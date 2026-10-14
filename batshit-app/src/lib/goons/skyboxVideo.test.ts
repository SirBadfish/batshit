// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isSkyboxVideo, loadSkyboxVideo } from './skyboxVideo'

afterEach(() => vi.restoreAllMocks())

function setup(width = 4096, height = 2048) {
  const element = document.createElement('video')
  Object.defineProperty(element, 'videoWidth', { value: width })
  Object.defineProperty(element, 'videoHeight', { value: height })
  let paused = true
  Object.defineProperty(element, 'paused', { get: () => paused })
  const play = vi.spyOn(element, 'play').mockImplementation(async () => { paused = false })
  const pause = vi.spyOn(element, 'pause').mockImplementation(() => { paused = true })
  vi.spyOn(element, 'load').mockImplementation(() => {})
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) => tag === 'video' ? element : create(tag, options)) as typeof document.createElement)
  const abort = new AbortController()
  const onError = vi.fn()
  const options = { signal: abort.signal, maxTextureSize: 8192, paused: false, onError }
  return { element, play, pause, abort, options, onError }
}

describe('panorama video lifecycle', () => {
  it('uses MIME metadata for opaque asset URLs and recognizes MP4/WebM paths', () => {
    expect(isSkyboxVideo('/api/uploads/opaque-id', 'video/mp4')).toBe(true)
    expect(isSkyboxVideo('/city.WEBM?download=1')).toBe(true)
    expect(isSkyboxVideo('/city.png', 'image/png')).toBe(false)
  })

  it('loops silently, pauses with the stage, and releases the decoder when disposed', async () => {
    const { element, play, pause, options } = setup()
    const pending = loadSkyboxVideo('/city.mp4', options)
    element.dispatchEvent(new Event('loadeddata'))
    const resource = await pending
    expect(element.muted && element.loop && element.playsInline).toBe(true)
    expect(play).toHaveBeenCalledTimes(1)
    expect(resource.isPlaying()).toBe(true)
    resource.setPaused(true)
    expect(pause).toHaveBeenCalled()
    expect(resource.isPlaying()).toBe(false)
    resource.setPaused(false)
    expect(play).toHaveBeenCalledTimes(2)
    expect(resource.isPlaying()).toBe(true)
    const disposed = vi.fn()
    resource.texture.addEventListener('dispose', disposed)
    resource.dispose()
    resource.dispose()
    expect(disposed).toHaveBeenCalledTimes(1)
    expect(element.hasAttribute('src')).toBe(false)
    expect(resource.isPlaying()).toBe(false)
  })

  it('cancels a superseded load and removes the source', async () => {
    const { element, abort, options } = setup()
    const pending = loadSkyboxVideo('/old.mp4', options)
    abort.abort()
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' })
    expect(element.hasAttribute('src')).toBe(false)
  })

  it('rejects wrong projection dimensions', async () => {
    const { element, options } = setup(1920, 1080)
    const pending = loadSkyboxVideo('/flat.mp4', options)
    element.dispatchEvent(new Event('loadeddata'))
    await expect(pending).rejects.toThrow('2:1')
    expect(element.hasAttribute('src')).toBe(false)
  })

  it('rejects a video larger than the actual device texture limit', async () => {
    const { element, options } = setup(8192, 4096)
    const pending = loadSkyboxVideo('/8k.mp4', { ...options, maxTextureSize: 4096 })
    element.dispatchEvent(new Event('loadeddata'))
    await expect(pending).rejects.toThrow('up to 4096px')
    expect(element.hasAttribute('src')).toBe(false)
  })

  it('loads a paused stage without starting playback', async () => {
    const { element, play, options } = setup()
    const pending = loadSkyboxVideo('/city.mp4', { ...options, paused: true })
    element.dispatchEvent(new Event('loadeddata'))
    const resource = await pending
    expect(play).not.toHaveBeenCalled()
    expect(resource.isPlaying()).toBe(false)
    resource.dispose()
  })

  it('reports playback failure after loading, including a rejected resume', async () => {
    const { element, play, options, onError } = setup()
    const pending = loadSkyboxVideo('/city.mp4', options)
    element.dispatchEvent(new Event('loadeddata'))
    const resource = await pending
    resource.setPaused(true)
    play.mockRejectedValueOnce(new Error('codec failure'))
    resource.setPaused(false)
    await Promise.resolve()
    expect(onError).toHaveBeenCalledTimes(1)
    element.dispatchEvent(new Event('error'))
    expect(onError).toHaveBeenCalledTimes(2)
    resource.dispose()
    element.dispatchEvent(new Event('error'))
    expect(onError).toHaveBeenCalledTimes(2)
  })
})
