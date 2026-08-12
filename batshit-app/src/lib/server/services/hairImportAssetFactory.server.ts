import {
  HAIR_ASSET_AUDIT_CONTRACT,
  HAIR_ASSET_CONTRACT,
  HAIR_FIT_RECEIPT_CONTRACT,
  HAIR_FOLLOWER_DECLARATION_CONTRACT,
  HAIR_MATERIAL_DECLARATION_CONTRACT,
  HAIR_PHYSICS_DECLARATION_CONTRACT,
  HAIR_REFIT_SOURCE_CONTRACT,
  hairAssetRevisionSha256,
  hairFitReceiptSha256,
  hairMaterialDefinitionSha256,
  parseHairRefitSource,
  verifyHairAsset,
  type HairAssetV1,
  type HairRefitSourceV1,
  type HairRefitTransformV1
} from '$lib/goons/hairAssets'
import {
  hairFollowerDefinitionSha256,
  parseHairFollowerDefinition,
  type HairFollowerDefinitionV1
} from '$lib/goons/hairFollowers'
import { HAIR_ROOT_WEIGHTED_MOTION_TAG } from '$lib/goons/hairMotionSettings'
import type { RecipeSourceIdentity } from '$lib/goons/recipe/packageMetadata'
import {
  parseSecondaryMotionDefinition,
  secondaryMotionDefinitionSha256,
  type SecondaryMotionDefinitionV1
} from '$lib/goons/secondaryMotion'

import type { HairImportOwnedFile } from './hairImportJobRepository.server'
import { hairAssetFileRef } from './hairImportOwnedFiles.server'

const ZERO_SHA256 = '0'.repeat(64)

function stableId(value: string, context: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (!normalized || !/^[a-z0-9][a-z0-9._:-]*$/.test(normalized)) {
    throw new Error(`${context} must contain at least one stable letter or number.`)
  }
  return normalized.slice(0, 96)
}

export type ImportedHairAssetFiles = {
  geometry: HairImportOwnedFile
  followerDefinition: HairImportOwnedFile
  physicsDefinition: HairImportOwnedFile
  neutralValue: HairImportOwnedFile
  highlightMask: HairImportOwnedFile
  preview: HairImportOwnedFile
  importReceipt: HairImportOwnedFile
  refitSource: HairImportOwnedFile
}

export async function buildImportedHairAsset(input: {
  displayName: string
  assetId: string
  revisionId: string
  revision: number
  recipeSource: RecipeSourceIdentity
  headNode: string
  authoredRootMatrix: number[]
  sourceSha256: string
  sourceMode: string
  author: string
  license: string
  followerDefinition: HairFollowerDefinitionV1
  physicsDefinition: SecondaryMotionDefinitionV1
  files: ImportedHairAssetFiles
  audit: {
    meshCount: number
    vertexCount: number
    triangleCount: number
    materialCount: number
  }
}): Promise<HairAssetV1> {
  const assetId = stableId(input.assetId, 'Hair Asset id')
  const revisionId = stableId(input.revisionId, 'Hair Asset revision id')
  const followerDefinition = parseHairFollowerDefinition(input.followerDefinition)
  const physicsDefinition = parseSecondaryMotionDefinition(input.physicsDefinition)
  const [followerDefinitionSha256, physicsDefinitionSha256] = await Promise.all([
    hairFollowerDefinitionSha256(followerDefinition),
    secondaryMotionDefinitionSha256(physicsDefinition)
  ])
  if (
    followerDefinition.assetId !== assetId ||
    followerDefinition.revisionId !== revisionId ||
    physicsDefinition.owner.assetId !== assetId ||
    physicsDefinition.owner.revisionId !== revisionId
  ) {
    throw new Error(
      'Generated Hair follower and motion definitions do not bind the final immutable ids.'
    )
  }
  if (
    followerDefinition.geometrySha256 !== input.files.geometry.sha256 ||
    physicsDefinition.owner.geometrySha256 !== input.files.geometry.sha256
  ) {
    throw new Error(
      'Generated Hair follower and motion definitions do not bind the final geometry bytes.'
    )
  }

  const material = {
    contract: HAIR_MATERIAL_DECLARATION_CONTRACT,
    status: 'ready' as const,
    definitionSha256: ZERO_SHA256,
    layout: {
      width: 64,
      height: 64,
      uvSet: 0 as const,
      flipY: false as const,
      neutralValue: {
        colorSpace: 'srgb' as const,
        channel: 'rgb' as const,
        pivot: 0.5 as const,
        highlightStrength: 0.35 as const
      },
      highlightMask: { colorSpace: 'linear' as const, channel: 'r' as const },
      normal: null,
      roughness: null
    },
    neutralValueTexture: hairAssetFileRef(input.files.neutralValue),
    highlightMask: hairAssetFileRef(input.files.highlightMask),
    normalTexture: null,
    roughnessTexture: null,
    defaults: {
      baseColor: '#2a1738',
      highlightColor: '#6f4a8e',
      metalness: 0,
      roughness: 0.58,
      alphaMode: 'OPAQUE' as const
    }
  }
  material.definitionSha256 = await hairMaterialDefinitionSha256(material)

  const draft = {
    schemaVersion: HAIR_ASSET_CONTRACT,
    assetId,
    revisionId,
    revision: input.revision,
    revisionSha256: ZERO_SHA256,
    sourceClass: 'user' as const,
    display: {
      name: input.displayName.trim(),
      previewImage: hairAssetFileRef(input.files.preview),
      tags: ['appearance-followers-v2', HAIR_ROOT_WEIGHTED_MOTION_TAG, 'imported', input.sourceMode]
        .map((tag) => stableId(tag, 'Hair tag'))
        .sort()
    },
    compatibility: {
      baseId: input.recipeSource.baseId,
      fitFamily: input.recipeSource.fitFamily
    },
    geometry: {
      main: hairAssetFileRef(input.files.geometry),
      sparseAccent: null
    },
    attachment: {
      headNode: input.headNode,
      authoredRootMatrix: input.authoredRootMatrix,
      fitReceipt: {
        contract: HAIR_FIT_RECEIPT_CONTRACT,
        receiptId: `${assetId}-fit-${revisionId}`.slice(0, 96),
        assetId,
        assetRevisionId: revisionId,
        assetRevisionSha256: ZERO_SHA256,
        baseId: input.recipeSource.baseId,
        fitFamily: input.recipeSource.fitFamily,
        headAttachmentNode: input.headNode,
        appearanceDefinitionSha256: input.recipeSource.definitionSha256,
        physicalBasisSha256: input.recipeSource.physicalBasisSha256,
        topologySha256: input.recipeSource.topologySha256,
        skeletonHierarchySha256: input.recipeSource.skeletonHierarchySha256,
        fitSha256: ZERO_SHA256
      }
    },
    material,
    follower: {
      contract: HAIR_FOLLOWER_DECLARATION_CONTRACT,
      mode: 'appearance-followers/v2' as const,
      definitionSha256: followerDefinitionSha256,
      asset: hairAssetFileRef(input.files.followerDefinition),
      staticReason: null
    },
    physics: {
      contract: HAIR_PHYSICS_DECLARATION_CONTRACT,
      mode: 'secondary-motion/v1' as const,
      definitionSha256: physicsDefinitionSha256,
      asset: hairAssetFileRef(input.files.physicsDefinition),
      staticReason: null
    },
    audit: {
      contract: HAIR_ASSET_AUDIT_CONTRACT,
      ...input.audit,
      textureCount: 2,
      sparseAccent: false,
      receiptSha256: input.files.importReceipt.sha256
    },
    provenance: {
      author: input.author.trim(),
      license: input.license.trim(),
      sourceTool: `Batshit ${input.sourceMode} reviewed Hair importer`,
      sourceSha256: input.sourceSha256,
      catalogEligible: false,
      productExportApproved: false
    },
    receiptRefs: [hairAssetFileRef(input.files.importReceipt)]
  }
  draft.revisionSha256 = await hairAssetRevisionSha256(draft)
  draft.attachment.fitReceipt.assetRevisionSha256 = draft.revisionSha256
  draft.attachment.fitReceipt.fitSha256 = await hairFitReceiptSha256(draft.attachment.fitReceipt)
  return verifyHairAsset(draft)
}

export function buildImportedHairRefitSource(input: {
  assetId: string
  revisionId: string
  source: HairImportOwnedFile
  startingTransform: HairRefitTransformV1
  savedTransform: HairRefitTransformV1
}): HairRefitSourceV1 {
  return parseHairRefitSource({
    contract: HAIR_REFIT_SOURCE_CONTRACT,
    assetId: stableId(input.assetId, 'Hair refit asset id'),
    revisionId: stableId(input.revisionId, 'Hair refit revision id'),
    source: hairAssetFileRef(input.source),
    startingTransform: input.startingTransform,
    savedTransform: input.savedTransform
  })
}
