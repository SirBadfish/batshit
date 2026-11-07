import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import * as THREE from 'three'
import { WebGPURenderer } from 'three/webgpu'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { GoonEngine } from './engine'
import { LipArtworkEngineRuntime } from './lipArtwork.engine'
import { parseLipArtworkDefinition } from './lipArtwork'
import type { GoonCustomAvatarManifest } from './customAvatar'
import { loadAvatarIntoEngine } from './customAvatar'
import type { GoonRecord } from '$lib/types/goons'
import { createRecipePhysicalMigrationFixture } from './recipe/fixtures/recipePhysicalMigrationPair'

function deferred<T>() {
  let resolvePromise!: (value: T) => void
  let rejectPromise!: (error: unknown) => void
  const promise = new Promise<T>((resolve, reject) => {
    resolvePromise = resolve
    rejectPromise = reject
  })
  return { promise, resolve: resolvePromise, reject: rejectPromise }
}

function renderer() {
  return {
    domElement: document.createElement('canvas'),
    setAnimationLoop: vi.fn(),
    dispose: vi.fn()
  }
}

function engineFixture(paused = false) {
  const engine = new GoonEngine(document.createElement('div')) as any
  engine.renderer = renderer()
  engine.paused = paused
  return engine
}

function vrmGoon(url: string, manifestUrl?: string): GoonRecord {
  return {
    id: 'lifetime-goon', user_id: 'lifetime-user', name: 'Lifetime Goon',
    created_at: '2026-10-14T00:00:00Z', updated_at: '2026-10-14T00:00:00Z',
    sourceProfile: manifestUrl ? 'guided-custom-vrm' : 'standard-vrm',
    files: { vrm: { url, filename: 'model.vrm' }, animations: [] },
    ...(manifestUrl ? { guidedAvatar: { manifest: { url: manifestUrl, filename: 'manifest.json' } } } : {})
  }
}

async function nextTask() {
  await new Promise((resolveTask) => setTimeout(resolveTask, 0))
}

afterEach(() => {
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

describe('GoonEngine asynchronous avatar-load lifecycle', () => {
  it('does not attach a late Hair candidate after its caller target changes', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({ runtimePreviewCompatible: true })
    const engine = engineFixture()
    const root = new THREE.Group()
    const head = new THREE.Bone()
    head.name = 'HeadAnchor'
    root.add(head)
    engine.customAvatarRoot = root
    engine.customAvatarManifest = fixture.source.avatarManifest
    engine.customHairAttachmentRestMatrix = new THREE.Matrix4()
    const previous = new THREE.Group()
    head.add(previous)
    engine.hairPreviewRoot = previous

    const geometry = deferred<any>()
    const loader = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValueOnce(geometry.promise)
    const candidate = new THREE.Group()
    const meshGeometry = new THREE.BufferGeometry()
    meshGeometry.setAttribute('position', new THREE.Float32BufferAttribute([0, 0, 0, 1, 0, 0, 0, 1, 0], 3))
    const material = new THREE.MeshStandardMaterial()
    candidate.add(new THREE.Mesh(meshGeometry, material))
    const disposeGeometry = vi.spyOn(meshGeometry, 'dispose')
    const disposeMaterial = vi.spyOn(material, 'dispose')
    let current = true
    const guard = () => { if (!current) throw new Error('target changed') }
    const loading = engine.loadHairPreviewCandidate('late.glb', null, null, (ref: string) => ref, guard)
    current = false
    geometry.resolve({ scene: candidate, scenes: [candidate], animations: [] })

    await expect(loading).rejects.toThrow('target changed')
    expect(candidate.parent).toBeNull()
    expect(disposeGeometry).toHaveBeenCalledTimes(1)
    expect(disposeMaterial).toHaveBeenCalledTimes(1)
    expect(engine.hairPreviewRoot).toBe(previous)
    expect(previous.parent).toBe(head)

    const next = new THREE.Group()
    next.add(new THREE.Mesh(new THREE.BufferGeometry(), new THREE.MeshStandardMaterial()))
    loader.mockResolvedValueOnce({ scene: next, scenes: [next], animations: [] } as any)
    current = true
    await expect(engine.loadHairPreviewCandidate('current.glb', null, null, (ref: string) => ref, guard))
      .resolves.toBeTruthy()
    expect(engine.hairPreviewRoot).toBe(next)
    expect(next.parent).toBe(head)
  })

  it('does not publish a renderer when disposal wins an in-flight initialization', async () => {
    const initialization = deferred<void>()
    const initializeRenderer = vi
      .spyOn(WebGPURenderer.prototype, 'init')
      .mockReturnValue(initialization.promise)
    const disposeRenderer = vi
      .spyOn(WebGPURenderer.prototype, 'dispose')
      .mockImplementation(() => {})
    const container = document.createElement('div')
    const engine = new GoonEngine(container) as any
    const setRuntimeStatus = vi.spyOn(engine, 'setRuntimeStatus')

    const initializing = engine.init()
    expect(initializeRenderer).toHaveBeenCalledTimes(1)
    engine.dispose()
    initialization.resolve()

    await expect(initializing).rejects.toThrow('Goon engine has been disposed.')
    expect(disposeRenderer).toHaveBeenCalledTimes(1)
    expect(setRuntimeStatus).not.toHaveBeenCalled()
    expect(engine.renderer).toBeUndefined()
    expect(container.querySelector('canvas')).toBeNull()
    await expect(engine.init()).rejects.toThrow('Goon engine has been disposed.')
  })

  it.each(['model', 'animation'] as const)('aborts only its owned same-URL %s fetch, leaving the actual Three FileLoader borrower alive', async stage => {
    const engine = engineFixture(true)
    const abort = new AbortController()
    const url = `https://preview.test/independent-${stage}.glb`
    const requests: Array<{ signal?: AbortSignal; finish: () => void }> = []
    const payload = JSON.stringify({ asset: { version: '2.0' }, scenes: [{ nodes: [] }], scene: 0, nodes: [] })
    const fetcher = vi.fn((input: RequestInfo | URL, init?: RequestInit) => new Promise<Response>((resolveResponse, reject) => {
      const signal = init?.signal ?? (input instanceof Request ? input.signal : undefined)
      const finish = () => resolveResponse(new Response(payload, { status: 200, headers: { 'Content-Type': 'application/json' } }))
      requests.push({ signal: signal ?? undefined, finish })
      if (signal?.aborted) reject(signal.reason)
      else signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
    }))
    vi.stubGlobal('fetch', fetcher)
    // This unowned request uses the actual GLTFLoader/FileLoader global URL
    // queue. The canceled preview must neither join nor abort its transport.
    const other = new GLTFLoader().loadAsync(url)
    const owned = stage === 'model'
      ? engine.loadCustomGoon(url, {} as GoonCustomAvatarManifest, { signal: abort.signal })
      : (() => { engine.customAvatarRoot = new THREE.Group(); return engine.syncAnimations([{ url, filename: 'probe.glb' }], { signal: abort.signal }) })()
    const observed = owned.catch((error: unknown) => error)
    await nextTask()
    expect(fetcher).toHaveBeenCalledTimes(2)
    expect(requests[1]!.signal).toBe(abort.signal)
    abort.abort(new DOMException('Cancel only this preview.', 'AbortError'))
    const result = await observed
    if (stage === 'animation') expect(result).toMatchObject({ name: 'AbortError' })
    else expect(result).toBeUndefined()
    expect(requests[0]!.signal?.aborted).toBe(false)
    requests[0]!.finish()
    expect((await other).scene).toBeInstanceOf(THREE.Group)
    expect(engine.getAnimationNames()).not.toContain('canceled-preview-motion')
    engine.dispose()
  })

  it.each(['model', 'animation'] as const)('settles an owned %s body after Cancel without beginning a new parse', async stage => {
    const engine = engineFixture(true), body = deferred<ArrayBuffer>(), abort = new AbortController()
    const parse = vi.spyOn(GLTFLoader.prototype, 'parseAsync').mockResolvedValue({ scene: new THREE.Group(), animations: [] } as any)
    const readBody = vi.fn(() => body.promise)
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: true, arrayBuffer: readBody }))
    const pending = stage === 'model'
      ? engine.loadCustomGoon('https://preview.test/body-model.glb', {} as GoonCustomAvatarManifest, { signal: abort.signal })
      : (() => { engine.customAvatarRoot = new THREE.Group(); return engine.syncAnimations([{ url: 'https://preview.test/body-motion.glb', filename: 'motion.glb' }], { signal: abort.signal }) })()
    let settled = false
    const observed = pending.catch((error: unknown) => error).then((value: unknown) => { settled = true; return value })
    await nextTask()
    expect(readBody).toHaveBeenCalledOnce()
    abort.abort(new DOMException('Cancel owned body.', 'AbortError'))
    await nextTask()
    expect(settled).toBe(false)
    body.resolve(new ArrayBuffer(4))
    const result = await observed
    if (stage === 'animation') expect(result).toMatchObject({ name: 'AbortError' })
    else expect(result).toBeUndefined()
    expect(parse).not.toHaveBeenCalled()
    engine.dispose()
  })

  it.each(['model', 'animation'] as const)('fences a canceled staged %s load before late completion can replace restored state', async stage => {
    const engine = engineFixture(true)
    const completion = deferred<any>()
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(completion.promise)
    const disposeScene = vi.spyOn(engine, 'disposeObject3D').mockImplementation(() => {})
    const abort = new AbortController()
    abort.signal.addEventListener('abort', () => engine.unloadGoon(), { once: true })
    let loading: Promise<unknown>
    if (stage === 'model') {
      loading = engine.loadCustomGoon('/candidate.glb', {} as GoonCustomAvatarManifest)
    } else {
      engine.customAvatarRoot = new THREE.Group()
      loading = engine.syncAnimations([{ url: '/candidate-motion.glb', filename: 'candidate-motion.glb' }])
    }
    await nextTask()
    abort.abort()
    const generation = engine.goonLoadToken
    const restoredRoot = new THREE.Group()
    engine.customAvatarRoot = restoredRoot
    const originalNames = engine.getAnimationNames()
    const lateScene = new THREE.Group()
    const lateClip = new THREE.AnimationClip('canceled-preview-motion', 1, [])
    completion.resolve({ scene: lateScene, scenes: [lateScene], animations: [lateClip] })
    await loading
    expect(engine.goonLoadToken).toBe(generation)
    expect(engine.customAvatarRoot).toBe(restoredRoot)
    expect(engine.getAnimationNames()).toEqual(originalNames)
    expect(engine.getAnimationNames()).not.toContain('canceled-preview-motion')
    if (stage === 'model') expect(disposeScene.mock.calls.filter(([scene]) => scene === lateScene)).toHaveLength(1)
    engine.dispose()
  })

  it('disposal invalidates and disposes a model that finishes loading late', async () => {
    const engine = engineFixture(true)
    const geometry = deferred<any>()
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(geometry.promise)
    const disposeScene = vi.spyOn(engine, 'disposeObject3D').mockImplementation(() => {})
    const loading = engine.loadCustomGoon('late.glb', {} as GoonCustomAvatarManifest)
    await nextTask()

    engine.dispose()
    const lateScene = new THREE.Group()
    geometry.resolve({ scene: lateScene, scenes: [lateScene], animations: [] })
    await expect(loading).resolves.toBeUndefined()
    expect(disposeScene).toHaveBeenCalledWith(lateScene)
  })

  it('does not publish an appearance runtime after its load owner is replaced', async () => {
    const engine = engineFixture(true)
    const definition = parseLipArtworkDefinition(
      JSON.parse(
        readFileSync(
          resolve(process.cwd(), 'static/goons/lip-artwork/v2/lip-artwork-v2.json'),
          'utf8'
        )
      )
    )
    const material = new THREE.MeshStandardMaterial()
    material.name = definition.runtimeBinding.material
    const mesh = new THREE.Mesh(new THREE.BufferGeometry(), material)
    mesh.name = definition.runtimeBinding.node
    const originalRoot = new THREE.Group()
    originalRoot.add(mesh)
    const replacementRoot = new THREE.Group()
    const replacementRuntime = { replacement: true }
    const application = deferred<boolean>()
    vi.spyOn(LipArtworkEngineRuntime.prototype, 'apply').mockReturnValue(application.promise)
    const dispose = vi.spyOn(LipArtworkEngineRuntime.prototype, 'dispose')

    engine.goonLoadToken = 7
    engine.customAvatarRoot = originalRoot
    const setup = engine.setupLipArtwork(
      { appearanceDials: {}, lipArtwork: definition } as unknown as GoonCustomAvatarManifest,
      null,
      true,
      { token: 7, root: originalRoot }
    )
    engine.goonLoadToken = 8
    engine.customAvatarRoot = replacementRoot
    engine.lipArtworkRuntime = replacementRuntime
    application.resolve(true)

    await setup
    expect(dispose).toHaveBeenCalledTimes(1)
    expect(engine.lipArtworkRuntime).toBe(replacementRuntime)
    expect(engine.customAvatarRoot).toBe(replacementRoot)
  })

  it('does not publish setter state after its appearance runtime is replaced', async () => {
    const engine = engineFixture(true)
    const application = deferred<boolean>()
    const originalRuntime = { apply: vi.fn().mockReturnValue(application.promise) }
    const replacementRuntime = { apply: vi.fn() }
    const requestedState = { version: 'lip-artwork-state/v2' }
    const replacementState = { version: 'lip-artwork-state/v2', replacement: true }
    engine.lipArtworkRuntime = originalRuntime
    engine.lipArtworkState = null

    const setting = engine.setLipArtworkState(requestedState)
    engine.lipArtworkRuntime = replacementRuntime
    engine.lipArtworkState = replacementState
    application.resolve(true)

    await setting
    expect(engine.lipArtworkState).toBe(replacementState)
  })

  it('turns a stale appearance failure into cancellation without clearing replacement state', async () => {
    const engine = engineFixture(true)
    const geometry = deferred<any>()
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(geometry.promise)
    vi.spyOn(engine, 'captureCustomStageAnchors').mockImplementation(() => {})
    vi.spyOn(engine, 'discoverCustomFaceSupport').mockImplementation(() => {})
    vi.spyOn(engine, 'setupBodyDials').mockImplementation(() => {})
    const appearance = deferred<void>()
    vi.spyOn(engine, 'setupLipArtwork').mockReturnValue(appearance.promise)

    const loading = engine.loadCustomGoon('appearance.glb', {} as GoonCustomAvatarManifest)
    const originalRoot = new THREE.Group()
    geometry.resolve({ scene: originalRoot, scenes: [originalRoot], animations: [] })
    await nextTask()

    engine.unloadGoon()
    const replacementRoot = new THREE.Group()
    const replacementRuntime = { replacement: true }
    engine.customAvatarRoot = replacementRoot
    engine.lipArtworkRuntime = replacementRuntime
    appearance.reject(new Error('stale artwork failure'))

    await expect(loading).resolves.toBeUndefined()
    expect(engine.customAvatarRoot).toBe(replacementRoot)
    expect(engine.lipArtworkRuntime).toBe(replacementRuntime)
  })

  it('settles transferred pause when a newer public Custom manifest rejects before legacy loading', async () => {
    const engine = engineFixture(false)
    const geometry = deferred<any>()
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(geometry.promise)
    const older = engine.loadGoon('older.vrm', null)
    await nextTask()
    expect(engine.paused).toBe(true)
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Current Custom manifest rejected')))
    const goon = { id: 'custom-rejected', kind: 'custom', sourceProfile: 'expert-custom-glb', files: {}, customAvatar: {
      model: { url: '/custom-rejected.glb', filename: 'custom-rejected.glb' },
      manifest: { url: '/custom-rejected.json', filename: 'custom-rejected.json' }
    } } as GoonRecord
    await expect(loadAvatarIntoEngine(engine, goon)).rejects.toThrow('Current Custom manifest rejected')
    expect(engine.paused).toBe(false)
    const late = new THREE.Group()
    geometry.resolve({ scene: late, scenes: [late], animations: [] })
    await older
    engine.dispose()
  })

  it.each([false, true])('cancels older public Custom manifest work without releasing a newer pause (failure=%s)', async (failure) => {
    const engine = engineFixture(false)
    const response = deferred<any>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const geometry = deferred<any>()
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(geometry.promise)
    const customLoad = vi.spyOn(engine, 'loadCustomGoon')
    const settings = vi.spyOn(engine, 'setSocketEyeContactSettings')
    const goon = {
      ...vrmGoon('unused.vrm'), kind: 'custom' as const, sourceProfile: 'expert-custom-glb' as const,
      files: { animations: [] }, customAvatar: {
        model: { url: `/older-public-${failure}.glb`, filename: 'older.glb' },
        manifest: { url: `/older-public-${failure}.json`, filename: 'older.json' }
      }
    }
    const older = loadAvatarIntoEngine(engine, goon)
    const newer = engine.loadGoon('newer-public-owner.vrm')
    expect(engine.paused).toBe(true)
    if (failure) response.reject(new Error('stale public Custom manifest failed'))
    else response.resolve({ ok: true, json: async () => ({ contractVersion: 1 }) })

    await expect(older).resolves.toEqual({ kind: 'custom', manifest: null, role: 'cancelled' })
    expect(customLoad).not.toHaveBeenCalled()
    expect(settings).not.toHaveBeenCalled()
    expect(load).toHaveBeenCalledExactlyOnceWith('newer-public-owner.vrm')
    expect(engine.paused).toBe(true)
    engine.unloadGoon()
    const scene = new THREE.Group()
    const dispose = vi.spyOn(engine, 'disposeVrmScene')
    geometry.resolve({ scene })
    await newer
    expect(dispose).toHaveBeenCalledExactlyOnceWith(scene)
    expect(engine.paused).toBe(false)
    engine.dispose()
  })

  it('cancels a public Custom manifest after real engine disposal without starting geometry', async () => {
    const engine = engineFixture(false)
    const response = deferred<any>()
    vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync')
    const customLoad = vi.spyOn(engine, 'loadCustomGoon')
    const loading = loadAvatarIntoEngine(engine, {
      ...vrmGoon('unused.vrm'), kind: 'custom', sourceProfile: 'expert-custom-glb',
      files: { animations: [] }, customAvatar: {
        model: { url: '/disposed-public-custom.glb', filename: 'disposed.glb' },
        manifest: { url: '/disposed-public-custom.json', filename: 'disposed.json' }
      }
    })
    engine.dispose()
    response.resolve({ ok: true, json: async () => ({ contractVersion: 1 }) })
    await expect(loading).resolves.toEqual({ kind: 'custom', manifest: null, role: 'cancelled' })
    expect(load).not.toHaveBeenCalled()
    expect(customLoad).not.toHaveBeenCalled()
  })

  it('refuses new load ownership after terminal disposal', () => {
    const engine = engineFixture()
    const token = engine.beginGoonLoad()
    engine.dispose()
    expect(engine.isCurrentGoonLoad(token)).toBe(false)
    expect(() => engine.beginGoonLoad()).toThrow('Goon engine has been disposed.')
    engine.finishGoonLoad(token)
    expect(engine.goonLoadPauseToken).toBeNull()
  })

  it('settles the transferred pause when a newer Guided manifest rejects before model loading', async () => {
    const engine = engineFixture()
    const geometry = deferred<any>()
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(geometry.promise)
    const pause = vi.spyOn(engine, 'setPaused')
    const older = engine.loadGoon('older-standard.vrm')
    expect(engine.paused).toBe(true)
    const failure = new Error('newest Guided manifest rejected')
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(failure))
    const latest = loadAvatarIntoEngine(engine, vrmGoon('latest-guided.vrm', 'latest-guided-rejection.json'))

    await expect(latest).rejects.toBe(failure)
    expect(engine.paused).toBe(false)
    expect(engine.goonLoadPauseToken).toBeNull()
    expect(load).toHaveBeenCalledTimes(1)
    const scene = new THREE.Group()
    const dispose = vi.spyOn(engine, 'disposeVrmScene')
    geometry.resolve({ scene })
    await older
    expect(dispose).toHaveBeenCalledExactlyOnceWith(scene)
    expect(pause.mock.calls.map(([paused]) => paused)).toEqual([true, false])
    expect(engine.vrm).toBeNull()
    engine.dispose()
  })

  it.each(['unload', 'dispose', 'supersede'] as const)(
    'cancels Guided manifest preparation after %s without starting model or outfit loading',
    async (retirement) => {
      const engine = engineFixture()
      const response = deferred<any>()
      vi.stubGlobal('fetch', vi.fn().mockReturnValue(response.promise))
      const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync')
      const outfits = vi.spyOn(engine, 'configureGuidedOutfitPieces')
      const loading = loadAvatarIntoEngine(engine, vrmGoon(`pending-${retirement}.vrm`, `pending-${retirement}.json`))
      if (retirement === 'unload') engine.unloadGoon()
      else if (retirement === 'dispose') engine.dispose()
      else engine.beginGoonLoad()
      response.resolve({ ok: true, json: async () => ({ contractVersion: 1 }) })

      await expect(loading).resolves.toEqual({ kind: 'vrm', manifest: null, role: 'cancelled' })
      expect(load).not.toHaveBeenCalled()
      expect(outfits).not.toHaveBeenCalled()
      engine.dispose()
    }
  )

  it.each(['standard-vrm', 'guided-custom-vrm'] as const)(
    'returns actual cancellation for a late %s model and disposes its uninstalled scene once',
    async (sourceProfile) => {
      const engine = engineFixture()
      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true, json: async () => ({ contractVersion: 1 })
      }))
      const geometry = deferred<any>()
      vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(geometry.promise)
      const outfits = vi.spyOn(engine, 'configureGuidedOutfitPieces')
      const loading = loadAvatarIntoEngine(engine, vrmGoon(
        `late-${sourceProfile}.vrm`,
        sourceProfile === 'guided-custom-vrm' ? `late-${sourceProfile}.json` : undefined
      ))
      await nextTask()
      engine.unloadGoon()
      const replacement = new THREE.Group()
      engine.vrm = { scene: replacement }
      const scene = new THREE.Group()
      const material = new THREE.MeshStandardMaterial()
      const buffer = new THREE.BufferGeometry()
      scene.add(new THREE.Mesh(buffer, material), new THREE.Mesh(buffer, material))
      const disposeGeometry = vi.spyOn(buffer, 'dispose')
      const disposeMaterial = vi.spyOn(material, 'dispose')
      geometry.resolve({ scene })

      await expect(loading).resolves.toEqual({ kind: 'vrm', manifest: null, role: 'cancelled' })
      expect(disposeGeometry).toHaveBeenCalledTimes(1)
      expect(disposeMaterial).toHaveBeenCalledTimes(1)
      expect(scene.parent).toBeNull()
      expect(engine.vrm.scene).toBe(replacement)
      expect(outfits).not.toHaveBeenCalled()
      engine.dispose()
    }
  )

  it.each(['unload-and-replace', 'dispose', 'same-vrm-generation', 'same-vrm-configuration'] as const)(
    'fences both Guided overlay layers after %s without continuing the old configuration',
    async (retirement) => {
      const engine = engineFixture()
      const base = new THREE.Group()
      const basePiece = new THREE.Group()
      basePiece.name = 'Base'
      base.add(basePiece)
      engine.vrm = { scene: base }
      const overlay = deferred<any>()
      const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(overlay.promise)
      const visibility = vi.spyOn(engine, 'setGuidedOutfitPieceVisible')
      const materials = vi.spyOn(engine, 'collectMaterials').mockImplementation(() => {})
      const budget = vi.spyOn(engine, 'applyRuntimeTextureBudget').mockImplementation(() => {})
      const baseDefinition = { id: 'base', label: 'Base', runtimeNodeNames: ['Base'] }
      const pieces = [baseDefinition, ...['first', 'second'].map((id) => ({
        id, label: id, source: 'duf-overlay' as const, overlayId: id, runtimeNodeNames: [id]
      }))]
      const loading = engine.configureGuidedOutfitPieces(pieces, { base: false }, [
        { id: 'first', file: { url: 'first-overlay.glb', filename: 'first.glb' } },
        { id: 'second', file: { url: 'second-overlay.glb', filename: 'second.glb' } }
      ])
      const oldPairs = engine.guidedDufOverlayBonePairs
      if (retirement === 'dispose') engine.dispose()
      else if (retirement === 'same-vrm-configuration') {
        await engine.configureGuidedOutfitPieces([baseDefinition], { base: true })
        expect(engine.guidedDufOverlayBonePairs).not.toBe(oldPairs)
      } else if (retirement === 'same-vrm-generation') engine.beginGoonLoad()
      else {
        engine.unloadGoon()
        engine.vrm = { scene: new THREE.Group() }
      }
      const ownerVrm = engine.vrm
      const ownerPairs = engine.guidedDufOverlayBonePairs
      const ownerNodes = new Map(engine.guidedOutfitPieceNodes)
      const ownerMaterials = new Map(engine.materialMap)
      visibility.mockClear()
      materials.mockClear()
      budget.mockClear()
      const scene = new THREE.Group()
      const buffer = new THREE.BufferGeometry()
      const material = new THREE.MeshStandardMaterial()
      scene.add(new THREE.Mesh(buffer, material), new THREE.Mesh(buffer, material))
      const disposeGeometry = vi.spyOn(buffer, 'dispose')
      const disposeMaterial = vi.spyOn(material, 'dispose')
      overlay.resolve({ scene })

      await loading
      expect(load).toHaveBeenCalledExactlyOnceWith('first-overlay.glb')
      expect(disposeGeometry).toHaveBeenCalledTimes(1)
      expect(disposeMaterial).toHaveBeenCalledTimes(1)
      expect(scene.parent).toBeNull()
      expect(engine.vrm).toBe(ownerVrm)
      expect(engine.guidedDufOverlayBonePairs).toBe(ownerPairs)
      expect(engine.guidedOutfitPieceNodes).toEqual(ownerNodes)
      expect(engine.materialMap).toEqual(ownerMaterials)
      expect(engine.guidedDufOverlayRoot).toBeNull()
      expect(basePiece.visible).toBe(true)
      expect(visibility).not.toHaveBeenCalled()
      expect(materials).not.toHaveBeenCalled()
      expect(budget).not.toHaveBeenCalled()
      engine.dispose()
    }
  )

  it.each([false, true])('suppresses a Guided overlay rejection only when stale=%s', async (stale) => {
    const engine = engineFixture()
    engine.vrm = { scene: new THREE.Group() }
    const overlay = deferred<any>()
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockReturnValue(overlay.promise)
    const materials = vi.spyOn(engine, 'collectMaterials').mockImplementation(() => {})
    const pieces = ['first', 'second'].map((id) => ({
      id, label: id, source: 'duf-overlay' as const, overlayId: id, runtimeNodeNames: [id]
    }))
    const loading = engine.configureGuidedOutfitPieces(pieces, {}, [
      { id: 'first', file: { url: 'failed-first-overlay.glb', filename: 'first.glb' } },
      { id: 'second', file: { url: 'unused-second-overlay.glb', filename: 'second.glb' } }
    ])
    if (stale) engine.beginGoonLoad()
    const failure = new Error('Guided overlay transport failed')
    overlay.reject(failure)
    if (stale) await expect(loading).resolves.toBeUndefined()
    else await expect(loading).rejects.toBe(failure)
    expect(load).toHaveBeenCalledTimes(1)
    expect(materials).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('installs current multi-overlay pieces and bone bindings, then disposes them once on unload', async () => {
    const engine = engineFixture()
    const base = new THREE.Group()
    const baseBone = new THREE.Bone()
    baseBone.name = 'SharedBone'
    baseBone.position.set(1, 2, 3)
    base.add(baseBone)
    engine.vrm = { scene: base }
    vi.spyOn(engine, 'applyRuntimeTextureBudget').mockImplementation(() => {})
    const overlays = ['first', 'second'].map((id) => {
      const scene = new THREE.Group()
      const bone = new THREE.Bone()
      bone.name = 'SharedBone'
      const geometry = new THREE.BufferGeometry()
      const material = new THREE.MeshStandardMaterial()
      material.name = `${id}-material`
      const mesh = new THREE.Mesh(geometry, material)
      mesh.name = id
      bone.add(mesh)
      scene.add(bone)
      return { scene, bone, mesh, material, dispose: vi.spyOn(geometry, 'dispose') }
    })
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync')
      .mockResolvedValueOnce({ scene: overlays[0].scene } as any)
      .mockResolvedValueOnce({ scene: overlays[1].scene } as any)
    await engine.configureGuidedOutfitPieces(['first', 'second'].map((id) => ({
      id, label: id, source: 'duf-overlay' as const, overlayId: id, runtimeNodeNames: [id]
    })), {}, ['first', 'second'].map((id) => ({ id, file: { url: `${id}.glb`, filename: `${id}.glb` } })))

    expect(load.mock.calls.map(([url]) => url)).toEqual(['first.glb', 'second.glb'])
    expect(engine.guidedDufOverlayRoot.parent).toBe(base)
    expect(engine.guidedDufOverlayBonePairs).toHaveLength(2)
    for (const [index, id] of ['first', 'second'].entries()) {
      expect(engine.guidedOutfitPieceNodes.get(id)).toEqual([overlays[index].mesh])
      expect(engine.materialMap.get(`${id}-material`)).toEqual([overlays[index].material])
      expect(overlays[index].bone.position.toArray()).toEqual([1, 2, 3])
    }
    engine.unloadGoon()
    for (const overlay of overlays) expect(overlay.dispose).toHaveBeenCalledTimes(1)
    engine.dispose()
    for (const overlay of overlays) expect(overlay.dispose).toHaveBeenCalledTimes(1)
  })
})

describe('Custom GLB animation overlap diagnostics', () => {
  function motionGlb(channels: Array<{ node: string; path: 'rotation' | 'translation' | 'scale' }>) {
    const names = [...new Set(channels.map((channel) => channel.node))]
    const values = [0, 1, 0, 0, 0, 1, 0, Math.SQRT1_2, 0, Math.SQRT1_2, 1, 1, 1, 2, 2, 2]
    const binary = new ArrayBuffer(values.length * 4)
    const binaryView = new DataView(binary)
    values.forEach((value, index) => binaryView.setFloat32(index * 4, value, true))
    const json = new TextEncoder().encode(JSON.stringify({
      asset: { version: '2.0' }, scene: 0,
      scenes: [{ nodes: names.map((_, index) => index) }],
      nodes: names.map((name) => ({ name })),
      buffers: [{ byteLength: binary.byteLength }],
      bufferViews: [
        { buffer: 0, byteOffset: 0, byteLength: 8 },
        { buffer: 0, byteOffset: 8, byteLength: 32 },
        { buffer: 0, byteOffset: 40, byteLength: 24 }
      ],
      accessors: [
        { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
        { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
        { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' }
      ],
      animations: [{
        name: 'real-glb-probe',
        samplers: [{ input: 0, output: 1 }, { input: 0, output: 2 }],
        channels: channels.map(({ node, path }) => ({
          sampler: path === 'rotation' ? 0 : 1,
          target: { node: names.indexOf(node), path }
        }))
      }]
    }))
    const jsonSize = (json.length + 3) & ~3
    const buffer = new ArrayBuffer(12 + 8 + jsonSize + 8 + binary.byteLength)
    const bytes = new Uint8Array(buffer)
    const view = new DataView(buffer)
    bytes.fill(0x20, 20, 20 + jsonSize)
    bytes.set(json, 20)
    bytes.set(new Uint8Array(binary), 28 + jsonSize)
    view.setUint32(0, 0x46546c67, true)
    view.setUint32(4, 2, true)
    view.setUint32(8, buffer.byteLength, true)
    view.setUint32(12, jsonSize, true)
    view.setUint32(16, 0x4e4f534a, true)
    view.setUint32(20 + jsonSize, binary.byteLength, true)
    view.setUint32(24 + jsonSize, 0x004e4942, true)
    return buffer
  }

  async function loadRealGlbMotion(
    targetName: string,
    channels: Array<{ node: string; path: 'rotation' | 'translation' | 'scale' }>
  ) {
    const parsed = await new GLTFLoader().parseAsync(motionGlb(channels), '')
    const fixture = await createRecipePhysicalMigrationFixture({ runtimePreviewCompatible: true })
    const engine = engineFixture()
    const root = new THREE.Group()
    const target = new THREE.Bone()
    target.name = targetName
    root.add(target)
    engine.customAvatarRoot = root
    engine.customAvatarManifest = fixture.source.avatarManifest
    engine.mixer = new THREE.AnimationMixer(root)
    const reports = vi.fn()
    engine.setCompatibilityHandler(reports)
    vi.spyOn(engine, 'syncBaseLoopAnimation').mockImplementation(() => {})
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue(parsed)
    await engine.loadAdditionalAnimations([{ url: '/owned/probe.glb', filename: 'probe.glb' }])
    const clip = engine.animationMap.get('real-glb-probe') as THREE.AnimationClip
    return { engine, target, reports, clip }
  }

  it.each([
    { name: 'no matching tracks', tracks: ['AlienSpine'], warning: 'no matching tracks found' },
    { name: 'low overlap', tracks: ['KnownBone', ...Array.from({ length: 19 }, (_, index) => `Unknown${index}`)], warning: 'low rig overlap (1/20 tracks matched)' },
    { name: 'matching rig', tracks: ['KnownBone'], warning: null }
  ])('reports $name after the actual GLB loading path', async ({ tracks, warning }) => {
    const fixture = await createRecipePhysicalMigrationFixture({ runtimePreviewCompatible: true })
    const engine = engineFixture()
    const root = new THREE.Group()
    const knownBone = new THREE.Bone()
    knownBone.name = 'KnownBone'
    root.add(knownBone)
    engine.customAvatarRoot = root
    engine.customAvatarManifest = fixture.source.avatarManifest
    const reports = vi.fn()
    engine.setCompatibilityHandler(reports)
    vi.spyOn(engine, 'syncBaseLoopAnimation').mockImplementation(() => {})
    const clip = new THREE.AnimationClip('overlap-probe', 1,
      tracks.map((name) => new THREE.QuaternionKeyframeTrack(`${name}.quaternion`, [0], [0, 0, 0, 1])))
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ animations: [clip] } as any)

    await engine.loadAdditionalAnimations([{ url: '/owned/probe.glb', filename: 'probe.glb' }])

    expect(engine.getAnimationNames()).toContain('overlap-probe')
    const issues = reports.mock.lastCall?.[0]?.issues as string[]
    expect(issues).toBeDefined()
    if (warning) expect(issues.some((issue) => issue.includes(warning))).toBe(true)
    else expect(issues.some((issue) => issue.includes('rig overlap') || issue.includes('no matching tracks'))).toBe(false)
    engine.dispose()
  })

  it('does not load animation files without an active avatar', async () => {
    const engine = engineFixture()
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync')
    await engine.loadAdditionalAnimations([{ url: '/owned/probe.glb', filename: 'probe.glb' }])
    expect(load).not.toHaveBeenCalled()
    engine.dispose()
  })

  it('never queues an older sync plan after a newer eager load wins', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({ runtimePreviewCompatible: true })
    const engine = engineFixture()
    const root = new THREE.Group()
    const bone = new THREE.Bone()
    bone.name = 'KnownBone'
    root.add(bone)
    engine.customAvatarRoot = root
    engine.customAvatarManifest = fixture.source.avatarManifest
    const oldEager = deferred<any>()
    const newDeferred = deferred<any>()
    const clip = (name: string) => ({ animations: [new THREE.AnimationClip(name, 1, [
      new THREE.QuaternionKeyframeTrack('KnownBone.quaternion', [0], [0, 0, 0, 1])
    ])] })
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
      if (url === '/old-eager.glb') return oldEager.promise
      if (url === '/new-deferred.glb') return newDeferred.promise
      return clip(url === '/new-eager.glb' ? 'new-eager' : 'old-deferred') as any
    })
    const reports = vi.fn()
    engine.setCompatibilityHandler(reports)
    vi.spyOn(engine, 'syncBaseLoopAnimation').mockImplementation(() => {})
    const file = (name: string) => ({ url: `/${name}.glb`, filename: `${name}.glb` })

    const old = engine.syncAnimations([file('old-eager')], { deferredFiles: [file('old-deferred')] })
    await engine.syncAnimations([file('new-eager')], { deferredFiles: [file('new-deferred')] })
    expect(load).toHaveBeenCalledWith('/new-deferred.glb')
    oldEager.resolve(clip('old-eager'))
    await old
    expect(load).not.toHaveBeenCalledWith('/old-deferred.glb')
    newDeferred.resolve(clip('new-deferred'))
    await vi.waitFor(() => expect(engine.getAnimationNames()).toContain('new-deferred'))
    expect(engine.getAnimationNames()).toEqual(expect.arrayContaining(['new-eager', 'new-deferred']))
    const reportedNames = reports.mock.calls.flatMap(([report]) => report.animationNames ?? [])
    for (const name of ['old-eager', 'old-deferred']) {
      expect(engine.getAnimationNames()).not.toContain(name)
      expect(reportedNames).not.toContain(name)
    }
    engine.dispose()
  })

  it('does not resolve pending motion from a superseded deferred load', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({ runtimePreviewCompatible: true })
    const engine = engineFixture()
    engine.customAvatarRoot = new THREE.Group()
    engine.customAvatarManifest = fixture.source.avatarManifest
    const oldDeferred = deferred<any>()
    const newDeferred = deferred<any>()
    const load = vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockImplementation(async (url) => {
      if (url === '/old.glb') return oldDeferred.promise
      return newDeferred.promise
    })
    const resolvePending = vi.spyOn(engine, 'resolvePendingAnimations')
    vi.spyOn(engine, 'syncBaseLoopAnimation').mockImplementation(() => {})
    const file = (name: string) => ({ url: `/${name}.glb`, filename: `${name}.glb` })
    await engine.syncAnimations([], { deferredFiles: [file('old')] })
    await engine.syncAnimations([], { deferredFiles: [file('new')] })
    oldDeferred.resolve({ animations: [] })
    await vi.waitFor(() => expect(load).toHaveBeenCalledWith('/new.glb'))
    await nextTask()
    expect(engine.deferredLoading).toBe(true)
    expect(resolvePending).not.toHaveBeenCalled()
    newDeferred.resolve({ animations: [] })
    await vi.waitFor(() => expect(resolvePending).toHaveBeenCalledTimes(1))
    await vi.waitFor(() => expect(engine.deferredLoading).toBe(false))
    engine.dispose()
  })

  it('continues to report mismatched GLB motion for a VRM avatar', async () => {
    const engine = engineFixture()
    const root = new THREE.Group()
    const knownBone = new THREE.Bone()
    knownBone.name = 'KnownBone'
    root.add(knownBone)
    engine.vrm = { scene: root }
    const reports = vi.fn()
    engine.setCompatibilityHandler(reports)
    vi.spyOn(engine, 'syncBaseLoopAnimation').mockImplementation(() => {})
    const clip = new THREE.AnimationClip('vrm-overlap-probe', 1, [
      new THREE.QuaternionKeyframeTrack('AlienSpine.quaternion', [0], [0, 0, 0, 1])
    ])
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ animations: [clip] } as any)

    await engine.loadAdditionalAnimations([{ url: '/owned/probe.glb', filename: 'probe.glb' }])

    expect(engine.getAnimationNames()).toContain('vrm-overlap-probe')
    expect(reports.mock.lastCall?.[0]?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('no matching tracks found')])
    )
    engine.dispose()
  })

  it('recognizes a Unicode target that GLTFLoader and the mixer actually bind', async () => {
    const { engine, target, reports, clip } = await loadRealGlbMotion('頭', [
      { node: '頭', path: 'rotation' }
    ])
    const issues = reports.mock.lastCall?.[0]?.issues as string[]
    expect(issues.some((issue) => issue.includes('rig overlap') || issue.includes('no matching tracks'))).toBe(false)
    expect(clip.tracks.map((track) => track.name)).toEqual(['頭.quaternion'])
    engine.mixer.clipAction(clip).play()
    engine.mixer.update(0.5)
    expect(target.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 8), 6)
    engine.dispose()
  })

  it('does not treat a suffix-similar node as an actual mixer binding', async () => {
    const { engine, target, reports, clip } = await loadRealGlbMotion('KnownBone', [
      { node: 'UnknownBone', path: 'rotation' }
    ])
    expect(reports.mock.lastCall?.[0]?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('no matching tracks found')])
    )
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    engine.mixer.clipAction(clip).play()
    engine.mixer.update(0.5)
    expect(target.quaternion.y).toBe(0)
    expect(warning).toHaveBeenCalled()
    engine.dispose()
  })

  it('does not count channels that registration drops against the retained GLB motion', async () => {
    const dropped = Array.from({ length: 19 }, (_, index) => [
      { node: `Alien${index}`, path: 'translation' as const },
      { node: `Alien${index}`, path: 'scale' as const }
    ]).flat()
    const { engine, target, reports, clip } = await loadRealGlbMotion('KnownBone', [
      { node: 'KnownBone', path: 'rotation' }, ...dropped
    ])
    const issues = reports.mock.lastCall?.[0]?.issues as string[]
    expect(issues.some((issue) => issue.includes('rig overlap') || issue.includes('no matching tracks'))).toBe(false)
    expect(clip.tracks.map((track) => track.name)).toEqual(['KnownBone.quaternion'])
    engine.mixer.clipAction(clip).play()
    engine.mixer.update(0.5)
    expect(target.quaternion.y).toBeCloseTo(Math.sin(Math.PI / 8), 6)
    engine.dispose()
  })

  it('reports when all raw GLB tracks are filtered while preserving clip registration', async () => {
    const { engine, reports, clip } = await loadRealGlbMotion('KnownBone', [
      { node: 'AlienArm', path: 'translation' }, { node: 'AlienArm', path: 'scale' }
    ])
    expect(reports.mock.lastCall?.[0]?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('contains no supported animation tracks')])
    )
    expect(engine.getAnimationNames()).toContain('real-glb-probe')
    expect(clip.tracks).toHaveLength(0)
    engine.dispose()
  })

  it('reports a retained track that Three cannot parse without aborting clip registration', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({ runtimePreviewCompatible: true })
    const engine = engineFixture()
    engine.customAvatarRoot = new THREE.Group()
    engine.customAvatarManifest = fixture.source.avatarManifest
    const reports = vi.fn()
    engine.setCompatibilityHandler(reports)
    vi.spyOn(engine, 'syncBaseLoopAnimation').mockImplementation(() => {})
    const clip = new THREE.AnimationClip('unparseable-probe', 1, [
      new THREE.QuaternionKeyframeTrack('Broken[.quaternion', [0], [0, 0, 0, 1])
    ])
    vi.spyOn(GLTFLoader.prototype, 'loadAsync').mockResolvedValue({ animations: [clip] } as any)

    await engine.loadAdditionalAnimations([{ url: '/owned/probe.glb', filename: 'probe.glb' }])

    expect(reports.mock.lastCall?.[0]?.issues).toEqual(
      expect.arrayContaining([expect.stringContaining('no matching tracks found')])
    )
    expect(engine.getAnimationNames()).toContain('unparseable-probe')
    engine.dispose()
  })
})
