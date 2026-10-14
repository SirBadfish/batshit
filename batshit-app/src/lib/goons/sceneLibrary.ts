import type { GoonSceneDefinition, GoonSceneMap, GoonsSettings } from '$lib/types/goons'

export const SCENE_ASSET_KINDS = ['skybox', 'roomShell', 'prop'] as const
export type SceneAssetKind = (typeof SCENE_ASSET_KINDS)[number]
export type SceneAssetUploads = Record<SceneAssetKind, Set<string>>
export type SceneAsset = { kind: SceneAssetKind; filename: string }

export function buildUniqueSceneId(name: string, scenes: GoonSceneMap): string {
  const base = name.trim().toLowerCase()
    .replace(/[^a-z0-9]+/g, '_').replace(/^_+|_+$/g, '') || 'scene'
  let candidate = base
  let suffix = 2
  while (Object.hasOwn(scenes, candidate)) candidate = `${base}_${suffix++}`
  return candidate
}

export function duplicateSceneDefinition(scenes: GoonSceneMap, sceneId: string): GoonSceneDefinition {
  const source = scenes[sceneId]
  if (!source) throw new Error('The scene to duplicate is no longer available.')
  const names = new Set(Object.values(scenes).map((scene) => scene.name.trim().toLowerCase()))
  const base = `${source.name.trim() || 'Scene'} Copy`
  let name = base
  let suffix = 2
  while (names.has(name.toLowerCase())) name = `${base} ${suffix++}`
  // Scene definitions are JSON data and may arrive through a Svelte state proxy.
  // Preserve scene-scoped prop/marker IDs and links, but share only file URLs,
  // never mutable nested settings objects.
  const copy = JSON.parse(JSON.stringify(source)) as GoonSceneDefinition
  return { ...copy, id: buildUniqueSceneId(name, scenes), name }
}

export function collectSceneAssetFilenames(
  kind: SceneAssetKind,
  scenes?: GoonSceneMap | null
): Set<string> {
  const filenames = new Set<string>()
  for (const scene of Object.values(scenes ?? {})) {
    const refs = kind === 'prop'
      ? (scene.props ?? []).map((prop) => prop.fileRef)
      : [kind === 'skybox' ? scene.skybox : scene.roomShell]
    for (const ref of refs) {
      const filename = ref?.filename?.trim()
      if (filename) filenames.add(filename)
    }
  }
  return filenames
}

/** Only confirmed saved scenes can release existing file ownership. */
export function planSceneAssetCleanup(
  previousScenes: GoonSceneMap | undefined,
  persistedScenes: GoonSceneMap | undefined,
  uploads: SceneAssetUploads
): SceneAsset[] {
  return SCENE_ASSET_KINDS.flatMap((kind) => {
    const retained = collectSceneAssetFilenames(kind, persistedScenes)
    const candidates = new Set([...collectSceneAssetFilenames(kind, previousScenes), ...uploads[kind]])
    return [...candidates].filter((filename) => !retained.has(filename))
      .map((filename) => ({ kind, filename }))
  })
}

/** Save first, then release only assets absent from the server-confirmed library. */
export async function persistSceneLibrary({
  persist,
  previousScenes,
  uploads,
  protectedUploads,
  deleteAsset
}: {
  persist: () => Promise<GoonsSettings>
  previousScenes: GoonSceneMap | undefined
  uploads: SceneAssetUploads
  protectedUploads: SceneAssetUploads
  deleteAsset: (asset: SceneAsset) => Promise<void>
}) {
  const attemptedUploads: SceneAssetUploads = {
    skybox: new Set([...protectedUploads.skybox, ...uploads.skybox]),
    roomShell: new Set([...protectedUploads.roomShell, ...uploads.roomShell]),
    prop: new Set([...protectedUploads.prop, ...uploads.prop])
  }
  // Transfer ownership before awaiting the request: Cancel/unmount may discard
  // drafts while it is pending. A rejected response can follow a committed save,
  // so submitted files stay protected until a later confirmed save reconciles them.
  for (const kind of SCENE_ASSET_KINDS) {
    for (const filename of attemptedUploads[kind]) {
      uploads[kind].delete(filename)
      protectedUploads[kind].add(filename)
    }
  }
  const settings = await persist()
  const cleanup = planSceneAssetCleanup(previousScenes, settings.kitchen?.scenes, attemptedUploads)
  for (const kind of SCENE_ASSET_KINDS) {
    for (const filename of attemptedUploads[kind]) protectedUploads[kind].delete(filename)
  }
  const cleanupFailures: Array<SceneAsset & { error: unknown }> = []
  for (const asset of cleanup) {
    try {
      await deleteAsset(asset)
    } catch (error) {
      // Keep failed cleanup eligible for the next save/discard, without turning
      // a successful settings save into a misleading save failure.
      uploads[asset.kind].add(asset.filename)
      cleanupFailures.push({ ...asset, error })
    }
  }
  return { settings, cleanupFailures }
}
