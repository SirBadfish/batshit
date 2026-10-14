import { isAgentRuntimeSettingKey } from '$lib/utils/modelSettingsMapper'
import { NATIVE_TOOLS_SETTING_KEY, nativeToolsOf } from '$lib/utils/agentProviderSettings'
import { sameJsonValue } from '$lib/utils/agentBlockFieldSettings'

/**
 * BL-514, the Agent Settings half: what the Primary Agent basic form sends when it saves.
 *
 * Agent Settings keeps a copy of the agent from when it opened. Other places change the same
 * record while that copy is on screen: the chat-bar model picker, the chat-bar Work mode and
 * Codex/Claude mode, the Goon dock. A save that sent the whole copy took those changes back with
 * no word (a Plan-mode agent got write access again, a model picked in the chat bar went back to
 * the old one). So a save sends only what differs from the copy the form loaded or last saved,
 * the same rule Artifact Settings follows since BL-546.
 *
 * `provider_specific_settings` holds two kinds of keys (`isAgentRuntimeSettingKey`): the picked
 * preset's MODEL keys and the agent's OWN keys (`nativeTools` with the Work mode and the Bash
 * never-allow list, `codex_*`, `claude_*`, ...). The agent PUT (`buildAgentProviderSettingsPatch`)
 * writes an own key only when the block names it, `null` removing it, and `nativeTools` field by
 * field (BL-841); a block that names only own keys leaves the stored model keys alone, and any
 * other block replaces them with the ones it names (BL-833). So the block this sends carries the
 * model keys only with a model choice, only the own keys the user changed (a removed one as
 * `null`), and of `nativeTools` only the fields the user changed (a removed field as `null`).
 * Before, a never-allow list edit sent the form's whole `nativeTools` and its model keys, which
 * took back a Work mode or a model chosen in the chat bar of another window after Settings opened.
 */

type Fields = Record<string, unknown>

function isPlainObject(value: unknown): value is Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

// `sameJsonValue` (deep equality over JSON values) lives with the block diff, which needs it too;
// it is re-exported here for this file's own callers.
export { sameJsonValue }

/** "No value" either way: the form builds `null` where an older copy may hold `undefined`. */
function sameFieldValue(left: unknown, right: unknown): boolean {
  return sameJsonValue(left ?? null, right ?? null)
}

/** The model choice: the chat-bar model picker writes these too, so they travel as one. */
export const AGENT_MODEL_FIELDS: readonly string[] = [
  'primary_model_preset_id',
  'primary_model_connection',
  'primary_model_provider',
  'primary_model_name',
  'primary_model_temperature',
  'primary_model_max_tokens',
  'primary_model_top_p',
  'primary_model_top_k',
  'primary_model_frequency_penalty',
  'primary_model_presence_penalty',
  'primary_model_seed',
  'primary_model_stop_sequences',
  'primary_model_reasoning_effort',
  'primary_model_capabilities'
]

/**
 * The memory settings, saved as one group. The agent itself writes some of them too (App Actions,
 * `conditionalAgentSettings.ts`), so a save that names any of them says which saved values it
 * started from (`expectedMemory`, BL-1294) and `PUT /api/agents/[id]` refuses it when they changed.
 */
export const AGENT_MEMORY_GROUP: readonly string[] = [
  'memory_enabled',
  'memory_linger_turns',
  'memory_recall_linger_turns',
  'memory_lane_budgets',
  'memory_window'
]

/**
 * Every stored name of the memory settings: the group above and the older camelCase names the
 * resolvers still read (`memoryControl.ts`). The agent PUT's memory guard reads these, and a tab
 * that hears the agent changed its memory settings takes these from the record it reads again.
 */
export const AGENT_MEMORY_STORED_FIELDS: readonly string[] = [
  ...AGENT_MEMORY_GROUP,
  'memoryEnabled',
  'memoryLingerTurns',
  'memoryRecallLingerTurns',
  'memoryLaneBudgets',
  'memoryWindow'
]

/**
 * Fields that describe one choice, sent together when any of them changed, so a save never
 * mixes the user's new value of one with another place's newer value of its partner (preset C's
 * name beside preset B's provider). Every other field is its own group.
 */
export const AGENT_SAVE_FIELD_GROUPS: readonly (readonly string[])[] = [
  AGENT_MODEL_FIELDS,
  ['show_reasoning', 'preserve_reasoning'],
  AGENT_MEMORY_GROUP,
  ['dm_senders', 'dm_sender_agent_ids'],
  ['wake_enabled', 'wake_timeout_minutes', 'wake_target'],
  ['webhook_url', 'webhookUrl'],
  ['avatar_url', 'avatar', 'avatar_icon_ref', 'avatar_icon_fit']
]

const PROVIDER_SETTINGS = 'provider_specific_settings'

/** A block's model keys that hold a value (the agent PUT stores a `null` model key as absent). */
function modelKeysOf(block: Fields): Fields {
  return Object.fromEntries(
    Object.entries(block).filter(([key, value]) => !isAgentRuntimeSettingKey(key) && value !== null && value !== undefined)
  )
}

/**
 * Review fix: the command location travels with the Work mode. The Permissions Mode pick sets
 * `executionBackend` beside `bashAccessMode` (`getBashBackendForPermissionMode`: the Mac for
 * Batshit Crazy, a sandbox otherwise), and a value equal to the copy is still sent: the record
 * may hold another window's Full access on the Mac (`local`) since this copy was taken, and a Plan
 * pick that left it there ran commands on the Mac while Settings showed the sandbox. At worst this
 * swaps one sandbox for another. The pick's other fields need no forcing: every reader takes
 * `bashAccessMode` before the legacy `bashPolicyMode`, and `bashAgentApprovalCardsEnabled` counts
 * only in Agent mode, where the pick does not set it.
 */
const WORK_MODE_FIELD = 'bashAccessMode'
const WORK_MODE_LOCATION_FIELD = 'executionBackend'

/**
 * BL-841: the fields of `nativeTools` that differ between two copies of a block, a removed one as
 * `null`, or `undefined` when none differ. A copy with no `nativeTools` counts as an empty one. A
 * changed Work mode brings its command location, changed or not (the review fix above).
 */
export function nativeToolsFieldChanges(baseBlock: Fields, nextBlock: Fields): Fields | undefined {
  const base = nativeToolsOf(baseBlock)
  const next = nativeToolsOf(nextBlock)
  const changes: Fields = {}
  for (const field of new Set([...Object.keys(base), ...Object.keys(next)])) {
    if (sameFieldValue(base[field], next[field])) continue
    changes[field] = next[field] ?? null
  }
  if (WORK_MODE_FIELD in changes) changes[WORK_MODE_LOCATION_FIELD] = next[WORK_MODE_LOCATION_FIELD] ?? null
  return Object.keys(changes).length > 0 ? changes : undefined
}

/**
 * The keys of a `provider_specific_settings` copy that differ from another (`baseBlock`, the copy
 * the form loaded or last saved, and `nextBlock`, the form now), for a writer that merges the block
 * key by key: a changed key with its new value, a removed key as `null`, `nativeTools` field by field
 * (`nativeToolsFieldChanges`). `includeKey` picks the keys compared; a key it leaves out is never
 * named. The agent form compares only the agent's OWN keys this way (its model keys travel with a
 * model choice, BL-514); the Subagent form compares every key (BL-914: the Subagent PUT merges the
 * block key by key and no model key rides with a choice).
 */
export function providerSettingsKeyChanges(
  baseBlock: Fields,
  nextBlock: Fields,
  includeKey: (key: string) => boolean
): Fields {
  const changes: Fields = {}
  for (const key of new Set([...Object.keys(baseBlock), ...Object.keys(nextBlock)])) {
    if (!includeKey(key)) continue
    if (key === NATIVE_TOOLS_SETTING_KEY) {
      const fieldChanges = nativeToolsFieldChanges(baseBlock, nextBlock)
      if (fieldChanges) changes[key] = fieldChanges
      continue
    }
    if (sameFieldValue(baseBlock[key], nextBlock[key])) continue
    changes[key] = nextBlock[key] ?? null
  }
  return changes
}

/**
 * The save for `next`, a full basic payload, against `baseline`, the full payload built from the
 * copy the form loaded or last saved. An empty object means nothing to save.
 *
 * - A field (or its group) is sent only when it differs.
 * - `provider_specific_settings` is sent when the model choice is sent or an own key changed. With
 *   the model choice it carries the form's model keys and a `null` for each model key the copy had
 *   and the form no longer has (so the block names a model key whenever there was or is one, and
 *   the PUT replaces the stored model keys even beside an own-key change). Without it, no model
 *   key: the stored ones stay (BL-833). Plus each own key whose value differs, `null` for one the
 *   form removed; of `nativeTools`, only the fields that differ, `null` for a removed field
 *   (BL-841). An own key or field the user did not touch is left out, so the stored value stays,
 *   a newer chat-bar Work mode included.
 */
export function buildAgentSettingsSavePatch(baseline: Fields, next: Fields): Fields {
  const baseBlock = isPlainObject(baseline[PROVIDER_SETTINGS]) ? (baseline[PROVIDER_SETTINGS] as Fields) : {}
  const nextBlock = isPlainObject(next[PROVIDER_SETTINGS]) ? (next[PROVIDER_SETTINGS] as Fields) : {}
  const baseModelKeys = modelKeysOf(baseBlock)
  const nextModelKeys = modelKeysOf(nextBlock)
  const modelKeysChanged = !sameJsonValue(baseModelKeys, nextModelKeys)

  const ownKeyChanges = providerSettingsKeyChanges(baseBlock, nextBlock, isAgentRuntimeSettingKey)

  const grouped = new Set(AGENT_SAVE_FIELD_GROUPS.flat())
  const groups: (readonly string[])[] = [
    ...AGENT_SAVE_FIELD_GROUPS,
    ...Object.keys(next)
      .filter((key) => key !== PROVIDER_SETTINGS && !grouped.has(key))
      .map((key) => [key])
  ]

  const patch: Fields = {}
  for (const group of groups) {
    const changed =
      group.some((key) => !sameFieldValue(baseline[key], next[key])) ||
      (group === AGENT_MODEL_FIELDS && modelKeysChanged)
    if (!changed) continue
    for (const key of group) {
      if (key in next) patch[key] = next[key]
    }
  }

  const modelChoiceSent = AGENT_MODEL_FIELDS.some((key) => key in patch)
  if (modelChoiceSent) {
    const droppedModelKeys = Object.keys(baseModelKeys).filter((key) => !(key in nextModelKeys))
    patch[PROVIDER_SETTINGS] = {
      ...Object.fromEntries(droppedModelKeys.map((key) => [key, null])),
      ...nextModelKeys,
      ...ownKeyChanges
    }
  } else if (Object.keys(ownKeyChanges).length > 0) {
    patch[PROVIDER_SETTINGS] = ownKeyChanges
  }
  return patch
}
