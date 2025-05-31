import fs from 'fs';
import path from 'path';
import crypto from 'crypto';
import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk';
import { fileURLToPath } from 'url';
import Arweave from 'arweave';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
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
    throw { code: 'LOAD_POOLS_FAILED', message: `Failed to load pools: ${error.message}` };
  }
}

function savePools(pools) {
  try {
    fs.writeFileSync(POOLS_FILE, JSON.stringify(pools, null, 2));
    console.log(`Saved pools to: ${POOLS_FILE}`);
  } catch (error) {
    console.error(`Error saving pools to ${POOLS_FILE}:`, error);
    throw { code: 'SAVE_POOLS_FAILED', message: `Failed to save pools: ${error.message}` };
  }
}

async function getPoolBalance(poolId) {
  const pools = loadPools();
  const pool = pools[poolId];
  if (!pool) {
    throw { code: 'POOL_NOT_FOUND', message: 'Pool not found' };
  }

  const walletPath = pool.walletPath;
  if (!fs.existsSync(walletPath)) {
    throw { code: 'WALLET_NOT_FOUND', message: `Wallet file not found at ${walletPath}` };
  }
  let wallet;
  try {
    wallet = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  } catch (error) {
    throw { code: 'WALLET_READ_FAILED', message: `Failed to read wallet file: ${error.message}` };
  }

  try {
    const signer = new ArweaveSigner(wallet);
    const turbo = TurboFactory.authenticated({ signer, token: 'arweave' });
    const balanceResult = await turbo.getBalance();
    return {
      balance: Number(balanceResult.winc) / 1e12, // Convert winston to Turbo Credits
      controlledWinc: Number(balanceResult.controlledWinc) / 1e12,
      effectiveBalance: Number(balanceResult.effectiveBalance) / 1e12,
      equivalentFileSize: (Number(balanceResult.winc) / 1e12 / 0.1) * 1024 * 1024 // MB equivalent
    };
  } catch (error) {
    throw { code: 'BALANCE_CHECK_FAILED', message: `Failed to get pool balance: ${error.message}` };
  }
}

function updatePool(poolId, updates) {
  const { startTime, endTime, whitelist } = updates;
  const pools = loadPools();
  const pool = pools[poolId];

  if (!pool) {
    throw { code: 'POOL_NOT_FOUND', message: 'Pool not found' };
  }

  if (startTime) pool.startTime = startTime;
  if (endTime) pool.endTime = endTime;
  if (whitelist) pool.whitelist = whitelist;

  if (new Date(pool.startTime) >= new Date(pool.endTime)) {
    throw { code: 'INVALID_TIME_RANGE', message: 'End time must be after start time' };
  }

  savePools(pools);
  return { message: 'Pool updated successfully' };
}


// poolManager.js - Updated createPool function
async function createPool(poolData) {
  console.log('Received /create-pool request');
  const { name, startTime, endTime, usageCap, whitelist, creatorAddress } = poolData;
  if (!name || !startTime || !endTime || !usageCap || !whitelist || !creatorAddress) {
    throw { code: 'MISSING_FIELDS', message: 'Missing required fields' };
  }

  const pools = loadPools();
  // Check pool limit for the creatorAddress
  const existingPools = Object.values(pools).filter(pool => pool.creatorAddress === creatorAddress);
  if (existingPools.length >= 3) {
    throw { code: 'POOL_LIMIT_EXCEEDED', message: 'Maximum of 3 pools per wallet exceeded' };
  }

  const arweave = Arweave.init({});
  let walletData;
  try {
    walletData = await arweave.wallets.generate();
  } catch (error) {
    throw { code: 'WALLET_GENERATION_FAILED', message: `Failed to generate wallet: ${error.message}` };
  }
  const walletAddress = await arweave.wallets.jwkToAddress(walletData);

  const poolId = crypto.randomBytes(16).toString('hex');
  const walletPath = path.join(POOL_WALLETS_DIR, `${poolId}.json`);
  try {
    fs.writeFileSync(walletPath, JSON.stringify(walletData, null, 2));
    console.log(`Saved wallet to: ${walletPath}`);
  } catch (error) {
    throw { code: 'WALLET_SAVE_FAILED', message: `Failed to save wallet: ${error.message}` };
  }

  pools[poolId] = {
    name,
    startTime,
    endTime,
    usageCap: Number(usageCap),
    walletPath,
    whitelist: Array.isArray(whitelist) ? whitelist : JSON.parse(whitelist),
    usage: {},
    creatorAddress
  };
  savePools(pools);

  return { poolId, message: 'Pool created successfully', walletAddress, wallet: walletData };
}

function validateEventPoolAccess(poolId, walletAddress) {
  const pools = loadPools();
  const pool = pools[poolId];
  if (!pool) {
    throw { code: 'INVALID_POOL_ID', message: 'Invalid pool ID' };
  }

  const now = new Date().toISOString();
  if (now < pool.startTime || now > pool.endTime) {
    throw { code: 'POOL_NOT_ACTIVE', message: 'Pool is not active' };
  }

  if (!pool.whitelist.includes(walletAddress)) {
    throw { code: 'WALLET_NOT_WHITELISTED', message: 'Wallet address not in whitelist' };
  }

  return-pool;
}

function updatePoolUsage(poolId, walletAddress, actualWincSpent, pool) {
  pool.usage[walletAddress] = pool.usage[walletAddress] || 0;
  const totalUsage = pool.usage[walletAddress] + actualWincSpent;
  if (totalUsage > pool.usageCap) {
    throw { code: 'USAGE_CAP_EXCEEDED', message: `Usage cap exceeded for wallet ${walletAddress}` };
  }
  
  pool.usage[walletAddress] = totalUsage;
  const pools = loadPools();
  pools[poolId] = pool;
  savePools(pools);
}

export {
  loadPools,
  savePools,
  getPoolBalance,
  updatePool,
  createPool,
  validateEventPoolAccess,
  updatePoolUsage,
  POOLS_FILE,
  POOL_WALLETS_DIR
};