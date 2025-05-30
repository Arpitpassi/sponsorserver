import { createReadStream, existsSync, statSync, readFileSync, rmSync, unlinkSync, mkdirSync } from 'fs';
import { extname, join, dirname } from 'path';
import { fileURLToPath } from 'url';
import { Extract } from 'unzipper';
import { createHash } from 'crypto';
import { TurboFactory, ArweaveSigner } from '@ardrive/turbo-sdk';
import { loadPools, updatePoolUsage } from './poolManager.js';
import { loadWalletFromPath, getRandomCommunityWallet } from './walletManager.js';
import ArweaveSignatureVerifier from './arweaveSignatureVerifier.js';

const __dirname = dirname(fileURLToPath(import.meta.url));

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

    const zipBuffer = readFileSync(zipPath);
    const calculatedHash = createHash('sha256').update(zipBuffer).digest('hex');
    if (calculatedHash !== zipHash) {
      throw { code: 'HASH_MISMATCH', message: 'Hash mismatch' };
    }

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
    let usage = null;
    let remainingAllowance = null;

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

      const whitelist = pool.whitelist || [];
      if (!whitelist.includes(walletAddress)) {
        throw { code: 'WALLET_NOT_WHITELISTED', message: 'Wallet address not in whitelist' };
      }

      sponsorWallet = loadWalletFromPath(pool.walletPath);
      usage = pool.usage[walletAddress] || 0;
      remainingAllowance = pool.usageCap - usage;
    } else {
      sponsorWallet = getRandomCommunityWallet();
      poolName = 'Community Pool';
    }

    console.log(`Using wallet for ${poolType} pool`);

    await extractZipFile(zipPath, tempDir);
    
    const fileMetadata = JSON.parse(req.body.fileMetadata || '[]');
    validateUploadFiles(fileMetadata, tempDir);
    
    const result = await uploadToArweave(fileMetadata, tempDir, sponsorWallet, poolType, poolName);
    
    if (poolType === 'event') {
      const actualWincSpent = Number(result.totalWincSpent) / 1e12;
      updatePoolUsage(eventPoolId, walletAddress, actualWincSpent, pool);
      usage = pool.usage[walletAddress] || actualWincSpent;
      remainingAllowance = pool.usageCap - usage;
    }

    return {
      poolType,
      uploadedFiles: result.uploadedFiles,
      poolName: poolType === 'event' ? `You have been sponsored by ${poolName}` : `You have been sponsored by the community pool`,
      remainingBalance: result.remainingBalance,
      equivalentFileSize: result.equivalentFileSize,
      totalCreditsSpent: result.totalWincSpent,
      usage: poolType === 'event' ? usage : undefined,
      remainingAllowance: poolType === 'event' ? remainingAllowance : undefined
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