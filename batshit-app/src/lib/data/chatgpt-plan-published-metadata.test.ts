import { expect, it } from 'vitest'
import { chatgptPlanPublishedMetadata, withChatgptPlanPublishedMetadata } from './chatgpt-plan-published-metadata'
import type { SavedModel } from '$lib/types/savedModels'

it('uses exact published slugs and keeps the dated source isolated from account budgets', () => {
  for (const slug of ['gpt-6-astra', 'gpt-5.6-sol', 'gpt-5.6-terra', 'gpt-5.6-luna', 'gpt-5.5']) {
    expect(chatgptPlanPublishedMetadata(slug)).toMatchObject({ modelId: slug, sourceUrl: `https://developers.openai.com/api/docs/models/${slug}`, verifiedAt: '2026-10-01', inputModalities: ['text', 'image'], outputModalities: ['text'] })
  }
  for (const slug of ['GPT-6-astra', 'gpt-6-astra-unknown', 'gpt-6.1-sol', '__proto__']) expect(chatgptPlanPublishedMetadata(slug)).toBeUndefined()
  const metadata = chatgptPlanPublishedMetadata('gpt-6-astra')!
  metadata.inputModalities.splice(1); metadata.contextWindow = 1
  expect(chatgptPlanPublishedMetadata('gpt-6-astra')).toMatchObject({ contextWindow: 1_050_000, inputModalities: ['text', 'image'] })
  const preset = { id: 'saved', modelId: 'gpt-6-astra', contextWindow: 23456, settings: { temperature: 0 }, pricing: {}, capabilities: { vision: false } } as SavedModel
  const projection = withChatgptPlanPublishedMetadata(preset)
  expect(projection).toMatchObject({ id: 'saved', contextWindow: 23456, settings: { temperature: 0 }, pricing: {}, capabilities: { vision: false, image: false } })
  expect(preset.capabilities?.vision).toBe(false)
  expect(withChatgptPlanPublishedMetadata({ ...preset, capabilities: undefined }).capabilities?.vision).toBe(true)
  expect(withChatgptPlanPublishedMetadata({ ...preset, modelId: 'future-model', contextWindow: undefined, capabilities: undefined })).toMatchObject({ capabilities: { image: false } })
  expect(withChatgptPlanPublishedMetadata({ ...preset, modelId: 'future-model', contextWindow: undefined, capabilities: undefined }).capabilities?.vision).toBeUndefined()
})
