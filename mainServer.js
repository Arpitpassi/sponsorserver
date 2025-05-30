import express, { json } from 'express';
import multer from 'multer';
import { existsSync, mkdirSync, readFileSync } from 'fs';
import cors from 'cors';

// Import modules
import { POOL_WALLETS_DIR, POOLS_FILE, loadPools, getPoolBalance, updatePool,createPool } from './poolManager.js';
import { SPONSOR_WALLET_DIR, uploadWallet } from './walletManager.js';
import { handleFileUpload } from './uploadService.js';

const app = express();
const upload = multer({ dest: 'uploads/' });

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'PATCH'],
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