const express = require('express');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const cors = require('cors');

// Import modules
const poolManager = require('./poolManager');
const walletManager = require('./walletManager');
const uploadService = require('./uploadService');

const app = express();
const upload = multer({ dest: 'uploads/' });

// Enable CORS
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS', 'PATCH', 'DELETE'],
  allowedHeaders: ['Content-Type', 'X-API-Key', 'X-Event-Pool-Id']
}));

// Ensure pool_wallets directory exists
if (!fs.existsSync(poolManager.POOL_WALLETS_DIR)) {
  fs.mkdirSync(poolManager.POOL_WALLETS_DIR, { recursive: true });
  console.log(`Created pool wallets directory: ${poolManager.POOL_WALLETS_DIR}`);
}

// Log directory paths at startup
console.log(`SPONSOR_WALLET_DIR: ${walletManager.SPONSOR_WALLET_DIR}`);
console.log(`POOLS_FILE: ${poolManager.POOLS_FILE}`);
console.log(`POOL_WALLETS_DIR: ${poolManager.POOL_WALLETS_DIR}`);

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
    return res.status(401).json({ error: 'Missing API key' });
  }

  if (path === '/upload' && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for upload endpoint`);
    return res.status(401).json({ error: 'Invalid API key for upload endpoint' });
  }

  if (path === '/upload-wallet' && apiKey !== SPONSOR_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for upload-wallet endpoint`);
    return res.status(401).json({ error: 'Invalid API key for upload-wallet endpoint' });
  }

  if (path === '/create-pool' && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for create-pool endpoint`);
    return res.status(401).json({ error: 'Invalid API key for create-pool endpoint' });
  }

  if (path === '/pools' && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for pools endpoint`);
    return res.status(401).json({ error: 'Invalid API key for pools endpoint' });
  }

  if (path.startsWith('/pool/') && apiKey !== DEPLOY_API_KEY) {
    console.error(`[${new Date().toISOString()}] Invalid API key for pool endpoint`);
    return res.status(401).json({ error: 'Invalid API key for pool endpoint' });
  }

  next();
});

// Health check endpoint
app.get('/health', (req, res) => {
  console.log(`[${new Date().toISOString()}] Health check successful`);
  res.status(200).json({ status: 'ok' });
});

// Endpoint to list all pools
app.get('/pools', (req, res) => {
  try {
    const pools = poolManager.loadPools();
    res.json(pools);
  } catch (error) {
    console.error('Error fetching pools:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to get pool balance
app.get('/pool/:id/balance', async (req, res) => {
  try {
    const poolId = req.params.id;
    const balance = await poolManager.getPoolBalance(poolId);
    res.json({ balance });
  } catch (error) {
    console.error(`Error fetching balance for pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to update a pool
app.patch('/pool/:id', (req, res) => {
  try {
    const poolId = req.params.id;
    const result = poolManager.updatePool(poolId, req.body);
    res.json(result);
  } catch (error) {
    console.error(`Error updating pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to delete a pool
app.delete('/pool/:id', (req, res) => {
  try {
    const poolId = req.params.id;
    const result = poolManager.deletePool(poolId);
    res.json(result);
  } catch (error) {
    console.error(`Error deleting pool ${req.params.id}:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to create a new event pool
app.post('/create-pool', upload.fields([
  { name: 'wallet', maxCount: 1 },
  { name: 'name', maxCount: 1 },
  { name: 'startTime', maxCount: 1 },
  { name: 'endTime', maxCount: 1 },
  { name: 'usageCap', maxCount: 1 },
  { name: 'whitelist', maxCount: 1 }
]), async (req, res) => {
  try {
    const result = await poolManager.createPool(req.body, req.files.wallet);
    res.json(result);
  } catch (error) {
    console.error('Pool creation error:', error);
    if (req.files?.wallet?.[0]?.path && fs.existsSync(req.files.wallet[0].path)) {
      fs.unlinkSync(req.files.wallet[0].path);
    }
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to receive user wallet keyfiles for community pools
app.post('/upload-wallet', upload.single('wallet'), async (req, res) => {
  try {
    const result = await walletManager.uploadWallet(req.file);
    res.json(result);
  } catch (error) {
    console.error('Wallet upload error:', error);
    res.status(500).json({ error: error.message });
  }
});

// Endpoint to receive and upload files from a ZIP
app.post('/upload', upload.single('zip'), async (req, res) => {
  try {
    console.log(`[${new Date().toISOString()}] Processing upload request`);
    const result = await uploadService.handleFileUpload(req);
    res.json(result);
  } catch (error) {
    console.error(`[${new Date().toISOString()}] Upload error:`, error);
    res.status(500).json({ error: error.message });
  }
});

// Catch-all route to ensure JSON responses
app.use((req, res) => {
  res.status(404).json({ error: 'Not Found' });
});

// Start the server with error handling
const PORT = process.env.PORT || 8080;
const server = app.listen(PORT, () => {
  console.log(`Sponsor server running on port ${PORT}`);
  console.log(`Wallet directory: ${walletManager.SPONSOR_WALLET_DIR}`);
  console.log(`Pools file: ${poolManager.POOLS_FILE}`);
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

module.exports = app;