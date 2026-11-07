// @vitest-environment node
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { VRMHumanBoneName } from '@pixiv/three-vrm'
import { createVRMAnimationHumanoidTracks, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'

afterEach(() => vi.unstubAllGlobals())

describe('bundled conceal-painting VRMA poses', () => {
  it.each([
    ['brush-floating-pose.vrma', 52, true],
    ['brush-sitting-pose.vrma', 52, true],
    ['brush-t-pose.vrma', 6, false]
  ])('%s maps current thumb roles and retains every animated track', async (filename, rotationCount, animatedThumbs) => {
    const bytes = await readFile(path.resolve('static/goons/brush-poses', filename))
    const data = JSON.parse(bytes.toString('utf8'))
    const bones = data.extensions.VRMC_vrm_animation.humanoid.humanBones
    for (const side of ['left', 'right'] as const) {
      const prefix = side === 'left' ? 'Left' : 'Right'
      for (const [role, source] of [['Metacarpal', 1], ['Proximal', 2], ['Distal', 3]] as const) {
        const node = bones[`${side}Thumb${role}`]?.node
        expect(data.nodes[node]?.name).toBe(`mixamorig:${prefix}HandThumb${source}`)
      }
      expect(bones[`${side}ThumbIntermediate`]).toBeUndefined()
    }

    if (!globalThis.ProgressEvent) {
      vi.stubGlobal('ProgressEvent', class { constructor(public type: string, init: object) { Object.assign(this, init) } })
    }
    const loader = new GLTFLoader()
    loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
    const gltf = await loader.parseAsync(bytes.toString('utf8'), '')
    const animation = gltf.userData.vrmAnimations?.[0]
    expect(animation).toBeDefined()
    const currentRoles = new Set<string>(Object.values(VRMHumanBoneName))
    const humanoid = {
      normalizedRestPose: { hips: { position: [0, 1, 0] } },
      getNormalizedBoneNode: (role: string) => currentRoles.has(role) ? { name: `Normalized_${role}` } : null
    }
    const tracks = createVRMAnimationHumanoidTracks(animation, humanoid as any, '1')
    expect(tracks.rotation.size).toBe(rotationCount)
    expect([...tracks.translation.keys()]).toEqual(['hips'])
    for (const side of ['left', 'right']) {
      for (const role of ['Metacarpal', 'Proximal', 'Distal']) {
        expect(tracks.rotation.has(`${side}Thumb${role}`)).toBe(animatedThumbs)
      }
    }
  })
})
