import { execFile } from 'node:child_process'
import crypto from 'node:crypto'
import fs from 'node:fs/promises'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

const HOST = process.env.BATSHIT_FBX2VRMA_HOST || '0.0.0.0'
const PORT = Number(process.env.BATSHIT_FBX2VRMA_PORT || 8079)
const FBX2GLTF_PATH = process.env.BATSHIT_FBX2GLTF_PATH || '/usr/local/bin/FBX2glTF'
const FBX2GLTF_VERSION = process.env.BATSHIT_FBX2GLTF_VERSION || 'v0.9.7'
const WORK_DIR = process.env.BATSHIT_FBX2VRMA_WORK_DIR || path.join(os.tmpdir(), 'batshit-fbx2vrma')
const MAX_BYTES = Number(process.env.BATSHIT_FBX2VRMA_MAX_BYTES || 524288000)
const CONVERT_TIMEOUT_MS = Number(process.env.BATSHIT_FBX2VRMA_CONVERT_TIMEOUT_MS || 120000)
const CHECKSUM_NOTE =
  'Upstream FBX2glTF releases do not publish official checksums. This Docker worker verifies the pinned Linux asset against Batshit recorded SHA256 during image build.'

const HUMANOID_BONE_MAPPING = {
  'mixamorig:Hips': 'hips',
  'mixamorig:Spine': 'spine',
  'mixamorig:Spine1': 'chest',
  'mixamorig:Spine2': 'upperChest',
  'mixamorig:Neck': 'neck',
  'mixamorig:Head': 'head',
  'mixamorig:LeftShoulder': 'leftShoulder',
  'mixamorig:LeftArm': 'leftUpperArm',
  'mixamorig:LeftForeArm': 'leftLowerArm',
  'mixamorig:LeftHand': 'leftHand',
  'mixamorig:LeftHandThumb2': 'leftThumbProximal',
  'mixamorig:LeftHandThumb3': 'leftThumbIntermediate',
  'mixamorig:LeftHandThumb4': 'leftThumbDistal',
  'mixamorig:LeftHandIndex1': 'leftIndexProximal',
  'mixamorig:LeftHandIndex2': 'leftIndexIntermediate',
  'mixamorig:LeftHandIndex3': 'leftIndexDistal',
  'mixamorig:LeftHandMiddle1': 'leftMiddleProximal',
  'mixamorig:LeftHandMiddle2': 'leftMiddleIntermediate',
  'mixamorig:LeftHandMiddle3': 'leftMiddleDistal',
  'mixamorig:LeftHandRing1': 'leftRingProximal',
  'mixamorig:LeftHandRing2': 'leftRingIntermediate',
  'mixamorig:LeftHandRing3': 'leftRingDistal',
  'mixamorig:LeftHandPinky1': 'leftLittleProximal',
  'mixamorig:LeftHandPinky2': 'leftLittleIntermediate',
  'mixamorig:LeftHandPinky3': 'leftLittleDistal',
  'mixamorig:RightShoulder': 'rightShoulder',
  'mixamorig:RightArm': 'rightUpperArm',
  'mixamorig:RightForeArm': 'rightLowerArm',
  'mixamorig:RightHand': 'rightHand',
  'mixamorig:RightHandThumb2': 'rightThumbProximal',
  'mixamorig:RightHandThumb3': 'rightThumbIntermediate',
  'mixamorig:RightHandThumb4': 'rightThumbDistal',
  'mixamorig:RightHandIndex1': 'rightIndexProximal',
  'mixamorig:RightHandIndex2': 'rightIndexIntermediate',
  'mixamorig:RightHandIndex3': 'rightIndexDistal',
  'mixamorig:RightHandMiddle1': 'rightMiddleProximal',
  'mixamorig:RightHandMiddle2': 'rightMiddleIntermediate',
  'mixamorig:RightHandMiddle3': 'rightMiddleDistal',
  'mixamorig:RightHandRing1': 'rightRingProximal',
  'mixamorig:RightHandRing2': 'rightRingIntermediate',
  'mixamorig:RightHandRing3': 'rightRingDistal',
  'mixamorig:RightHandPinky1': 'rightLittleProximal',
  'mixamorig:RightHandPinky2': 'rightLittleIntermediate',
  'mixamorig:RightHandPinky3': 'rightLittleDistal',
  'mixamorig:LeftUpLeg': 'leftUpperLeg',
  'mixamorig:LeftLeg': 'leftLowerLeg',
  'mixamorig:LeftFoot': 'leftFoot',
  'mixamorig:RightUpLeg': 'rightUpperLeg',
  'mixamorig:RightLeg': 'rightLowerLeg',
  'mixamorig:RightFoot': 'rightFoot',
  'mixamorig:LeftToeBase': 'leftToes',
  'mixamorig:RightToeBase': 'rightToes',
  Pelvis: 'hips',
  pelvis: 'hips',
  Spine1: 'spine',
  spine1: 'spine',
  Spine2: 'chest',
  spine2: 'chest',
  Spine3: 'upperChest',
  spine3: 'upperChest',
  Neck: 'neck',
  neck: 'neck',
  Head: 'head',
  head: 'head',
  L_Collar: 'leftShoulder',
  l_collar: 'leftShoulder',
  L_Shoulder: 'leftUpperArm',
  l_shoulder: 'leftUpperArm',
  L_Elbow: 'leftLowerArm',
  l_elbow: 'leftLowerArm',
  L_Wrist: 'leftHand',
  l_wrist: 'leftHand',
  L_Thumb1: 'leftThumbProximal',
  l_thumb1: 'leftThumbProximal',
  L_Thumb2: 'leftThumbIntermediate',
  l_thumb2: 'leftThumbIntermediate',
  L_Thumb3: 'leftThumbDistal',
  l_thumb3: 'leftThumbDistal',
  L_Index1: 'leftIndexProximal',
  l_index1: 'leftIndexProximal',
  L_Index2: 'leftIndexIntermediate',
  l_index2: 'leftIndexIntermediate',
  L_Index3: 'leftIndexDistal',
  l_index3: 'leftIndexDistal',
  L_Middle1: 'leftMiddleProximal',
  l_middle1: 'leftMiddleProximal',
  L_Middle2: 'leftMiddleIntermediate',
  l_middle2: 'leftMiddleIntermediate',
  L_Middle3: 'leftMiddleDistal',
  l_middle3: 'leftMiddleDistal',
  L_Ring1: 'leftRingProximal',
  l_ring1: 'leftRingProximal',
  L_Ring2: 'leftRingIntermediate',
  l_ring2: 'leftRingIntermediate',
  L_Ring3: 'leftRingDistal',
  l_ring3: 'leftRingDistal',
  L_Pinky1: 'leftLittleProximal',
  l_pinky1: 'leftLittleProximal',
  L_Pinky2: 'leftLittleIntermediate',
  l_pinky2: 'leftLittleIntermediate',
  L_Pinky3: 'leftLittleDistal',
  l_pinky3: 'leftLittleDistal',
  R_Collar: 'rightShoulder',
  r_collar: 'rightShoulder',
  R_Shoulder: 'rightUpperArm',
  r_shoulder: 'rightUpperArm',
  R_Elbow: 'rightLowerArm',
  r_elbow: 'rightLowerArm',
  R_Wrist: 'rightHand',
  r_wrist: 'rightHand',
  R_Thumb1: 'rightThumbProximal',
  r_thumb1: 'rightThumbProximal',
  R_Thumb2: 'rightThumbIntermediate',
  r_thumb2: 'rightThumbIntermediate',
  R_Thumb3: 'rightThumbDistal',
  r_thumb3: 'rightThumbDistal',
  R_Index1: 'rightIndexProximal',
  r_index1: 'rightIndexProximal',
  R_Index2: 'rightIndexIntermediate',
  r_index2: 'rightIndexIntermediate',
  R_Index3: 'rightIndexDistal',
  r_index3: 'rightIndexDistal',
  R_Middle1: 'rightMiddleProximal',
  r_middle1: 'rightMiddleProximal',
  R_Middle2: 'rightMiddleIntermediate',
  r_middle2: 'rightMiddleIntermediate',
  R_Middle3: 'rightMiddleDistal',
  r_middle3: 'rightMiddleDistal',
  R_Ring1: 'rightRingProximal',
  r_ring1: 'rightRingProximal',
  R_Ring2: 'rightRingIntermediate',
  r_ring2: 'rightRingIntermediate',
  R_Ring3: 'rightRingDistal',
  r_ring3: 'rightRingDistal',
  R_Pinky1: 'rightLittleProximal',
  r_pinky1: 'rightLittleProximal',
  R_Pinky2: 'rightLittleIntermediate',
  r_pinky2: 'rightLittleIntermediate',
  R_Pinky3: 'rightLittleDistal',
  r_pinky3: 'rightLittleDistal',
  L_Hip: 'leftUpperLeg',
  l_hip: 'leftUpperLeg',
  L_Knee: 'leftLowerLeg',
  l_knee: 'leftLowerLeg',
  L_Ankle: 'leftFoot',
  l_ankle: 'leftFoot',
  L_Foot: 'leftToes',
  l_foot: 'leftToes',
  R_Hip: 'rightUpperLeg',
  r_hip: 'rightUpperLeg',
  R_Knee: 'rightLowerLeg',
  r_knee: 'rightLowerLeg',
  R_Ankle: 'rightFoot',
  r_ankle: 'rightFoot',
  R_Foot: 'rightToes',
  r_foot: 'rightToes'
}

async function pathExists(targetPath) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(body)
  })
  res.end(body)
}

function sendError(res, status, error) {
  console.error('[fbx2vrma-worker] request failed:', error instanceof Error ? error.message : 'Unknown error')
  sendJson(res, status, {
    ok: false,
    error: status >= 500 ? 'FBX-to-VRMA worker request failed.' : 'Invalid FBX-to-VRMA worker request.'
  })
}

async function readBody(req) {
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    total += chunk.length
    if (total > MAX_BYTES) {
      throw new Error(`FBX file is too large for this worker limit (${MAX_BYTES} bytes).`)
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

function cleanFilename(value) {
  const fallback = `animation-${crypto.randomUUID()}.fbx`
  const base = path.basename(String(value || fallback)).slice(0, 180)
  const cleaned = base.replace(/[^a-zA-Z0-9._ -]/g, '_').trim()
  return cleaned || fallback
}

function outputNameFor(inputName) {
  const base = path.basename(inputName, path.extname(inputName)).trim() || 'animation'
  return `${base}.vrma`
}

async function moveFile(source, destination) {
  try {
    await fs.rename(source, destination)
  } catch (error) {
    if (error?.code !== 'EXDEV') throw error
    await fs.copyFile(source, destination)
    await fs.unlink(source)
  }
}

async function movePath(source, destination) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true })
  await fs.rm(source, { recursive: true, force: true })
}

async function moveSidecarFiles(sourceDir, targetDir, outputName) {
  if (!(await pathExists(sourceDir))) return
  const entries = await fs.readdir(sourceDir, { withFileTypes: true })
  for (const entry of entries) {
    if (!entry?.name || entry.name === `${outputName}.gltf`) continue
    await movePath(path.join(sourceDir, entry.name), path.join(targetDir, entry.name))
  }
  await fs.rm(sourceDir, { recursive: true, force: true })
}

async function runFbx2Gltf(inputPath, outputPath, embed) {
  const outputDir = path.dirname(outputPath)
  const outputName = path.basename(outputPath, '.gltf')
  const args = ['-i', inputPath, '-o', path.join(outputDir, outputName)]
  if (embed) args.push('--embed')

  await execFileAsync(FBX2GLTF_PATH, args, {
    timeout: CONVERT_TIMEOUT_MS,
    maxBuffer: 10 * 1024 * 1024
  })

  const outputFolder = path.join(outputDir, `${outputName}_out`)
  const nestedOutputPath = path.join(outputFolder, `${outputName}.gltf`)
  if (await pathExists(nestedOutputPath)) {
    await moveFile(nestedOutputPath, outputPath)
    await moveSidecarFiles(outputFolder, outputDir, outputName)
  }

  if (!(await pathExists(outputPath))) {
    throw new Error('FBX2glTF did not produce a GLTF file.')
  }
}

async function convertFbxToGltf(inputPath, outputPath) {
  try {
    await runFbx2Gltf(inputPath, outputPath, true)
  } catch {
    await runFbx2Gltf(inputPath, outputPath, false)
  }
}

async function embedBinaryData(gltfData, gltfDir) {
  if (!Array.isArray(gltfData.buffers)) return gltfData
  for (const buffer of gltfData.buffers) {
    if (!buffer?.uri || buffer.uri.startsWith('data:')) continue
    const bufferPath = path.join(gltfDir, buffer.uri)
    if (!(await pathExists(bufferPath))) continue
    const bufferData = await fs.readFile(bufferPath)
    buffer.uri = `data:application/octet-stream;base64,${bufferData.toString('base64')}`
  }
  return gltfData
}

async function embedImageData(gltfData, gltfDir) {
  if (!Array.isArray(gltfData.images)) return gltfData
  for (const image of gltfData.images) {
    if (!image?.uri || image.uri.startsWith('data:') || /^https?:/i.test(image.uri)) continue
    const imagePath = path.join(gltfDir, image.uri)
    if (!(await pathExists(imagePath))) continue
    const imageData = await fs.readFile(imagePath)
    const ext = path.extname(image.uri).toLowerCase()
    const mimeType =
      ext === '.png'
        ? 'image/png'
        : ext === '.jpg' || ext === '.jpeg'
          ? 'image/jpeg'
          : ext === '.webp'
            ? 'image/webp'
            : ext === '.gif'
              ? 'image/gif'
              : 'application/octet-stream'
    image.uri = `data:${mimeType};base64,${imageData.toString('base64')}`
  }
  return gltfData
}

function enhanceAnimationTiming(gltfData, framerate) {
  if (!Array.isArray(gltfData.animations) || gltfData.animations.length === 0) return gltfData

  let maxDuration = 0
  for (const animation of gltfData.animations) {
    if (!Array.isArray(animation.samplers) || !Array.isArray(gltfData.accessors)) continue
    for (const sampler of animation.samplers) {
      if (sampler.input === undefined) continue
      const timeAccessor = gltfData.accessors[sampler.input]
      if (timeAccessor?.type !== 'SCALAR' || !Array.isArray(timeAccessor.max)) continue
      const endTime = timeAccessor.max[0]
      if (typeof endTime === 'number' && endTime > maxDuration) maxDuration = endTime
    }
  }

  gltfData.extras = {
    ...(gltfData.extras || {}),
    animationMetadata: {
      maxDuration,
      framerate,
      frameCount: Math.ceil(maxDuration * framerate),
      calculatedAt: new Date().toISOString()
    }
  }
  return gltfData
}

function generateHumanBones(gltfData) {
  const humanBones = {}
  if (!Array.isArray(gltfData.nodes)) return humanBones
  gltfData.nodes.forEach((node, index) => {
    if (!node?.name) return
    const vrmBoneName = HUMANOID_BONE_MAPPING[node.name]
    if (vrmBoneName) humanBones[vrmBoneName] = { node: index }
  })
  return humanBones
}

function processAnimationsWithTiming(animations, duration) {
  if (!Array.isArray(animations) || animations.length === 0) return []
  return animations.map((animation, index) => ({
    name: animation.name || `VRMAnimation${index}`,
    channels: animation.channels,
    samplers: animation.samplers,
    extras: {
      duration,
      vrmAnimationMetadata: {
        calculatedDuration: duration,
        originalName: animation.name
      }
    }
  }))
}

function convertToVrmaWithTiming(gltfData) {
  const duration = gltfData.extras?.animationMetadata?.maxDuration || 5.0
  const vrmaData = {
    asset: gltfData.asset,
    scene: gltfData.scene,
    scenes: gltfData.scenes,
    nodes: gltfData.nodes,
    animations: processAnimationsWithTiming(gltfData.animations, duration),
    accessors: gltfData.accessors,
    bufferViews: gltfData.bufferViews,
    buffers: gltfData.buffers,
    samplers: gltfData.samplers,
    extensionsUsed: ['VRMC_vrm_animation'],
    extensions: {
      VRMC_vrm_animation: {
        specVersion: '1.0',
        humanoid: {
          humanBones: generateHumanBones(gltfData)
        },
        meta: {
          duration,
          frameCount: gltfData.extras?.animationMetadata?.frameCount ?? 0,
          framerate: gltfData.extras?.animationMetadata?.framerate ?? 30
        }
      }
    }
  }

  if (gltfData.materials) vrmaData.materials = gltfData.materials
  if (gltfData.meshes) vrmaData.meshes = gltfData.meshes
  if (gltfData.skins) vrmaData.skins = gltfData.skins
  if (gltfData.textures) vrmaData.textures = gltfData.textures
  if (gltfData.images) vrmaData.images = gltfData.images

  return vrmaData
}

async function convertBufferToVrma(inputBuffer, inputName, framerate) {
  const tempRoot = await fs.mkdtemp(path.join(WORK_DIR, 'job-'))
  const inputPath = path.join(tempRoot, cleanFilename(inputName))
  const tempGltfPath = path.join(tempRoot, 'temp.gltf')
  const outputName = outputNameFor(inputName)
  const outputPath = path.join(tempRoot, outputName)

  try {
    await fs.writeFile(inputPath, inputBuffer)
    await convertFbxToGltf(inputPath, tempGltfPath)
    const gltfData = JSON.parse(await fs.readFile(tempGltfPath, 'utf-8'))
    const timed = enhanceAnimationTiming(gltfData, framerate)
    const embeddedBuffers = await embedBinaryData(timed, path.dirname(tempGltfPath))
    const embedded = await embedImageData(embeddedBuffers, path.dirname(tempGltfPath))
    const vrmaData = convertToVrmaWithTiming(embedded)
    await fs.writeFile(outputPath, JSON.stringify(vrmaData, null, 2))
    return { outputName, buffer: await fs.readFile(outputPath) }
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function healthPayload() {
  await fs.access(FBX2GLTF_PATH)
  await fs.mkdir(WORK_DIR, { recursive: true })
  const versionResult = await execFileAsync(FBX2GLTF_PATH, ['--version'], {
    timeout: 5000,
    maxBuffer: 1024 * 1024
  })
  const versionText = `${versionResult.stdout || ''}${versionResult.stderr || ''}`.trim()

  return {
    ok: true,
    status: 'ready',
    mode: 'docker-worker',
    service: 'fbx2vrma-worker',
    version: FBX2GLTF_VERSION,
    fbx2gltfVersion: FBX2GLTF_VERSION,
    fbx2gltfVersionOutput: versionText,
    fbx2gltfPath: FBX2GLTF_PATH,
    checksumNote: CHECKSUM_NOTE,
    maxBytes: MAX_BYTES,
    workDir: WORK_DIR
  }
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)

    if (req.method === 'GET' && url.pathname === '/health') {
      sendJson(res, 200, await healthPayload())
      return
    }

    if (req.method === 'POST' && url.pathname === '/convert') {
      const inputName = cleanFilename(req.headers['x-batshit-filename'])
      const framerateHeader = Number(req.headers['x-batshit-framerate'] || 30)
      const framerate = Number.isFinite(framerateHeader) && framerateHeader > 0 ? framerateHeader : 30
      const inputBuffer = await readBody(req)

      if (!inputBuffer.length) {
        sendError(res, 400, 'No FBX bytes were provided.')
        return
      }

      const { outputName, buffer } = await convertBufferToVrma(inputBuffer, inputName, framerate)
      res.writeHead(200, {
        'content-type': 'application/octet-stream',
        'content-length': buffer.length,
        'x-batshit-output-filename': outputName
      })
      res.end(buffer)
      return
    }

    sendJson(res, 404, { ok: false, error: 'Not found' })
  } catch (error) {
    sendError(res, 500, error)
  }
})

await fs.mkdir(WORK_DIR, { recursive: true })

server.listen(PORT, HOST, () => {
  console.log(`[fbx2vrma-worker] listening on ${HOST}:${PORT}`)
})
