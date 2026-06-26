/*
 *
 * Peer (Optimized)
 *
 * P2P client that connects to a full node to receive block notifications.
 * Emits:
 *   - 'blockFound' (hash) – when a new block is announced
 *   - 'connected' – when handshake completes
 *   - 'disconnected' – when the connection drops
 *   - 'connectionFailed' – when connection fails (e.g., ECONNREFUSED)
 *   - 'connectionRejected' – when the peer closes the connection unexpectedly
 *   - 'error' (message) – for other errors
 *   - 'socketError' (error) – for socket errors
 *   - 'peerMessage' (message) – for debugging
 *   - 'sentMessage' (message) – for debugging
 */

const net = require('net');
const crypto = require('crypto');
const events = require('events');
const utils = require('./utils');

// -----------------------------------------------------------------------------

const Peer = function(poolConfig) {
  const _this = this;

  // Set max listeners to avoid warnings
  this.setMaxListeners(0);

  this.poolConfig = poolConfig;
  this._destroyed = false;
  this._client = null;
  this._reconnectTimer = null;
  this._reconnectAttempts = 0;
  this._verack = false;
  this._validConnectionConfig = true;

  // Protocol constants
  this.networkServices = Buffer.from('0100000000000000', 'hex');
  this.emptyNetAddress = Buffer.from(
    '010000000000000000000000000000000000ffff000000000000',
    'hex'
  );
  this.userAgent = utils.varStringBuffer('/node-stratum/');
  this.blockStartHeight = Buffer.from('00000000', 'hex');
  this.relayTransactions = Buffer.from([false]);

  const testnet = poolConfig.settings.testnet || false;
  const coin = poolConfig.primary.coin;
  const magicHex = testnet ? coin.testnet.peerMagic : coin.mainnet.peerMagic;
  this.magic = Buffer.from(magicHex, 'hex');
  this.magicInt = this.magic.readUInt32LE(0);

  // Command buffers
  const commands = {
    version: utils.commandStringBuffer('version'),
    inv: utils.commandStringBuffer('inv'),
    verack: utils.commandStringBuffer('verack'),
    addr: utils.commandStringBuffer('addr'),
    getblocks: utils.commandStringBuffer('getblocks')
  };
  this._commands = commands;

  // INV codes
  const invCodes = {
    error: 0,
    tx: 1,
    block: 2
  };
  this._invCodes = invCodes;

  // Log helper
  const emitLog = (severity, message) => {
    _this.emit('log', severity, message);
  };

  // --------------------------------------------------------------------------
  //  Connection management
  // --------------------------------------------------------------------------

  this._connect = function() {
    if (_this._destroyed) return;

    _this._client = net.connect({
      host: poolConfig.p2p.host,
      port: poolConfig.p2p.port
    }, () => {
      _this._reconnectAttempts = 0;
      _this._verack = false;
      _this._validConnectionConfig = true;
      _this.sendVersion();
    });

    _this._client.on('error', (e) => {
      if (e.code === 'ECONNREFUSED') {
        _this._validConnectionConfig = false;
        _this.emit('connectionFailed');
        _this._scheduleReconnect();
      } else {
        _this.emit('socketError', e);
        _this._scheduleReconnect();
      }
    });

    _this._client.on('close', () => {
      if (_this._destroyed) return;
      if (_this._verack) {
        _this._verack = false;
        _this.emit('disconnected');
        _this._scheduleReconnect();
      } else if (_this._validConnectionConfig) {
        _this.emit('connectionRejected');
        _this._scheduleReconnect();
      } else {
        // Already scheduled via error path
      }
    });

    _this.setupMessageParser(_this._client);
  };

  this._scheduleReconnect = function() {
    if (_this._destroyed) return;
    if (_this._reconnectTimer) return; // already scheduled

    const maxAttempts = 10;
    if (_this._reconnectAttempts >= maxAttempts) {
      emitLog('error', `P2P reconnect failed after ${maxAttempts} attempts – giving up`);
      return;
    }

    const delay = Math.min(1000 * Math.pow(2, _this._reconnectAttempts), 60000);
    _this._reconnectAttempts++;
    emitLog('debug', `P2P reconnect attempt ${_this._reconnectAttempts} in ${delay}ms`);

    _this._reconnectTimer = setTimeout(() => {
      _this._reconnectTimer = null;
      if (!_this._destroyed) {
        _this._connect();
      }
    }, delay);
  };

  // --------------------------------------------------------------------------
  //  Message parser (stream reader)
  // --------------------------------------------------------------------------

  /**
   * Read a fixed number of bytes from a stream, handling over-read data.
   * @param {stream} stream - the socket
   * @param {number} amount - bytes to read
   * @param {Buffer|null} preRead - any data already read
   * @param {Function} callback - (data, lopped) => {}
   */
  this.readFlowingBytes = function(stream, amount, preRead, callback) {
    let buff = preRead || Buffer.alloc(0);
    const readData = (data) => {
      buff = Buffer.concat([buff, data]);
      if (buff.length >= amount) {
        const returnData = buff.slice(0, amount);
        const lopped = buff.length > amount ? buff.slice(amount) : null;
        callback(returnData, lopped);
      } else {
        stream.once('data', readData);
      }
    };
    stream.once('data', readData);
  };

  // --------------------------------------------------------------------------
  //  Message parser initialisation
  // --------------------------------------------------------------------------

  this.setupMessageParser = function(client) {
    const beginReadingMessage = (preRead) => {
      _this.readFlowingBytes(client, 24, preRead, (header, lopped) => {
        const msgMagic = header.readUInt32LE(0);
        if (msgMagic !== _this.magicInt) {
          // Skip forward until we find a magic byte
          let offset = 1;
          while (offset < header.length - 3) {
            if (header.readUInt32LE(offset) === _this.magicInt) {
              beginReadingMessage(header.slice(offset));
              return;
            }
            offset++;
          }
          // No magic found in this chunk – discard and wait for more
          beginReadingMessage(null);
          return;
        }

        const msgCommand = header.slice(4, 16).toString();
        const msgLength = header.readUInt32LE(16);
        const msgChecksum = header.readUInt32LE(20);

        _this.readFlowingBytes(client, msgLength, lopped, (payload, lopped2) => {
          // Validate checksum
          const hash = utils.sha256d(payload);
          if (hash.readUInt32LE(0) !== msgChecksum) {
            emitLog('error', 'P2P: bad payload – checksum mismatch');
            beginReadingMessage(null);
            return;
          }
          _this._handleMessage(msgCommand, payload);
          beginReadingMessage(lopped2);
        });
      });
    };
    beginReadingMessage(null);
  };

  // --------------------------------------------------------------------------
  //  Message handling
  // --------------------------------------------------------------------------

  this._handleInventory = function(payload) {
    let count = payload.readUInt8(0);
    payload = payload.slice(1);
    if (count >= 0xfd) {
      count = payload.readUInt16LE(0);
      payload = payload.slice(2);
    }
    const invCodes = this._invCodes;
    while (count--) {
      const type = payload.readUInt32LE(0);
      const hash = payload.slice(4, 36).toString('hex');
      if (type === invCodes.block) {
        this.emit('blockFound', hash);
      }
      payload = payload.slice(36);
    }
  };

  this._handleMessage = function(command, payload) {
    this.emit('peerMessage', { command, payload });
    const commands = this._commands;
    switch (command) {
      case commands.inv.toString():
        this._handleInventory(payload);
        break;
      case commands.verack.toString():
        if (!this._verack) {
          this._verack = true;
          this.emit('connected');
        }
        break;
      case commands.version.toString():
        this.sendMessage(commands.verack, Buffer.alloc(0));
        break;
      default:
        // ignore other messages
        break;
    }
  };

  // --------------------------------------------------------------------------
  //  Sending messages
  // --------------------------------------------------------------------------

  this.sendMessage = function(command, payload) {
    if (this._destroyed || !this._client || this._client.destroyed) return;
    const message = Buffer.concat([
      this.magic,
      command,
      utils.packUInt32LE(payload.length),
      utils.sha256d(payload).slice(0, 4),
      payload
    ]);
    try {
      this._client.write(message);
      this.emit('sentMessage', message);
    } catch (e) {
      this.emit('error', `Failed to send message: ${e.message}`);
    }
  };

  this.sendVersion = function() {
    const protocolVersion = this.poolConfig.settings.protocolVersion || 70015;
    const timestamp = (Date.now() / 1000) | 0;
    const payload = Buffer.concat([
      utils.packUInt32LE(protocolVersion),
      this.networkServices,
      utils.packUInt64LE(timestamp),
      this.emptyNetAddress,
      this.emptyNetAddress,
      crypto.randomBytes(8),
      this.userAgent,
      this.blockStartHeight,
      this.relayTransactions
    ]);
    this.sendMessage(this._commands.version, payload);
  };

  // --------------------------------------------------------------------------
  //  Public API
  // --------------------------------------------------------------------------

  this.setupPeer = function() {
    this._connect();
  };

  this.close = function(callback) {
    if (this._destroyed) {
      if (callback) callback();
      return;
    }
    this._destroyed = true;

    // Clear reconnect timer
    if (this._reconnectTimer) {
      clearTimeout(this._reconnectTimer);
      this._reconnectTimer = null;
    }

    // Close socket
    if (this._client && !this._client.destroyed) {
      try {
        this._client.destroy();
      } catch (e) {}
    }
    this._client = null;

    // Remove all listeners to prevent leaks
    this.removeAllListeners();
    if (callback) callback();
  };

  // --------------------------------------------------------------------------
  //  Initialise
  // --------------------------------------------------------------------------
  this.setupPeer();
};

Peer.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Peer;
