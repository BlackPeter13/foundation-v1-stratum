/*
 *
 * Pool (Optimized)
 *
 * Main pool logic – coordinates stratum server, daemon, job management, and shares.
 * Now with improved logging, graceful shutdown, health checks, and async flow.
 */

const bignum = require('bignum');
const events = require('events');
const utils = require('./utils');
const Algorithms = require('./algorithms');
const Difficulty = require('./difficulty');
const Daemon = require('./daemon');
const Manager = require('./manager');
const Network = require('./network');
const Peer = require('./peer');

// -----------------------------------------------------------------------------

const Pool = function(poolConfig, portalConfig, authorizeFn, responseFn) {
  const _this = this;
  this.poolConfig = poolConfig;
  this.portalConfig = portalConfig;
  this.authorizeFn = authorizeFn;
  this.responseFn = responseFn;

  this.primary = {};
  this.auxiliary = {};

  // Internal state for shutdown
  this._shuttingDown = false;
  this._intervals = [];

  // Logging helpers
  const emitLog = (severity, text) => _this.emit('log', severity, text);
  const emitInfo = (text) => emitLog('info', text);
  const emitDebug = (text) => emitLog('debug', text);
  const emitWarning = (text) => emitLog('warning', text);
  const emitError = (text) => {
    emitLog('error', text);
    // Also send to responseFn if defined
    if (_this.responseFn) _this.responseFn(text);
  };
  const emitSpecial = (text) => emitLog('special', text);

  // Limit messages to primary worker only (forkId = 0)
  const isPrimaryWorker = () => {
    return !process.env.forkId || process.env.forkId === '0';
  };
  const limitMessages = (callback) => {
    if (isPrimaryWorker()) callback();
  };

  // ------------------------------
  //  Validation
  // ------------------------------
  this.checkAlgorithm = function(algorithm) {
    if (!(algorithm in Algorithms)) {
      const errMsg = `The ${algorithm} algorithm is not supported.`;
      emitError(errMsg);
      throw new Error(errMsg);
    }
  };

  // Validate all required algorithms
  _this.checkAlgorithm(_this.poolConfig.primary.coin.algorithms.mining);
  _this.checkAlgorithm(_this.poolConfig.primary.coin.algorithms.block);
  _this.checkAlgorithm(_this.poolConfig.primary.coin.algorithms.coinbase);

  // ------------------------------
  //  Setup flow (async/await)
  // ------------------------------
  this.setupPool = async function() {
    try {
      this.setupDifficulty();
      await this.setupDaemonInterface();
      await this.setupPoolData();
      this.setupRecipients();
      this.setupJobManager();
      await this.setupBlockchain();
      await this.setupFirstJob();
      this.setupBlockPolling();
      this.setupPeer();
      await this.setupStratum();
      this.outputPoolInfo();
      this.emit('started');
    } catch (err) {
      emitError(`Pool startup failed: ${err.message}`);
      if (err.stack) emitError(err.stack);
      throw err;
    }
  };

  // ------------------------------
  //  Difficulty
  // ------------------------------
  this.setDifficulty = function(port) {
    const currentPort = port.port;
    const currentDifficulty = port.difficulty;
    if (typeof(_this.difficulty[currentPort]) !== 'undefined') {
      _this.difficulty[currentPort].removeAllListeners();
    }
    const difficultyInstance = new Difficulty(currentPort, currentDifficulty, false);
    _this.difficulty[currentPort] = difficultyInstance;
    _this.difficulty[currentPort].on('newDifficulty', (client, newDiff) => {
      client.enqueueNextDifficulty(newDiff);
    });
  };

  this.setupDifficulty = function() {
    _this.difficulty = {};
    _this.poolConfig.ports.forEach(port => {
      if (port.difficulty) {
        _this.setDifficulty(port);
      }
    });
  };

  // ------------------------------
  //  Daemon
  // ------------------------------
  this.setupDaemon = function(daemons) {
    return new Promise((resolve, reject) => {
      const daemon = new Daemon(daemons, (severity, message) => {
        _this.emit('log', severity, message);
      });
      daemon.once('online', () => resolve(daemon));
      daemon.on('connectionFailed', (error) => {
        emitError(`Failed to connect daemon(s): ${JSON.stringify(error)}`);
        reject(error);
      });
      daemon.on('error', (message) => emitError(message));
      daemon.initDaemons(() => {});
    });
  };

  this.setupDaemonInterface = async function() {
    if (!Array.isArray(_this.poolConfig.primary.daemons) || _this.poolConfig.primary.daemons.length < 1) {
      emitError('No primary daemons have been configured - pool cannot start');
      throw new Error('Missing primary daemons');
    }
    _this.primary.daemon = await _this.setupDaemon(_this.poolConfig.primary.daemons);

    if (_this.poolConfig.auxiliary && _this.poolConfig.auxiliary.enabled) {
      if (!Array.isArray(_this.poolConfig.auxiliary.daemons) || _this.poolConfig.auxiliary.daemons.length < 1) {
        emitError('No auxiliary daemons have been configured - pool cannot start');
        throw new Error('Missing auxiliary daemons');
      }
      _this.auxiliary.daemon = await _this.setupDaemon(_this.poolConfig.auxiliary.daemons);
    }
  };

  // ------------------------------
  //  Pool Data
  // ------------------------------
  this.setupPoolData = function() {
    return new Promise((resolve, reject) => {
      const batchRPCCommand = [
        ['validateaddress', [_this.poolConfig.primary.address]],
        ['getmininginfo', []],
        ['submitblock', []]
      ];

      if (_this.poolConfig.primary.coin.getinfo) {
        batchRPCCommand.push(['getinfo', []]);
      } else {
        batchRPCCommand.push(['getblockchaininfo', []], ['getnetworkinfo', []]);
      }

      _this.primary.daemon.batchCmd(batchRPCCommand, (error, results) => {
        if (error || !results) {
          const errMsg = 'Could not start pool, error with init batch RPC call';
          emitError(errMsg);
          reject(new Error(errMsg));
          return;
        }

        const rpcResults = {};
        let hasError = false;
        results.forEach((output, idx) => {
          const rpcCall = batchRPCCommand[idx][0];
          rpcResults[rpcCall] = output.result || output.error;
          if (rpcCall !== 'submitblock' && (output.error || !output.result)) {
            emitError(`Could not start pool, error with init RPC call: ${rpcCall} - ${JSON.stringify(output.error)}`);
            hasError = true;
          }
        });
        if (hasError) {
          reject(new Error('RPC init failed'));
          return;
        }

        if (!rpcResults.validateaddress.isvalid) {
          emitError('Daemon reports address is not valid');
          reject(new Error('Invalid address'));
          return;
        }

        // Determine testnet
        if (_this.poolConfig.primary.coin.getinfo) {
          _this.poolConfig.settings.testnet = (rpcResults.getinfo.testnet === true);
        } else {
          _this.poolConfig.settings.testnet = (rpcResults.getblockchaininfo.chain === 'test');
        }

        _this.poolConfig.primary.address = rpcResults.validateaddress.address;
        _this.poolConfig.settings.protocolVersion = _this.poolConfig.primary.coin.getinfo
          ? rpcResults.getinfo.protocolversion
          : rpcResults.getnetworkinfo.protocolversion;

        let difficulty = _this.poolConfig.primary.coin.getinfo
          ? rpcResults.getinfo.difficulty
          : rpcResults.getblockchaininfo.difficulty;
        if (typeof(difficulty) === 'object') {
          difficulty = difficulty['proof-of-work'];
        }

        _this.poolConfig.statistics = {
          connections: _this.poolConfig.primary.coin.getinfo
            ? rpcResults.getinfo.connections
            : rpcResults.getnetworkinfo.connections,
          difficulty: difficulty * Algorithms[_this.poolConfig.primary.coin.algorithms.mining].multiplier,
        };

        // Detect submitblock support
        if (rpcResults.submitblock.message === 'Method not found') {
          _this.poolConfig.settings.hasSubmitMethod = false;
        } else if (rpcResults.submitblock.code === -1) {
          _this.poolConfig.settings.hasSubmitMethod = true;
        } else {
          emitError('Could not detect block submission RPC method');
          reject(new Error('Unknown submitblock method'));
          return;
        }

        resolve();
      });
    });
  };

  // ------------------------------
  //  Recipients
  // ------------------------------
  this.setupRecipients = function() {
    if (_this.poolConfig.primary.recipients.length === 0) {
      emitWarning('No recipients have been added which means that no fees will be taken');
    }
    _this.poolConfig.settings.feePercentage = 0;
    _this.poolConfig.primary.recipients.forEach(recipient => {
      _this.poolConfig.settings.feePercentage += recipient.percentage;
    });
  };

  // ------------------------------
  //  Block Submission
  // ------------------------------
  this.submitBlock = function(blockHex, callback) {
    let rpcCommand, rpcArgs;
    if (_this.poolConfig.settings.hasSubmitMethod) {
      rpcCommand = 'submitblock';
      rpcArgs = [blockHex];
    } else {
      rpcCommand = 'getblocktemplate';
      rpcArgs = [{ 'mode': 'submit', 'data': blockHex }];
    }

    _this.primary.daemon.cmd(rpcCommand, rpcArgs, false, (results) => {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.error) {
          emitError(`RPC error with primary daemon instance ${result.instance.index} when submitting block with ${rpcCommand}: ${JSON.stringify(result.error)}`);
          return;
        } else if (result.response === 'rejected') {
          emitError(`Primary daemon instance ${result.instance.index} rejected a supposedly valid block`);
          return;
        }
      }
      emitSpecial(`Submitted primary block successfully to ${_this.poolConfig.primary.coin.name}'s daemon instance(s)`);
      callback();
    });
  };

  this.submitAuxBlock = function(headerBuffer, coinbaseBuffer, blockHash, callback) {
    const branch = utils.uint256BufferFromHash(_this.auxiliary.rpcData.hash);
    let branchProof = _this.manager.auxMerkle.getHashProof(branch);
    if (!branchProof) {
      branchProof = Buffer.concat([utils.varIntBuffer(0), utils.packInt32LE(0)]);
    }

    const coinbaseProof = Buffer.concat([
      utils.varIntBuffer(_this.manager.currentJob.merkle.steps.length),
      Buffer.concat(_this.manager.currentJob.merkle.steps),
      utils.packInt32LE(0)
    ]);

    const auxPow = Buffer.concat([
      coinbaseBuffer,
      blockHash,
      coinbaseProof,
      branchProof,
      headerBuffer
    ]);

    const rpcArgs = [_this.auxiliary.rpcData.hash, auxPow.toString('hex')];
    _this.auxiliary.daemon.cmd('getauxblock', rpcArgs, false, (results) => {
      for (let i = 0; i < results.length; i++) {
        const result = results[i];
        if (result.error) {
          emitError(`RPC error with auxiliary daemon instance ${result.instance.index} when submitting block: ${JSON.stringify(result.error)}`);
          return;
        } else if (!result.response || result.response === 'rejected') {
          emitError(`Auxiliary daemon instance ${result.instance.index} rejected a supposedly valid block`);
          return;
        }
      }
      emitSpecial(`Submitted auxiliary block successfully to ${_this.poolConfig.auxiliary.coin.name}'s daemon instance(s)`);
      callback(_this.auxiliary.rpcData.hash);
    });
  };

  this.checkBlockAccepted = function(blockHash, daemon, callback) {
    daemon.cmd('getblock', [blockHash], false, (results) => {
      const validResults = results.filter((result) => {
        return result.response && (result.response.hash === blockHash);
      });
      if (validResults.length >= 1) {
        if (validResults[0].response.confirmations >= 0) {
          callback(true, validResults[0].response.tx[0]);
        } else {
          emitError('Block was rejected by the network');
          callback(false);
        }
      } else {
        emitError('Block was rejected by the network');
        callback(false);
      }
    });
  };

  // ------------------------------
  //  Block Template
  // ------------------------------
  this.getBlockTemplate = function(callback, force) {
    const callConfig = {
      'capabilities': ['coinbasetxn', 'workid', 'coinbase/append'],
      'rules': [],
    };
    if (_this.poolConfig.primary.coin.segwit) callConfig.rules.push('segwit');
    if (_this.poolConfig.primary.coin.mweb) callConfig.rules.push('mweb');

    _this.primary.daemon.cmd('getblocktemplate', [callConfig], true, (result) => {
      if (result.error) {
        emitError(`getblocktemplate call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
        callback(result.error);
      } else {
        if (_this.poolConfig.auxiliary && _this.poolConfig.auxiliary.enabled) {
          result.response.auxData = _this.auxiliary.rpcData;
        }
        const processedNewBlock = _this.manager.processTemplate(result.response, force);
        callback(null, result.response, processedNewBlock);
      }
    });
  };

  this.getAuxTemplate = function(callback) {
    if (_this.poolConfig.auxiliary && _this.poolConfig.auxiliary.enabled) {
      _this.auxiliary.daemon.cmd('getauxblock', [], true, (result) => {
        if (result.error) {
          emitError(`getauxblock call failed for daemon instance ${result.instance.index} with error ${JSON.stringify(result.error)}`);
          callback(result.error);
        } else {
          let updateTemplate = false;
          const hash = result.response.target || result.response._target || '';
          const target = utils.uint256BufferFromHash(hash, { endian: 'little', size: 32 });
          if (_this.auxiliary.rpcData) {
            if (_this.auxiliary.rpcData.hash !== result.response.hash) {
              updateTemplate = true;
            }
          }
          _this.auxiliary.rpcData = result.response;
          _this.auxiliary.rpcData.target = bignum.fromBuffer(target);
          callback(null, result.response, updateTemplate);
        }
      });
    } else {
      callback(null, null, false);
    }
  };

  // ------------------------------
  //  Job Manager
  // ------------------------------
  this.setupJobManager = function() {
    _this.manager = new Manager(_this.poolConfig, _this.portalConfig);
    _this.manager.on('newBlock', (blockTemplate) => {
      if (_this.stratum) {
        _this.stratum.broadcastMiningJobs(blockTemplate, true);
        if (_this.poolConfig.debug) {
          emitDebug('Established new job for updated block template');
        }
      }
    });

    _this.manager.on('share', (shareData, auxShareData, blockValid) => {
      let shareType = 'valid';
      if (shareData.error && shareData.error === 'job not found') {
        shareType = 'stale';
      } else if (shareData.error) {
        shareType = 'invalid';
      }

      if (!blockValid) {
        _this.emit('share', shareData, shareType, blockValid, () => {});
      } else {
        _this.submitBlock(shareData.hex, () => {
          _this.checkBlockAccepted(shareData.hash, _this.primary.daemon, (accepted, tx) => {
            shareData.transaction = tx;
            _this.emit('share', shareData, shareType, accepted, () => {});
            _this.getBlockTemplate((error, result, foundNewBlock) => {
              if (foundNewBlock) {
                emitSpecial('Block notification via RPC after primary block submission');
              }
            }, false);
          });
        });
      }

      // Auxiliary block handling
      if (shareType === 'valid' && _this.poolConfig.auxiliary && _this.poolConfig.auxiliary.enabled) {
        const algorithm = _this.poolConfig.primary.coin.algorithms.mining;
        const shareMultiplier = Algorithms[algorithm].multiplier;
        const difficulty = parseFloat((Algorithms[algorithm].diff / _this.auxiliary.rpcData.target.toNumber()).toFixed(9));
        auxShareData.blockDiffAuxiliary = difficulty * shareMultiplier;

        if (_this.auxiliary.rpcData.target.ge(auxShareData.headerDiff)) {
          const hexBuffer = Buffer.from(auxShareData.hex, 'hex').slice(0, 80);
          _this.submitAuxBlock(hexBuffer, auxShareData.coinbase, auxShareData.header, (hash) => {
            _this.checkBlockAccepted(hash, _this.auxiliary.daemon, (accepted, tx) => {
              auxShareData.transaction = tx;
              auxShareData.height = _this.auxiliary.rpcData.height;
              auxShareData.reward = _this.auxiliary.rpcData.coinbasevalue;
              _this.emit('share', auxShareData, shareType, accepted, () => {});
              _this.getBlockTemplate((error, result, foundNewBlock) => {
                if (foundNewBlock) {
                  emitSpecial('Block notification via RPC after auxiliary block submission');
                }
              }, true);
            });
          });
        }
      }
    });

    _this.manager.on('updatedBlock', (blockTemplate) => {
      if (_this.stratum) {
        _this.stratum.broadcastMiningJobs(blockTemplate, false);
      }
    });
  };

  // ------------------------------
  //  Blockchain Sync
  // ------------------------------
  this.setupBlockchain = function() {
    return new Promise((resolve, reject) => {
      const callConfig = {
        'capabilities': ['coinbasetxn', 'workid', 'coinbase/append'],
        'rules': [],
      };
      if (_this.poolConfig.primary.coin.segwit) callConfig.rules.push('segwit');
      if (_this.poolConfig.primary.coin.mweb) callConfig.rules.push('mweb');

      const generateProgress = () => {
        const cmd = _this.poolConfig.primary.coin.getinfo ? 'getinfo' : 'getblockchaininfo';
        _this.primary.daemon.cmd(cmd, [], false, (results) => {
          const blockCount = Math.max.apply(null, results
            .flatMap(result => result.response)
            .flatMap(response => response.blocks));
          _this.primary.daemon.cmd('getpeerinfo', [], true, (result) => {
            const peers = result.response;
            const totalBlocks = Math.max.apply(null, peers
              .flatMap(response => response.startingheight));
            const percent = (blockCount / totalBlocks * 100).toFixed(2);
            emitWarning(`Downloaded ${percent}% of blockchain from ${peers.length} peers`);
          });
        });
      };

      const checkSynced = () => {
        _this.primary.daemon.cmd('getblocktemplate', [callConfig], false, (results) => {
          const synced = results.every((r) => {
            return !r.error || r.error.code !== -10;
          });
          if (synced) {
            resolve();
          } else {
            if (isPrimaryWorker()) {
              generateProgress();
            }
            setTimeout(checkSynced, 30000);
          }
        });
      };

      // Start with a warning if not synced
      if (isPrimaryWorker()) {
        emitWarning('Daemon is still syncing with the network. The server will be started once synced.');
      }
      checkSynced();
    });
  };

  // ------------------------------
  //  First Job
  // ------------------------------
  this.setupFirstJob = function() {
    return new Promise((resolve, reject) => {
      _this.getAuxTemplate((auxError) => {
        if (auxError) {
          emitError(`Error with getauxblock on creating first job: ${auxError}`);
          reject(auxError);
          return;
        }
        _this.getBlockTemplate((error) => {
          if (error) {
            emitError(`Error with getblocktemplate on creating first job, server cannot start: ${error}`);
            reject(error);
            return;
          }
          const portWarnings = [];
          const networkDiffAdjusted = _this.poolConfig.statistics.difficulty;
          _this.poolConfig.ports.forEach(port => {
            const currentPort = port.port;
            const portDiff = port.difficulty.initial;
            if (networkDiffAdjusted < portDiff) {
              portWarnings.push(`port ${currentPort} w/ diff ${portDiff}`);
            }
          });
          if (portWarnings.length > 0 && isPrimaryWorker()) {
            emitWarning(`Network diff of ${networkDiffAdjusted} is lower than ${portWarnings.join(' and ')}`);
          }
          resolve();
        }, false);
      });
    });
  };

  // ------------------------------
  //  Block Polling
  // ------------------------------
  this.setupBlockPolling = function() {
    if (typeof _this.poolConfig.settings.blockRefreshInterval !== 'number' || _this.poolConfig.settings.blockRefreshInterval <= 0) {
      emitDebug('Block template polling has been disabled');
      return;
    }
    let pollingFlag = false;
    const intervalId = setInterval(() => {
      if (pollingFlag === false) {
        pollingFlag = true;
        _this.getAuxTemplate((auxError, auxiliaryResult, auxiliaryUpdate) => {
          _this.getBlockTemplate((primaryError, primaryResult, primaryUpdate) => {
            pollingFlag = false;
            if (primaryUpdate && !auxiliaryUpdate && isPrimaryWorker()) {
              emitDebug(`Primary chain (${_this.poolConfig.primary.coin.name}) notification via RPC polling at height ${primaryResult.height}`);
            }
            if (auxiliaryUpdate && isPrimaryWorker()) {
              emitDebug(`Auxiliary chain (${_this.poolConfig.auxiliary.coin.name}) notification via RPC polling at height ${auxiliaryResult.height}`);
            }
          }, auxiliaryUpdate);
        });
      }
    }, _this.poolConfig.settings.blockRefreshInterval);
    _this._intervals.push(intervalId);
  };

  // ------------------------------
  //  Peer (p2p)
  // ------------------------------
  this.setupPeer = function() {
    _this.poolConfig.settings.verack = false;
    _this.poolConfig.settings.validConnectionConfig = true;

    if (!_this.poolConfig.p2p || !_this.poolConfig.p2p.enabled) {
      if (isPrimaryWorker()) {
        emitDebug('p2p has been disabled in the configuration');
      }
      return;
    }
    if (_this.poolConfig.settings.testnet && !_this.poolConfig.primary.coin.testnet.peerMagic) {
      emitError('p2p cannot be enabled in testnet without peerMagic set in testnet configuration');
      return;
    } else if (!_this.poolConfig.primary.coin.mainnet.peerMagic) {
      emitError('p2p cannot be enabled without peerMagic set in mainnet configuration');
      return;
    }

    _this.peer = new Peer(_this.poolConfig);
    _this.peer.on('blockFound', (hash) => {
      emitDebug('Block notification via p2p');
      _this.processBlockNotify(hash);
    });
    _this.peer.on('connectionFailed', () => {
      emitError('p2p connection failed - likely incorrect host or port');
    });
    _this.peer.on('connectionRejected', () => {
      emitError('p2p connection failed - likely incorrect p2p magic value');
    });
    _this.peer.on('error', (msg) => {
      emitError(`p2p had an error: ${msg}`);
    });
    _this.peer.on('socketError', (e) => {
      emitError(`p2p had a socket error: ${JSON.stringify(e)}`);
    });
  };

  this.processBlockNotify = function(blockHash) {
    const currentJob = _this.manager.currentJob;
    if (currentJob && blockHash !== currentJob.rpcData.previousblockhash) {
      _this.getBlockTemplate((error) => {
        if (error) {
          emitError(`Block notify error getting block template for ${_this.poolConfig.primary.coin.name}`);
        } else {
          emitDebug(`Block template for ${_this.poolConfig.primary.coin.name} updated successfully`);
        }
      }, false);
    }
  };

  // ------------------------------
  //  Stratum Server
  // ------------------------------
  this.setupStratum = function() {
    return new Promise((resolve, reject) => {
      _this.stratum = new Network(_this.poolConfig, _this.portalConfig, _this.authorizeFn);
      _this.stratum.on('started', () => {
        const stratumPorts = _this.poolConfig.ports
          .filter(port => port.enabled)
          .flatMap(port => port.port);
        _this.poolConfig.statistics.stratumPorts = stratumPorts;
        _this.stratum.broadcastMiningJobs(_this.manager.currentJob, true);
        resolve();
      });

      // Timeout and rebroadcast
      _this.stratum.on('broadcastTimeout', () => {
        if (_this.poolConfig.debug) {
          emitDebug(`No new blocks for ${_this.poolConfig.settings.jobRebroadcastTimeout} seconds - updating transactions & rebroadcasting work`);
        }
        _this.getBlockTemplate((error, rpcData, processedBlock) => {
          if (error || processedBlock) return;
          _this.manager.updateCurrentJob(rpcData);
          if (_this.poolConfig.debug) {
            emitDebug('Updated existing job for current block template');
          }
        }, false);
      });

      // Client events
      _this.stratum.on('client.connected', (client) => {
        if (typeof(_this.difficulty[client.socket.localPort]) !== 'undefined') {
          _this.difficulty[client.socket.localPort].manageClient(client);
        }

        client.on('difficultyQueued', (diff) => {
          emitDebug(`Difficulty update queued for worker: ${client.addrPrimary} (${diff})`);
        });
        client.on('difficultyChanged', (diff) => {
          emitDebug(`Difficulty updated successfully for worker: ${client.addrPrimary} (${diff})`);
        });

        client.on('subscription', (params, callback) => {
          const extraNonce = _this.manager.extraNonceCounter.next();
          switch (_this.poolConfig.primary.coin.algorithms.mining) {
            case 'kawpow':
            case 'firopow':
              callback(null, extraNonce, extraNonce);
              break;
            default:
              callback(null, extraNonce, _this.manager.extraNonce2Size);
              break;
          }
          const validPorts = _this.poolConfig.ports
            .filter(port => port.port === client.socket.localPort)
            .filter(port => typeof port.difficulty.initial !== 'undefined');
          if (validPorts.length >= 1) {
            client.sendDifficulty(validPorts[0].difficulty.initial);
          } else {
            client.sendDifficulty(8);
          }
          const jobParams = _this.manager.currentJob.getJobParams(client, true);
          client.sendMiningJob(jobParams);
        });

        client.on('submit', (message, callback) => {
          let result, submission;
          switch (_this.poolConfig.primary.coin.algorithms.mining) {
            case 'kawpow':
            case 'firopow':
              submission = {
                extraNonce1: client.extraNonce1,
                nonce: message.params[2].substr(2),
                headerHash: message.params[3].substr(2),
                mixHash: message.params[4].substr(2),
              };
              result = _this.manager.processShare(
                message.params[1],
                client.previousDifficulty,
                client.difficulty,
                client.remoteAddress,
                client.socket.localPort,
                client.addrPrimary,
                client.addrAuxiliary,
                submission,
              );
              break;
            default:
              submission = {
                extraNonce1: client.extraNonce1,
                extraNonce2: message.params[2],
                nTime: message.params[3],
                nonce: message.params[4],
                versionBit: message.params[5],
                versionMask: client.versionMask,
                asicboost: client.asicboost,
              };
              result = _this.manager.processShare(
                message.params[1],
                client.previousDifficulty,
                client.difficulty,
                client.remoteAddress,
                client.socket.localPort,
                client.addrPrimary,
                client.addrAuxiliary,
                submission,
              );
              break;
          }
          callback(result.error, result.result ? true : null);
        });

        client.on('malformedMessage', (message) => {
          emitWarning(`Malformed message from ${client.getLabel()}: ${JSON.stringify(message)}`);
        });
        client.on('socketError', (e) => {
          emitWarning(`Socket error from ${client.getLabel()}: ${JSON.stringify(e)}`);
        });
        client.on('socketTimeout', (reason) => {
          emitWarning(`Connection timed out for ${client.getLabel()}: ${reason}`);
        });
        client.on('socketDisconnect', () => {
          emitWarning(`Socket disconnect for ${client.getLabel()}`);
        });
        client.on('kickedBannedIP', (remainingBanTime) => {
          emitWarning(`Rejected incoming connection from ${client.remoteAddress}. The client is banned for ${remainingBanTime} seconds.`);
        });
        client.on('forgaveBannedIP', () => {
          emitWarning(`Forgave banned IP ${client.remoteAddress}`);
        });
        client.on('unknownStratumMethod', (fullMessage) => {
          emitWarning(`Unknown stratum method from ${client.getLabel()}: ${fullMessage.method}`);
        });
        client.on('socketFlooded', () => {
          emitWarning(`Detected socket flooding from ${client.getLabel()}`);
        });
        client.on('tcpProxyError', (data) => {
          emitError(`Client IP detection failed, tcpProxyProtocol is enabled yet did not receive proxy protocol message, instead got data: ${data}`);
        });
        client.on('triggerBan', (reason) => {
          emitWarning(`Ban triggered for ${client.getLabel()}: ${reason}`);
          _this.emit('banIP', client.remoteAddress, client.addrPrimary);
        });
        _this.emit('connectionSucceeded');
      });

      // Error handling for stratum startup
      _this.stratum.once('error', (err) => {
        emitError(`Stratum server failed: ${err.message}`);
        reject(err);
      });
    });
  };

  // ------------------------------
  //  Output Info
  // ------------------------------
  this.outputPoolInfo = function() {
    const startMessage = `Stratum pool server started for ${_this.poolConfig.name}`;
    const infoLines = [
      startMessage,
      `Coins Connected:\t${_this.poolConfig.coins}`,
      `Network Connected:\t${_this.poolConfig.settings.testnet ? 'Testnet' : 'Mainnet'}`,
      `Current Block Height:\t${_this.manager.currentJob.rpcData.height}`,
      `Current Connect Peers:\t${_this.poolConfig.statistics.connections}`,
      `Current Block Diff:\t${_this.manager.currentJob.difficulty * Algorithms[_this.poolConfig.primary.coin.algorithms.mining].multiplier}`,
      `Network Difficulty:\t${_this.poolConfig.statistics.difficulty}`,
      `Stratum Port(s):\t${_this.poolConfig.statistics.stratumPorts.join(', ')}`,
      `Pool Fee Percentage:\t${_this.poolConfig.settings.feePercentage * 100}%`,
    ];
    if (typeof _this.poolConfig.settings.blockRefreshInterval === 'number' && _this.poolConfig.settings.blockRefreshInterval > 0) {
      infoLines.push(`Block Polling Every:\t${_this.poolConfig.settings.blockRefreshInterval} ms`);
    }
    limitMessages(() => {
      emitSpecial(infoLines.join('\n\t\t\t\t'));
    });
    if (_this.responseFn) _this.responseFn(true);
  };

  // ------------------------------
  //  Graceful Shutdown
  // ------------------------------
  this.shutdown = function(callback) {
    if (_this._shuttingDown) {
      if (callback) callback();
      return;
    }
    _this._shuttingDown = true;
    emitInfo('Shutting down pool...');

    // Clear intervals
    _this._intervals.forEach(id => clearInterval(id));
    _this._intervals = [];

    // Close stratum server
    if (_this.stratum) {
      _this.stratum.close(() => {
        emitInfo('Stratum server closed');
      });
    }

    // Close daemon connections
    if (_this.primary.daemon) {
      _this.primary.daemon.close(() => {});
    }
    if (_this.auxiliary.daemon) {
      _this.auxiliary.daemon.close(() => {});
    }

    // Close peer
    if (_this.peer) {
      _this.peer.close(() => {});
    }

    // Remove all listeners to prevent memory leaks
    _this.removeAllListeners();

    if (callback) callback();
  };

  // ------------------------------
  //  Health Check
  // ------------------------------
  this.healthCheck = function() {
    const status = {
      online: true,
      stratum: !!_this.stratum,
      daemon: !!_this.primary.daemon,
      auxiliary: !!_this.auxiliary.daemon,
      peer: !!_this.peer,
      clients: _this.stratum ? Object.keys(_this.stratum.clients).length : 0,
      lastBlockTime: _this.manager ? _this.manager.lastBlockTime : null,
      uptime: process.uptime(),
    };
    // Add daemon connection status if possible
    if (_this.primary.daemon) {
      status.daemonConnected = _this.primary.daemon.isConnected();
    }
    return status;
  };
};

// Inherit EventEmitter
Pool.prototype.__proto__ = events.EventEmitter.prototype;

module.exports = Pool;
