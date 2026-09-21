/**
 * SA-125 (DL-125-06): move Ollama's sampler settings where Ollama reads them.
 *
 * `ollama-ai-provider-v2` 4.0.1 serialises the AI SDK's standard settings at the
 * TOP LEVEL of the `/api/chat` body:
 *
 *   { model, temperature, top_p, max_output_tokens, think, stream }
 *
 * Ollama does not read any of those there. Every generation setting belongs
 * inside `options`, and the output cap is `num_predict`, not `max_output_tokens`.
 *
 * Measured against a real Ollama on 2026-09-20, same model, same pinned seed:
 *
 *   options.temperature 0 vs 2          -> different output. Honoured.
 *   top-level temperature 2, with
 *     options.temperature 0 alongside   -> byte-identical to the 0 run. Ignored.
 *   top-level max_output_tokens 5       -> no truncation at all. Ignored.
 *
 * Without this shim, adopting the provider would silently break Temperature and
 * Max Output Tokens for every Ollama preset — strictly worse than the `/v1` door
 * it replaces. The provider is still worth using: it owns the NDJSON streaming,
 * tool-call assembly and abort plumbing, which is the expensive part. This fixes
 * its body in one place instead of Batshit owning a whole second protocol.
 *
 * Revisit when upstream fixes it; the shim is a no-op once nothing top-level is
 * left to move, so it is safe to leave in place until then.
 */

/**
 * Options that make Ollama REJECT the whole request rather than ignore them.
 * Verified one by one on 2026-09-20: `typical_p` answers
 * `{"error": "typical_p is no longer supported"}`, while `tfs_z` — also dropped
 * from Ollama — answers normally and is merely ignored, so it does not belong
 * here. Only add a name to this list after seeing it error.
 */
const OLLAMA_REMOVED_OPTIONS = ['typical_p'] as const

/** Top-level key in the provider's body -> the name Ollama reads inside `options`. */
const TOP_LEVEL_TO_OPTIONS: Record<string, string> = {
  temperature: 'temperature',
  top_p: 'top_p',
  top_k: 'top_k',
  min_p: 'min_p',
  seed: 'seed',
  stop: 'stop',
  frequency_penalty: 'frequency_penalty',
  presence_penalty: 'presence_penalty',
  // Ollama's output cap has its own name.
  max_output_tokens: 'num_predict',
  max_tokens: 'num_predict'
}

/**
 * Rewrites one Ollama request body. Exported for tests; the shim below wraps it
 * in a fetch.
 *
 * An explicit `options.<name>` always wins: it came from a Model Preset's
 * parameter routed through `providerOptions.ollama.options`, which is a
 * deliberate choice, while the top-level copy is only the SDK's serialisation.
 */
export function moveOllamaTopLevelSettingsIntoOptions(
  body: Record<string, unknown>
): Record<string, unknown> {
  const next: Record<string, unknown> = { ...body }
  const options: Record<string, unknown> = {
    ...((next.options as Record<string, unknown> | undefined) ?? {})
  }
  let moved = false

  // Ollama does not ignore these — it answers `{"error": "<name> is no longer
  // supported"}` and the whole send fails. Measured 2026-09-20 with `typical_p`.
  // Batshit never offers them, but a user-authored Custom Parameter is a genuine
  // passthrough (SA-102 P2), so someone copying settings from another app could
  // otherwise break every Ollama send with one stale field.
  for (const removed of OLLAMA_REMOVED_OPTIONS) {
    if (removed in options) delete options[removed]
    if (removed in next) delete next[removed]
  }

  for (const [topLevel, optionName] of Object.entries(TOP_LEVEL_TO_OPTIONS)) {
    if (!(topLevel in next)) continue
    const value = next[topLevel]
    delete next[topLevel]
    if (value === undefined || value === null) continue
    // Explicit wins. Two top-level keys can also map to one option name
    // (max_tokens and max_output_tokens), so the first one seen keeps the slot.
    if (options[optionName] !== undefined) continue
    options[optionName] = value
    moved = true
  }

  if (moved || Object.keys(options).length > 0) {
    next.options = options
  }
  return next
}

/** A `fetch` for `createOllama` that applies the rewrite to every chat request. */
export function withOllamaOptionsShim(
  baseFetch: typeof fetch = fetch
): typeof fetch {
  return async (input: any, init?: any) => {
    if (!init?.body || typeof init.body !== 'string') {
      return baseFetch(input, init)
    }
    let parsed: Record<string, unknown>
    try {
      parsed = JSON.parse(init.body)
    } catch {
      // Not JSON we understand; never let the shim be the reason a send fails.
      return baseFetch(input, init)
    }
    const rewritten = moveOllamaTopLevelSettingsIntoOptions(parsed)
    return baseFetch(input, { ...init, body: JSON.stringify(rewritten) })
  }
}
