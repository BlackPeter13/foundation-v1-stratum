/*
 *
 * Difficulty (Optimized)
 *
 * Variable difficulty manager per port.
 * Adjusts client difficulty based on share submission timing.
 */

const events = require('events');
const utils = require('./utils');

// -----------------------------------------------------------------------------
//  Ring buffer for storing submission times
// -----------------------------------------------------------------------------
class RingBuffer {
  /**
   * @param {number} maxSize - Maximum number of entries to store
   */
  constructor(maxSize) {
    this._maxSize = maxSize;
    this._data = new Array(maxSize);
    this._cursor = 0;
    this._count = 0;
    this._full = false;
  }

  /**
   * Append a value to the ring buffer.
   * @param {number} value - Value to append
   */
  append(value) {
    this._data[this._cursor] = value;
    this._cursor = (this._cursor + 1) % this._maxSize;
    if (this._count < this._maxSize) {
      this._count++;
    } else {
      this._full = true;
    }
  }

  /**
   * Compute the average of stored values.
   * @returns {number} Average, or 0 if empty
   */
  avg() {
    if (this._count === 0) return 0;
    let sum = 0;
    const len = this._full ? this._maxSize : this._count;
    for (let i = 0; i < len; i++) {
      sum += this._data[i];
    }
    return sum / len;
  }

  /** Number of stored entries */
  size() {
    return this._full ? this._maxSize : this._count;
  }

  /** Reset the buffer */
  clear() {
    this._data.fill(0);
    this._cursor = 0;
    this._count = 0;
    this._full = false;
  }
}

// -----------------------------------------------------------------------------
//  Difficulty manager
// -----------------------------------------------------------------------------
/**
 * Variable difficulty manager for a specific port.
 * Emits:
 *   - 'newDifficulty' (client, newDifficulty) when client difficulty should be updated
 *   - 'log' (severity, message) for logging
 */
const Difficulty = function(port, difficulty, showLogs) {
  const _this = this;

  // Set max listeners to avoid warnings if many clients are managed
  this.setMaxListeners(0);

  this.port = port;
  this.options = difficulty;
  this.showLogs = showLogs !== false;

  // Internal state
  const variance = difficulty.targetTime * difficulty.variance;
  const bufferSize = Math.ceil(difficulty.retargetTime / difficulty.targetTime * 4);
  const tMin = difficulty.targetTime - variance;
  const tMax = difficulty.targetTime + variance;

  // Per-client tracking (optional, but we keep it simple)
  this._clientListeners = new Map(); // client -> listener function

  // Log helper
  const emitLog = (severity, message) => {
    _this.emit('log', severity, message);
    if (_this.showLogs) {
      // Fallback to console if no listener
      console.log(`${severity}: ${message}`);
    }
  };

  // --------------------------------------------------------------------------
  //  Update difficulty for a client based on share timing
  // --------------------------------------------------------------------------
  this.updateDifficulty = function(client) {
    if (!client || client.destroyed) return;

    const ts = (Date.now() / 1000) | 0;

    // Initialize per-client data if not present
    if (!client._diffData) {
      client._diffData = {
        lastRtc: ts - _this.options.retargetTime / 2,
        lastTs: ts,
        timeBuffer: new RingBuffer(bufferSize),
      };
      if (_this.showLogs) {
        emitLog('debug', `Initializing difficulty for client ${client.getLabel()}`);
      }
      return;
    }

    const data = client._diffData;
    const sinceLast = ts - data.lastTs;
    data.timeBuffer.append(sinceLast);
    data.lastTs = ts;

    const avg = data.timeBuffer.avg();
    let ddiff = _this.options.targetTime / avg;

    // Check if retarget time has passed
    if ((ts - data.lastRtc) < _this.options.retargetTime || data.timeBuffer.size() === 0) {
      if (_this.showLogs) {
        emitLog('debug', `No difficulty update for ${client.getLabel()}: retarget not due or insufficient samples`);
      }
      return;
    }

    data.lastRtc = ts;

    // Determine difficulty adjustment
    let newDiff = client.difficulty;
    if (avg > tMax && client.difficulty > _this.options.minimum) {
      // Too slow – decrease difficulty
      if (_this.showLogs) {
        emitLog('debug', `Decreasing difficulty for ${client.getLabel()}`);
      }
      const factor = Math.min(ddiff, 1);
      newDiff = utils.toFixed(client.difficulty * factor, 8);
      if (newDiff < _this.options.minimum) {
        newDiff = _this.options.minimum;
      }
    } else if (avg < tMin && client.difficulty < _this.options.maximum) {
      // Too fast – increase difficulty
      if (_this.showLogs) {
        emitLog('debug', `Increasing difficulty for ${client.getLabel()}`);
      }
      const factor = Math.max(ddiff, 1);
      newDiff = utils.toFixed(client.difficulty * factor, 8);
      if (newDiff > _this.options.maximum) {
        newDiff = _this.options.maximum;
      }
    } else {
      if (_this.showLogs) {
        emitLog('debug', `No difficulty update for ${client.getLabel()}: within target range`);
      }
      return;
    }

    // Only emit if difficulty actually changed
    if (Math.abs(newDiff - client.difficulty) > 0.00000001) {
      data.timeBuffer.clear();
      _this.emit('newDifficulty', client, newDiff);
      if (_this.showLogs) {
        emitLog('debug', `Difficulty updated for ${client.getLabel()}: ${client.difficulty} → ${newDiff}`);
      }
    }
  };

  // --------------------------------------------------------------------------
  //  Manage a client – attach submit listener
  // --------------------------------------------------------------------------
  this.manageClient = function(client) {
    const stratumPort = client.socket ? client.socket.localPort : null;
    if (stratumPort !== _this.port) {
      emitLog('error', `Trying to manage client on wrong port: ${stratumPort} != ${_this.port}`);
      return;
    }

    // Remove any existing listener first (to avoid duplicates)
    _this.unmanageClient(client);

    // Define listener
    const listener = function() {
      // When client submits a share, update difficulty
      _this.updateDifficulty(client);
    };

    // Store reference
    _this._clientListeners.set(client, listener);
    client.on('submit', listener);

    // Initialize difficulty data on first share (or now)
    if (!client._diffData) {
      const ts = (Date.now() / 1000) | 0;
      client._diffData = {
        lastRtc: ts - _this.options.retargetTime / 2,
        lastTs: ts,
        timeBuffer: new RingBuffer(bufferSize),
      };
    }

    if (_this.showLogs) {
      emitLog('debug', `Started managing difficulty for client ${client.getLabel()}`);
    }
  };

  // --------------------------------------------------------------------------
  //  Unmanage a client – remove submit listener
  // --------------------------------------------------------------------------
  this.unmanageClient = function(client) {
    const listener = _this._clientListeners.get(client);
    if (listener) {
      client.removeListener('submit', listener);
      _this._clientListeners.delete(client);
      // Clear diff data to allow re‑initialization if re‑added
      delete client._diffData;
      if (_this.showLogs) {
        emitLog('debug', `Stopped managing difficulty for client ${client.getLabel()}`);
      }
    }
  };

  // --------------------------------------------------------------------------
  //  Clean up all clients (when port is closed)
  // --------------------------------------------------------------------------
  this.shutdown = function() {
    for (const [client, listener] of _this._clientListeners) {
      if (client && !client.destroyed) {
        client.removeListener('submit', listener);
        delete client._diffData;
      }
    }
    _this._clientListeners.clear();
    _this.removeAllListeners();
    if (_this.showLogs) {
      emitLog('info', 'Difficulty manager shut down');
    }
  };
};

// Inherit EventEmitter
Difficulty.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Difficulty;
