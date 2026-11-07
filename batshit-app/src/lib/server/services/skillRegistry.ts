import { getBatshitHomeDir } from './batshitHome'
import fs from 'node:fs/promises'
import { existsSync } from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { APP_ACTIONS_SKILL_ID, APP_ACTIONS_COMMAND_ID, isCanonicalAppActionsCommand, isCanonicalAppActionsSkill, BUILTIN_PLUGIN_SKILLS, getBuiltinSystemSkillsRoot, resolveBuiltinSystemSkillDirectory } from './systemPluginPackage'

import { redis } from '$lib/server/redis'
import { mcpGatewayService } from '$lib/server/services/mcpGatewayService'
import { SKILL_FILES_MISSING } from '$lib/server/services/skillFilesMissing'
import type {
  MCPGateway,
  SkillBundleFile,
  SkillBundleFileKind,
  SkillBundleManifest,
  SkillDependencyRequirement,
  SkillRow,
  SkillStandardsStatus,
  SlashCommandRow
} from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { acquireSettingsMutation, assertSettingsLifecycle, captureSettingsLifecycle, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'
import { beginSlashCommandWrite, captureSlashCommandWriteBasis, type SlashCommandWritePreparation, COMMAND_ACCESS_FIELDS, saveSlashCommandRecord } from './slashCommandRevision'
import {
  normalizeAllowedTools,
  splitFrontmatter
} from './skillFrontmatter'

const SKILL_FILESYSTEM_ROOT = path.join(getBatshitHomeDir(), 'skills')
const DEFAULT_SKILL_TEMPLATE = '# Skill\n\nAdd SKILL.md content for this skill.\n'
const MAX_COMPATIBILITY_LENGTH = 500
const MAX_DESCRIPTION_LENGTH = 1024
const VALID_SKILL_NAME_PATTERN = /^(?!-)(?!.*--)[\p{Ll}\p{N}-]{1,64}(?<!-)$/u
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.ico',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.7z',
  '.mp3',
  '.wav',
  '.mp4',
  '.mov',
  '.webm',
  '.woff',
  '.woff2',
  '.ttf',
  '.otf'
])
export type SkillFilesystemStartupResult = { complete: boolean; failed: number }
let startupFilesystemPassPromise: Promise<SkillFilesystemStartupResult> | null = null

const INTEGRATION_LABELS: Record<string, string> = {
  n8n_mcp: 'n8n MCP',
  huggingface: 'HuggingFace MCP',
  comfyui: 'ComfyUI MCP',
  browser: 'Agent Browser',
  web_search: 'Web search'
}

interface ParsedSkillMarkdownMetadata {
  name?: string
  displayName?: string
  description?: string
  dependencies: SkillDependencyRequirement[]
  license?: string
  compatibility?: string
  metadata: Record<string, string>
  allowedTools: string[]
  standardsStatus: SkillStandardsStatus
  standardsIssues: string[]
  trustLevel?: SkillRow['trust_level']
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
}

interface SkillFilesystemSnapshot {
  rootDir: string
  markdownPath: string
  markdown: string
  bundleFiles: SkillBundleFile[]
  bundleManifest?: SkillBundleManifest
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
  parsed: ParsedSkillMarkdownMetadata
}

export interface SkillDependencyStatus {
  id: string
  label: string
  required: boolean
  available: boolean
  reason?: string
}

export interface SkillDependencyCheckResult {
  allRequiredAvailable: boolean
  statuses: SkillDependencyStatus[]
}

export interface UpsertSkillInput {
  userId: string
  commandId: string
  nowIso?: string
  /** Internal canonical-package seed only; never copied from a model's skill payload. */
  builtinAppActionsSeed?: boolean
  skill: {
    id?: string
    name?: string
    displayName?: string
    description?: string
    markdown?: string
    source?: SkillRow['source']
    sourceRef?: string
    dependencies?: SkillDependencyRequirement[]
    license?: string
    compatibility?: string
    metadata?: Record<string, string>
    allowedTools?: string[]
    standardsStatus?: SkillStandardsStatus
    standardsIssues?: string[]
    trustLevel?: SkillRow['trust_level']
    hasScripts?: boolean
    hasReferences?: boolean
    hasAssets?: boolean
    bundleManifest?: SkillBundleManifest
    bundleFiles?: SkillBundleFile[]
    isSystem?: boolean
    isActive?: boolean
  }
}

/**
 * BL-369: a user skill's text lives only in its folder under the skill root (Redis keeps
 * metadata), so a missing folder is lost data, never a reason to write a blank placeholder
 * over the skill. Thrown by `getSkill` and by a save that brings no text; nothing is written.
 */
export class SkillFilesMissingError extends Error {
  readonly code = SKILL_FILES_MISSING
  readonly skillId: string
  readonly folder: string

  constructor(skill: Pick<SkillRow, 'id' | 'name' | 'displayName'>) {
    const folder = buildSkillDirectory(skill.id)
    super(
      `The files for skill "${skill.displayName || skill.name || skill.id}" are missing from ${folder}. ` +
        'Batshit did not replace them with an empty skill. Restore them from a backup that carries skill files, ' +
        'save the skill again with its text, or delete it.'
    )
    this.name = 'SkillFilesMissingError'
    this.skillId = skill.id
    this.folder = folder
  }
}

function buildSkillKey(userId: string, skillId: string) {
  return `skill:${userId}:${skillId}`
}

function buildSkillDirectory(skillId: string) {
  return path.join(SKILL_FILESYSTEM_ROOT, skillId)
}

function buildSkillMarkdownPath(skillId: string) {
  return path.join(buildSkillDirectory(skillId), 'SKILL.md')
}

function buildSkillMetadataPath(skillId: string) {
  return path.join(buildSkillDirectory(skillId), 'metadata.json')
}

function isRepoBackedSystemSkill(skill: Pick<SkillRow, 'is_system' | 'source'>) {
  return skill.is_system === true || skill.source === 'system'
}

function resolveSystemSkillSourceDir(skill: Pick<SkillRow, 'id' | 'name' | 'source_ref' | 'is_system' | 'source'>): string | null {
  if (!isRepoBackedSystemSkill(skill)) return null

  // The shipped identity owns built-in source binding, including older records
  // whose source_ref still points at a previous checkout or package version.
  for (const identity of [skill.id, skill.name]) {
    const builtin = resolveBuiltinSystemSkillDirectory(identity)
    if (builtin && (!['app-actions', APP_ACTIONS_SKILL_ID].includes(identity) || isCanonicalAppActionsSkill(skill))) return builtin
  }

  const sourceRef = normalizeString(skill.source_ref)
  if (sourceRef) {
    const resolved = path.resolve(sourceRef)
    const asDir = path.extname(resolved).toLowerCase() === '.md' ? path.dirname(resolved) : resolved
    if (existsSync(path.join(asDir, 'SKILL.md'))) {
      return asDir
    }
  }

  return null
}

function normalizeBoolean(value: unknown, defaultValue: boolean) {
  if (typeof value === 'boolean') return value
  return defaultValue
}

function normalizeString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined
  const trimmed = value.trim()
  return trimmed || undefined
}

function normalizeSkillNameFromSpec(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  return value || undefined
}

function toSpecLikeName(input: string): string {
  return sanitizeId(input).replace(/_/g, '-').replace(/^-+|-+$/g, '')
}

function toDisplayName(value: string): string {
  return value
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

export function normalizeSkillId(value: string | null | undefined, fallback: string) {
  const fromValue = sanitizeId((value ?? '').trim())
  if (fromValue) return fromValue
  const fromFallback = sanitizeId(fallback)
  return fromFallback || `skill_${Date.now()}`
}

function normalizeDependencies(input: unknown): SkillDependencyRequirement[] {
  const entries: unknown[] =
    Array.isArray(input)
      ? input
      : typeof input === 'string'
        ? input
            .split(',')
            .map((value) => value.trim())
            .filter(Boolean)
        : []

  const seen = new Set<string>()
  const normalized: SkillDependencyRequirement[] = []

  for (const entry of entries) {
    if (typeof entry === 'string') {
      const id = sanitizeId(entry.trim())
      if (!id || seen.has(id)) continue
      seen.add(id)
      normalized.push({
        id,
        label: INTEGRATION_LABELS[id],
        required: true
      })
      continue
    }

    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const id = sanitizeId(String(raw.id ?? '').trim())
    if (!id || seen.has(id)) continue

    seen.add(id)
    normalized.push({
      id,
      label: typeof raw.label === 'string' && raw.label.trim() ? raw.label.trim() : INTEGRATION_LABELS[id],
      required: normalizeBoolean(raw.required, true)
    })
  }

  return normalized
}

function normalizeMetadataMap(input: unknown): Record<string, string> {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return {}
  const output: Record<string, string> = {}
  for (const [key, value] of Object.entries(input)) {
    const normalizedKey = key.trim()
    if (!normalizedKey) continue
    const normalizedValue = String(value ?? '').trim()
    if (!normalizedValue) continue
    output[normalizedKey] = normalizedValue
  }
  return output
}

function normalizeCompatibility(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const trimmed = input.trim()
  if (!trimmed) return undefined
  return trimmed.slice(0, MAX_COMPATIBILITY_LENGTH)
}

function hashSha256(value: string | Buffer): string {
  return createHash('sha256').update(value).digest('hex')
}

function normalizeBundleFileKind(value: unknown): SkillBundleFileKind | null {
  if (value === 'script' || value === 'reference' || value === 'asset') return value
  return null
}

function normalizeBundlePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function normalizeBundleFiles(input: unknown): SkillBundleFile[] {
  if (!Array.isArray(input)) return []

  const normalized: SkillBundleFile[] = []
  const seen = new Set<string>()

  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const bundlePath = normalizeBundlePath(String(raw.path ?? '').trim())
    if (!bundlePath) continue
    if (bundlePath.includes('..')) continue
    if (seen.has(bundlePath)) continue

    const kind = normalizeBundleFileKind(raw.kind)
    if (!kind) continue

    const encoding = raw.encoding === 'base64' ? 'base64' : 'utf8'
    const content = typeof raw.content === 'string' ? raw.content : ''
    const size =
      typeof raw.size === 'number' && Number.isFinite(raw.size) && raw.size >= 0
        ? Math.floor(raw.size)
        : Buffer.byteLength(content, encoding === 'base64' ? 'base64' : 'utf8')
    const sha256 = typeof raw.sha256 === 'string' && raw.sha256.trim() ? raw.sha256.trim() : hashSha256(content)

    normalized.push({
      path: bundlePath,
      kind,
      encoding,
      content,
      sha256,
      size
    })
    seen.add(bundlePath)
  }

  normalized.sort((a, b) => a.path.localeCompare(b.path))
  return normalized
}

function buildBundleManifest(bundleFiles: SkillBundleFile[]): SkillBundleManifest | undefined {
  if (bundleFiles.length === 0) return undefined

  const scriptCount = bundleFiles.filter((file) => file.kind === 'script').length
  const referenceCount = bundleFiles.filter((file) => file.kind === 'reference').length
  const assetCount = bundleFiles.filter((file) => file.kind === 'asset').length
  const checksumSeed = bundleFiles.map((file) => `${file.path}:${file.sha256}`).join('|')

  return {
    version: 1,
    checksum: hashSha256(checksumSeed),
    file_count: bundleFiles.length,
    script_count: scriptCount,
    reference_count: referenceCount,
    asset_count: assetCount,
    generated_at: new Date().toISOString()
  }
}

async function pathExists(targetPath: string): Promise<boolean> {
  try {
    await fs.access(targetPath)
    return true
  } catch {
    return false
  }
}

function extractHeading(body: string): string {
  const match = body.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : ''
}

function extractDescription(body: string): string {
  const paragraphs = body
    .split(/\n\s*\n/)
    .map((paragraph) => paragraph.trim())
    .filter((paragraph) => paragraph.length > 0)

  for (const paragraph of paragraphs) {
    if (paragraph.startsWith('#')) continue
    if (paragraph.startsWith('```')) continue
    if (paragraph.startsWith('- ') || paragraph.startsWith('* ')) continue
    if (paragraph.startsWith('>')) continue
    return paragraph.replace(/\s+/g, ' ').trim()
  }

  return ''
}

function parseSkillMarkdownMetadata(markdown: string): ParsedSkillMarkdownMetadata {
  const { frontmatter, body } = splitFrontmatter(markdown)

  const standardsIssues: string[] = []

  const requestedName = normalizeSkillNameFromSpec(frontmatter.name)
  let canonicalName = requestedName
  if (!requestedName) {
    standardsIssues.push('Frontmatter "name" is missing. Imported as degraded compatibility.')
  } else if (!VALID_SKILL_NAME_PATTERN.test(requestedName)) {
    canonicalName = toSpecLikeName(requestedName)
    standardsIssues.push('Frontmatter "name" is outside Agent Skills spec format.')
  }

  // Parse metadata early so custom fields stored inside it can serve as fallbacks
  const metadata = normalizeMetadataMap(frontmatter.metadata)
  if (frontmatter.metadata && Object.keys(metadata).length === 0) {
    standardsIssues.push('Frontmatter "metadata" is present but invalid. Expected key/value object.')
  }

  const heading = extractHeading(body)
  const displayName = normalizeString(frontmatter.displayName) || normalizeString(metadata.displayName) || heading || (canonicalName ? toDisplayName(canonicalName) : undefined)

  const frontmatterDescription = normalizeString(frontmatter.description)
  let description = frontmatterDescription || extractDescription(body) || undefined
  if (!frontmatterDescription) {
    standardsIssues.push('Frontmatter "description" is missing. Imported as degraded compatibility.')
  }
  if (description && description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH)
    standardsIssues.push(`Description exceeded ${MAX_DESCRIPTION_LENGTH} chars and was truncated.`)
  }

  const dependencies = normalizeDependencies(
    frontmatter.dependencies ?? frontmatter.integrations ?? frontmatter.requires ?? metadata.dependencies
  )
  const license = normalizeString(frontmatter.license)
  const compatibility = normalizeCompatibility(frontmatter.compatibility)
  if (typeof frontmatter.compatibility === 'string' && frontmatter.compatibility.trim().length > MAX_COMPATIBILITY_LENGTH) {
    standardsIssues.push(`Compatibility text exceeded ${MAX_COMPATIBILITY_LENGTH} chars and was truncated.`)
  }

  const allowedTools = normalizeAllowedTools(
    frontmatter['allowed-tools'] ?? frontmatter.allowed_tools ?? frontmatter.allowedTools ?? metadata.allowedTools
  )

  const trustLevel =
    frontmatter.trust === 'trusted' || frontmatter.trust_level === 'trusted' || metadata.trust === 'trusted' ? 'trusted' : undefined

  const hasScripts = frontmatter.has_scripts === true || frontmatter.hasScripts === true
  const hasReferences = frontmatter.has_references === true || frontmatter.hasReferences === true
  const hasAssets = frontmatter.has_assets === true || frontmatter.hasAssets === true

  return {
    name: canonicalName || undefined,
    displayName,
    description,
    dependencies,
    license,
    compatibility,
    metadata,
    allowedTools,
    standardsStatus: standardsIssues.length > 0 ? 'degraded' : 'full',
    standardsIssues,
    trustLevel,
    hasScripts,
    hasReferences,
    hasAssets
  }
}

function toPosixPath(value: string): string {
  return value.split(path.sep).join(path.posix.sep)
}

function isLikelyBinary(filePath: string, buffer: Buffer): boolean {
  const extension = path.extname(filePath).toLowerCase()
  if (BINARY_EXTENSIONS.has(extension)) return true

  const sample = buffer.subarray(0, 2048)
  for (const byte of sample) {
    if (byte === 0) return true
  }
  return false
}

async function collectFilesRecursive(rootDir: string, currentDir = rootDir): Promise<string[]> {
  const entries = await fs.readdir(currentDir, { withFileTypes: true })
  const files: string[] = []

  for (const entry of entries) {
    if (entry.name.startsWith('.')) continue
    const fullPath = path.join(currentDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...(await collectFilesRecursive(rootDir, fullPath)))
      continue
    }
    if (!entry.isFile()) continue
    files.push(path.relative(rootDir, fullPath))
  }

  return files
}

async function collectBundleFiles(skillDir: string): Promise<SkillBundleFile[]> {
  const bundleDirs: Array<{ dirName: string; kind: SkillBundleFileKind }> = [
    { dirName: 'scripts', kind: 'script' },
    { dirName: 'references', kind: 'reference' },
    { dirName: 'assets', kind: 'asset' }
  ]

  const bundleFiles: SkillBundleFile[] = []

  for (const bundleDir of bundleDirs) {
    const fullDir = path.join(skillDir, bundleDir.dirName)
    if (!(await pathExists(fullDir))) continue
    const relativeFiles = await collectFilesRecursive(fullDir)

    for (const relativeFile of relativeFiles) {
      const absoluteFile = path.join(fullDir, relativeFile)
      const buffer = await fs.readFile(absoluteFile)
      const binary = isLikelyBinary(absoluteFile, buffer)
      const encoding = binary ? 'base64' : 'utf8'
      const content = binary ? buffer.toString('base64') : buffer.toString('utf8')
      bundleFiles.push({
        path: toPosixPath(path.join(bundleDir.dirName, relativeFile)),
        kind: bundleDir.kind,
        encoding,
        content,
        sha256: hashSha256(content),
        size: buffer.byteLength
      })
    }
  }

  bundleFiles.sort((a, b) => a.path.localeCompare(b.path))
  return bundleFiles
}

async function readSkillFilesystemSnapshotFromDir(skillDir: string): Promise<SkillFilesystemSnapshot | null> {
  const markdownPath = path.join(skillDir, 'SKILL.md')
  if (!(await pathExists(markdownPath))) {
    return null
  }

  const markdown = await fs.readFile(markdownPath, 'utf8')
  const parsed = parseSkillMarkdownMetadata(markdown)
  const bundleFiles = await collectBundleFiles(skillDir)
  const bundleManifest = buildBundleManifest(bundleFiles)

  const hasScripts = parsed.hasScripts || bundleFiles.some((file) => file.kind === 'script')
  const hasReferences = parsed.hasReferences || bundleFiles.some((file) => file.kind === 'reference')
  const hasAssets = parsed.hasAssets || bundleFiles.some((file) => file.kind === 'asset')

  return {
    rootDir: skillDir,
    markdownPath,
    markdown,
    bundleFiles,
    bundleManifest,
    hasScripts,
    hasReferences,
    hasAssets,
    parsed
  }
}

async function readSkillFilesystemSnapshot(skillId: string): Promise<SkillFilesystemSnapshot | null> {
  return readSkillFilesystemSnapshotFromDir(buildSkillDirectory(skillId))
}

function buildDefaultSkillMarkdown(name: string | undefined, description: string | undefined): string {
  const heading = normalizeString(name) || 'Skill'
  const summary = normalizeString(description) || 'Add SKILL.md content for this skill.'
  return `# ${heading}\n\n${summary}\n`
}

async function writeSkillFilesystemContent(skillId: string, markdown: string, bundleFiles: SkillBundleFile[]): Promise<void> {
  const skillDir = buildSkillDirectory(skillId)
  await fs.mkdir(skillDir, { recursive: true })

  await fs.writeFile(buildSkillMarkdownPath(skillId), markdown, 'utf8')

  await Promise.all(
    ['scripts', 'references', 'assets'].map((folder) =>
      fs.rm(path.join(skillDir, folder), { recursive: true, force: true })
    )
  )

  for (const bundleFile of bundleFiles) {
    const targetPath = path.resolve(skillDir, bundleFile.path)
    if (!targetPath.startsWith(`${skillDir}${path.sep}`)) continue
    await fs.mkdir(path.dirname(targetPath), { recursive: true })
    const content =
      bundleFile.encoding === 'base64'
        ? Buffer.from(bundleFile.content, 'base64')
        : bundleFile.content
    await fs.writeFile(targetPath, content)
  }
}

async function writeSkillFilesystemMetadata(skill: SkillRow, snapshot: SkillFilesystemSnapshot): Promise<void> {
  if (isRepoBackedSystemSkill(skill)) {
    return
  }

  const metadata = {
    id: skill.id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    source: skill.source,
    sourceRef: skill.source_ref,
    trustLevel: skill.trust_level,
    dependencies: skill.dependencies ?? [],
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata ?? {},
    allowedTools: skill.allowed_tools ?? [],
    standardsStatus: skill.standards_status ?? 'degraded',
    standardsIssues: skill.standards_issues ?? [],
    hasScripts: skill.has_scripts ?? false,
    hasReferences: skill.has_references ?? false,
    hasAssets: skill.has_assets ?? false,
    bundleManifest: skill.bundle_manifest,
    bundleFileCount: snapshot.bundleFiles.length,
    updatedAt: skill.updated_at
  }

  await fs.mkdir(buildSkillDirectory(skill.id), { recursive: true })
  await fs.writeFile(buildSkillMetadataPath(skill.id), JSON.stringify(metadata, null, 2), 'utf8')
}

function hasLegacyRedisSkillContent(skill: SkillRow): boolean {
  if (typeof skill.skill_markdown === 'string' && skill.skill_markdown.trim().length > 0) {
    return true
  }
  return Array.isArray(skill.bundle_files) && skill.bundle_files.length > 0
}

function comparableSkillMetadata(skill: SkillRow) {
  return {
    id: skill.id,
    user_id: skill.user_id,
    name: skill.name,
    displayName: skill.displayName,
    description: skill.description,
    source: skill.source,
    source_ref: skill.source_ref,
    dependencies: skill.dependencies ?? [],
    license: skill.license,
    compatibility: skill.compatibility,
    metadata: skill.metadata ?? {},
    allowed_tools: skill.allowed_tools ?? [],
    standards_status: skill.standards_status,
    standards_issues: skill.standards_issues ?? [],
    trust_level: skill.trust_level,
    has_scripts: skill.has_scripts ?? false,
    has_references: skill.has_references ?? false,
    has_assets: skill.has_assets ?? false,
    bundle_manifest: skill.bundle_manifest,
    cache_path: skill.cache_path,
    is_system: skill.is_system ?? false,
    is_active: skill.is_active ?? true,
    created_at: skill.created_at
  }
}

function skillMetadataChanged(current: SkillRow, next: SkillRow): boolean {
  return JSON.stringify(comparableSkillMetadata(current)) !== JSON.stringify(comparableSkillMetadata(next))
}

function hydrateRuntimeSkillRow(stored: SkillRow, snapshot: SkillFilesystemSnapshot): SkillRow {
  return {
    ...stored,
    skill_markdown: snapshot.markdown,
    bundle_files: snapshot.bundleFiles
  }
}

function buildStoredSkillRecord(params: {
  userId: string
  commandId: string
  skillId: string
  existing: SkillRow | null
  skillInput?: UpsertSkillInput['skill']
  snapshot: SkillFilesystemSnapshot
  nowIso: string
}): SkillRow {
  const existing = params.existing
  const input = params.skillInput
  const parsed = params.snapshot.parsed

  const inputName = normalizeString(input?.name)
  const inputDisplayName = normalizeString(input?.displayName)
  const inputDescription = normalizeString(input?.description)
  const inputSourceRef = normalizeString(input?.sourceRef)

  const dependencies =
    input?.dependencies !== undefined
      ? normalizeDependencies(input.dependencies)
      : parsed.dependencies.length > 0
        ? parsed.dependencies
        : existing?.dependencies ?? []

  const metadata =
    input?.metadata !== undefined
      ? normalizeMetadataMap(input.metadata)
      : Object.keys(parsed.metadata).length > 0
        ? parsed.metadata
        : normalizeMetadataMap(existing?.metadata)

  const allowedTools =
    input?.allowedTools !== undefined
      ? normalizeAllowedTools(input.allowedTools)
      : parsed.allowedTools.length > 0
        ? parsed.allowedTools
        : normalizeAllowedTools(existing?.allowed_tools)

  const standardsIssues =
    input?.standardsIssues !== undefined
      ? input.standardsIssues.map((issue) => String(issue).trim()).filter(Boolean)
      : parsed.standardsIssues

  const standardsStatus =
    input?.standardsStatus ??
    parsed.standardsStatus ??
    existing?.standards_status ??
    (standardsIssues.length > 0 ? 'degraded' : 'full')

  const requestedHasScripts = input?.hasScripts
  const requestedHasReferences = input?.hasReferences
  const requestedHasAssets = input?.hasAssets

  const hasScripts =
    (typeof requestedHasScripts === 'boolean' ? requestedHasScripts : existing?.has_scripts === true) ||
    params.snapshot.hasScripts
  const hasReferences =
    (typeof requestedHasReferences === 'boolean' ? requestedHasReferences : existing?.has_references === true) ||
    params.snapshot.hasReferences
  const hasAssets =
    (typeof requestedHasAssets === 'boolean' ? requestedHasAssets : existing?.has_assets === true) ||
    params.snapshot.hasAssets

  const source = input?.source || existing?.source || 'custom'
  const builtinSource = (source === 'system' || input?.isSystem === true || existing?.is_system === true) &&
    (params.skillId !== APP_ACTIONS_SKILL_ID || isCanonicalAppActionsSkill({ id: params.skillId, user_id: params.userId,
      source, is_system: input?.isSystem ?? existing?.is_system, source_ref: inputSourceRef || existing?.source_ref }, params.userId))
    ? resolveBuiltinSystemSkillDirectory(params.skillId) || resolveBuiltinSystemSkillDirectory(inputName || existing?.name || '')
    : null

  const parsedName = normalizeString(parsed.name)
  const name = inputName || parsedName || existing?.name || params.commandId
  const displayName =
    inputDisplayName ||
    normalizeString(parsed.displayName) ||
    existing?.displayName ||
    toDisplayName(name)

  const description =
    inputDescription ||
    normalizeString(parsed.description) ||
    existing?.description ||
    'Imported skill definition.'

  const trustLevel =
    input?.trustLevel || existing?.trust_level || parsed.trustLevel || 'untrusted'

  const next: SkillRow = {
    id: params.skillId,
    user_id: params.userId,
    name,
    displayName,
    description,
    skill_markdown: '',
    source,
    source_ref:
      builtinSource || inputSourceRef ||
      existing?.source_ref ||
      (source === 'system' ? params.snapshot.rootDir : undefined),
    dependencies,
    license: normalizeString(input?.license) ?? normalizeString(parsed.license) ?? existing?.license,
    compatibility:
      normalizeCompatibility(input?.compatibility) ??
      normalizeCompatibility(parsed.compatibility) ??
      existing?.compatibility,
    metadata,
    allowed_tools: allowedTools,
    standards_status: standardsStatus,
    standards_issues: standardsIssues,
    trust_level: trustLevel,
    has_scripts: hasScripts,
    has_references: hasReferences,
    has_assets: hasAssets,
    bundle_manifest: params.snapshot.bundleManifest,
    bundle_files: [],
    cache_path: params.snapshot.markdownPath,
    is_system: normalizeBoolean(input?.isSystem, existing?.is_system ?? false),
    is_active: normalizeBoolean(input?.isActive, existing?.is_active ?? true),
    created_at: existing?.created_at || params.nowIso,
    updated_at: params.nowIso
  }

  return next
}

async function ensureSkillFilesystemSnapshot(
  skill: SkillRow,
  options?: { allowLegacyMaterialize?: boolean }
): Promise<SkillFilesystemSnapshot | null> {
  if (isRepoBackedSystemSkill(skill)) {
    const systemSkillDir = resolveSystemSkillSourceDir(skill)
    return systemSkillDir ? readSkillFilesystemSnapshotFromDir(systemSkillDir) : null
  }

  let snapshot = await readSkillFilesystemSnapshot(skill.id)
  if (snapshot) return snapshot

  const allowLegacyMaterialize = options?.allowLegacyMaterialize !== false
  if (allowLegacyMaterialize && hasLegacyRedisSkillContent(skill)) {
    const legacyMarkdown =
      typeof skill.skill_markdown === 'string' && skill.skill_markdown.trim().length > 0
        ? skill.skill_markdown
        : buildDefaultSkillMarkdown(skill.name, skill.description)
    const legacyBundleFiles = normalizeBundleFiles(skill.bundle_files)
    await writeSkillFilesystemContent(skill.id, legacyMarkdown, legacyBundleFiles)
    snapshot = await readSkillFilesystemSnapshot(skill.id)
    if (snapshot) return snapshot
  }

  // BL-369: no blank placeholder here. The callers decide: a user skill with no files is
  // reported (`SkillFilesMissingError`), never rewritten to match an empty folder.
  return snapshot
}

// One write, guarded by BOTH originally observed namespace owners. Settings replacement
// fencing alone does not order ordinary command saves against awaited filesystem work.
const APP_ACTIONS_SKILL_PUBLICATION_SCRIPT = `
-- BATSHIT_APP_ACTIONS_SKILL_PUBLICATION_V1
for index = 1, 2 do
  local kind = redis.call('TYPE', KEYS[index]).ok
  if kind ~= 'none' and kind ~= 'ReJSON-RL' then return 'CHANGED' end
  if (redis.call('JSON.GET', KEYS[index], '$') or '') ~= ARGV[index] then return 'CHANGED' end
end
local ok, value = pcall(cjson.decode, ARGV[3])
if not ok or type(value) ~= 'table' or value.id ~= 'app_actions' or type(value.user_id) ~= 'string' or
  KEYS[1] ~= 'skill:' .. value.user_id .. ':app_actions' or KEYS[2] ~= 'slash_command:' .. value.user_id .. ':app-actions' then return 'INVALID' end
local written = redis.pcall('JSON.SET', KEYS[1], '$', ARGV[3])
if type(written) == 'table' and written.ok == 'OK' then return 'APPLIED' end
return 'UNCONFIRMED'
`

async function persistMetadataOnlySkill(
  key: string,
  stored: SkillRow,
  snapshot: SkillFilesystemSnapshot,
  reserved?: { raw: string | null; commandRaw: string | null; commandKey: string; lifecycle: SettingsLifecycleSnapshot }
): Promise<void> {
  if (stored.id === APP_ACTIONS_SKILL_ID) {
    if (!reserved) throw new Error('The App Actions metadata publication has no original identity capture.')
    let issued = false
    let lease: ReturnType<typeof acquireSettingsMutation> | undefined
    try {
      const encoded = JSON.stringify(stored)
      const answer = await redis.execute(client => {
        lease = acquireSettingsMutation(reserved.lifecycle); lease.check(); issued = true
        return client.eval(APP_ACTIONS_SKILL_PUBLICATION_SCRIPT, { keys: [key, reserved.commandKey],
          arguments: [reserved.raw ?? '', reserved.commandRaw ?? '', encoded] })
      })
      if (!['APPLIED', 'CHANGED', 'INVALID'].includes(answer as string)) throw new Error('The namespace publication returned an unconfirmed outcome.')
      lease?.settle(); issued = false
      if (answer !== 'APPLIED') throw new Error('The saved App Actions skill or command identity changed. Metadata was not published; skill files were kept.')
    } catch (error) {
      if (issued) { lease?.unknown(); throw new Error('The App Actions skill metadata write is unconfirmed. Existing files were kept; reload before another write.') }
      lease?.settle(); throw error
    }
  } else await redis.json.set(key, '$', stored)
  await writeSkillFilesystemMetadata(stored, snapshot)
}

async function reservedAppActionsState(key: string, userId: string) {
  const commandKey = `slash_command:${userId}:${APP_ACTIONS_COMMAND_ID}`
  const lifecycle = captureSettingsLifecycle([key, commandKey])
  const raw = await redis.json.getRaw(key, '$')
  const commandRaw = await redis.json.getRaw(commandKey, '$')
  let command: Record<string, unknown> | null = null
  if (commandRaw !== null) {
    const values: unknown = JSON.parse(commandRaw)
    if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object' || Array.isArray(values[0])) throw new Error('The App Actions command identity is unreadable; nothing was published.')
    command = values[0] as Record<string, unknown>
  }
  let existing: SkillRow | null = null
  if (raw !== null) {
    const values: unknown = JSON.parse(raw)
    if (!Array.isArray(values) || values.length !== 1 || !values[0] || typeof values[0] !== 'object' || Array.isArray(values[0]) ||
        values[0].id !== APP_ACTIONS_SKILL_ID || values[0].user_id !== userId) throw new Error('The saved App Actions skill identity is unreadable; nothing was published.')
    existing = values[0] as SkillRow
  }
  assertSettingsLifecycle(lifecycle)
  return { existing, raw, lifecycle, command, commandRaw, commandKey }
}

async function refreshSkillRecordFromFilesystem(
  key: string,
  existing: SkillRow,
  options?: { allowLegacyMaterialize?: boolean; forcePersist?: boolean; nowIso?: string }
): Promise<SkillRow | null> {
  const reserved = existing.id === APP_ACTIONS_SKILL_ID ? await reservedAppActionsState(key, existing.user_id) : undefined
  if (reserved) {
    if (!reserved.existing) return null
    existing = reserved.existing
    if (reserved.command && isCanonicalAppActionsCommand(reserved.command, existing.user_id) !== isCanonicalAppActionsSkill(existing, existing.user_id)) {
      throw new Error('The saved App Actions command and skill have different owners. Their files and metadata were preserved.')
    }
  }
  const now = options?.nowIso ?? new Date().toISOString()
  const snapshot = await ensureSkillFilesystemSnapshot(existing, {
    allowLegacyMaterialize: options?.allowLegacyMaterialize
  })
  if (!snapshot) {
    // A built-in skill whose repo folder is gone reads as absent, as before. A user skill's
    // folder holds its only copy of its text: say so, and write nothing (BL-369).
    if (isRepoBackedSystemSkill(existing)) return null
    throw new SkillFilesMissingError(existing)
  }

  const nextStored = buildStoredSkillRecord({
    userId: existing.user_id,
    commandId: existing.name || existing.id,
    skillId: existing.id,
    existing,
    snapshot,
    nowIso: existing.updated_at || now
  })

  const changed = skillMetadataChanged(existing, nextStored)
  const hadLegacy = hasLegacyRedisSkillContent(existing)
  const shouldPersist = options?.forcePersist === true || changed || hadLegacy

  if (shouldPersist) {
    nextStored.updated_at = options?.nowIso ?? (changed || hadLegacy ? now : nextStored.updated_at)
    await persistMetadataOnlySkill(key, nextStored, snapshot, reserved)
  }

  return hydrateRuntimeSkillRow(nextStored, snapshot)
}

export async function writeSkillCache(skill: SkillRow): Promise<void> {
  if (isRepoBackedSystemSkill(skill)) {
    return
  }

  const markdown =
    typeof skill.skill_markdown === 'string' && skill.skill_markdown.trim().length > 0
      ? skill.skill_markdown
      : buildDefaultSkillMarkdown(skill.name, skill.description)
  const bundleFiles = normalizeBundleFiles(skill.bundle_files)

  await writeSkillFilesystemContent(skill.id, markdown, bundleFiles)

  const snapshot = await readSkillFilesystemSnapshot(skill.id)
  if (snapshot) {
    const metadataOnly = {
      ...skill,
      skill_markdown: '',
      bundle_files: [],
      bundle_manifest: snapshot.bundleManifest,
      has_scripts: skill.has_scripts === true || snapshot.hasScripts,
      has_references: skill.has_references === true || snapshot.hasReferences,
      has_assets: skill.has_assets === true || snapshot.hasAssets,
      cache_path: buildSkillMarkdownPath(skill.id)
    }
    await writeSkillFilesystemMetadata(metadataOnly, snapshot)
  }
}

export async function ensureSkillCache(skill: SkillRow): Promise<void> {
  if (isRepoBackedSystemSkill(skill)) {
    return
  }

  await refreshSkillRecordFromFilesystem(buildSkillKey(skill.user_id, skill.id), skill, {
    allowLegacyMaterialize: true,
    forcePersist: false
  })
}

/**
 * BL-75: whether a skill record exists, without the filesystem refresh `getSkill` runs. Used by
 * `sys.skill.save` to refuse a new or repointed command for a skill that already exists.
 */
export async function skillRecordExists(userId: string, skillId: string): Promise<boolean> {
  if (!skillId) return false
  return (await redis.json.get(buildSkillKey(userId, skillId))) != null
}

export async function getSkill(userId: string, skillId: string): Promise<SkillRow | null> {
  const key = buildSkillKey(userId, skillId)
  const skill = (await redis.json.get(key)) as SkillRow | null
  if (!skill) return null

  return refreshSkillRecordFromFilesystem(key, skill, {
    allowLegacyMaterialize: true,
    forcePersist: false
  })
}

export async function upsertSkill(input: UpsertSkillInput): Promise<SkillRow> {
  const now = input.nowIso ?? new Date().toISOString()
  const skillId = normalizeSkillId(input.skill.id, input.skill.name || input.commandId)
  const key = buildSkillKey(input.userId, skillId)
  const reserved = skillId === APP_ACTIONS_SKILL_ID ? await reservedAppActionsState(key, input.userId) : undefined
  const existing = reserved ? reserved.existing : (await redis.json.get(key)) as SkillRow | null
  if (input.builtinAppActionsSeed && (skillId !== APP_ACTIONS_SKILL_ID || input.commandId !== APP_ACTIONS_COMMAND_ID || input.skill.source !== 'system' || input.skill.isSystem !== true)) {
    throw new Error('Invalid canonical App Actions seed. No skill files or metadata were changed.')
  }
  if (reserved && existing && (input.builtinAppActionsSeed === true) !== isCanonicalAppActionsSkill(existing, input.userId)) {
    throw new Error('The App Actions skill ID is owned by another saved skill. Its files, metadata and access were preserved.')
  }
  if (reserved?.command && (input.builtinAppActionsSeed === true) !== isCanonicalAppActionsCommand(reserved.command, input.userId)) {
    throw new Error('The App Actions command ID is owned by another saved item. Its skill files, metadata and access were preserved.')
  }
  const nextSkillShape: Pick<SkillRow, 'id' | 'name' | 'source_ref' | 'is_system' | 'source'> = {
    id: skillId,
    name: input.skill.name || existing?.name || input.commandId,
    source_ref: input.skill.sourceRef || existing?.source_ref,
    is_system: normalizeBoolean(input.skill.isSystem, existing?.is_system ?? false),
    source: input.skill.source || existing?.source || 'custom'
  }

  const existingSnapshot = existing
    ? await ensureSkillFilesystemSnapshot(existing, {
        allowLegacyMaterialize: true
      })
    : null

  const markdownFromInput = typeof input.skill.markdown === 'string' ? input.skill.markdown : undefined
  // BL-369: a save of an existing user skill whose files are missing must bring its text;
  // otherwise it would write a blank placeholder over the skill.
  if (existing && !existingSnapshot && markdownFromInput === undefined && !isRepoBackedSystemSkill(nextSkillShape)) {
    throw new SkillFilesMissingError(existing)
  }
  let markdownToWrite =
    markdownFromInput ??
    existingSnapshot?.markdown ??
    (existing && typeof existing.skill_markdown === 'string' && existing.skill_markdown.trim().length > 0
      ? existing.skill_markdown
      : buildDefaultSkillMarkdown(input.skill.name || existing?.name, input.skill.description || existing?.description))

  if (!markdownToWrite.trim()) {
    markdownToWrite = buildDefaultSkillMarkdown(input.skill.name || existing?.name, input.skill.description || existing?.description)
  }

  const bundleFilesToWrite =
    input.skill.bundleFiles !== undefined
      ? normalizeBundleFiles(input.skill.bundleFiles)
      : existingSnapshot?.bundleFiles ?? normalizeBundleFiles(existing?.bundle_files)

  const snapshot =
    isRepoBackedSystemSkill(nextSkillShape)
      ? await ensureSkillFilesystemSnapshot(nextSkillShape as SkillRow, {
          allowLegacyMaterialize: false
        })
      : (await writeSkillFilesystemContent(skillId, markdownToWrite, bundleFilesToWrite),
        await readSkillFilesystemSnapshot(skillId))
  if (!snapshot) {
    throw new Error(`Failed to read canonical filesystem snapshot for skill '${skillId}'.`)
  }

  const stored = buildStoredSkillRecord({
    userId: input.userId,
    commandId: input.commandId,
    skillId,
    existing,
    skillInput: input.skill,
    snapshot,
    nowIso: now
  })

  if (input.builtinAppActionsSeed && existing && !skillMetadataChanged(existing, stored)) {
    return hydrateRuntimeSkillRow(existing, snapshot)
  }
  await persistMetadataOnlySkill(key, stored, snapshot, reserved)

  return hydrateRuntimeSkillRow(stored, snapshot)
}

function gatewayHasMatch(gateway: MCPGateway, patterns: RegExp[]) {
  const values: string[] = []
  values.push(gateway.name)
  values.push(gateway.slug ?? '')
  values.push(gateway.type)
  values.push(gateway.url ?? '')
  for (const toolName of gateway.discoveredTools ?? []) {
    values.push(toolName)
  }
  const blob = values.join(' ').toLowerCase()
  return patterns.some((pattern) => pattern.test(blob))
}

function resolveDependencyPatterns(dependencyId: string): RegExp[] {
  switch (dependencyId) {
    case 'n8n_mcp':
      return [/\bn8n\b/, /n8n_mcp/, /n8n-mcp/, /instance\s*mcp/]
    case 'huggingface':
      return [/hugging\s*face/, /huggingface/, /\bhf\b/]
    case 'comfyui':
      return [/comfy\s*ui/, /comfyui/]
    case 'browser':
      return [/browser/, /agent-browser/, /cloudflared/]
    case 'web_search':
      return [/web\s*search/, /search/]
    default:
      return [new RegExp(dependencyId.replace(/[-_]+/g, '[-_\\s]*'), 'i')]
  }
}

export async function evaluateSkillDependencies(
  userId: string,
  dependencies: SkillDependencyRequirement[] | undefined
): Promise<SkillDependencyCheckResult> {
  const normalized = normalizeDependencies(dependencies)
  if (normalized.length === 0) {
    return {
      allRequiredAvailable: true,
      statuses: []
    }
  }

  const gateways = await mcpGatewayService.list(userId).catch(() => [])
  const enabledGateways = gateways.filter((gateway) => gateway.enabled)

  const statuses: SkillDependencyStatus[] = []

  for (const dependency of normalized) {
    if (dependency.id === 'web_search') {
      statuses.push({
        id: dependency.id,
        label: dependency.label || INTEGRATION_LABELS[dependency.id] || dependency.id,
        required: dependency.required !== false,
        available: true,
        reason: 'Native web search is available in Batshit.'
      })
      continue
    }

    const patterns = resolveDependencyPatterns(dependency.id)
    const available = enabledGateways.some((gateway) => gatewayHasMatch(gateway, patterns))

    statuses.push({
      id: dependency.id,
      label: dependency.label || INTEGRATION_LABELS[dependency.id] || dependency.id,
      required: dependency.required !== false,
      available,
      reason: available
        ? 'Available through enabled MCP gateways.'
        : 'No enabled MCP gateway appears to provide this integration.'
    })
  }

  return {
    allRequiredAvailable: statuses.every((status) => !status.required || status.available),
    statuses
  }
}

export async function deleteSkill(userId: string, skillId: string): Promise<void> {
  const key = buildSkillKey(userId, skillId)
  const existing = (await redis.json.get(key)) as SkillRow | null

  await redis.del(key)
  if (existing && isRepoBackedSystemSkill(existing)) {
    return
  }

  await fs.rm(buildSkillDirectory(skillId), { recursive: true, force: true })
}

export async function deleteSkillIfOrphaned(
  userId: string,
  skillId: string,
  excludingCommandId?: string
): Promise<boolean> {
  const keys = await redis.keys(`slash_command:${userId}:*`)

  for (const key of keys) {
    const command = (await redis.json.get(key)) as SlashCommandRow | null
    if (!command) continue
    if (excludingCommandId && command.id === excludingCommandId) continue
    if (command.skill_id === skillId) {
      return false
    }
  }

  await deleteSkill(userId, skillId)
  return true
}

export function getSkillCacheRoot() {
  return SKILL_FILESYSTEM_ROOT
}

async function stripLegacySkillBundleFilesFromSlashCommands(originalLifecycle: SettingsLifecycleSnapshot, options?: { userId?: string | null }) {
  const userId = options?.userId?.trim()
  const pattern = userId ? `slash_command:${userId}:*` : 'slash_command:*:*'
  const keys = await redis.keys(pattern)
  if (keys.length === 0) return

  const preparations = new Map<string, SlashCommandWritePreparation>()
  for (const key of keys) {
    const match = /^slash_command:([A-Za-z0-9_-]+):([A-Za-z0-9_-]+)$/.exec(key)
    if (!match) throw new Error('Invalid saved command identity.')
    assertSettingsLifecycle(originalLifecycle)
    let preparation = preparations.get(match[1])
    if (!preparation) { preparation = beginSlashCommandWrite(match[1]); preparations.set(match[1], preparation) }
    const basis = await captureSlashCommandWriteBasis(preparation, [match[2]])
    const command = (await redis.json.get(key)) as SlashCommandRow | null
    if (!command || command.type !== 'skill') continue

    if (!Array.isArray(command.skill_bundle_files) || command.skill_bundle_files.length === 0) {
      continue
    }

    const next: SlashCommandRow = {
      ...command,
      skill_bundle_files: undefined,
      updated_at: new Date().toISOString()
    }

    await saveSlashCommandRecord(command.user_id, { record: next, mode: 'update', preserveAccess: COMMAND_ACCESS_FIELDS }, basis)
  }
}

export async function runSkillFilesystemMigrationPass(options?: { userId?: string | null }) {
  const originalLifecycle = captureSettingsLifecycle([])
  const userId = options?.userId?.trim()
  const pattern = userId ? `skill:${userId}:*` : 'skill:*:*'
  const keys = await redis.keys(pattern)
  let failed = 0

  for (const key of keys) {
    try {
      const skill = (await redis.json.get(key)) as SkillRow | null
      if (!skill) continue

      await refreshSkillRecordFromFilesystem(key, skill, {
        allowLegacyMaterialize: true,
        forcePersist: true
      })
    } catch (error) {
      failed += 1
      console.warn('[skillRegistry] Filesystem migration skipped invalid skill key', key, error)
    }
  }

  await stripLegacySkillBundleFilesFromSlashCommands(originalLifecycle, options)
  return { complete: failed === 0, failed }
}

export async function runSkillCacheIntegrityPass(options?: { userId?: string | null }) {
  await runSkillFilesystemMigrationPass(options)
}

async function cleanupSystemSkillRuntimeCopies(): Promise<void> {
  if (!existsSync(getBuiltinSystemSkillsRoot())) return
  // Keep the existing six reserved legacy names. Adding a new package member
  // must not delete a user's previously valid same-name custom skill folder.
  for (const entry of BUILTIN_PLUGIN_SKILLS.filter((skill) => skill.skillId !== 'goon_guide')) {
    const candidates = new Set<string>([
      entry.legacyDirectory,
      normalizeSkillId(entry.legacyDirectory, entry.legacyDirectory)
    ])

    for (const candidate of candidates) {
      if (!candidate.trim()) continue
      await fs.rm(path.join(SKILL_FILESYSTEM_ROOT, candidate), {
        recursive: true,
        force: true
      })
    }
  }
}

export function ensureSkillFilesystemStartup() {
  if (!startupFilesystemPassPromise) {
    startupFilesystemPassPromise = (async () => {
      await cleanupSystemSkillRuntimeCopies()
      return await runSkillFilesystemMigrationPass()
    })().catch((error) => {
      console.warn('[skillRegistry] Startup filesystem migration pass failed:', error)
      return { complete: false, failed: 1 }
    })
  }
  return startupFilesystemPassPromise
}

export function ensureSkillCacheIntegrityStartup() {
  return ensureSkillFilesystemStartup()
}
