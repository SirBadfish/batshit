import { apiKeyEncryption } from './encryption.server';
import { redis } from '$lib/server/redis';
import { containsSuspiciousInput } from '$lib/utils/inputSanitization';
import type { RedisClientType } from 'redis';
import type { RedisJSON } from '@redis/json';

export interface ApiKeyInfo {
  service: string;
  masked: string;
  updatedAt: string;
  status: 'ready' | 'needs-config' | 'error';
}

interface StoredApiKey {
  encrypted: string;
  iv: string;
  authTag: string;
  updatedAt: string;
}

export const INFRA_API_KEY_SERVICES = new Set([
  'batshit_token',
  'n8n_api_key',
  'n8n_api_url',
  'batshit_artifact_complete_url',
  'n8n_instance_mcp_token',
  'ai_gateway'
]);

const GENERIC_SECRET_PATTERN = /^[\x21-\x7E]{3,4096}$/;
const INTERNAL_SECRET_PATTERN = /^[\x21-\x7E]{8,4096}$/;

function normalizeApiKeyValue(apiKey: string): string {
  return typeof apiKey === 'string' ? apiKey.trim() : '';
}

// Service-specific validation patterns. Most provider keys intentionally use a
// relaxed single-line secret shape because vendors change token formats often.
const API_KEY_PATTERNS: Record<string, RegExp> = {
  openweather: GENERIC_SECRET_PATTERN,
  anthropic: GENERIC_SECRET_PATTERN,
  openai: GENERIC_SECRET_PATTERN,
  google: GENERIC_SECRET_PATTERN,
  groq: GENERIC_SECRET_PATTERN,
  xai: GENERIC_SECRET_PATTERN,
  moonshot: GENERIC_SECRET_PATTERN,
  minimax: GENERIC_SECRET_PATTERN,
  mimo: GENERIC_SECRET_PATTERN,
  qwencloud: GENERIC_SECRET_PATTERN,
  alibaba: GENERIC_SECRET_PATTERN,
  stepfun: GENERIC_SECRET_PATTERN,
  mistral: GENERIC_SECRET_PATTERN,
  deepseek: GENERIC_SECRET_PATTERN,
  openrouter: GENERIC_SECRET_PATTERN,
  zai: GENERIC_SECRET_PATTERN,
  zai_coding: GENERIC_SECRET_PATTERN,
  fal: GENERIC_SECRET_PATTERN,
  fish: GENERIC_SECRET_PATTERN,
  inworld: GENERIC_SECRET_PATTERN,
  cartesia: GENERIC_SECRET_PATTERN,
  async: GENERIC_SECRET_PATTERN,
  azure_speech_key: GENERIC_SECRET_PATTERN,
  azure_speech_region: /^[A-Za-z0-9-]{2,64}$/i,
  luma: GENERIC_SECRET_PATTERN,
  replicate: GENERIC_SECRET_PATTERN,
  elevenlabs: GENERIC_SECRET_PATTERN,
  deepgram: GENERIC_SECRET_PATTERN,
  assemblyai: GENERIC_SECRET_PATTERN,
  cohere: GENERIC_SECRET_PATTERN,
  deepinfra: GENERIC_SECRET_PATTERN,
  togetherai: GENERIC_SECRET_PATTERN,
  fireworks: GENERIC_SECRET_PATTERN,
  baseten: GENERIC_SECRET_PATTERN,
  cerebras: GENERIC_SECRET_PATTERN,
  exa: GENERIC_SECRET_PATTERN,
  perplexity: GENERIC_SECRET_PATTERN,
  browserbase: GENERIC_SECRET_PATTERN,
  browserbase_project_id: /^[A-Za-z0-9._:-]{3,128}$/,
  browserbase_api_url: /^https?:\/\/.+/i,
  browseruse: GENERIC_SECRET_PATTERN,
  browseruse_base_url: /^https?:\/\/.+/i,
  kernel: GENERIC_SECRET_PATTERN,
  kernel_base_url: /^https?:\/\/.+/i,
  livekit_url: /^(?:wss?|https?):\/\/.+/i,
  livekit_api_key: GENERIC_SECRET_PATTERN,
  livekit_api_secret: GENERIC_SECRET_PATTERN,
  ai_gateway: GENERIC_SECRET_PATTERN,
  huggingface: GENERIC_SECRET_PATTERN,
  github: GENERIC_SECRET_PATTERN,
  n8n_api_key: GENERIC_SECRET_PATTERN,
  n8n_api_url: /^https?:\/\/.+/i,
  n8n_instance_mcp_token: GENERIC_SECRET_PATTERN,
  batshit_token: INTERNAL_SECRET_PATTERN,
  batshit_artifact_complete_url: /^https?:\/\/.+/i
};

const UNMASKED_SERVICES = new Set([
  'n8n_api_url',
  'batshit_artifact_complete_url',
  'browserbase_project_id',
  'browserbase_api_url',
  'browseruse_base_url',
  'kernel_base_url',
  'livekit_url',
  'azure_speech_region'
]);

// Rate limiting map (in-memory for simplicity)
const validationAttempts = new Map<string, { count: number; resetAt: number }>();

export function normalizeApiKeyServiceName(service: string): string {
  return service.trim().toLowerCase();
}

export function listUserFacingApiKeyServices(): string[] {
  return Object.keys(API_KEY_PATTERNS)
    .filter((service) => !INFRA_API_KEY_SERVICES.has(service))
    .sort();
}

export function isUserFacingApiKeyService(service: string): boolean {
  const normalized = normalizeApiKeyServiceName(service);
  return listUserFacingApiKeyServices().includes(normalized);
}

class ApiKeyService {
  /**
   * Store an encrypted API key
   */
  async store(service: string, apiKey: string, userId: string): Promise<void> {
    const normalizedService = normalizeApiKeyServiceName(service);
    const normalizedApiKey = normalizeApiKeyValue(apiKey);

    // Validate format first
    if (!this.validateFormat(normalizedService, normalizedApiKey)) {
      throw new Error(`Invalid API key format for ${normalizedService}`);
    }

    // Check for injection attempts
    if (this.containsInjection(normalizedApiKey)) {
      throw new Error('Invalid key format - contains suspicious characters');
    }

    // Encrypt the API key
    const encryptedData = apiKeyEncryption.encrypt(normalizedApiKey);

    // Store in Redis as JSON
    await redis.execute(async (client) => {
      await client.json.set(`api_keys:${userId}:${normalizedService}`, '$', {
        encrypted: encryptedData.encrypted,
        iv: encryptedData.iv,
        authTag: encryptedData.authTag,
        updatedAt: new Date().toISOString()
      } as unknown as RedisJSON);
    });
  }

  /**
   * Retrieve and decrypt an API key
   */
  async retrieve(service: string, userId: string): Promise<string | null> {
    const normalizedService = normalizeApiKeyServiceName(service);
    const storedData = await redis.execute(async (client) => {
      return await client.json.get(`api_keys:${userId}:${normalizedService}`) as StoredApiKey | null;
    });

    if (!storedData) return null;

    try {
      return apiKeyEncryption.decrypt(
        storedData.encrypted,
        storedData.iv,
        storedData.authTag
      );
    } catch (error) {
      console.error(`Failed to decrypt API key for ${normalizedService}:`, error);
      return null;
    }
  }

  /**
   * Get a masked version of an API key
   */
  async getMasked(service: string, userId: string): Promise<string | null> {
    const normalizedService = normalizeApiKeyServiceName(service);
    const apiKey = await this.retrieve(normalizedService, userId);
    if (!apiKey) return null;
    if (UNMASKED_SERVICES.has(normalizedService)) {
      return apiKey;
    }
    return apiKeyEncryption.mask(apiKey);
  }

  /**
   * Get all API keys for a user (masked)
   */
  async getAllMasked(
    userId: string,
    options: { skipServices?: Iterable<string> } = {}
  ): Promise<Record<string, ApiKeyInfo>> {
    const result: Record<string, ApiKeyInfo> = {};
    const skipServices = new Set(options.skipServices ?? []);

    // Get all supported services
    const services = Object.keys(API_KEY_PATTERNS).filter((service) => !skipServices.has(service));

    for (const service of services) {
      const masked = await this.getMasked(service, userId);
      const storedData = await redis.execute(async (client) => {
        return await client.json.get(`api_keys:${userId}:${service}`) as StoredApiKey | null;
      });

      if (storedData) {
        result[service] = {
          service,
          masked: masked || '****',
          updatedAt: storedData.updatedAt,
          status: masked ? 'ready' : 'error'
        };
      } else {
        result[service] = {
          service,
          masked: '',
          updatedAt: '',
          status: 'needs-config'
        };
      }
    }

    return result;
  }

  /**
   * Update an existing API key
   */
  async update(service: string, apiKey: string, userId: string): Promise<void> {
    return this.store(service, apiKey, userId);
  }

  /**
   * Delete an API key
   */
  async delete(service: string, userId: string): Promise<void> {
    const normalizedService = normalizeApiKeyServiceName(service);
    await redis.execute(async (client) => {
      await client.del(`api_keys:${userId}:${normalizedService}`);
    });
  }

  /**
   * Check if an API key exists for a service
   */
  async exists(service: string, userId: string): Promise<boolean> {
    const key = await this.retrieve(service, userId);
    return key !== null;
  }

  /**
   * Get API key availability for all user-facing services.
   * Returns configured vs not-configured lists WITHOUT decrypting any values.
   * Infrastructure keys (batshit_token, n8n_*, etc.) are excluded.
   */
  async getApiKeyAvailability(userId: string): Promise<{ configured: string[], notConfigured: string[] }> {
    const userFacingServices = listUserFacingApiKeyServices()

    const configured: string[] = []
    const notConfigured: string[] = []

    for (const service of userFacingServices) {
      const exists = await redis.exists(`api_keys:${userId}:${service}`)
      if (exists) {
        configured.push(service)
      } else {
        notConfigured.push(service)
      }
    }

    return { configured, notConfigured }
  }

  /**
   * Validate an API key format
   */
  validateFormat(service: string, apiKey: string): boolean {
    const normalizedService = normalizeApiKeyServiceName(service);
    const normalizedApiKey = normalizeApiKeyValue(apiKey);
    const pattern = API_KEY_PATTERNS[normalizedService];
    if (!pattern) return GENERIC_SECRET_PATTERN.test(normalizedApiKey);
    return pattern.test(normalizedApiKey);
  }

  /**
   * Check for injection attempts
   */
  private containsInjection(apiKey: string): boolean {
    return containsSuspiciousInput(apiKey, { sqlKeywords: true });
  }

  /**
   * Validate API key with rate limiting
   */
  async validateWithRateLimit(service: string, apiKey: string, userId: string): Promise<{
    valid: boolean;
    error?: string;
    retryAfter?: number;
  }> {
    const now = Date.now();
    const rateLimitKey = `${userId}:${service}`;

    // Check rate limit
    const attempts = validationAttempts.get(rateLimitKey);
    if (attempts) {
      if (attempts.resetAt > now && attempts.count >= 5) {
        return {
          valid: false,
          error: 'Rate limit exceeded',
          retryAfter: Math.ceil((attempts.resetAt - now) / 1000)
        };
      }

      if (attempts.resetAt <= now) {
        // Reset counter
        validationAttempts.set(rateLimitKey, { count: 1, resetAt: now + 60000 });
      } else {
        // Increment counter
        attempts.count++;
      }
    } else {
      // First attempt
      validationAttempts.set(rateLimitKey, { count: 1, resetAt: now + 60000 });
    }

    // Validate format
    const normalizedService = normalizeApiKeyServiceName(service);
    const normalizedApiKey = normalizeApiKeyValue(apiKey);

    if (!this.validateFormat(normalizedService, normalizedApiKey)) {
      return { valid: false, error: 'Invalid key format' };
    }

    // Check for injection
    if (this.containsInjection(normalizedApiKey)) {
      return { valid: false, error: 'Invalid key format - suspicious characters detected' };
    }

    // Could add actual API validation here (test the key with the service)
    return { valid: true };
  }

  /**
   * Check whether an API key matches Batshit's saved format expectations.
   */
  async testApiKey(service: string, apiKey: string): Promise<{
    success: boolean;
    formatValid: boolean;
    verified: boolean;
    message?: string;
    error?: string;
  }> {
    const normalizedService = normalizeApiKeyServiceName(service);
    const normalizedApiKey = normalizeApiKeyValue(apiKey);
    const isValid = this.validateFormat(normalizedService, normalizedApiKey);

    if (!isValid) {
      return {
        success: false,
        formatValid: false,
        verified: false,
        error: 'Invalid key format'
      };
    }

    if (this.containsInjection(normalizedApiKey)) {
      return {
        success: false,
        formatValid: false,
        verified: false,
        error: 'Invalid key format - suspicious characters detected'
      };
    }

    return {
      success: true,
      formatValid: true,
      verified: false,
      message: 'API key format looks valid. This test does not contact the provider.'
    };
  }
}

export const apiKeyService = new ApiKeyService();

// Test helper to reset rate limiting state (clears in-memory cache)
export function __resetApiKeyRateLimitCacheForTests() {
  validationAttempts.clear();
}
