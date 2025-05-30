<codebase>
<project_structure>
.
├── .gitignore
├── arweaveSignatureVerifier.js
├── mainServer.js
├── package.json
├── poolManager.js
├── temp
├── uploadService.js
├── uploads
└── walletManager.js

2 directories, 7 files
</project_structure>

<file src=".gitignore">
node_modules
uploads/1d9285da4a958da2cb86cec2b11f52c6
uploads/38e77d9300edd5183aa9cd11e952e3c8
uploads/a38d207b0043eaee288c7725ff546824
package-lock.json
pools.json

</file>

<file src="arweaveSignatureVerifier.js">
import pkg from 'arweave';
const { init } = pkg;


class ArweaveSignatureVerifier {
  constructor() {
    this.arweave = init({
      host: 'arweave.net',
      port: 443,
      protocol: 'https'
    });
  }

async verifySignatureWithPublicKey(publicKey, signature, originalHash) {
    try {
      console.log('🔍 Verifying signature...');
      
      const walletAddress = await this.arweave.wallets.ownerToAddress(publicKey);
      
      const signatureBuffer = Buffer.from(signature, 'base64');
      const hashBuffer = Buffer.from(originalHash, 'hex');
      
      const isValid = await this.arweave.crypto.verify(
        publicKey,
        hashBuffer,
        signatureBuffer
      );
      
      console.log(`✓ Signature verified: ${isValid}`);
      console.log(`✓ Wallet address retrieved: ${walletAddress}`);
      
      if (!isValid) {
        throw new Error('Invalid signature - cannot trust the derived address');
      }
      
      return {
        walletAddress,
        isValidSignature: isValid,
        publicKey
      };
    } catch (error) {
      throw new Error(`Failed to verify signature: ${error.message}`);
    }
  }
}

export default ArweaveSignatureVerifier;
</file>

<file src="mainServer.js">
import express, { json } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import cors from 'cors';

// Import modules
import { POOL_WALLETS_DIR, POOLS_FILE, loadPools, getPoolBalance, updatePool, deletePool, createPool } from './poolManager.js';
import { SPONSOR_WALLET_DIR, uploadWallet } from './walletManager.js';
import { handleFileUpload } from './uploadService.js';

const app = express();
const upload = multer({ dest: 'uploads/' });

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Event-Pool-Id']
}));
app.use(json()); // Add JSON body parser

// Ensure pool_wallets directory exists
if (!existsSync(POOL_WALLETS_DIR)) {
  mkdirSync(POOL_WALLETS_DIR, { recursive: true });
  console.log(`Created pool wallets directory: ${POOL_WALLETS_DIR}`);
}

// Log directory paths at startup
console.log(`SPONSOR_WALLET_DIR: ${SPONSOR_WALLET_DIR}`);
console.log(`POOLS_FILE: ${POOLS_FILE}`);
console.log(`POOL_WALLETS_DIR: ${POOL_WALLETS_DIR}`);

// API keys
const DEPLOY_API_KEY = 'deploy-api-key-123';
const SPONSOR_API_KEY = 'sponsor-api-key-456';

// Handle uncaught exceptions and rejections
process.on('uncaughtException', (error) => {
  console.error('Uncaught Exception:', error);
  process.exit(1);
});
process.on('unhandledRejection', (reason, promise) => {
  console.error('Unhandled Rejection at:', promise, 'reason:', reason);
  process.exit(1);
});

// Middleware to validate API key
app.use((req, res, next) => {
  const apiKey = req.header('X-API-Key');
  const path = req.path;

  // Log incoming headers for debugging
  console.log(`[${new Date().toISOString()}] Request to ${path} with headers:`, {
    'X-API-Key': apiKey,
    'X-Event-Pool-Id': req.header('X-Event-Pool-Id')
  });

  // Bypass API key check for /health
  if (path === '/health') {
    next();
    return;
  }

  if (!apiKey) {
    console.error(`[${new Date().toISOString()}] Missing API key for ${path}`);
    return res.status(401).json({ error: 'Missing API key', code: 'MISSING_API_KEY' });
  }

  if (path === '/upload' && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for upload endpoint`);
    return res.status(401).json({ error: 'Invalid API key for upload endpoint', code: 'INVALID_API_KEY' });
  }

  if (path === '/upload-wallet' && apiKey !== SPONSOR_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for upload-wallet endpoint`);
    return res.status(401).json({ error: 'Invalid API key for upload-wallet endpoint', code: 'INVALID_API_KEY' });
  }

  if (path === '/create-pool' && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for create-pool endpoint`);
    return res.status(401).json({ error: 'Invalid API key for create-pool endpoint', code: 'INVALID_API_KEY' });
  }

  if (path === '/pools' && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for pools endpoint`);
    return res.status(401).json({ error: 'Invalid API key for pools endpoint', code: 'INVALID_API_KEY' });
  }

  if (path.startsWith('/pool/') && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for pool endpoint`);
    return res.status(401).json({ error: 'Invalid API key for pool endpoint', code: 'INVALID_API_KEY' });
  }

  next();
});

// Middleware to filter pools by creator address
app.use('/pools', (req, res, next) => {
  const creatorAddress = req.query.creatorAddress;
  if (!creatorAddress) {
    return res.status(400).json({ error: 'Missing creatorAddress query parameter', code: 'MISSING_CREATOR_ADDRESS' });
  }
  const pools = loadPools();
  const filteredPools = Object.fromEntries(
    Object.entries(pools).filter(([_, pool]) => pool.creatorAddress === creatorAddress)
  );
  res.json(filteredPools);
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log(`[${new Date().toISOString()}] Health check successful`);
  res.status(200).json({ status: 'ok' });
});

// Endpoint to get pool balance
app.get('/pool/:id/balance', async (req, res) => {
  try {
    const poolId = req.params.id;
    const creatorAddress = req.query.creatorAddress;
    const pools = loadPools();
    const pool = pools[poolId];
    if (!pool) {
      return res.status(404).json({ error: 'Pool not found', code: 'POOL_NOT_FOUND' });
    }
    if (pool.creatorAddress !== creatorAddress) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this pool', code: 'UNAUTHORIZED' });
    }
    const balance = await getPoolBalance(poolId);
    res.json({ balance });
  } catch (error) {
    console.error(`Error fetching balance for pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Endpoint to get pool wallet
app.get('/pool/:id/wallet', async (req, res) => {
  try {
    const poolId = req.params.id;
    const creatorAddress = req.query.creatorAddress;
    const pools = loadPools();
    const pool = pools[poolId];
    if (!pool) {
      return res.status(404).json({ error: 'Pool not found', code: 'POOL_NOT_FOUND' });
    }
    if (pool.creatorAddress !== creatorAddress) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this pool', code: 'UNAUTHORIZED' });
    }
    const now = new Date();
    const endTime = new Date(pool.endTime);
    if (now <= endTime) {
      return res.status(403).json({ error: 'Pool has not ended yet', code: 'POOL_NOT_ENDED' });
    }
    const walletPath = pool.walletPath;
    if (!existsSync(walletPath)) {
      return res.status(404).json({ error: 'Wallet file not found', code: 'WALLET_NOT_FOUND' });
    }
    const wallet = JSON.parse(readFileSync(walletPath, 'utf-8'));
    res.json({ wallet });
  } catch (error) {
    console.error(`Error fetching wallet for pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Endpoint to update a pool
app.patch('/pool/:id', (req, res) => {
  try {
    const poolId = req.params.id;
    const creatorAddress = req.query.creatorAddress;
    const pools = loadPools();
    const pool = pools[poolId];
    if (!pool) {
      return res.status(404).json({ error: 'Pool not found', code: 'POOL_NOT_FOUND' });
    }
    if (pool.creatorAddress !== creatorAddress) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this pool', code: 'UNAUTHORIZED' });
    }
    const result = updatePool(poolId, req.body);
    res.json(result);
  } catch (error) {
    console.error(`Error updating pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Endpoint to delete a pool
app.delete('/pool/:id', (req, res) => {
  try {
    const poolId = req.params.id;
    const creatorAddress = req.query.creatorAddress;
    const pools = loadPools();
    const pool = pools[poolId];
    if (!pool) {
      return res.status(404).json({ error: 'Pool not found', code: 'POOL_NOT_FOUND' });
    }
    if (pool.creatorAddress !== creatorAddress) {
      return res.status(403).json({ error: 'Unauthorized: You do not own this pool', code: 'UNAUTHORIZED' });
    }
    const result = deletePool(poolId);
    res.json(result);
  } catch (error) {
    console.error(`Error deleting pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Endpoint to create a new event pool
app.post('/create-pool', async (req, res) => {
  try {
    const result = await createPool(req.body);
    res.json(result);
  } catch (error) {
    console.error('Pool creation error:', error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Endpoint to receive user wallet keyfiles for community pools
app.post('/upload-wallet', upload.single('wallet'), async (req, res) => {
  try {
    const result = await uploadWallet(req.file);
    res.json(result);
  } catch (error) {
    console.error('Wallet upload error:', error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Endpoint to receive and upload files from a ZIP
app.post('/upload', upload.single('zip'), async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Processing upload request`);
    const result = await handleFileUpload(req);
    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Upload error:`, error);
    res.status(500).json({ error: error.message, code: error.code || 'UNKNOWN_ERROR' });
  }
});

// Catch-all route to ensure JSON responses
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found', code: 'NOT_FOUND' });
});

// Start the server with error handling
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Sponsor server running on port ${PORT}`);
  console.log(`Wallet directory: ${SPONSOR_WALLET_DIR}`);
  console.log(`Pools file: ${POOLS_FILE}`);
}).on('error', (error) => {
  console.error(`Failed to start server on port ${PORT}:`, error);
  process.exit(1);
});

// Handle graceful shutdown
process.on('SIGTERM', () => {
  console.log('Received SIGTERM. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

process.on('SIGINT', () => {
  console.log('Received SIGINT. Shutting down gracefully...');
  server.close(() => {
    console.log('Server closed.');
    process.exit(0);
  });
});

export default app;
</file>

<file src="package.json">
{
  "name": "sponsor-server",
  "version": "1.0.0",
  "description": "",
  "main": "server.js",
  "scripts": {
    "test": "echo \"Error: no test specified\" && exit 1",
    "start": "node server.js"
  },
  "keywords": [],
  "author": "",
  "license": "ISC",
  "type": "module",
  "dependencies": {
    "@ardrive/turbo-sdk": "^1.23.5",
    "arweave": "^1.15.7",
    "cors": "^2.8.5",
    "express": "^5.1.0",
    "jwk-to-pem": "^2.0.7",
    "multer": "^1.4.5-lts.2",
    "unzipper": "^0.12.3"
  }
 
}

</file>

<file src="poolManager.js">
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

function deletePool(poolId) {
  const pools = loadPools();
  if (!pools[poolId]) {
    throw { code: 'POOL_NOT_FOUND', message: 'Pool not found' };
  }

  const walletPath = pools[poolId].walletPath;
  if (fs.existsSync(walletPath)) {
    try {
      fs.unlinkSync(walletPath);
      console.log(`Deleted wallet file: ${walletPath}`);
    } catch (error) {
      console.error(`Error deleting wallet file ${walletPath}:`, error);
      throw { code: 'WALLET_DELETE_FAILED', message: `Failed to delete wallet file: ${error.message}` };
    }
  }

  delete pools[poolId];
  savePools(pools);
  return { message: 'Pool deleted successfully' };
}

async function createPool(poolData) {
  console.log('Received /create-pool request');
  const { name, startTime, endTime, usageCap, whitelist, creatorAddress } = poolData;
  if (!name || !startTime || !endTime || !usageCap || !whitelist || !creatorAddress) {
    throw { code: 'MISSING_FIELDS', message: 'Missing required fields' };
  }

  
  const arweave = Arweave.init({});


  let walletData;
  try {
    walletData = await arweave.wallets.generate();
  } catch (error) {
    throw { code: 'WALLET_GENERATION_FAILED', message: `Failed to generate wallet: ${error.message}` };
  }
  const walletAddress = await arweave.wallets.jwkToAddress(walletData);

  const pools = loadPools();
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
  deletePool,
  createPool,
  validateEventPoolAccess,
  updatePoolUsage,
  POOLS_FILE,
  POOL_WALLETS_DIR
};
</file>

<file src="uploadService.js">

import { createReadStream, existsSync, statSync, readFileSync, rmSync, unlinkSync, mkdirSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Extract } from 'unzipper';
import { createHash } from 'crypto';
import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk';
import { loadPools, updatePoolUsage } from './poolManager.js';
import { loadWalletFromPath, getRandomCommunityWallet } from './walletManager.js';
import ArweaveSignatureVerifier from './arweaveSignatureVerifier.js';

// Define __dirname for ES Modules
const __dirname = dirname(fileURLToPath(import.meta.url));

// Function to determine Content-Type based on file extension
function getContentType(filePath) {
  const ext = extname(filePath).toLowerCase();
  const mimeTypes = {
    '.html': 'text/html',
    '.css': 'text/css',
    '.js': 'application/javascript',
    '.json': 'application/json',
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.jpeg': 'image/jpeg',
    '.gif': 'image/gif',
    '.svg': 'image/svg+xml',
    '.ico': 'image/x-icon',
    '.txt': 'text/plain',
    '.pdf': 'application/pdf',
    '.woff': 'font/woff',
    '.woff2': 'font/woff2',
    '.ttf': 'font/ttf',
  };
  return mimeTypes[ext] || 'application/octet-stream';
}

async function extractZipFile(zipPath, tempDir) {
  try {
    await new Promise((resolve, reject) => {
      createReadStream(zipPath)
        .pipe(Extract({ path: tempDir }))
        .on('close', resolve)
        .on('error', reject);
    });
  } catch (error) {
    throw { code: 'ZIP_EXTRACT_FAILED', message: `Failed to extract ZIP file: ${error.message}` };
  }
}

function validateUploadFiles(fileMetadata, tempDir) {
  const totalSize = fileMetadata.reduce((sum, file) => {
    const filePath = join(tempDir, file.relativePath);
    return existsSync(filePath) ? sum + statSync(filePath).size : sum;
  }, 0);

  if (totalSize > 50 * 1024 * 1024) {
    throw { code: 'TOTAL_SIZE_EXCEEDED', message: 'Total size exceeds 50 MB' };
  }

  const allowedExtensions = ['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg'];
  for (const file of fileMetadata) {
    const ext = extname(file.relativePath).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw { code: 'INVALID_FILE_TYPE', message: `Invalid file type: ${ext}` };
    }
  }

  return totalSize;
}

async function uploadToArweave(fileMetadata, tempDir, wallet, poolType, poolName) {
  const signer = new ArweaveSigner(wallet);
  const turbo = TurboFactory.authenticated({ signer, token: 'arweave' });

  // Get initial balance
  let balanceResult;
  try {
    balanceResult = await turbo.getBalance();
  } catch (error) {
    throw { code: 'BALANCE_CHECK_FAILED', message: `Failed to check initial balance: ${error.message}` };
  }
  const initialBalance = BigInt(balanceResult.winc);

  const uploadedFiles = [];
  let totalWincSpent = 0n;

  for (const file of fileMetadata) {
    const filePath = join(tempDir, file.relativePath);
    if (!existsSync(filePath)) {
      throw { code: 'FILE_NOT_FOUND_IN_ZIP', message: `File not found in zip: ${file.relativePath}` };
    }
    const fileStreamFactory = () => createReadStream(filePath);
    const fileSizeFactory = () => statSync(filePath).size;
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');

    console.log(`Uploading file: ${file.relativePath}`);
    try {
      const uploadResult = await turbo.uploadFile({
        fileStreamFactory,
        fileSizeFactory,
        dataItemOpts: {
          tags: [
            { name: 'App-Name', value: 'PermaDeploy' },
            { name: 'anchor', value: new Date().toISOString() },
            { name: 'Content-Type', value: file.contentType },
            { name: 'Pool-Type', value: poolType },
            ...(poolType === 'event' ? [{ name: 'Event-Name', value: poolName }] : [])
          ],
        },
      });

      const wincSpent = BigInt(uploadResult.winc);
      totalWincSpent += wincSpent;

      uploadedFiles.push({
        relativePath: file.relativePath,
        txId: uploadResult.id,
        hash,
        lastModified: statSync(filePath).mtime.toISOString(),
        winc: uploadResult.winc
      });
    } catch (error) {
      throw { code: 'UPLOAD_FAILED', message: `Failed to upload file ${file.relativePath}: ${error.message}` };
    }
  }

  // Get final balance to confirm
  try {
    balanceResult = await turbo.getBalance();
  } catch (error) {
    throw { code: 'BALANCE_CHECK_FAILED', message: `Failed to check final balance: ${error.message}` };
  }
  const remainingBalance = BigInt(balanceResult.winc) / BigInt(1e12);
  const equivalentFileSize = (Number(remainingBalance) / 0.1) * 1024 * 1024;

  return {
    uploadedFiles,
    totalWincSpent: totalWincSpent.toString(),
    remainingBalance: Number(remainingBalance),
    equivalentFileSize
  };
}

function cleanupTempFiles(tempDir, zipPath) {
  try {
    if (tempDir && existsSync(tempDir)) {
      rmSync(tempDir, { recursive: true, force: true });
      console.log(`Cleaned up temporary directory: ${tempDir}`);
    }
  } catch (error) {
    console.error(`Failed to clean up temporary directory ${tempDir}:`, error);
  }

  try {
    if (zipPath && existsSync(zipPath)) {
      unlinkSync(zipPath);
      console.log(`Deleted uploaded ZIP file: ${zipPath}`);
    }
  } catch (error) {
    console.error(`Failed to delete ZIP file ${zipPath}:`, error);
  }
}

async function handleFileUpload(req) {
  const poolType = req.body.poolType || 'community';
  const { eventPoolId, zipHash, signature, publicKey, walletAddress } = req.body;
  const zipPath = req.file ? req.file.path : null;

  // Initialize tempDir early to ensure cleanup
  const tempDir = zipPath ? join(__dirname, 'temp', Date.now().toString()) : null;
  if (tempDir) {
    try {
      mkdirSync(tempDir, { recursive: true });
      console.log(`Created temporary directory: ${tempDir}`);
    } catch (error) {
      cleanupTempFiles(tempDir, zipPath);
      throw { code: 'TEMP_DIR_CREATION_FAILED', message: `Failed to create temporary directory: ${error.message}` };
    }
  }

  try {
    if (!req.file || !zipPath) {
      throw { code: 'NO_ZIP_FILE', message: 'No ZIP file provided' };
    }

    // Verify the hash matches the uploaded ZIP file
    const zipBuffer = readFileSync(zipPath);
    const calculatedHash = createHash('sha256').update(zipBuffer).digest('hex');
    if (calculatedHash !== zipHash) {
      throw { code: 'HASH_MISMATCH', message: 'Hash mismatch' };
    }

    // Verify the signature using ArweaveSignatureVerifier
    const verifier = new ArweaveSignatureVerifier();
    const verificationResult = await verifier.verifySignatureWithPublicKey(publicKey, signature, zipHash);
    if (!verificationResult.isValidSignature) {
      throw { code: 'INVALID_SIGNATURE', message: 'Invalid signature' };
    }
    if (verificationResult.walletAddress !== walletAddress) {
      throw { code: 'WALLET_ADDRESS_MISMATCH', message: 'Wallet address mismatch' };
    }

    let sponsorWallet;
    let poolName = '';
    let pool;

    if (poolType === 'event') {
      if (!eventPoolId) {
        throw { code: 'MISSING_POOL_ID', message: 'Event pool requires pool ID' };
      }
      const pools = loadPools();
      pool = pools[eventPoolId];
      if (!pool) {
        throw { code: 'INVALID_POOL_ID', message: 'Invalid pool ID' };
      }
      const now = new Date().toISOString();
      if (now < pool.startTime || now > pool.endTime) {
        throw { code: 'POOL_NOT_ACTIVE', message: 'Pool is not active' };
      }
      poolName = pool.name;

      // Check if derived address is in the whitelist
      const whitelist = pool.whitelist || [];
      if (!whitelist.includes(walletAddress)) {
        throw { code: 'WALLET_NOT_WHITELISTED', message: 'Wallet address not in whitelist' };
      }

      sponsorWallet = loadWalletFromPath(pool.walletPath);
    } else {
      // For community pools, use a random wallet (no whitelist check needed)
      sponsorWallet = getRandomCommunityWallet();
    }

    console.log(`Using wallet for ${poolType} pool`);

    await extractZipFile(zipPath, tempDir);
    
    const fileMetadata = JSON.parse(req.body.fileMetadata || '[]');
    validateUploadFiles(fileMetadata, tempDir);
    
    const result = await uploadToArweave(fileMetadata, tempDir, sponsorWallet, poolType, poolName);
    
    // Update pool usage for event pools using actual winc spent
    if (poolType === 'event') {
      updatePoolUsage(eventPoolId, walletAddress, Number(result.totalWincSpent) / 1e12, pool);
    }

    return {
      poolType,
      uploadedFiles: result.uploadedFiles,
      poolName: poolType === 'event' ? `You have been sponsored by ${poolName}` : undefined,
      remainingBalance: result.remainingBalance,
      equivalentFileSize: result.equivalentFileSize,
      totalCreditsSpent: result.totalWincSpent
    };
  } finally {
    cleanupTempFiles(tempDir, zipPath);
  }
}

export {
  getContentType,
  extractZipFile,
  validateUploadFiles,
  uploadToArweave,
  cleanupTempFiles,
  handleFileUpload
};

</file>

<file src="walletManager.js">
import fs from 'fs';
import path from 'path';
  import Arweave from 'arweave';

const SPONSOR_DIR = path.join(process.env.HOME, '.nitya', 'sponsor');
const SPONSOR_WALLET_DIR = path.join(SPONSOR_DIR, 'wallets');

// Ensure sponsor directory exists (for community pool wallets)
function ensureSponsorDir() {
  try {
    if (!fs.existsSync(SPONSOR_DIR)) {
      fs.mkdirSync(SPONSOR_DIR, { recursive: true });
      console.log(`Created directory: ${SPONSOR_DIR}`);
    }
  } catch (error) {
    console.error(`Failed to create directory ${SPONSOR_DIR}:`, error);
    throw error;
  }
}

function validateWalletFile(walletPath) {
  let walletData;
  try {
    walletData = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  } catch (error) {
    throw new Error(`Invalid wallet keyfile: ${error.message}`);
  }
  if (!walletData.n || !walletData.d) {
    throw new Error('Invalid Arweave JWK format');
  }
  return walletData;
}

async function getWalletAddress(walletData) {

  const arweave = Arweave.init({});
  return await arweave.wallets.jwkToAddress(walletData);
}

async function uploadWallet(walletFile) {
  if (!walletFile) {
    throw new Error('No wallet keyfile provided');
  }
  const walletPath = walletFile.path;
  const walletData = validateWalletFile(walletPath);
  const walletAddress = await getWalletAddress(walletData);

  try {
    ensureSponsorDir();
    if (!fs.existsSync(SPONSOR_WALLET_DIR)) {
      fs.mkdirSync(SPONSOR_WALLET_DIR, { recursive: true });
      console.log(`Created wallet directory: ${SPONSOR_WALLET_DIR}`);
    }
  } catch (error) {
    console.error(`Failed to create wallet directory ${SPONSOR_WALLET_DIR}:`, error);
    throw error;
  }

  const targetPath = path.join(SPONSOR_WALLET_DIR, `${walletAddress}.json`);
  fs.renameSync(walletPath, targetPath);
  console.log(`Saved wallet to: ${targetPath}`);

  return { message: 'Wallet keyfile uploaded successfully', walletAddress };
}

function getRandomCommunityWallet() {
  try {
    ensureSponsorDir();
    if (!fs.existsSync(SPONSOR_WALLET_DIR)) {
      fs.mkdirSync(SPONSOR_WALLET_DIR, { recursive: true });
      console.log(`Created wallet directory: ${SPONSOR_WALLET_DIR}`);
    }
  } catch (error) {
    console.error(`Failed to create wallet directory ${SPONSOR_WALLET_DIR}:`, error);
    throw error;
  }

  const walletFiles = fs.readdirSync(SPONSOR_WALLET_DIR)
    .filter(file => file.endsWith('.json'))
    .map(file => path.join(SPONSOR_WALLET_DIR, file));

  if (walletFiles.length === 0) {
    throw new Error(`No wallet keyfiles found in ${SPONSOR_WALLET_DIR}`);
  }

  const selectedWalletPath = walletFiles[Math.floor(Math.random() * walletFiles.length)];
  const sponsorWallet = JSON.parse(fs.readFileSync(selectedWalletPath, 'utf-8'));
  
  if (!sponsorWallet.n || !sponsorWallet.d) {
    throw new Error(`Invalid Arweave JWK format in wallet`);
  }
  
  return sponsorWallet;
}

function loadWalletFromPath(walletPath) {
  if (!fs.existsSync(walletPath)) {
    throw new Error(`Wallet file not found at ${walletPath}`);
  }
  const wallet = JSON.parse(fs.readFileSync(walletPath, 'utf-8'));
  
  if (!wallet.n || !wallet.d) {
    throw new Error(`Invalid Arweave JWK format in wallet`);
  }
  
  return wallet;
}

export {
  ensureSponsorDir,
  validateWalletFile,
  getWalletAddress,
  uploadWallet,
  getRandomCommunityWallet,
  loadWalletFromPath,
  SPONSOR_DIR,
  SPONSOR_WALLET_DIR
};
</file>

</codebase>
