/*
 *
 * Transactions (Optimized)
 *
 * Constructs the coinbase transaction (generation transaction) for a block template.
 * Handles various reward distributions (masternodes, smartnodes, superblocks, etc.).
 */

const utils = require('./utils');

// -----------------------------------------------------------------------------
//  Helper: process a list of payees (masternodes, smartnodes, superblocks, etc.)
//  Adds their outputs to the transaction and subtracts from the reward.
// -----------------------------------------------------------------------------
function processPayees(payees, network, reward, txOutputBuffers, alreadySubtracted) {
  if (!payees || !Array.isArray(payees)) return reward;

  for (const payee of payees) {
    const amount = payee.amount || 0;
    let script;
    if (payee.script) {
      script = Buffer.from(payee.script, 'hex');
    } else if (payee.payee) {
      script = utils.addressToScript(payee.payee, network);
    } else {
      continue; // skip if no address/script
    }
    txOutputBuffers.push(Buffer.concat([
      utils.packUInt64LE(amount),
      utils.varIntBuffer(script.length),
      script,
    ]));
    if (!alreadySubtracted) reward -= amount;
  }
  return reward;
}

// -----------------------------------------------------------------------------
//  Main Transactions class
// -----------------------------------------------------------------------------
const Transactions = function() {};

/**
 * Build the coinbase transaction parts (p1 and p2).
 * @param {Object} poolConfig - pool configuration
 * @param {Object} rpcData - raw getblocktemplate response
 * @param {Buffer} extraNoncePlaceholder - placeholder for extraNonce
 * @param {Merkle|null} auxMerkle - auxiliary merkle tree (for merged mining)
 * @returns {[Buffer, Buffer]} [part1, part2] of the generation transaction
 */
Transactions.prototype.default = function(poolConfig, rpcData, extraNoncePlaceholder, auxMerkle) {
  const txLockTime = 0;
  const txInSequence = 0;
  const txInPrevOutHash = ''; // 32-byte zero hash
  const txInPrevOutIndex = Math.pow(2, 32) - 1;

  const network = !poolConfig.settings.testnet
    ? poolConfig.primary.coin.mainnet
    : poolConfig.primary.coin.testnet;

  let txVersion = poolConfig.primary.coin.version || 1;
  let txExtraPayload;

  // Override version if coinbasetxn is provided
  if (rpcData.coinbasetxn && rpcData.coinbasetxn.data) {
    const versionHex = utils.reverseHex(rpcData.coinbasetxn.data.slice(0, 8));
    txVersion = parseInt(versionHex, 16) || txVersion;
  }

  // Coinbase v3 block template support
  if (rpcData.coinbase_payload && rpcData.coinbase_payload.length > 0) {
    txExtraPayload = Buffer.from(rpcData.coinbase_payload, 'hex');
    txVersion = txVersion + (5 << 16);
  }

  let reward = rpcData.coinbasevalue || 0;
  const coinbaseAux = rpcData.coinbaseaux && rpcData.coinbaseaux.flags
    ? Buffer.from(rpcData.coinbaseaux.flags, 'hex')
    : Buffer.alloc(0);

  const poolAddressScript = utils.addressToScript(poolConfig.primary.address, network);

  // Hybrid coin timestamp
  const txTimestamp = poolConfig.primary.coin.hybrid === true
    ? utils.packUInt32LE(rpcData.curtime)
    : Buffer.alloc(0);

  // Build scriptSig (first part of input script)
  const heightBuf = utils.serializeNumber(rpcData.height);
  const timestampBuf = utils.serializeNumber((Date.now() / 1000) | 0);
  const placeholderLenBuf = Buffer.from([extraNoncePlaceholder.length]);

  let scriptSig = Buffer.concat([
    heightBuf,
    coinbaseAux,
    timestampBuf,
    placeholderLenBuf,
  ]);

  // Merged mining: append aux data
  if (auxMerkle && poolConfig.auxiliary && poolConfig.auxiliary.enabled) {
    const auxHeader = Buffer.from(poolConfig.auxiliary.coin.header, 'hex');
    const auxRoot = utils.reverseBuffer(auxMerkle.root);
    const auxLen = auxMerkle.data ? auxMerkle.data.length : 0;
    scriptSig = Buffer.concat([
      scriptSig,
      auxHeader,
      auxRoot,
      utils.packUInt32LE(auxLen),
      utils.packUInt32LE(0),
    ]);
  }

  // ---------- Part 1: input ----------
  const p1 = Buffer.concat([
    utils.packUInt32LE(txVersion),
    txTimestamp,
    utils.varIntBuffer(1), // number of inputs = 1
    utils.uint256BufferFromHash(txInPrevOutHash),
    utils.packUInt32LE(txInPrevOutIndex),
    utils.varIntBuffer(scriptSig.length + extraNoncePlaceholder.length),
    scriptSig,
  ]);

  // ---------- Build outputs ----------
  const txOutputBuffers = [];

  // Helper to add a single output
  const addOutput = (address, amount) => {
    if (amount <= 0) return;
    const script = utils.addressToScript(address, network);
    txOutputBuffers.push(Buffer.concat([
      utils.packUInt64LE(amount),
      utils.varIntBuffer(script.length),
      script,
    ]));
  };

  // Helper to add output from a payee object (with script or address)
  const addPayeeOutput = (payee, subtractFromReward = true) => {
    const amount = payee.amount || 0;
    if (amount <= 0) return;
    let script;
    if (payee.script) {
      script = Buffer.from(payee.script, 'hex');
    } else if (payee.payee) {
      script = utils.addressToScript(payee.payee, network);
    } else {
      return;
    }
    txOutputBuffers.push(Buffer.concat([
      utils.packUInt64LE(amount),
      utils.varIntBuffer(script.length),
      script,
    ]));
    if (subtractFromReward) reward -= amount;
  };

  // ---- Masternodes ----
  if (rpcData.masternode) {
    if (rpcData.masternode.payee) {
      addPayeeOutput(rpcData.masternode, true);
    } else if (Array.isArray(rpcData.masternode) && rpcData.masternode.length > 0) {
      for (const payee of rpcData.masternode) {
        addPayeeOutput(payee, true);
      }
    }
  }

  // ---- Smartnodes ----
  if (rpcData.smartnode) {
    if (rpcData.smartnode.payee) {
      addPayeeOutput(rpcData.smartnode, true);
    } else if (Array.isArray(rpcData.smartnode) && rpcData.smartnode.length > 0) {
      for (const payee of rpcData.smartnode) {
        addPayeeOutput(payee, true);
      }
    }
  }

  // ---- Superblocks ----
  if (rpcData.superblock && Array.isArray(rpcData.superblock) && rpcData.superblock.length > 0) {
    for (const payee of rpcData.superblock) {
      addPayeeOutput(payee, true);
    }
  }

  // ---- ZNodes (Evo Nodes) - Firo ----
  if (rpcData.znode_payments_started && rpcData.znode_payments_enforced && rpcData.znode) {
    if (Array.isArray(rpcData.znode)) {
      for (const payee of rpcData.znode) {
        // Firo already subtracts znode rewards from the block reward,
        // so we don't subtract again (alreadySubtracted = false)
        addPayeeOutput(payee, false);
      }
    }
  }

  // ---- Other payee ----
  if (rpcData.payee) {
    const payeeReward = rpcData.payee_amount || Math.ceil(reward / 5);
    if (payeeReward > 0) {
      const script = utils.addressToScript(rpcData.payee, network);
      txOutputBuffers.push(Buffer.concat([
        utils.packUInt64LE(payeeReward),
        utils.varIntBuffer(script.length),
        script,
      ]));
      reward -= payeeReward;
    }
  }

  // ---- Secondary (founder) rewards ----
  const coinRewards = poolConfig.primary.coin.rewards;
  if (coinRewards) {
    switch (coinRewards.type) {
      case 'raptoreum':
        if (rpcData.founder_payments_started && rpcData.founder) {
          const founderAmt = rpcData.founder.amount || 0;
          if (founderAmt > 0 && rpcData.founder.payee) {
            const script = utils.addressToScript(rpcData.founder.payee, network);
            txOutputBuffers.push(Buffer.concat([
              utils.packUInt64LE(founderAmt),
              utils.varIntBuffer(script.length),
              script,
            ]));
            reward -= founderAmt;
          }
        }
        break;

      case 'firocoin':
        if (Array.isArray(coinRewards.addresses)) {
          for (const addrObj of coinRewards.addresses) {
            const amt = addrObj.amount || 0;
            if (amt > 0 && addrObj.address) {
              const script = utils.addressToScript(addrObj.address, network);
              txOutputBuffers.push(Buffer.concat([
                utils.packUInt64LE(amt),
                utils.varIntBuffer(script.length),
                script,
              ]));
              // Already subtracted from block reward by daemon
            }
          }
        }
        break;

      case 'hivecoin':
        if (rpcData.CommunityAutonomousValue && rpcData.CommunityAutonomousAddress) {
          const amt = rpcData.CommunityAutonomousValue;
          const script = utils.addressToScript(rpcData.CommunityAutonomousAddress, network);
          txOutputBuffers.unshift(Buffer.concat([
            utils.packUInt64LE(amt),
            utils.varIntBuffer(script.length),
            script,
          ]));
          // Do not subtract from reward – it's already accounted.
        }
        break;

      default:
        break;
    }
  }

  // ---- Pool fee recipients ----
  let recipientTotal = 0;
  const recipients = poolConfig.primary.recipients || [];
  for (const recipient of recipients) {
    const perc = recipient.percentage || 0;
    if (perc <= 0) continue;
    const amt = Math.floor(perc * reward);
    if (amt > 0 && recipient.address) {
      const script = utils.addressToScript(recipient.address, network);
      txOutputBuffers.push(Buffer.concat([
        utils.packUInt64LE(amt),
        utils.varIntBuffer(script.length),
        script,
      ]));
      recipientTotal += amt;
    }
  }
  reward -= recipientTotal;

  // ---- Pool's own output (remaining reward) ----
  const poolAmount = reward;
  if (poolAmount > 0) {
    txOutputBuffers.unshift(Buffer.concat([
      utils.packUInt64LE(poolAmount),
      utils.varIntBuffer(poolAddressScript.length),
      poolAddressScript,
    ]));
  }

  // ---- Witness commitment (segwit) ----
  if (rpcData.default_witness_commitment !== undefined) {
    const witnessBuf = Buffer.from(rpcData.default_witness_commitment, 'hex');
    if (witnessBuf.length > 0) {
      txOutputBuffers.push(Buffer.concat([
        utils.packUInt64LE(0),
        utils.varIntBuffer(witnessBuf.length),
        witnessBuf,
      ]));
    }
  }

  // ---- Concatenate outputs ----
  const outputTransactions = Buffer.concat([
    utils.varIntBuffer(txOutputBuffers.length),
    Buffer.concat(txOutputBuffers),
  ]);

  // ---- Part 2: output + locktime + extra payload ----
  let p2 = Buffer.concat([
    utils.packUInt32LE(txInSequence),
    outputTransactions,
    utils.packUInt32LE(txLockTime),
  ]);

  if (txExtraPayload && txExtraPayload.length > 0) {
    p2 = Buffer.concat([
      p2,
      utils.varIntBuffer(txExtraPayload.length),
      txExtraPayload,
    ]);
  }

  return [p1, p2];
};

module.exports = Transactions;
