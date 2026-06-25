// Classifies provider/CLI errors that mean "the model context window is full".
// Used by send-routed to decide whether a failed managed run is eligible for
// automatic continuation (a fresh run recompiled from persisted history, where
// tool results live as compact zip refs).
//
// Codex CLI, OpenAI-compatible APIs, Anthropic, and Google each word this
// differently; keep patterns tight enough to avoid classifying unrelated
// failures as continuable — a wrong match would auto-retry an error that can
// never succeed.

export const CONTEXT_EXHAUSTION_PATTERNS: RegExp[] = [
  /batshit context guard/i, // proactive guard stop from the managed CLI lanes
  /ran out of room in the model[’']?s context window/i, // Codex CLI turn.failed
  /context[_\s-]?length[_\s-]?exceeded/i, // OpenAI error code
  /maximum context length/i, // OpenAI message text
  /prompt is too long/i, // Anthropic
  /input length and `?max_tokens`? exceed context limit/i, // Anthropic variant
  /input token count .{0,30}exceeds the maximum number of tokens/i, // Google Gemini
  /exceeds? the (?:maximum )?(?:context|token) (?:window|limit|length)/i,
  /context window .{0,40}exceeded/i,
]

export function isContextExhaustionError(
  message: string | null | undefined,
): boolean {
  if (!message) return false
  return CONTEXT_EXHAUSTION_PATTERNS.some((pattern) => pattern.test(message))
}
