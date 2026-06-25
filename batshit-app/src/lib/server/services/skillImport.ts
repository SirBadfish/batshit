import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { promisify } from 'node:util'

import type {
  SkillBundleFile,
  SkillBundleFileKind,
  SkillBundleManifest,
  SkillDependencyRequirement,
  SkillRow,
  SkillStandardsStatus
} from '$lib/types/database'
import { sanitizeId } from '$lib/utils/idSanitizer'
import {
  assertSafeRemoteImportUrl,
  guardedFetchText,
  SkillImportNetworkError
} from './skillImportNetworkGuard'
import {
  normalizeAllowedTools,
  splitFrontmatter
} from './skillFrontmatter'

const execFileAsync = promisify(execFile)

const SUPPORTED_SOURCE_TYPES = new Set(['github', 'url', 'git', 'local'])
const SUPPORTED_INSTALL_PACKAGES = new Set([
  'skills',
  '@vercel-labs/skills',
  '@vercel/skills',
  '@agent-skills/cli'
])
const DISALLOWED_SHELL_PATTERN = /(?:&&|\|\||;|`|\$\(|\n|\r|>|<)/
const REMOTE_FETCH_TIMEOUT_MS = 20_000
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

export type SkillImportSourceType = 'github' | 'url' | 'git' | 'local'

export interface ParsedInstallCommand {
  packageName: string
  source: string
  sourceType: SkillImportSourceType
  skillPath?: string
  originalCommand: string
}

export interface SkillImportInput {
  sourceType?: SkillImportSourceType
  source?: string
  skillPath?: string
  installCommand?: string
  trustLevel?: SkillRow['trust_level']
}

export interface ImportedSkillDefinition {
  id: string
  name: string
  displayName: string
  description: string
  markdown: string
  source: SkillRow['source']
  sourceRef?: string
  dependencies: SkillDependencyRequirement[]
  license?: string
  compatibility?: string
  metadata?: Record<string, string>
  allowedTools?: string[]
  standardsStatus: SkillStandardsStatus
  standardsIssues: string[]
  trustLevel: SkillRow['trust_level']
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
  bundleManifest?: SkillBundleManifest
  bundleFiles?: SkillBundleFile[]
}

export interface SkillImportResult {
  skill: ImportedSkillDefinition
  warnings: string[]
  parsedInstallCommand?: ParsedInstallCommand
}

class SkillImportError extends Error {
  status: number

  constructor(message: string, status = 400) {
    super(message)
    this.name = 'SkillImportError'
    this.status = status
  }
}

type SourceLoadResult = {
  markdown: string
  sourceRef: string
  sourceType: SkillImportSourceType
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
  bundleManifest?: SkillBundleManifest
  bundleFiles?: SkillBundleFile[]
  warnings: string[]
}

function expandHomePath(value: string) {
  if (!value.startsWith('~')) return value
  return path.join(os.homedir(), value.slice(1))
}

function parseArgumentTokens(raw: string): string[] {
  const tokens: string[] = []
  let current = ''
  let quote: '"' | '\'' | null = null
  let escape = false

  for (const char of raw) {
    if (escape) {
      current += char
      escape = false
      continue
    }

    if (char === '\\') {
      escape = true
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === '"' || char === '\'') {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ''
      }
      continue
    }

    current += char
  }

  if (current.length > 0) {
    tokens.push(current)
  }

  return tokens
}

function inferSourceType(source: string): SkillImportSourceType {
  const trimmed = source.trim()
  if (!trimmed) throw new SkillImportError('Source is required for skill import.')

  if (
    trimmed.startsWith('/') ||
    trimmed.startsWith('./') ||
    trimmed.startsWith('../') ||
    trimmed.startsWith('~')
  ) {
    return 'local'
  }

  if (trimmed.startsWith('git@') || trimmed.startsWith('ssh://') || trimmed.endsWith('.git')) {
    return 'git'
  }

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.+)?$/.test(trimmed)) {
    return 'github'
  }

  try {
    const url = new URL(trimmed)
    if (url.hostname.toLowerCase() === 'github.com' || url.hostname.toLowerCase() === 'raw.githubusercontent.com') {
      return 'github'
    }
    if (trimmed.endsWith('.git')) return 'git'
    return 'url'
  } catch {
    throw new SkillImportError(
      'Could not determine source type. Use a valid local path, git URL, GitHub shorthand/URL, or direct URL.'
    )
  }
}

export function parseAllowlistedInstallCommand(command: string): ParsedInstallCommand {
  const trimmed = command.trim()
  if (!trimmed) {
    throw new SkillImportError('Install command is required.')
  }

  if (DISALLOWED_SHELL_PATTERN.test(trimmed)) {
    throw new SkillImportError(
      'Unsupported install command: chained/shell operators are blocked. Paste a single "skills add ..." command only.'
    )
  }

  const tokens = parseArgumentTokens(trimmed)
  if (tokens.length < 2) {
    throw new SkillImportError('Install command is incomplete. Expected "npx skills add <source> ...".')
  }

  let cursor = 0
  if (tokens[cursor] === 'npx') {
    cursor += 1
    while (cursor < tokens.length && tokens[cursor].startsWith('-')) {
      const flag = tokens[cursor]
      if (flag === '-y' || flag === '--yes') {
        cursor += 1
        continue
      }
      throw new SkillImportError(`Unsupported npx flag "${flag}".`)
    }
  }

  const packageName = tokens[cursor]
  if (!packageName || !SUPPORTED_INSTALL_PACKAGES.has(packageName)) {
    throw new SkillImportError(
      'Unsupported installer package. Allowed packages: skills, @vercel-labs/skills, @vercel/skills, @agent-skills/cli.'
    )
  }
  cursor += 1

  const action = tokens[cursor]
  if (action !== 'add') {
    throw new SkillImportError('Unsupported install verb. Only "add" is allowed.')
  }
  cursor += 1

  const source = tokens[cursor]
  if (!source) {
    throw new SkillImportError('Install command is missing a source value.')
  }
  cursor += 1

  let skillPath: string | undefined

  while (cursor < tokens.length) {
    const token = tokens[cursor]
    if (!token.startsWith('--')) {
      throw new SkillImportError(`Unexpected argument "${token}". Only allowlisted flags are supported.`)
    }

    if (token === '--skill') {
      const value = tokens[cursor + 1]
      if (!value || value.startsWith('--')) {
        throw new SkillImportError('Flag "--skill" requires a value.')
      }
      skillPath = value
      cursor += 2
      continue
    }

    if (token.startsWith('--skill=')) {
      skillPath = token.slice('--skill='.length)
      cursor += 1
      continue
    }

    throw new SkillImportError(`Unsupported flag "${token}".`)
  }

  return {
    packageName,
    source,
    sourceType: inferSourceType(source),
    skillPath,
    originalCommand: trimmed
  }
}

function normalizeDependencies(input: unknown): SkillDependencyRequirement[] {
  const raw =
    Array.isArray(input)
      ? input
      : typeof input === 'string'
        ? input.split(',').map((value) => value.trim()).filter(Boolean)
        : []

  const seen = new Set<string>()
  const dependencies: SkillDependencyRequirement[] = []

  for (const entry of raw) {
    const candidate = typeof entry === 'string' ? entry : String(entry ?? '')
    const id = sanitizeId(candidate.trim())
    if (!id || seen.has(id)) continue
    seen.add(id)
    dependencies.push({ id, required: true })
  }

  return dependencies
}

function normalizeMetadata(input: unknown): Record<string, string> {
  const output: Record<string, string> = {}
  if (!input || typeof input !== 'object' || Array.isArray(input)) return output

  for (const [rawKey, rawValue] of Object.entries(input)) {
    const key = rawKey.trim()
    if (!key) continue
    const value = String(rawValue ?? '').trim()
    if (!value) continue
    output[key] = value
  }

  return output
}

function normalizeLicense(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  return value || undefined
}

function normalizeCompatibility(input: unknown): string | undefined {
  if (typeof input !== 'string') return undefined
  const value = input.trim()
  if (!value) return undefined
  return value.slice(0, MAX_COMPATIBILITY_LENGTH)
}

function toDisplayName(name: string) {
  return name
    .split(/[-_]+/)
    .filter(Boolean)
    .map((part) => part.charAt(0).toUpperCase() + part.slice(1))
    .join(' ')
}

function normalizeSpecSkillName(input: unknown): string {
  if (typeof input !== 'string') return ''
  return input.trim()
}

function toSpecLikeName(input: string): string {
  return sanitizeId(input).replace(/_/g, '-').replace(/^-+|-+$/g, '')
}

function extractHeading(body: string) {
  const match = body.match(/^#\s+(.+)$/m)
  return match ? match[1].trim() : ''
}

function extractDescription(body: string) {
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

async function exists(filePath: string) {
  try {
    await fs.access(filePath)
    return true
  } catch {
    return false
  }
}

async function detectAssetFolders(skillRootDir: string) {
  const [hasScripts, hasReferences, hasAssets] = await Promise.all([
    exists(path.join(skillRootDir, 'scripts')),
    exists(path.join(skillRootDir, 'references')),
    exists(path.join(skillRootDir, 'assets'))
  ])
  return { hasScripts, hasReferences, hasAssets }
}

function toPosixPath(value: string) {
  return value.split(path.sep).join(path.posix.sep)
}

function sha256(value: string | Buffer) {
  return createHash('sha256').update(value).digest('hex')
}

function isLikelyBinary(filePath: string, buffer: Buffer) {
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

async function collectBundleFiles(skillRootDir: string): Promise<SkillBundleFile[]> {
  const bundleDirs: Array<{ dirName: string; kind: SkillBundleFileKind }> = [
    { dirName: 'scripts', kind: 'script' },
    { dirName: 'references', kind: 'reference' },
    { dirName: 'assets', kind: 'asset' }
  ]

  const bundleFiles: SkillBundleFile[] = []

  for (const bundleDir of bundleDirs) {
    const fullDir = path.join(skillRootDir, bundleDir.dirName)
    if (!(await exists(fullDir))) continue
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
        sha256: sha256(content),
        size: buffer.byteLength
      })
    }
  }

  bundleFiles.sort((a, b) => a.path.localeCompare(b.path))
  return bundleFiles
}

function buildBundleManifest(bundleFiles: SkillBundleFile[]): SkillBundleManifest | undefined {
  if (bundleFiles.length === 0) return undefined

  const scriptCount = bundleFiles.filter((file) => file.kind === 'script').length
  const referenceCount = bundleFiles.filter((file) => file.kind === 'reference').length
  const assetCount = bundleFiles.filter((file) => file.kind === 'asset').length
  const checksumSeed = bundleFiles.map((file) => `${file.path}:${file.sha256}`).join('|')

  return {
    version: 1,
    checksum: sha256(checksumSeed),
    file_count: bundleFiles.length,
    script_count: scriptCount,
    reference_count: referenceCount,
    asset_count: assetCount,
    generated_at: new Date().toISOString()
  }
}

async function resolveSkillMarkdownPath(basePath: string, skillPath?: string) {
  const pathCandidates = buildSkillPathCandidates(skillPath)

  for (const relativePath of pathCandidates) {
    const candidateBase = relativePath ? path.resolve(basePath, relativePath) : basePath
    const stat = await fs.stat(candidateBase).catch(() => null)
    if (!stat) continue

    if (stat.isFile()) {
      if (!candidateBase.toLowerCase().endsWith('.md')) {
        throw new SkillImportError('Skill file imports must target a markdown file (SKILL.md).')
      }
      return { markdownPath: candidateBase, skillRootDir: path.dirname(candidateBase) }
    }

    const markdownPath = path.join(candidateBase, 'SKILL.md')
    if (await exists(markdownPath)) {
      return { markdownPath, skillRootDir: candidateBase }
    }
  }

  if (skillPath?.trim()) {
    throw new SkillImportError(`Could not find SKILL.md for skill path "${skillPath}" under: ${basePath}`)
  }

  throw new SkillImportError(`Skill path does not exist: ${basePath}`)
}

async function loadFromLocalSource(source: string, skillPath?: string): Promise<SourceLoadResult> {
  const resolvedSource = path.resolve(expandHomePath(source.trim()))
  const { markdownPath, skillRootDir } = await resolveSkillMarkdownPath(resolvedSource, skillPath)
  const markdown = await fs.readFile(markdownPath, 'utf8')
  const assets = await detectAssetFolders(skillRootDir)
  const bundleFiles = await collectBundleFiles(skillRootDir)
  const bundleManifest = buildBundleManifest(bundleFiles)

  return {
    markdown,
    sourceRef: skillPath ? `${resolvedSource}#${skillPath}` : resolvedSource,
    sourceType: 'local',
    hasScripts: assets.hasScripts || bundleFiles.some((file) => file.kind === 'script'),
    hasReferences: assets.hasReferences || bundleFiles.some((file) => file.kind === 'reference'),
    hasAssets: assets.hasAssets || bundleFiles.some((file) => file.kind === 'asset'),
    bundleManifest,
    bundleFiles,
    warnings: []
  }
}

function parseGithubLocation(source: string, skillPath?: string) {
  const trimmed = source.trim()

  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+(?:\/.+)?$/.test(trimmed)) {
    const parts = trimmed.split('/').filter(Boolean)
    const owner = parts[0]
    const repo = parts[1].replace(/\.git$/, '')
    const inferredPath = parts.slice(2).join('/')
    return {
      owner,
      repo,
      ref: null as string | null,
      path: skillPath || inferredPath || '',
      sourceRef: trimmed
    }
  }

  const parsed = new URL(trimmed)
  if (parsed.hostname === 'raw.githubusercontent.com') {
    const parts = parsed.pathname.split('/').filter(Boolean)
    if (parts.length < 3) {
      throw new SkillImportError('Invalid raw GitHub URL for skill import.')
    }
    const [owner, repo, ref, ...rest] = parts
    const rawPath = rest.join('/')
    return {
      owner,
      repo: repo.replace(/\.git$/, ''),
      ref,
      path: skillPath || rawPath,
      sourceRef: trimmed
    }
  }

  if (parsed.hostname !== 'github.com') {
    throw new SkillImportError('GitHub source must use github.com or raw.githubusercontent.com.')
  }

  const parts = parsed.pathname.split('/').filter(Boolean)
  if (parts.length < 2) {
    throw new SkillImportError('GitHub source must include owner/repo.')
  }

  const owner = parts[0]
  const repo = parts[1].replace(/\.git$/, '')
  let ref: string | null = null
  let pathFromUrl = ''

  if (parts.length >= 5 && (parts[2] === 'tree' || parts[2] === 'blob')) {
    ref = parts[3]
    pathFromUrl = parts.slice(4).join('/')
  }

  return {
    owner,
    repo,
    ref,
    path: skillPath || pathFromUrl || '',
    sourceRef: trimmed
  }
}

function buildGithubRawPath(rawPath: string) {
  const trimmed = rawPath.trim().replace(/^\/+|\/+$/g, '')
  if (!trimmed) return 'SKILL.md'
  if (trimmed.toLowerCase().endsWith('.md')) return trimmed
  return `${trimmed}/SKILL.md`
}

function normalizeSkillPath(rawPath?: string) {
  return (rawPath ?? '').trim().replace(/^\/+|\/+$/g, '')
}

function buildSkillPathCandidates(rawPath?: string) {
  const normalized = normalizeSkillPath(rawPath)
  if (!normalized) return ['']

  const candidates = [normalized]
  if (!normalized.toLowerCase().startsWith('skills/')) {
    candidates.push(`skills/${normalized}`)
  }
  return candidates
}

function appendPathToUrl(base: URL, appendedPath: string) {
  const normalized = normalizeSkillPath(appendedPath)
  if (!normalized) return base.toString()

  const next = new URL(base.toString())
  const directoryPath = next.pathname.endsWith('/')
    ? next.pathname
    : next.pathname.toLowerCase().endsWith('.md')
      ? `${path.posix.dirname(next.pathname)}/`
      : `${next.pathname}/`

  next.pathname = `${directoryPath}${normalized}`
  return next.toString()
}

async function fetchText(url: string): Promise<{ text: string; contentType: string } | null> {
  // Guarded fetch (G-0232): https-only, public addresses only, redirect hops
  // re-validated, DNS re-checked at connect time. Blocked targets throw a
  // loud SkillImportNetworkError; ordinary misses return null so candidate
  // loops can continue.
  try {
    return await guardedFetchText(url, REMOTE_FETCH_TIMEOUT_MS)
  } catch (error) {
    if (error instanceof SkillImportNetworkError) {
      throw new SkillImportError(error.message)
    }
    return null
  }
}

function isLikelyHtmlDocument(text: string, contentType: string): boolean {
  const normalizedType = contentType.toLowerCase()
  if (normalizedType.includes('text/html')) return true

  const sample = text.trim().slice(0, 240).toLowerCase()
  if (sample.startsWith('<!doctype html') || sample.startsWith('<html')) return true
  if (sample.includes('<head') && sample.includes('<body')) return true
  return false
}

async function loadFromGithubSource(source: string, skillPath?: string): Promise<SourceLoadResult> {
  const location = parseGithubLocation(source, skillPath)
  const refs = location.ref ? [location.ref] : ['main', 'master']
  const pathCandidates = buildSkillPathCandidates(location.path)

  for (const ref of refs) {
    for (const candidatePath of pathCandidates) {
      const rawPath = buildGithubRawPath(candidatePath)
      const rawUrl = `https://raw.githubusercontent.com/${location.owner}/${location.repo}/${ref}/${rawPath}`
      const fetched = await fetchText(rawUrl)
      if (!fetched) continue
      const markdown = fetched.text

      return {
        markdown,
        sourceRef: location.sourceRef,
        sourceType: 'github',
        hasScripts: false,
        hasReferences: false,
        hasAssets: false,
        bundleManifest: undefined,
        bundleFiles: [],
        warnings: [
          'Imported from GitHub source. Review SKILL.md content before enabling broad usage.',
          'Remote GitHub import only ingests SKILL.md. Use local/git source for scripts/references/assets.'
        ]
      }
    }
  }

  throw new SkillImportError(
    `Could not fetch SKILL.md from GitHub source "${location.sourceRef}".`
  )
}

async function loadFromUrlSource(source: string, skillPath?: string): Promise<SourceLoadResult> {
  const parsed = new URL(source.trim())
  const candidateSet = new Set<string>()
  const sourceString = parsed.toString()
  const normalizedSkillPath = normalizeSkillPath(skillPath)

  if (normalizedSkillPath) {
    for (const candidatePath of buildSkillPathCandidates(normalizedSkillPath)) {
      const skillMarkdownPath = candidatePath.toLowerCase().endsWith('.md') ? candidatePath : `${candidatePath}/SKILL.md`
      candidateSet.add(appendPathToUrl(parsed, skillMarkdownPath))
    }
  }

  if (sourceString.toLowerCase().endsWith('.md')) {
    candidateSet.add(sourceString)
  } else {
    candidateSet.add(sourceString.endsWith('/') ? `${sourceString}SKILL.md` : `${sourceString}/SKILL.md`)
    candidateSet.add(sourceString)
  }

  const candidates = Array.from(candidateSet)
  let sawHtmlDocument = false

  for (const candidate of candidates) {
    const fetched = await fetchText(candidate)
    if (!fetched) continue
    if (isLikelyHtmlDocument(fetched.text, fetched.contentType)) {
      sawHtmlDocument = true
      continue
    }
    const markdown = fetched.text
    return {
      markdown,
      sourceRef: candidate,
      sourceType: 'url',
      hasScripts: false,
      hasReferences: false,
      hasAssets: false,
      bundleManifest: undefined,
      bundleFiles: [],
      warnings: [
        'Imported from remote URL. Verify source trust and any external references.',
        'URL imports only ingest SKILL.md. Use local/git source for scripts/references/assets.'
      ]
    }
  }

  if (sawHtmlDocument) {
    throw new SkillImportError(
      'URL import returned an HTML page, not a SKILL.md file. Use the install command flow or a direct raw SKILL.md URL.'
    )
  }

  throw new SkillImportError('Could not fetch SKILL.md from URL source.')
}

async function loadFromGitSource(source: string, skillPath?: string): Promise<SourceLoadResult> {
  const trimmedSource = source.trim()

  // Local repository paths carry local-import trust (same disk the local
  // source type reads). Everything else is a REMOTE git import and is
  // https-only against public hosts (G-0232) — for ssh/private-repo sources,
  // clone locally and import the local clone.
  const isLocalGitSource =
    trimmedSource.startsWith('/') ||
    trimmedSource.startsWith('./') ||
    trimmedSource.startsWith('../') ||
    trimmedSource.startsWith('~') ||
    trimmedSource.startsWith('file://')

  if (!isLocalGitSource) {
    try {
      await assertSafeRemoteImportUrl(trimmedSource, 'Git skill import')
    } catch (error) {
      if (error instanceof SkillImportNetworkError) {
        throw new SkillImportError(error.message)
      }
      throw error
    }
  }

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-skill-import-'))
  const repoDir = path.join(tempRoot, 'repo')
  try {
    await execFileAsync('git', ['clone', '--depth', '1', trimmedSource, repoDir], {
      timeout: 90_000,
      env: {
        ...process.env,
        // Hard protocol pin: a remote clone can never be redirected onto
        // file/ssh/ext transports; local clones only use the file transport.
        GIT_ALLOW_PROTOCOL: isLocalGitSource ? 'file' : 'https',
        GIT_TERMINAL_PROMPT: '0'
      }
    })

    const { markdownPath, skillRootDir } = await resolveSkillMarkdownPath(repoDir, skillPath)
    const markdown = await fs.readFile(markdownPath, 'utf8')
    const assets = await detectAssetFolders(skillRootDir)
    const bundleFiles = await collectBundleFiles(skillRootDir)
    const bundleManifest = buildBundleManifest(bundleFiles)

    return {
      markdown,
      sourceRef: skillPath ? `${source.trim()}#${skillPath}` : source.trim(),
      sourceType: 'git',
      hasScripts: assets.hasScripts || bundleFiles.some((file) => file.kind === 'script'),
      hasReferences: assets.hasReferences || bundleFiles.some((file) => file.kind === 'reference'),
      hasAssets: assets.hasAssets || bundleFiles.some((file) => file.kind === 'asset'),
      bundleManifest,
      bundleFiles,
      warnings: ['Imported from git URL. Review all skill content before enabling automation.']
    }
  } catch (error) {
    const details = (error as any)?.stderr?.toString?.().trim() || ''
    throw new SkillImportError(
      details ? `Git import failed: ${details}` : 'Git import failed. Verify repository URL and access.'
    )
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true })
  }
}

function deriveNameFromSource(sourceRef: string) {
  const fromBasename = path.basename(sourceRef).replace(/\.md$/i, '')
  return fromBasename && fromBasename !== 'SKILL' ? fromBasename : 'Imported Skill'
}

function deriveSkillDefinition(params: {
  markdown: string
  sourceRef: string
  sourceType: SkillImportSourceType
  trustLevel?: SkillRow['trust_level']
  hasScripts: boolean
  hasReferences: boolean
  hasAssets: boolean
  bundleManifest?: SkillBundleManifest
  bundleFiles?: SkillBundleFile[]
}) {
  const { frontmatter, body } = splitFrontmatter(params.markdown)
  const heading = extractHeading(body)
  const fallbackName = deriveNameFromSource(params.sourceRef)
  const standardsIssues: string[] = []

  const requestedName = normalizeSpecSkillName(frontmatter.name)
  let canonicalName = requestedName
  if (!requestedName) {
    canonicalName = toSpecLikeName(heading || fallbackName || 'imported-skill')
    standardsIssues.push('Frontmatter "name" is missing. Imported as degraded compatibility.')
  } else if (!VALID_SKILL_NAME_PATTERN.test(requestedName)) {
    canonicalName = toSpecLikeName(requestedName)
    standardsIssues.push(
      'Frontmatter "name" is outside Agent Skills spec format (lowercase alphanumeric + hyphens).'
    )
  }

  if (!canonicalName) {
    canonicalName = 'imported-skill'
  }

  const displayName =
    (typeof frontmatter.displayName === 'string' && frontmatter.displayName.trim()) ||
    heading ||
    toDisplayName(canonicalName) ||
    fallbackName

  const idSeed =
    (typeof frontmatter.id === 'string' && frontmatter.id.trim()) ||
    canonicalName ||
    displayName ||
    fallbackName
  const id = sanitizeId(idSeed) || `skill_${Date.now()}`

  const frontmatterDescription =
    typeof frontmatter.description === 'string' ? frontmatter.description.trim() : ''
  let description = frontmatterDescription || extractDescription(body) || 'Imported skill definition.'
  if (!frontmatterDescription) {
    standardsIssues.push('Frontmatter "description" is missing. Imported as degraded compatibility.')
  }
  if (description.length > MAX_DESCRIPTION_LENGTH) {
    description = description.slice(0, MAX_DESCRIPTION_LENGTH)
    standardsIssues.push(`Description exceeded ${MAX_DESCRIPTION_LENGTH} chars and was truncated.`)
  }

  const dependencies = normalizeDependencies(
    frontmatter.dependencies ?? frontmatter.integrations ?? frontmatter.requires
  )
  const license = normalizeLicense(frontmatter.license)
  const compatibility = normalizeCompatibility(frontmatter.compatibility)
  if (typeof frontmatter.compatibility === 'string' && frontmatter.compatibility.trim().length > MAX_COMPATIBILITY_LENGTH) {
    standardsIssues.push(`Compatibility text exceeded ${MAX_COMPATIBILITY_LENGTH} chars and was truncated.`)
  }
  const metadata = normalizeMetadata(frontmatter.metadata)
  if (frontmatter.metadata && Object.keys(metadata).length === 0) {
    standardsIssues.push('Frontmatter "metadata" is present but invalid. Expected key/value object.')
  }
  const allowedTools = normalizeAllowedTools(
    frontmatter['allowed-tools'] ?? frontmatter.allowed_tools ?? frontmatter.allowedTools
  )

  const frontmatterTrust =
    frontmatter.trust === 'trusted' || frontmatter.trust_level === 'trusted' ? 'trusted' : undefined

  const trustLevel = params.trustLevel || frontmatterTrust || 'untrusted'

  const hasScripts =
    params.hasScripts ||
    params.bundleFiles?.some((file) => file.kind === 'script') === true ||
    frontmatter.has_scripts === true ||
    frontmatter.hasScripts === true
  const hasReferences =
    params.hasReferences ||
    params.bundleFiles?.some((file) => file.kind === 'reference') === true ||
    frontmatter.has_references === true ||
    frontmatter.hasReferences === true
  const hasAssets =
    params.hasAssets ||
    params.bundleFiles?.some((file) => file.kind === 'asset') === true ||
    frontmatter.has_assets === true ||
    frontmatter.hasAssets === true
  const standardsStatus: SkillStandardsStatus = standardsIssues.length > 0 ? 'degraded' : 'full'

  return {
    id,
    name: canonicalName,
    displayName,
    description,
    markdown: params.markdown,
    source: params.sourceType,
    sourceRef: params.sourceRef,
    dependencies,
    license,
    compatibility,
    metadata,
    allowedTools,
    standardsStatus,
    standardsIssues,
    trustLevel,
    hasScripts,
    hasReferences,
    hasAssets,
    bundleManifest: params.bundleManifest,
    bundleFiles: params.bundleFiles ?? []
  } satisfies ImportedSkillDefinition
}

async function loadSkillSource(params: {
  sourceType: SkillImportSourceType
  source: string
  skillPath?: string
}): Promise<SourceLoadResult> {
  if (params.sourceType === 'local') {
    return loadFromLocalSource(params.source, params.skillPath)
  }
  if (params.sourceType === 'github') {
    return loadFromGithubSource(params.source, params.skillPath)
  }
  if (params.sourceType === 'git') {
    return loadFromGitSource(params.source, params.skillPath)
  }
  return loadFromUrlSource(params.source, params.skillPath)
}

function assertSourceType(value: unknown): SkillImportSourceType | undefined {
  if (typeof value !== 'string') return undefined
  const normalized = value.trim().toLowerCase()
  if (!SUPPORTED_SOURCE_TYPES.has(normalized)) return undefined
  return normalized as SkillImportSourceType
}

export async function importSkillDefinition(input: SkillImportInput): Promise<SkillImportResult> {
  const warnings: string[] = []
  let parsedInstallCommand: ParsedInstallCommand | undefined

  let source = input.source?.trim() || ''
  let skillPath = input.skillPath?.trim() || undefined
  let sourceType = assertSourceType(input.sourceType)

  if (input.installCommand && input.installCommand.trim()) {
    parsedInstallCommand = parseAllowlistedInstallCommand(input.installCommand)
    source = parsedInstallCommand.source
    skillPath = parsedInstallCommand.skillPath
    sourceType = parsedInstallCommand.sourceType
    warnings.push('Install command was parsed using the allowlisted importer (no shell execution).')
  }

  if (!source) {
    throw new SkillImportError('Source is required. Provide a source value or paste a supported install command.')
  }

  if (!sourceType) {
    sourceType = inferSourceType(source)
  }

  const loaded = await loadSkillSource({ sourceType, source, skillPath })
  warnings.push(...loaded.warnings)

  const skill = deriveSkillDefinition({
    markdown: loaded.markdown,
    sourceRef: loaded.sourceRef,
    sourceType: loaded.sourceType,
    trustLevel: input.trustLevel,
    hasScripts: loaded.hasScripts,
    hasReferences: loaded.hasReferences,
    hasAssets: loaded.hasAssets,
    bundleManifest: loaded.bundleManifest,
    bundleFiles: loaded.bundleFiles
  })

  if (skill.trustLevel !== 'trusted') {
    warnings.push('Imported skills default to untrusted. Review SKILL.md content before broad enablement.')
  }
  if (skill.hasScripts) {
    warnings.push('This imported skill includes scripts. Verify expected behavior before enabling.')
  }
  if (skill.hasReferences) {
    warnings.push('This imported skill references additional assets. Ensure required files are available.')
  }
  if (skill.hasAssets) {
    warnings.push('This imported skill includes assets/attachments. Verify files are expected and safe.')
  }
  if (skill.standardsStatus !== 'full') {
    warnings.push('This import is compatibility-degraded against Agent Skills spec.')
    for (const issue of skill.standardsIssues) {
      warnings.push(`Spec warning: ${issue}`)
    }
  }
  if (skill.bundleManifest) {
    warnings.push(
      `Bundle imported (${skill.bundleManifest.file_count} files: scripts=${skill.bundleManifest.script_count}, references=${skill.bundleManifest.reference_count}, assets=${skill.bundleManifest.asset_count}).`
    )
  }
  if (skill.sourceRef) {
    warnings.push(`Source reference: ${skill.sourceRef}`)
  }

  return {
    skill,
    warnings: Array.from(new Set(warnings)),
    parsedInstallCommand
  }
}

export function toImportErrorResponse(error: unknown) {
  if (error instanceof SkillImportError) {
    return { status: error.status, message: error.message }
  }
  return {
    status: 500,
    message: 'Skill import failed unexpectedly.'
  }
}
