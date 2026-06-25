import { createHash } from 'node:crypto'
import { createReadStream, createWriteStream } from 'node:fs'
import { mkdir, rename, rm, stat } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'
import { pipeline } from 'node:stream/promises'

import {
  getVoiceEngineRecord,
  resolveVoiceEngineSttModelCatalog,
  upsertVoiceEngineRecord
} from '$lib/server/services/voiceEngineRegistry'
import type {
  VoiceEngineLaunchConfig,
  VoiceEngineModelCatalog,
  VoiceEngineModelCatalogEntry,
  VoiceEngineRecord
} from '$lib/types/voice'

type VoiceEngineModelActionResult = {
  engineId: string
  providerId: `byo:${string}`
  modelId: string
  modelPath?: string
  installed?: boolean
  active?: boolean
  restartRequired?: boolean
  engine: Awaited<ReturnType<typeof upsertVoiceEngineRecord>>['summary']
}

function normalizeEngineId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('engineId must be a string.')
  }
  const normalized = value.trim().toLowerCase()
  if (!normalized) {
    throw new Error('engineId is required.')
  }
  if (!/^[a-z0-9][a-z0-9._-]*$/.test(normalized)) {
    throw new Error('engineId must use lowercase letters, numbers, dots, underscores, or dashes.')
  }
  return normalized
}

function normalizeModelId(value: unknown): string {
  if (typeof value !== 'string') {
    throw new Error('modelId must be a string.')
  }
  const normalized = value.trim()
  if (!normalized) {
    throw new Error('modelId is required.')
  }
  return normalized
}

function assertCatalog(
  record: VoiceEngineRecord
): { catalog: VoiceEngineModelCatalog; models: VoiceEngineModelCatalogEntry[] } {
  const catalog = resolveVoiceEngineSttModelCatalog(record)
  if (!catalog || !Array.isArray(catalog.models) || catalog.models.length === 0) {
    throw new Error('This engine has not published an STT model catalog yet.')
  }
  return { catalog, models: catalog.models }
}

function findCatalogEntry(
  record: VoiceEngineRecord,
  modelId: string
): { catalog: VoiceEngineModelCatalog; entry: VoiceEngineModelCatalogEntry } {
  const { catalog, models } = assertCatalog(record)
  const entry = models.find((candidate) => candidate.id === modelId)
  if (!entry) {
    throw new Error(`Model "${modelId}" is not published for engine "${record.id}".`)
  }
  return { catalog, entry }
}

function assertInsideRoot(root: string, target: string): string {
  const resolvedRoot = path.resolve(root)
  const resolvedTarget = path.resolve(target)
  const relative = path.relative(resolvedRoot, resolvedTarget)
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error('Model paths must stay inside the engine install root.')
  }
  return resolvedTarget
}

function resolveInstallRoot(record: VoiceEngineRecord): string {
  const installRoot = record.localRuntime?.installRoot?.trim()
  if (!installRoot) {
    throw new Error('This engine does not have a local install root, so Batshit cannot manage model files for it.')
  }
  return path.resolve(installRoot)
}

function resolveModelPath(
  record: VoiceEngineRecord,
  catalog: VoiceEngineModelCatalog,
  entry: VoiceEngineModelCatalogEntry
): string {
  const installRoot = resolveInstallRoot(record)
  const modelDir = catalog.modelDir?.trim() || 'models'
  const filename = entry.filename?.trim() || entry.requestModel?.trim() || entry.id.trim()
  if (!filename || filename.includes('\0')) {
    throw new Error('Model filename is invalid.')
  }

  const baseDir = path.isAbsolute(modelDir) ? path.resolve(modelDir) : path.resolve(installRoot, modelDir)
  const target = path.isAbsolute(filename) ? path.resolve(filename) : path.resolve(baseDir, filename)
  return assertInsideRoot(installRoot, target)
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const info = await stat(filePath)
    return info.isFile()
  } catch {
    return false
  }
}

async function hashFileSha256(filePath: string): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(filePath)) {
    hash.update(chunk)
  }
  return hash.digest('hex')
}

function updateCatalogEntry(
  catalog: VoiceEngineModelCatalog,
  modelId: string,
  update: Partial<VoiceEngineModelCatalogEntry>,
  activeModelId?: string
): VoiceEngineModelCatalog {
  return {
    ...catalog,
    activeModelId: activeModelId ?? catalog.activeModelId,
    models: catalog.models.map((model) => {
      if (model.id !== modelId) return model
      const next = { ...model, ...update }
      if (update.failedReason === undefined) delete next.failedReason
      return next
    })
  }
}

function resolveRequestModel(entry: VoiceEngineModelCatalogEntry): string {
  return entry.requestModel?.trim() || entry.filename?.trim() || entry.id
}

function replaceLaunchModelArg(
  launch: VoiceEngineLaunchConfig | undefined,
  modelPath: string,
  catalog: VoiceEngineModelCatalog
): VoiceEngineLaunchConfig | undefined {
  if (!launch) return undefined
  const args = [...(launch.args ?? [])]

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === '-m' || arg === '--model') {
      if (index + 1 < args.length) {
        args[index + 1] = modelPath
        return { ...launch, args }
      }
    }
    if (arg.startsWith('--model=')) {
      args[index] = `--model=${modelPath}`
      return { ...launch, args }
    }
  }

  if (catalog.kind === 'whisper.cpp') {
    args.push('-m', modelPath)
    return { ...launch, args }
  }

  return launch
}

async function persistModelCatalogUpdate(
  userId: string,
  record: VoiceEngineRecord,
  payload: Record<string, any>
): Promise<Awaited<ReturnType<typeof upsertVoiceEngineRecord>>['summary']> {
  const result = await upsertVoiceEngineRecord(userId, record.id, payload)
  return result.summary
}

export async function downloadVoiceEngineModel(
  userId: string,
  engineIdValue: string,
  modelIdValue: string
): Promise<VoiceEngineModelActionResult> {
  const engineId = normalizeEngineId(engineIdValue)
  const modelId = normalizeModelId(modelIdValue)
  const record = await getVoiceEngineRecord(userId, engineId)
  if (!record) {
    throw new Error(`Engine "${engineId}" was not found.`)
  }
  const { catalog, entry } = findCatalogEntry(record, modelId)
  const modelPath = resolveModelPath(record, catalog, entry)

  if (entry.installed === true && (await fileExists(modelPath))) {
    const engine = await persistModelCatalogUpdate(userId, record, {
      sttModelCatalog: updateCatalogEntry(catalog, modelId, {
        installed: true,
        failedReason: undefined
      })
    })
    return {
      engineId,
      providerId: `byo:${engineId}`,
      modelId,
      modelPath,
      installed: true,
      active: catalog.activeModelId === modelId,
      restartRequired: false,
      engine
    }
  }

  const url = entry.url?.trim()
  if (!url) {
    throw new Error(`Model "${modelId}" does not have a download URL.`)
  }

  const tempPath = `${modelPath}.download-${Date.now()}`
  try {
    await mkdir(path.dirname(modelPath), { recursive: true })
    const response = await fetch(url)
    if (!response.ok || !response.body) {
      throw new Error(`Model download failed with HTTP ${response.status}.`)
    }

    await pipeline(Readable.fromWeb(response.body as any), createWriteStream(tempPath))

    if (entry.sha256) {
      const actualHash = await hashFileSha256(tempPath)
      if (actualHash.toLowerCase() !== entry.sha256.toLowerCase()) {
        throw new Error('Downloaded model checksum did not match the catalog checksum.')
      }
    }

    await rename(tempPath, modelPath)
    const nextCatalog = updateCatalogEntry(catalog, modelId, {
      installed: true,
      failedReason: undefined
    })
    const engine = await persistModelCatalogUpdate(userId, record, {
      sttModelCatalog: nextCatalog
    })

    return {
      engineId,
      providerId: `byo:${engineId}`,
      modelId,
      modelPath,
      installed: true,
      active: nextCatalog.activeModelId === modelId,
      restartRequired: false,
      engine
    }
  } catch (error) {
    await rm(tempPath, { force: true }).catch(() => undefined)
    const failedCatalog = updateCatalogEntry(catalog, modelId, {
      installed: false,
      failedReason: error instanceof Error ? error.message : 'Download failed.'
    })
    await persistModelCatalogUpdate(userId, record, {
      sttModelCatalog: failedCatalog
    }).catch(() => undefined)
    throw error
  }
}

export async function useVoiceEngineModel(
  userId: string,
  engineIdValue: string,
  modelIdValue: string
): Promise<VoiceEngineModelActionResult> {
  const engineId = normalizeEngineId(engineIdValue)
  const modelId = normalizeModelId(modelIdValue)
  const record = await getVoiceEngineRecord(userId, engineId)
  if (!record) {
    throw new Error(`Engine "${engineId}" was not found.`)
  }
  const { catalog, entry } = findCatalogEntry(record, modelId)
  const modelPath = resolveModelPath(record, catalog, entry)
  const installed = entry.installed === true || (await fileExists(modelPath))
  if (!installed) {
    throw new Error(`Model "${modelId}" must be downloaded before it can be selected.`)
  }

  const nextCatalog = updateCatalogEntry(catalog, modelId, {
    installed: true,
    failedReason: undefined
  }, modelId)
  const nextLaunch = replaceLaunchModelArg(record.localRuntime?.launch, modelPath, catalog)
  const nextLocalRuntime =
    nextLaunch && record.localRuntime
      ? {
          ...record.localRuntime,
          launch: nextLaunch
        }
      : record.localRuntime

  const updatePayload: Record<string, any> = {
    sttDefaults: {
      ...(record.sttDefaults ?? {}),
      modelId: resolveRequestModel(entry)
    },
    sttModelCatalog: nextCatalog
  }
  if (nextLocalRuntime) {
    updatePayload.localRuntime = nextLocalRuntime
  }
  const engine = await persistModelCatalogUpdate(userId, record, updatePayload)

  return {
    engineId,
    providerId: `byo:${engineId}`,
    modelId,
    modelPath,
    installed: true,
    active: true,
    restartRequired: catalog.requiresRestartOnModelChange === true,
    engine
  }
}

export async function deleteVoiceEngineModel(
  userId: string,
  engineIdValue: string,
  modelIdValue: string
): Promise<VoiceEngineModelActionResult> {
  const engineId = normalizeEngineId(engineIdValue)
  const modelId = normalizeModelId(modelIdValue)
  const record = await getVoiceEngineRecord(userId, engineId)
  if (!record) {
    throw new Error(`Engine "${engineId}" was not found.`)
  }
  const { catalog, entry } = findCatalogEntry(record, modelId)
  const requestModel = resolveRequestModel(entry)
  if (catalog.activeModelId === modelId || record.sttDefaults?.modelId === requestModel) {
    throw new Error('The active STT model cannot be deleted. Select another installed model first.')
  }

  const modelPath = resolveModelPath(record, catalog, entry)
  await rm(modelPath, { force: true })
  const nextCatalog = updateCatalogEntry(catalog, modelId, {
    installed: false,
    failedReason: undefined
  })
  const engine = await persistModelCatalogUpdate(userId, record, {
    sttModelCatalog: nextCatalog
  })

  return {
    engineId,
    providerId: `byo:${engineId}`,
    modelId,
    modelPath,
    installed: false,
    active: false,
    restartRequired: false,
    engine
  }
}
