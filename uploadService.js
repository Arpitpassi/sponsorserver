import { createReadStream, existsSync, statSync, readFileSync, rmSync, unlinkSync, mkdirSync } from 'fs';
import { extname, join } from 'path';
import { Extract } from 'unzipper';
import { createHash } from 'crypto';
import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk';
import { loadPools, updatePoolUsage } from './poolManager.js';
import { loadWalletFromPath, getRandomCommunityWallet } from './walletManager.js';
import ArweaveSignatureVerifier from './arweaveSignatureVerifier.js';

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
  await new Promise((resolve, reject) => {
    createReadStream(zipPath)
      .pipe(Extract({ path: tempDir }))
      .on('close', resolve)
      .on('error', reject);
  });
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

  const uploadedFiles = [];
  for (const file of fileMetadata) {
    const filePath = join(tempDir, file.relativePath);
    if (!existsSync(filePath)) {
      throw { code: 'FILE_NOT_FOUND_IN_ZIP', message: `File not found in zip: ${file.relativePath}` };
    }
    const fileStreamFactory = () => createReadStream(filePath);
    const fileSizeFactory = () => statSync(filePath).size;
    const hash = createHash('sha256').update(readFileSync(filePath)).digest('hex');

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
      lastModified: statSync(filePath).mtime.toISOString()
    });
  }

  const balanceResult = await turbo.getBalance();
  const remainingBalance = balanceResult.winc / 1e12;
  const equivalentFileSize = (remainingBalance / 0.1) * 1024 * 1024;

  return { uploadedFiles, remainingBalance, equivalentFileSize };
}

function cleanupTempFiles(tempDir, zipPath) {
  if (existsSync(tempDir)) {
    rmSync(tempDir, { recursive: true, force: true });
    console.log(`Cleaned up temporary directory: ${tempDir}`);
  }
  if (existsSync(zipPath)) {
    unlinkSync(zipPath);
    console.log(`Deleted uploaded ZIP file: ${zipPath}`);
  }
}

async function handleFileUpload(req) {
  const poolType = req.body.poolType || 'community';
  const { eventPoolId, zipHash, signature, publicKey, walletAddress } = req.body;
  const zipPath = req.file.path;

  if (!req.file) {
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

  if (poolType === 'event') {
    if (!eventPoolId) {
      throw { code: 'MISSING_POOL_ID', message: 'Event pool requires pool ID' };
    }
    const pools = loadPools();
    const pool = pools[eventPoolId];
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

    // Update pool usage
    const totalSize = statSync(zipPath).size;
    const estimatedCost = totalSize / (1024 * 1024) * 0.1;
    updatePoolUsage(eventPoolId, walletAddress, estimatedCost, pool);

    sponsorWallet = loadWalletFromPath(pool.walletPath);
  } else {
    // For community pools, use a random wallet (no whitelist check needed)
    sponsorWallet = getRandomCommunityWallet();
  }

  console.log(`Using wallet for ${poolType} pool`);

  const tempDir = join(__dirname, 'temp', Date.now().toString());
  mkdirSync(tempDir, { recursive: true });

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

export {
  getContentType,
  extractZipFile,
  validateUploadFiles,
  uploadToArweave,
  cleanupTempFiles,
  handleFileUpload
};