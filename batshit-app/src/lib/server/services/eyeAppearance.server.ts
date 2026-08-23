import {
  parseEyeAppearanceDefinition,
  parseEyeAppearanceState,
  type EyeAppearanceDefinition,
  type EyeAppearanceState
} from '$lib/goons/eyeAppearance'
import { APPEARANCE_DIAL_VALUES_CONTRACT } from '$lib/goons/appearanceDials.contracts'
import { parseFacialArtworkDefinition } from '$lib/goons/facialArtwork'
import {
  parseEyeApertureSeamDefinition,
  validateSocketEyeApertureOwnership
} from '$lib/goons/eyeApertureSeam'
import { parseSocketEyeSurfaceDefinition } from '$lib/goons/socketEyeSurface'
import type { GoonRecord } from '$lib/types/goons'
import {
  readStoredGoonManifest,
  StoredUploadJsonError,
  type StoredUploadJsonReader
} from './storedUploadJson.server'

type RedisJsonReader = StoredUploadJsonReader

function fail(message: string): never {
  throw new Error(`[eye-appearance/v5] ${message}`)
}

async function loadStoredManifest(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar'>
): Promise<Record<string, unknown> | null> {
  const filename = goon.customAvatar?.manifest?.filename
  if (!filename) return null
  try {
    return await readStoredGoonManifest(client, filename)
  } catch (error) {
    if (error instanceof StoredUploadJsonError) {
      fail(error.message)
    }
    throw error
  }
}

export async function loadGoonEyeAppearanceDefinition(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>
): Promise<EyeAppearanceDefinition | null> {
  const manifest = await loadStoredManifest(client, goon)
  if (!manifest || manifest.eyeAppearance === undefined) return null
  const recipeAppearanceDials = goon.recipe?.authoringRevision.state.appearanceDials
  const hasRecipeAppearanceOwnership =
    recipeAppearanceDials?.contract === APPEARANCE_DIAL_VALUES_CONTRACT
  if (
    (manifest.appearanceDials === undefined || manifest.appearanceDials === null) &&
    !hasRecipeAppearanceOwnership
  ) {
    fail('eye-appearance/v5 requires the package Recipe appearance-dials/v2 definition')
  }
  const definition = parseEyeAppearanceDefinition(manifest.eyeAppearance)
  if (manifest.socketEyeSurface === undefined || manifest.eyeApertureSeam === undefined) {
    fail('eye-appearance/v5 requires socket-eye-surface/v2 and eye-aperture-seam/v2')
  }
  const socketEyeSurface = parseSocketEyeSurfaceDefinition(manifest.socketEyeSurface)
  const eyeApertureSeam = parseEyeApertureSeamDefinition(manifest.eyeApertureSeam)
  validateSocketEyeApertureOwnership(socketEyeSurface, eyeApertureSeam)
  if (
    definition.dependencies.socketEyeSurface.definitionSha256 !==
      socketEyeSurface.definitionSha256 ||
    definition.dependencies.eyeApertureSeam.definitionSha256 !==
      eyeApertureSeam.definitionSha256
  ) {
    fail('eye-appearance/v5 dependencies do not match the installed socket-eye definitions')
  }
  for (const side of ['left', 'right'] as const) {
    if (
      definition.runtimeBindings[side].physicalEyeNode !==
      socketEyeSurface.runtimeBindings[side].nodes.physicalEye
    ) {
      fail(`eye-appearance/v5 ${side} physical-eye binding does not match socket-eye-surface/v2`)
    }
    if (
      definition.runtimeBindings[side].irisNeutralRadiusMeters *
        definition.controls[0].maximum >=
      socketEyeSurface.runtimeBindings[side].sphere.radiusMeters
    ) {
      fail(`eye-appearance/v5 ${side} Iris Size range exceeds the physical eye sphere`)
    }
    if (
      definition.runtimeBindings[side].pupilNeutralRadiusRatio *
        definition.controls[1].maximum >=
      1
    ) {
      fail(`eye-appearance/v5 ${side} Pupil Size range exceeds the iris surface`)
    }
    const horizontalControl = definition.controls[2]
    const verticalControl = definition.controls[3]
    const neutralPlacement = definition.runtimeBindings[side].neutralPlacement
    const maximumHorizontalTravel =
      definition.runtimeBindings[side].irisHorizontalTravelMeters *
      Math.max(
        Math.abs(neutralPlacement.horizontalTravelFraction + horizontalControl.minimum),
        Math.abs(neutralPlacement.horizontalTravelFraction + horizontalControl.maximum)
      )
    const maximumVerticalTravel =
      definition.runtimeBindings[side].irisVerticalTravelMeters *
      Math.max(
        Math.abs(neutralPlacement.verticalTravelFraction + verticalControl.minimum),
        Math.abs(neutralPlacement.verticalTravelFraction + verticalControl.maximum)
      )
    const maximumIrisRadius =
      definition.runtimeBindings[side].irisNeutralRadiusMeters *
      definition.controls[0].maximum
    if (
      Math.hypot(maximumHorizontalTravel, maximumVerticalTravel) + maximumIrisRadius >=
      socketEyeSurface.runtimeBindings[side].sphere.radiusMeters
    ) {
      fail(`eye-appearance/v5 ${side} Iris Position range exceeds the physical eye sphere`)
    }
  }
  if (manifest.facialArtwork === undefined) {
    fail('eye-appearance/v5 requires the matching facial-artwork/v6 package definition')
  }
  const facialArtwork = parseFacialArtworkDefinition(manifest.facialArtwork)
  if (
    facialArtwork.dependencies.eyeAppearance.definitionSha256 !== definition.definitionSha256 ||
    facialArtwork.dependencies.socketEyeSurface.definitionSha256 !==
      socketEyeSurface.definitionSha256 ||
    facialArtwork.dependencies.eyeApertureSeam.definitionSha256 !==
      eyeApertureSeam.definitionSha256
  ) {
    fail('facial-artwork/v6 dependencies do not match the installed socket-eye tuple')
  }
  for (const side of ['left', 'right'] as const) {
    const physicalEyeNode = socketEyeSurface.runtimeBindings[side].nodes.physicalEye
    const treatmentNode = eyeApertureSeam.runtimeBindings[side].lashesEyeOutlineNode
    for (const role of facialArtwork.roles) {
      const target = role.target[side]
      if (
        target.bindingKind === 'physical-eye-layer' &&
        target.runtimeNodes[0] !== physicalEyeNode
      ) {
        fail(`facial-artwork/v6 ${role.id} ${side} target does not match the physical eye`)
      }
      if (
        role.id === 'lashes_eye_outline' &&
        target.runtimeNodes[0] !== treatmentNode
      ) {
        fail(`facial-artwork/v6 ${side} treatment target does not match eye-aperture-seam/v2`)
      }
    }
  }
  return definition
}

export async function validateGoonEyeAppearanceState(
  client: RedisJsonReader,
  goon: Pick<GoonRecord, 'customAvatar' | 'recipe'>,
  value: unknown
): Promise<EyeAppearanceState | null> {
  if (value === null) return null
  const definition = await loadGoonEyeAppearanceDefinition(client, goon)
  if (!definition) fail('current Goon package does not support Eye Appearance')
  return parseEyeAppearanceState(definition, value)
}
