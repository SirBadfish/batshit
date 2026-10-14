/**
 * Plan pause (Plans/2026-09-27-provider-plan-approval.md, sections 3 and 3a).
 * A paused plan is switched off, not deleted; the server decides; the Dev
 * switch defaults off and counts only where the Dev panel exists.
 */
import { beforeEach, describe, expect, it, vi } from 'vitest'

const store = vi.hoisted(() => new Map<string, unknown>())
const testEnv = vi.hoisted(() => ({}) as Record<string, string | undefined>)

vi.mock('$env/dynamic/private', () => ({ env: testEnv }))
vi.mock('@ai-sdk/openai', () => ({
  createOpenAI: vi.fn(() => {
    const client = (modelId: string) => ({ modelId, mode: 'responses' })
    client.chat = (modelId: string) => ({ modelId, mode: 'chat' })
    return client
  })
}))
vi.mock('$lib/server/redis', () => ({
  redis: {
    json: {
      get: vi.fn(async (key: string) => store.get(key) ?? null),
      set: vi.fn(async (key: string, _path: string, value: unknown) => {
        store.set(key, value)
      })
    },
    del: vi.fn(async (key: string) => {
      store.delete(key)
    })
  }
}))

import { PAUSED_PLANS, findPausedPlan, pausedPlanSentence } from '$lib/data/pausedPlans'
import {
  PAUSED_PLANS_DEV_SWITCH_KEY,
  PausedPlanError,
  pausedPlansAllowedOnThisCopy,
  readPausedPlansDevSwitch,
  writePausedPlansDevSwitch
} from '../pausedPlans'
import { ProviderManager } from '../providers/index'

const ZAI_SENTENCE =
  'Z.ai Coding Plan is paused: Z.ai does not list Batshit as an allowed tool yet. ' +
  "Z.ai's normal pay-as-you-go connection (Z.ai) works."

function devPanelOn() {
  testEnv.BATSHIT_ENABLE_INTERNAL_DEV_PANEL = '1'
  testEnv.BATSHIT_INTERNAL_DEV_PANEL_SECRET = 'test-se-secret-0123456789abcdef0123456789'
}

beforeEach(() => {
  store.clear()
  for (const key of Object.keys(testEnv)) delete testEnv[key]
  testEnv.ZAI_CODING_API_KEY = 'test-se-zai-coding-0123456789'
  testEnv.ZAI_API_KEY = 'test-se-zai-paygo-0123456789'
  testEnv.MIMO_TOKEN_PLAN_API_KEY = 'test-se-mimo-plan-0123456789'
  testEnv.QWEN_TOKEN_PLAN_API_KEY = 'test-se-qwen-plan-0123456789'
  testEnv.KIMI_CODE_API_KEY = 'test-se-kimi-code-0123456789'
  testEnv.MINIMAX_TOKEN_PLAN_API_KEY = 'test-se-minimax-plan-0123456789'
})

describe('the one list of paused plans', () => {
  it('names Z.ai Coding Plan, Qwen Token Plan, and MiMo Token Plan, each with its rule, link, and date', () => {
    expect(PAUSED_PLANS.map((plan) => plan.service)).toEqual([
      'zai_coding',
      'qwen_token_plan',
      'mimo_token_plan'
    ])
    for (const plan of PAUSED_PLANS) {
      expect(plan.rule.length).toBeGreaterThan(20)
      expect(plan.ruleUrl).toMatch(/^https:\/\//)
      expect(plan.readOn).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    }
  })

  it('does not pause Kimi Code or MiniMax', () => {
    expect(findPausedPlan('kimi_code')).toBeNull()
    expect(findPausedPlan('minimax_token_plan')).toBeNull()
    expect(findPausedPlan('direct:zai_coding')?.service).toBe('zai_coding')
  })

  it('finds a paused plan regardless of case or surrounding spaces (BL-add-refusal-dodge)', () => {
    expect(findPausedPlan(' ZAI_CODING ')?.service).toBe('zai_coding')
    expect(findPausedPlan('Zai_Coding')?.service).toBe('zai_coding')
    expect(findPausedPlan(' direct:ZAI_CODING ')?.service).toBe('zai_coding')
  })

  it('reads plain words', () => {
    expect(pausedPlanSentence(findPausedPlan('zai_coding')!)).toBe(ZAI_SENTENCE)
  })

  it('adds the asking clause only when the letter went out (Faye, 2026-09-28)', () => {
    const zai = findPausedPlan('zai_coding')!
    expect(zai.letterSentOn).toBeNull()
    expect(pausedPlanSentence(zai)).toBe(ZAI_SENTENCE)
    expect(pausedPlanSentence(zai)).not.toMatch(/asking/)

    const sentWithDate = pausedPlanSentence({ ...zai, letterSentOn: '2026-10-01' })
    expect(sentWithDate).toBe(
      "Z.ai Coding Plan is paused: Z.ai does not list Batshit as an allowed tool yet. Z.ai's normal pay-as-you-go connection (Z.ai) works. " +
        'Batshit asked Z.ai for approval on 2026-10-01.'
    )
  })
})

describe('routing a saved model of a paused plan', () => {
  it('fails with the sentence by default', () => {
    const manager = new ProviderManager()
    expect(() => manager.getModel('glm-5.3', { transport: 'direct', service: 'zai_coding' })).toThrow(
      ZAI_SENTENCE
    )
  })

  it('never switches silently: not to a configured fallback, not to the auto fallback', () => {
    const manager = new ProviderManager()
    const call = () =>
      manager.getModel('glm-5.3', {
        transport: 'direct',
        service: 'zai_coding',
        allowAutoFallback: true,
        fallbackModel: { modelName: 'glm-5.3', transport: 'direct', service: 'zai' }
      })
    expect(call).toThrow(PausedPlanError)
    expect(call).toThrow(ZAI_SENTENCE)
  })

  it('keeps the plan registered (switched off, not deleted)', () => {
    const manager = new ProviderManager()
    expect(manager.hasProvider('zai_coding')).toBe(true)
    expect(manager.hasProvider('mimo_token_plan')).toBe(true)
    expect(manager.hasProvider('qwen_token_plan')).toBe(true)
  })

  it('refuses every paused plan and routes the plans that are not paused', () => {
    const manager = new ProviderManager()
    for (const service of ['zai_coding', 'qwen_token_plan', 'mimo_token_plan']) {
      expect(() => manager.getModel('zcpause-model', { transport: 'direct', service })).toThrow(
        PausedPlanError
      )
    }
    expect(() => manager.getModel('kimi-for-coding', { transport: 'direct', service: 'kimi_code' })).not.toThrow()
    expect(() => manager.getModel('glm-5.3', { transport: 'direct', service: 'zai' })).not.toThrow()
  })

  it('routes as today when the server allowed paused plans on this copy', () => {
    const manager = new ProviderManager({ pausedPlansAllowed: true })
    expect(() => manager.getModel('glm-5.3', { transport: 'direct', service: 'zai_coding' })).not.toThrow()
  })

  it('the auto-fallback chain skips a paused plan even when it is the only provider configured (FIX 4)', () => {
    testEnv.ZAI_API_KEY = ''
    testEnv.KIMI_CODE_API_KEY = ''
    testEnv.MINIMAX_TOKEN_PLAN_API_KEY = ''
    const manager = new ProviderManager()
    expect(manager.hasProvider('zai')).toBe(false)
    expect(manager.hasProvider('kimi_code')).toBe(false)
    expect(manager.hasProvider('minimax_token_plan')).toBe(false)
    expect(manager.hasProvider('zai_coding')).toBe(true)
    expect(manager.hasProvider('qwen_token_plan')).toBe(true)
    expect(manager.hasProvider('mimo_token_plan')).toBe(true)
    // Every configured provider is a paused plan; auto-fallback must find none
    // of them, not silently pick one.
    expect(() =>
      manager.getModel('zcpause-model', { transport: 'direct', service: 'unknown_provider_xyz', allowAutoFallback: true })
    ).toThrow(/not configured and no fallback available/)
  })
})

describe('the Dev switch "Use paused plans on this copy"', () => {
  it('is off by default, even on a copy with the Dev panel', async () => {
    devPanelOn()
    expect(await readPausedPlansDevSwitch()).toBe(false)
    expect(await pausedPlansAllowedOnThisCopy()).toBe(false)
  })

  it('counts only where the Dev panel exists: a stored switch without the panel is nothing', async () => {
    await writePausedPlansDevSwitch(true)
    expect(store.has(PAUSED_PLANS_DEV_SWITCH_KEY)).toBe(true)
    expect(await pausedPlansAllowedOnThisCopy()).toBe(false)
    testEnv.BATSHIT_ENABLE_INTERNAL_DEV_PANEL = '1'
    testEnv.BATSHIT_INTERNAL_DEV_PANEL_SECRET = 'too-short'
    expect(await pausedPlansAllowedOnThisCopy()).toBe(false)
  })

  it('allows paused plans on a Dev copy with the switch on; off deletes the record', async () => {
    devPanelOn()
    await writePausedPlansDevSwitch(true)
    expect(await pausedPlansAllowedOnThisCopy()).toBe(true)
    await writePausedPlansDevSwitch(false)
    expect(store.has(PAUSED_PLANS_DEV_SWITCH_KEY)).toBe(false)
    expect(await pausedPlansAllowedOnThisCopy()).toBe(false)
  })

  it('is read on the server by ProviderManager.createForUser', async () => {
    devPanelOn()
    await writePausedPlansDevSwitch(true)
    const allowed = await ProviderManager.createForUser(null)
    expect(() => allowed.getModel('glm-5.3', { transport: 'direct', service: 'zai_coding' })).not.toThrow()
    await writePausedPlansDevSwitch(false)
    const paused = await ProviderManager.createForUser(null)
    expect(() => paused.getModel('glm-5.3', { transport: 'direct', service: 'zai_coding' })).toThrow(
      ZAI_SENTENCE
    )
  })
})
