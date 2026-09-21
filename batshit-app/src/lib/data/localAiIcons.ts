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
  vllm: { kind: 'brand', slug: 'vllm-color', fixed: true },
  // SA-124 P7. None of these three are in the Lobe Icons or Simple Icons packs
  // Batshit already licenses (checked 2026-09-20: 850 and 3,429 marks, no hit),
  // so each was taken from the project's own repository and reduced to a
  // single-colour glyph in Batshit's house format. Provenance is in the story.
  sglang: { kind: 'brand', slug: 'sglang-mono', fixed: true },
  omlx: { kind: 'brand', slug: 'omlx-mono', fixed: true },
  koboldcpp: { kind: 'brand', slug: 'koboldcpp-mono', fixed: true }
}

export function getLocalAiIconRef(serverId: string): IconRef {
  return LOCAL_AI_ICON_REFS[serverId] ?? { kind: 'lucide', id: 'server' }
}
