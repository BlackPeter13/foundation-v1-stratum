/*
 *
 * Template (Optimized)
 *
 * Represents a mining job template derived from a block template RPC call.
 * Handles serialization of coinbase, headers, blocks, and generating job parameters for clients.
 */

const bignum = require('bignum');
const utils = require('./utils');
const Sha3 = require('sha3');
const Algorithms = require('./algorithms');
const Merkle = require('./merkle');
const Transactions = require('./transactions');

// -----------------------------------------------------------------------------

/**
 * @param {Object} poolConfig
 * @param {Object} rpcData - raw getblocktemplate response
 * @param {string|number} jobId - unique job identifier
 * @param {Buffer} extraNoncePlaceholder
 * @param {Merkle|null} auxMerkle - optional auxiliary merkle tree
 */
const Template = function(poolConfig, rpcData, jobId, extraNoncePlaceholder, auxMerkle) {
  const _this = this;

  this.poolConfig = poolConfig;
  this.submits = [];
  this.rpcData = rpcData;
  this.jobId = jobId;

  const algorithm = this.poolConfig.primary.coin.algorithms.mining;
  const coinAlgo = Algorithms[algorithm];
  const diff = coinAlgo.diff;

  // Target (from bits or explicit target)
  this.target = rpcData.target
    ? bignum(rpcData.target, 16)
    : utils.bignumFromBitsHex(rpcData.bits);
  this.difficulty = parseFloat((diff / this.target.toNumber()).toFixed(9));

  // Check if merged mining is supported with extra coinbase payload
  if (rpcData.coinbase_payload && this.poolConfig.auxiliary && this.poolConfig.auxiliary.enabled) {
    throw new Error('Merged mining is not supported with coins that pass an extra coinbase payload.');
  }

  // --------------------------------------------------------------------------
  //  Hash functions (cached)
  // --------------------------------------------------------------------------
  const blockAlgorithm = this.poolConfig.primary.coin.algorithms.block;
  const blockHashDigest = Algorithms[blockAlgorithm].hash(this.poolConfig.primary.coin);
  this.blockHasher = function() {
    return utils.reverseBuffer(blockHashDigest.apply(this, arguments));
  };

  const coinbaseAlgorithm = this.poolConfig.primary.coin.algorithms.coinbase;
  const coinbaseHashDigest = Algorithms[coinbaseAlgorithm].hash(this.poolConfig.primary.coin);
  this.coinbaseHasher = function() {
    return coinbaseHashDigest.apply(this, arguments);
  };

  // --------------------------------------------------------------------------
  //  Merkle tree and generation transaction
  // --------------------------------------------------------------------------
  this.getMerkleHashes = function(steps) {
    return steps.map((step) => step.toString('hex'));
  };

  this.getTransactionBuffers = function(txs) {
    const txHashes = txs.map((tx) => {
      const hash = tx.txid !== undefined ? tx.txid : tx.hash;
      return utils.uint256BufferFromHash(hash);
    });
    return [null, ...txHashes];
  };

  this.getVoteData = function() {
    if (!this.rpcData.masternode_payments) return Buffer.alloc(0);
    const votes = this.rpcData.votes || [];
    return Buffer.concat([
      utils.varIntBuffer(votes.length),
      ...votes.map((vt) => Buffer.from(vt, 'hex'))
    ]);
  };

  this.createMerkle = function(rpcData) {
    return new Merkle(this.getTransactionBuffers(rpcData.transactions));
  };

  this.createGeneration = function(poolConfig, rpcData, extraNoncePlaceholder, auxMerkle) {
    return new Transactions().default(poolConfig, rpcData, extraNoncePlaceholder, auxMerkle);
  };

  this.merkle = this.createMerkle(this.rpcData);
  this.generation = this.createGeneration(
    this.poolConfig,
    this.rpcData,
    extraNoncePlaceholder,
    auxMerkle
  );
  this.previousblockhash = utils.reverseByteOrder(
    Buffer.from(this.rpcData.previousblockhash, 'hex')
  ).toString('hex');
  this.transactions = Buffer.concat(
    this.rpcData.transactions.map((tx) => Buffer.from(tx.data, 'hex'))
  );

  // --------------------------------------------------------------------------
  //  Serialization methods
  // --------------------------------------------------------------------------
  this.serializeCoinbase = function(extraNonce1, extraNonce2) {
    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      return Buffer.concat([
        this.generation[0],
        extraNonce1,
        this.generation[1]
      ]);
    }
    return Buffer.concat([
      this.generation[0],
      extraNonce1,
      extraNonce2 || Buffer.alloc(0),
      this.generation[1]
    ]);
  };

  this.serializeHeader = function(merkleRoot, nTime, nonce, version) {
    const header = Buffer.alloc(80);
    let pos = 0;

    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // Kawpow/Firopow header layout: height, bits, time, merkle, prevhash, version
      header.write(utils.packUInt32BE(this.rpcData.height).toString('hex'), pos, 4, 'hex');
      pos += 4;
      header.write(this.rpcData.bits, pos, 4, 'hex');
      pos += 4;
      header.write(nTime, pos, 4, 'hex');
      pos += 4;
      header.write(utils.reverseBuffer(merkleRoot).toString('hex'), pos, 32, 'hex');
      pos += 32;
      header.write(this.rpcData.previousblockhash, pos, 32, 'hex');
      pos += 32;
      header.writeUInt32BE(version, pos, 4);
    } else {
      // Default: nonce, bits, time, merkle, prevhash, version
      header.write(nonce, pos, 4, 'hex');
      pos += 4;
      header.write(this.rpcData.bits, pos, 4, 'hex');
      pos += 4;
      header.write(nTime, pos, 4, 'hex');
      pos += 4;
      header.write(utils.reverseBuffer(merkleRoot).toString('hex'), pos, 32, 'hex');
      pos += 32;
      header.write(this.rpcData.previousblockhash, pos, 32, 'hex');
      pos += 32;
      header.writeUInt32BE(version, pos, 4);
    }
    return utils.reverseBuffer(header);
  };

  this.serializeBlock = function(header, coinbase, nonce, mixHash) {
    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // Header + nonce + mixHash + varint + coinbase + transactions
      return Buffer.concat([
        header,
        nonce || Buffer.alloc(0),
        utils.reverseBuffer(mixHash || Buffer.alloc(32)),
        utils.varIntBuffer(this.rpcData.transactions.length + 1),
        coinbase,
        this.transactions,
      ]);
    }
    // Default block
    const parts = [
      header,
      utils.varIntBuffer(this.rpcData.transactions.length + 1),
      coinbase,
      this.transactions,
      this.getVoteData(),
    ];
    // Hybrid coin support
    if (this.poolConfig.primary.coin.hybrid) {
      parts.push(Buffer.from([0]));
    }
    // Mweb support
    if (this.rpcData.mweb) {
      parts.push(Buffer.concat([
        Buffer.from([1]),
        Buffer.from(this.rpcData.mweb, 'hex')
      ]));
    }
    return Buffer.concat(parts);
  };

  // --------------------------------------------------------------------------
  //  Submit tracking
  // --------------------------------------------------------------------------
  this.registerSubmit = function(header) {
    const submission = header.join('').toLowerCase();
    if (this.submits.indexOf(submission) === -1) {
      this.submits.push(submission);
      // Trim submits to avoid memory leaks (max 10000)
      if (this.submits.length > 10000) {
        this.submits = this.submits.slice(-5000);
      }
      return true;
    }
    return false;
  };

  // --------------------------------------------------------------------------
  //  Job parameters (cached per job)
  // --------------------------------------------------------------------------
  // Cache computed values that are independent of client
  this._jobParamsCache = null;

  this._computeJobParamsCache = function() {
    const algorithm = this.poolConfig.primary.coin.algorithms.mining;
    const coinAlgo = Algorithms[algorithm];

    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // Kawpow/Firopow specific cache
      const adjPow = coinAlgo.diff / this.difficulty;
      const epochLength = Math.floor(this.rpcData.height / coinAlgo.epochLength);

      // Build seed hash
      let sha3Hash = new Sha3.SHA3Hash(256);
      const seedHashBuffer = Buffer.alloc(32);
      for (let i = 0; i < epochLength; i++) {
        sha3Hash = new Sha3.SHA3Hash(256);
        sha3Hash.update(seedHashBuffer);
        seedHashBuffer.fill(sha3Hash.digest());
      }

      // Target hex
      let targetHex = adjPow.toString(16);
      while (targetHex.length < 64) targetHex = '0' + targetHex;

      this._jobParamsCache = {
        algorithm,
        epochLength,
        seedHash: seedHashBuffer.toString('hex'),
        target: targetHex,
        adjPow,
        height: this.rpcData.height,
        bits: this.rpcData.bits,
        version: this.rpcData.version,
        curtime: this.rpcData.curtime,
        previousblockhash: this.previousblockhash,
        merkleSteps: this.merkle.steps,
        generation0: this.generation[0],
        generation1: this.generation[1],
      };
    } else {
      // Default cache
      this._jobParamsCache = {
        algorithm,
        jobId: this.jobId,
        previousblockhash: this.previousblockhash,
        generation0: this.generation[0],
        generation1: this.generation[1],
        merkleSteps: this.merkle.steps,
        version: this.rpcData.version,
        bits: this.rpcData.bits,
        curtime: this.rpcData.curtime,
        cleanJobs: true, // default
      };
    }
  };
  this._computeJobParamsCache();

  // --------------------------------------------------------------------------
  //  Get job params for a client (uses cache)
  // --------------------------------------------------------------------------
  this.getJobParams = function(client, cleanJobs) {
    const cache = this._jobParamsCache;
    const algorithm = cache.algorithm;

    if (algorithm === 'kawpow' || algorithm === 'firopow') {
      // Ensure client has extraNonce1 (generate if missing)
      if (!client.extraNonce1) {
        client.extraNonce1 = utils.extraNonceCounter(2).next();
      }
      const extraNonce1Buffer = Buffer.from(client.extraNonce1, 'hex');

      // Build coinbase and merkle root
      const coinbaseBuffer = this.serializeCoinbase(extraNonce1Buffer);
      const coinbaseHash = this.coinbaseHasher(coinbaseBuffer);
      const merkleRoot = this.merkle.withFirst(coinbaseHash);

      // Build header hash
      const nTime = utils.packUInt32BE(cache.curtime).toString('hex');
      const header = this.serializeHeader(merkleRoot, nTime, '00000000', cache.version);
      const headerBuffer = utils.reverseBuffer(utils.sha256d(header));

      return [
        this.jobId,
        headerBuffer.toString('hex'),
        cache.seedHash,
        cache.target,
        cleanJobs !== undefined ? cleanJobs : true,
        cache.height,
        cache.bits
      ];
    } else {
      // Default – no extraNonce1 needed for getJobParams
      return [
        this.jobId,
        cache.previousblockhash,
        cache.generation0.toString('hex'),
        cache.generation1.toString('hex'),
        this.getMerkleHashes(cache.merkleSteps),
        utils.packInt32BE(cache.version).toString('hex'),
        cache.bits,
        utils.packUInt32BE(cache.curtime).toString('hex'),
        cleanJobs !== undefined ? cleanJobs : true
      ];
    }
  };
};

module.exports = Template;
