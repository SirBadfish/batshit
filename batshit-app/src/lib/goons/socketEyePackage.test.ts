import { beforeEach, describe, expect, it, vi } from 'vitest'

import { parseFirstPartySocketEyePackage } from './socketEyePackage'
import { classifyFacialArtworkPackageCapability } from './facialArtwork.package'
import { parseSocketEyeSurfaceDefinition } from './socketEyeSurface'
import { parseEyeApertureSeamDefinition } from './eyeApertureSeam'
import { parseEyeAppearanceDefinition } from './eyeAppearance'
import { parseFacialArtworkDefinition } from './facialArtwork'
import { resolveCustomPerformanceRigManifest } from './customPerformanceRig'

vi.mock('./facialArtwork.package', () => ({
  classifyFacialArtworkPackageCapability: vi.fn()
}))
vi.mock('./socketEyeSurface', () => ({
  parseSocketEyeSurfaceDefinition: vi.fn()
}))
vi.mock('./eyeApertureSeam', () => ({
  parseEyeApertureSeamDefinition: vi.fn(),
  validateSocketEyeApertureOwnership: vi.fn()
}))
vi.mock('./eyeAppearance', () => ({
  parseEyeAppearanceDefinition: vi.fn()
}))
vi.mock('./facialArtwork', () => ({
  parseFacialArtworkDefinition: vi.fn()
}))
vi.mock('./customAvatar', () => ({
  resolveCustomPerformanceRigBlock: vi.fn((manifest) => manifest.rig?.performance)
}))
vi.mock('./customPerformanceRig', () => ({
  resolveCustomPerformanceRigManifest: vi.fn()
}))

const hashes = {
  socket: 'a'.repeat(64),
  seam: 'b'.repeat(64),
  eye: 'c'.repeat(64)
}

function tuple() {
  const socketEyeSurface = {
    schemaVersion: 'socket-eye-surface/v1',
    definitionSha256: hashes.socket,
    runtimeBindings: {
      left: { nodes: { compositeCap: 'Cap_L' } },
      right: { nodes: { compositeCap: 'Cap_R' } }
    }
  }
  const eyeApertureSeam = {
    schemaVersion: 'eye-aperture-seam/v1',
    definitionSha256: hashes.seam
  }
  const eyeAppearance = {
    schemaVersion: 'eye-appearance/v3',
    definitionSha256: hashes.eye,
    dependencies: {
      socketEyeSurface: {
        schemaVersion: 'socket-eye-surface/v1',
        definitionSha256: hashes.socket
      },
      eyeApertureSeam: {
        schemaVersion: 'eye-aperture-seam/v1',
        definitionSha256: hashes.seam
      }
    },
    runtimeBindings: {
      left: { compositeCapNode: 'Cap_L' },
      right: { compositeCapNode: 'Cap_R' }
    }
  }
  const compositeRoles = ['sclera', 'iris', 'pupil', 'eye_highlight'].map((id) => ({
    id,
    target: {
      left: { bindingKind: 'socket-eye-composite-layer', runtimeNodes: ['Cap_L'] },
      right: { bindingKind: 'socket-eye-composite-layer', runtimeNodes: ['Cap_R'] }
    }
  }))
  const facialArtwork = {
    schemaVersion: 'facial-artwork/v4',
    dependencies: {
      eyeAppearance: { schemaVersion: 'eye-appearance/v3', definitionSha256: hashes.eye },
      socketEyeSurface: {
        schemaVersion: 'socket-eye-surface/v1',
        definitionSha256: hashes.socket
      },
      eyeApertureSeam: {
        schemaVersion: 'eye-aperture-seam/v1',
        definitionSha256: hashes.seam
      }
    },
    roles: compositeRoles
  }
  return { socketEyeSurface, eyeApertureSeam, eyeAppearance, facialArtwork }
}

function manifest() {
  return {
    ...tuple(),
    rig: { performance: { contract: 'batshit-performance-rig/v2' } }
  } as any
}

beforeEach(() => {
  vi.mocked(classifyFacialArtworkPackageCapability).mockReturnValue({ status: 'current' })
  vi.mocked(parseSocketEyeSurfaceDefinition).mockImplementation((value) => value as any)
  vi.mocked(parseEyeApertureSeamDefinition).mockImplementation((value) => value as any)
  vi.mocked(parseEyeAppearanceDefinition).mockImplementation((value) => value as any)
  vi.mocked(parseFacialArtworkDefinition).mockImplementation((value) => value as any)
  vi.mocked(resolveCustomPerformanceRigManifest).mockReturnValue({
    manifest: { contract: 'batshit-performance-rig/v2' } as any,
    issues: []
  })
})

describe('first-party socket-eye package closure', () => {
  it('accepts only the exact hash-bound tuple with a performance v2 eye driver', () => {
    expect(parseFirstPartySocketEyePackage(manifest())).toMatchObject({
      socketEyeSurface: { definitionSha256: hashes.socket },
      eyeApertureSeam: { definitionSha256: hashes.seam },
      eyeAppearance: { definitionSha256: hashes.eye },
      performanceRig: { contract: 'batshit-performance-rig/v2' }
    })
  })

  it('rejects dependency drift and cap nodes that do not share the socket surface', () => {
    const stale = manifest()
    stale.eyeAppearance.dependencies.socketEyeSurface.definitionSha256 = 'f'.repeat(64)
    expect(() => parseFirstPartySocketEyePackage(stale)).toThrow(/dependency hashes/)

    const wrongCap = manifest()
    wrongCap.eyeAppearance.runtimeBindings.left.compositeCapNode = 'FloatingGlobe_L'
    expect(() => parseFirstPartySocketEyePackage(wrongCap)).toThrow(/left cap node/)
  })

  it('rejects the rotating-eye performance contract', () => {
    vi.mocked(resolveCustomPerformanceRigManifest).mockReturnValue({
      manifest: { contract: 'batshit-performance-rig/v1' } as any,
      issues: []
    })
    expect(() => parseFirstPartySocketEyePackage(manifest())).toThrow(
      /batshit-performance-rig\/v2/
    )
  })
})
