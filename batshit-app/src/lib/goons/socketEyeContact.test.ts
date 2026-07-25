import { describe, expect, it } from 'vitest'
import {
  DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
  parseSocketEyeContactSettings,
  resolveSocketEyeContactSettings,
  socketEyeContactResponseLerp
} from './socketEyeContact'

describe('socket eye contact settings', () => {
  it('resolves one explicit five-setting first-party contract', () => {
    expect(resolveSocketEyeContactSettings(null)).toEqual({
      schemaVersion: 'socket-eye-contact-settings/v2',
      enabled: true,
      strength: 0.8,
      convergence: 0,
      headFollow: 0.5,
      response: 0.5
    })
    expect(
      parseSocketEyeContactSettings({
        schemaVersion: 'socket-eye-contact-settings/v2',
        enabled: false,
        strength: 0.4,
        convergence: 0.12,
        headFollow: 0.25,
        response: 0.8
      })
    ).toEqual({
      schemaVersion: 'socket-eye-contact-settings/v2',
      enabled: false,
      strength: 0.4,
      convergence: 0.12,
      headFollow: 0.25,
      response: 0.8
    })
  })

  it('rejects retired schemas and out-of-range convergence instead of silently carrying them', () => {
    expect(() =>
      parseSocketEyeContactSettings({
        schemaVersion: 'socket-eye-contact-settings/v1',
        enabled: true,
        strength: 0.8,
        convergence: 0,
        headFollow: 0.5,
        response: 0.5
      })
    ).toThrow('schemaVersion must be socket-eye-contact-settings/v2')
    expect(() =>
      parseSocketEyeContactSettings({
        ...DEFAULT_SOCKET_EYE_CONTACT_SETTINGS,
        convergence: 0.26
      })
    ).toThrow('settings.convergence must be a finite number inside [-0.25, 0.25]')
  })

  it('keeps response mapping finite, monotonic, and bounded', () => {
    expect(socketEyeContactResponseLerp(0)).toBe(0.04)
    expect(socketEyeContactResponseLerp(0.5)).toBeGreaterThan(socketEyeContactResponseLerp(0))
    expect(socketEyeContactResponseLerp(1)).toBe(0.35)
    expect(() => socketEyeContactResponseLerp(1.01)).toThrow('inside [0, 1]')
  })
})
