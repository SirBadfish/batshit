/** Plan pause: a paused plan's connection is locked with its plain words. */
import { describe, expect, it } from 'vitest'
import { _buildConnectionOptions } from './+server'
import { PAUSED_PLANS, pausedPlanDevOnSentence, pausedPlanSentence } from '$lib/data/pausedPlans'

const access = {
  apiKeys: {},
  availability: new Proxy({}, { get: () => ({ hasKey: true, source: 'user' }) }),
  gateway: { apiKey: null, baseURL: null, availability: { hasKey: false, source: null } }
} as any

function statuses(paused: boolean) {
  return Object.fromEntries(
    PAUSED_PLANS.map((plan) => [
      plan.service,
      paused
        ? { paused: true, message: pausedPlanSentence(plan) }
        : { paused: false, message: pausedPlanDevOnSentence(plan) }
    ])
  )
}

describe('/api/models connection options and paused plans', () => {
  it('locks each paused plan with its sentence even when its key is saved', () => {
    const options = _buildConnectionOptions(access, { codex: null, pausedPlans: statuses(true) })
    for (const plan of PAUSED_PLANS) {
      const option = options.find((entry) => entry.id === `direct:${plan.service}`)
      expect(option).toMatchObject({ status: 'locked', lockedReason: pausedPlanSentence(plan) })
    }
    expect(options.find((entry) => entry.id === 'direct:kimi_code')).toMatchObject({ status: 'ready' })
  })

  it('on a Dev copy that allows paused plans the plan is ready and says so', () => {
    const options = _buildConnectionOptions(access, { codex: null, pausedPlans: statuses(false) })
    const zai = options.find((entry) => entry.id === 'direct:zai_coding')
    expect(zai?.status).toBe('ready')
    expect(zai?.description).toContain('paused for other copies of Batshit')
  })
})
