// @vitest-environment happy-dom
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GoonEngine } from './engine'
import { loadSkyboxVideo } from './skyboxVideo'

afterEach(() => vi.restoreAllMocks())

async function videoStage() {
  const video = document.createElement('video')
  Object.defineProperty(video, 'videoWidth', { value: 4096 })
  Object.defineProperty(video, 'videoHeight', { value: 2048 })
  let paused = true
  Object.defineProperty(video, 'paused', { get: () => paused })
  vi.spyOn(video, 'play').mockImplementation(async () => { paused = false })
  vi.spyOn(video, 'pause').mockImplementation(() => { paused = true })
  vi.spyOn(video, 'load').mockImplementation(() => {})
  const create = document.createElement.bind(document)
  vi.spyOn(document, 'createElement').mockImplementation(((tag: string, options?: ElementCreationOptions) =>
    tag === 'video' ? video : create(tag, options)) as typeof document.createElement)
  const pending = loadSkyboxVideo('/city.mp4', {
    signal: new AbortController().signal, maxTextureSize: 8192, paused: false, onError: vi.fn()
  })
  video.dispatchEvent(new Event('loadeddata'))
  const resource = await pending
  const engine = new GoonEngine(document.createElement('div')) as any
  engine.skyboxVideo = resource
  engine.skyboxActive = true
  engine.lastFrameTime = 0
  engine.targetFrameIntervalMs = 1000 / 60
  const render = vi.fn()
  engine.renderer = { render, autoClear: true }
  let now = 0
  vi.spyOn(performance, 'now').mockImplementation(() => now)
  const frame = (time: number) => { now = time; engine.update() }
  return { engine, resource, render, frame }
}

describe('panorama video stage cadence', () => {
  it('renders a video-only stage at active cadence, returning to idle when paused or disposed', async () => {
    const { resource, render, frame } = await videoStage()
    try {
      frame(20)
      frame(40)
      expect(render).toHaveBeenCalledTimes(2)
      resource.setPaused(true)
      frame(60)
      expect(render).toHaveBeenCalledTimes(2)
      frame(90)
      expect(render).toHaveBeenCalledTimes(3)
      resource.setPaused(false)
      frame(110)
      expect(render).toHaveBeenCalledTimes(4)
      resource.dispose()
      frame(130)
      expect(render).toHaveBeenCalledTimes(4)
      frame(160)
      expect(render).toHaveBeenCalledTimes(5)
    } finally {
      resource.dispose()
    }
  })

  it('respects the configured frame limit and retains idle behavior after video removal', async () => {
    const { engine, resource, render, frame } = await videoStage()
    try {
      engine.targetFrameIntervalMs = 1000 / 30
      frame(20)
      expect(render).not.toHaveBeenCalled()
      frame(34)
      expect(render).toHaveBeenCalledTimes(1)
      engine.clearSkybox()
      frame(68)
      expect(render).toHaveBeenCalledTimes(1)
      frame(84)
      expect(render).toHaveBeenCalledTimes(2)
    } finally {
      resource.dispose()
    }
  })
})
