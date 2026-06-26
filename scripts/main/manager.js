/*
 *
 * Manager (Optimized)
 *
 * Manages mining jobs, processes shares, and handles block validation.
 * Emits:
 *   - 'newBlock' (template) – when a new block is found
 *   - 'updatedBlock' (template) – when current block updates
 *   - 'share' (shareData, auxShareData, blockValid) – for each processed share
 *   - 'log' (severity, message)
 */

const events = require('events');
const bignum = require('bignum');
const utils = require('./utils');
const Algorithms = require('./algorithms');
const Merkle = require('./merkle');
const Template = require('./template');

// -----------------------------------------------------------------------------

const Manager = function(poolConfig, portalConfig) {
  const _this = this;

  // Set max listeners to avoid warnings (many shares can be processed)
  this.setMaxListeners(0);

  this.poolConfig = poolConfig;
  this.portalConfig = portalConfig;

  const algorithm = this.poolConfig.primary.coin.algorithms.mining;
  const shareMultiplier = Algorithms[algorithm].multiplier;
  const extraNonceSize = ['kawpow', 'firopow'].includes(algorithm) ? 2 : 4;

  this.currentJob = null;
  this.validJobs = {};
  this.jobCounter = utils.jobCounter();
  this.extraNoncePlaceholder = ['kawpow', 'firopow'].includes(algorithm)
    ? Buffer.from('f000', 'hex')
    : Buffer.from('f000000ff111111f', 'hex');
  this.extraNonceCounter = utils.extraNonceCounter(extraNonceSize);
  this.extraNonce2Size = this.extraNoncePlaceholder.length - this.extraNonceCounter.size;
  this.auxMerkle = null;

  // Logging helper
  const emitLog = (severity, message) => {
    _this.emit('log', severity, message);
  };

  // --------------------------------------------------------------------------
  //  Merkle tree for auxiliary chain
  // --------------------------------------------------------------------------
  this.buildMerkleTree = function(auxData) {
    if (!auxData) return null;
    const merkleData = [Buffer.alloc(32)];
    const position = utils.getAuxMerklePosition(auxData.chainid, 1);
    const hash = utils.uint256BufferFromHash(auxData.hash);
    if (position < merkleData.length) {
      hash.copy(merkleData[position]);
    }
    return new Merkle(merkleData);
  };

  // --------------------------------------------------------------------------
  //  Update current job (without emitting 'newBlock')
  // --------------------------------------------------------------------------
  this.updateCurrentJob = function(rpcData) {
    const auxMerkle = this.buildMerkleTree(rpcData.auxData);
    const tmpTemplate = new Template(
      this.poolConfig,
      Object.assign({}, rpcData),
      this.jobCounter.next(),
      this.extraNoncePlaceholder,
      auxMerkle
    );
    this.currentJob = tmpTemplate;
    this.validJobs = {};
    this.validJobs[tmpTemplate.jobId] = tmpTemplate;
    this.auxMerkle = auxMerkle;
    this.emit('updatedBlock', tmpTemplate);
    emitLog('debug', `Updated current job (height ${tmpTemplate.rpcData.height})`);
  };

  // --------------------------------------------------------------------------
  //  Process new block template – returns true if new block was accepted
  // --------------------------------------------------------------------------
  this.processTemplate = function(rpcData, processNew) {
    // Check if this is a new block (different previous hash or bits)
    let isNewBlock = typeof(this.currentJob) === 'undefined';
    if (this.currentJob) {
      const cur = this.currentJob.rpcData;
      if (cur.previousblockhash !== rpcData.previousblockhash || cur.bits !== rpcData.bits) {
        isNewBlock = true;
        // Guard against reorg: if height is lower, don't process
        if (rpcData.height < cur.height) {
          isNewBlock = false;
          emitLog('warning', `Rejected lower height block: ${rpcData.height} < ${cur.height}`);
        }
      }
    }

    if (!isNewBlock && !processNew) {
      return false;
    }

    // Build new template
    const auxMerkle = this.buildMerkleTree(rpcData.auxData);
    const tmpTemplate = new Template(
      this.poolConfig,
      Object.assign({}, rpcData),
      this.jobCounter.next(),
      this.extraNoncePlaceholder,
      auxMerkle
    );

    // Replace current job
    this.validJobs = {};
    this.currentJob = tmpTemplate;
    this.validJobs[tmpTemplate.jobId] = tmpTemplate;
    this.auxMerkle = auxMerkle;

    this.emit('newBlock', tmpTemplate);
    emitLog('debug', `New block at height ${tmpTemplate.rpcData.height}`);
    return true;
  };

  // --------------------------------------------------------------------------
  //  Clean up old jobs (prevent memory leaks)
  // --------------------------------------------------------------------------
  this.cleanupJobs = function(maxJobs) {
    maxJobs = maxJobs || 100;
    const jobIds = Object.keys(this.validJobs);
    if (jobIds.length > maxJobs) {
      // Keep only the most recent maxJobs
      const sorted = jobIds.sort((a, b) => {
        // Assuming jobId is incrementing; otherwise we need to compare timestamps
        // We'll keep the current job and the newest ones
        return parseInt(a, 10) - parseInt(b, 10);
      });
      const toRemove = sorted.slice(0, sorted.length - maxJobs);
      toRemove.forEach(id => {
        delete this.validJobs[id];
      });
      emitLog('debug', `Cleaned up ${toRemove.length} stale jobs`);
    }
  };

  // --------------------------------------------------------------------------
  //  Process a submitted share
  // --------------------------------------------------------------------------
  this.processShare = function(
    jobId, previousDifficulty, difficulty, ipAddress, port, addrPrimary,
    addrAuxiliary, submission
  ) {
    const algorithm = this.poolConfig.primary.coin.algorithms.mining;
    const shareMultiplier = Algorithms[algorithm].multiplier;
    const identifier = this.portalConfig.identifier || '';

    // Helper to emit a share error
    const shareError = function(errorCode, message) {
      const shareData = {
        job: jobId,
        ip: ipAddress,
        port: port,
        addrPrimary: addrPrimary,
        addrAuxiliary: addrAuxiliary,
        difficulty: difficulty,
        identifier: identifier,
        error: message,
      };
      _this.emit('share', shareData, null, false);
      return { error: [errorCode, message], result: null };
    };

    // Validate job existence
    const job = this.validJobs[jobId];
    if (!job || job.jobId !== jobId) {
      return shareError(21, 'job not found');
    }

    // Common validation for kawpow/firopow vs others
    let extraNonce1Buffer, extraNonce2Buffer, nonceBuffer, mixHashBuffer, nTimeInt, version;
    let headerDigest, headerBuffer, headerHash, headerBigNum;
    let blockValid = false;
    let blockHex, blockHash, coinbaseBuffer, coinbaseHash, merkleRoot;
    let shareDiff, blockDiffAdjusted;
    let shareData, auxShareData;

    // Algorithm-specific validation and processing
    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // ---- Kawpow/Firopow ----
      const submitTime = (Date.now() / 1000) | 0;

      if (!utils.isHexString(submission.headerHash)) {
        return shareError(20, 'invalid header submission [1]');
      }
      if (!utils.isHexString(submission.mixHash)) {
        return shareError(20, 'invalid mixHash submission');
      }
      if (!utils.isHexString(submission.nonce)) {
        return shareError(20, 'invalid nonce submission');
      }
      if (submission.mixHash.length !== 64) {
        return shareError(20, 'incorrect size of mixHash');
      }
      if (submission.nonce.length !== 16) {
        return shareError(20, 'incorrect size of nonce');
      }
      if (submission.nonce.indexOf(submission.extraNonce1.substring(0, 4)) !== 0) {
        return shareError(24, 'nonce out of worker range');
      }
      if (!addrPrimary && !addrAuxiliary) {
        return shareError(20, 'worker address isn\'t set properly');
      }
      if (!job.registerSubmit([submission.extraNonce1, submission.nonce, submission.headerHash, submission.mixHash])) {
        return shareError(22, 'duplicate share');
      }

      // Build coinbase and merkle root
      extraNonce1Buffer = Buffer.from(submission.extraNonce1, 'hex');
      nonceBuffer = utils.reverseBuffer(Buffer.from(submission.nonce, 'hex'));
      mixHashBuffer = Buffer.from(submission.mixHash, 'hex');
      coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer);
      coinbaseHash = job.coinbaseHasher(coinbaseBuffer);
      merkleRoot = job.merkle.withFirst(coinbaseHash);

      // Serialize header
      version = job.rpcData.version;
      const nTime = utils.packUInt32BE(job.rpcData.curtime).toString('hex');
      headerDigest = Algorithms[algorithm].hash(_this.poolConfig.primary.coin);
      headerBuffer = job.serializeHeader(merkleRoot, nTime, submission.nonce, version);
      const headerHashBuffer = utils.reverseBuffer(utils.sha256d(headerBuffer));
      headerHash = headerHashBuffer.toString('hex');

      if (submission.headerHash !== headerHash) {
        return shareError(20, 'invalid header submission [2]');
      }

      // Validate solution (Kawpow/Firopow specific)
      const hashOutputBuffer = Buffer.alloc(32);
      const isValid = headerDigest(headerHashBuffer, nonceBuffer, job.rpcData.height, mixHashBuffer, hashOutputBuffer);
      headerBigNum = bignum.fromBuffer(hashOutputBuffer, { endian: 'big', size: 32 });

      if (!isValid) {
        return shareError(20, 'submission is not valid');
      }

      // Calculate difficulty
      shareDiff = Algorithms[algorithm].diff / headerBigNum.toNumber() * shareMultiplier;
      blockDiffAdjusted = job.difficulty * shareMultiplier;
      blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer, nonceBuffer, mixHashBuffer).toString('hex');

      // Generate block hash (different for firopow)
      if (algorithm === 'firopow') {
        const combinedBuffer = Buffer.alloc(120);
        headerBuffer.copy(combinedBuffer);
        merkleRoot.copy(combinedBuffer, 36);
        nonceBuffer.copy(combinedBuffer, 80);
        utils.reverseBuffer(mixHashBuffer).copy(combinedBuffer, 88);
        blockHash = utils.reverseBuffer(utils.sha256d(combinedBuffer)).toString('hex');
      } else {
        blockHash = hashOutputBuffer.toString('hex');
      }

      // Check if valid block candidate
      if (job.target.ge(headerBigNum)) {
        blockValid = true;
      } else {
        if (shareDiff / difficulty < 0.99) {
          if (previousDifficulty && shareDiff >= previousDifficulty) {
            difficulty = previousDifficulty;
          } else {
            return shareError(23, `low difficulty share of ${shareDiff}`);
          }
        }
      }

      // Build share data
      shareData = {
        job: jobId,
        ip: ipAddress,
        port: port,
        addrPrimary, addrAuxiliary,
        blockDiffPrimary: blockDiffAdjusted,
        blockType: blockValid ? 'primary' : 'share',
        coinbase: coinbaseBuffer,
        difficulty,
        hash: blockHash,
        hex: blockHex,
        header: headerHash,
        headerDiff: headerBigNum,
        height: job.rpcData.height,
        identifier,
        reward: job.rpcData.coinbasevalue,
        shareDiff: shareDiff.toFixed(8),
      };
      auxShareData = {
        job: jobId,
        ip: ipAddress,
        port: port,
        addrPrimary, addrAuxiliary,
        blockDiffPrimary: blockDiffAdjusted,
        blockType: 'auxiliary',
        coinbase: coinbaseBuffer,
        difficulty,
        hash: blockHash,
        hex: blockHex,
        header: headerHash,
        headerDiff: headerBigNum,
        identifier,
        shareDiff: shareDiff.toFixed(8),
      };

    } else {
      // ---- Default (standard) ----
      const submitTime = (Date.now() / 1000) | 0;

      if (submission.extraNonce2.length / 2 !== this.extraNonce2Size) {
        return shareError(20, 'incorrect size of extranonce2');
      }
      if (submission.nTime.length !== 8) {
        return shareError(20, 'incorrect size of ntime');
      }
      const nTimeInt = parseInt(submission.nTime, 16);
      if (nTimeInt < job.rpcData.curtime || nTimeInt > submitTime + 7200) {
        return shareError(20, 'ntime out of range');
      }
      if (submission.nonce.length !== 8) {
        return shareError(20, 'incorrect size of nonce');
      }
      if (!addrPrimary && !addrAuxiliary) {
        return shareError(20, 'worker address isn\'t set properly');
      }
      if (!job.registerSubmit([submission.extraNonce1, submission.extraNonce2, submission.nTime, submission.nonce])) {
        return shareError(22, 'duplicate share');
      }

      // Asicboost version handling
      version = job.rpcData.version;
      if (submission.asicboost && submission.versionBit !== undefined) {
        const vBit = parseInt('0x' + submission.versionBit);
        const vMask = parseInt('0x' + submission.versionMask);
        if ((vBit & ~vMask) !== 0) {
          return shareError(20, 'invalid version bit');
        }
        version = (version & ~vMask) | (vBit & vMask);
      }

      // Build coinbase and merkle root
      extraNonce1Buffer = Buffer.from(submission.extraNonce1, 'hex');
      extraNonce2Buffer = Buffer.from(submission.extraNonce2, 'hex');
      coinbaseBuffer = job.serializeCoinbase(extraNonce1Buffer, extraNonce2Buffer);
      coinbaseHash = job.coinbaseHasher(coinbaseBuffer);
      merkleRoot = job.merkle.withFirst(coinbaseHash);

      // Serialize and hash header
      headerDigest = Algorithms[algorithm].hash(_this.poolConfig.primary.coin);
      headerBuffer = job.serializeHeader(merkleRoot, submission.nTime, submission.nonce, version);
      headerHash = headerDigest(headerBuffer, nTimeInt);
      headerBigNum = bignum.fromBuffer(headerHash, { endian: 'little', size: 32 });

      shareDiff = Algorithms[algorithm].diff / headerBigNum.toNumber() * shareMultiplier;
      blockDiffAdjusted = job.difficulty * shareMultiplier;
      blockHex = job.serializeBlock(headerBuffer, coinbaseBuffer, null, null).toString('hex');
      blockHash = job.blockHasher(headerBuffer, submission.nTime).toString('hex');

      if (job.target.ge(headerBigNum)) {
        blockValid = true;
      } else {
        if (shareDiff / difficulty < 0.99) {
          if (previousDifficulty && shareDiff >= previousDifficulty) {
            difficulty = previousDifficulty;
          } else {
            return shareError(23, `low difficulty share of ${shareDiff}`);
          }
        }
      }

      shareData = {
        job: jobId,
        ip: ipAddress,
        port: port,
        addrPrimary, addrAuxiliary,
        blockDiffPrimary: blockDiffAdjusted,
        blockType: blockValid ? 'primary' : 'share',
        coinbase: coinbaseBuffer,
        difficulty,
        hash: blockHash,
        hex: blockHex,
        header: headerHash,
        headerDiff: headerBigNum,
        height: job.rpcData.height,
        identifier,
        reward: job.rpcData.coinbasevalue,
        shareDiff: shareDiff.toFixed(8),
      };
      auxShareData = {
        job: jobId,
        ip: ipAddress,
        port: port,
        addrPrimary, addrAuxiliary,
        blockDiffPrimary: blockDiffAdjusted,
        blockType: 'auxiliary',
        coinbase: coinbaseBuffer,
        difficulty,
        hash: blockHash,
        hex: blockHex,
        header: headerHash,
        headerDiff: headerBigNum,
        identifier,
        shareDiff: shareDiff.toFixed(8),
      };
    }

    // Emit share event
    this.emit('share', shareData, auxShareData, blockValid);

    // Clean up old jobs periodically (every 10 shares to avoid overhead)
    if (Math.random() < 0.01) { // 1% chance per share
      this.cleanupJobs(100);
    }

    return { error: null, hash: blockHash, hex: blockHex, result: true };
  };

  // --------------------------------------------------------------------------
  //  Graceful shutdown
  // --------------------------------------------------------------------------
  this.shutdown = function() {
    this.validJobs = {};
    this.currentJob = null;
    this.auxMerkle = null;
    this.removeAllListeners();
    emitLog('info', 'Manager shut down');
  };
};

// Inherit EventEmitter
Manager.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Manager;
