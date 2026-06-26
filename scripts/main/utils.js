/*
 *
 * Utils (Optimized)
 *
 * Collection of low‑level utility functions used across the stratum module.
 * All functions are pure and side‑effect‑free.
 */

const bchaddr = require('bchaddrjs');
const bignum = require('bignum');
const bitcoin = require('foundation-utxo-lib');
const crypto = require('crypto');

// -----------------------------------------------------------------------------
//  Address & Script conversions
// -----------------------------------------------------------------------------

/**
 * Convert an address to a scriptPubKey buffer.
 * @param {string} addr - Bitcoin/cash address
 * @param {Object} network - network configuration (coin, etc.)
 * @returns {Buffer}
 */
exports.addressToScript = function(addr, network) {
  network = network || {};
  if (network.coin === 'bch' && bchaddr.isCashAddress(addr)) {
    addr = bchaddr.toLegacyAddress(addr);
    return bitcoin.address.toOutputScript(addr, network);
  }
  if (typeof network.coin !== 'undefined') {
    return bitcoin.address.toOutputScript(addr, network);
  }
  // Fallback for unknown network: P2PKH
  const hash = bitcoin.address.fromBase58Check(addr).hash;
  return Buffer.concat([
    Buffer.from([0x76, 0xa9, 0x14]),
    hash,
    Buffer.from([0x88, 0xac])
  ]);
};

// -----------------------------------------------------------------------------
//  Difficulty / target conversion (bits ↔ bignum)
// -----------------------------------------------------------------------------

/**
 * Convert a 4‑byte bits buffer to a target bignum.
 * @param {Buffer} bitsBuff - 4‑byte buffer (little‑endian)
 * @returns {bignum}
 */
exports.bignumFromBitsBuffer = function(bitsBuff) {
  const numBytes = bitsBuff.readUInt8(0);
  const bigBits = bignum.fromBuffer(bitsBuff.slice(1));
  const exponent = bignum(8).mul(numBytes - 3);
  return bigBits.mul(bignum(2).pow(exponent));
};

/**
 * Convert a hex bits string to a target bignum.
 * @param {string} bitsString - 8 hex chars
 * @returns {bignum}
 */
exports.bignumFromBitsHex = function(bitsString) {
  const bitsBuff = Buffer.from(bitsString, 'hex');
  return exports.bignumFromBitsBuffer(bitsBuff);
};

// -----------------------------------------------------------------------------
//  Binary / hex helpers
// -----------------------------------------------------------------------------

/**
 * Generate a fixed‑length buffer filled with zeros, then write a string.
 * @param {string} s - string to write (max 12 chars)
 * @returns {Buffer} 12‑byte buffer
 */
exports.commandStringBuffer = function(s) {
  const buff = Buffer.alloc(12);
  buff.fill(0);
  buff.write(s);
  return buff;
};

/**
 * Check if a character is a valid hex digit (fast, no regex).
 * @param {string} c - single character
 * @returns {boolean}
 */
function isHexChar(c) {
  const code = c.charCodeAt(0);
  return (code >= 48 && code <= 57) || // 0-9
         (code >= 97 && code <= 102) || // a-f
         (code >= 65 && code <= 70);    // A-F
}

/**
 * Check if a string is a valid hex string (even length, all hex chars).
 * @param {string} s
 * @returns {boolean}
 */
exports.isHexString = function(s) {
  if (typeof s !== 'string') return false;
  const len = s.length;
  if (len % 2 !== 0) return false;
  for (let i = 0; i < len; i++) {
    if (!isHexChar(s[i])) return false;
  }
  return true;
};

/**
 * Check if a two‑character string is a valid hex byte.
 * @param {string} c - exactly two characters
 * @returns {boolean}
 */
exports.isHex = function(c) {
  if (typeof c !== 'string' || c.length !== 2) return false;
  const a = parseInt(c, 16);
  if (isNaN(a)) return false;
  const b = a.toString(16).toLowerCase();
  // Pad to two digits
  const padded = b.length === 1 ? '0' + b : b;
  return padded === c.toLowerCase();
};

// -----------------------------------------------------------------------------
//  Counters
// -----------------------------------------------------------------------------

/**
 * Generate a unique extraNonce for each subscriber (random bytes).
 * @param {number} size - number of bytes (default 4)
 * @returns {Object} with `.next()` returning hex string
 */
exports.extraNonceCounter = function(size) {
  size = size || 4;
  return {
    size: size,
    next: function() {
      return crypto.randomBytes(this.size).toString('hex');
    }
  };
};

/**
 * Generate a monotonically increasing job counter (wraps at 0xffff).
 * @returns {Object} with `.next()` and `.cur()` returning hex string
 */
exports.jobCounter = function() {
  let counter = 0;
  return {
    next: function() {
      counter += 1;
      if (counter % 0xffff === 0) counter = 1;
      return this.cur();
    },
    cur: function() {
      return counter.toString(16);
    }
  };
};

/**
 * Generate a unique subscription ID.
 * @returns {Object} with `.next()` returning hex string
 */
exports.subscriptionCounter = function() {
  let count = 0;
  const padding = 'deadbeefcafebabe';
  return {
    next: function() {
      count += 1;
      if (count >= Number.MAX_SAFE_INTEGER) count = 0;
      return padding + exports.packUInt64LE(count).toString('hex');
    }
  };
};

// -----------------------------------------------------------------------------
//  Pack / unpack helpers (all return Buffer)
// -----------------------------------------------------------------------------

exports.packUInt16LE = function(num) {
  const buff = Buffer.alloc(2);
  buff.writeUInt16LE(num, 0);
  return buff;
};

exports.packUInt16BE = function(num) {
  const buff = Buffer.alloc(2);
  buff.writeUInt16BE(num, 0);
  return buff;
};

exports.packUInt32LE = function(num) {
  const buff = Buffer.alloc(4);
  buff.writeUInt32LE(num, 0);
  return buff;
};

exports.packUInt32BE = function(num) {
  const buff = Buffer.alloc(4);
  buff.writeUInt32BE(num, 0);
  return buff;
};

exports.packUInt64LE = function(num) {
  const buff = Buffer.alloc(8);
  buff.writeUInt32LE(num % Math.pow(2, 32), 0);
  buff.writeUInt32LE(Math.floor(num / Math.pow(2, 32)), 4);
  return buff;
};

exports.packUInt64BE = function(num) {
  const buff = Buffer.alloc(8);
  buff.writeUInt32BE(Math.floor(num / Math.pow(2, 32)), 0);
  buff.writeUInt32BE(num % Math.pow(2, 32), 4);
  return buff;
};

exports.packInt32LE = function(num) {
  const buff = Buffer.alloc(4);
  buff.writeInt32LE(num, 0);
  return buff;
};

exports.packInt32BE = function(num) {
  const buff = Buffer.alloc(4);
  buff.writeInt32BE(num, 0);
  return buff;
};

// -----------------------------------------------------------------------------
//  Script helpers
// -----------------------------------------------------------------------------

/**
 * Convert a public key hex to a scriptPubKey (P2PK).
 * @param {string} key - 66‑char hex (33 bytes)
 * @returns {Buffer}
 */
exports.pubkeyToScript = function(key) {
  if (key.length !== 66) {
    throw new Error('Invalid pubkey length: ' + key.length);
  }
  const pubKey = Buffer.concat([
    Buffer.from([0x21]),      // push 33 bytes
    Buffer.alloc(33),         // placeholder for key
    Buffer.from([0xac])       // OP_CHECKSIG
  ]);
  const bufferKey = Buffer.from(key, 'hex');
  if (bufferKey.length !== 33) {
    throw new Error('Invalid pubkey hex');
  }
  bufferKey.copy(pubKey, 1);
  return pubKey;
};

// -----------------------------------------------------------------------------
//  Merkle / auxiliary position
// -----------------------------------------------------------------------------

/**
 * Compute the merkle position for auxiliary chain data.
 * @param {number} chain_id - chain identifier
 * @param {number} size - merkle tree size
 * @returns {number}
 */
exports.getAuxMerklePosition = function(chain_id, size) {
  return (1103515245 * chain_id + 1103515245 * 12345 + 12345) % size;
};

// -----------------------------------------------------------------------------
//  Range generator
// -----------------------------------------------------------------------------

/**
 * Generate an array of numbers from start to stop (exclusive) with step.
 * @param {number} start
 * @param {number} [stop]
 * @param {number} [step=1]
 * @returns {number[]}
 */
exports.range = function(start, stop, step) {
  if (step === undefined) step = 1;
  if (stop === undefined) {
    stop = start;
    start = 0;
  }
  if ((step > 0 && start >= stop) || (step < 0 && start <= stop)) {
    return [];
  }
  const result = [];
  for (let i = start; step > 0 ? i < stop : i > stop; i += step) {
    result.push(i);
  }
  return result;
};

// -----------------------------------------------------------------------------
//  Buffer operations
// -----------------------------------------------------------------------------

/**
 * Reverse a buffer in‑place and return it.
 * @param {Buffer} buff
 * @returns {Buffer} (same instance, reversed)
 */
exports.reverseBuffer = function(buff) {
  const len = buff.length;
  for (let i = 0; i < len / 2; i++) {
    const j = len - 1 - i;
    const tmp = buff[i];
    buff[i] = buff[j];
    buff[j] = tmp;
  }
  return buff;
};

/**
 * Reverse the byte order of a 32‑byte buffer (swap 4‑byte words).
 * @param {Buffer} buff - exactly 32 bytes
 * @returns {Buffer} (same instance, modified)
 */
exports.reverseByteOrder = function(buff) {
  if (buff.length !== 32) {
    throw new Error('reverseByteOrder expects a 32‑byte buffer');
  }
  for (let i = 0; i < 8; i += 1) {
    const pos = i * 4;
    const val = buff.readUInt32BE(pos);
    buff.writeUInt32LE(val, pos);
  }
  return exports.reverseBuffer(buff);
};

/**
 * Reverse a hex string (two‑byte reverse).
 * @param {string} hex
 * @returns {string}
 */
exports.reverseHex = function(hex) {
  return exports.reverseBuffer(Buffer.from(hex, 'hex')).toString('hex');
};

// -----------------------------------------------------------------------------
//  Variable‑length integer encoding
// -----------------------------------------------------------------------------

/**
 * Serialize a number to a variable‑length integer (VarInt).
 * @param {number} n
 * @returns {Buffer}
 */
exports.varIntBuffer = function(n) {
  if (n < 0xfd) {
    return Buffer.from([n]);
  } else if (n <= 0xffff) {
    const buff = Buffer.alloc(3);
    buff[0] = 0xfd;
    exports.packUInt16LE(n).copy(buff, 1);
    return buff;
  } else if (n <= 0xffffffff) {
    const buff = Buffer.alloc(5);
    buff[0] = 0xfe;
    exports.packUInt32LE(n).copy(buff, 1);
    return buff;
  } else {
    const buff = Buffer.alloc(9);
    buff[0] = 0xff;
    exports.packUInt64LE(n).copy(buff, 1);
    return buff;
  }
};

/**
 * Serialize a string as a VarString (VarInt length + string bytes).
 * @param {string} string
 * @returns {Buffer}
 */
exports.varStringBuffer = function(string) {
  const strBuff = Buffer.from(string, 'utf8');
  return Buffer.concat([exports.varIntBuffer(strBuff.length), strBuff]);
};

// -----------------------------------------------------------------------------
//  Hash functions
// -----------------------------------------------------------------------------

/**
 * Single SHA‑256 hash.
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
exports.sha256 = function(buffer) {
  return crypto.createHash('sha256').update(buffer).digest();
};

/**
 * Double SHA‑256 (SHA‑256d).
 * @param {Buffer} buffer
 * @returns {Buffer}
 */
exports.sha256d = function(buffer) {
  return exports.sha256(exports.sha256(buffer));
};

// -----------------------------------------------------------------------------
//  Big number / hash conversions
// -----------------------------------------------------------------------------

/**
 * Convert a hex hash (little‑endian) to a 32‑byte buffer in big‑endian.
 * @param {string} hex - 64 hex chars
 * @param {boolean} reverse - if true, reverse the byte order (default true)
 * @returns {Buffer}
 */
exports.uint256BufferFromHash = function(hex, options) {
  const opts = options || {};
  const size = opts.size || 32;
  let fromHex = Buffer.from(hex, 'hex');
  if (fromHex.length !== size) {
    const empty = Buffer.alloc(size);
    empty.fill(0);
    fromHex.copy(empty);
    fromHex = empty;
  }
  if (opts.endian === 'little') {
    return exports.reverseBuffer(fromHex);
  }
  return fromHex;
};

// -----------------------------------------------------------------------------
//  Serialization helpers
// -----------------------------------------------------------------------------

/**
 * Serialize a number to a compact format (used for height/date).
 * @param {number} n
 * @returns {Buffer}
 */
exports.serializeNumber = function(n) {
  if (n >= 1 && n <= 16) {
    return Buffer.from([0x50 + n]);
  }
  let l = 1;
  const buff = Buffer.alloc(9);
  while (n > 0x7f) {
    buff.writeUInt8(n & 0xff, l++);
    n >>= 8;
  }
  buff.writeUInt8(l, 0);
  buff.writeUInt8(n, l++);
  return buff.slice(0, l);
};

/**
 * Serialize a string with length prefix (used for signatures).
 * @param {string} s
 * @returns {Buffer}
 */
exports.serializeString = function(s) {
  const strBuff = Buffer.from(s, 'utf8');
  const len = strBuff.length;
  if (len < 253) {
    return Buffer.concat([Buffer.from([len]), strBuff]);
  } else if (len < 0x10000) {
    return Buffer.concat([Buffer.from([253]), exports.packUInt16LE(len), strBuff]);
  } else if (len < 0x100000000) {
    return Buffer.concat([Buffer.from([254]), exports.packUInt32LE(len), strBuff]);
  } else {
    return Buffer.concat([Buffer.from([255]), exports.packUInt64LE(len), strBuff]);
  }
};

// -----------------------------------------------------------------------------
//  Formatting helpers
// -----------------------------------------------------------------------------

/**
 * Truncate a number to a fixed number of decimal places.
 * @param {number} num
 * @param {number} len - number of decimal places
 * @returns {number}
 */
exports.toFixed = function(num, len) {
  return parseFloat(num.toFixed(len));
};
