import path from 'node:path'
import fs from 'node:fs/promises'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

type ErrnoError = NodeJS.ErrnoException

const HUMANOID_BONE_MAPPING: Record<string, string> = {
  // Mixamo (default)
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
  // SMPL/SMPLH-style rigs (ex: Tencent Hunyuan/HT-Motion)
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

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await fs.readFile(filePath, 'utf-8')
  return JSON.parse(raw) as T
}

async function writeJson(filePath: string, data: unknown) {
  await fs.writeFile(filePath, JSON.stringify(data, null, 2))
}

async function moveFile(source: string, destination: string) {
  try {
    await fs.rename(source, destination)
  } catch (error) {
    const err = error as ErrnoError
    if (err?.code !== 'EXDEV') {
      throw error
    }
    await fs.copyFile(source, destination)
    await fs.unlink(source)
  }
}

async function movePath(source: string, destination: string) {
  await fs.mkdir(path.dirname(destination), { recursive: true })
  await fs.cp(source, destination, { recursive: true, force: true })
  await fs.rm(source, { recursive: true, force: true })
}

async function removePath(targetPath: string) {
  await fs.rm(targetPath, { recursive: true, force: true })
}

export type FbxToVrmaOptions = {
  inputPath: string
  outputPath: string
  fbx2gltfPath: string
  framerate?: number
}

export async function convertFbxToVrmaFile({
  inputPath,
  outputPath,
  fbx2gltfPath,
  framerate = 30
}: FbxToVrmaOptions) {
  const converter = new FbxToVrmaConverter()
  await converter.convert(inputPath, outputPath, fbx2gltfPath, framerate)
}

class FbxToVrmaConverter {
  async convert(inputPath: string, outputPath: string, fbx2gltfPath: string, framerate: number) {
    const tempGltfPath = path.join(path.dirname(outputPath), 'temp.gltf')

    try {
      await this.convertFbxToGltf(inputPath, tempGltfPath, fbx2gltfPath)

      const gltfData = await readJson<Record<string, any>>(tempGltfPath)
      const enhancedGltfData = this.enhanceAnimationTiming(gltfData, framerate)
      const embeddedGltfData = await this.embedBinaryData(
        enhancedGltfData,
        path.dirname(tempGltfPath)
      )
      const fullyEmbeddedGltfData = await this.embedImageData(
        embeddedGltfData,
        path.dirname(tempGltfPath)
      )
      const vrmaData = this.convertToVrmaWithTiming(fullyEmbeddedGltfData)

      await writeJson(outputPath, vrmaData)
      await this.cleanupTempFiles([tempGltfPath])
    } catch (error) {
      await this.cleanupTempFiles([tempGltfPath]).catch(() => {})
      throw error
    }
  }

  private async convertFbxToGltf(inputPath: string, outputPath: string, fbx2gltfPath: string) {
    try {
      await this.convertFbxToGltfEmbedded(inputPath, outputPath, fbx2gltfPath)
    } catch {
      await this.convertFbxToGltfNormal(inputPath, outputPath, fbx2gltfPath)
    }
  }

  private async convertFbxToGltfEmbedded(
    inputPath: string,
    outputPath: string,
    fbx2gltfPath: string
  ) {
    const outputDir = path.dirname(outputPath)
    const outputName = path.basename(outputPath, '.gltf')

    await execFileAsync(fbx2gltfPath, [
      '-i',
      inputPath,
      '-o',
      path.join(outputDir, outputName),
      '--embed'
    ])

    const outputFolder = path.join(outputDir, `${outputName}_out`)
    const actualOutputPath = path.join(outputFolder, `${outputName}.gltf`)
    if (await pathExists(actualOutputPath)) {
      await moveFile(actualOutputPath, outputPath)
      await this.moveSidecarFiles(outputFolder, outputDir, outputName)
    }
  }

  private async convertFbxToGltfNormal(
    inputPath: string,
    outputPath: string,
    fbx2gltfPath: string
  ) {
    const outputDir = path.dirname(outputPath)
    const outputName = path.basename(outputPath, '.gltf')

    await execFileAsync(fbx2gltfPath, ['-i', inputPath, '-o', path.join(outputDir, outputName)])

    const outputFolder = path.join(outputDir, `${outputName}_out`)
    const actualOutputPath = path.join(outputFolder, `${outputName}.gltf`)
    if (await pathExists(actualOutputPath)) {
      await moveFile(actualOutputPath, outputPath)
      await this.moveSidecarFiles(outputFolder, outputDir, outputName)
    }
  }

  private enhanceAnimationTiming(gltfData: Record<string, any>, framerate: number) {
    if (!gltfData.animations || gltfData.animations.length === 0) {
      return gltfData
    }

    let maxDuration = 0
    for (const animation of gltfData.animations ?? []) {
      if (!animation.samplers || !gltfData.accessors) continue
      for (const sampler of animation.samplers) {
        if (sampler.input === undefined) continue
        const timeAccessor = gltfData.accessors[sampler.input]
        if (!timeAccessor) continue
        if (timeAccessor.type === 'SCALAR' && Array.isArray(timeAccessor.max)) {
          const endTime = timeAccessor.max[0]
          if (typeof endTime === 'number' && endTime > maxDuration) {
            maxDuration = endTime
          }
        }
      }
    }

    if (!gltfData.extras) {
      gltfData.extras = {}
    }

    gltfData.extras.animationMetadata = {
      maxDuration,
      framerate,
      frameCount: Math.ceil(maxDuration * framerate),
      calculatedAt: new Date().toISOString()
    }

    return gltfData
  }

  private async embedBinaryData(gltfData: Record<string, any>, gltfDir: string) {
    if (!gltfData.buffers || gltfData.buffers.length === 0) {
      return gltfData
    }

    for (let i = 0; i < gltfData.buffers.length; i += 1) {
      const buffer = gltfData.buffers[i]
      if (!buffer?.uri || buffer.uri.startsWith('data:')) continue
      const bufferPath = path.join(gltfDir, buffer.uri)
      if (!(await pathExists(bufferPath))) continue

      const bufferData = await fs.readFile(bufferPath)
      const base64Data = bufferData.toString('base64')
      gltfData.buffers[i].uri = `data:application/octet-stream;base64,${base64Data}`
    }

    return gltfData
  }

  private async embedImageData(gltfData: Record<string, any>, gltfDir: string) {
    if (!gltfData.images || gltfData.images.length === 0) {
      return gltfData
    }

    for (let i = 0; i < gltfData.images.length; i += 1) {
      const image = gltfData.images[i]
      if (!image?.uri || image.uri.startsWith('data:')) continue
      const uri = image.uri
      if (/^https?:/i.test(uri)) continue
      const imagePath = path.join(gltfDir, uri)
      if (!(await pathExists(imagePath))) continue

      const imageData = await fs.readFile(imagePath)
      const ext = path.extname(uri).toLowerCase()
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
      gltfData.images[i].uri = `data:${mimeType};base64,${imageData.toString('base64')}`
    }

    return gltfData
  }

  private async moveSidecarFiles(sourceDir: string, targetDir: string, outputName: string) {
    if (!(await pathExists(sourceDir))) return
    const entries = await fs.readdir(sourceDir, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry?.name) continue
      if (entry.name === `${outputName}.gltf`) continue
      const sourcePath = path.join(sourceDir, entry.name)
      const targetPath = path.join(targetDir, entry.name)
      await movePath(sourcePath, targetPath)
    }
    await removePath(sourceDir)
  }

  private convertToVrmaWithTiming(gltfData: Record<string, any>) {
    let animationDuration = 5.0
    if (gltfData.extras?.animationMetadata?.maxDuration) {
      animationDuration = gltfData.extras.animationMetadata.maxDuration
    }

    const vrmaData: Record<string, any> = {
      asset: gltfData.asset,
      scene: gltfData.scene,
      scenes: gltfData.scenes,
      nodes: gltfData.nodes,
      animations: this.processAnimationsWithTiming(gltfData.animations, animationDuration),
      accessors: gltfData.accessors,
      bufferViews: gltfData.bufferViews,
      buffers: gltfData.buffers,
      samplers: gltfData.samplers,
      extensionsUsed: ['VRMC_vrm_animation'],
      extensions: {
        VRMC_vrm_animation: {
          specVersion: '1.0',
          humanoid: {
            humanBones: this.generateHumanBones(gltfData)
          },
          meta: {
            duration: animationDuration,
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

  private processAnimationsWithTiming(animations: any[], duration: number) {
    if (!animations || animations.length === 0) {
      return []
    }

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

  private generateHumanBones(gltfData: Record<string, any>) {
    const humanBones: Record<string, { node: number }> = {}
    if (!gltfData.nodes) return humanBones

    gltfData.nodes.forEach((node: { name?: string }, index: number) => {
      if (!node?.name) return
      const vrmBoneName = HUMANOID_BONE_MAPPING[node.name]
      if (!vrmBoneName) return
      humanBones[vrmBoneName] = { node: index }
    })

    return humanBones
  }

  private async cleanupTempFiles(filePaths: string[]) {
    for (const filePath of filePaths) {
      if (await pathExists(filePath)) {
        await removePath(filePath)
      }
      const binPath = filePath.replace(/\.gltf$/, '.bin')
      if (await pathExists(binPath)) {
        await removePath(binPath)
      }
    }
  }
}
