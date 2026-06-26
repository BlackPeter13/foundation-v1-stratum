/*
 *
 * Network (Optimized)
 *
 * Stratum server – handles incoming TCP/TLS connections, manages clients,
 * bans, and broadcasts mining jobs.
 *
 * Emits:
 *   - 'started' – when all stratum servers are listening
 *   - 'stopped' – after shutdown
 *   - 'client.connected' (client) – new client connected
 *   - 'client.disconnected' (client) – client disconnected
 *   - 'client.banned' (client) – client was banned
 *   - 'broadcastTimeout' – when job rebroadcast timeout fires
 *   - 'log' (severity, message)
 */

const net = require('net');
const tls = require('tls');
const fs = require('fs');
const path = require('path');
const events = require('events');
const utils = require('./utils');
const Client = require('./client');

// -----------------------------------------------------------------------------

const Network = function(poolConfig, portalConfig, authorizeFn) {
  const _this = this;

  // Set max listeners to avoid warnings (many clients connect)
  this.setMaxListeners(0);

  this.poolConfig = poolConfig;
  this.portalConfig = portalConfig;
  this.authorizeFn = authorizeFn;

  // Use Map for banned IPs (faster lookups)
  this.bannedIPs = new Map(); // ip -> timestamp (ms)
  this.stratumClients = new Map(); // subscriptionId -> Client instance
  this.stratumServers = new Map(); // port -> Server instance

  this._rebroadcastTimeout = null;
  this._cleanupInterval = null;
  this._destroyed = false;

  // Log helper
  const emitLog = (severity, message) => {
    _this.emit('log', severity, message);
  };

  // Ban duration in ms
  const bannedMS = this.poolConfig.banning.time * 1000;

  // --------------------------------------------------------------------------
  //  Server startup
  // --------------------------------------------------------------------------
  this.setupNetwork = function() {
    // Periodic cleanup of expired bans
    this._cleanupInterval = setInterval(() => {
      this._cleanupBans();
    }, this.poolConfig.banning.purgeInterval * 1000);

    // Start stratum servers
    const stratumPorts = this.poolConfig.ports.filter(port => port.enabled);
    if (stratumPorts.length === 0) {
      emitLog('error', 'No enabled ports configured – server cannot start');
      return;
    }

    let serversStarted = 0;

    stratumPorts.forEach((port) => {
      const currentPort = port.port;

      // Build TLS options if enabled
      let options = {};
      if (port.tls) {
        const keyPath = path.join('./certificates', this.portalConfig.tls.key);
        const certPath = path.join('./certificates', this.portalConfig.tls.cert);
        try {
          options.key = fs.readFileSync(keyPath);
          options.cert = fs.readFileSync(certPath);
        } catch (err) {
          emitLog('error', `Failed to read TLS certificate files: ${err.message}`);
          return;
        }
        // Optional: add CA if provided
        if (this.portalConfig.tls.ca) {
          try {
            options.ca = fs.readFileSync(path.join('./certificates', this.portalConfig.tls.ca));
          } catch (err) {
            emitLog('warning', `CA file not found: ${err.message}`);
          }
        }
        options.allowHalfOpen = false;
      }

      // Create server (TLS or TCP)
      const callback = (socket) => {
        _this.handleNewClient(socket);
      };
      let server;
      if (port.tls) {
        server = tls.createServer(options, callback);
      } else {
        server = net.createServer(options, callback);
      }

      // Handle server errors
      server.once('error', (err) => {
        emitLog('error', `Stratum server on port ${currentPort} error: ${err.message}`);
        // Do not stop the whole pool; log and continue
      });

      // Start listening
      server.listen(parseInt(currentPort, 10), () => {
        serversStarted += 1;
        emitLog('info', `Stratum server listening on port ${currentPort}${port.tls ? ' (TLS)' : ''}`);
        if (serversStarted === stratumPorts.length) {
          _this.emit('started');
          emitLog('info', 'All stratum servers started');
        }
      });

      // Store server reference
      this.stratumServers.set(currentPort, server);
    });
  };

  // --------------------------------------------------------------------------
  //  Ban cleanup
  // --------------------------------------------------------------------------
  this._cleanupBans = function() {
    const now = Date.now();
    for (const [ip, banTime] of this.bannedIPs) {
      if (now - banTime > bannedMS) {
        this.bannedIPs.delete(ip);
        emitLog('debug', `Forgave banned IP ${ip}`);
      }
    }
  };

  // --------------------------------------------------------------------------
  //  Check if IP is banned
  // --------------------------------------------------------------------------
  this.checkBan = function(client) {
    if (this._destroyed) return;

    const ip = client.remoteAddress;
    if (this.bannedIPs.has(ip)) {
      const banTime = this.bannedIPs.get(ip);
      const timeLeft = bannedMS - (Date.now() - banTime);
      if (timeLeft > 0) {
        client.emit('kickedBannedIP', Math.floor(timeLeft / 1000));
        client.destroy();
        return true;
      } else {
        // Ban expired
        this.bannedIPs.delete(ip);
        client.emit('forgaveBannedIP');
        return false;
      }
    }
    return false;
  };

  // --------------------------------------------------------------------------
  //  Add IP to ban list
  // --------------------------------------------------------------------------
  this.addBannedIP = function(ipAddress) {
    if (this._destroyed) return;
    this.bannedIPs.set(ipAddress, Date.now());
    emitLog('debug', `Banned IP ${ipAddress}`);
  };

  // --------------------------------------------------------------------------
  //  Handle new client connection
  // --------------------------------------------------------------------------
  this.handleNewClient = function(socket) {
    if (this._destroyed) {
      socket.destroy();
      return;
    }

    // Enable keep-alive
    socket.setKeepAlive(true);

    const subscriptionId = utils.subscriptionCounter().next();
    const client = new Client({
      subscriptionId: subscriptionId,
      authorizeFn: this.authorizeFn,
      socket: socket,
      remoteAddress: socket.remoteAddress || 'unknown',
      algorithm: this.poolConfig.primary.coin.algorithms.mining,
      asicboost: this.poolConfig.primary.coin.asicboost || false,
      banning: this.poolConfig.banning,
      connectionTimeout: this.poolConfig.settings.connectionTimeout || 300,
      tcpProxyProtocol: this.poolConfig.settings.tcpProxyProtocol || false,
      debug: this.poolConfig.debug || false,
    });

    // Store client
    this.stratumClients.set(subscriptionId, client);

    // Emit connection event
    this.emit('client.connected', client);

    // Client events
    client.on('socketDisconnect', () => {
      if (!_this._destroyed) {
        _this.stratumClients.delete(subscriptionId);
        _this.emit('client.disconnected', client);
      }
    });

    client.on('checkBan', () => {
      _this.checkBan(client);
    });

    client.on('triggerBan', (reason) => {
      _this.addBannedIP(client.remoteAddress);
      _this.emit('client.banned', client);
      emitLog('debug', `Client ${client.getLabel()} banned: ${reason}`);
    });

    // Forward log events from client
    client.on('log', (severity, message) => {
      _this.emit('log', severity, `[Client ${client.getLabel()}] ${message}`);
    });

    // Set up the client (socket handlers)
    client.setupClient();
  };

  // --------------------------------------------------------------------------
  //  Broadcast mining jobs to all connected clients
  // --------------------------------------------------------------------------
  this.broadcastMiningJobs = function(template, cleanJobs) {
    if (this._destroyed) return;

    const clients = this.stratumClients;
    if (clients.size === 0) {
      // No clients connected, but still keep the timeout for future connections
      // We'll still set the rebroadcast timer.
    }

    for (const [, client] of clients) {
      try {
        const jobParams = template.getJobParams(client, cleanJobs);
        client.sendMiningJob(jobParams);
      } catch (err) {
        emitLog('error', `Error broadcasting to client: ${err.message}`);
        // Optionally destroy client if it fails
      }
    }

    // Reset rebroadcast timeout
    if (this._rebroadcastTimeout) {
      clearTimeout(this._rebroadcastTimeout);
    }
    this._rebroadcastTimeout = setTimeout(() => {
      if (!_this._destroyed) {
        _this.emit('broadcastTimeout');
      }
    }, this.poolConfig.settings.jobRebroadcastTimeout * 1000);
  };

  // --------------------------------------------------------------------------
  //  Stop all servers
  // --------------------------------------------------------------------------
  this.stopServer = function() {
    if (this._destroyed) return;
    for (const [port, server] of this.stratumServers) {
      server.close(() => {
        emitLog('info', `Closed stratum server on port ${port}`);
      });
    }
    this.stratumServers.clear();
    this.emit('stopped');
  };

  // --------------------------------------------------------------------------
  //  Graceful shutdown
  // --------------------------------------------------------------------------
  this.shutdown = function(callback) {
    if (this._destroyed) {
      if (callback) callback();
      return;
    }
    this._destroyed = true;

    emitLog('info', 'Shutting down network layer...');

    // Clear intervals and timeouts
    if (this._cleanupInterval) {
      clearInterval(this._cleanupInterval);
      this._cleanupInterval = null;
    }
    if (this._rebroadcastTimeout) {
      clearTimeout(this._rebroadcastTimeout);
      this._rebroadcastTimeout = null;
    }

    // Close all stratum servers
    for (const [port, server] of this.stratumServers) {
      server.close(() => {
        emitLog('debug', `Closed server on port ${port}`);
      });
    }
    this.stratumServers.clear();

    // Destroy all clients
    for (const [id, client] of this.stratumClients) {
      try {
        client.destroy();
      } catch (e) {}
    }
    this.stratumClients.clear();

    // Clear bans
    this.bannedIPs.clear();

    // Remove all listeners
    this.removeAllListeners();

    if (callback) callback();
  };

  // --------------------------------------------------------------------------
  //  Start the network
  // --------------------------------------------------------------------------
  this.setupNetwork();
};

// Inherit EventEmitter
Network.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Network;
