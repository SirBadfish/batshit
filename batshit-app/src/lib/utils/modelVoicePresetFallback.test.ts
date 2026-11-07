import { describe, expect, it } from 'vitest'
import { findSettingsVoicePresetFallback, findChatVoicePresetFallback } from './modelVoiceSession'
import type { SavedModel } from '$lib/types/savedModels'
const model = (id: string, connection: SavedModel['connection'], extra: Partial<SavedModel> = {}) => ({ id, modelName: id, provider: 'openai', modelId: 'gpt-realtime-2', connection, ...extra }) as SavedModel
describe('existing Voice preset fallback extraction equivalence', () => {
  it('keeps original order and the two consumers different connection rules', () => {
    const gateway = model('gateway', { type: 'vercel-gateway', service: 'vercel' }), direct = model('direct', { type: 'direct', service: 'openai' }), models = [gateway, direct]
    const selected = { primary_model_provider: 'openai', primary_model_name: 'gpt-realtime-2', primary_model_connection: { type: 'direct' as const, service: 'openai' } }
    expect(findSettingsVoicePresetFallback(models, selected)).toBe(direct)
    expect(findChatVoicePresetFallback(models, selected)).toBe(gateway)
    expect(findSettingsVoicePresetFallback([direct, gateway], { ...selected, primary_model_connection: null })).toBe(direct)
    expect(findChatVoicePresetFallback([direct, gateway], selected)).toBe(direct)
  })
  it('retains ChatInput prefix parsing and Settings stored effective-ID matching without unifying them', () => {
    const saved = model('saved', { type: 'direct', service: 'openai' }, { effectiveModelId: 'openai/gpt-realtime-2' })
    expect(findChatVoicePresetFallback([saved], { primary_model_provider: '', primary_model_name: 'openai/gpt-realtime-2' })).toBe(saved)
    expect(findSettingsVoicePresetFallback([saved], { primary_model_provider: '', primary_model_name: 'openai/gpt-realtime-2' })).toBeNull()
    expect(findSettingsVoicePresetFallback([saved], { primary_model_provider: 'openai', primary_model_name: 'openai/gpt-realtime-2' })).toBe(saved)
    expect(findChatVoicePresetFallback([saved], { primary_model_provider: 'openai', primary_model_name: ' openai/gpt-realtime-2 ' })).toBe(saved)
  })
  it('keeps absent/no-match optional selections empty', () => {
    const saved = model('saved', { type: 'direct', service: 'openai' })
    expect(findChatVoicePresetFallback([saved], {})).toBeNull()
    expect(findSettingsVoicePresetFallback([saved], {})).toBeNull()
    expect(findChatVoicePresetFallback([saved], { primary_model_provider: 'openai', primary_model_name: 'unmatched' })).toBeNull()
  })
})
