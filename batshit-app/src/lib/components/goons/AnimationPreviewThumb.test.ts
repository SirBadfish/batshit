import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { get } from 'svelte/store'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { goonMotionPreviewGenerationCount } from '$lib/stores/goonMotionPreviewGeneration'
import AnimationPreviewThumb from './AnimationPreviewThumb.svelte'

const preview = vi.hoisted(() => ({
  init: vi.fn(),
  loadGoon: vi.fn(),
  loadCustom: vi.fn(),
  loadAvatar: vi.fn(),
  syncAnimations: vi.fn(),
  play: vi.fn(),
  dispose: vi.fn(),
  upload: vi.fn(),
  capture: vi.fn(),
  trackStop: vi.fn()
}))

vi.mock('$lib/goons/engine', () => ({
  GoonEngine: class {
    init = preview.init
    loadGoon = preview.loadGoon
    loadCustomGoon(...args: unknown[]) { return preview.loadCustom(this, ...args) }
    syncAnimations = preview.syncAnimations
    previewLoopAnimation = preview.play
    dispose = preview.dispose
    setMotionPreviewPurpose() {}
    setGoonVisible() {}
    private loadGeneration = 0
    beginGoonLoad() { return ++this.loadGeneration }
    isCurrentGoonLoad(token: number) { return token === this.loadGeneration }
    finishGoonLoad(_token: number) {}
    getAnimationNames() { return ['Wave'] }
    getCanvasElement() { return { captureStream: preview.capture } }
  }
}))
vi.mock('$lib/goons/customAvatar', () => ({
  resolveGoonAvatarUrl: (goon: any) => goon?.customAvatar?.model?.url ?? '',
  loadAvatarIntoEngine: preview.loadAvatar,
  loadCustomAvatarManifest: vi.fn()
}))
vi.mock('$lib/services/goons', () => ({ uploadGoonAnimationPreview: preview.upload }))

beforeEach(() => {
  preview.play.mockReturnValue(true)
  preview.init.mockResolvedValue(undefined)
  preview.loadGoon.mockResolvedValue(undefined)
  preview.loadCustom.mockResolvedValue('loaded')
  preview.loadAvatar.mockResolvedValue({ role: 'live' })
  preview.syncAnimations.mockResolvedValue(undefined)
  preview.upload.mockResolvedValue({ previewVideo: { url: '/wave-preview.webm', filename: 'wave-preview.webm' } })
  preview.capture.mockImplementation(() => ({ getTracks: () => [{ stop: preview.trackStop }] }))
  vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined)
  vi.spyOn(HTMLMediaElement.prototype, 'pause').mockImplementation(() => {})
  vi.stubGlobal('MediaRecorder', class {
    ondataavailable: ((event: { data: Blob }) => void) | null = null
    onstop: (() => void) | null = null
    onerror: (() => void) | null = null
    static isTypeSupported() { return true }
    start() { this.ondataavailable?.({ data: new Blob(['video']) }) }
    stop() { this.onstop?.() }
  })
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) =>
    setTimeout(() => callback(performance.now()), 0))
  vi.stubGlobal('IntersectionObserver', class {
    private callback: IntersectionObserverCallback
    constructor(callback: IntersectionObserverCallback) { this.callback = callback }
    observe() { this.callback([{ isIntersecting: true } as IntersectionObserverEntry], this as unknown as IntersectionObserver) }
    disconnect() {}
    unobserve() {}
  })
  vi.spyOn(Element.prototype, 'getBoundingClientRect').mockReturnValue({
    x: 0, y: 0, top: 0, left: 0, bottom: 164, right: 120,
    width: 120, height: 164, toJSON: () => ({})
  })
})

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.resetAllMocks()
})

describe('motion thumbnail failure ownership', () => {
  it('settles one failed attempt without automatically reserving again', async () => {
    preview.play.mockReturnValue(false)
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/test-failure.vrm' },
      animationFile: { url: '/wave.vrma', filename: 'wave.vrma' },
      animationName: 'Wave', previewId: 'wave'
    })
    try {
      await waitFor(() => expect(preview.play).toHaveBeenCalled())
      // Allow time for an unintended retry after the failure settles.
      await new Promise((resolve) => setTimeout(resolve, 100))
      expect(preview.play).toHaveBeenCalledTimes(1)
      expect(get(goonMotionPreviewGenerationCount)).toBe(0)
    } finally {
      view.unmount()
    }
  })

  it('retries only on explicit Refresh or a changed target or source', async () => {
    preview.play.mockReturnValue(false)
    const file = { url: '/retry-a.vrma', filename: 'retry-a.vrma' }
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/retry-a.vrm' }, animationFile: file,
      animationName: 'Wave', previewId: 'wave'
    })
    try {
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(1))
      await view.rerender({ previewTarget: { kind: 'vrm', url: '/retry-a.vrm' }, animationFile: { ...file } })
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(preview.play).toHaveBeenCalledTimes(1)
      await fireEvent.click(screen.getByRole('button', { name: 'Recreate motion preview video' }))
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await view.rerender({ previewTarget: { kind: 'vrm', url: '/retry-b.vrm' } })
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(3))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await view.rerender({ animationFile: { url: '/retry-b.vrma', filename: 'retry-b.vrma' } })
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(4))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(preview.play).toHaveBeenCalledTimes(4)
    } finally {
      view.unmount()
    }
  })

  it('does not let an old in-flight failure pin a later A-to-B-to-A owner', async () => {
    let rejectFirst: ((reason: Error) => void) | undefined
    preview.play.mockReturnValue(false)
    preview.syncAnimations.mockImplementationOnce(() => new Promise<void>((_, reject) => { rejectFirst = reject }))
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/stale-a.vrm' },
      animationFile: { url: '/stale.vrma', filename: 'stale.vrma' }, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(preview.syncAnimations).toHaveBeenCalledTimes(1))
      await view.rerender({ previewTarget: { kind: 'vrm', url: '/stale-b.vrm' } })
      await view.rerender({ previewTarget: { kind: 'vrm', url: '/stale-a.vrm' } })
      rejectFirst?.(new Error('old owner failure'))
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      expect(screen.queryByTitle('old owner failure')).toBeNull()
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(preview.play).toHaveBeenCalledTimes(1)
    } finally {
      view.unmount()
    }
  })

  it('retries and reloads a changed custom target even when its model URL is unchanged', async () => {
    preview.play.mockReturnValue(false)
    const goon = { id: 'goon', user_id: 'owner', kind: 'custom', files: {},
      customAvatar: { model: { url: '/same-model.glb', filename: 'same-model.glb' },
        manifest: { url: '/same-manifest.json', filename: 'same-manifest.json' } },
      appearanceDials: { values: { leg_length: 0 } }, created_at: '', updated_at: '' }
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'custom', goon: goon as any },
      animationFile: { url: '/custom.glb', filename: 'custom.glb' }, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await view.rerender({ previewTarget: { kind: 'custom', goon: { ...goon,
        appearanceDials: { values: { leg_length: 0.25 } } } as any } })
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(2))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      expect(preview.loadAvatar).toHaveBeenCalledTimes(2)
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(preview.play).toHaveBeenCalledTimes(2)
    } finally { view.unmount() }
  })

  it('settles coalesced failures and accepts an externally supplied preview', async () => {
    let reject: ((reason: Error) => void) | undefined
    preview.syncAnimations.mockImplementationOnce(() => new Promise<void>((_, rejectPromise) => { reject = rejectPromise }))
    const props = { previewTarget: { kind: 'vrm' as const, url: '/shared.vrm' },
      animationFile: { url: '/shared.vrma', filename: 'shared.vrma' }, animationName: 'Wave' }
    const first = render(AnimationPreviewThumb, props), second = render(AnimationPreviewThumb, props)
    try {
      await waitFor(() => expect(preview.syncAnimations).toHaveBeenCalledTimes(1))
      expect(get(goonMotionPreviewGenerationCount)).toBe(2)
      reject?.(new Error('not available'))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(preview.syncAnimations).toHaveBeenCalledTimes(1)
      await first.rerender({ animationFile: { ...props.animationFile,
        previewVideo: { url: '/saved.webm', filename: 'saved.webm' } } })
      await waitFor(() => expect(first.container.querySelector('video')?.getAttribute('src')).toBe('/saved.webm'))
      expect(preview.syncAnimations).toHaveBeenCalledTimes(1)
    } finally { first.unmount(); second.unmount() }
  })

  it('keeps a newly supplied preview when an older automatic attempt fails', async () => {
    let reject: ((reason: Error) => void) | undefined
    preview.syncAnimations.mockImplementationOnce(() => new Promise<void>((_, rejectPromise) => { reject = rejectPromise }))
    const file = { url: '/external.vrma', filename: 'external.vrma' }
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/external.vrm' }, animationFile: file, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(preview.syncAnimations).toHaveBeenCalledTimes(1))
      await view.rerender({ animationFile: { ...file, previewVideo: { url: '/external.webm', filename: 'external.webm' } } })
      reject?.(new Error('old automatic failure'))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      expect(view.container.querySelector('video')?.getAttribute('src')).toBe('/external.webm')
      expect(screen.queryByTitle('old automatic failure')).toBeNull()
      expect(preview.syncAnimations).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  })

  it('treats a current load that returns no video as a settled failure', async () => {
    preview.loadCustom.mockImplementationOnce(async (engine: any) => { engine.beginGoonLoad() })
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'custom-url', modelUrl: '/empty.glb', manifestUrl: '/empty.json' },
      animationFile: { url: '/empty-animation.glb', filename: 'empty-animation.glb' }, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(preview.loadCustom).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      await new Promise((resolve) => setTimeout(resolve, 50))
      expect(preview.loadCustom).toHaveBeenCalledTimes(1)
      expect(screen.getByText('Preview unavailable')).toBeTruthy()
    } finally { view.unmount() }
  })

  it('does not reserve without a target and can start when a target arrives', async () => {
    preview.play.mockReturnValue(false)
    const view = render(AnimationPreviewThumb, {
      previewTarget: null, previewUnavailableReason: 'Choose a preview Goon',
      animationFile: { url: '/missing.vrma', filename: 'missing.vrma' }, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(screen.getByText('Choose a preview Goon')).toBeTruthy())
      expect(get(goonMotionPreviewGenerationCount)).toBe(0)
      expect(preview.play).not.toHaveBeenCalled()
      await view.rerender({ previewTarget: { kind: 'vrm', url: '/arrived.vrm' }, previewUnavailableReason: '' })
      await waitFor(() => expect(preview.play).toHaveBeenCalledTimes(1))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
    } finally { view.unmount() }
  })

  it('keeps successful capture and upload available for an unmanaged target', async () => {
    preview.play.mockReturnValue(true)
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/successful.vrm' },
      animationFile: { url: '/success.vrma', filename: 'success.vrma' }, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(preview.upload).toHaveBeenCalledTimes(1), { timeout: 5000 })
      await waitFor(() => expect(view.container.querySelector('video')?.getAttribute('src')).toBe('/wave-preview.webm'))
      expect(preview.trackStop).toHaveBeenCalledTimes(1)
      expect(get(goonMotionPreviewGenerationCount)).toBe(0)
    } finally { view.unmount() }
  }, 8000)

  it('lets a remaining shared subscriber use an upload already issued by a destroyed owner', async () => {
    let finishUpload: ((result: { previewVideo: { url: string; filename: string } }) => void) | undefined
    preview.play.mockReturnValue(true)
    preview.upload.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve }))
    const props = { previewTarget: { kind: 'vrm' as const, url: '/shared-upload.vrm' },
      animationFile: { url: '/shared-upload.vrma', filename: 'shared-upload.vrma' }, animationName: 'Wave' }
    const first = render(AnimationPreviewThumb, props), second = render(AnimationPreviewThumb, props)
    try {
      await waitFor(() => expect(preview.upload).toHaveBeenCalledTimes(1), { timeout: 5000 })
      first.unmount()
      finishUpload?.({ previewVideo: { url: '/shared-saved.webm', filename: 'shared-saved.webm' } })
      await waitFor(() => expect(second.container.querySelector('video')?.getAttribute('src')).toBe('/shared-saved.webm'))
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      expect(preview.upload).toHaveBeenCalledTimes(1)
      expect(preview.play).toHaveBeenCalledTimes(1)
    } finally { second.unmount() }
  }, 8000)

  it('keeps a supplied preview that arrives after an automatic upload was issued', async () => {
    let finishUpload: ((result: { previewVideo: { url: string; filename: string } }) => void) | undefined
    preview.play.mockReturnValue(true)
    preview.upload.mockImplementationOnce(() => new Promise((resolve) => { finishUpload = resolve }))
    const file = { url: '/late-external.vrma', filename: 'late-external.vrma' }
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/late-external.vrm' }, animationFile: file, animationName: 'Wave'
    })
    try {
      await waitFor(() => expect(preview.upload).toHaveBeenCalledTimes(1), { timeout: 5000 })
      await view.rerender({ animationFile: { ...file,
        previewVideo: { url: '/supplied.webm', filename: 'supplied.webm' } } })
      finishUpload?.({ previewVideo: { url: '/older-upload.webm', filename: 'older-upload.webm' } })
      await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
      expect(view.container.querySelector('video')?.getAttribute('src')).toBe('/supplied.webm')
      expect(preview.upload).toHaveBeenCalledTimes(1)
    } finally { view.unmount() }
  }, 8000)

  it('stops owned capture tracks and releases the reservation after unmount', async () => {
    preview.play.mockReturnValue(true)
    const view = render(AnimationPreviewThumb, {
      previewTarget: { kind: 'vrm', url: '/unmount.vrm' },
      animationFile: { url: '/unmount.vrma', filename: 'unmount.vrma' }, animationName: 'Wave'
    })
    await waitFor(() => expect(preview.capture).toHaveBeenCalledTimes(1), { timeout: 2000 })
    view.unmount()
    await waitFor(() => expect(preview.trackStop).toHaveBeenCalledTimes(1), { timeout: 4000 })
    await waitFor(() => expect(get(goonMotionPreviewGenerationCount)).toBe(0))
    expect(preview.upload).not.toHaveBeenCalled()
  }, 8000)
})
