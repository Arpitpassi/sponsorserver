const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { TurboFactory, ArweaveSigner } = require('@ardrive/turbo-sdk');

const POOLS_FILE = path.join(__dirname, 'pools.json');
const POOL_WALLETS_DIR = path.join(process.env.HOME, '.nitya', 'sponsor', 'pool_wallets');

// Load or initialize pools data
function loadPools() {
  try {
    if (!fs.existsSync(POOLS_FILE)) {
      fs.writeFileSync(POOLS_FILE, JSON.stringify({}));
      console.log(`Created pools file: ${POOLS_FILE}`);
    }
    return JSON.parse(fs.readFileSync(POOLS_FILE, 'utf-8'));
  } catch (error) {
    console.error(`Error loading pools from ${POOLS_FILE}:`, error);
    throw error;
  }
}

function savePools(pools) {
  try {
    fs.writeFileSync(POOLS_FILE, JSON.stringify(pools, null, 2));
    console.log(`Saved pools to: ${POOLS_FILE}`);
  } catch (error) {
    console.error(`Error saving pools to ${POOLS_FILE}:`, error);
    throw error;
  }
}

async function getPoolBalance(poolId) {
  const pools = loadPools();
  const pool = pools[poolId];
  if (!pool) {
    throw new Error('Pool not found');
  }

  const walletPath = pool.walletPath;
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found at ${walletPath}`);
  }
  const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));

  const signer = new ArweaveSigner(wallet);
  const turbo = TurboFactory.authenticated({ signer, token: 'arweave' });
  const balanceResult = await turbo.getBalance();
  const balance = balanceResult.winc / 1e12; // Convert winston to Turbo Credits

  return balance;
}

function updatePool(poolId, updates) {
  const { startTime, endTime, whitelist } = updates;
  const pools = loadPools();
  const pool = pools[poolId];

  if (!pool) {
    throw new Error('Pool not found');
  }

  if (startTime) pool.startTime = startTime;
  if (endTime) pool.endTime = endTime;
  if (whitelist) pool.whitelist = whitelist;

  if (new Date(pool.startTime) >= new Date(pool.endTime)) {
    throw new Error('End time must be after start time');
  }

  savePools(pools);
  return { message: 'Pool updated successfully' };
}

function deletePool(poolId) {
  const pools = loadPools();
  if (!pools[poolId]) {
    throw new Error('Pool not found');
  }

  // Delete the associated wallet file
  const walletPath = pools[poolId].walletPath;
  if (fs.existsSync(walletPath)) {
    fs.unlinkSync(walletPath);
    console.log(`Deleted wallet file: ${walletPath}`);
  }

  delete pools[poolId];
  savePools(pools);
  return { message: 'Pool deleted successfully' };
}

async function createPool(poolData, walletFile) {
  console.log('Received /create-pool request');
  const { name, startTime, endTime, usageCap, whitelist } = poolData;
  if (!name || !startTime || !endTime || !usageCap || !whitelist || !walletFile) {
    throw new Error('Missing required fields or wallet file');
  }

  let walletData;
  try {
    walletData = JSON.parse(fs.readFileSync(walletFile[0].path, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid wallet keyfile: ${error.message}`);
  }
  if (!walletData.n || !walletData.d) {
    throw new Error('Invalid Arweave JWK format');
  }

  const Arweave = require('arweave');
  const arweave = Arweave.init({});
  const walletAddress = await arweave.wallets.jwkToAddress(walletData);

  const pools = loadPools();
  const poolId = crypto.randomBytes(16).toString('hex');
  
  // Save wallet to a separate file
  const walletPath = path.join(POOL_WALLETS_DIR, `${poolId}.json`);
  fs.writeFileSync(walletPath, JSON.stringify(walletData, null, 2));
  console.log(`Saved wallet to: ${walletPath}`);

  pools[poolId] = {
    name,
    startTime,
    endTime,
    usageCap: parseInt(usageCap),
    walletPath, // Store the path to the wallet file
    whitelist: JSON.parse(whitelist),
    usage: {}
  };
  savePools(pools);

  // Clean up uploaded wallet file
  fs.unlinkSync(walletFile[0].path);

  return { poolId, message: 'Pool created successfully', walletAddress };
}

function validateEventPoolAccess(poolId, walletAddress) {
  const pools = loadPools();
  const pool = pools[poolId];
  if (!pool) {
    throw new Error('Invalid pool ID');
  }

  const now = new Date().toISOString();
  if (now < pool.startTime || now > pool.endTime) {
    throw new Error('Pool is not active');
  }

  if (!pool.whitelist.includes(walletAddress)) {
    throw new Error('Wallet address not in whitelist');
  }

  return pool;
}

function updatePoolUsage(poolId, walletAddress, estimatedCost, pool) {
  pool.usage[walletAddress] = pool.usage[walletAddress] || 0;
  if (pool.usage[walletAddress] + estimatedCost > pool.usageCap) {
    throw new Error('Usage cap exceeded for this wallet');
  }
  
  pool.usage[walletAddress] += estimatedCost;
  const pools = loadPools();
  pools[poolId] = pool;
  savePools(pools);
}

module.exports = {
  loadPools,
  savePools,
  getPoolBalance,
  updatePool,
  deletePool,
  createPool,
  validateEventPoolAccess,
  updatePoolUsage,
  POOLS_FILE,
  POOL_WALLETS_DIR
};