import os from 'node:os'
import path from 'node:path'

import type { SkillBundleFile, SkillRow } from '$lib/types/database'

import { evaluateSkillDependencies, getSkill } from './skillRegistry'

export interface SkillRuntimeForTool {
  skill: SkillRow
  cacheDir: string
  bundleFiles: SkillBundleFile[]
}

export type SkillRuntimeAction = 'invoke' | 'list' | 'read'

const MAX_SKILL_REFERENCE_CHARS = 50_000
const DEFAULT_SKILL_REFERENCE_CHARS = 12_000

function normalizeBundlePath(input: string): string {
  return input.replace(/\\/g, '/').replace(/^\/+/, '').replace(/\/+/g, '/')
}

function normalizeOptionalString(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function clampReferenceChars(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_SKILL_REFERENCE_CHARS
  }
  return Math.max(64, Math.min(MAX_SKILL_REFERENCE_CHARS, Math.floor(value)))
}

export function normalizeBundleFiles(input: unknown): SkillBundleFile[] {
  if (!Array.isArray(input)) return []

  const normalized: SkillBundleFile[] = []
  const seen = new Set<string>()
  for (const entry of input) {
    if (!entry || typeof entry !== 'object') continue
    const raw = entry as Record<string, unknown>
    const pathValue = normalizeBundlePath(String(raw.path ?? '').trim())
    if (!pathValue || pathValue.includes('..') || seen.has(pathValue)) continue
    const kind = raw.kind
    if (kind !== 'script' && kind !== 'reference' && kind !== 'asset') continue
    const encoding = raw.encoding === 'base64' ? 'base64' : 'utf8'
    const content = typeof raw.content === 'string' ? raw.content : ''
    const sha256 = typeof raw.sha256 === 'string' ? raw.sha256 : ''
    const size =
      typeof raw.size === 'number' && Number.isFinite(raw.size)
        ? Math.floor(raw.size)
        : Buffer.byteLength(content, encoding === 'base64' ? 'base64' : 'utf8')
    normalized.push({
      path: pathValue,
      kind,
      encoding,
      content,
      sha256,
      size
    })
    seen.add(pathValue)
  }

  normalized.sort((a, b) => a.path.localeCompare(b.path))
  return normalized
}

function resolveSkillCacheDir(skill: SkillRow): string {
  const cachePath = typeof skill.cache_path === 'string' ? skill.cache_path.trim() : ''
  if (cachePath.length > 0) {
    const parsed = path.parse(cachePath)
    if (parsed.ext.length > 0) return path.dirname(cachePath)
    return cachePath
  }
  return path.join(os.homedir(), '.batshit', 'skills', skill.id)
}

function decodeBundleFileText(
  file: SkillBundleFile,
  maxChars?: number
): { content: string; truncated: boolean; originalChars: number } {
  const decoded =
    file.encoding === 'base64'
      ? Buffer.from(file.content, 'base64').toString('utf8')
      : file.content
  const originalChars = decoded.length
  const safeMax =
    typeof maxChars === 'number' && Number.isFinite(maxChars)
      ? Math.max(64, Math.min(50_000, Math.floor(maxChars)))
      : 12_000
  if (decoded.length <= safeMax) {
    return {
      content: decoded,
      truncated: false,
      originalChars
    }
  }
  return {
    content: decoded.slice(0, safeMax),
    truncated: true,
    originalChars
  }
}

export async function resolveSkillRuntimeForTool(
  userId: string,
  skillId: string
): Promise<{ runtime: SkillRuntimeForTool; error: null } | { runtime: null; error: string }> {
  const skill = await getSkill(userId, skillId)
  if (!skill) {
    return {
      runtime: null,
      error: `Skill '${skillId}' was not found.`
    }
  }

  const bundleFiles = normalizeBundleFiles(skill.bundle_files)
  const cacheDir = resolveSkillCacheDir(skill)

  return {
    runtime: { skill, cacheDir, bundleFiles },
    error: null
  }
}

export function findBundleFileByPath(
  files: SkillBundleFile[],
  targetPath: string
): SkillBundleFile | null {
  const normalized = normalizeBundlePath(targetPath.trim())
  if (!normalized || normalized.includes('..')) return null
  return files.find((file) => normalizeBundlePath(file.path) === normalized) ?? null
}

export function readSkillBundleFileText(
  file: SkillBundleFile,
  maxChars?: number
): { content: string; truncated: boolean; originalChars: number } {
  return decodeBundleFileText(file, maxChars)
}

export function resolveBundleFileAbsolutePath(cacheDir: string, file: SkillBundleFile): string | null {
  const absolute = path.resolve(cacheDir, file.path)
  const allowedPrefix = `${path.resolve(cacheDir)}${path.sep}`
  if (!absolute.startsWith(allowedPrefix)) return null
  return absolute
}

function shellQuote(value: string): string {
  if (value.length === 0) return "''"
  return `'${value.replace(/'/g, `'\"'\"'`)}'`
}

export function buildSkillScriptCommand(scriptAbsolutePath: string, args: string[] = []): string {
  const sanitizedArgs = args
    .map((arg) => String(arg ?? ''))
    .map((arg) => arg.trim())
    .filter((arg) => arg.length > 0)
    .slice(0, 32)

  const quotedScript = shellQuote(scriptAbsolutePath)
  const quotedArgs = sanitizedArgs.map((arg) => shellQuote(arg)).join(' ')
  return quotedArgs.length > 0 ? `bash ${quotedScript} ${quotedArgs}` : `bash ${quotedScript}`
}

export async function executeSkillRuntimeAction(input: {
  userId: string
  skillId: string
  action?: SkillRuntimeAction
  path?: string
  maxChars?: number
}) {
  const action = input.action ?? 'list'
  const runtimeResult = await resolveSkillRuntimeForTool(input.userId, input.skillId)
  if (!runtimeResult.runtime) {
    return {
      success: false,
      action,
      error: runtimeResult.error
    }
  }

  const { skill, bundleFiles } = runtimeResult.runtime
  const references = bundleFiles.filter((file) => file.kind === 'reference')
  const referencePaths = references.map((file) => file.path)
  const hasSkillMd = typeof skill.skill_markdown === 'string' && skill.skill_markdown.trim().length > 0
  const allPaths = hasSkillMd ? ['SKILL.md', ...referencePaths] : referencePaths

  if (action === 'invoke') {
    const skillMarkdown = skill.skill_markdown?.trim() || ''
    const scripts = bundleFiles.filter((file) => file.kind === 'script').map((file) => file.path)

    const warnings: string[] = []
    if (skill.trust_level !== 'trusted') {
      warnings.push('This skill is marked untrusted. Review prompt/script content before enabling broad automation.')
    }
    if (skill.has_scripts) {
      warnings.push('This skill includes script assets. Verify source and expected behavior before running script actions.')
    }
    if (skill.has_assets) {
      warnings.push('This skill includes assets. Verify attached files before execution.')
    }
    if (skill.standards_status === 'degraded') {
      warnings.push('Skill import is standards-degraded. Review spec warnings before use.')
    }
    for (const issue of skill.standards_issues ?? []) {
      warnings.push(`Spec warning: ${issue}`)
    }

    let dependencyStatuses: Array<{
      id: string
      label: string
      required: boolean
      available: boolean
      reason?: string
    }> = []
    if (skill.dependencies && skill.dependencies.length > 0) {
      const depCheck = await evaluateSkillDependencies(input.userId, skill.dependencies)
      dependencyStatuses = depCheck.statuses
      const missingRequired = depCheck.statuses.filter((status) => status.required && !status.available)
      if (missingRequired.length > 0) {
        warnings.push(`Missing required integrations: ${missingRequired.map((entry) => entry.label).join(', ')}.`)
      }
    }

    return {
      success: true,
      action: 'invoke' as const,
      skill: {
        id: skill.id,
        name: skill.displayName || skill.name,
        description: skill.description || '',
        references: referencePaths,
        scripts
      },
      skillMarkdown,
      warnings,
      dependencyStatuses
    }
  }

  if (action === 'list') {
    return {
      success: true,
      action: 'list' as const,
      skillId: skill.id,
      skillName: skill.displayName || skill.name,
      totalReferences: allPaths.length,
      references: allPaths
    }
  }

  const targetPath = normalizeOptionalString(input.path)
  if (!targetPath) {
    return {
      success: false,
      action: 'read' as const,
      error: 'path is required when action is "read".',
      availableReferences: allPaths
    }
  }

  const isSkillMdRequest = targetPath.toLowerCase().replace(/^\/+/, '') === 'skill.md'
  if (isSkillMdRequest) {
    const skillMarkdown = skill.skill_markdown?.trim()
    if (!skillMarkdown) {
      return {
        success: false,
        action: 'read' as const,
        error: 'SKILL.md has no content. The skill may not be properly configured.',
        availableReferences: allPaths
      }
    }

    const maxChars = clampReferenceChars(input.maxChars)
    const truncated = skillMarkdown.length > maxChars
    return {
      success: true,
      action: 'read' as const,
      skillId: skill.id,
      skillName: skill.displayName || skill.name,
      path: 'SKILL.md',
      content: truncated ? skillMarkdown.slice(0, maxChars) : skillMarkdown,
      contentTruncated: truncated,
      originalChars: skillMarkdown.length,
      returnedChars: truncated ? maxChars : skillMarkdown.length
    }
  }

  const file = findBundleFileByPath(references, targetPath)
  if (!file) {
    return {
      success: false,
      action: 'read' as const,
      error: `Reference "${targetPath}" was not found in the skill bundle.`,
      availableReferences: allPaths
    }
  }

  const decoded = readSkillBundleFileText(file, clampReferenceChars(input.maxChars))
  return {
    success: true,
    action: 'read' as const,
    skillId: skill.id,
    skillName: skill.displayName || skill.name,
    path: file.path,
    content: decoded.content,
    contentTruncated: decoded.truncated,
    originalChars: decoded.originalChars,
    returnedChars: decoded.content.length
  }
}
