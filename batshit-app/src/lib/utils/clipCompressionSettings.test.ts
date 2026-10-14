import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CLIP_COMPRESSION_SETTINGS,
  clipCompressionSettingsFromResponse,
  normalizeClipCompressionSettings
} from './clipCompressionSettings'

describe('normalizeClipCompressionSettings (BL-484)', () => {
  it('returns the defaults for a missing ui_settings (undefined)', () => {
    expect(normalizeClipCompressionSettings(undefined)).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })

  it('returns the defaults for a null ui_settings', () => {
    expect(normalizeClipCompressionSettings(null)).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })

  it('returns the defaults for a wrongly-shaped ui_settings (array)', () => {
    expect(normalizeClipCompressionSettings([1, 2, 3])).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })

  it('returns the defaults for a wrongly-shaped ui_settings (a primitive)', () => {
    expect(normalizeClipCompressionSettings('nonsense')).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })

  it('returns the defaults for an empty ui_settings object', () => {
    expect(normalizeClipCompressionSettings({})).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })

  it('keeps every explicitly-saved field', () => {
    expect(
      normalizeClipCompressionSettings({
        compress_images: false,
        compression_quality: 80,
        max_image_size: '2048',
        force_jpeg: false
      })
    ).toEqual({
      compress_images: false,
      compression_quality: 80,
      max_image_size: '2048',
      force_jpeg: false
    })
  })

  it('fills in only the missing fields of a partial ui_settings', () => {
    expect(normalizeClipCompressionSettings({ compression_quality: 90 })).toEqual({
      ...DEFAULT_CLIP_COMPRESSION_SETTINGS,
      compression_quality: 90
    })
  })

  it('falls back to the default quality/size for a falsy saved value (0 / empty string)', () => {
    expect(
      normalizeClipCompressionSettings({ compression_quality: 0, max_image_size: '' })
    ).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })
})

describe('clipCompressionSettingsFromResponse (BL-484)', () => {
  it('gives the defaults for a missing ui_settings on an OK response', () => {
    expect(
      clipCompressionSettingsFromResponse(true, 200, { settings: { user_id: 'josh' } })
    ).toEqual(DEFAULT_CLIP_COMPRESSION_SETTINGS)
  })

  it('gives the defaults when the whole settings object is missing on an OK response', () => {
    expect(clipCompressionSettingsFromResponse(true, 200, {})).toEqual(
      DEFAULT_CLIP_COMPRESSION_SETTINGS
    )
  })

  it('keeps a saved ui_settings on an OK response', () => {
    expect(
      clipCompressionSettingsFromResponse(true, 200, {
        settings: { ui_settings: { compression_quality: 90 } }
      })
    ).toEqual({ ...DEFAULT_CLIP_COMPRESSION_SETTINGS, compression_quality: 90 })
  })

  it('throws for a null payload (an unreadable body, or a caught JSON parse failure)', () => {
    expect(() => clipCompressionSettingsFromResponse(true, 200, null)).toThrow(
      'Clip upload settings are unavailable.'
    )
  })

  it('throws for a wrongly-shaped payload (an array, not an object)', () => {
    expect(() => clipCompressionSettingsFromResponse(true, 200, [1, 2, 3])).toThrow(
      'Clip upload settings are unavailable.'
    )
  })

  it('throws with the HTTP status for a non-OK response, even with a well-formed payload', () => {
    expect(() =>
      clipCompressionSettingsFromResponse(false, 503, { settings: { ui_settings: {} } })
    ).toThrow('Clip upload settings are unavailable (503).')
  })

  it('carries a different status through the same way (401)', () => {
    expect(() => clipCompressionSettingsFromResponse(false, 401, {})).toThrow(
      'Clip upload settings are unavailable (401).'
    )
  })
})
