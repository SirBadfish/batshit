import { refusePluginMemberWrite } from './agentPlugins'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'

import {
  DEFAULT_SKILL_ICON_REF
} from '$lib/icons/iconCatalog'
import { redis } from '$lib/server/redis'
import type {
  SkillRow,
  SkillSourceRow,
  SlashCommandRow
} from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'

import { importSkillDefinition } from './skillImport'
import { normalizeSkillId, upsertSkill } from './skillRegistry'
import { normalizeAccessAgentId, parseAccessAgentIds, readSavedAccessAgentIds } from './agentAccessLists'
import { beginSlashCommandWrite, captureSlashCommandWriteBasis, captureSkillSourceWriteBasis, saveSkillSourceRecord, deleteSkillSourceRecord, updateSkillSourceScan, isSlashCommandMutationError, SlashCommandMutationError, COMMAND_ACCESS_FIELDS, saveSlashCommandRecord, type SlashCommandWritePreparation, type SkillSourceWriteBasis } from './slashCommandRevision'

const MAX_SCAN_DEPTH = 8
const MAX_SKILLS_PER_SCAN = 200
const SKILL_SOURCE_KEY_PREFIX = 'skill_source'

const SKIP_DIR_NAMES = new Set([
  '.git',
  '.hg',
  '.svn',
  '.next',
  '.svelte-kit',
  '.turbo',
  'node_modules',
  'dist',
  'build',
  'coverage',
  'target',
  'vendor'
])

interface ScanCandidate {
  skillDir: string
  markdownPath: string
}

interface UpsertSourceInput {
  userId: string
  id?: string
  label?: string
  rootPath: string
  scope?: SkillSourceRow['scope']
  trustLevel?: SkillRow['trust_level']
  enabledForAllAgents?: boolean
  enabledAgentIds?: unknown
  projectPath?: string | null
}

interface ScanSourceInput {
  userId: string
  sourceId: string
  attachAgentId?: string | null
}

function buildSkillSourceKey(userId: string, sourceId: string) {
  return `${SKILL_SOURCE_KEY_PREFIX}:${userId}:${sourceId}`
}

function expandHomePath(value: string) {
  const trimmed = value.trim()
  if (trimmed === '~') return os.homedir()
  if (trimmed.startsWith('~/')) return path.join(os.homedir(), trimmed.slice(2))
  return trimmed
}

function hashShort(value: string) {
  return createHash('sha256').update(value).digest('hex').slice(0, 10)
}

function normalizeTrustLevel(value: unknown): SkillRow['trust_level'] {
  return value === 'trusted' ? 'trusted' : 'untrusted'
}

function normalizeScope(value: unknown): SkillSourceRow['scope'] {
  return value === 'project' ? 'project' : 'global'
}

function normalizeLabel(label: string | undefined, rootPath: string) {
  const trimmed = label?.trim()
  if (trimmed) return trimmed
  const base = path.basename(rootPath)
  return base && base !== path.sep ? base : rootPath
}

function buildSourceId(rootPath: string, label?: string) {
  const seed = label?.trim() || path.basename(rootPath) || rootPath
  const readable = sanitizeId(seed) || 'skill_source'
  return `${readable}_${hashShort(rootPath)}`
}

function toCommandInvocation(skillName: string, fallbackId: string) {
  const source = skillName.trim() || fallbackId
  const specLike = source
    .toLowerCase()
    .replace(/_/g, '-')
    .replace(/[^a-z0-9:-]+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
  return `/${specLike || fallbackId}`
}

async function pathExists(targetPath: string) {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

async function readDirSafe(dirPath: string) {
  try {
    return await fs.readdir(dirPath, { withFileTypes: true })
  } catch {
    return []
  }
}

async function assertDirectory(rootPath: string) {
  const resolved = path.resolve(expandHomePath(rootPath))
  let real = resolved
  try {
    real = await fs.realpath(resolved)
  } catch {
    throw Object.assign(new Error(`Skill source folder does not exist: ${resolved}`), { status: 400 })
  }

  const stat = await fs.stat(real).catch(() => null)
  if (!stat?.isDirectory()) {
    throw Object.assign(new Error(`Skill source must be a folder: ${real}`), { status: 400 })
  }
  return real
}

async function findSkillMarkdownFiles(rootPath: string): Promise<ScanCandidate[]> {
  const candidates: ScanCandidate[] = []
  const visited = new Set<string>()

  async function walk(currentDir: string, depth: number) {
    if (candidates.length >= MAX_SKILLS_PER_SCAN) return
    if (depth > MAX_SCAN_DEPTH) return

    let realCurrent = currentDir
    try {
      realCurrent = await fs.realpath(currentDir)
    } catch {
      return
    }
    if (visited.has(realCurrent)) return
    visited.add(realCurrent)

    const markdownPath = path.join(realCurrent, 'SKILL.md')
    if (await pathExists(markdownPath)) {
      candidates.push({
        skillDir: realCurrent,
        markdownPath
      })
      return
    }

    const entries = await readDirSafe(realCurrent)
    for (const entry of entries) {
      if (candidates.length >= MAX_SKILLS_PER_SCAN) return
      if (!entry.isDirectory()) continue
      if (SKIP_DIR_NAMES.has(entry.name)) continue

      await walk(path.join(realCurrent, entry.name), depth + 1)
    }
  }

  await walk(rootPath, 0)
  candidates.sort((a, b) => a.skillDir.localeCompare(b.skillDir))
  return candidates
}

async function getExistingSource(userId: string, sourceId: string): Promise<SkillSourceRow | null> {
  return (await redis.json.get(buildSkillSourceKey(userId, sourceId))) as SkillSourceRow | null
}

async function listSlashCommandKeys(userId: string) {
  return redis.keys(`slash_command:${userId}:*`)
}

async function invocationExistsForOtherCommand(userId: string, invocation: string, commandId: string) {
  const keys = await listSlashCommandKeys(userId)
  for (const key of keys) {
    const command = (await redis.json.get(key)) as SlashCommandRow | null
    if (!command || command.id === commandId) continue
    const existingInvocation = command.invocation_pattern?.trim() || `/${command.id}`
    if (existingInvocation === invocation) return true
  }
  return false
}

async function buildUniqueInvocation(userId: string, desiredInvocation: string, commandId: string) {
  if (!(await invocationExistsForOtherCommand(userId, desiredInvocation, commandId))) {
    return desiredInvocation
  }
  const suffix = commandId.slice(0, 8).replace(/_/g, '-')
  const withSuffix = `${desiredInvocation}-${suffix}`.replace(/-+/g, '-')
  if (!(await invocationExistsForOtherCommand(userId, withSuffix, commandId))) {
    return withSuffix
  }
  return `${desiredInvocation}-${hashShort(commandId)}`
}

function buildDiscoveredId(sourceId: string, importedSkillId: string) {
  return normalizeSkillId(`${sourceId}_${importedSkillId}`, importedSkillId)
}

function sourceMetadata(source: SkillSourceRow, candidate: ScanCandidate) {
  return {
    batshit_source_id: source.id,
    batshit_source_label: source.label,
    batshit_source_scope: source.scope,
    batshit_source_root: source.root_path,
    batshit_source_skill_dir: candidate.skillDir,
    ...(source.project_path ? { batshit_project_path: source.project_path } : {})
  }
}

async function upsertDiscoveredSkillCommand(params: {
  source: SkillSourceRow
  candidate: ScanCandidate
  attachAgentId?: string | null
  nowIso: string
  preparation: SlashCommandWritePreparation
  sourceBasis: SkillSourceWriteBasis
}) {
  const { source, candidate, attachAgentId, nowIso } = params
  const imported = await importSkillDefinition({
    sourceType: 'local',
    source: candidate.skillDir,
    trustLevel: source.trust_level
  })
  const importedSkill = imported.skill
  const skillId = buildDiscoveredId(source.id, importedSkill.id)
  const commandId = skillId
  const commandKey = `slash_command:${source.user_id}:${commandId}`
  const basis = await captureSlashCommandWriteBasis(params.preparation, [commandId], params.sourceBasis)
  const existingCommand = (await redis.json.get(commandKey)) as SlashCommandRow | null
  await refusePluginMemberWrite(source.user_id, existingCommand ?? { id: commandId, skill_id: skillId })
  const existingAgentIds = existingCommand ? readSavedAccessAgentIds(existingCommand.enabled_agent_ids) : []
  const sourceAgentIds = readSavedAccessAgentIds(source.enabled_agent_ids) ?? []

  const metadata = {
    ...(importedSkill.metadata ?? {}),
    ...sourceMetadata(source, candidate)
  }

  const skill = await upsertSkill({
    userId: source.user_id,
    commandId,
    nowIso,
    skill: {
      id: skillId,
      name: importedSkill.name,
      displayName: importedSkill.displayName,
      description: importedSkill.description,
      markdown: importedSkill.markdown,
      source: 'local',
      sourceRef: candidate.skillDir,
      dependencies: importedSkill.dependencies,
      license: importedSkill.license,
      compatibility: importedSkill.compatibility,
      metadata,
      allowedTools: importedSkill.allowedTools,
      standardsStatus: importedSkill.standardsStatus,
      standardsIssues: importedSkill.standardsIssues,
      trustLevel: source.trust_level,
      hasScripts: importedSkill.hasScripts,
      hasReferences: importedSkill.hasReferences,
      hasAssets: importedSkill.hasAssets,
      bundleManifest: importedSkill.bundleManifest,
      bundleFiles: importedSkill.bundleFiles,
      isActive: source.enabled !== false
    }
  })

  const nextAgentIds = new Set(existingAgentIds ?? [])
  for (const id of sourceAgentIds) nextAgentIds.add(id)
  const normalizedAttachAgentId = normalizeAccessAgentId(attachAgentId)
  if (normalizedAttachAgentId) nextAgentIds.add(normalizedAttachAgentId)

  const desiredInvocation = toCommandInvocation(importedSkill.name || importedSkill.displayName, commandId)
  const invocation = await buildUniqueInvocation(
    source.user_id,
    existingCommand?.invocation_pattern || desiredInvocation,
    commandId
  )
  const enabledForAllAgents =
    existingCommand?.enabled_for_all_agents === true || source.enabled_for_all_agents === true
  const enabledAgentIds = existingCommand && existingAgentIds === undefined ? undefined : Array.from(nextAgentIds)

  const nextCommand: SlashCommandRow = {
    ...(existingCommand ?? {
      id: commandId,
      user_id: source.user_id,
      created_at: nowIso
    }),
    id: commandId,
    user_id: source.user_id,
    name: importedSkill.name || commandId,
    displayName: importedSkill.displayName || importedSkill.name || commandId,
    description: skill.description || '',
    type: 'skill',
    prompt_template: undefined,
    instructions: '',
    parameters: existingCommand?.parameters ?? [],
    skill_id: skill.id,
    skill_source: skill.source,
    skill_source_ref: skill.source_ref,
    skill_summary: skill.description,
    skill_dependencies: skill.dependencies ?? [],
    skill_license: skill.license,
    skill_compatibility: skill.compatibility,
    skill_metadata: skill.metadata ?? {},
    skill_allowed_tools: skill.allowed_tools ?? [],
    skill_standards_status: skill.standards_status,
    skill_standards_issues: skill.standards_issues ?? [],
    skill_bundle_manifest: skill.bundle_manifest,
    skill_bundle_files: undefined,
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts === true,
    has_references: skill.has_references === true,
    has_assets: skill.has_assets === true,
    invocation_pattern: invocation,
    can_be_attached_to_agents: enabledForAllAgents || (enabledAgentIds?.length ?? 0) > 0,
    can_be_invoked_in_chat: existingCommand?.can_be_invoked_in_chat ?? true,
    enabled_for_all_agents: enabledForAllAgents,
    enabled_agent_ids: enabledAgentIds,
    category: 'skills',
    tags: Array.from(new Set([...(existingCommand?.tags ?? []), 'folder-source'])),
    icon_ref: existingCommand?.icon_ref ?? DEFAULT_SKILL_ICON_REF,
    icon: undefined,
    usage_count: existingCommand?.usage_count ?? 0,
    last_used_at: existingCommand?.last_used_at,
    is_active: source.enabled !== false && existingCommand?.is_active !== false,
    is_system: false,
    created_at: existingCommand?.created_at ?? nowIso,
    updated_at: nowIso
  }
  if (enabledAgentIds === undefined) Reflect.deleteProperty(nextCommand, 'enabled_agent_ids')

  const stored = await saveSlashCommandRecord(source.user_id, { record: nextCommand,
    mode: existingCommand ? 'update' : 'create',
    preserveAccess: COMMAND_ACCESS_FIELDS.filter(field => field !== 'is_active' || source.enabled !== false),
    mergeAgentIds: [...sourceAgentIds, ...(normalizedAttachAgentId ? [normalizedAttachAgentId] : [])],
    enableForAll: source.enabled_for_all_agents === true }, basis)
  if (!stored) throw Object.assign(new Error('The discovered command changed during the scan. Rescan from its current saved state.'), { status: 409 })

  return {
    command: stored,
    skill,
    warnings: imported.warnings
  }
}

export async function listSkillSources(userId: string): Promise<SkillSourceRow[]> {
  const keys = await redis.keys(`${SKILL_SOURCE_KEY_PREFIX}:${userId}:*`)
  const rows: SkillSourceRow[] = []
  for (const key of keys) {
    const row = (await redis.json.get(key)) as SkillSourceRow | null
    if (row) rows.push(row)
  }
  rows.sort((a, b) => a.label.localeCompare(b.label))
  return rows
}

export async function upsertSkillSource(input: UpsertSourceInput, preparation = beginSlashCommandWrite(input.userId)): Promise<SkillSourceRow> {
  await captureSlashCommandWriteBasis(preparation, [])
  const rootPath = await assertDirectory(input.rootPath)
  const now = new Date().toISOString()
  const id = sanitizeId(input.id ?? '') || buildSourceId(rootPath, input.label)
  const basis = await captureSkillSourceWriteBasis(preparation, id)
  const existing = await getExistingSource(input.userId, id)

  const source: SkillSourceRow = {
    ...(existing ?? {
      id,
      user_id: input.userId,
      created_at: now,
      discovered_skill_ids: [],
      discovered_command_ids: []
    }),
    id,
    user_id: input.userId,
    label: normalizeLabel(input.label, rootPath),
    root_path: rootPath,
    scope: normalizeScope(input.scope),
    trust_level: normalizeTrustLevel(input.trustLevel),
    enabled: true,
    enabled_for_all_agents:
      typeof input.enabledForAllAgents === 'boolean'
        ? input.enabledForAllAgents
        : existing?.enabled_for_all_agents === true,
    enabled_agent_ids:
      input.enabledAgentIds !== undefined
        ? parseAccessAgentIds(input.enabledAgentIds)
        : readSavedAccessAgentIds(existing?.enabled_agent_ids) ?? [],
    project_path:
      typeof input.projectPath === 'string' && input.projectPath.trim()
        ? path.resolve(expandHomePath(input.projectPath))
        : existing?.project_path,
    last_scanned_at: existing?.last_scanned_at,
    last_scan_status: existing?.last_scan_status,
    last_scan_error: existing?.last_scan_error,
    discovered_skill_ids: existing?.discovered_skill_ids ?? [],
    discovered_command_ids: existing?.discovered_command_ids ?? [],
    created_at: existing?.created_at ?? now,
    updated_at: now
  }
  if (existing && input.enabledAgentIds === undefined && !Object.hasOwn(existing, 'enabled_agent_ids')) {
    Reflect.deleteProperty(source, 'enabled_agent_ids')
  }

  return await saveSkillSourceRecord(source, basis)
}

export async function scanSkillSource(input: ScanSourceInput, preparation = beginSlashCommandWrite(input.userId)) {
  const sourceBasis = await captureSkillSourceWriteBasis(preparation, input.sourceId)
  const source = await getExistingSource(input.userId, input.sourceId)
  if (!source) {
    throw Object.assign(new Error(`Skill source '${input.sourceId}' was not found.`), { status: 404 })
  }

  // Validate requested identities before importing files or writing source/command metadata.
  readSavedAccessAgentIds(source.enabled_agent_ids)
  if (input.attachAgentId !== undefined && input.attachAgentId !== null && !normalizeAccessAgentId(input.attachAgentId)) {
    throw Object.assign(new Error('The attached agent ID is invalid.'), { status: 400 })
  }

  const now = new Date().toISOString()
  try {
    const rootPath = await assertDirectory(source.root_path)
    const candidates = await findSkillMarkdownFiles(rootPath)
    const importedCommands: SlashCommandRow[] = []
    const importedSkills: SkillRow[] = []
    const warnings: string[] = []

    for (const candidate of candidates) {
      const result = await upsertDiscoveredSkillCommand({
        source,
        candidate,
        attachAgentId: input.attachAgentId,
        nowIso: now, preparation, sourceBasis
      })
      importedCommands.push(result.command)
      importedSkills.push(result.skill)
      warnings.push(...result.warnings)
    }

    const nextSource = await updateSkillSourceScan(input.userId, source.id, {
      last_scanned_at: now,
      last_scan_status: 'success',
      last_scan_error: undefined,
      discovered_skill_ids: importedSkills.map(skill => skill.id),
      discovered_command_ids: importedCommands.map(command => command.id),
      updated_at: now
    }, sourceBasis)
    if (!nextSource) throw Object.assign(new Error('The source was deleted during the scan.'), { status: 409 })

    return {
      source: nextSource,
      scanned: candidates.length,
      skills: importedSkills,
      commands: importedCommands,
      warnings: Array.from(new Set(warnings))
    }
  } catch (error) {
    // A refused/stale/unknown command cannot be followed by a fresh bookkeeping write.
    if (isSlashCommandMutationError(error)) throw new SlashCommandMutationError(error.code, `Earlier skill import/file updates may already have completed. ${error.message}`, error.outcome, error.status)
    const message = error instanceof Error ? error.message : 'Skill source scan failed.'
    await updateSkillSourceScan(input.userId, source.id, {
      last_scanned_at: now,
      last_scan_status: 'error',
      last_scan_error: message,
      updated_at: now
    }, sourceBasis)
    throw error
  }
}

export async function deleteSkillSource(userId: string, sourceId: string) {
  const preparation = beginSlashCommandWrite(userId)
  const basis = await captureSkillSourceWriteBasis(preparation, sourceId)
  await deleteSkillSourceRecord(userId, sourceId, basis)
}

