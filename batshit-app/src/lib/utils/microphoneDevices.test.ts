import { describe, expect, it, vi } from 'vitest'

import { loadMicrophoneDeviceOptions } from './microphoneDevices'

describe('loadMicrophoneDeviceOptions', () => {
  it('enumerates audio input devices without forcing permission by default', async () => {
    const getUserMedia = vi.fn()
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'default', label: '' },
      { kind: 'audioinput', deviceId: 'mv7', label: 'Shure MV7' },
      { kind: 'audiooutput', deviceId: 'speakers', label: 'Speakers' }
    ])

    const devices = await loadMicrophoneDeviceOptions({
      mediaDevices: { enumerateDevices, getUserMedia } as any
    })

    expect(getUserMedia).not.toHaveBeenCalled()
    expect(devices).toEqual([
      { id: 'default', label: 'Microphone 1' },
      { id: 'mv7', label: 'Shure MV7' }
    ])
  })

  it('requests and releases microphone access before refresh enumeration', async () => {
    const stop = vi.fn()
    const stream = {
      getTracks: () => [{ stop }]
    }
    const getUserMedia = vi.fn(async () => stream)
    const enumerateDevices = vi.fn(async () => [
      { kind: 'audioinput', deviceId: 'mv7', label: 'Shure MV7' },
      { kind: 'audioinput', deviceId: 'joycast', label: 'Joycast Mic' }
    ])

    const devices = await loadMicrophoneDeviceOptions({
      mediaDevices: { enumerateDevices, getUserMedia } as any,
      requestPermission: true
    })

    expect(getUserMedia).toHaveBeenCalledWith({ audio: true })
    expect(stop).toHaveBeenCalledTimes(1)
    expect(enumerateDevices).toHaveBeenCalledTimes(1)
    expect(devices).toEqual([
      { id: 'mv7', label: 'Shure MV7' },
      { id: 'joycast', label: 'Joycast Mic' }
    ])
  })
})
