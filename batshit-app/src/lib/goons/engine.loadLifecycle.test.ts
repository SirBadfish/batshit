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
