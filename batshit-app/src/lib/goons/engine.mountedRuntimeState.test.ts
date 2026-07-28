import { describe, expect, it, vi } from 'vitest'

import { GoonEngine } from '$lib/goons/engine'
import { DEFAULT_SOCKET_EYE_CONTACT_SETTINGS } from '$lib/goons/socketEyeContact'

function action(name: string, time: number) {
  return {
    time,
    getClip: () => ({ name })
  }
}

describe('GoonEngine mounted runtime continuity', () => {
  it('preserves socket-eye contact settings across a same-Goon Live revision swap', () => {
    const outgoing = new GoonEngine(document.createElement('div')) as any
    outgoing.socketEyeSurfaceDefinition = { schemaVersion: 'socket-eye-surface/v1' }
    outgoing.socketEyeContact = {
      ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
      strength: 0.75,
      convergence: 0.18,
      headFollow: 0.4,
      response: 0.2
    }

    const snapshot = outgoing.captureMountedRuntimeState()
    expect(snapshot.eyeContact.socket).toEqual(outgoing.socketEyeContact)

    const incoming = new GoonEngine(document.createElement('div')) as any
    incoming.restoreMountedRuntimeState(snapshot)
    expect(incoming.getSocketEyeContactSettings()).toEqual(outgoing.socketEyeContact)
  })

  it('restores semantic animation, performance, speech, and camera state on a fresh engine', () => {
    const now = performance.now()
    const outgoing = new GoonEngine(document.createElement('div')) as any
    outgoing.getCameraState = vi.fn(() => ({ mode: 'free', fov: 36, position: [1, 2, 3] }))
    outgoing.baseLoop = 'base_relaxed'
    outgoing.activeMood = { name: 'base_relaxed', kind: 'mood', intensity: 0.8 }
    outgoing.baseLoopAction = action('base-relaxed.glb', 4.25)
    outgoing.oneShotAction = action('wave.glb', 0.6)
    outgoing.oneShotRestorePosture = 'stand'
    outgoing.oneShotRestorePreserveCamera = true
    outgoing.animationOverridePosture = 'sit'
    outgoing.eyeContactEnabled = false
    outgoing.eyeContactApplied = { eyeYaw: 0.2, eyePitch: -0.1, headYaw: 0.3, headPitch: 0.1 }
    outgoing.customPerformanceDirection = { headYaw: 0.3, headPitch: 0.1, eyeYaw: 0.2, eyePitch: -0.1 }
    outgoing.moodFaceBlend = 0.45
    outgoing.activeEmoteUntil = now + 700
    outgoing.activeExpressions = [{
      name: 'smile',
      kind: 'emote',
      intensity: 1,
      endsAt: now + 900,
      targets: [],
      faceControls: [],
      rawMorphTargets: [],
      startTime: now - 100,
      attackMs: 100,
      holdMs: 600,
      releaseMs: 200,
      easing: 'easeInOut',
      currentStep: 0,
      stepStartTime: now - 50
    }]
    outgoing.speaking = true
    outgoing.speechPausedForCue = true
    outgoing.speechLipSyncTimeline = {
      source: 'text-timing',
      analyzerId: 'batshit-text-timing',
      durationMs: 1200,
      frames: []
    }
    outgoing.speechLipSyncAnalyzerId = 'batshit-text-timing'
    outgoing.speechLipSyncDurationMs = 1200
    outgoing.speechLipSyncStartedAt = now - 300

    const snapshot = outgoing.captureMountedRuntimeState()
    expect(snapshot.baseLoop).toMatchObject({ clipName: 'base-relaxed.glb', time: 4.25 })
    expect(snapshot.oneShot).toMatchObject({ clipName: 'wave.glb', time: 0.6 })
    expect(snapshot.performance.expressions[0]).not.toHaveProperty('startTime')
    expect(snapshot.performance.expressions[0]).not.toHaveProperty('endsAt')

    const incoming = new GoonEngine(document.createElement('div')) as any
    const incomingBaseAction = action('base-relaxed.glb', 0)
    const incomingOneShotAction = action('wave.glb', 0)
    vi.spyOn(incoming, 'setMood').mockImplementation(() => {
      incoming.baseLoopAction = incomingBaseAction
    })
    vi.spyOn(incoming, 'playOneShotAnimation').mockImplementation(() => {
      incoming.oneShotAction = incomingOneShotAction
      return true
    })
    const applyCamera = vi.spyOn(incoming, 'applyCamera').mockImplementation(() => {})

    incoming.restoreMountedRuntimeState(snapshot)

    expect(incomingBaseAction.time).toBe(4.25)
    expect(incomingOneShotAction.time).toBe(0.6)
    expect(incoming.speaking).toBe(true)
    expect(incoming.speechPausedForCue).toBe(true)
    expect(incoming.speechLipSyncTimeline).toEqual(snapshot.speech.timeline)
    expect(incoming.activeExpressions[0].endsAt).toBeGreaterThan(performance.now())
    expect(applyCamera).toHaveBeenCalledWith(snapshot.camera)
  })

  it('keeps Emotes facial-only even when legacy motion fields are present', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const triggerExpression = vi.spyOn(engine, 'triggerExpression').mockImplementation(() => {})
    const playOneShotAnimation = vi
      .spyOn(engine, 'playOneShotAnimation')
      .mockImplementation(() => true)
    const requestDeferredAnimation = vi
      .spyOn(engine, 'requestDeferredAnimation')
      .mockImplementation(() => {})
    const transitionToPosture = vi
      .spyOn(engine, 'transitionToPosture')
      .mockImplementation(() => {})

    engine.playCue('wave', {
      name: 'wave',
      kind: 'emote',
      playback: 'oneshot',
      animationName: 'gesture-standing-greeting',
      posture: 'sit',
      expressionTargets: [{ preset: 'happy', weight: 1 }]
    })

    expect(triggerExpression).toHaveBeenCalledWith('wave', expect.objectContaining({ kind: 'emote' }))
    expect(playOneShotAnimation).not.toHaveBeenCalled()
    expect(requestDeferredAnimation).not.toHaveBeenCalled()
    expect(transitionToPosture).not.toHaveBeenCalled()
  })

  it('plays standalone Motions only through real animation assets', () => {
    const engine = new GoonEngine(document.createElement('div')) as any
    const triggerExpression = vi.spyOn(engine, 'triggerExpression').mockImplementation(() => {})
    const playOneShotAnimation = vi
      .spyOn(engine, 'playOneShotAnimation')
      .mockReturnValueOnce(true)
      .mockReturnValueOnce(false)
    const requestDeferredAnimation = vi
      .spyOn(engine, 'requestDeferredAnimation')
      .mockImplementation(() => {})

    engine.playCue('gesture-standing-greeting')
    expect(playOneShotAnimation).toHaveBeenNthCalledWith(1, 'gesture-standing-greeting')
    expect(triggerExpression).not.toHaveBeenCalled()

    engine.playCue('missing-motion')
    expect(playOneShotAnimation).toHaveBeenNthCalledWith(2, 'missing-motion')
    expect(requestDeferredAnimation).toHaveBeenCalledWith(
      'missing-motion',
      'generic',
      undefined
    )
    expect(engine).not.toHaveProperty('activeGesture')
  })
})
