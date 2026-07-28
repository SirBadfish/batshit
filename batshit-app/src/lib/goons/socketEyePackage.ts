import type { GoonCustomAvatarManifest } from './customAvatar'
import { resolveCustomPerformanceRigBlock } from './customAvatar'
import { resolveCustomPerformanceRigManifest } from './customPerformanceRig'
import { parseEyeApertureSeamDefinition, validateSocketEyeApertureOwnership } from './eyeApertureSeam'
import { parseEyeAppearanceDefinition } from './eyeAppearance'
import { classifyFacialArtworkPackageCapability } from './facialArtwork.package'
import { parseFacialArtworkDefinition } from './facialArtwork'
import { parseSocketEyeSurfaceDefinition } from './socketEyeSurface'

export function parseFirstPartySocketEyePackage(manifest: GoonCustomAvatarManifest) {
  const capability = classifyFacialArtworkPackageCapability(manifest)
  if (capability.status === 'absent' || capability.status === 'retired') return null
  if (capability.status === 'malformed') throw new Error(capability.error)

  const socketEyeSurface = parseSocketEyeSurfaceDefinition(manifest.socketEyeSurface)
  const eyeApertureSeam = parseEyeApertureSeamDefinition(manifest.eyeApertureSeam)
  validateSocketEyeApertureOwnership(socketEyeSurface, eyeApertureSeam)
  const eyeAppearance = parseEyeAppearanceDefinition(manifest.eyeAppearance)
  const facialArtwork = parseFacialArtworkDefinition(manifest.facialArtwork)

  if (
    eyeAppearance.dependencies.socketEyeSurface.definitionSha256 !==
      socketEyeSurface.definitionSha256 ||
    eyeAppearance.dependencies.eyeApertureSeam.definitionSha256 !==
      eyeApertureSeam.definitionSha256
  ) {
    throw new Error('[socket-eye-package] Eye Appearance dependency hashes do not match the package.')
  }
  if (
    facialArtwork.dependencies.eyeAppearance.definitionSha256 !==
      eyeAppearance.definitionSha256 ||
    facialArtwork.dependencies.socketEyeSurface.definitionSha256 !==
      socketEyeSurface.definitionSha256 ||
    facialArtwork.dependencies.eyeApertureSeam.definitionSha256 !==
      eyeApertureSeam.definitionSha256
  ) {
    throw new Error('[socket-eye-package] Facial Artwork dependency hashes do not match the package.')
  }

  for (const side of ['left', 'right'] as const) {
    const capNode = socketEyeSurface.runtimeBindings[side].nodes.compositeCap
    if (eyeAppearance.runtimeBindings[side].compositeCapNode !== capNode) {
      throw new Error(`[socket-eye-package] Eye Appearance ${side} cap node does not match the socket surface.`)
    }
    const compositeTargets = facialArtwork.roles
      .filter((role) => role.target[side].bindingKind === 'socket-eye-composite-layer')
      .map((role) => role.target[side].runtimeNodes[0])
    if (compositeTargets.some((node) => node !== capNode)) {
      throw new Error(`[socket-eye-package] Facial Artwork ${side} composite layers do not share the socket cap.`)
    }
  }

  const performance = resolveCustomPerformanceRigManifest(
    resolveCustomPerformanceRigBlock(manifest),
    { required: true }
  )
  if (performance.issues.length > 0 || !performance.manifest) {
    throw new Error(`[socket-eye-package] ${performance.issues.join(' ')}`)
  }
  if (performance.manifest.contract !== 'batshit-performance-rig/v2') {
    throw new Error('[socket-eye-package] First-party socket eyes require batshit-performance-rig/v2.')
  }

  return {
    socketEyeSurface,
    eyeApertureSeam,
    eyeAppearance,
    facialArtwork,
    performanceRig: performance.manifest
  }
}
