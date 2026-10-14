import { describe, expect, it, vi } from 'vitest'
import type { GoonSceneDefinition, GoonSceneMap, GoonsSettings } from '$lib/types/goons'
import {
  buildUniqueSceneId,
  collectSceneAssetFilenames,
  duplicateSceneDefinition,
  persistSceneLibrary,
  planSceneAssetCleanup,
  type SceneAssetUploads
} from './sceneLibrary'

function uploads(): SceneAssetUploads {
  return { skybox: new Set(), roomShell: new Set(), prop: new Set() }
}

function scene(): GoonSceneDefinition {
  return {
    id: 'city', name: 'City', description: 'A complete scene',
    skybox: {
      url: '/uploads/goon_scenes/city.mp4', filename: 'city.mp4',
      mimeType: 'video/mp4', thumbnailUrl: '/uploads/goon_scene_thumbs/city_thumb.jpg',
      kind: 'skybox', projection: 'equirectangular'
    },
    scenePlacement: 'ground', groundProjectionLine: .6,
    roomShell: { url: '/uploads/goon_room_shells/room.glb', filename: 'room.glb' },
    roomShellTransform: { position: [1, 2, 3], rotationY: .4, uniformScale: 1.2 },
    cameraBoundary: { center: [1, 2, 3], size: [6, 4, 8], rotationY: .2 },
    roomShellBuilder: {
      width: 6, depth: 8, height: 4, floorOffsetY: .3,
      surfaces: {
        floor: { enabled: true, interior: {
          texture: { url: '/uploads/goon_room_textures/wood.jpg', filename: 'wood.jpg' },
          tileScale: [2, 3]
        } },
        walls: { north: { enabled: false }, south: { interior: { opacity: .3 } } }
      },
      exteriorAprons: { north: { enabled: true, depth: 3 } },
      terrainSkirt: { enabled: true, radius: 20, edgeFade: .5 }
    },
    props: [{
      id: 'chair', name: 'Chair',
      fileRef: { url: '/uploads/goon_scene_props/chair.glb', filename: 'chair.glb' },
      position: [1, 0, 2], rotation: [0, .5, 0], scale: [1, 1, 1]
    }],
    markers: {
      sit: [{ id: 'sit_1', propId: 'chair', position: [0, .5, 0],
        rotation: [0, .2, 0], positioned: true, propLocked: true }],
      dance: [{ id: 'dance_1', position: [2, 0, 2], positioned: true, propLocked: true }]
    },
    ambience: { enabled: true, preset: 'rain', placement: 'outside', intensity: .4, speed: .7 }
  }
}

describe('Scene duplication', () => {
  it('copies every setting and scene-scoped link without sharing mutable nested state', () => {
    const original = scene()
    const before = JSON.parse(JSON.stringify(original))
    // Like Svelte $state, a proxy cannot be passed directly to structuredClone.
    const copy = duplicateSceneDefinition({ city: new Proxy(original, {}) }, 'city')
    expect(copy).toEqual({ ...before, id: 'city_copy', name: 'City Copy' })
    expect(copy.markers?.sit[0].propId).toBe(copy.props?.[0].id)
    copy.skybox!.url = '/replacement.mp4'
    copy.roomShell!.filename = 'other.glb'
    copy.roomShellTransform!.position![0] = 99
    copy.cameraBoundary!.center![0] = 99
    copy.roomShellBuilder!.surfaces!.floor!.interior!.tileScale![0] = 99
    copy.roomShellBuilder!.surfaces!.floor!.interior!.texture!.filename = 'other.jpg'
    copy.roomShellBuilder!.exteriorAprons!.north!.depth = 99
    copy.roomShellBuilder!.terrainSkirt!.radius = 99
    copy.props![0].position![0] = 99
    copy.props![0].fileRef.filename = 'other-chair.glb'
    copy.markers!.sit[0].position[0] = 99
    copy.markers!.dance[0].propLocked = false
    copy.ambience!.intensity = 99
    expect(original).toEqual(before)
  })

  it('chooses names and ids independently without overwriting another scene', () => {
    const scenes: GoonSceneMap = {
      city: scene(),
      other: { id: 'other', name: 'CITY COPY' },
      city_copy_2: { id: 'city_copy_2', name: 'Unrelated' }
    }
    const copy = duplicateSceneDefinition(scenes, 'city')
    expect(copy.name).toBe('City Copy 2')
    expect(copy.id).toBe('city_copy_2_2')
    expect(Object.keys(scenes)).toEqual(['city', 'other', 'city_copy_2'])
    const second = duplicateSceneDefinition({ ...scenes, [copy.id]: copy }, 'city')
    expect(second.name).toBe('City Copy 3')
    expect(buildUniqueSceneId('!!!', { scene: { id: 'scene', name: 'Existing' } })).toBe('scene_2')
    expect(() => duplicateSceneDefinition(scenes, 'missing')).toThrow('no longer available')
  })
})

describe('Scene media ownership', () => {
  it('retains shared files when replacing a copy skybox or removing either scene', () => {
    const source = scene()
    const copy = duplicateSceneDefinition({ city: source }, 'city')
    const previous = { city: source, [copy.id]: copy }
    copy.skybox = { filename: 'replacement.mp4', url: '/replacement.mp4', mimeType: 'video/mp4' }
    expect(planSceneAssetCleanup({ city: source }, previous, uploads())).toEqual([])
    expect(planSceneAssetCleanup(previous, { city: source }, uploads())).toEqual([
      { kind: 'skybox', filename: 'replacement.mp4' }
    ])
    const keepCopy = planSceneAssetCleanup(previous, { [copy.id]: copy }, uploads())
    expect(keepCopy).toEqual([{ kind: 'skybox', filename: 'city.mp4' }])
    expect(collectSceneAssetFilenames('prop', previous)).toEqual(new Set(['chair.glb']))
  })

  it('discarding a duplicate releases new uploads while preserving source media', () => {
    const saved = { city: scene() }
    const draftUploads = uploads()
    draftUploads.skybox.add('replacement.mp4')
    draftUploads.prop.add('new-chair.glb')
    expect(planSceneAssetCleanup(undefined, saved, draftUploads)).toEqual([
      { kind: 'skybox', filename: 'replacement.mp4' },
      { kind: 'prop', filename: 'new-chair.glb' }
    ])
    expect(planSceneAssetCleanup(undefined, saved, uploads())).toEqual([])
  })

  it('protects submitted media when the save response is lost, including later discard', async () => {
    const draftUploads = uploads()
    const protectedUploads = uploads()
    draftUploads.skybox.add('replacement.mp4')
    draftUploads.prop.add('new-chair.glb')
    const deleteAsset = vi.fn()
    await expect(persistSceneLibrary({
      previousScenes: { city: scene() }, uploads: draftUploads, protectedUploads, deleteAsset,
      // The server may already have written these references before the response failed.
      persist: async () => { throw new Error('Save response lost') }
    })).rejects.toThrow('Save response lost')
    expect(deleteAsset).not.toHaveBeenCalled()
    expect(protectedUploads.skybox).toEqual(new Set(['replacement.mp4']))
    expect(protectedUploads.prop).toEqual(new Set(['new-chair.glb']))
    // Neither Cancel nor teardown may reclaim submitted bytes using stale saved settings.
    expect(planSceneAssetCleanup(undefined, { city: scene() }, draftUploads)).toEqual([])
    // A subsequent confirmed save can reconcile an uncertain upload safely.
    const saved = scene()
    saved.skybox = { filename: 'replacement.mp4', url: '/replacement.mp4' }
    await persistSceneLibrary({
      previousScenes: { city: scene() }, uploads: draftUploads, protectedUploads, deleteAsset,
      persist: async () => ({ kitchen: { scenes: { city: saved } } })
    })
    expect(deleteAsset.mock.calls.map(([asset]) => asset)).toEqual([
      { kind: 'skybox', filename: 'city.mp4' },
      { kind: 'prop', filename: 'new-chair.glb' }
    ])
    expect(protectedUploads.skybox.size).toBe(0)
    expect(protectedUploads.prop.size).toBe(0)
  })

  it('protects new media from teardown while save is pending and retains confirmed references', async () => {
    let confirm!: (settings: GoonsSettings) => void
    const save = new Promise<GoonsSettings>((resolve) => { confirm = resolve })
    const draftUploads = uploads()
    const protectedUploads = uploads()
    draftUploads.skybox.add('replacement.mp4')
    draftUploads.prop.add('new-chair.glb')
    const deleteAsset = vi.fn().mockResolvedValue(undefined)
    const pending = persistSceneLibrary({
      previousScenes: { city: scene() }, uploads: draftUploads, protectedUploads,
      persist: () => save, deleteAsset
    })
    // This is the cleanup boundary used by discard/unmount, with the old saved library.
    expect(planSceneAssetCleanup(undefined, { city: scene() }, draftUploads)).toEqual([])
    const confirmed = scene()
    confirmed.skybox = { filename: 'replacement.mp4', url: '/replacement.mp4' }
    confirmed.props!.push({ id: 'new-chair', name: 'New Chair', fileRef: {
      filename: 'new-chair.glb', url: '/new-chair.glb'
    } })
    confirm({ kitchen: { scenes: { city: confirmed } } })
    await pending
    expect(deleteAsset).toHaveBeenCalledExactlyOnceWith({ kind: 'skybox', filename: 'city.mp4' })
    expect(planSceneAssetCleanup(undefined, { city: confirmed }, draftUploads)).toEqual([])
    expect(protectedUploads.skybox.size).toBe(0)
    expect(protectedUploads.prop.size).toBe(0)
  })

  it('waits for save confirmation and releases the final saved references only once', async () => {
    let confirm!: (settings: GoonsSettings) => void
    const save = new Promise<GoonsSettings>((resolve) => { confirm = resolve })
    const draftUploads = uploads()
    draftUploads.prop.add('chair.glb')
    const deleteAsset = vi.fn().mockResolvedValue(undefined)
    const pending = persistSceneLibrary({
      previousScenes: { city: scene() }, uploads: draftUploads,
      protectedUploads: uploads(),
      persist: () => save, deleteAsset
    })
    expect(deleteAsset).not.toHaveBeenCalled()
    draftUploads.prop.add('later-upload.glb')
    confirm({ kitchen: { scenes: {} } })
    const result = await pending
    expect(result.cleanupFailures).toEqual([])
    expect(deleteAsset.mock.calls.map(([asset]) => asset)).toEqual([
      { kind: 'skybox', filename: 'city.mp4' },
      { kind: 'roomShell', filename: 'room.glb' },
      { kind: 'prop', filename: 'chair.glb' }
    ])
    expect(draftUploads.prop).toEqual(new Set(['later-upload.glb']))
  })

  it('honors server-confirmed shared references and keeps failed cleanup retryable', async () => {
    const source = scene()
    const copy = duplicateSceneDefinition({ city: source }, 'city')
    const draftUploads = uploads()
    draftUploads.prop.add('unused.glb')
    const deleteAsset = vi.fn().mockRejectedValue(new Error('File service unavailable'))
    const options = {
      previousScenes: { city: source }, uploads: draftUploads, protectedUploads: uploads(), deleteAsset,
      persist: async () => ({ kitchen: { scenes: { [copy.id]: copy } } })
    }
    const saved = await persistSceneLibrary(options)
    expect(saved.settings.kitchen?.scenes?.[copy.id]).toEqual(copy)
    expect(saved.cleanupFailures).toHaveLength(1)
    expect(deleteAsset).toHaveBeenCalledExactlyOnceWith({ kind: 'prop', filename: 'unused.glb' })
    expect(draftUploads.prop).toEqual(new Set(['unused.glb']))
    deleteAsset.mockResolvedValue(undefined)
    expect((await persistSceneLibrary(options)).cleanupFailures).toEqual([])
    expect(draftUploads.prop.size).toBe(0)
  })
})
