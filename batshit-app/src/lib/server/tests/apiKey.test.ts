import { afterEach, describe, test, expect, beforeEach, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { apiKeyEncryption, assertApiKeyEncryptionConfigured } from '$lib/services/encryption.server'
import { apiKeyService, __resetApiKeyRateLimitCacheForTests } from '$lib/services/apiKey.server'

vi.mock('$app/environment', () => ({
  building: false,
  dev: false
}))

useRedisTestServer()

beforeEach(() => {
  __resetApiKeyRateLimitCacheForTests()
})

describe('API Key Encryption Service', () => {
  describe('Encryption/Decryption', () => {
    const originalEnv = { ...env }

    afterEach(() => {
      for (const key of Object.keys(env)) {
        delete env[key]
      }
      Object.assign(env, originalEnv)
    })

    test('encrypts and decrypts API keys correctly', () => {
      const originalKey = 'provider-placeholder-key';
      const encrypted = apiKeyEncryption.encrypt(originalKey);

      // Should not contain original key
      expect(encrypted.encrypted).not.toContain('provider-placeholder-key');
      expect(encrypted.encrypted).toBeTruthy();
      expect(encrypted.iv).toBeTruthy();
      expect(encrypted.authTag).toBeTruthy();

      // Should decrypt back to original
      const decrypted = apiKeyEncryption.decrypt(
        encrypted.encrypted,
        encrypted.iv,
        encrypted.authTag
      );
      expect(decrypted).toBe(originalKey);
    });

    test('generates unique IVs for each encryption', () => {
      const key = 'test-key';
      const enc1 = apiKeyEncryption.encrypt(key);
      const enc2 = apiKeyEncryption.encrypt(key);

      // IVs should be different even for same input
      expect(enc1.iv).not.toBe(enc2.iv);
      expect(enc1.encrypted).not.toBe(enc2.encrypted);
    });

    test('masks API keys correctly', () => {
      expect(apiKeyEncryption.mask('sk-test-1234567890')).toBe('****...7890');
      expect(apiKeyEncryption.mask('abc')).toBe('****');
      expect(apiKeyEncryption.mask('')).toBe('****');
      expect(apiKeyEncryption.mask('12345')).toBe('****...2345');
    });

    test('rejects missing, short, or placeholder encryption keys in every environment', () => {
      // The fallback-to-known-key behavior was removed (G-0091): dev installs
      // fail loudly too, never silently encrypt with a public key.
      for (const nodeEnv of ['production', 'development']) {
        env.NODE_ENV = nodeEnv
        delete env.ENCRYPTION_KEY

        expect(() => assertApiKeyEncryptionConfigured()).toThrow(
          'ENCRYPTION_KEY must be set to a stable, random secret of at least 32 characters'
        )

        env.ENCRYPTION_KEY = 'short'

        expect(() => assertApiKeyEncryptionConfigured()).toThrow(
          'ENCRYPTION_KEY must be set to a stable, random secret of at least 32 characters'
        )

        env.ENCRYPTION_KEY = 'replace-with-a-real-encryption-key-value'

        expect(() => assertApiKeyEncryptionConfigured()).toThrow(
          'ENCRYPTION_KEY must be set to a stable, random secret of at least 32 characters'
        )

        env.ENCRYPTION_KEY = 'CHANGE-THIS-IN-PRODUCTION-32CHR'

        expect(() => assertApiKeyEncryptionConfigured()).toThrow(
          'ENCRYPTION_KEY must be set to a stable, random secret of at least 32 characters'
        )
      }
    })

    test('accepts a stable encryption key in production', () => {
      env.NODE_ENV = 'production'
      env.ENCRYPTION_KEY = 'valid-production-encryption-key-123456'

      expect(() => assertApiKeyEncryptionConfigured()).not.toThrow()
    })
  });

  describe('Security Validation', () => {
    test('rejects malicious API key patterns', () => {
      const maliciousInputs = [
        '"; DROP TABLE users; --',
        '<script>alert(1)</script>',
        '${process.env.SECRET_KEY}',
        '../../../etc/passwd',
        '{{7*7}}',
        'javascript:alert(1)'
      ];

      for (const maliciousKey of maliciousInputs) {
        const hasInjection = apiKeyService['containsInjection'](maliciousKey);
        expect(hasInjection).toBe(true);
      }
    });

    test('validates relaxed single-line provider secret patterns', () => {
      const validationTests = [
        {
          service: 'openweather',
          valid: '1234567890abcdef1234567890abcdef',
          invalid: 'x'
        },
        {
          service: 'anthropic',
          valid: 'sk-ant-TESTONLYKEY00000',
          invalid: 'x'
        },
        {
          service: 'openai',
          valid: 'sk-TESTONLYKEY00000',
          invalid: 'x'
        },
        {
          service: 'openai',
          valid: 'pk-AbCdEfGhIjKlMnOpQrStUvWxYz1234567890',
          invalid: 'line-one\nline-two'
        },
        {
          service: 'fish',
          valid: 'fish_test_key_1234567890',
          invalid: 'x'
        },
        {
          service: 'inworld',
          valid: 'aW53b3JsZF90ZXN0X2tleQ==/+:',
          invalid: 'x'
        },
        {
          service: 'github',
          valid: 'github_pat_TESTONLY/+=._:-1234567890',
          invalid: 'two words'
        },
        {
          service: 'livekit_url',
          valid: 'ws://localhost:7880',
          invalid: 'localhost:7880'
        },
        {
          service: 'livekit_api_key',
          valid: 'devkey',
          invalid: 'x'
        },
        {
          service: 'livekit_api_secret',
          valid: 'secret',
          invalid: 'x'
        }
      ];

      for (const test of validationTests) {
        expect(apiKeyService.validateFormat(test.service, test.valid)).toBe(true);
        expect(apiKeyService.validateFormat(test.service, test.invalid)).toBe(false);
      }
    });

    test('test checks reject suspicious strings after relaxed format validation', async () => {
      const result = await apiKeyService.testApiKey('openai', '<script>alert(1)</script>')

      expect(result).toMatchObject({
        success: false,
        formatValid: false,
        verified: false,
        error: 'Invalid key format - suspicious characters detected'
      })
    })

    test('reports Test checks as format-only, not provider verified', async () => {
      const result = await apiKeyService.testApiKey('openai', 'sk-TESTONLYKEY00000')

      expect(result).toMatchObject({
        success: true,
        formatValid: true,
        verified: false
      })
      expect(result.message).toContain('does not contact the provider')
    })
  });

  describe('Rate Limiting', () => {
    test('enforces rate limits on validation attempts', async () => {
      const userId = 'test-user';
      const service = 'openai';
      const apiKey = 'sk-TESTONLYKEY00000';

      // Make 5 requests (should all succeed)
      for (let i = 0; i < 5; i++) {
        const result = await apiKeyService.validateWithRateLimit(service, apiKey, userId);
        expect(result.valid).toBe(true);
      }

      // 6th request should be rate limited
      const result = await apiKeyService.validateWithRateLimit(service, apiKey, userId);
      expect(result.valid).toBe(false);
      expect(result.error).toBe('Rate limit exceeded');
      expect(result.retryAfter).toBeGreaterThan(0);
    });
  });
});

describe('API Key Storage', () => {
  test('stores encrypted API keys in Redis JSON format', async () => {
    const userId = 'user123'
    const service = 'openweather'
    const key = `api_keys:${userId}:${service}`

    await redis.del(key)

    await apiKeyService.store(service, '  1234567890abcdef1234567890abcdef  ', userId)

    const stored = await redis.execute(async (client) => {
      return await client.json.get(key)
    })

    expect(typeof stored).toBe('object')
    expect(stored).toMatchObject({
      encrypted: expect.any(String),
      iv: expect.any(String),
      authTag: expect.any(String),
      updatedAt: expect.any(String)
    })
  })

  test('retrieves without parsing (json.get returns parsed)', async () => {
    const userId = 'user123'
    const service = 'openweather'
    const apiKey = 'openweather-placeholder-key'
    const key = `api_keys:${userId}:${service}`

    await redis.del(key)
    await apiKeyService.store(service, `  ${apiKey}  `, userId)

    const decryptSpy = vi.spyOn(apiKeyEncryption, 'decrypt')

    const retrieved = await apiKeyService.retrieve(service, userId)

    expect(retrieved).toBe(apiKey)
    expect(decryptSpy).toHaveBeenCalledWith(
      expect.any(String),
      expect.any(String),
      expect.any(String)
    )

    decryptSpy.mockRestore()
  })
})
