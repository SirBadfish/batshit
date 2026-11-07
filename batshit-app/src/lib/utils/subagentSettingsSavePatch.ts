import { iconRefKey, type AvatarIconFit, type IconRef } from '$lib/icons/iconTypes'
import type { SubagentRow } from '$lib/types/database'
import type { ModelConnectionInfo } from '$lib/types/savedModels'
import type { AgentDcmDisplaySettingsSave } from '$lib/utils/agentBlockFieldSettings'
import { providerSettingsKeyChanges, sameJsonValue } from '$lib/utils/agentSettingsSavePatch'
import {
  isRetiredSubagentType,
  retiredSubagentTypeSentences,
  type StoredSubagentType,
  type SubagentType
} from '$lib/utils/subagentType'
import { normalizeSubagentTimeoutSeconds } from '$lib/utils/subagentTimeout'
import { normalizeSubagentMaxToolSteps } from '$lib/utils/subagentToolSteps'
import type { InstructionsRevisions } from '$lib/appActions/settings/instructionsBaseline'

/**
 * BL-844: what the Subagent form in Agent Settings sends when it saves, the twin of
 * `agentSettingsSavePatch.ts` (BL-514, the Primary Agent form).
 *
 * Agent Settings keeps a copy of the Subagent from when its form loaded. The record changes under
 * that copy (another tab, a second Settings window, an agent tool), and a save that named every
 * field took those changes back with no word. So a save sends only the fields that differ from
 * the copy the form loaded or last saved. The Subagent PUT writes each field a body names by path
 * (`subagentRecordUpdate.ts`, BL-914), so a field the body does not name keeps its stored value.
 *
 * The route writes `provider_specific_settings` KEY BY KEY, and its `nativeTools` FIELD BY FIELD
 * (BL-914, the agent PUT's rule since BL-514 and BL-841), so this save names only the keys the user
 * changed and, of `nativeTools`, only the fields (`providerSettingsKeyChanges`, the Primary form's
 * own rule). A key the route is not told about stays as stored, so a removed key must be named:
 * - a key or `nativeTools` field the form removed goes as `null`, also when the last one goes (the
 *   route then leaves `nativeTools: {}`, which every reader treats as no settings): `{}` names
 *   nothing and removes nothing, so the emptied block is not sent as `{}`;
 * - a key the form left alone is not named, so another window's change to it survives;
 * - a cleared prompt goes as `''` (BL-482: the route stores it as no prompt), a cleared model as
 *   empty strings and `null`s (BL-266).
 * The Subagent form never copies a preset's model settings into the block (the run reads the live
 * preset, BL-266), so a model pick changes only the model group.
 *
 * SA-139 R5 (D14): the form holds the STORED type, so a leftover of a removed type (a CLI
 * Subagent) is never shown or saved as an API Subagent. Such a leftover is delete-only: the panel
 * refuses every save of it, and `buildSubagentPayload` throws for it (the Primary form's R4 rule).
 */

export interface SubagentSaveForm {
  displayName: string
  subagentType: StoredSubagentType
  /** The stored value, kept as read (`claude-code` is an old record's value; nothing offers it). */
  specialty: 'general' | 'n8n-specialist' | 'claude-code' | 'artifact'
  include_global_prompt: boolean
  system_prompt: string
  primary_model_provider: string
  primary_model_name: string
  // BL-266: the saved preset the model picker chose, and a copy of its connection.
  primary_model_preset_id: string
  primary_model_connection: ModelConnectionInfo | null
  timeout_seconds: string
  /** Delegation limits (2026-10-24): blank = no tool-step limit. */
  max_tool_steps: string
  avatar: string | null
  avatar_icon_ref: IconRef
  avatar_icon_fit: AvatarIconFit
  provider_specific_settings: Record<string, any> | null
}

/**
 * What a Subagent save names. The blocks the route writes key by key (BL-914) are typed as the
 * save names them: a key (or a `dcmDisplaySettings` map entry, or a `nativeTools` field) sent as
 * `null` is removed, one not sent stays (`provider_specific_settings` carries any value in its
 * keys, so it keeps the record's own type). SA-139 R5: no save names `claude_settings` (the CLI
 * Subagent's block); a leftover's stored block stays as it is until the record is deleted.
 */
export type LiveSubagentUpdate = Partial<
  Omit<SubagentRow, 'subagentType' | 'timeout_seconds' | 'max_tool_steps' | 'claude_settings' | 'dcmDisplaySettings'>
> & {
  subagentType?: SubagentType
  timeout_seconds?: number | null
  max_tool_steps?: number | null
  dcmDisplaySettings?: AgentDcmDisplaySettingsSave | null
  expectedModelSelection?: string
  expectedTypedFileTools?: string
  expectedInstructions?: Partial<InstructionsRevisions>
}

/** The form's fields as the save names them. A leftover of a removed type is never saved (D14). */
export function buildSubagentPayload(form: SubagentSaveForm): LiveSubagentUpdate {
  if (isRetiredSubagentType(form.subagentType)) {
    throw new Error(retiredSubagentTypeSentences(form.subagentType, form).details)
  }
  return {
    displayName: form.displayName.trim(),
    subagentType: form.subagentType,
    specialty: form.specialty,
    include_global_prompt: form.include_global_prompt,
    // BL-482: sent even when empty. JSON drops `undefined` and the route keeps a field the body
    // does not name, so a cleared prompt would stay saved; the route stores `''` as no prompt.
    system_prompt: form.system_prompt.trim(),
    // BL-266: sent even when empty. The route keeps a field the body does not name, and JSON
    // drops `undefined`, so a cleared model would stay saved; now clearing the picker clears the
    // model, its preset, and its connection.
    primary_model_provider: form.primary_model_provider,
    primary_model_name: form.primary_model_name,
    primary_model_preset_id: form.primary_model_preset_id || null,
    primary_model_connection: form.primary_model_preset_id ? form.primary_model_connection : null,
    timeout_seconds: normalizeSubagentTimeoutSeconds(form.timeout_seconds) ?? null,
    max_tool_steps: normalizeSubagentMaxToolSteps(form.max_tool_steps) ?? null,
    avatar: form.avatar ?? null,
    avatar_icon_ref: form.avatar_icon_ref,
    avatar_icon_fit: form.avatar_icon_fit,
    // The form's whole block, `{}` when it has none: `diffSubagentPayload` names only its changed
    // keys (BL-914); the whole block is never sent.
    provider_specific_settings: form.provider_specific_settings ?? {}
  }
}

/**
 * Trigger for the autosave: the form's fields, trimmed the way the save trims them. A change to
 * a field missing here is never saved, so every field of `SubagentSaveForm` is named (a test
 * changes each one and checks this signature moves).
 */
export function makeSubagentFormSignature(form: SubagentSaveForm): string {
  return JSON.stringify({
    displayName: form.displayName.trim(),
    subagentType: form.subagentType,
    specialty: form.specialty,
    include_global_prompt: form.include_global_prompt,
    system_prompt: form.system_prompt.trim(),
    primary_model_provider: form.primary_model_provider,
    primary_model_name: form.primary_model_name,
    primary_model_preset_id: form.primary_model_preset_id,
    primary_model_connection: form.primary_model_connection ?? null,
    // The Call Timeout is a number input: `bind:value` gives a number (or `null` when emptied), not
    // the string the form type says, and `.trim()` on that threw in the autosave effect.
    timeout_seconds: String(form.timeout_seconds ?? '').trim(),
    // Same number-input shape as the Call Timeout.
    max_tool_steps: String(form.max_tool_steps ?? '').trim(),
    avatar: form.avatar ?? '',
    avatar_icon_ref: iconRefKey(form.avatar_icon_ref),
    avatar_icon_fit: form.avatar_icon_fit,
    provider_specific_settings: form.provider_specific_settings ?? null
  })
}

/**
 * Fields that describe one choice, sent together when any of them changed, so a save never mixes
 * the user's new value of one with a stale value of its partner (a new preset beside the old
 * preset's connection). Every other field is its own group.
 */
export const SUBAGENT_SAVE_FIELD_GROUPS: readonly (readonly string[])[] = [
  ['primary_model_provider', 'primary_model_name', 'primary_model_preset_id', 'primary_model_connection'],
  ['avatar', 'avatar_icon_ref', 'avatar_icon_fit']
]

type Fields = Record<string, unknown>

/** "No value" either way: a field the payload leaves `undefined` and one it holds `null` are the same. */
function sameField(left: unknown, right: unknown): boolean {
  return sameJsonValue(left ?? null, right ?? null)
}

const PROVIDER_SETTINGS = 'provider_specific_settings'

function asFields(value: unknown): Fields {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Fields) : {}
}

/**
 * The fields of `next`, a payload from `buildSubagentPayload`, that differ from `baseline`, the
 * payload of the copy the form loaded or last saved. An empty object means nothing to save. A
 * group (`SUBAGENT_SAVE_FIELD_GROUPS`) goes whole when any of its fields differs.
 * `provider_specific_settings` goes key by key (BL-914): the keys that differ, a removed key as
 * `null`, of `nativeTools` the fields that differ (`providerSettingsKeyChanges`); it is not named
 * when no key differs.
 */
export function diffSubagentPayload(baseline: Fields, next: Fields): Fields {
  const grouped = new Set(SUBAGENT_SAVE_FIELD_GROUPS.flat())
  const groups: (readonly string[])[] = [
    ...SUBAGENT_SAVE_FIELD_GROUPS,
    ...Object.keys(next)
      .filter((key) => key !== PROVIDER_SETTINGS && !grouped.has(key))
      .map((key) => [key])
  ]
  const patch: Fields = {}
  for (const group of groups) {
    const changed = group.some((key) => !sameField(baseline[key], next[key]))
    if (!changed) continue
    for (const key of group) {
      if (key in next && next[key] !== undefined) patch[key] = next[key]
    }
  }
  if (PROVIDER_SETTINGS in next) {
    const keyChanges = providerSettingsKeyChanges(
      asFields(baseline[PROVIDER_SETTINGS]),
      asFields(next[PROVIDER_SETTINGS]),
      () => true
    )
    if (Object.keys(keyChanges).length > 0) patch[PROVIDER_SETTINGS] = keyChanges
  }
  return patch
}

/** The save for `form` against `baseline`, the form as it loaded or was last saved. */
export function buildSubagentSettingsSavePatch(baseline: SubagentSaveForm, form: SubagentSaveForm): LiveSubagentUpdate {
  return diffSubagentPayload(
    buildSubagentPayload(baseline) as Fields,
    buildSubagentPayload(form) as Fields
  ) as LiveSubagentUpdate
}
