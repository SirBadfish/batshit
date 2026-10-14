/**
 * Relevant event envelopes reconstructed from Automation B's scrubbed
 * claude-previous-pin.json (Claude 2.1.289, 2026-10-11). Model identities,
 * assistant usage, result usage and modelUsage are captured values. Assistant
 * role/content and event order are reconstructed (the receipt retains a set of
 * event types and result text). Omitted unrelated events/fields mean this is a
 * focused fixture, not a full wire log.
 * Candidate 2.1.296's claude-bridge-final.json independently has the same
 * init-suffix / assistant-base / result-key + canonicalModel relationship.
 */
export function capturedClaudePrimaryEvents(): any[] {
  return [
    { type: 'system', subtype: 'init', model: 'claude-sonnet-5-5[1m]', apiKeySource: 'none' },
    { type: 'assistant', message: {
      role: 'assistant', model: 'claude-sonnet-5-5', content: [{ type: 'text', text: 'OK' }],
      usage: {
        input_tokens: 2, cache_creation_input_tokens: 13_523, cache_read_input_tokens: 0,
        cache_creation: { ephemeral_5m_input_tokens: 0, ephemeral_1h_input_tokens: 13_523 },
        output_tokens: 4, service_tier: 'standard', inference_geo: 'global'
      }
    } },
    { type: 'result', subtype: 'success', is_error: false, result: 'OK', usage: {}, modelUsage: {
      'claude-sonnet-5-5[1m]': {
        inputTokens: 2, outputTokens: 4, cacheReadInputTokens: 0,
        cacheCreationInputTokens: 13_523, webSearchRequests: 0, costUSD: 0.054136000000000004,
        contextWindow: 1_000_000, maxOutputTokens: 128_000, thinkingTokens: 0,
        canonicalModel: 'claude-sonnet-5-5', provider: 'firstParty', costBasis: 'list'
      }
    } }
  ]
}
