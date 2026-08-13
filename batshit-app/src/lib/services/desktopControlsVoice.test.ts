import { describe, expect, it, vi } from 'vitest'

import {
  DesktopControlsVoiceCoordinator,
  DesktopControlsVoiceError,
  type DesktopControlsVoiceIntent,
  type DesktopControlsVoiceOwnerState
} from '$lib/services/desktopControlsVoice'

function inactiveState(
  overrides: Partial<DesktopControlsVoiceOwnerState> = {}
): DesktopControlsVoiceOwnerState {
  return {
    active: false,
    listening: false,
    runtime: 'direct',
    inputKind: null,
    phase: 'inactive',
    label: 'Voice Mode',
    modeLabel: 'Direct',
    error: null,
    allowedIntents: ['start'],
    ...overrides
  }
}

describe('Desktop Controls Voice Mode coordination', () => {
  it('reflects only owner-published Voice Mode state and does not carry audio ownership', () => {
    const coordinator = new DesktopControlsVoiceCoordinator()
    const snapshots: DesktopControlsVoiceOwnerState[] = []
    coordinator.subscribe((state) => snapshots.push(state))
    const owner = coordinator.attachOwner({
      initialState: inactiveState(),
      handleIntent: () => undefined
    })
    owner.publish(
      inactiveState({
        active: true,
        listening: true,
        inputKind: 'continuous',
        phase: 'listening',
        label: 'Listening',
        allowedIntents: ['end']
      })
    )

    expect(coordinator.getState()).toMatchObject({
      ownerAvailable: true,
      active: true,
      listening: true,
      phase: 'listening'
    })
    expect(Object.keys(coordinator.getState())).not.toEqual(
      expect.arrayContaining(['audio', 'microphone', 'mediaStream', 'audioContext', 'stt'])
    )
    expect(snapshots).toHaveLength(3)
  })

  it('delegates start, end, and listening actions to the one ChatInput owner', async () => {
    const coordinator = new DesktopControlsVoiceCoordinator()
    const intents: DesktopControlsVoiceIntent[] = []
    const owner = coordinator.attachOwner({
      initialState: inactiveState({ allowedIntents: ['start'] }),
      handleIntent(intent) {
        intents.push(intent)
      }
    })
    await coordinator.requestStart()

    owner.publish(
      inactiveState({
        active: true,
        listening: false,
        inputKind: 'recorded',
        phase: 'ready',
        allowedIntents: ['end', 'toggle-listening']
      })
    )
    await coordinator.requestListeningToggle()
    await coordinator.requestEnd()

    expect(intents).toEqual([{ type: 'start' }, { type: 'toggle-listening' }, { type: 'end' }])
  })

  it('rejects overlapping or unavailable intents with explicit errors and no retry', async () => {
    let resolveIntent: (() => void) | null = null
    const handler = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveIntent = resolve
        })
    )
    const coordinator = new DesktopControlsVoiceCoordinator()
    coordinator.attachOwner({
      initialState: inactiveState(),
      handleIntent: handler
    })

    const first = coordinator.requestStart()
    expect(coordinator.getState().pendingIntent).toBe('start')
    await expect(coordinator.requestStart()).rejects.toMatchObject({
      code: 'INTENT_IN_PROGRESS'
    })
    resolveIntent?.()
    await first
    expect(handler).toHaveBeenCalledTimes(1)
    expect(coordinator.getState().pendingIntent).toBeNull()
    await expect(coordinator.requestEnd()).rejects.toMatchObject({
      code: 'INTENT_NOT_ALLOWED'
    })
  })

  it('surfaces owner failures and keeps the latest authoritative voice state', async () => {
    const coordinator = new DesktopControlsVoiceCoordinator()
    coordinator.attachOwner({
      initialState: inactiveState(),
      handleIntent() {
        throw new Error('Microphone permission was denied.')
      }
    })

    await expect(coordinator.requestStart()).rejects.toMatchObject({
      code: 'INTENT_FAILED',
      message: 'Microphone permission was denied.'
    })
    expect(coordinator.getState()).toMatchObject({
      active: false,
      phase: 'inactive',
      pendingIntent: null,
      intentError: {
        code: 'INTENT_FAILED',
        message: 'Microphone permission was denied.'
      }
    })
  })

  it('rejects audio-like fields, impossible listening state, duplicate owners, and stale owners', () => {
    const coordinator = new DesktopControlsVoiceCoordinator()
    expect(() =>
      coordinator.attachOwner({
        initialState: {
          ...inactiveState(),
          audioContext: {}
        } as DesktopControlsVoiceOwnerState,
        handleIntent: () => undefined
      })
    ).toThrow(/unsupported field/)
    expect(() =>
      coordinator.attachOwner({
        initialState: inactiveState({ listening: true }),
        handleIntent: () => undefined
      })
    ).toThrow(/cannot listen/)

    const owner = coordinator.attachOwner({
      initialState: inactiveState(),
      handleIntent: () => undefined
    })
    expect(() =>
      coordinator.attachOwner({
        initialState: inactiveState(),
        handleIntent: () => undefined
      })
    ).toThrow(/already owns/)
    owner.detach()
    expect(() => owner.publish(inactiveState())).toThrow(/stale ChatInput owner/)
    expect(() => coordinator.requestStart()).rejects.toBeInstanceOf(DesktopControlsVoiceError)
  })
})
