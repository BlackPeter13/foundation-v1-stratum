/*
 *
 * Client (Optimized)
 *
 * Represents a connected Stratum client.
 * Handles subscription, authorization, difficulty, and share submission.
 */

const events = require('events');
const Algorithms = require('./algorithms');

// -----------------------------------------------------------------------------

const Client = function(options) {
  const _this = this;

  // Set max listeners to avoid warnings (many clients can attach many listeners)
  this.setMaxListeners(0);

  this.options = options;
  this.authorized = false;
  this.difficulty = 0;
  this.previousDifficulty = 0;
  this.lastActivity = Date.now();
  this.remoteAddress = options.remoteAddress;
  this.shares = { valid: 0, invalid: 0 };
  this.socket = options.socket;
  this.extraNonce1 = null;
  this.addrPrimary = null;
  this.addrAuxiliary = null;
  this.workerPassword = '';
  this.asicboost = false;
  this.versionMask = '00000000';

  // Difficulty management
  this.pendingDifficulty = null;
  this.staticDifficulty = false;

  // Internal state for cleanup
  this._destroyed = false;
  this._dataBuffer = '';
  this._socket = null; // will be set in setupClient

  // Log helper – emits 'log' event
  this.emitLog = function(severity, text) {
    _this.emit('log', severity, text);
  };
  this.emitDebug = function(text) {
    if (_this.options.debug) _this.emitLog('debug', text);
  };
  this.emitWarning = function(text) {
    _this.emitLog('warning', text);
  };
  this.emitError = function(text) {
    _this.emitLog('error', text);
  };

  // --------------------------------------------------------------------------
  //  Validation helpers
  // --------------------------------------------------------------------------
  this.validateName = function(name) {
    if (typeof name !== 'string' || name.length === 0) {
      return ['', null];
    }
    const clean = name.replace(/[^a-zA-Z0-9.,]+/g, '');
    const addresses = clean.split(',');
    if (addresses.length > 1) {
      return [addresses[0], addresses[1] || null];
    }
    return [addresses[0], null];
  };

  this.validatePassword = function(password) {
    const flags = {};
    if (typeof password !== 'string' || password.length === 0) return flags;
    const clean = password.replace(/[^a-zA-Z0-9.,=]+/g, '');
    const values = clean.split(',');
    values.forEach((value) => {
      if (/^d=[+-]?(\d*\.)?\d+$/.test(value)) {
        const diff = parseFloat(value.split('=')[1]);
        if (!isNaN(diff) && diff > 0) {
          flags.difficulty = diff;
        }
      }
    });
    return flags;
  };

  // --------------------------------------------------------------------------
  //  Ban management
  // --------------------------------------------------------------------------
  this.considerBan = function(shareValid) {
    if (_this._destroyed) return true;

    if (shareValid === true) {
      _this.shares.valid += 1;
    } else {
      _this.shares.invalid += 1;
    }
    const total = _this.shares.valid + _this.shares.invalid;
    if (total >= _this.options.banning.checkThreshold) {
      const percentBad = (_this.shares.invalid / total);
      if (percentBad < _this.options.banning.invalidPercent) {
        // Reset counters
        _this.shares = { valid: 0, invalid: 0 };
      } else {
        const reason = _this.shares.invalid + ' out of the last ' + total + ' shares were invalid';
        _this.emit('triggerBan', reason);
        _this.destroy();
        return true;
      }
    }
    return false;
  };

  // --------------------------------------------------------------------------
  //  JSON sending
  // --------------------------------------------------------------------------
  this.sendJson = function() {
    if (_this._destroyed || !_this.socket) return;
    let response = '';
    for (let i = 0; i < arguments.length; i++) {
      response += JSON.stringify(arguments[i]) + '\n';
    }
    try {
      _this.socket.write(response);
    } catch (e) {
      _this.emitError('Error writing to socket: ' + e.message);
    }
  };

  // --------------------------------------------------------------------------
  //  Setup client socket handlers
  // --------------------------------------------------------------------------
  this.setupClient = function() {
    if (_this._destroyed) return;

    const socket = _this.options.socket;
    _this._socket = socket;
    socket.setEncoding('utf8');
    _this._dataBuffer = '';

    // Handle proxy protocol if enabled
    if (_this.options.tcpProxyProtocol === true) {
      socket.once('data', (d) => {
        if (d.indexOf('PROXY') === 0) {
          const parts = d.split(' ');
          if (parts.length >= 3) {
            _this.remoteAddress = parts[2];
          }
        } else {
          _this.emit('tcpProxyError', d);
        }
        _this.emit('checkBan');
      });
    } else {
      _this.emit('checkBan');
    }

    // Main data handler
    socket.on('data', (d) => {
      if (_this._destroyed) return;
      _this._dataBuffer += d;

      // Prevent buffer overflow
      if (Buffer.byteLength(_this._dataBuffer, 'utf8') > 10240) {
        _this._dataBuffer = '';
        _this.emit('socketFlooded');
        _this.destroy();
        return;
      }

      if (_this._dataBuffer.indexOf('\n') !== -1) {
        const messages = _this._dataBuffer.split('\n');
        const incomplete = _this._dataBuffer.slice(-1) === '\n' ? '' : messages.pop();
        messages.forEach((message) => {
          if (message === '') return;
          let messageJson;
          try {
            messageJson = JSON.parse(message);
          } catch (e) {
            if (_this.options.tcpProxyProtocol !== true || d.indexOf('PROXY') !== 0) {
              _this.emit('malformedMessage', message);
              _this.destroy();
            }
            return;
          }
          if (messageJson) {
            _this.handleMessage(messageJson);
          }
        });
        _this._dataBuffer = incomplete;
      }
    });

    socket.on('close', () => {
      if (!_this._destroyed) {
        _this.emit('socketDisconnect');
        _this.destroy();
      }
    });

    socket.on('error', (e) => {
      if (e.code !== 'ECONNRESET' && !_this._destroyed) {
        _this.emit('socketError', e);
        _this.destroy();
      }
    });
  };

  // --------------------------------------------------------------------------
  //  Message handling
  // --------------------------------------------------------------------------
  this.handleMessage = function(message) {
    if (_this._destroyed) return;

    switch (message.method) {
      case 'mining.subscribe':
        _this.handleSubscribe(message);
        break;
      case 'mining.authorize':
        _this.handleAuthorize(message);
        break;
      case 'mining.configure':
        _this.handleConfigure(message);
        break;
      case 'mining.multi_version':
        _this.handleMultiVersion(message);
        break;
      case 'mining.submit':
        _this.lastActivity = Date.now();
        _this.handleSubmit(message);
        break;
      case 'mining.get_transactions':
        _this.sendJson({
          id: message.id,
          result: [],
          error: [20, 'Not supported.', null]
        });
        break;
      case 'mining.extranonce.subscribe':
        _this.sendJson({
          id: message.id,
          result: false,
          error: [20, 'Not supported.', null]
        });
        break;
      default:
        _this.emit('unknownStratumMethod', message);
        break;
    }
  };

  // --------------------------------------------------------------------------
  //  Subscription
  // --------------------------------------------------------------------------
  this.handleSubscribe = function(message) {
    const algorithm = _this.options.algorithm;
    _this.emit('subscription', {}, (error, extraNonce1) => {
      if (error) {
        _this.sendJson({ id: message.id, result: null, error: error });
        return;
      }
      _this.extraNonce1 = extraNonce1;

      if (algorithm === 'kawpow' || algorithm === 'firopow') {
        _this.sendJson({
          id: message.id,
          result: [null, extraNonce1],
          error: null
        });
      } else {
        const extraNonce2Size = _this.options.extraNonce2Size || 8;
        _this.sendJson({
          id: message.id,
          result: [
            [
              ['mining.set_difficulty', _this.options.subscriptionId],
              ['mining.notify', _this.options.subscriptionId]
            ],
            extraNonce1,
            extraNonce2Size
          ],
          error: null
        });
      }
    });
  };

  // --------------------------------------------------------------------------
  //  Authorization
  // --------------------------------------------------------------------------
  this.handleAuthorize = function(message) {
    const workerData = _this.validateName(message.params[0]);
    const workerFlags = _this.validatePassword(message.params[1]);

    _this.addrPrimary = workerData[0];
    _this.addrAuxiliary = workerData[1];
    _this.workerPassword = message.params[1] || '';

    // Check for static difficulty flag
    if (workerFlags.difficulty) {
      _this.enqueueNextDifficulty(workerFlags.difficulty);
      _this.staticDifficulty = true;
    }

    const port = _this.socket.localPort;
    _this.options.authorizeFn(
      _this.remoteAddress,
      port,
      _this.addrPrimary,
      _this.addrAuxiliary,
      _this.workerPassword,
      (result) => {
        if (_this._destroyed) return;
        _this.authorized = (!result.error && result.authorized === true);
        _this.sendJson({
          id: message.id,
          result: _this.authorized,
          error: result.error || null
        });
        if (result.disconnect === true) {
          _this.destroy();
        }
      }
    );
  };

  // --------------------------------------------------------------------------
  //  Configuration
  // --------------------------------------------------------------------------
  this.handleConfigure = function(message) {
    if (!_this.options.asicboost) {
      _this.asicboost = false;
      _this.versionMask = '00000000';
      _this.sendJson({
        id: message.id,
        result: { 'version-rolling': false },
        error: null
      });
    } else {
      _this.asicboost = true;
      _this.versionMask = '1fffe000';
      _this.sendJson({
        id: message.id,
        result: {
          'version-rolling': true,
          'version-rolling.mask': '1fffe000'
        },
        error: null
      });
    }
    return true;
  };

  // --------------------------------------------------------------------------
  //  Multi-version
  // --------------------------------------------------------------------------
  this.handleMultiVersion = function(message) {
    if (!_this.options.asicboost) {
      _this.asicboost = false;
      _this.versionMask = '00000000';
    } else {
      const mVersion = parseInt(message.params[0], 10);
      if (mVersion > 1) {
        _this.asicboost = true;
        _this.versionMask = '1fffe000';
      } else {
        _this.asicboost = false;
        _this.versionMask = '00000000';
      }
    }
    return true;
  };

  // --------------------------------------------------------------------------
  //  Share Submission
  // --------------------------------------------------------------------------
  this.handleSubmit = function(message) {
    if (!_this.addrPrimary) {
      const workerData = _this.validateName(message.params[0]);
      _this.addrPrimary = workerData[0];
      _this.addrAuxiliary = workerData[1];
    }

    if (!_this.authorized) {
      _this.sendJson({
        id: message.id,
        result: null,
        error: [24, 'unauthorized worker', null]
      });
      _this.considerBan(false);
      return;
    }

    if (!_this.extraNonce1) {
      _this.sendJson({
        id: message.id,
        result: null,
        error: [25, 'not subscribed', null]
      });
      _this.considerBan(false);
      return;
    }

    // Validate and clean worker name
    message.params[0] = _this.validateName(message.params[0])[0] || '';

    _this.emit('submit', message, (error, result) => {
      if (_this._destroyed) return;
      const banned = _this.considerBan(result);
      if (!banned) {
        _this.sendJson({
          id: message.id,
          result: result,
          error: error || null
        });
      }
    });
  };

  // --------------------------------------------------------------------------
  //  Difficulty management
  // --------------------------------------------------------------------------
  this.enqueueNextDifficulty = function(requestedNewDifficulty) {
    if (!_this.staticDifficulty && !_this._destroyed) {
      _this.pendingDifficulty = requestedNewDifficulty;
      _this.emit('difficultyQueued', requestedNewDifficulty);
    }
  };

  this.sendDifficulty = function(difficulty) {
    if (_this._destroyed) return false;
    if (difficulty === _this.difficulty) return false;

    _this.previousDifficulty = _this.difficulty;
    _this.difficulty = difficulty;

    const algorithm = _this.options.algorithm;
    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // Kawpow uses set_target with hex target
      const adjPow = Algorithms[algorithm].diff / difficulty;
      let hex = adjPow.toString(16);
      while (hex.length < 64) hex = '0' + hex;
      _this.sendJson({
        id: null,
        method: 'mining.set_target',
        params: [hex]
      });
    } else {
      _this.sendJson({
        id: null,
        method: 'mining.set_difficulty',
        params: [difficulty]
      });
    }
    return true;
  };

  // --------------------------------------------------------------------------
  //  Send mining job
  // --------------------------------------------------------------------------
  this.sendMiningJob = function(jobParams) {
    if (_this._destroyed) return;

    // Check inactivity timeout
    const now = Date.now();
    const lastActivityAgo = now - _this.lastActivity;
    const timeout = (_this.options.connectionTimeout || 300) * 1000;
    if (lastActivityAgo > timeout) {
      _this.emit('socketTimeout', 'last submitted a share was ' + Math.floor(lastActivityAgo / 1000) + ' seconds ago');
      _this.destroy();
      return;
    }

    // Apply pending difficulty
    if (_this.pendingDifficulty !== null) {
      const result = _this.sendDifficulty(_this.pendingDifficulty);
      _this.pendingDifficulty = null;
      if (result) {
        _this.emit('difficultyChanged', _this.difficulty);
      }
    }

    // Send job
    const algorithm = _this.options.algorithm;
    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // Kawpow includes target in job params[3] (override)
      const adjPow = Algorithms[algorithm].diff / _this.difficulty;
      let hex = adjPow.toString(16);
      while (hex.length < 64) hex = '0' + hex;
      jobParams[3] = hex;
    }

    _this.sendJson({
      id: null,
      method: 'mining.notify',
      params: jobParams
    });
  };

  // --------------------------------------------------------------------------
  //  Helpers
  // --------------------------------------------------------------------------
  this.getLabel = function() {
    return (_this.addrPrimary || '(unauthorized)') + ' [' + _this.remoteAddress + ']';
  };

  // --------------------------------------------------------------------------
  //  Cleanup / destroy
  // --------------------------------------------------------------------------
  this.destroy = function() {
    if (_this._destroyed) return;
    _this._destroyed = true;

    // Remove all listeners to prevent memory leaks
    _this.removeAllListeners();

    // Clear any pending data buffer
    _this._dataBuffer = '';

    // Destroy socket if it exists and is writable
    if (_this.socket && !_this.socket.destroyed) {
      try {
        _this.socket.destroy();
      } catch (e) {
        // ignore
      }
    }
    _this.socket = null;
    _this._socket = null;

    // Clear references
    _this.options = null;
    _this.emit('clientDestroyed');
  };
};

// Inherit EventEmitter
Client.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Client;
