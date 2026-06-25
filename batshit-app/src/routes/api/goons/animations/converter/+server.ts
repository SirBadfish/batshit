import { json, type RequestHandler } from '@sveltejs/kit'
import fs from 'node:fs/promises'
import path from 'node:path'
import {
  FBX2GLTF_ASSETS,
  FBX2GLTF_CHECKSUM_NOTE,
  FBX2GLTF_VERSION,
  resolveServerPlatform,
  resolveFbxInstallDir,
  resolveInstalledBinary,
  resolveManifestPath,
  resolveFbxDownloadUrl,
  type Fbx2GltfManifest,
  type Fbx2GltfPlatform,
  readFbxManifest
} from '$lib/server/converters/fbx2vrmaInstaller'
import {
  DOCKER_FBX2VRMA_WORKER_INSTALL_HELP,
  DOCKER_FBX2VRMA_WORKER_MISSING_REASON,
  buildFbx2VrmaWorkerManifest,
  getFbx2VrmaDockerWorkerStatus,
  isBatshitContainerizedRuntime
} from '$lib/server/services/fbx2vrmaWorker'

function isValidPlatform(value: unknown): value is Fbx2GltfPlatform {
  return typeof value === 'string' && value in FBX2GLTF_ASSETS
}

async function buildStatus() {
  const installed = await resolveInstalledBinary()
  const manifest = (await readFbxManifest()) as Fbx2GltfManifest | null
  const dockerUnsupported = isBatshitContainerizedRuntime()

  if (dockerUnsupported) {
    const worker = await getFbx2VrmaDockerWorkerStatus()
    const workerRunning = worker.running

    return {
      installed: workerRunning,
      supported: workerRunning,
      dockerUnsupported: !workerRunning,
      supportLevel: workerRunning ? 'docker-worker' : 'docker-worker-missing',
      reason: workerRunning ? null : DOCKER_FBX2VRMA_WORKER_MISSING_REASON,
      installHelp: DOCKER_FBX2VRMA_WORKER_INSTALL_HELP,
      manifest: workerRunning ? buildFbx2VrmaWorkerManifest(worker.health) : null,
      defaultPlatform: 'linux-x64',
      testedVersion: FBX2GLTF_VERSION,
      checksumNote: workerRunning
        ? buildFbx2VrmaWorkerManifest(worker.health).checksumNote
        : FBX2GLTF_CHECKSUM_NOTE,
      worker
    }
  }

  return {
    installed: Boolean(installed?.path),
    supported: true,
    dockerUnsupported: false,
    supportLevel: 'native-managed',
    reason: null,
    installHelp: 'Use the Admin installer',
    manifest: manifest ?? null,
    defaultPlatform: resolveServerPlatform(),
    testedVersion: FBX2GLTF_VERSION,
    checksumNote: FBX2GLTF_CHECKSUM_NOTE
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  return json(await buildStatus())
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  const payload = await request.json().catch(() => ({}))
  const platform = payload?.platform

  if (!isValidPlatform(platform)) {
    return json({ error: 'Invalid platform.' }, { status: 400 })
  }

  if (isBatshitContainerizedRuntime()) {
    return json(await buildStatus(), { status: 503 })
  }

  const assetName = FBX2GLTF_ASSETS[platform]
  const installDir = resolveFbxInstallDir()
  const stagingDir = `${installDir}.tmp-${Date.now()}`
  const url = resolveFbxDownloadUrl(platform)
  await fs.rm(stagingDir, { recursive: true, force: true })
  await fs.mkdir(stagingDir, { recursive: true })

  try {
    const response = await fetch(url)
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      return json(
        { error: text || `Failed to download FBX2glTF (${response.status}).` },
        { status: 500 }
      )
    }

    const buffer = Buffer.from(await response.arrayBuffer())
    const targetPath = path.join(stagingDir, assetName)
    await fs.writeFile(targetPath, buffer)

    if (!assetName.endsWith('.exe')) {
      await fs.chmod(targetPath, 0o755)
    }

    const installedAt = new Date().toISOString()
    const manifest: Fbx2GltfManifest = {
      version: FBX2GLTF_VERSION,
      platform,
      binaryName: assetName,
      installedAt,
      source: 'github-release',
      releaseTag: FBX2GLTF_VERSION,
      downloadUrl: url,
      checksumAlgorithm: null,
      checksum: null,
      checksumSource: 'upstream-not-published',
      checksumVerified: false,
      checksumNote: FBX2GLTF_CHECKSUM_NOTE
    }

    await fs.writeFile(resolveManifestPath(stagingDir), JSON.stringify(manifest, null, 2))
    await fs.rm(installDir, { recursive: true, force: true })
    await fs.rename(stagingDir, installDir)

    return json({
      installed: true,
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'native-managed',
      reason: null,
      installHelp: 'Use the Admin installer',
      manifest,
      defaultPlatform: resolveServerPlatform(),
      testedVersion: FBX2GLTF_VERSION,
      checksumNote: FBX2GLTF_CHECKSUM_NOTE
    })
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to install FBX converter.'
      },
      { status: 500 }
    )
  } finally {
    await fs.rm(stagingDir, { recursive: true, force: true }).catch(() => {})
  }
}

export const DELETE: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  if (isBatshitContainerizedRuntime()) {
    return json(await buildStatus(), { status: 503 })
  }

  try {
    const installDir = resolveFbxInstallDir()
    await fs.rm(installDir, { recursive: true, force: true })

    const installed = await resolveInstalledBinary()
    const manifest = (await readFbxManifest()) as Fbx2GltfManifest | null

    return json({
      installed: Boolean(installed?.path),
      supported: true,
      dockerUnsupported: false,
      supportLevel: 'native-managed',
      reason: null,
      installHelp: 'Use the Admin installer',
      manifest: manifest ?? null,
      defaultPlatform: resolveServerPlatform(),
      testedVersion: FBX2GLTF_VERSION,
      checksumNote: FBX2GLTF_CHECKSUM_NOTE
    })
  } catch (error) {
    return json(
      {
        error: error instanceof Error ? error.message : 'Failed to uninstall FBX converter.'
      },
      { status: 500 }
    )
  }
}
