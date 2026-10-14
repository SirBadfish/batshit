/**
 * BL-684: Batshit names itself in each call to a model seller.
 *
 * One true identity, sent as the User-Agent of every provider client the
 * `ProviderManager` creates for chat and of the OpenAI speech and transcription
 * clients (the other seller calls still lack it: see the bug list's waiting line
 * that follows BL-684). The AI SDK appends its own
 * library name after it (`ai-sdk/openai/<v>`), which is also true, so a seller
 * reads `Batshit/<version> (+https://batshit.ai) ai-sdk/...`.
 *
 * Never another tool's name: a seller's rule (Kimi Code, 2026-09-27) allows
 * another tool only when it keeps its true identity.
 */
import { BATSHIT_APP_VERSION } from '$lib/version'

export const BATSHIT_USER_AGENT = `Batshit/${BATSHIT_APP_VERSION} (+https://batshit.ai)`

/** The headers every provider client gets. A fresh object each call. */
export function batshitProviderHeaders(): Record<string, string> {
  return { 'User-Agent': BATSHIT_USER_AGENT }
}

/**
 * Batshit's identity plus a connection's own headers. A User-Agent the user set
 * on a custom connection (any letter case) replaces Batshit's; the two are
 * never joined into one header.
 */
export function withBatshitIdentity(
  headers?: Record<string, string> | null
): Record<string, string> {
  const own = headers ?? {}
  const userSetAgent = Object.keys(own).some((name) => name.toLowerCase() === 'user-agent')
  return userSetAgent ? { ...own } : { ...batshitProviderHeaders(), ...own }
}
