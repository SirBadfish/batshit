import { describe, expect, it } from 'vitest'
import { evaluateN8nPrimaryExclusivity } from './n8nPrimaryExclusivity'

describe('evaluateN8nPrimaryExclusivity', () => {
  it('allows API and CLI runs to overlap when no n8n run is active', () => {
    expect(
      evaluateN8nPrimaryExclusivity({
        transport: 'api',
        currentSessionId: 'api-b',
        activeRuns: [{ sessionId: 'api-a', transport: 'api' }]
      })
    ).toEqual({ allowed: true })

    expect(
      evaluateN8nPrimaryExclusivity({
        transport: 'cli',
        currentSessionId: 'cli-b',
        activeRuns: [{ sessionId: 'api-a', transport: 'api' }]
      })
    ).toEqual({ allowed: true })
  })

  it('blocks starting an n8n run while another session is active', () => {
    const decision = evaluateN8nPrimaryExclusivity({
      transport: 'n8n',
      currentSessionId: 'n8n-session',
      activeRuns: [{ sessionId: 'api-session', transport: 'api' }]
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe('other-run-active')
      expect(decision.description).toMatch(/run by themselves/i)
    }
  })

  it('blocks duplicate sends in the same n8n session', () => {
    const decision = evaluateN8nPrimaryExclusivity({
      transport: 'n8n',
      currentSessionId: 'n8n-session',
      activeRuns: [{ sessionId: 'n8n-session', transport: 'n8n' }]
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe('same-session-active')
    }
  })

  it('blocks API or CLI starts while n8n is active', () => {
    const decision = evaluateN8nPrimaryExclusivity({
      transport: 'api',
      currentSessionId: 'api-session',
      activeRuns: [{ sessionId: 'n8n-session', transport: 'n8n' }]
    })

    expect(decision.allowed).toBe(false)
    if (!decision.allowed) {
      expect(decision.reason).toBe('n8n-run-active')
      expect(decision.description).toMatch(/before starting another chat/i)
    }
  })
})
