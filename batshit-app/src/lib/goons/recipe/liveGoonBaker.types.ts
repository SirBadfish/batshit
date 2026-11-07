import type { HairAssetV1 } from '../hairAssets'
import type { RecipeSource, RecipeStateSnapshot } from './recipeContracts'

export type LiveGoonBakeInput = {
  source: RecipeSource
  sourceRevision: {
    revisionId: string
    revision: number
  }
  state: RecipeStateSnapshot
  packageBytes: Uint8Array
  modelBytes: Uint8Array
  manifestBytes: Uint8Array
  hair?: LiveGoonHairBakeInput
}

export type LiveGoonHairBakeInput = {
  asset: HairAssetV1
  mainBytes: Uint8Array
  followerBytes?: Uint8Array
  physicsBytes?: Uint8Array
  neutralValueBytes: Uint8Array
  highlightMaskBytes: Uint8Array
  normalBytes?: Uint8Array
  roughnessBytes?: Uint8Array
  sparseAccentBytes?: Uint8Array
}

