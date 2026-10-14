import { describe, expect, it } from 'vitest'
import { DEFAULT_AGENT_ICON_REF } from '$lib/icons/iconCatalog'
import {
  buildSubagentPayload,
  buildSubagentSettingsSavePatch,
  diffSubagentPayload,
  makeSubagentFormSignature,
  type SubagentSaveForm
} from './subagentSettingsSavePatch'

/**
 * BL-844: what the Subagent form in Agent Settings sends when it saves. The rule is a pure
 * function of two forms, the copy the form loaded or last saved and the form now, so it is tested
 * here without the panel. The panel's own test (`AgentSettingsPanel.subagentSave.test.ts`)
 * renders the real panel against the real route.
 */

const CONNECTION = { type: 'direct', service: 'openai' } as const

/** A Subagent with a value in every field: a workflow-backed one, so the webhook fields count. */
function baseForm(): SubagentSaveForm {
  return {
    displayName: 'Research helper',
    subagentType: 'n8n-workflow',
    specialty: 'general',
    webhook_url: 'https://n8n.example.com/webhook/research',
    include_global_prompt: false,
    system_prompt: 'Answer only in haiku.',
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.5',
    primary_model_preset_id: 'preset_a',
    primary_model_connection: { ...CONNECTION },
    timeout_seconds: '45',
    avatar: null,
    avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
    avatar_icon_fit: 'fill',
    provider_specific_settings: { temperature: 0.7, nativeTools: { webSearchEnabled: false } }
  }
}

const patchOf = (change: Partial<SubagentSaveForm>, from: SubagentSaveForm = baseForm()) =>
  buildSubagentSettingsSavePatch(from, { ...from, ...change })

describe('what a Subagent save sends (BL-844)', () => {
  it('sends nothing when nothing changed', () => {
    expect(buildSubagentSettingsSavePatch(baseForm(), baseForm())).toEqual({})
  })

  it('sends only the field that changed', () => {
    expect(patchOf({ displayName: 'Research helper 2' })).toEqual({ displayName: 'Research helper 2' })
    expect(patchOf({ include_global_prompt: true })).toEqual({ include_global_prompt: true })
    expect(patchOf({ specialty: 'artifact' })).toEqual({ specialty: 'artifact' })
    expect(patchOf({ timeout_seconds: '90' })).toEqual({ timeout_seconds: 90 })
    expect(patchOf({ system_prompt: 'Answer in limericks.' })).toEqual({ system_prompt: 'Answer in limericks.' })
  })

  it('names a cleared prompt as an empty string, so the route stores no prompt (BL-482)', () => {
    expect(patchOf({ system_prompt: '' })).toEqual({ system_prompt: '' })
    expect(patchOf({ system_prompt: '   ' })).toEqual({ system_prompt: '' })
    // Already empty and still empty: nothing to say.
    expect(patchOf({ system_prompt: '' }, { ...baseForm(), system_prompt: '' })).toEqual({})
  })

  it('names a cleared Call Timeout as null', () => {
    expect(patchOf({ timeout_seconds: '' })).toEqual({ timeout_seconds: null })
  })

  it('reads the Call Timeout a number input gives as the same value as the string it loaded', () => {
    // `bind:value` on the number input gives a number, or null once emptied (not a string).
    const asNumber = { ...baseForm(), timeout_seconds: 45 as unknown as string }
    expect(buildSubagentSettingsSavePatch(baseForm(), asNumber)).toEqual({})
    expect(makeSubagentFormSignature(asNumber)).toBe(makeSubagentFormSignature(baseForm()))
    expect(patchOf({ timeout_seconds: 60 as unknown as string })).toEqual({ timeout_seconds: 60 })
    expect(patchOf({ timeout_seconds: null as unknown as string })).toEqual({ timeout_seconds: null })
    expect(() => makeSubagentFormSignature({ ...baseForm(), timeout_seconds: null as unknown as string })).not.toThrow()
  })

  it('sends the model choice whole when any of it changed, and nothing else', () => {
    expect(
      patchOf({
        primary_model_preset_id: 'preset_b',
        primary_model_provider: 'anthropic',
        primary_model_name: 'claude-x',
        primary_model_connection: { type: 'direct', service: 'anthropic' }
      })
    ).toEqual({
      primary_model_preset_id: 'preset_b',
      primary_model_provider: 'anthropic',
      primary_model_name: 'claude-x',
      primary_model_connection: { type: 'direct', service: 'anthropic' }
    })
    // One field of the choice differs: the whole choice goes, never a new name beside an old connection.
    expect(patchOf({ primary_model_name: 'gpt-5.5-mini' })).toEqual({
      primary_model_preset_id: 'preset_a',
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5.5-mini',
      primary_model_connection: CONNECTION
    })
  })

  it('names a cleared model as empty strings and nulls (BL-266)', () => {
    expect(
      patchOf({
        primary_model_preset_id: '',
        primary_model_provider: '',
        primary_model_name: '',
        primary_model_connection: null
      })
    ).toEqual({
      primary_model_preset_id: null,
      primary_model_provider: '',
      primary_model_name: '',
      primary_model_connection: null
    })
  })

  it('leaves the model out of a save that did not touch it, also when its saved preset cannot be selected (BL-834)', () => {
    // The panel keeps the loaded model in the form when the picker cannot show it, so an edit of
    // another field finds the model equal to the copy and names no model key.
    const patch = patchOf({ displayName: 'Renamed' })
    for (const key of ['primary_model_preset_id', 'primary_model_provider', 'primary_model_name', 'primary_model_connection']) {
      expect(patch).not.toHaveProperty(key)
    }
  })

  it('sends the workflow URL with the type when either changed', () => {
    expect(patchOf({ webhook_url: 'https://n8n.example.com/webhook/other' })).toEqual({
      subagentType: 'n8n-workflow',
      webhook_url: 'https://n8n.example.com/webhook/other',
      webhookUrl: 'https://n8n.example.com/webhook/other'
    })
  })

  it('sends a workflow URL an API Subagent does not keep as no change at all', () => {
    const api = { ...baseForm(), subagentType: 'api' as const, webhook_url: '' }
    // The form empties a stale URL on open: its signature moves, the payload does not.
    const stale = { ...api, webhook_url: 'https://n8n.example.com/webhook/stale' }
    expect(buildSubagentSettingsSavePatch(stale, api)).toEqual({})
    expect(buildSubagentSettingsSavePatch(api, stale)).toEqual({})
  })

  it('sends the avatar fields together', () => {
    expect(patchOf({ avatar_icon_fit: 'contain' })).toEqual({
      avatar: null,
      avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
      avatar_icon_fit: 'contain'
    })
    expect(patchOf({ avatar: 'https://example.com/pic.png' })).toEqual({
      avatar: 'https://example.com/pic.png',
      avatar_icon_ref: DEFAULT_AGENT_ICON_REF,
      avatar_icon_fit: 'fill'
    })
  })

  it('sends provider_specific_settings key by key: only the key that changed, the block\'s other keys are left out (BL-914)', () => {
    expect(patchOf({ provider_specific_settings: { temperature: 0.1, nativeTools: { webSearchEnabled: false } } })).toEqual({
      provider_specific_settings: { temperature: 0.1 }
    })
    // Same content in another key order is no change.
    expect(
      patchOf({ provider_specific_settings: { nativeTools: { webSearchEnabled: false }, temperature: 0.7 } })
    ).toEqual({})
  })

  it('sends nativeTools field by field: only the field that changed (BL-914)', () => {
    expect(
      patchOf({ provider_specific_settings: { temperature: 0.7, nativeTools: { webSearchEnabled: true } } })
    ).toEqual({ provider_specific_settings: { nativeTools: { webSearchEnabled: true } } })
    const from = {
      ...baseForm(),
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *'], webSearchEnabled: false } }
    }
    expect(
      patchOf({ provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'sudo *'], webSearchEnabled: false } } }, from)
    ).toEqual({ provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'sudo *'] } } })
  })

  it('names a removed key and a removed nativeTools field as null (the route writes key by key: a key the form dropped stays until it is named)', () => {
    // A model key the form no longer has, beside a changed one.
    const from = { ...baseForm(), provider_specific_settings: { temperature: 0.7, top_p: 0.9, nativeTools: { webSearchEnabled: false } } }
    expect(patchOf({ provider_specific_settings: { temperature: 0.3, nativeTools: { webSearchEnabled: false } } }, from)).toEqual({
      provider_specific_settings: { temperature: 0.3, top_p: null }
    })
    // The last nativeTools field removed: the field goes as null, the block itself is not named.
    expect(patchOf({ provider_specific_settings: { temperature: 0.7 } })).toEqual({
      provider_specific_settings: { nativeTools: { webSearchEnabled: null } }
    })
  })

  it('names an emptied provider_specific_settings key by key: every removed key and field as null, never {}', () => {
    expect(patchOf({ provider_specific_settings: null })).toEqual({
      provider_specific_settings: { temperature: null, nativeTools: { webSearchEnabled: null } }
    })
    // No block and still none (or an empty one): nothing.
    expect(patchOf({ provider_specific_settings: null }, { ...baseForm(), provider_specific_settings: null })).toEqual({})
    expect(patchOf({ provider_specific_settings: {} }, { ...baseForm(), provider_specific_settings: null })).toEqual({})
  })

  it('names a key and a field the form added, from a Subagent with no block', () => {
    const from = { ...baseForm(), provider_specific_settings: null }
    expect(patchOf({ provider_specific_settings: { codex_model: 'gpt-6-astra', nativeTools: { webSearchEnabled: true } } }, from)).toEqual({
      provider_specific_settings: { codex_model: 'gpt-6-astra', nativeTools: { webSearchEnabled: true } }
    })
  })

  it('a changed Work mode brings its command location, changed or not (the Primary form\'s rule, shared)', () => {
    const from = {
      ...baseForm(),
      provider_specific_settings: { nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container' } }
    }
    expect(
      patchOf({ provider_specific_settings: { nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container' } } }, from)
    ).toEqual({ provider_specific_settings: { nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container' } } })
    // A change of another field leaves both alone.
    expect(
      patchOf(
        { provider_specific_settings: { nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container', webSearchEnabled: true } } },
        from
      )
    ).toEqual({ provider_specific_settings: { nativeTools: { webSearchEnabled: true } } })
  })

  it('counts a missing value and null as the same', () => {
    expect(diffSubagentPayload({ avatar: null, webhook_url: undefined }, { avatar: undefined, webhook_url: null })).toEqual({})
  })

  it('never puts an undefined value in the patch', () => {
    const api = { ...baseForm(), subagentType: 'api' as const, webhook_url: '' }
    const patch = buildSubagentSettingsSavePatch(baseForm(), api)
    expect(Object.values(patch).some((value) => value === undefined)).toBe(false)
    expect(patch).toMatchObject({ subagentType: 'api' })
  })
})

/**
 * The walk: a NEW form field that the save or the autosave trigger does not name silently loses
 * its changes (the Settings Auto-Save Contract). This table has one entry per field of
 * `SubagentSaveForm`: a type error here means a field was added without a change to test.
 */
const CHANGE_ONE_FIELD: { [K in keyof SubagentSaveForm]: (form: SubagentSaveForm) => SubagentSaveForm } = {
  displayName: (form) => ({ ...form, displayName: `${form.displayName} changed` }),
  subagentType: (form) => ({ ...form, subagentType: 'api' }),
  specialty: (form) => ({ ...form, specialty: 'artifact' }),
  webhook_url: (form) => ({ ...form, webhook_url: 'https://n8n.example.com/webhook/changed' }),
  include_global_prompt: (form) => ({ ...form, include_global_prompt: !form.include_global_prompt }),
  system_prompt: (form) => ({ ...form, system_prompt: 'A changed prompt.' }),
  primary_model_provider: (form) => ({ ...form, primary_model_provider: 'anthropic' }),
  primary_model_name: (form) => ({ ...form, primary_model_name: 'claude-changed' }),
  primary_model_preset_id: (form) => ({ ...form, primary_model_preset_id: 'preset_changed' }),
  primary_model_connection: (form) => ({ ...form, primary_model_connection: { type: 'direct', service: 'anthropic' } }),
  timeout_seconds: (form) => ({ ...form, timeout_seconds: '120' }),
  avatar: (form) => ({ ...form, avatar: 'https://example.com/changed.png' }),
  avatar_icon_ref: (form) => ({ ...form, avatar_icon_ref: { kind: 'batshit', id: 'changed_icon' } as SubagentSaveForm['avatar_icon_ref'] }),
  avatar_icon_fit: (form) => ({ ...form, avatar_icon_fit: 'contain' }),
  provider_specific_settings: (form) => ({ ...form, provider_specific_settings: { temperature: 0.1 } })
}

describe('every field the Subagent save can name is saved when it changes (BL-844)', () => {
  const fields = Object.keys(CHANGE_ONE_FIELD) as (keyof SubagentSaveForm)[]

  it('the table names every field of the form', () => {
    expect(fields.sort()).toEqual(Object.keys(baseForm()).sort())
  })

  for (const field of fields) {
    it(`a change to ${field} is sent and moves the autosave trigger`, () => {
      const changed = CHANGE_ONE_FIELD[field](baseForm())
      expect(buildSubagentSettingsSavePatch(baseForm(), changed)).not.toEqual({})
      expect(makeSubagentFormSignature(changed)).not.toBe(makeSubagentFormSignature(baseForm()))
    })
  }

  it('every field the payload builder names is in some change\'s patch', () => {
    const named = new Set(Object.keys(buildSubagentPayload(baseForm())))
    const sent = new Set<string>()
    for (const field of fields) {
      const patch = buildSubagentSettingsSavePatch(baseForm(), CHANGE_ONE_FIELD[field](baseForm()))
      for (const key of Object.keys(patch)) sent.add(key)
    }
    expect([...named].filter((key) => !sent.has(key))).toEqual([])
  })

  it('refuses a Subagent type that was removed', () => {
    expect(() => buildSubagentPayload({ ...baseForm(), subagentType: 'n8n-subnode' })).toThrow(/removed from Batshit/)
  })
})
