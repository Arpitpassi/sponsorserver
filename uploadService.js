const fs = require('fs');
const path = require('path');
const unzipper = require('unzipper');
const crypto = require('crypto');
const { TurboFactory, ArweaveSigner } = require('@ardrive/turbo-sdk');
const poolManager = require('./poolManager');
const walletManager = require('./walletManager');
const jwkToPem = require('jwk-to-pem');
const arweave = require('arweave');

// Calculate SHA256 hash of a file
function calculateFileHash(filePath) {
  const fileBuffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(fileBuffer).digest('hex');
}

// Function to determine Content-Type based on file extension
function getContentType(filePath) {
  const ext = path.extname(filePath).toLowerCase();
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
  await new Promise((resolve, reject) => {
    fs.createReadStream(zipPath)
      .pipe(unzipper.Extract({ path: tempDir }))
      .on('close', resolve)
      .on('error', reject);
  });
}

function validateUploadFiles(fileMetadata, tempDir) {
  const totalSize = fileMetadata.reduce((sum, file) => {
    const filePath = path.join(tempDir, file.relativePath);
    return fs.existsSync(filePath) ? sum + fs.statSync(filePath).size : sum;
  }, 0);

  if (totalSize > 50 * 1024 * 1024) {
    throw new Error('Total size exceeds 50 MB');
  }

  const allowedExtensions = ['.html', '.css', '.js', '.png', '.jpg', '.jpeg', '.gif', '.svg'];
  for (const file of fileMetadata) {
    const ext = path.extname(file.relativePath).toLowerCase();
    if (!allowedExtensions.includes(ext)) {
      throw new Error(`Invalid file type: ${ext}`);
    }
  }

  return totalSize;
}

async function uploadToArweave(fileMetadata, tempDir, wallet, poolType, poolName) {
  const signer = new ArweaveSigner(wallet);
  const turbo = TurboFactory.authenticated({ signer, token: 'arweave' });

  const uploadedFiles = [];
  for (const file of fileMetadata) {
    const filePath = path.join(tempDir, file.relativePath);
    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found in zip: ${file.relativePath}`);
    }
    const fileStreamFactory = () => fs.createReadStream(filePath);
    const fileSizeFactory = () => fs.statSync(filePath).size;
    const hash = calculateFileHash(filePath);

    console.log(`Uploading file: ${file.relativePath}`);
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

    uploadedFiles.push({
      relativePath: file.relativePath,
      txId: uploadResult.id,
      hash,
      lastModified: fs.statSync(filePath).mtime.toISOString()
    });
  }

  const balanceResult = await turbo.getBalance();
  const remainingBalance = balanceResult.winc / 1e12;
  const equivalentFileSize = (remainingBalance / 0.1) * 1024 * 1024;

  return { uploadedFiles, remainingBalance, equivalentFileSize };
}

function cleanupTempFiles(tempDir, zipPath) {
  if (fs.existsSync(tempDir)) {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
  if (fs.existsSync(zipPath)) {
    fs.unlinkSync(zipPath);
  }
}

async function handleFileUpload(req) {
  const poolType = req.body.poolType || 'community';
  const { eventPoolId, hash, signature, publicKey } = req.body;
  const zipPath = req.file.path;

  if (!req.file) {
    throw new Error('No ZIP file provided');
  }

  // Verify the hash matches the uploaded ZIP file
  const zipBuffer = fs.readFileSync(zipPath);
  const calculatedHash = crypto.createHash('sha256').update(zipBuffer).digest('hex');
  if (calculatedHash !== hash) {
    throw new Error('Hash mismatch');
  }

  // Verify the signature using the provided public key
  let publicKeyJwk;
  try {
    publicKeyJwk = JSON.parse(publicKey);
  } catch (e) {
    throw new Error('Invalid public key format');
  }
  const publicKeyPem = jwkToPem(publicKeyJwk);
  const isValid = crypto.verify(
    {
      algorithm: 'sha256',
      key: publicKeyPem,
      padding: crypto.constants.RSA_PKCS1_PSS_PADDING,
      saltLength: crypto.constants.RSA_PSS_SALTLEN_DIGEST
    },
    Buffer.from(hash, 'hex'),
    Buffer.from(signature, 'base64')
  );
  if (!isValid) {
    throw new Error('Invalid signature');
  }

  let sponsorWallet;
  let poolName = '';
  let walletAddress = null;

  if (poolType === 'event') {
    if (!eventPoolId) {
      throw new Error('Event pool requires pool ID');
    }
    const pools = poolManager.loadPools();
    const pool = pools[eventPoolId];
    if (!pool) {
      throw new Error('Invalid pool ID');
    }
    const now = new Date().toISOString();
    if (now < pool.startTime || now > pool.endTime) {
      throw new Error('Pool is not active');
    }
    poolName = pool.name;

    // Derive wallet address from provided public key
    const arweaveInstance = arweave.init({});
    walletAddress = await arweaveInstance.wallets.jwkToAddress(publicKeyJwk);

    // Check if derived address is in the whitelist
    const whitelist = pool.whitelist || [];
    if (!whitelist.includes(walletAddress)) {
      throw new Error('Wallet address not in whitelist');
    }

    // Update pool usage
    const totalSize = fs.statSync(zipPath).size;
    const estimatedCost = totalSize / (1024 * 1024) * 0.1;
    poolManager.updatePoolUsage(eventPoolId, walletAddress, estimatedCost, pool);

    sponsorWallet = walletManager.loadWalletFromPath(pool.walletPath);
  } else {
    // For community pools, use a random wallet (no whitelist check needed)
    sponsorWallet = walletManager.getRandomCommunityWallet();
  }

  console.log(`Using wallet for ${poolType} pool`);

  const tempDir = path.join(__dirname, 'temp', Date.now().toString());
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    await extractZipFile(zipPath, tempDir);
    
    const fileMetadata = JSON.parse(req.body.fileMetadata || '[]');
    validateUploadFiles(fileMetadata, tempDir);
    
    const result = await uploadToArweave(fileMetadata, tempDir, sponsorWallet, poolType, poolName);
    
    return {
      poolType,
      uploadedFiles: result.uploadedFiles,
      poolName: poolType === 'event' ? `You have been sponsored by ${poolName}` : undefined,
      remainingBalance: result.remainingBalance,
      equivalentFileSize: result.equivalentFileSize
    };
  } finally {
    cleanupTempFiles(tempDir, zipPath);
  }
}

module.exports = {
  calculateFileHash,
  getContentType,
  extractZipFile,
  validateUploadFiles,
  uploadToArweave,
  cleanupTempFiles,
  handleFileUpload
};