import { describe, expect, it } from 'vitest'
import {
  getClipExtensionLabel,
  getClipFileIconName,
  resolveClipContextTokens
} from './clipPresentation'

describe('clipPresentation', () => {
  it('prefers local token estimates for text-like clips', () => {
    expect(
      resolveClipContextTokens({
        filename: 'setup-notes.sh',
        mimeType: 'text/plain',
        externalTokens: 765,
        localTokens: 1210,
        storageMode: 'local'
      })
    ).toBe(1210)
  })

  it('prefers external token estimates for image clips', () => {
    expect(
      resolveClipContextTokens({
        filename: 'eye-contact.png',
        mimeType: 'image/png',
        externalTokens: 765,
        localTokens: 14400,
        storageMode: 'local'
      })
    ).toBe(765)
  })

  it('uses structured-image tokens for local images with legacy base64 estimates', () => {
    expect(
      resolveClipContextTokens({
        filename: 'ss-3.jpg',
        mimeType: 'image/jpeg',
        localTokens: 28800,
        storageMode: 'local'
      })
    ).toBe(765)
  })

  it('treats extensionless system clips as markdown for icon presentation', () => {
    const iconName = getClipFileIconName({
      filename: 'Goon Guide',
      mimeType: 'text/markdown',
      systemClip: true
    })

    expect(iconName).toBe('Goon Guide.md')
    expect(getClipExtensionLabel({ filename: iconName })).toBe('.md')
  })
})
