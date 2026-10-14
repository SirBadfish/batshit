import { readFileSync } from 'node:fs'
import ts from 'typescript'
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { installUserSettingsRoutes, loadUserSettingsRoute, storedUserSettings } from '$lib/test-utils/userSettingsRoute'
import { persistGoonsSettingsPatchRequest } from '$lib/services/goonsSettingsPersistence'
import { confirmUserSettings, failUserSettingsRead, getUserSettingsReadState, resetUserSettings } from '$lib/stores/userSettings.svelte'
import type { GoonsSettings } from '$lib/types/goons'

useRedisTestServer()

// Execute the panel's actual writer bodies, while substituting only their UI state and unrelated
// upload/library helpers. The patch helper and POST still use the real service and settings route.
function panelWriter(name: string, context: Record<string, unknown>) {
  const source = readFileSync('src/lib/components/settings/panels/GoonsSettingsPanel.svelte', 'utf8')
    .split('<script lang="ts">')[1]
    .split('</script>')[0]
  const file = ts.createSourceFile('GoonsSettingsPanel.ts', source, ts.ScriptTarget.Latest, true)
  const names = new Set([
    'requireConfirmedUserSettings', 'persistGoonsSettingsPatch',
    'saveKitchenSettings', 'saveClosetSettings', 'saveScenesSettings',
    'saveMotionsAndPostures', 'persistGlbPreviewGoonSelection', 'confirmLibraryImport',
    'handleSceneSelection', 'handleRoomShellSelection', 'handleRoomTextureSelection', 'handleScenePropSelection'
  ])
  const declarations = file.statements.filter(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name && names.has(statement.name.text)
  )
  if (declarations.length !== names.size) throw new Error('Panel writer fixture could not locate all writer bodies')
  const js = ts.transpileModule(declarations.map((item) => item.getText(file)).join('\n'), {
    compilerOptions: { target: ts.ScriptTarget.ES2022 }
  }).outputText
  const scope = new Proxy(context, {
    has: () => true,
    get(target, key) {
      if (typeof key === 'symbol') return Reflect.get(target, key)
      if (Object.hasOwn(target, key)) return Reflect.get(target, key)
      return Reflect.get(globalThis as any, key)
    },
    set(target, key, value) { return Reflect.set(target, key, value) }
  })
  const writers = new Function('scope', `with (scope) { ${js}; return { ${[...names].join(', ')} }; }`)(scope)
  return writers[name] as (...args: any[]) => Promise<unknown>
}

const USER = 'bl975-panel-writers'
const SAVED: GoonsSettings = {
  dockOpen: true,
  showCues: false,
  immersiveMode: true,
  desktop: {
    fullHeight: false,
    normalizedWidth: 0.72,
    stayOnTop: true,
    clickThrough: false,
    controlsShortcut: 'CommandOrControl+Alt+K',
    workspace: 'current-workspace'
  },
  globalCloset: { items: { saved_coat: { id: 'saved_coat', name: 'Saved coat' } } },
  kitchen: {
    cues: { saved_cue: { kind: 'mood', name: 'Saved cue' } },
    emojiMap: { '🙂': 'saved_cue' },
    postures: { saved_posture: { id: 'saved_posture', name: 'Saved posture', basePosture: 'standing' } },
    scenes: { saved_scene: { id: 'saved_scene', name: 'Saved scene' } },
    roomTextures: { floor: [{ filename: 'saved-floor.png' }] },
    defaultPack: { name: 'Saved pack', cueMap: { saved_cue: 'saved_cue' } }
  },
  motions: { glbPreviewGoonId: 'saved-preview' }
}

let route: Awaited<ReturnType<typeof loadUserSettingsRoute>>
let posts: Array<{ body: Record<string, any> }>

beforeAll(async () => { route = await loadUserSettingsRoute() }, 60_000)
beforeEach(async () => {
  resetUserSettings()
  await redis.updateUserSettings(USER, { displayName: 'Authoritative', goons_settings: structuredClone(SAVED) } as any)
  posts = installUserSettingsRoutes({ userId: USER, route }).posts
})
afterEach(() => { resetUserSettings(); vi.unstubAllGlobals(); vi.restoreAllMocks() })

function context(extra: Record<string, unknown> = {}) {
  return {
    fetch: globalThis.fetch,
    persistGoonsSettingsPatchRequest,
    userSettingsConfirmed: getUserSettingsReadState() === 'confirmed',
    confirmUserSettings,
    getUserSettingsReadState,
    toast: { error: vi.fn(), success: vi.fn(), warning: vi.fn() },
    goonsSettings: structuredClone(SAVED),
    ...extra
  }
}

async function assertStored(patch: Partial<GoonsSettings>) {
  const saved = await storedUserSettings(USER)
  expect(saved?.goons_settings).toMatchObject({
    dockOpen: patch.dockOpen ?? SAVED.dockOpen,
    desktop: SAVED.desktop,
    globalCloset: patch.globalCloset ?? SAVED.globalCloset,
    motions: patch.motions ?? SAVED.motions,
    ...Object.fromEntries(Object.entries(patch).filter(([key]) => key !== 'kitchen'))
  })
  const kitchen = saved?.goons_settings?.kitchen
  if (patch.kitchen?.scenes === undefined) {
    expect(kitchen?.scenes).toMatchObject(SAVED.kitchen?.scenes ?? {})
  }
  if (patch.kitchen?.roomTextures === undefined) {
    expect(kitchen?.roomTextures).toMatchObject(SAVED.kitchen?.roomTextures ?? {})
  }
}

describe('Goons panel writers preserve non-owned server settings (BL-975 D3-D6)', () => {
  beforeEach(() => confirmUserSettings({ displayName: 'Stale tab', goons_settings: { dockOpen: false } }))

  it('Kitchen patches only cues, emoji map, and eye-contact settings', async () => {
    const patch = {
      cues: { kitchen_cue: { kind: 'mood', name: 'Kitchen cue' } },
      emojiMap: { '😎': 'kitchen_cue' },
      eyeContact: { saved_posture: { vroid: { mode: 'on' } } }
    }
    const apply = vi.fn()
    const fn = panelWriter('saveKitchenSettings', context({
      kitchenSaving: false,
      kitchenCueMap: patch.cues,
      kitchenEmojiMap: {},
      kitchenEmoteEmojiDrafts: {},
      normalizeGoonCueMap: (value: unknown) => value,
      buildEmojiMapFromDrafts: () => ({ emojiMap: patch.emojiMap, conflicts: [] }),
      buildKitchenEyeContactSettings: () => patch.eyeContact,
      applyKitchenStateFromSettings: apply,
      buildEmoteEmojiDrafts: () => ({})
    }))
    await fn()
    expect(posts.map(({ body }) => body)).toEqual([{ goons_settings_patch: { kitchen: patch } }])
    await assertStored({ kitchen: patch })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('Closet patches only globalCloset', async () => {
    const globalCloset = { items: { new_coat: { id: 'new_coat', name: 'New coat' } } }
    const apply = vi.fn()
    await panelWriter('saveClosetSettings', context({
      closetSaving: false,
      globalCloset,
      sanitizeGlobalClosetLibrary: (value: unknown) => value,
      applyClosetStateFromSettings: apply
    }))()
    expect(posts.map(({ body }) => body)).toEqual([{ goons_settings_patch: { globalCloset } }])
    await assertStored({ globalCloset })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('Scenes patches only scenes and room textures through its persist wrapper', async () => {
    const kitchenScenes = { new_scene: { id: 'new_scene', name: 'New scene' } }
    const kitchenRoomTextures = { wall: [{ filename: 'new-wall.png' }] }
    const persistSceneLibrary = vi.fn(async ({ persist }: { persist: () => Promise<GoonsSettings> }) => ({
      settings: await persist(), cleanupFailures: []
    }))
    const apply = vi.fn()
    await panelWriter('saveScenesSettings', context({
      sceneSaving: false,
      sceneUploadBusy: false,
      sceneRoomShellBusy: false,
      scenePropBusy: false,
      roomTextureBusy: false,
      activeSceneEdit: null,
      hasPendingMarkerDrafts: () => false,
      cloneSceneMap: (value: unknown) => structuredClone(value),
      kitchenScenes,
      kitchenRoomTextures,
      sanitizeSceneMap: (value: unknown) => value,
      persistSceneLibrary,
      draftSceneAssetUploadFilenames: { skybox: new Set(), roomShell: new Set(), prop: new Set() },
      protectedSceneAssetUploadFilenames: { skybox: new Set(), roomShell: new Set(), prop: new Set() },
      deleteSceneAssetUpload: vi.fn(),
      scenePanelDestroyed: false,
      applySceneStateFromSettings: apply,
      sceneEditorMode: false
    }))()
    const patch = { scenes: kitchenScenes, roomTextures: kitchenRoomTextures }
    expect(posts.map(({ body }) => body)).toEqual([{ goons_settings_patch: { kitchen: patch } }])
    await assertStored({ kitchen: patch })
    expect(persistSceneLibrary).toHaveBeenCalledOnce()
    expect(apply).toHaveBeenCalledOnce()
  })

  it('Motions patches posture and only cues/scenes/defaultPack changed by the rebase', async () => {
    const nextKitchen = {
      ...SAVED.kitchen,
      postures: { new_posture: { id: 'new_posture', name: 'New posture', basePosture: 'standing' } },
      cues: { rebased_cue: { kind: 'mood', name: 'Rebased cue' } },
      scenes: { rebased_scene: { id: 'rebased_scene', name: 'Rebased scene' } },
      defaultPack: { name: 'Rebased pack', cueMap: {} }
    }
    const apply = vi.fn()
    await panelWriter('saveMotionsAndPostures', context({
      validateMotionPostureDrafts: () => null,
      motionsSaving: false,
      normalizeCustomPostureMap: (value: unknown) => value,
      motionCustomPostureDraftMap: nextKitchen.postures,
      postureMapsMatch: () => false,
      buildMotionDraftSettings: () => ({ ...SAVED, kitchen: nextKitchen }),
      vrmaLibrary: [],
      animationLibrary: [],
      applyMotionsStateFromSources: apply
    }))()
    const patch = { kitchen: {
      postures: nextKitchen.postures,
      cues: nextKitchen.cues,
      scenes: nextKitchen.scenes,
      defaultPack: nextKitchen.defaultPack
    } }
    expect(posts.map(({ body }) => body)).toEqual([{ goons_settings_patch: patch }])
    await assertStored({ kitchen: patch.kitchen })
    expect(apply).toHaveBeenCalledOnce()
  })

  it('GLB preview patches only the preview body and preserves sibling user settings', async () => {
    await panelWriter('persistGlbPreviewGoonSelection', context())('new-preview')
    expect(posts.map(({ body }) => body)).toEqual([{ goons_settings_patch: { motions: { glbPreviewGoonId: 'new-preview' } } }])
    await assertStored({ motions: { glbPreviewGoonId: 'new-preview' } })
  })

  it('pack import patches only imported Kitchen library sections', async () => {
    const imported = {
      cues: { imported_cue: { kind: 'mood', name: 'Imported cue' } },
      emojiMap: { '✨': 'imported_cue' },
      scenes: { imported_scene: { id: 'imported_scene', name: 'Imported scene' } },
      postures: { imported_posture: { id: 'imported_posture', name: 'Imported posture', basePosture: 'standing' } }
    }
    const applyKitchen = vi.fn()
    const pendingImportPack = {
      manifest: {
        postures: [{ id: 'imported_posture', name: 'Imported posture', basePosture: 'stand' }],
        motions: [],
        moods: [{ cue: { kind: 'mood', name: 'Imported cue' }, emojis: ['✨'] }],
        emotes: [],
        scenes: [{ id: 'imported_scene', name: 'Imported scene' }],
        exportedAt: 'now'
      },
      entries: new Map()
    }
    await panelWriter('confirmLibraryImport', context({
      pendingImportPack,
      libraryImportBusy: false,
      remapImportedCuePosture: (value: unknown) => value,
      remapImportedScenePostures: (value: unknown) => value,
      restoreSceneFromPack: (value: unknown) => value,
      mergeImportedCustomPostures: () => ({ idMap: {}, postures: imported.postures }),
      importGoonLibraryExportBundle: () => ({
        settings: { ...SAVED, kitchen: { ...SAVED.kitchen, ...imported } },
        renamedCueNames: {}, renamedSceneNames: {}, emojiConflicts: []
      }),
      applyKitchenStateFromSettings: applyKitchen,
      applyClosetStateFromSettings: vi.fn(),
      applySceneStateFromSettings: vi.fn(),
      importPackPreviewOpen: true,
      sceneAssetCache: new Map(),
      motionCache: new Map()
    }))()
    const patch = { kitchen: imported }
    expect(posts.map(({ body }) => body)).toEqual([{ goons_settings_patch: patch }])
    await assertStored({ kitchen: patch.kitchen })
    expect(applyKitchen).toHaveBeenCalledOnce()
  })

  it('motion-only pack import does not post stale Kitchen settings', async () => {
    const newerServerSettings = structuredClone(SAVED)
    newerServerSettings.kitchen!.scenes = { scene_from_other_tab: { id: 'scene_from_other_tab', name: 'Newer scene' } }
    await redis.updateUserSettings(USER, { displayName: 'Authoritative', goons_settings: newerServerSettings } as any)
    const restoreMotion = vi.fn(async () => ({ filename: 'motion_a.vrma' }))
    await panelWriter('confirmLibraryImport', context({
      pendingImportPack: {
        manifest: { postures: [], motions: [{ filename: 'motion_a.vrma' }], moods: [], emotes: [], scenes: [], exportedAt: 'now' },
        entries: new Map()
      },
      libraryImportBusy: false,
      remapImportedMotionRefPosture: (value: unknown) => value,
      restorePackMotionFile: restoreMotion,
      mergeImportedCustomPostures: () => ({ idMap: {}, postures: {} }),
      importGoonLibraryExportBundle: () => ({
        settings: structuredClone(SAVED), renamedCueNames: {}, renamedSceneNames: {}, emojiConflicts: []
      }),
      applyKitchenStateFromSettings: vi.fn(),
      applyClosetStateFromSettings: vi.fn(),
      applySceneStateFromSettings: vi.fn()
    }))()

    expect(posts).toEqual([])
    expect(restoreMotion).toHaveBeenCalledOnce()
    expect(await storedUserSettings(USER)).toMatchObject({ goons_settings: { kitchen: { scenes: newerServerSettings.kitchen!.scenes } } })
  })

  it('single-kind cue import leaves a newer Scenes section untouched', async () => {
    const newerServerSettings = structuredClone(SAVED)
    newerServerSettings.kitchen!.scenes = { scene_from_other_tab: { id: 'scene_from_other_tab', name: 'Newer scene' } }
    await redis.updateUserSettings(USER, { displayName: 'Authoritative', goons_settings: newerServerSettings } as any)
    const importedCues = { ...SAVED.kitchen!.cues, imported_cue: { kind: 'mood', name: 'Imported cue' } }
    const importedEmojiMap = { ...SAVED.kitchen!.emojiMap, '✨': 'imported_cue' }
    await panelWriter('confirmLibraryImport', context({
      pendingImportPack: {
        manifest: {
          postures: [], motions: [],
          moods: [{ cue: { kind: 'mood', name: 'Imported cue' }, emojis: ['✨'] }],
          emotes: [], scenes: [], exportedAt: 'now'
        },
        entries: new Map()
      },
      libraryImportBusy: false,
      remapImportedCuePosture: (value: unknown) => value,
      mergeImportedCustomPostures: () => ({ idMap: {}, postures: {} }),
      importGoonLibraryExportBundle: () => ({
        settings: { ...SAVED, kitchen: { ...SAVED.kitchen, cues: importedCues, emojiMap: importedEmojiMap } },
        renamedCueNames: {}, renamedSceneNames: {}, emojiConflicts: []
      }),
      applyKitchenStateFromSettings: vi.fn(),
      applyClosetStateFromSettings: vi.fn(),
      applySceneStateFromSettings: vi.fn()
    }))()

    expect(posts.map(({ body }) => body)).toEqual([{
      goons_settings_patch: { kitchen: { cues: importedCues, emojiMap: importedEmojiMap } }
    }])
    expect(await storedUserSettings(USER)).toMatchObject({ goons_settings: {
      kitchen: { scenes: newerServerSettings.kitchen!.scenes, cues: importedCues }
    } })
  })

  it.each([
    ['Kitchen', 'saveKitchenSettings'],
    ['Closet', 'saveClosetSettings'],
    ['Scenes', 'saveScenesSettings'],
    ['Motions', 'saveMotionsAndPostures'],
    ['GLB preview', 'persistGlbPreviewGoonSelection'],
    ['pack import', 'confirmLibraryImport'],
    ['skybox upload', 'handleSceneSelection'],
    ['room-shell upload', 'handleRoomShellSelection'],
    ['room-texture upload', 'handleRoomTextureSelection'],
    ['scene-prop upload', 'handleScenePropSelection']
  ])('%s refuses before side effects when the user-settings read is failed', async (_label, name) => {
    resetUserSettings()
    failUserSettingsRead(new Error('settings unavailable'))
    const upload = vi.fn()
    const metadata = vi.fn()
    const cleanup = vi.fn()
    const fn = panelWriter(name, context({
      uploadGoonRoomTexture: upload,
      uploadGoonSceneSkybox: upload,
      uploadGoonRoomShell: upload,
      uploadGoonSceneProp: upload,
      updateGoonAnimationLibraryMetadata: metadata,
      restorePackMotionFile: upload,
      restoreSceneFromPack: upload,
      persistSceneLibrary: cleanup,
      pendingImportPack: { manifest: { moods: [], emotes: [], scenes: [], motions: [], postures: [] }, entries: new Map() },
      validateMotionPostureDrafts: () => null,
      hasPendingMarkerDrafts: () => false,
      goonsSettings: SAVED
    }))
    await fn(
      name === 'persistGlbPreviewGoonSelection' ? 'new-preview' :
      name.startsWith('handle') ? { currentTarget: { files: [{}] } } : undefined
    )
    expect(posts).toEqual([])
    expect(upload).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(await storedUserSettings(USER)).toMatchObject({ goons_settings: SAVED })
  })

  it('all panel writers also refuse before side effects while unread', async () => {
    resetUserSettings()
    const upload = vi.fn()
    const metadata = vi.fn()
    const cleanup = vi.fn()
    for (const name of [
      'saveKitchenSettings', 'saveClosetSettings', 'saveScenesSettings', 'saveMotionsAndPostures',
      'persistGlbPreviewGoonSelection', 'confirmLibraryImport', 'handleSceneSelection',
      'handleRoomShellSelection', 'handleRoomTextureSelection', 'handleScenePropSelection'
    ]) {
      await panelWriter(name, context({
        uploadGoonRoomTexture: upload,
        uploadGoonSceneSkybox: upload,
        uploadGoonRoomShell: upload,
        uploadGoonSceneProp: upload,
        updateGoonAnimationLibraryMetadata: metadata,
        restorePackMotionFile: upload,
        restoreSceneFromPack: upload,
        persistSceneLibrary: cleanup,
        pendingImportPack: { manifest: { moods: [], emotes: [], scenes: [], motions: [], postures: [] }, entries: new Map() },
        validateMotionPostureDrafts: () => null,
        hasPendingMarkerDrafts: () => false
      }))(name === 'persistGlbPreviewGoonSelection' ? 'new-preview' :
        name.startsWith('handle') ? { currentTarget: { files: [{}] } } : undefined)
    }
    expect(posts).toEqual([])
    expect(upload).not.toHaveBeenCalled()
    expect(metadata).not.toHaveBeenCalled()
    expect(cleanup).not.toHaveBeenCalled()
    expect(await storedUserSettings(USER)).toMatchObject({ goons_settings: SAVED })
  })
})
