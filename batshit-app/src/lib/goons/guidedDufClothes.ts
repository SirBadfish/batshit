import * as THREE from 'three'
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js'
import { MToonMaterialLoaderPlugin, VRMLoaderPlugin } from '@pixiv/three-vrm'
import { MToonNodeMaterial } from '@pixiv/three-vrm/nodes'
import {
  getDefaultClosetSlotLabel,
  isBodySkinClosetSlotMaterialName,
  isClosetSlotMaterialName,
  normalizeClosetSlotMaterialName
} from '$lib/goons/closetMaterials'
import type { GoonGuidedOutfitPiece } from '$lib/types/goons'

export type GuidedDufClothesAnalysis = {
  pieces: GoonGuidedOutfitPiece[]
  warnings: string[]
}

function createVrmSceneLoader() {
  const loader = new GLTFLoader()
  loader.register((parser: any) => {
    const mtoonMaterialPlugin = new MToonMaterialLoaderPlugin(parser, {
      materialType: MToonNodeMaterial
    })
    return new VRMLoaderPlugin(parser, { mtoonMaterialPlugin })
  })
  return loader
}

function collectRenderableNodeNames(root: THREE.Object3D | null | undefined) {
  const names = new Set<string>()
  if (!root) return names
  root.traverse((node) => {
    if (!('isMesh' in node) && !('isSkinnedMesh' in node)) return
    const trimmed = node.name.trim()
    if (!trimmed) return
    names.add(trimmed)
  })
  return names
}

function getMeshMaterials(node: THREE.Object3D) {
  const mesh = node as THREE.Mesh
  if (!('material' in mesh)) return [] as THREE.Material[]
  const materials = Array.isArray(mesh.material) ? mesh.material : [mesh.material]
  return materials.filter(Boolean)
}

export function isSupportedGuidedDufClothesMaterialName(materialName: string) {
  return (
    isClosetSlotMaterialName(materialName) && !isBodySkinClosetSlotMaterialName(materialName)
  )
}

export function buildGuidedDufOverlayPieceId(overlayId: string, slotName: string) {
  return `duf_${overlayId}_${normalizeClosetSlotMaterialName(slotName)}`
}

export function analyzeGuidedDufClothesScene(
  overlayId: string,
  overlayRoot: THREE.Object3D,
  baseRoot: THREE.Object3D | null | undefined
): GuidedDufClothesAnalysis {
  const baseNodeNames = collectRenderableNodeNames(baseRoot)
  const skippedBecauseAlreadyPresent = new Set<string>()
  const skippedSkinOverlayMaterials = new Set<string>()
  const groups = new Map<
    string,
    {
      materialNames: Set<string>
      runtimeNodeNames: Set<string>
    }
  >()

  overlayRoot.traverse((node) => {
    if (!('isMesh' in node) && !('isSkinnedMesh' in node)) return
    const runtimeNodeName = node.name.trim()
    if (!runtimeNodeName) return

    const supportedMaterials = new Set<string>()
    for (const material of getMeshMaterials(node)) {
      const materialName = material.name?.trim()
      if (!materialName) continue
      if (isBodySkinClosetSlotMaterialName(materialName)) {
        skippedSkinOverlayMaterials.add(normalizeClosetSlotMaterialName(materialName))
        continue
      }
      if (!isSupportedGuidedDufClothesMaterialName(materialName)) continue
      supportedMaterials.add(normalizeClosetSlotMaterialName(materialName))
    }
    if (supportedMaterials.size === 0) return

    if (baseNodeNames.has(runtimeNodeName)) {
      skippedBecauseAlreadyPresent.add(runtimeNodeName)
      return
    }

    const slotName = [...supportedMaterials].sort((a, b) => a.localeCompare(b))[0]
    const group = groups.get(slotName) ?? {
      materialNames: new Set<string>(),
      runtimeNodeNames: new Set<string>()
    }
    group.runtimeNodeNames.add(runtimeNodeName)
    for (const materialName of supportedMaterials) {
      group.materialNames.add(materialName)
    }
    groups.set(slotName, group)
  })

  const pieces = [...groups.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([slotName, group]) => ({
      id: buildGuidedDufOverlayPieceId(overlayId, slotName),
      label: getDefaultClosetSlotLabel(slotName),
      runtimeNodeNames: [...group.runtimeNodeNames].sort((a, b) => a.localeCompare(b)),
      category: 'DUF',
      defaultOn: true,
      source: 'duf-overlay' as const,
      overlayId,
      materialNames: [...group.materialNames].sort((a, b) => a.localeCompare(b))
    }))

  const warnings: string[] = []
  if (pieces.length === 0) {
    warnings.push('No supported DUF clothing meshes were found to import.')
  }
  if (skippedSkinOverlayMaterials.size > 0) {
    warnings.push(
      `Skipped skin-overlay clothing lanes: ${[...skippedSkinOverlayMaterials]
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}.`
    )
  }
  if (skippedBecauseAlreadyPresent.size > 0) {
    warnings.push(
      `Skipped meshes already present on the base avatar: ${[...skippedBecauseAlreadyPresent]
        .sort((a, b) => a.localeCompare(b))
        .join(', ')}.`
    )
  }

  return { pieces, warnings }
}

export async function analyzeGuidedDufClothesFile(
  overlayId: string,
  file: File,
  baseRoot: THREE.Object3D | null | undefined
) {
  const objectUrl = URL.createObjectURL(file)
  try {
    const loader = createVrmSceneLoader()
    const gltf = await loader.loadAsync(objectUrl)
    const scene = gltf.scene ?? gltf.scenes?.[0]
    if (!scene) {
      return {
        pieces: [] as GoonGuidedOutfitPiece[],
        warnings: ['DUF clothes analysis could not find a scene root in the imported VRM.']
      }
    }
    return analyzeGuidedDufClothesScene(overlayId, scene, baseRoot)
  } finally {
    URL.revokeObjectURL(objectUrl)
  }
}
