/**
 * Mock for SvelteKit environment variables in tests
 */

export const env = {
  // API Keys
  ANTHROPIC_API_KEY: 'sk-ant-placeholder',
  OPENAI_API_KEY: 'sk-placeholder',
  GOOGLE_GENERATIVE_AI_API_KEY: 'validGoogleKey123',
  GROQ_API_KEY: 'gsk_placeholder',
  MISTRAL_API_KEY: 'mistralplaceholder',
  OPENROUTER_API_KEY: 'sk-or-placeholder',

  // Service URLs
  N8N_WEBHOOK_URL: 'http://localhost:5678/webhook',
  REDIS_URL: (() => {
    const base = process.env.REDIS_URL ?? 'redis://localhost:6379'

    if (process.env.VITEST === 'true') {
      // Force tests to an isolated DB (15) to protect DB0.
      if (!/\/\d+$/.test(base)) return `${base}/15`
      return base.endsWith('/0') ? base.replace(/\/0$/, '/15') : base
    }

    return base
  })(),

  // Secrets (test-only values; encryption.server fails loudly without a real key)
  ENCRYPTION_KEY: 'vitest-only-encryption-key-0123456789abcdef',

  // Feature Flags
  USE_VERCEL_BRAIN: 'true',

  // Other configs
  TOOL_EXECUTION_TIMEOUT: '15000'
}
