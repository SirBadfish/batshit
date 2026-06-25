import path from 'node:path'
import fs from 'node:fs/promises'

export const FBX2GLTF_VERSION = 'v0.9.7'
export const FBX2GLTF_RELEASE_BASE =
  `https://github.com/facebookincubator/FBX2glTF/releases/download/${FBX2GLTF_VERSION}`
export const FBX2GLTF_CHECKSUM_NOTE =
  'Upstream FBX2glTF releases do not publish official checksums, so Batshit pins the exact release URL and records the source instead of claiming checksum verification.'

export const FBX2GLTF_ASSETS = {
  'darwin-x64': 'FBX2glTF-darwin-x64',
  'linux-x64': 'FBX2glTF-linux-x64',
  'windows-x64': 'FBX2glTF-windows-x64.exe'
} as const

export type Fbx2GltfPlatform = keyof typeof FBX2GLTF_ASSETS

export type Fbx2GltfManifest = {
  version: string
  platform: Fbx2GltfPlatform
  binaryName: string
  installedAt: string
  source: 'github-release'
  releaseTag: string
  downloadUrl: string
  checksumAlgorithm: null
  checksum: null
  checksumSource: 'upstream-not-published'
  checksumVerified: false
  checksumNote: string
}

export function resolveServerPlatform(): Fbx2GltfPlatform {
  if (process.platform === 'win32') return 'windows-x64'
  if (process.platform === 'linux') return 'linux-x64'
  return 'darwin-x64'
}

function isLikelyRepoRoot(dir: string) {
  return path.basename(dir) === 'batshit'
}

export function resolveRepoRoot() {
  const explicit = process.env.BATSHIT_REPO_ROOT || process.env.BATSHIT_MAC_REPO_ROOT
  if (explicit?.trim()) return path.resolve(explicit.trim())

  const cwd = process.cwd()
  if (isLikelyRepoRoot(cwd)) {
    return cwd
  }
  if (path.basename(cwd) === 'batshit-app' || path.basename(cwd) === 'n8n') {
    return path.resolve(cwd, '..')
  }
  if (path.basename(cwd) === 'batshit-server') {
    return path.resolve(cwd, '..')
  }
  if (path.basename(cwd) === 'server' && path.basename(path.dirname(cwd)) === 'batshit-server') {
    return path.resolve(cwd, '..', '..')
  }
  return cwd
}

export function resolveIgnoreDir() {
  return path.join(resolveRepoRoot(), '_local')
}

export function resolveFbxInstallDir() {
  const explicit = process.env.BATSHIT_FBX2GLTF_DIR?.trim()
  if (explicit) return path.resolve(explicit)

  const runtimeDataDir = process.env.BATSHIT_RUNTIME_DATA_DIR?.trim()
  if (runtimeDataDir) return path.resolve(runtimeDataDir, 'fbx2vrma')

  return path.join(resolveIgnoreDir(), 'fbx2vrma')
}

export function resolveManifestPath(installDir = resolveFbxInstallDir()) {
  return path.join(installDir, 'manifest.json')
}

export async function readFbxManifest(): Promise<Fbx2GltfManifest | null> {
  try {
    const raw = await fs.readFile(resolveManifestPath(), 'utf-8')
    const parsed = JSON.parse(raw) as Fbx2GltfManifest
    if (!parsed?.binaryName || !parsed?.platform) return null
    return parsed
  } catch {
    return null
  }
}

export async function resolveInstalledBinary() {
  const envPath = process.env.BATSHIT_FBX2GLTF_PATH
  if (envPath) {
    try {
      await fs.access(envPath)
      return { path: envPath, manifest: await readFbxManifest() }
    } catch {
      // fallthrough
    }
  }

  const installDir = resolveFbxInstallDir()
  const manifest = await readFbxManifest()
  const serverPlatform = resolveServerPlatform()
  const preferredAsset = FBX2GLTF_ASSETS[serverPlatform]

  if (manifest?.binaryName && (!manifest.platform || manifest.platform === serverPlatform)) {
    const candidate = path.join(installDir, manifest.binaryName)
    try {
      await fs.access(candidate)
      return { path: candidate, manifest }
    } catch {
      // fallthrough
    }
  }

  if (preferredAsset) {
    const candidate = path.join(installDir, preferredAsset)
    try {
      await fs.access(candidate)
      return { path: candidate, manifest }
    } catch {
      // continue
    }
  }

  const legacyDir = path.join(resolveIgnoreDir(), 'tools', 'fbx2vrma-converter')
  if (preferredAsset) {
    const candidate = path.join(legacyDir, preferredAsset)
    try {
      await fs.access(candidate)
      return { path: candidate, manifest }
    } catch {
      // continue
    }
  }

  return null
}

export function resolveFbxDownloadUrl(platform: Fbx2GltfPlatform) {
  return `${FBX2GLTF_RELEASE_BASE}/${FBX2GLTF_ASSETS[platform]}`
}
