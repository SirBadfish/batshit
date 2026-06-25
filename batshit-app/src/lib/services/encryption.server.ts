import crypto from 'crypto';
import { building } from '$app/environment';
import { env } from '$env/dynamic/private';

// Historical placeholder value — recognized so an old .env that still carries
// it fails loudly instead of silently encrypting with a publicly known key.
const LEGACY_PLACEHOLDER_KEY = 'CHANGE-THIS-IN-PRODUCTION-32CHR';

function isUnsafePlaceholderSecret(value: string): boolean {
  const normalized = value.trim().toLowerCase();
  return normalized === LEGACY_PLACEHOLDER_KEY.toLowerCase() || normalized.startsWith('replace-with-');
}

class ApiKeyEncryption {
  private algorithm = 'aes-256-gcm';
  private secretKey: Buffer | null = null;

  private resolveKey(): string {
    const key = (env.ENCRYPTION_KEY || '').trim();

    // `vite build` loads server modules without runtime env; nothing is
    // encrypted at build time, so a placeholder keeps the build moving.
    if (building) return key || 'batshit-buildtime-placeholder-key-32';

    // No environment is exempt: a missing or publicly known key would mean
    // every stored provider API key is decryptable by anyone (G-0091).
    // Batshit launchers and the Mac app generate this key on first run.
    if (!key || isUnsafePlaceholderSecret(key) || key.length < 32) {
      throw new Error(
        'ENCRYPTION_KEY must be set to a stable, random secret of at least 32 characters. ' +
          'Launch Batshit through your normal install path once to generate it, ' +
          'or set it in .env yourself. Changing the key means stored API keys must be re-entered.'
      );
    }

    return key;
  }

  private getSecretKey(): Buffer {
    if (!this.secretKey) {
      // ENCRYPTION_KEY is generator-enforced high-entropy (all launch paths
      // create a 32-byte random secret), so HKDF is the appropriate key
      // derivation: standard, fast, domain-separated. The previous
      // scrypt-with-static-'salt' construction implied passphrase stretching
      // it did not deliver (G-0091).
      this.secretKey = Buffer.from(
        crypto.hkdfSync('sha256', this.resolveKey(), '', 'batshit-api-key-encryption-v1', 32)
      );
    }

    return this.secretKey;
  }

  assertConfigured(): void {
    this.resolveKey();
  }

  encrypt(text: string): { encrypted: string; iv: string; authTag: string } {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(this.algorithm, this.getSecretKey(), iv) as crypto.CipherGCM;

    let encrypted = cipher.update(text, 'utf8', 'hex');
    encrypted += cipher.final('hex');

    const authTag = cipher.getAuthTag();

    return {
      encrypted,
      iv: iv.toString('hex'),
      authTag: authTag.toString('hex')
    };
  }

  decrypt(encrypted: string, iv: string, authTag: string): string {
    const decipher = crypto.createDecipheriv(
      this.algorithm,
      this.getSecretKey(),
      Buffer.from(iv, 'hex')
    ) as crypto.DecipherGCM;

    decipher.setAuthTag(Buffer.from(authTag, 'hex'));

    let decrypted = decipher.update(encrypted, 'hex', 'utf8');
    decrypted += decipher.final('utf8');

    return decrypted;
  }

  /**
   * Mask an API key for display (e.g., "****...2345")
   */
  mask(key: string): string {
    if (!key || key.length < 4) return '****';
    return `****...${key.slice(-4)}`;
  }
}

export const apiKeyEncryption = new ApiKeyEncryption();

export function assertApiKeyEncryptionConfigured(): void {
  apiKeyEncryption.assertConfigured();
}
