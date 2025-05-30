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