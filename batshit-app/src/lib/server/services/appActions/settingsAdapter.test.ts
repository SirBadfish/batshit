import { beforeEach, describe, expect, it, vi } from 'vitest'

/**
 * SA-122 A-1y (LS-067/LS-068): the agent's own Settings save tells every tab of the user, on the
 * user channel, that the agent changed (`agent_settings_changed`). Only a save that was sent:
 * saved, or sent with its answer lost. A refused, never-sent, unchanged or read-only call says
 * nothing. The owner is mocked here: its own conditional write is `conditionalAgentSettings`'s
 * suites; this file pins only the adapter's publish rule.
 */

const owner = vi.hoisted(() => ({
  updateMemory: vi.fn(),
  updateIdentity: vi.fn(),
  readMemory: vi.fn(),
  readIdentity: vi.fn(),
  inspect: vi.fn()
}))
const publishUserEvent = vi.hoisted(() => vi.fn(async () => {}))

vi.mock('./settings/server', () => ({
  ownAgentSettings: {
    updateMemory: owner.updateMemory,
    updateIdentity: owner.updateIdentity,
    readMemory: owner.readMemory,
    readIdentity: owner.readIdentity
  },
  inspectSettings: owner.inspect
}))
vi.mock('$lib/server/ssePublisher', () => ({ publishUserEvent }))

const { executeAgentSettingsAction } = await import('./settingsAdapter')
const { SettingsActionRefusal } = await import('$lib/appActions/settings/validation')

const USER = 'user-a1y'
const AGENT = 'agent-a1y'
const context = () => ({ userId: USER, agentId: AGENT, abortSignal: new AbortController().signal })
const REVISION = `sha256:${'a'.repeat(64)}`
const memoryArgs = { subjectAgentId: AGENT, expectedRevision: REVISION, changes: { onMyMind: 120 } }
const identityArgs = { subjectAgentId: AGENT, expectedRevision: REVISION, changes: { displayName: 'Probe 2' } }

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the agent Settings adapter announces a sent save (LS-067/LS-068)', () => {
  it('a saved memory update publishes one agent_settings_changed for memory, after the save, and returns the owner result', async () => {
    const result = { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown' }
    owner.updateMemory.mockImplementation(async () => {
      expect(publishUserEvent).not.toHaveBeenCalled()
      return result
    })

    expect(await executeAgentSettingsAction(context(), 'settings.agent.memory.update', memoryArgs)).toBe(result)
    expect(publishUserEvent).toHaveBeenCalledTimes(1)
    expect(publishUserEvent).toHaveBeenCalledWith(USER, { type: 'agent_settings_changed', agentId: AGENT, family: 'memory' })
  })

  it('a saved identity update publishes one for identity; a save whose readback failed or changed still publishes', async () => {
    for (const result of [
      { status: 'completed', saved: 'saved', readback: 'verified', visible: 'unknown' },
      { status: 'completed', reason: 'saved_readback_unavailable', saved: 'saved', readback: 'unavailable', visible: 'unknown' },
      { status: 'completed', reason: 'saved_then_changed', saved: 'saved', readback: 'changed', visible: 'unknown' }
    ]) {
      publishUserEvent.mockClear()
      owner.updateIdentity.mockResolvedValueOnce(result)
      expect(await executeAgentSettingsAction(context(), 'settings.agent.identity.update', identityArgs)).toBe(result)
      expect(publishUserEvent).toHaveBeenCalledTimes(1)
      expect(publishUserEvent).toHaveBeenCalledWith(USER, { type: 'agent_settings_changed', agentId: AGENT, family: 'identity' })
    }
  })

  it('a sent save whose answer was lost (saved unknown) publishes, and the result still says visible unknown', async () => {
    const result = { status: 'unknown_outcome', reason: 'save_outcome_unconfirmed', saved: 'unknown', readback: 'unavailable', visible: 'unknown' }
    owner.updateMemory.mockResolvedValueOnce(result)

    const answer = await executeAgentSettingsAction(context(), 'settings.agent.memory.update', memoryArgs)

    expect(answer).toBe(result)
    expect(answer.visible).toBe('unknown')
    expect(publishUserEvent).toHaveBeenCalledTimes(1)
  })

  it('a refused, never-sent or unchanged save publishes nothing', async () => {
    for (const result of [
      { status: 'blocked', reason: 'revision_conflict', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
      { status: 'blocked', reason: 'settings_store_unavailable_before_write', saved: 'not_requested', readback: 'not_requested', visible: 'unchanged' },
      { status: 'no_op', saved: 'not_requested', readback: 'verified', visible: 'unchanged' }
    ]) {
      owner.updateMemory.mockResolvedValueOnce(result)
      expect(await executeAgentSettingsAction(context(), 'settings.agent.memory.update', memoryArgs)).toBe(result)
    }
    owner.updateIdentity.mockRejectedValueOnce(new SettingsActionRefusal('operation_no_longer_admitted'))
    expect(await executeAgentSettingsAction(context(), 'settings.agent.identity.update', identityArgs)).toEqual({
      status: 'blocked',
      reason: 'operation_no_longer_admitted'
    })
    expect(publishUserEvent).not.toHaveBeenCalled()
  })

  it('invalid arguments, a stopped caller and reads publish nothing and never reach the writer', async () => {
    expect(await executeAgentSettingsAction(context(), 'settings.agent.memory.update', { ...memoryArgs, changes: {} })).toEqual({
      status: 'blocked',
      reason: 'empty_changes'
    })
    const stopped = new AbortController()
    stopped.abort()
    expect(
      await executeAgentSettingsAction({ userId: USER, agentId: AGENT, abortSignal: stopped.signal }, 'settings.agent.identity.update', identityArgs)
    ).toEqual({ status: 'blocked', reason: 'caller_stopped' })
    owner.readMemory.mockResolvedValueOnce({ subjectAgentId: AGENT, revision: REVISION, values: {} })
    await executeAgentSettingsAction(context(), 'settings.agent.memory.read', { subjectAgentId: AGENT })
    expect(owner.updateMemory).not.toHaveBeenCalled()
    expect(owner.updateIdentity).not.toHaveBeenCalled()
    expect(publishUserEvent).not.toHaveBeenCalled()
  })
})
