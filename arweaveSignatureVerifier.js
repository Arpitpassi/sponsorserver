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