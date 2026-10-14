import { SRGBColorSpace, VideoTexture } from 'three'

export function isSkyboxVideo(url: string, mimeType?: string): boolean {
  if (mimeType?.startsWith('video/')) return true
  return /\.(mp4|webm)(?:[?#]|$)/i.test(url)
}

export type SkyboxVideo = {
  texture: VideoTexture
  isPlaying(): boolean
  setPaused(paused: boolean): void
  dispose(): void
}

/** Own the decoder, texture and listeners as one resource, including aborted loads. */
export async function loadSkyboxVideo(
  url: string,
  options: { signal: AbortSignal; maxTextureSize: number; paused: boolean; onError: (message: string) => void }
): Promise<SkyboxVideo> {
  const video = document.createElement('video')
  video.muted = true
  video.defaultMuted = true
  video.loop = true
  video.playsInline = true
  video.crossOrigin = 'anonymous'
  video.preload = 'auto'
  let disposed = false
  let paused = options.paused
  let texture: VideoTexture | null = null
  const message = 'The panorama video could not be played. Try a supported MP4 or WebM, or a smaller 4K export.'
  const onPlaybackError = () => options.onError(message)
  const dispose = () => {
    if (disposed) return
    disposed = true
    options.signal.removeEventListener('abort', dispose)
    video.removeEventListener('error', onPlaybackError)
    video.pause()
    video.removeAttribute('src')
    video.load()
    texture?.dispose()
  }
  try {
    await new Promise<void>((resolve, reject) => {
      const finish = (error?: Error) => {
        clearTimeout(timeout)
        video.removeEventListener('loadeddata', onReady)
        video.removeEventListener('error', onError)
        options.signal.removeEventListener('abort', onAbort)
        error ? reject(error) : resolve()
      }
      const onReady = () => finish()
      const onError = () => finish(new Error(message))
      const onAbort = () => finish(new DOMException('Panorama load cancelled', 'AbortError'))
      const timeout = setTimeout(() => finish(new Error('The panorama video took too long to load. Try a smaller export.')), 60_000)
      video.addEventListener('loadeddata', onReady)
      video.addEventListener('error', onError)
      options.signal.addEventListener('abort', onAbort, { once: true })
      if (options.signal.aborted) { onAbort(); return }
      video.src = url
      video.load()
    })
    if (video.videoWidth < 2 || video.videoHeight < 1 || Math.abs(video.videoWidth / video.videoHeight - 2) > .02) {
      throw new Error('Panorama videos must be 2:1 equirectangular videos, such as 4096 × 2048.')
    }
    if (options.maxTextureSize > 0 && Math.max(video.videoWidth, video.videoHeight) > options.maxTextureSize) {
      throw new Error(`This device supports panorama textures up to ${options.maxTextureSize}px. Choose a smaller video export.`)
    }
    texture = new VideoTexture(video)
    texture.colorSpace = SRGBColorSpace
    options.signal.addEventListener('abort', dispose, { once: true })
    video.addEventListener('error', onPlaybackError)
    if (!options.paused) await video.play()
    if (options.signal.aborted) throw new DOMException('Panorama load cancelled', 'AbortError')
    return {
      texture,
      isPlaying: () => !disposed && !paused && !video.paused && !video.ended,
      setPaused(nextPaused) {
        if (disposed) return
        paused = nextPaused
        if (paused) video.pause()
        else void video.play().catch(() => { if (!disposed && !paused) onPlaybackError() })
      },
      dispose
    }
  } catch (error) {
    dispose()
    throw error instanceof DOMException && error.name === 'AbortError'
      ? error
      : new Error(error instanceof Error ? error.message : message)
  }
}
