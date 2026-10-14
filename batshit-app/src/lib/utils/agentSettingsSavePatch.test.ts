import { describe, expect, it } from 'vitest'
import { AGENT_MODEL_FIELDS, buildAgentSettingsSavePatch, sameJsonValue } from './agentSettingsSavePatch'

/**
 * BL-514: the Agent Settings basic form sends only what differs from the copy it loaded or last
 * saved. BL-833 and BL-841: the provider settings block carries the model keys only with a model
 * choice, and only the own keys the user changed, a removed one as null; `nativeTools` only the
 * fields the user changed, a removed field as null.
 */

const WORK_MODE = { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'] }

function payload(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    displayName: 'Probe',
    agentType: 'api',
    show_reasoning: true,
    preserve_reasoning: false,
    webhook_url: null,
    webhookUrl: null,
    avatar_url: null,
    avatar: null,
    avatar_icon_ref: { kind: 'batshit', id: 'agents' },
    avatar_icon_fit: 'fill',
    goon_id: null,
    primary_model_preset_id: 'preset-a',
    primary_model_connection: { type: 'direct', service: 'openai' },
    primary_model_provider: 'openai',
    primary_model_name: 'gpt-5.5',
    primary_model_temperature: 0.7,
    primary_model_max_tokens: null,
    primary_model_top_p: null,
    primary_model_top_k: null,
    primary_model_frequency_penalty: null,
    primary_model_presence_penalty: null,
    primary_model_seed: null,
    primary_model_stop_sequences: null,
    primary_model_reasoning_effort: null,
    primary_model_capabilities: null,
    provider_specific_settings: { temperature: 0.7, nativeTools: WORK_MODE, codex_permission_mode: 'chat' },
    ...overrides
  }
}

describe('buildAgentSettingsSavePatch', () => {
  it('sends nothing when nothing differs, whatever the key order of the block', () => {
    const base = payload()
    const reordered = payload({
      provider_specific_settings: { codex_permission_mode: 'chat', nativeTools: { bashNeverAllowList: ['rm -rf *'], bashAccessMode: 'plan' }, temperature: 0.7 }
    })
    expect(buildAgentSettingsSavePatch(base, reordered)).toEqual({})
  })

  it('an unrelated edit sends only that field: no model choice, no block', () => {
    expect(buildAgentSettingsSavePatch(payload(), payload({ displayName: 'Renamed', goon_id: undefined }))).toEqual({
      displayName: 'Renamed'
    })
  })

  it('a Work-mode edit sends only the fields the pick sets: no model keys, no other own key (BL-841, BL-833)', () => {
    const next = payload({
      provider_specific_settings: {
        temperature: 0.7,
        nativeTools: { ...WORK_MODE, bashAccessMode: 'agent', executionBackend: 'apple_container' },
        codex_permission_mode: 'chat'
      }
    })
    expect(buildAgentSettingsSavePatch(payload(), next)).toEqual({
      provider_specific_settings: { nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container' } }
    })
  })

  it('a Work-mode edit always sends the command location, even one equal to the copy (review fix)', () => {
    // Another window may have switched the record to Full access on the Mac since this copy was
    // taken; the pick's sandbox must go with the mode, or the record keeps `local` under Plan.
    const base = payload({
      provider_specific_settings: { temperature: 0.7, nativeTools: { ...WORK_MODE, bashAccessMode: 'agent', executionBackend: 'apple_container' } }
    })
    const next = payload({
      provider_specific_settings: {
        temperature: 0.7,
        nativeTools: { ...WORK_MODE, bashAccessMode: 'plan', executionBackend: 'apple_container', bashAgentApprovalCardsEnabled: false }
      }
    })
    expect(buildAgentSettingsSavePatch(base, next)).toEqual({
      provider_specific_settings: {
        nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container', bashAgentApprovalCardsEnabled: false }
      }
    })
    // A form with no location names it null (the record then takes the default sandbox for Plan).
    const noLocation = payload({
      provider_specific_settings: { temperature: 0.7, nativeTools: { ...WORK_MODE, bashAccessMode: 'agent' }, codex_permission_mode: 'chat' }
    })
    expect(buildAgentSettingsSavePatch(payload(), noLocation).provider_specific_settings).toEqual({
      nativeTools: { bashAccessMode: 'agent', executionBackend: null }
    })
  })

  it('an edit that leaves the Work mode alone does not send the command location', () => {
    const base = payload({ provider_specific_settings: { nativeTools: { ...WORK_MODE, executionBackend: 'apple_container' } } })
    const next = payload({ provider_specific_settings: { nativeTools: { ...WORK_MODE, executionBackend: 'apple_container', webSearchProvider: 'exa' } } })
    expect(buildAgentSettingsSavePatch(base, next).provider_specific_settings).toEqual({ nativeTools: { webSearchProvider: 'exa' } })
  })

  it('a never-allow list edit sends only the list, so a Work mode chosen elsewhere stays (BL-841)', () => {
    const next = payload({
      provider_specific_settings: {
        temperature: 0.7,
        nativeTools: { ...WORK_MODE, bashNeverAllowList: ['rm -rf *', 'git push --force'] },
        codex_permission_mode: 'chat'
      }
    })
    expect(buildAgentSettingsSavePatch(payload(), next)).toEqual({
      provider_specific_settings: { nativeTools: { bashNeverAllowList: ['rm -rf *', 'git push --force'] } }
    })
  })

  it('a native-tool field the form removed goes as null, field by field, never the whole block as null (BL-841)', () => {
    expect(
      buildAgentSettingsSavePatch(payload(), payload({ provider_specific_settings: { temperature: 0.7, nativeTools: { bashAccessMode: 'plan' }, codex_permission_mode: 'chat' } }))
    ).toEqual({ provider_specific_settings: { nativeTools: { bashNeverAllowList: null } } })
    // The last native-tool setting cleared (the form drops the empty block): each of its fields is
    // named null, and the removed Work mode takes its command location with it (the defaults are a
    // sandbox), never leaving another window's `local` under the default mode.
    expect(
      buildAgentSettingsSavePatch(payload(), payload({ provider_specific_settings: { temperature: 0.7, codex_permission_mode: 'chat' } }))
    ).toEqual({ provider_specific_settings: { nativeTools: { bashAccessMode: null, bashNeverAllowList: null, executionBackend: null } } })
  })

  it('an own key the form removed goes as null (the server keeps one a save leaves out)', () => {
    expect(
      buildAgentSettingsSavePatch(payload(), payload({ provider_specific_settings: { temperature: 0.7, nativeTools: WORK_MODE } }))
    ).toEqual({ provider_specific_settings: { codex_permission_mode: null } })
    // The whole block emptied: no model keys were there, and each own key is named null.
    expect(buildAgentSettingsSavePatch(payload({ provider_specific_settings: { nativeTools: WORK_MODE } }), payload({ provider_specific_settings: null }))).toEqual({
      provider_specific_settings: { nativeTools: { bashAccessMode: null, bashNeverAllowList: null, executionBackend: null } }
    })
  })

  it('an unchanged nativeTools sends nothing, whatever its key order or a field stored as null', () => {
    const next = payload({
      provider_specific_settings: { temperature: 0.7, nativeTools: { bashNeverAllowList: ['rm -rf *'], bashAccessMode: 'plan', webSearchProvider: null }, codex_permission_mode: 'chat' }
    })
    expect(buildAgentSettingsSavePatch(payload(), next)).toEqual({})
  })

  it('a model pick sends the whole model choice and the new model keys, and leaves untouched own keys out', () => {
    const next = payload({
      primary_model_preset_id: 'preset-c',
      primary_model_name: 'gpt-5.5-mini',
      primary_model_temperature: 1.1,
      provider_specific_settings: { temperature: 1.1, topP: 0.9, nativeTools: WORK_MODE, codex_permission_mode: 'chat' }
    })
    const patch = buildAgentSettingsSavePatch(payload(), next)
    // Preset C shares A's provider and connection: they are sent anyway, as one choice.
    expect(Object.keys(patch).sort()).toEqual([...AGENT_MODEL_FIELDS, 'provider_specific_settings'].sort())
    expect(patch.primary_model_provider).toBe('openai')
    expect(patch.primary_model_connection).toEqual({ type: 'direct', service: 'openai' })
    expect(patch.provider_specific_settings).toEqual({ temperature: 1.1, topP: 0.9 })
  })

  it('a pick whose preset has the same model keys still sends the block, so the choice is whole', () => {
    const next = payload({ primary_model_preset_id: 'preset-a2' })
    expect(buildAgentSettingsSavePatch(payload(), next).provider_specific_settings).toEqual({ temperature: 0.7 })
  })

  it('a model key change alone counts as a model choice', () => {
    const next = payload({ provider_specific_settings: { temperature: 0.9, nativeTools: WORK_MODE, codex_permission_mode: 'chat' } })
    const patch = buildAgentSettingsSavePatch(payload(), next)
    expect(patch.primary_model_preset_id).toBe('preset-a')
    expect(patch.provider_specific_settings).toEqual({ temperature: 0.9 })
  })

  it('a pick of a preset with no model keys names each old model key null, beside an own-key change too (BL-833)', () => {
    // A block that names only own keys leaves the stored model keys alone, so the old ones are named.
    const next = payload({
      primary_model_preset_id: 'preset-empty',
      primary_model_temperature: null,
      provider_specific_settings: { nativeTools: { ...WORK_MODE, bashNeverAllowList: [] }, codex_permission_mode: 'chat' }
    })
    const patch = buildAgentSettingsSavePatch(payload(), next)
    expect(patch.primary_model_preset_id).toBe('preset-empty')
    expect(patch.provider_specific_settings).toEqual({ temperature: null, nativeTools: { bashNeverAllowList: [] } })

    const clearOnly = payload({ primary_model_preset_id: null, primary_model_temperature: null, provider_specific_settings: { nativeTools: WORK_MODE, codex_permission_mode: 'chat' } })
    expect(buildAgentSettingsSavePatch(payload(), clearOnly).provider_specific_settings).toEqual({ temperature: null })
  })

  it('a pick that drops one model key and keeps another names the dropped one null', () => {
    const base = payload({ provider_specific_settings: { temperature: 0.7, topK: 40, nativeTools: WORK_MODE } })
    const next = payload({ primary_model_preset_id: 'preset-d', provider_specific_settings: { temperature: 0.3, nativeTools: WORK_MODE } })
    expect(buildAgentSettingsSavePatch(base, next).provider_specific_settings).toEqual({ temperature: 0.3, topK: null })
  })

  it('a null model key counts as absent (the PUT stores it as absent)', () => {
    const next = payload({ provider_specific_settings: { temperature: 0.7, topK: null, nativeTools: WORK_MODE, codex_permission_mode: 'chat' } })
    expect(buildAgentSettingsSavePatch(payload(), next)).toEqual({})
  })

  it('sends a group whole when one of its fields changed', () => {
    expect(buildAgentSettingsSavePatch(payload(), payload({ webhook_url: 'https://x', webhookUrl: 'https://x' }))).toEqual({
      webhook_url: 'https://x',
      webhookUrl: 'https://x'
    })
    expect(buildAgentSettingsSavePatch(payload(), payload({ avatar_url: '/a.png', avatar: '/a.png' }))).toEqual({
      avatar_url: '/a.png',
      avatar: '/a.png',
      avatar_icon_ref: { kind: 'batshit', id: 'agents' },
      avatar_icon_fit: 'fill'
    })
    expect(buildAgentSettingsSavePatch(payload(), payload({ show_reasoning: false }))).toEqual({
      show_reasoning: false,
      preserve_reasoning: false
    })
  })

  it('a field the builder adds later is compared on its own', () => {
    expect(buildAgentSettingsSavePatch(payload({ brand_new_field: 1 }), payload({ brand_new_field: 2 }))).toEqual({ brand_new_field: 2 })
  })
})

describe('sameJsonValue', () => {
  it('ignores key order and undefined keys, and tells arrays and values apart', () => {
    expect(sameJsonValue({ a: 1, b: [1, { c: 2 }] }, { b: [1, { c: 2 }], a: 1, d: undefined })).toBe(true)
    expect(sameJsonValue([1, 2], [2, 1])).toBe(false)
    expect(sameJsonValue({ a: 1 }, { a: 1, b: null })).toBe(false)
    expect(sameJsonValue(0, null)).toBe(false)
    expect(sameJsonValue({}, [])).toBe(false)
  })
})
