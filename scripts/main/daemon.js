/*
 *
 * Daemon (Optimized)
 *
 * Interface to coin daemon RPC. Supports multiple daemons, retries, and connection health tracking.
 */

const http = require('http');
const events = require('events');
const async = require('async');

// -----------------------------------------------------------------------------

const Daemon = function(daemons, logger) {
  const _this = this;

  // Logging function
  this.logger = logger || function(severity, message) {
    console.log(severity + ': ' + message);
  };

  // Internal state
  this._instances = [];
  this._requests = []; // pending request objects for abort
  this._destroyed = false;

  // Status per instance: { online: boolean, lastCheck: timestamp, error: string|null }
  this._status = new Map();

  // Index and initialize daemons
  daemons.forEach((daemon, idx) => {
    daemon.index = idx;
    daemon.retries = daemon.retries || 2; // default retries per call
    daemon.timeout = daemon.timeout || 5000; // request timeout in ms
    this._instances.push(daemon);
    this._status.set(idx, { online: false, lastCheck: 0, error: null });
  });

  // --------------------------------------------------------------------------
  //  HTTP request with timeout and retry
  // --------------------------------------------------------------------------
  this.performHttpRequest = function(instance, jsonData, callback, retries, attempt) {
    if (_this._destroyed) {
      callback({ type: 'destroyed', message: 'Daemon interface destroyed' }, null);
      return;
    }

    attempt = attempt || 0;
    retries = (retries !== undefined) ? retries : instance.retries;

    const options = {
      hostname: instance.host,
      port: instance.port,
      method: 'POST',
      timeout: instance.timeout || 5000,
      headers: { 'Content-Length': jsonData.length },
      auth: instance.username + ':' + instance.password,
    };

    let req = null;
    let timedOut = false;
    const requestId = Date.now() + Math.random();

    const handleError = (err, type) => {
      // If we have retries left and it's a recoverable error, retry
      const recoverable = (type === 'offline' || type === 'timeout' || type === 'request error');
      if (recoverable && attempt < retries) {
        const delay = Math.min(1000 * Math.pow(2, attempt), 10000);
        _this.logger('debug', `Daemon ${instance.index} ${type} - retrying in ${delay}ms (attempt ${attempt+1}/${retries})`);
        setTimeout(() => {
          _this.performHttpRequest(instance, jsonData, callback, retries, attempt + 1);
        }, delay);
        return;
      }
      // Final failure
      const errorObj = { type: type || 'unknown', message: err ? err.message : 'Unknown error', instance };
      _this._status.set(instance.index, { online: false, lastCheck: Date.now(), error: errorObj.message });
      callback(errorObj, null);
    };

    // Parse response
    const parseJson = function(res, data) {
      if (res.statusCode === 401 || res.statusCode === 403) {
        handleError(new Error('Unauthorized - invalid RPC username/password'), 'unauthorized');
        return;
      }
      let dataJson;
      try {
        dataJson = JSON.parse(data);
      } catch (e) {
        _this.logger('error', `Could not parse RPC data from daemon ${instance.index}: ${data}`);
        handleError(new Error('Invalid JSON response'), 'parse error');
        return;
      }
      // Update status
      _this._status.set(instance.index, { online: true, lastCheck: Date.now(), error: null });
      callback(dataJson.error || null, dataJson, data);
    };

    // Create request
    req = http.request(options, (res) => {
      let data = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => { data += chunk; });
      res.on('end', () => {
        if (!timedOut && !_this._destroyed) {
          parseJson(res, data);
        }
      });
    });

    // Store request for potential abort
    _this._requests.push(req);

    req.on('error', (e) => {
      // Remove from pending
      const idx = _this._requests.indexOf(req);
      if (idx !== -1) _this._requests.splice(idx, 1);
      if (timedOut || _this._destroyed) return;
      if (e.code === 'ECONNREFUSED') {
        handleError(e, 'offline');
      } else if (e.code === 'ETIMEDOUT' || e.code === 'ESOCKETTIMEDOUT') {
        handleError(e, 'timeout');
      } else {
        handleError(e, 'request error');
      }
    });

    // Timeout handling
    const timeoutHandle = setTimeout(() => {
      timedOut = true;
      if (req) {
        try { req.destroy(); } catch (e) {}
      }
      handleError(new Error('Request timeout'), 'timeout');
    }, options.timeout);

    req.on('close', () => {
      clearTimeout(timeoutHandle);
    });

    req.end(jsonData);
  };

  // --------------------------------------------------------------------------
  //  Check online status (all daemons)
  // --------------------------------------------------------------------------
  this.isOnline = function(callback) {
    if (_this._destroyed) {
      callback(false);
      return;
    }
    // Use a simple command to check all daemons
    this.cmd('getpeerinfo', [], false, (results) => {
      const allOnline = results.every((result) => {
        return !result.error;
      });
      callback(allOnline);
      if (!allOnline) {
        _this.emit('connectionFailed', results);
      }
    });
  };

  // --------------------------------------------------------------------------
  //  Initialize daemons (check and emit online)
  // --------------------------------------------------------------------------
  this.initDaemons = function(callback) {
    this.isOnline((online) => {
      if (online) {
        _this.emit('online');
      }
      if (callback) callback(online);
    });
  };

  // --------------------------------------------------------------------------
  //  Batch command – sends multiple RPC calls to first daemon (no retries)
  // --------------------------------------------------------------------------
  this.batchCmd = function(requests, callback) {
    if (_this._destroyed) {
      callback({ type: 'destroyed', message: 'Daemon interface destroyed' }, null);
      return;
    }
    const requestsJson = [];
    requests.forEach((command, idx) => {
      requestsJson.push({
        method: command[0],
        params: command[1],
        id: Date.now() + Math.floor(Math.random() * 10) + idx
      });
    });
    const serializedRequest = JSON.stringify(requestsJson);
    // Use the first instance, no retries
    const instance = this._instances[0];
    if (!instance) {
      callback(new Error('No daemon instances configured'), null);
      return;
    }
    this.performHttpRequest(instance, serializedRequest, (error, result) => {
      callback(error, result);
    }, 0, 0); // no retries
  };

  // --------------------------------------------------------------------------
  //  Single RPC command with optional streaming and retries
  // --------------------------------------------------------------------------
  this.cmd = function(method, params, streaming, callback, retries) {
    if (_this._destroyed) {
      if (callback) callback({ type: 'destroyed', message: 'Daemon interface destroyed' });
      return;
    }

    let responded = false;
    const results = [];
    const serializedRequest = JSON.stringify({
      method: method,
      params: params,
      id: Date.now() + Math.floor(Math.random() * 10)
    });

    // If no retries specified, use each instance's default
    const useRetries = (retries !== undefined) ? retries : (this._instances[0] ? this._instances[0].retries : 2);

    // Iterate over instances
    async.each(this._instances, (instance, eachCallback) => {
      _this.performHttpRequest(instance, serializedRequest, (error, result, data) => {
        const returnObj = {
          error: error,
          response: (result || {}).result,
          instance: instance,
          data: data,
        };
        results.push(returnObj);

        if (streaming && !responded) {
          if (!error) {
            responded = true;
            callback(returnObj);
          } else {
            eachCallback(); // continue to next instance
          }
        } else {
          eachCallback();
        }
      }, useRetries, 0);
    }, () => {
      // All instances processed
      if (streaming && !responded) {
        // No success, return first result
        if (results.length > 0) {
          callback(results[0]);
        } else {
          callback({ error: new Error('No instances available'), instance: null });
        }
      } else {
        callback(results);
      }
    });
  };

  // --------------------------------------------------------------------------
  //  Connection status per instance
  // --------------------------------------------------------------------------
  this.getConnectionStatus = function() {
    const status = {};
    this._instances.forEach((inst) => {
      const idx = inst.index;
      const s = this._status.get(idx) || { online: false, lastCheck: 0, error: 'Unknown' };
      status[idx] = {
        host: inst.host,
        port: inst.port,
        online: s.online,
        lastCheck: s.lastCheck ? new Date(s.lastCheck).toISOString() : 'never',
        error: s.error
      };
    });
    return status;
  };

  // --------------------------------------------------------------------------
  //  Is at least one daemon connected?
  // --------------------------------------------------------------------------
  this.isConnected = function() {
    for (const [idx, status] of this._status) {
      if (status.online) return true;
    }
    return false;
  };

  // --------------------------------------------------------------------------
  //  Graceful shutdown
  // --------------------------------------------------------------------------
  this.close = function(callback) {
    if (_this._destroyed) {
      if (callback) callback();
      return;
    }
    _this._destroyed = true;
    // Abort all pending requests
    _this._requests.forEach((req) => {
      try {
        req.destroy();
      } catch (e) {}
    });
    _this._requests = [];
    _this._status.clear();
    _this.removeAllListeners();
    if (callback) callback();
  };
};

// Inherit EventEmitter
Daemon.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Daemon;
