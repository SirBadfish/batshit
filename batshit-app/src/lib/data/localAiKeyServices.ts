/**
 * SA-102 P6 (DL-102-09, revised 2026-09-03) — the API Keys panel's rows for
 * local AI programs.
 *
 * The original decision put a key field in two places, Settings -> API Keys and
 * Settings -> Local AI. Josh's call on 2026-09-03: one secret, one place, and
 * API Keys is the place. Two editors for one value is a drift hazard and makes
 * a user wonder which one is real.
 *
 * Generated from `LOCAL_AI_SERVER_DEFINITIONS` so a program added there surfaces
 * here with no edit — the same rule the parameter schemas and the
 * compatibility-matrix scopes follow. It lives in a data module rather than
 * inside the panel so the user-facing copy can be asserted without rendering,
 * because the descriptions render inside closed info popovers.
 */

import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
import { getLocalAiIconRef } from '$lib/data/localAiIcons'
import type { IconRef } from '$lib/icons/iconTypes'

export type LocalAiKeyServiceDefinition = {
  id: string
  label: string
  description: string
  scope: 'provider'
  connectionHint: string
  iconRef: IconRef
}

export const LOCAL_AI_KEY_SERVICES: LocalAiKeyServiceDefinition[] =
  LOCAL_AI_SERVER_DEFINITIONS.map((definition) => ({
    id: definition.id,
    label: definition.label,
    // Says "only if" first, because most local programs never ask for a key and
    // a user who assumes it is required goes hunting for one that does not exist.
    description: `Only if ${definition.label} asks for one. Most local programs ignore the key entirely — leave this blank unless ${definition.label} answers with "401" or "API key required". The same key is used for chat and for memory search.`,
    scope: 'provider' as const,
    connectionHint: 'Runs on your computer',
    iconRef: getLocalAiIconRef(definition.id)
  }))
