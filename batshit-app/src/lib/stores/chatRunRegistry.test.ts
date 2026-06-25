import { afterEach, describe, expect, it } from 'vitest'

import {
  clearRunRegistryForTest,
  getRunState,
  hasActiveN8nPrimaryRun,
  isSessionBusy,
  markComplete,
  markStreaming,
  releaseAbortController,
  removeActiveMessage,
  resetRunState,
  setAbortController,
  startRun
} from './chatRunRegistry.svelte'

describe('chatRunRegistry', () => {
  afterEach(() => {
    clearRunRegistryForTest()
  })

  it('tracks selected-session busy state independently from background sessions', () => {
    startRun({
      sessionId: 'session-a',
      transport: 'api',
      activeMessageId: 'msg-a'
    })

    expect(isSessionBusy('session-a')).toBe(true)
    expect(isSessionBusy('session-b')).toBe(false)

    markStreaming('session-b', 'msg-b')

    expect(getRunState('session-a').activeMessageId).toBe('msg-a')
    expect(getRunState('session-b').activeMessageId).toBe('msg-b')
    expect(isSessionBusy('session-a')).toBe(true)
    expect(isSessionBusy('session-b')).toBe(true)
  })

  it('tracks the active n8n run separately from API run state', () => {
    startRun({
      sessionId: 'n8n-session',
      transport: 'n8n',
      activeMessageId: 'msg-n8n'
    })

    expect(hasActiveN8nPrimaryRun('api-session')?.sessionId).toBe('n8n-session')

    startRun({
      sessionId: 'api-session',
      transport: 'api',
      activeMessageId: 'msg-api'
    })

    expect(hasActiveN8nPrimaryRun('api-session')?.sessionId).toBe('n8n-session')
    expect(hasActiveN8nPrimaryRun('n8n-session')).toBeNull()

    markComplete('n8n-session')

    expect(hasActiveN8nPrimaryRun('api-session')).toBeNull()
  })

  it('uses abort controllers per session', () => {
    const controllerA = new AbortController()
    const controllerB = new AbortController()

    startRun({ sessionId: 'session-a', transport: 'cli', abortController: controllerA })
    startRun({ sessionId: 'session-b', transport: 'cli', abortController: controllerB })

    expect(getRunState('session-a').abortController).toBe(controllerA)
    expect(getRunState('session-b').abortController).toBe(controllerB)

    setAbortController('session-a', null)

    expect(getRunState('session-a').abortController).toBeNull()
    expect(getRunState('session-b').abortController).toBe(controllerB)
  })

  it('marks a run complete when the controller is released after the last stream message ended', () => {
    const controller = new AbortController()

    startRun({
      sessionId: 'group-session',
      transport: 'cli',
      activeMessageId: 'msg-placeholder',
      abortController: controller
    })

    removeActiveMessage('group-session', 'msg-placeholder')

    expect(isSessionBusy('group-session')).toBe(true)

    releaseAbortController('group-session', controller)

    expect(getRunState('group-session').status).toBe('complete')
    expect(getRunState('group-session').abortController).toBeNull()
    expect(isSessionBusy('group-session')).toBe(false)
  })

  it('keeps a run active when the controller is released before the stream message ends', () => {
    const controller = new AbortController()

    startRun({
      sessionId: 'active-session',
      transport: 'api',
      activeMessageId: 'msg-active',
      abortController: controller
    })

    releaseAbortController('active-session', controller)

    expect(getRunState('active-session').status).toBe('submitting')
    expect(getRunState('active-session').abortController).toBeNull()
    expect(isSessionBusy('active-session')).toBe(true)

    removeActiveMessage('active-session', 'msg-active')

    expect(isSessionBusy('active-session')).toBe(false)
  })

  it('can reset one session without clearing another', () => {
    markStreaming('session-a', 'msg-a')
    markStreaming('session-b', 'msg-b')

    resetRunState('session-a')

    expect(isSessionBusy('session-a')).toBe(false)
    expect(isSessionBusy('session-b')).toBe(true)
  })
})
