import { afterEach, describe, test, expect, beforeEach, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { apiKeyEncryption, assertApiKeyEncryptionConfigured } from '$lib/services/encryption.server'
import { apiKeyService, READ_API_KEY_REFERENCE_SCRIPT, __resetApiKeyRateLimitCacheForTests } from '$lib/services/apiKey.server'

vi.mock('$app/env', () => ({
  building: false,
  dev: false
}))

useRedisTestServer()

beforeEach(() => {
  __resetApiKeyRateLimitCacheForTests()
})

describe('API Key Encryption Service', () => {
  test('I1 reference-only cuts retain exact saved source without decrypting, including an undecryptable present record', async () => {
    const userId = 'i1_reference_user', key = apiKeyService.storedKeyName('custom-mcp', userId)
    const decrypt = vi.spyOn(apiKeyEncryption, 'decrypt')
    // Default-lane reply adapter tests private DTO custody/no decryption, not Lua.
    // The genuine portable route case exercises this script on admitted real Redis.
    let reply = ['', 'absent']
    const read = vi.fn(async (script: string, options: { keys: string[] }) => {
      expect(script).toBe(READ_API_KEY_REFERENCE_SCRIPT); expect(options.keys).toEqual([key]); return reply
    })
    const execute = vi.spyOn(redis, 'execute').mockImplementation(async callback => callback({ eval: read } as never))
    try {
      expect(await apiKeyService.readReferenceState('custom-mcp', userId)).toEqual({ key, raw: '', present: false, shapeValid: true })
      await redis.json.set(key, '$', { encrypted: 'not-a-ciphertext', iv: 'not-an-iv', authTag: 'not-a-tag' })
      reply = [(await redis.json.getRaw(key, '$'))!, 'present']
      const state = await apiKeyService.readReferenceState('custom-mcp', userId)
      expect(state).toMatchObject({ key, present: true, shapeValid: true })
      expect(state.raw).toBe(await redis.json.getRaw(key, '$'))
      expect(state).not.toHaveProperty('value')
      expect(decrypt).not.toHaveBeenCalled()
      await redis.json.set(key, '$', { encrypted: null })
      reply = ['', 'malformed']
      expect(await apiKeyService.readReferenceState('custom-mcp', userId)).toMatchObject({ present: true, shapeValid: false })
      await redis.json.set(key, '$', { encrypted: 'x'.repeat(16385) })
      reply = [(await redis.json.getRaw(key, '$'))!, 'present']
      await expect(apiKeyService.readReferenceState('custom-mcp', userId)).rejects.toThrow('reference is unavailable')
      await expect(apiKeyService.readReferenceState('batshit_token', userId)).rejects.toThrow('reference is unavailable')
      expect(decrypt).not.toHaveBeenCalled()
    } finally { execute.mockRestore(); decrypt.mockRestore() }
  })
  test('A10 private configured use binds the actual value to one bounded raw cut and clears its temporary value', async () => {
    const userId = 'a10_account_key_user', key = apiKeyService.storedKeyName('fish', userId)
    let held: import('$lib/services/apiKey.server').ConfiguredApiKeyUseState | undefined
    expect(await apiKeyService.withConfiguredValue('fish', userId, async source => ({ state: source.state, raw: source.raw }))).toEqual({ state: 'absent', raw: '[]' })
    await redis.json.set(key, '$', apiKeyEncryption.encrypt('A10_ACCOUNT_PRIVATE_VALUE'))
    const answer = await apiKeyService.withConfiguredValue('fish', userId, async source => {
      held = source
      expect(source.value).toBe('A10_ACCOUNT_PRIVATE_VALUE')
      expect(source.state).toBe('readable')
      return { key: source.key, raw: source.raw }
    })
    expect(answer).toMatchObject({ key })
    expect(JSON.stringify(answer)).not.toContain('A10_ACCOUNT_PRIVATE_VALUE')
    expect(held?.value).toBeNull()
  })
  test('A10 private use keeps malformed input unreadable, bounds before consumption and preserves consumer failure', async () => {
    const userId = 'a10_account_key_user', key = apiKeyService.storedKeyName('fish', userId)
    await redis.json.set(key, '$', { encrypted: 'invalid', iv: 'invalid', authTag: 'invalid' })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await apiKeyService.withConfiguredValue('fish', userId, async source => ({ state: source.state, value: source.value }))).toEqual({ state: 'unreadable', value: null })
      const consume = vi.fn(async () => 'must not run')
      await redis.json.set(key, '$', { encrypted: 'x'.repeat(16385), iv: 'invalid', authTag: 'invalid' })
      await expect(apiKeyService.withConfiguredValue('fish', userId, consume)).rejects.toThrow('Configured key state is unavailable.')
      expect(consume).not.toHaveBeenCalled()
      await redis.json.set(key, '$', apiKeyEncryption.encrypt('A10_ACCOUNT_PRIVATE_VALUE'))
      let held: import('$lib/services/apiKey.server').ConfiguredApiKeyUseState | undefined
      await expect(apiKeyService.withConfiguredValue('fish', userId, async source => { held = source; throw new Error('consumer failed') })).rejects.toThrow('consumer failed')
      expect(held?.value).toBeNull()
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })
  test('A10 configured-state evidence distinguishes absent/unreadable and never retains or logs plaintext', async () => {
    const userId = 'a10_configured_key_user', key = apiKeyService.storedKeyName('openai', userId)
    expect(await apiKeyService.readConfiguredState('openai', userId)).toEqual({ key, raw: '[]', configured: false, readable: true })
    await redis.json.set(key, '$', apiKeyEncryption.encrypt('A10_PRIVATE_SYNTHETIC_VALUE'))
    const saved = await apiKeyService.readConfiguredState('openai', userId)
    expect(saved).toMatchObject({ key, configured: true, readable: true })
    expect(JSON.stringify(saved)).not.toContain('A10_PRIVATE_SYNTHETIC_VALUE')
    await redis.json.set(key, '$', { encrypted: 'invalid', iv: 'invalid', authTag: 'invalid' })
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    try {
      expect(await apiKeyService.readConfiguredState('openai', userId)).toMatchObject({ key, configured: false, readable: false })
      expect(log).not.toHaveBeenCalled()
      await redis.json.set(key, '$', { encrypted: 'x'.repeat(16385), iv: 'invalid', authTag: 'invalid' })
      await expect(apiKeyService.readConfiguredState('openai', userId)).rejects.toThrow('Configured key state is unavailable.')
      expect(log).not.toHaveBeenCalled()
    } finally { log.mockRestore() }
  })

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
