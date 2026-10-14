import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import {
  applyAgentProviderSettingsUpdate,
  buildAgentProviderSettingsPatch,
  chatBarWorkModeSave,
  presetModelSettings
} from './agentProviderSettings'

/**
 * BL-514: a save keeps the agent's own keys in `provider_specific_settings` (the Work mode, the
 * Bash never-allow list, `codex_*`, `claude_*`, ...) unless it names them; the model keys it sends
 * replace the old model keys.
 */

const WORK_MODE = { bashAccessMode: 'plan', bashNeverAllowList: ['rm -rf *'], executionBackend: 'apple_container', webSearchProvider: 'exa' }
const STORED = { temperature: 1.2, customKnob: 5, nativeTools: WORK_MODE, codex_permission_mode: 'chat' }

describe('buildAgentProviderSettingsPatch', () => {
  it('a model pick replaces the model keys and keeps the agent keys', () => {
    expect(buildAgentProviderSettingsPatch(STORED, { temperature: 0.7 })).toEqual({ temperature: 0.7, customKnob: null })
    expect(applyAgentProviderSettingsUpdate(STORED, { temperature: 0.7 })).toEqual({
      temperature: 0.7,
      nativeTools: WORK_MODE,
      codex_permission_mode: 'chat'
    })
  })

  it('a block sent as null removes the model keys and keeps the agent keys', () => {
    expect(applyAgentProviderSettingsUpdate(STORED, null)).toEqual({ nativeTools: WORK_MODE, codex_permission_mode: 'chat' })
  })

  it('an agent key is written when the body names it, and removed when it names it null', () => {
    const plan = { ...WORK_MODE, bashAccessMode: 'agent' }
    expect(applyAgentProviderSettingsUpdate(STORED, { ...STORED, nativeTools: plan })).toEqual({ ...STORED, nativeTools: plan })
    expect(applyAgentProviderSettingsUpdate(STORED, { temperature: 1.2, customKnob: 5, nativeTools: null })).toEqual({
      temperature: 1.2,
      customKnob: 5,
      codex_permission_mode: 'chat'
    })
  })

  it('no block sent: nothing to write', () => {
    expect(buildAgentProviderSettingsPatch(STORED, undefined)).toBeUndefined()
    expect(applyAgentProviderSettingsUpdate(STORED, undefined)).toEqual(STORED)
  })

  it('refuses a block that is not an object', () => {
    expect(() => buildAgentProviderSettingsPatch(STORED, 'temperature=1')).toThrow('must be an object or null')
  })
})

/**
 * BL-833: a block that names only the agent's own keys (a chat-bar mode, Work mode or reasoning
 * control) leaves the stored model keys alone, so those controls can send only their own key.
 * Any other block (null, an empty one for a preset with no settings, or one that names a model
 * key, even as null) still replaces the model keys.
 */
describe('a block that names only own keys leaves the model keys alone (BL-833)', () => {
  it('writes only the named own key', () => {
    expect(buildAgentProviderSettingsPatch(STORED, { codex_permission_mode: 'agent' })).toEqual({ codex_permission_mode: 'agent' })
    expect(applyAgentProviderSettingsUpdate(STORED, { codex_reasoning_effort: null, claude_permission_mode: 'plan' })).toEqual({
      ...STORED,
      claude_permission_mode: 'plan'
    })
  })

  it('an empty block (a preset with no settings) still removes the model keys', () => {
    expect(buildAgentProviderSettingsPatch(STORED, {})).toEqual({ temperature: null, customKnob: null })
    expect(applyAgentProviderSettingsUpdate(STORED, {})).toEqual({ nativeTools: WORK_MODE, codex_permission_mode: 'chat' })
  })

  it('a block that names a model key, even as null, replaces the model keys beside an own key', () => {
    expect(buildAgentProviderSettingsPatch(STORED, { temperature: null, codex_permission_mode: 'agent' })).toEqual({
      temperature: null,
      customKnob: null,
      codex_permission_mode: 'agent'
    })
  })

  it('a key whose value is undefined (JSON drops it) names nothing', () => {
    expect(buildAgentProviderSettingsPatch(STORED, { temperature: undefined, codex_permission_mode: 'agent' })).toEqual({
      temperature: undefined,
      codex_permission_mode: 'agent'
    })
  })
})

/**
 * BL-841: `nativeTools` holds the Work mode, the never-allow list, the command location and the
 * web search choice together. The server writes it field by field (a named field is written, a
 * field named null is removed, a field not named stays), and a copy in the browser takes a save
 * the same way, so a save of one field never carries an older copy of the others.
 */
describe('nativeTools is laid over field by field (BL-841)', () => {
  it('a never-allow list edit keeps the Work mode, and a field named null is removed', () => {
    expect(
      applyAgentProviderSettingsUpdate(STORED, { nativeTools: { bashNeverAllowList: ['git push --force'], webSearchProvider: null } })
    ).toEqual({
      ...STORED,
      nativeTools: { bashAccessMode: 'plan', bashNeverAllowList: ['git push --force'], executionBackend: 'apple_container' }
    })
  })

  it('a copy with no nativeTools, or one that is not an object, gets one', () => {
    expect(applyAgentProviderSettingsUpdate({ temperature: 1 }, { nativeTools: { bashAccessMode: 'agent' } })).toEqual({
      temperature: 1,
      nativeTools: { bashAccessMode: 'agent' }
    })
    expect(applyAgentProviderSettingsUpdate({ nativeTools: 'odd' }, { nativeTools: { bashAccessMode: 'agent' } })).toEqual({
      nativeTools: { bashAccessMode: 'agent' }
    })
  })

  it('nativeTools named null removes the whole block', () => {
    expect(applyAgentProviderSettingsUpdate(STORED, { nativeTools: null })).toEqual({ ...STORED, nativeTools: undefined })
  })

  it('does not change the copy it was given', () => {
    const copy = structuredClone(STORED)
    applyAgentProviderSettingsUpdate(copy, { nativeTools: { bashAccessMode: 'agent' } })
    expect(copy).toEqual(STORED)
  })
})

/**
 * BL-833: the chat bar's Work mode control sends only the nativeTools fields its pick sets: the
 * mode the user chose, ALWAYS with its command location (review fix: the mode and the location
 * are one choice, because the copy can be older than the record), and a null for the legacy
 * `bashPolicyMode` alias it retires. Never the never-allow list or the web search choice.
 */
describe('chatBarWorkModeSave (BL-833)', () => {
  it('Plan from Full access: the mode, and the command location moves off the Mac', () => {
    expect(chatBarWorkModeSave({ nativeTools: { bashAccessMode: 'dangerous', executionBackend: 'local', bashNeverAllowList: ['x'] } }, 'plan')).toEqual({
      nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container' }
    })
  })

  it('Plan with a sandbox already in the copy: the mode AND that sandbox (review fix)', () => {
    // The record may hold Full access on the Mac (`local`), chosen in another window since this
    // copy was taken; sending the mode alone stored Plan with `local`: commands on the Mac while
    // the chat bar shows the sandbox.
    expect(chatBarWorkModeSave({ temperature: 1, nativeTools: { ...WORK_MODE, executionBackend: 'docker', bashAccessMode: 'agent' } }, 'plan')).toEqual({
      nativeTools: { bashAccessMode: 'plan', executionBackend: 'docker' }
    })
  })

  it('Full access from a copy that already shows the Mac still names the Mac', () => {
    expect(chatBarWorkModeSave({ nativeTools: { bashAccessMode: 'dangerous', executionBackend: 'local' } }, 'dangerous')).toEqual({
      nativeTools: { bashAccessMode: 'dangerous', executionBackend: 'local' }
    })
  })

  it('Full access runs on the Mac itself; a legacy bashPolicyMode is removed', () => {
    expect(chatBarWorkModeSave({ nativeTools: { bashPolicyMode: 'plan', executionBackend: 'docker' } }, 'dangerous')).toEqual({
      nativeTools: { bashAccessMode: 'dangerous', executionBackend: 'local', bashPolicyMode: null }
    })
  })

  it('no settings yet: the mode and the default sandbox', () => {
    expect(chatBarWorkModeSave(null, 'agent')).toEqual({ nativeTools: { bashAccessMode: 'agent', executionBackend: 'apple_container' } })
  })

  it('the mode already shown is sent anyway, with its location (the copy may be older than the record)', () => {
    expect(chatBarWorkModeSave({ nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container' } }, 'plan')).toEqual({
      nativeTools: { bashAccessMode: 'plan', executionBackend: 'apple_container' }
    })
  })
})

describe('presetModelSettings', () => {
  it('drops the agent keys a preset may carry (a Codex preset carries codex_* keys) and keeps a real 0', () => {
    expect(presetModelSettings({ temperature: 0, reasoningEffort: 'low', codex_permission_mode: 'agent', nativeTools: {} })).toEqual({
      temperature: 0,
      reasoningEffort: 'low'
    })
    expect(presetModelSettings(undefined)).toEqual({})
  })
})

describe('the chat-bar controls send only their own key (BL-514, BL-833; pinned from the line start)', () => {
  const selector = readFileSync('src/lib/components/models/CodexReasoningEffortSelector.svelte', 'utf8')
  const chatInput = readFileSync('src/lib/components/chat/ChatInput.svelte', 'utf8')

  it('the Codex reasoning selector sends codex_reasoning_effort alone, null for Default', () => {
    expect(selector).toContain(
      "\n      const nextProviderSettings = { codex_reasoning_effort: clamped === 'default' ? null : clamped }\n"
    )
    expect(selector).toContain('\n        provider_specific_settings: nextProviderSettings\n')
    expect(selector).not.toContain('...(currentAgent.provider_specific_settings')
    expect(selector).not.toContain('delete nextProviderSettings.codex_reasoning_effort')
  })

  it('the Codex and Claude mode controls send their permission-mode key alone', () => {
    // BL-941 part C: each save sits inside `trackModeSave(...)`, the send's wait for it.
    expect(chatInput).toContain('\n          provider_specific_settings: { codex_permission_mode: mode }\n')
    expect(chatInput).toContain('\n          provider_specific_settings: { claude_permission_mode: mode }\n')
  })

  it('the Work mode control sends chatBarWorkModeSave, never the copy of the whole block', () => {
    expect(chatInput).toContain(
      '\n        provider_specific_settings: chatBarWorkModeSave(currentAgent.provider_specific_settings, mode)\n'
    )
    expect(chatInput).not.toContain('...(currentAgent.provider_specific_settings ?? {})')
    expect(chatInput).not.toContain('...currentProviderSettings,\n        nativeTools: nextNativeTools')
  })
})
