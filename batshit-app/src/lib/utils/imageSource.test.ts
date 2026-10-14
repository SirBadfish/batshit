import { describe, expect, it } from 'vitest'
import { addressCarriesData, classifyImageSource, type ImageSourceContext } from './imageSource'

const context: ImageSourceContext = {
  baseUrl: 'http://localhost:5173/',
  serverUrls: ['http://localhost:5600']
}

const kind = (value: string, extra: Partial<ImageSourceContext> = {}) =>
  classifyImageSource(value, { ...context, ...extra })

describe('classifyImageSource (BL-474 step 1)', () => {
  it('owns an upload on the configured Batshit server', () => {
    expect(kind('http://localhost:5600/uploads/images/a.png')).toEqual({
      kind: 'owned',
      url: 'http://localhost:5600/uploads/images/a.png',
      owner: 'upload'
    })
  })

  it('resolves a canonical relative upload path against the configured server', () => {
    expect(kind('/uploads/images/a.png')).toEqual({
      kind: 'owned',
      url: 'http://localhost:5600/uploads/images/a.png',
      owner: 'upload'
    })
  })

  it('treats /uploads/ on another website as outside, never as an upload', () => {
    const result = kind('https://pictures.example.org/uploads/images/a.png')
    expect(result).toMatchObject({ kind: 'outside', host: 'pictures.example.org' })
    expect(kind('//pictures.example.org/uploads/a.png')).toMatchObject({ kind: 'outside', host: 'pictures.example.org' })
  })

  it('treats a non-upload path on the Batshit server or the app itself as outside', () => {
    expect(kind('http://localhost:5600/api/v1/thing.png')).toMatchObject({ kind: 'outside', host: 'localhost' })
    expect(kind('/api/sessions/x.png')).toMatchObject({ kind: 'outside', url: 'http://localhost:5173/api/sessions/x.png' })
  })

  it('owns an address from a Clip record the server returned, whatever its shape', () => {
    expect(kind('https://tunnel.example.net/clip/a.png', { fromTrustedClip: true })).toMatchObject({ kind: 'owned', owner: 'clip' })
  })

  it('owns raster data images but not SVG or other data', () => {
    expect(kind('data:image/png;base64,AAAA')).toMatchObject({ kind: 'owned', owner: 'data' })
    expect(kind('DATA:image/JPEG;base64,AAAA')).toMatchObject({ kind: 'owned', owner: 'data' })
    expect(kind('data:image/svg+xml;base64,AAAA')).toMatchObject({ kind: 'unsupported' })
    expect(kind('data:text/html,hello')).toMatchObject({ kind: 'unsupported' })
    expect(kind('data:image/svg+xml,x', { fromTrustedClip: true })).toMatchObject({ kind: 'unsupported' })
  })

  it('never owns a blob address', () => {
    expect(kind('blob:http://localhost:5173/1111-2222')).toMatchObject({ kind: 'unsupported' })
  })

  it('does not own a relative upload path whose dot segments leave /uploads/', () => {
    expect(kind('/uploads/../api/v1/secret.png')).toMatchObject({ kind: 'outside', url: 'http://localhost:5600/api/v1/secret.png' })
    expect(kind('/uploads/%2e%2e/api/x.png')).toMatchObject({ kind: 'outside' })
    expect(kind('/uploads/images/./a.png')).toMatchObject({ kind: 'owned', url: 'http://localhost:5600/uploads/images/a.png' })
  })

  it('refuses other schemes, empty text, and text that is not an address', () => {
    expect(kind('')).toMatchObject({ kind: 'unsupported' })
    expect(kind('ftp://example.org/a.png')).toMatchObject({ kind: 'unsupported' })
    expect(kind('file:///tmp/a.png')).toMatchObject({ kind: 'unsupported' })
    expect(kind('http://[bad')).toMatchObject({ kind: 'unsupported' })
  })

  it('does not trust an upload path when no Batshit server is configured', () => {
    expect(kind('/uploads/a.png', { serverUrls: [] })).toMatchObject({ kind: 'outside', host: 'localhost' })
  })

  it('names the website and whether the address carries extra data', () => {
    expect(kind('https://images.example.com/cat.png')).toEqual({
      kind: 'outside',
      url: 'https://images.example.com/cat.png',
      host: 'images.example.com',
      carriesData: false
    })
    expect(kind('https://images.example.com/cat.png?q=1')).toMatchObject({ carriesData: true })
  })
})

describe('addressCarriesData', () => {
  const carries = (value: string) => addressCarriesData(new URL(value))

  it('is false for a plain picture address', () => {
    expect(carries('https://example.com/pictures/cat.png')).toBe(false)
    expect(carries('https://example.com/a/b/c/photo-of-a-cat-in-a-hat.jpeg')).toBe(false)
    expect(carries('https://example.com/pictures/cat.png?')).toBe(false)
  })

  it('is true for a query string, a fragment, or a user name', () => {
    expect(carries('https://example.com/cat.png?x=1')).toBe(true)
    expect(carries('https://example.com/cat.png#part')).toBe(true)
    expect(carries('https://someone@example.com/cat.png')).toBe(true)
  })

  it('is true for a path part or host name part that looks like encoded data', () => {
    expect(carries('https://example.com/p/aGVsbG8gd29ybGQgaGVsbG8gd29ybGQ')).toBe(true)
    expect(carries('https://example.com/p/0123456789abcdef0123456789abcdef')).toBe(true)
    expect(carries('https://example.com/p/%48%65%6c%6c%6f%20%57%6f%72%6c%64%21%21')).toBe(true)
    expect(carries('https://aGVsbG8gd29ybGQgaGVsbG8gd29y.example.com/cat.png')).toBe(true)
  })

  it('reads a long file name with an extension as a file name', () => {
    expect(carries('https://example.com/p/0123456789abcdef0123456789abcdef.png')).toBe(false)
  })
})
