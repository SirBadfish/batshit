/**
 * SA-102 P6: the icon each local AI program renders with.
 *
 * Two panels need these — Settings → Local AI for the program cards, and
 * Settings → API Keys for the key rows — so the map lives beside
 * `LOCAL_AI_SERVER_DEFINITIONS` rather than being copied into a component.
 * Adding a program stays one row in `localAiServers.ts` plus, optionally, one
 * row here; a program with no brand icon falls back cleanly.
 */

import type { IconRef } from '$lib/icons/iconTypes'

/** Brand marks that exist in the generated brand-icon set. */
const LOCAL_AI_ICON_REFS: Partial<Record<string, IconRef>> = {
  ollama: { kind: 'brand', slug: 'ollama-mono', fixed: true },
  dmr: { kind: 'brand', slug: 'docker-color', fixed: true },
  lmstudio: { kind: 'brand', slug: 'lmstudio-mono', fixed: true },
  'llama-cpp': { kind: 'brand', slug: 'llamacpp-color', fixed: true },
  vllm: { kind: 'brand', slug: 'vllm-color', fixed: true }
  // SGLang and oMLX have no brand mark in the generated set yet, so they take
  // the generic fallback below rather than borrowing someone else's logo.
}

export function getLocalAiIconRef(serverId: string): IconRef {
  return LOCAL_AI_ICON_REFS[serverId] ?? { kind: 'lucide', id: 'server' }
}
