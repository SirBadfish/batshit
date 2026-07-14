import { describe, expect, it } from 'vitest'
import {
  GOON_BASE_POSE_FALLBACK_NAMES,
  buildGoonAnimationPriorityNames,
  filterGoonAnimationFilesForLane,
  groupGoonMotionLibraryEntries,
  isGlbAnimationFileRef,
  resolveGoonAnimationName,
  resolveGoonMotionLane,
  resolveGoonMotionMetadataWinner,
  sanitizeGoonAnimationName
} from './animationLoadPlan'
import type { GoonFileRef } from '$lib/types/goons'

describe('goon animation naming helpers', () => {
  it('normalizes animation labels without extensions', () => {
    const file: GoonFileRef = {
      filename: 'Idle Loop.vrma',
      originalName: 'Idle Loop!!.vrma',
      url: '/uploads/goons/idle-loop.vrma'
    }

    expect(resolveGoonAnimationName(file, 'fallback')).toBe('Idle_Loop')
  })

  it('uses fallbacks when animation labels normalize to nothing', () => {
    expect(sanitizeGoonAnimationName('!!!.vrma', 'motion_preview')).toBe('motion_preview')
    expect(resolveGoonAnimationName(null, 'base_stand')).toBe('base_stand')
  })

  it('builds deduped priority names with base pose fallbacks', () => {
    expect(buildGoonAnimationPriorityNames('idle')).toEqual([
      'idle',
      ...GOON_BASE_POSE_FALLBACK_NAMES
    ])

    expect(buildGoonAnimationPriorityNames('base_stand_pose')).toEqual([
      ...GOON_BASE_POSE_FALLBACK_NAMES
    ])
  })
})

describe('goon motion lane helpers', () => {
  const vrmaFile: GoonFileRef = {
    filename: '1000_idle.vrma',
    originalName: 'idle.vrma',
    url: '/uploads/goon_animations/1000_idle.vrma'
  }
  const glbFile: GoonFileRef = {
    filename: '2000_idle.glb',
    originalName: 'idle.glb',
    url: '/uploads/goon_animations/2000_idle.glb'
  }
  const gltfFile: GoonFileRef = {
    filename: '3000_wave.gltf',
    originalName: 'wave.gltf',
    url: '/uploads/goon_animations/3000_wave.gltf'
  }

  it('detects GLB-lane files by extension across name fields', () => {
    expect(isGlbAnimationFileRef(vrmaFile)).toBe(false)
    expect(isGlbAnimationFileRef(glbFile)).toBe(true)
    expect(isGlbAnimationFileRef(gltfFile)).toBe(true)
    expect(isGlbAnimationFileRef({ filename: '', url: '/x/clip.GLB' } as GoonFileRef)).toBe(true)
    expect(isGlbAnimationFileRef(null)).toBe(false)
  })

  it('resolves motion lanes with vrm as the non-GLB default', () => {
    expect(resolveGoonMotionLane(vrmaFile)).toBe('vrm')
    expect(resolveGoonMotionLane(glbFile)).toBe('glb')
    expect(resolveGoonMotionLane(null)).toBe('vrm')
  })

  it('resolves lanes from the stored asset, not the source upload name', () => {
    // Converted entries keep the source upload's name in originalName —
    // FBX-sourced VRMAs (the whole official vault) and future
    // worker-retargeted GLBs both carry "*.fbx" there. The stored
    // filename/url decides the lane; originalName is a last resort.
    const fbxSourcedVrma: GoonFileRef = {
      filename: '4000_dance.vrma',
      originalName: 'dance.fbx',
      url: '/uploads/goon_animations/4000_dance.vrma'
    }
    const fbxSourcedGlb: GoonFileRef = {
      filename: '5000_dance.glb',
      originalName: 'dance.fbx',
      url: '/uploads/goon_animations/5000_dance.glb'
    }
    expect(resolveGoonMotionLane(fbxSourcedVrma)).toBe('vrm')
    expect(resolveGoonMotionLane(fbxSourcedGlb)).toBe('glb')
  })

  it('filters mixed file lists per lane', () => {
    const files = [vrmaFile, glbFile, gltfFile]
    expect(filterGoonAnimationFilesForLane(files, 'vrm')).toEqual([vrmaFile])
    expect(filterGoonAnimationFilesForLane(files, 'glb')).toEqual([glbFile, gltfFile])
    expect(filterGoonAnimationFilesForLane(null, 'glb')).toEqual([])
  })
})

describe('unified motion library grouping', () => {
  const vrma = (overrides: Partial<GoonFileRef> = {}): GoonFileRef => ({
    filename: 'dance-hip-hop-1-abc.vrma',
    originalName: 'dance-hip-hop-1.vrma',
    url: '/uploads/goons/dance-hip-hop-1-abc.vrma',
    ...overrides
  })
  const glb = (overrides: Partial<GoonFileRef> = {}): GoonFileRef => ({
    filename: 'dance-hip-hop-1-def.glb',
    originalName: 'dance-hip-hop-1.glb',
    url: '/uploads/goons/dance-hip-hop-1-def.glb',
    ...overrides
  })

  it('pairs same-base-name files into one entry with per-lane slots', () => {
    const vrmaFile = vrma()
    const glbFile = glb()
    const solo: GoonFileRef = {
      filename: 'Idle-standing-1.vrma',
      originalName: 'Idle-standing-1.vrma',
      url: '/uploads/goons/idle-standing-1.vrma'
    }

    const entries = groupGoonMotionLibraryEntries([vrmaFile, glbFile, solo])
    expect(entries).toHaveLength(2)

    const paired = entries.find((entry) => entry.name === 'dance-hip-hop-1')
    expect(paired?.files).toEqual([vrmaFile, glbFile])
    expect(paired?.vrma).toBe(vrmaFile)
    expect(paired?.glb).toBe(glbFile)

    const single = entries.find((entry) => entry.name === 'Idle-standing-1')
    expect(single?.files).toEqual([solo])
    expect(single?.vrma).toBe(solo)
    expect(single?.glb).toBeNull()
  })

  it('does not pair files with different base names', () => {
    const entries = groupGoonMotionLibraryEntries([
      vrma(),
      glb({ originalName: 'dance-hip-hop-2.glb', filename: 'dance-hip-hop-2.glb' })
    ])
    expect(entries).toHaveLength(2)
  })

  it('picks the most recently edited side as the metadata winner', () => {
    const older = vrma({
      metaUpdatedAt: '2026-07-01T00:00:00.000Z',
      displayName: 'Old Name'
    })
    const newer = glb({
      metaUpdatedAt: '2026-07-06T00:00:00.000Z',
      displayName: 'New Name'
    })
    expect(resolveGoonMotionMetadataWinner([older, newer])).toBe(newer)
    expect(resolveGoonMotionMetadataWinner([newer, older])).toBe(newer)
  })

  it('prefers the side with authored metadata over a blank newer upload', () => {
    const authored = vrma({
      uploadedAt: '2026-07-01T00:00:00.000Z',
      tags: ['dance'],
      motionMeta: { posture: 'stand' }
    })
    const blankNewer = glb({ uploadedAt: '2026-07-06T00:00:00.000Z' })
    expect(resolveGoonMotionMetadataWinner([authored, blankNewer])).toBe(authored)
  })

  it('falls back to the newer upload, then the VRM lane, when nothing is authored', () => {
    const olderVrma = vrma({ uploadedAt: '2026-07-01T00:00:00.000Z' })
    const newerGlb = glb({ uploadedAt: '2026-07-06T00:00:00.000Z' })
    expect(resolveGoonMotionMetadataWinner([olderVrma, newerGlb])).toBe(newerGlb)

    const tieVrma = vrma({ uploadedAt: '2026-07-06T00:00:00.000Z' })
    const tieGlb = glb({ uploadedAt: '2026-07-06T00:00:00.000Z' })
    expect(resolveGoonMotionMetadataWinner([tieGlb, tieVrma])).toBe(tieVrma)
  })
})
