/*
 * main.js (Optimized)
 *
 * Entry point for foundation-stratum
 * Exports pool factory, algorithms, daemon, difficulty utilities
 */

const Pool = require('./main/pool');
const algorithms = require('./main/algorithms');
const daemon = require('./main/daemon');
const difficulty = require('./main/difficulty');
const pkg = require('../package.json');

// Expose core components
exports.algorithms = algorithms;
exports.daemon = daemon;
exports.difficulty = difficulty;

/**
 * Factory method to create a new Pool instance.
 *
 * @param {Object} poolOptions   - Pool configuration (daemon, redis, etc.)
 * @param {Object} portalOptions - Portal configuration (web UI)
 * @param {Function} authorizeFn - Callback for authorizing miners
 * @param {Function} responseFn  - Callback for sending responses
 * @returns {Pool}               - Fully initialized Pool instance
 * @throws {Error}               - If poolOptions are missing or creation fails
 */
exports.create = function(poolOptions, portalOptions, authorizeFn, responseFn) {
  // Validate required parameter
  if (!poolOptions || typeof poolOptions !== 'object') {
    const err = new Error('poolOptions are required to create a pool instance');
    console.error('[Stratum] ' + err.message);
    throw err;
  }

  try {
    return new Pool(poolOptions, portalOptions, authorizeFn, responseFn);
  } catch (err) {
    // Log the error with context and re-throw for the caller
    console.error('[Stratum] Failed to create pool:', err.message);
    if (err.stack) console.error(err.stack);
    throw err;
  }
};

// Expose package version for tracking
exports.version = pkg.version;

// Optional: If you want to expose a health-check function,
// you could add it here. For now, we keep it clean.
