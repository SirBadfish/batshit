// @vitest-environment node
import { spawn } from 'node:child_process'
import { once } from 'node:events'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js'
import { createVRMAnimationHumanoidTracks, VRMAnimationLoaderPlugin } from '@pixiv/three-vrm-animation'

// The external decoder is outside this test's boundary. Supply its synthetic
// glTF output to the actual native converter, including its file pipeline.
vi.mock('node:child_process', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:child_process')>()
  return {
    ...actual,
    execFile: (_binary: string, args: string[], callback: (error: Error | null) => void) => {
      import('node:fs/promises').then(({ copyFile }) => copyFile(args[1], `${args[3]}.gltf`))
        .then(() => callback(null), (error: Error) => callback(error))
    }
  }
})

import { convertFbxToVrmaFile } from './fbx2vrma'
import { convertToVrmaWithTiming as convertDockerGltf } from '../../../../../tools/docker/fbx2vrma-worker/worker.mjs'

const roots: string[] = []
const workerPath = fileURLToPath(new URL('../../../../../tools/docker/fbx2vrma-worker/worker.mjs', import.meta.url))

afterEach(async () => {
  vi.unstubAllGlobals()
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })))
})

type RigKind = 'mixamo' | 'smpl-upper' | 'smpl-lower'

function fixture(kind: RigKind) {
  const sideName = (side: 'left' | 'right', bone: string) => {
    if (kind === 'mixamo') return `mixamorig:${side === 'left' ? 'Left' : 'Right'}Hand${bone}`
    const prefix = side === 'left' ? 'L' : 'R'
    const name = `${prefix}_${bone}`
    return kind === 'smpl-lower' ? name.toLowerCase() : name
  }
  const hand = (side: 'left' | 'right') => kind === 'mixamo'
    ? `mixamorig:${side === 'left' ? 'Left' : 'Right'}Hand`
    : kind === 'smpl-lower' ? `${side === 'left' ? 'l' : 'r'}_wrist` : `${side === 'left' ? 'L' : 'R'}_Wrist`
  const hips = kind === 'mixamo' ? 'mixamorig:Hips' : kind === 'smpl-lower' ? 'pelvis' : 'Pelvis'
  const nodes = [
    { name: hips, translation: [0, 1, 0], children: [1, 6] },
    { name: hand('left'), children: [2, 11] },
    { name: sideName('left', 'Thumb1'), children: [3] },
    { name: sideName('left', 'Thumb2'), children: [4] },
    { name: sideName('left', 'Thumb3'), children: [5] },
    { name: sideName('left', 'Thumb4') },
    { name: hand('right'), children: [7, 12] },
    { name: sideName('right', 'Thumb1'), children: [8] },
    { name: sideName('right', 'Thumb2'), children: [9] },
    { name: sideName('right', 'Thumb3'), children: [10] },
    { name: sideName('right', 'Thumb4') },
    { name: sideName('left', 'Index1') },
    { name: sideName('right', 'Index1') }
  ]
  const values = [0, 1, 0, 0, 0, 1, 0.2, 0, 0, Math.sqrt(0.96), 0, 1, 0, 0.1, 1, 0]
  const binary = Buffer.alloc(values.length * 4)
  values.forEach((value, index) => binary.writeFloatLE(value, index * 4))
  return {
    asset: { version: '2.0' }, scene: 0, scenes: [{ nodes: [0] }], nodes,
    animations: [{
      name: 'synthetic-thumb-motion',
      channels: [
        ...[2, 3, 4, 7, 8, 9].map((node) => ({ sampler: 0, target: { node, path: 'rotation' } })),
        { sampler: 1, target: { node: 0, path: 'translation' } }
      ],
      samplers: [{ input: 0, output: 1 }, { input: 0, output: 2 }]
    }],
    buffers: [{ byteLength: binary.length, uri: `data:application/octet-stream;base64,${binary.toString('base64')}` }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: 8 },
      { buffer: 0, byteOffset: 8, byteLength: 32 },
      { buffer: 0, byteOffset: 40, byteLength: 24 }
    ],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 2, type: 'SCALAR', min: [0], max: [1] },
      { bufferView: 1, componentType: 5126, count: 2, type: 'VEC4' },
      { bufferView: 2, componentType: 5126, count: 2, type: 'VEC3' }
    ]
  }
}

async function nativeOutput(input: ReturnType<typeof fixture>) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-vrma-map-'))
  roots.push(root)
  const source = path.join(root, 'input.fbx'), output = path.join(root, 'output.vrma')
  await writeFile(source, JSON.stringify(input))
  await convertFbxToVrmaFile({ inputPath: source, outputPath: output, fbx2gltfPath: 'mock-fbx2gltf' })
  return JSON.parse(await readFile(output, 'utf8'))
}

async function verifyInstalledParser(output: any) {
  if (!globalThis.ProgressEvent) {
    vi.stubGlobal('ProgressEvent', class { constructor(public type: string, init: object) { Object.assign(this, init) } })
  }
  const loader = new GLTFLoader()
  loader.register((parser) => new VRMAnimationLoaderPlugin(parser))
  const loaded = await loader.parseAsync(JSON.stringify(output), '')
  const animation = loaded.userData.vrmAnimations?.[0]
  expect(animation).toBeDefined()
  const roles = [
    'leftThumbMetacarpal', 'leftThumbProximal', 'leftThumbDistal',
    'rightThumbMetacarpal', 'rightThumbProximal', 'rightThumbDistal'
  ]
  const humanoid = {
    normalizedRestPose: { hips: { position: [0, 1, 0] } },
    getNormalizedBoneNode: (role: string) => role === 'hips' || roles.includes(role) ? { name: `Normalized_${role}` } : null
  }
  const tracks = createVRMAnimationHumanoidTracks(animation, humanoid as any, '1')
  expect([...tracks.rotation.keys()].sort()).toEqual([...roles].sort())
  expect([...tracks.translation.keys()]).toEqual(['hips'])
  vi.unstubAllGlobals()
}

describe('FBX-to-VRMA current humanoid roles', () => {
  it.each<RigKind>(['mixamo', 'smpl-upper', 'smpl-lower'])(
    'keeps the three animated %s thumb joints on each hand in native and Docker output',
    async (kind) => {
      const input = fixture(kind)
      const native = await nativeOutput(input)
      const docker = convertDockerGltf(structuredClone(input))
      const expected = {
        hips: { node: 0 }, leftHand: { node: 1 }, rightHand: { node: 6 },
        leftThumbMetacarpal: { node: 2 }, leftThumbProximal: { node: 3 }, leftThumbDistal: { node: 4 },
        rightThumbMetacarpal: { node: 7 }, rightThumbProximal: { node: 8 }, rightThumbDistal: { node: 9 },
        leftIndexProximal: { node: 11 }, rightIndexProximal: { node: 12 }
      }
      for (const output of [native, docker]) {
        expect(output.extensions.VRMC_vrm_animation.humanoid.humanBones).toEqual(expected)
        expect(output.nodes).toEqual(input.nodes)
        expect(output.animations[0].channels).toEqual(input.animations[0].channels)
        expect(output.animations[0].samplers).toEqual(input.animations[0].samplers)
        expect(output.accessors).toEqual(input.accessors)
        expect(output.bufferViews).toEqual(input.bufferViews)
        expect(output.buffers).toEqual(input.buffers)
        await verifyInstalledParser(output)
      }
    }
  )

  it('still starts the Docker worker when executed directly', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'batshit-vrma-worker-'))
    roots.push(root)
    const child = spawn(process.execPath, [workerPath], {
      env: { PATH: process.env.PATH ?? '', BATSHIT_FBX2VRMA_HOST: '127.0.0.1', BATSHIT_FBX2VRMA_PORT: '0', BATSHIT_FBX2VRMA_WORK_DIR: root },
      stdio: ['ignore', 'pipe', 'pipe']
    })
    try {
      await new Promise<void>((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('Worker did not start')), 5000)
        child.once('error', (error) => { clearTimeout(timeout); reject(error) })
        child.once('exit', (code) => { clearTimeout(timeout); reject(new Error(`Worker exited early: ${code}`)) })
        child.stdout.on('data', (chunk) => {
          if (String(chunk).includes('listening on 127.0.0.1:0')) { clearTimeout(timeout); resolve() }
        })
      })
    } finally {
      if (child.exitCode === null && child.signalCode === null) {
        const closed = once(child, 'close')
        child.kill('SIGTERM')
        await closed
      }
    }
  })
})
