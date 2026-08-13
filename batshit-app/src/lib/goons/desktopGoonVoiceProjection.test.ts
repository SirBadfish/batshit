import { describe, expect, it } from 'vitest'

import { projectDesktopGoonVoiceVisual } from '$lib/goons/desktopGoonVoiceProjection'

describe('projectDesktopGoonVoiceVisual', () => {
  it('accepts clone-safe speech frames, timelines, and normalized levels', () => {
    const result = projectDesktopGoonVoiceVisual({
      kind: 'frame',
      generation: 'speech-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      atMs: 1000,
      elapsedMs: 240,
      audioLevel: 0.42,
      frame: {
        profile: 'rhubarb-9',
        weights: {
          closed: 0,
          wide_open: 0.8,
          teeth: 0,
          puckered: 0,
          lips_together: 0,
          lower_lip_bite: 0,
          tongue_tip_up: 0,
          tongue_up: 0,
          tongue_lift: 0
        }
      }
    })

    expect(result).toMatchObject({ ok: true, value: { kind: 'frame', audioLevel: 0.42 } })
  })

  it.each([
    { audio: { play() {} } },
    { audioContext: { resume() {} } },
    { rawAudio: new Uint8Array([1, 2, 3]) },
    { pcmBytes: [1, 2, 3] }
  ])('rejects duplicate/raw audio ownership: $rawAudio', (forbidden) => {
    const result = projectDesktopGoonVoiceVisual({
      kind: 'start',
      generation: 'speech-1',
      agentId: 'agent-1',
      messageId: 'message-1',
      startedAtMs: 1000,
      durationMs: null,
      analyzerId: null,
      timeline: null,
      ...forbidden
    })
    expect(result).toMatchObject({ ok: false, code: 'FORBIDDEN_AUDIO_OWNER' })
  })

  it('rejects non-plain clone-unsafe state and out-of-range visual levels', () => {
    expect(projectDesktopGoonVoiceVisual({
      kind: 'frame',
      generation: 'speech-1',
      agentId: null,
      messageId: null,
      atMs: 1,
      elapsedMs: 1,
      frame: null,
      audioLevel: 1.1
    })).toMatchObject({ ok: false, code: 'INVALID_INPUT' })

    expect(projectDesktopGoonVoiceVisual({
      kind: 'end',
      generation: 'speech-1',
      agentId: null,
      messageId: null,
      endedAtMs: 1,
      callback: () => {}
    })).toMatchObject({ ok: false, code: 'NOT_CLONE_SAFE' })
  })
})
