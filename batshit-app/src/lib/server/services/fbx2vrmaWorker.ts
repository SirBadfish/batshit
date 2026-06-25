import { bytesToFile } from '$lib/utils/binary'
import {
  FBX2GLTF_CHECKSUM_NOTE,
  FBX2GLTF_VERSION,
  resolveFbxDownloadUrl
} from '$lib/server/converters/fbx2vrmaInstaller'

const DEFAULT_DOCKER_WORKER_URL = 'http://fbx2vrma-worker:8079'
const DEFAULT_TIMEOUT_MS = 3000
const DEFAULT_CONVERT_TIMEOUT_MS = 120000

export const DOCKER_FBX2VRMA_WORKER_INSTALL_HELP =
  'Start the optional Docker worker with: docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker'

export const DOCKER_FBX2VRMA_WORKER_MISSING_REASON =
  'FBX-to-VRMA conversion in Docker needs the optional fbx2vrma-worker sidecar. The core app container does not download native converter binaries into itself.'

export type Fbx2VrmaWorkerHealth = {
  ok?: boolean
  status?: string
  mode?: 'docker-worker'
  service?: string
  version?: string
  fbx2gltfVersion?: string
  fbx2gltfPath?: string
  checksumNote?: string
  maxBytes?: number
  workDir?: string
}

export type Fbx2VrmaWorkerStatus = {
  running: boolean
  url: string
  checkedAt: string
  health: Fbx2VrmaWorkerHealth | null
  error: string | null
}

export type Fbx2VrmaDockerConversionResult = {
  file: File
  size: number
  worker: Fbx2VrmaWorkerStatus
}

export function isBatshitContainerizedRuntime() {
  return (
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

export function resolveFbx2VrmaDockerWorkerUrl() {
  const configured = process.env.BATSHIT_FBX2VRMA_WORKER_URL?.trim()
  return configured || DEFAULT_DOCKER_WORKER_URL
}

function resolveConvertTimeoutMs() {
  const raw = Number(process.env.BATSHIT_FBX2VRMA_CONVERT_TIMEOUT_MS)
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_CONVERT_TIMEOUT_MS
}

async function fetchWithTimeout(url: string, init: RequestInit = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), timeoutMs)

  try {
    return await fetch(url, {
      ...init,
      signal: controller.signal
    })
  } finally {
    clearTimeout(timeout)
  }
}

function errorMessage(error: unknown) {
  return error instanceof Error ? error.message : String(error)
}

export async function getFbx2VrmaDockerWorkerStatus(
  timeoutMs = DEFAULT_TIMEOUT_MS
): Promise<Fbx2VrmaWorkerStatus> {
  const url = resolveFbx2VrmaDockerWorkerUrl()
  const checkedAt = new Date().toISOString()

  try {
    const response = await fetchWithTimeout(`${url.replace(/\/+$/, '')}/health`, {}, timeoutMs)
    const health = (await response.json().catch(() => null)) as Fbx2VrmaWorkerHealth | null

    return {
      running: response.ok && health?.ok === true,
      url,
      checkedAt,
      health,
      error: response.ok ? null : health?.status || `Worker health returned ${response.status}`
    }
  } catch (error) {
    return {
      running: false,
      url,
      checkedAt,
      health: null,
      error: errorMessage(error)
    }
  }
}

function outputNameFor(sourceName: string) {
  const baseName = sourceName.replace(/\.[^.]+$/, '').trim() || 'animation'
  return `${baseName}.vrma`
}

export async function convertFbxToVrmaWithDockerWorker(
  sourceFile: File,
  framerate = 30
): Promise<Fbx2VrmaDockerConversionResult> {
  const worker = await getFbx2VrmaDockerWorkerStatus()
  if (!worker.running) {
    throw new Error(`${DOCKER_FBX2VRMA_WORKER_MISSING_REASON} ${DOCKER_FBX2VRMA_WORKER_INSTALL_HELP}`)
  }

  const url = `${worker.url.replace(/\/+$/, '')}/convert`
  const response = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        'x-batshit-filename': sourceFile.name,
        'x-batshit-framerate': String(framerate)
      },
      body: Buffer.from(await sourceFile.arrayBuffer())
    },
    resolveConvertTimeoutMs()
  )

  if (!response.ok) {
    const payload = await response.json().catch(() => null)
    const message =
      typeof payload?.error === 'string'
        ? payload.error
        : `FBX-to-VRMA worker conversion failed with ${response.status}.`
    throw new Error(message)
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  const outputName = response.headers.get('x-batshit-output-filename') || outputNameFor(sourceFile.name)
  return {
    file: bytesToFile(buffer, outputName, { type: 'model/vrm' }),
    size: buffer.length,
    worker
  }
}

export function buildFbx2VrmaWorkerManifest(health: Fbx2VrmaWorkerHealth | null) {
  return {
    version: health?.version || FBX2GLTF_VERSION,
    platform: 'linux-x64',
    binaryName: 'FBX2glTF-linux-x64',
    installedAt: null,
    source: 'docker-worker',
    releaseTag: FBX2GLTF_VERSION,
    downloadUrl: resolveFbxDownloadUrl('linux-x64'),
    checksumAlgorithm: 'sha256',
    checksum: 'b38210352fdd29d50ba53a6514c3ff05ccbb5d1e0a6442db7a49834bf34a3145',
    checksumSource: 'batshit-pinned-build-arg',
    checksumVerified: true,
    checksumNote:
      health?.checksumNote ||
      `${FBX2GLTF_CHECKSUM_NOTE} The Docker worker verifies the pinned Linux asset against Batshit's recorded SHA256 during image build.`
  }
}
