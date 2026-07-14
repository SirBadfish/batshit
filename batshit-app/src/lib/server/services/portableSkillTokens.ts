import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { redis } from '$lib/server/redis'
import type {
  PortableSkillEnvTemplateInfo,
  PortableSkillFamilyId,
  PortableSkillTokenFamilyDefinition,
  PortableSkillTokenRecord,
  PortableSkillTokenSummary,
  PortableSkillTokenValidation
} from '$lib/types/portableSkills'

const TOKEN_SECRET_BYTES = 32
const TOKEN_ID_BYTES = 12
const MAX_LABEL_LENGTH = 80
const EXECUTION_LOG_LIMIT = 200
const TOKEN_PREFIX_LENGTH = 12
const TOKEN_SUFFIX_LENGTH = 6
const PORTABLE_SKILL_ENV_DIR = path.join(os.homedir(), '.batshit', 'portable-skills')

export const PORTABLE_SKILL_TOKEN_HEADER = 'x-batshit-portable-token'

export const PORTABLE_SKILL_FAMILIES: PortableSkillTokenFamilyDefinition[] = [
  {
    id: 'voice-engines',
    label: 'Voice Engines',
    description: 'Register, complete setup, manage models, health-check, enable, and delete local voice engines.',
    controlIds: [
      'sys.voice.engine.register',
      'sys.voice.engine.update',
      'sys.voice.engine.health_check',
      'sys.voice.engine.enable',
      'sys.voice.engine.delete',
      'sys.voice.engine.complete_local_setup',
      'sys.voice.engine.model.download',
      'sys.voice.engine.model.use',
      'sys.voice.engine.model.delete',
      'sys.runtime_addon.list',
      'sys.runtime_addon.status',
      'sys.runtime_addon.prepare',
      'sys.runtime_addon.start',
      'sys.runtime_addon.stop'
    ]
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    description: 'Create, validate, update, patch, publish, place, and inspect artifact run logs.',
    controlIds: [
      'sys.artifact.create',
      'sys.artifact.get',
      'sys.artifact.list',
      'sys.artifact.update',
      'sys.artifact.apply_patch',
      'sys.artifact.validate_structure',
      'sys.artifact.publish',
      'sys.artifact.add_version',
      'sys.artifact.delete_version',
      'sys.artifact.rollback',
      'sys.artifact.set_zone',
      'sys.artifact.set_webhook',
      'sys.artifact.analyze_url',
      'sys.artifact.check_requirements',
      'sys.artifact.run_logs.get',
      'sys.artifact.run_logs.list',
      'sys.model_catalog.search'
    ]
  },
  {
    id: 'cli-tools',
    label: 'CLI Tools',
    description: 'Create, inspect, update, archive, delete, and test user CLI tools.',
    controlIds: [
      'sys.cli_tool.create',
      'sys.cli_tool.get',
      'sys.cli_tool.list',
      'sys.cli_tool.update',
      'sys.cli_tool.delete',
      'sys.cli_tool.archive',
      'sys.cli_tool.test'
    ]
  },
  {
    id: 'skills',
    label: 'Skills',
    description: 'Save and import user-authored Batshit skills.',
    controlIds: ['sys.skill.save', 'sys.skill.import']
  },
  {
    id: 'goon-scenes',
    label: 'Goon Scenes',
    description:
      'Verify portable Goon Scene Creator access and retrieve current scene-planning capability guidance.',
    controlIds: ['sys.goon_scene.creator_info']
  }
]

const FAMILY_BY_ID = new Map(PORTABLE_SKILL_FAMILIES.map((family) => [family.id, family]))

const PORTABLE_SKILL_ENV_TEMPLATES: Array<{
  id: string
  kind: 'shared' | 'skill'
  skillId: string | null
  family: PortableSkillFamilyId | null
  label: string
}> = [
  {
    id: 'portable-skills',
    kind: 'shared',
    skillId: null,
    family: null,
    label: 'All Portable Skills'
  }
]

function buildTokenSetKey(userId: string) {
  return `portable_skill_tokens:${userId}`
}

function buildTokenRecordKey(userId: string, tokenId: string) {
  return `portable_skill_token:${userId}:${tokenId}`
}

function buildTokenHashIndexKey(tokenHash: string) {
  return `portable_skill_token_hash:${tokenHash}`
}

function buildExecutionLogKey(userId: string) {
  return `portable_skill_token_executions:${userId}`
}

function isContainerizedRuntime() {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

function buildPortableSkillEnvPlaceholder() {
  return [
    '# Batshit Portable Skill private token file',
    '# Keep this file on your machine. Do not put it inside a downloaded portable skill bundle.',
    '# Use one multi-scope token here for all Portable Skills, or create a per-skill',
    '# override file such as artifact-creator.env only when you want a narrower token.',
    'BATSHIT_BASE_URL=http://127.0.0.1:5620',
    'BATSHIT_PORTABLE_TOKEN=paste-your-portable-skill-token-here',
    ''
  ].join('\n')
}

function buildPortableSkillEnvPath(definition: (typeof PORTABLE_SKILL_ENV_TEMPLATES)[number]) {
  const fileName = definition.kind === 'shared' ? 'portable-skills.env' : `${definition.skillId}.env`
  return path.join(PORTABLE_SKILL_ENV_DIR, fileName)
}

function nowIso() {
  return new Date().toISOString()
}

function generateTokenId() {
  return `pst_${randomBytes(TOKEN_ID_BYTES).toString('base64url')}`
}

function generateTokenSecret() {
  return `bspt_${randomBytes(TOKEN_SECRET_BYTES).toString('base64url')}`
}

function hashToken(secret: string) {
  return createHash('sha256').update(secret, 'utf8').digest('hex')
}

function tokenHashMatches(expected: string, actual: string) {
  try {
    const expectedBuffer = Buffer.from(expected, 'hex')
    const actualBuffer = Buffer.from(actual, 'hex')
    if (expectedBuffer.length !== actualBuffer.length) return false
    return timingSafeEqual(expectedBuffer, actualBuffer)
  } catch {
    return false
  }
}

function normalizeLabel(value: unknown): string {
  if (typeof value !== 'string') return 'Portable Skill Token'
  const trimmed = value.trim().replace(/\s+/g, ' ')
  if (!trimmed) return 'Portable Skill Token'
  return trimmed.slice(0, MAX_LABEL_LENGTH)
}

export function normalizePortableSkillFamilies(value: unknown): PortableSkillFamilyId[] {
  if (!Array.isArray(value)) return []
  const normalized: PortableSkillFamilyId[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const id = item.trim() as PortableSkillFamilyId
    if (!FAMILY_BY_ID.has(id)) continue
    if (!normalized.includes(id)) normalized.push(id)
  }
  return normalized
}

function summarizeRecord(record: PortableSkillTokenRecord): PortableSkillTokenSummary {
  const { tokenHash: _tokenHash, ...summary } = record
  return summary
}

export function getPortableSkillFamilyDefinitions(): PortableSkillTokenFamilyDefinition[] {
  return PORTABLE_SKILL_FAMILIES.map((family) => ({
    ...family,
    controlIds: [...family.controlIds]
  }))
}

export function buildPortableSkillEnvSnippet(token: string, baseUrl = 'http://127.0.0.1:5620') {
  return [
    'BATSHIT_BASE_URL=' + baseUrl,
    'BATSHIT_PORTABLE_TOKEN=' + token,
    ''
  ].join('\n')
}

export async function ensurePortableSkillEnvTemplates(): Promise<PortableSkillEnvTemplateInfo[]> {
  const placeholder = buildPortableSkillEnvPlaceholder()
  const writable = !isContainerizedRuntime()

  if (writable) {
    await fs.mkdir(PORTABLE_SKILL_ENV_DIR, { recursive: true })
  }

  const templates: PortableSkillEnvTemplateInfo[] = []
  for (const definition of PORTABLE_SKILL_ENV_TEMPLATES) {
    const targetPath = buildPortableSkillEnvPath(definition)
    const displayPath = writable
      ? targetPath
      : definition.kind === 'shared'
        ? '~/.batshit/portable-skills/portable-skills.env'
        : `~/.batshit/portable-skills/${definition.skillId}.env`
    let exists = false
    let created = false

    if (writable) {
      try {
        await fs.access(targetPath)
        exists = true
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
        await fs.writeFile(targetPath, placeholder, { flag: 'wx' })
        exists = true
        created = true
      }
    }

    templates.push({
      ...definition,
      path: displayPath,
      placeholder,
      writable,
      exists,
      created
    })
  }

  return templates
}

export function getPortableSkillAllowedControlIds(families: PortableSkillFamilyId[]): string[] {
  const allowed = new Set<string>()
  for (const familyId of families) {
    const family = FAMILY_BY_ID.get(familyId)
    if (!family) continue
    for (const controlId of family.controlIds) {
      allowed.add(controlId)
    }
  }
  return Array.from(allowed).sort((left, right) => left.localeCompare(right))
}

export function getPortableSkillRequiredFamiliesForControl(controlId: string): PortableSkillFamilyId[] {
  const normalizedControlId = controlId.trim()
  if (!normalizedControlId) return []
  return PORTABLE_SKILL_FAMILIES
    .filter((family) => family.controlIds.includes(normalizedControlId))
    .map((family) => family.id)
}

export function isPortableSkillControlAllowed(
  controlId: string,
  families: PortableSkillFamilyId[]
): boolean {
  return getPortableSkillAllowedControlIds(families).includes(controlId.trim())
}

async function readTokenRecord(userId: string, tokenId: string): Promise<PortableSkillTokenRecord | null> {
  return await redis.execute(async (client: any) => {
    const value = await client.json.get(buildTokenRecordKey(userId, tokenId))
    if (!value || typeof value !== 'object') return null
    return value as PortableSkillTokenRecord
  })
}

export async function listPortableSkillTokens(userId: string): Promise<PortableSkillTokenSummary[]> {
  return await redis.execute(async (client: any) => {
    const tokenSetKey = buildTokenSetKey(userId)
    const ids = await client.sMembers(tokenSetKey)
    const records: PortableSkillTokenSummary[] = []
    for (const id of ids) {
      const value = await client.json.get(buildTokenRecordKey(userId, id))
      if (!value || typeof value !== 'object') {
        await client.sRem(tokenSetKey, id)
        continue
      }

      const record = value as PortableSkillTokenRecord
      if (record.revokedAt) {
        await client.sRem(tokenSetKey, id)
        continue
      }

      records.push(summarizeRecord(record))
    }
    return records.sort((left, right) => right.createdAt.localeCompare(left.createdAt))
  })
}

export async function createPortableSkillToken(options: {
  userId: string
  label?: unknown
  families?: unknown
}): Promise<{ token: string; record: PortableSkillTokenSummary }> {
  const families = normalizePortableSkillFamilies(options.families)
  if (families.length === 0) {
    throw Object.assign(new Error('Choose at least one Portable Skills capability family.'), {
      status: 400
    })
  }

  const secret = generateTokenSecret()
  const tokenHash = hashToken(secret)
  const createdAt = nowIso()
  const record: PortableSkillTokenRecord = {
    id: generateTokenId(),
    userId: options.userId,
    label: normalizeLabel(options.label),
    families,
    tokenHash,
    tokenPrefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
    tokenSuffix: secret.slice(-TOKEN_SUFFIX_LENGTH),
    createdAt,
    updatedAt: createdAt,
    lastUsedAt: null,
    revokedAt: null
  }

  await redis.execute(async (client: any) => {
    await client.json.set(buildTokenRecordKey(record.userId, record.id), '$', record)
    await client.sAdd(buildTokenSetKey(record.userId), record.id)
    await client.json.set(buildTokenHashIndexKey(tokenHash), '$', {
      userId: record.userId,
      tokenId: record.id
    })
  })

  return {
    token: secret,
    record: summarizeRecord(record)
  }
}

export async function updatePortableSkillToken(options: {
  userId: string
  tokenId: string
  label?: unknown
  families?: unknown
}): Promise<PortableSkillTokenSummary> {
  const record = await readTokenRecord(options.userId, options.tokenId)
  if (!record || record.revokedAt) {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }

  const nextFamilies =
    options.families === undefined
      ? record.families
      : normalizePortableSkillFamilies(options.families)
  if (nextFamilies.length === 0) {
    throw Object.assign(new Error('Choose at least one Portable Skills capability family.'), {
      status: 400
    })
  }

  const updated: PortableSkillTokenRecord = {
    ...record,
    label: options.label === undefined ? record.label : normalizeLabel(options.label),
    families: nextFamilies,
    updatedAt: nowIso()
  }

  await redis.execute(async (client: any) => {
    await client.json.set(buildTokenRecordKey(updated.userId, updated.id), '$', updated)
  })

  return summarizeRecord(updated)
}

export async function rotatePortableSkillToken(options: {
  userId: string
  tokenId: string
}): Promise<{ token: string; record: PortableSkillTokenSummary }> {
  const record = await readTokenRecord(options.userId, options.tokenId)
  if (!record || record.revokedAt) {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }

  const secret = generateTokenSecret()
  const tokenHash = hashToken(secret)
  const updated: PortableSkillTokenRecord = {
    ...record,
    tokenHash,
    tokenPrefix: secret.slice(0, TOKEN_PREFIX_LENGTH),
    tokenSuffix: secret.slice(-TOKEN_SUFFIX_LENGTH),
    updatedAt: nowIso()
  }

  await redis.execute(async (client: any) => {
    await client.del(buildTokenHashIndexKey(record.tokenHash))
    await client.json.set(buildTokenRecordKey(updated.userId, updated.id), '$', updated)
    await client.json.set(buildTokenHashIndexKey(tokenHash), '$', {
      userId: updated.userId,
      tokenId: updated.id
    })
  })

  return {
    token: secret,
    record: summarizeRecord(updated)
  }
}

export async function revokePortableSkillToken(options: {
  userId: string
  tokenId: string
}): Promise<PortableSkillTokenSummary> {
  const record = await readTokenRecord(options.userId, options.tokenId)
  if (!record || record.revokedAt) {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }

  const revokedAt = nowIso()
  const updated: PortableSkillTokenRecord = {
    ...record,
    revokedAt,
    updatedAt: revokedAt
  }

  await redis.execute(async (client: any) => {
    await client.del(buildTokenHashIndexKey(record.tokenHash))
    await client.json.set(buildTokenRecordKey(updated.userId, updated.id), '$', updated)
    await client.sRem(buildTokenSetKey(updated.userId), updated.id)
  })

  return summarizeRecord(updated)
}

export async function validatePortableSkillToken(secret: string | null): Promise<PortableSkillTokenValidation> {
  const normalizedSecret = secret?.trim()
  if (!normalizedSecret) return { valid: false, reason: 'missing' }

  const tokenHash = hashToken(normalizedSecret)

  return await redis.execute(async (client: any) => {
    const index = await client.json.get(buildTokenHashIndexKey(tokenHash))
    if (!index || typeof index !== 'object') return { valid: false, reason: 'invalid' }

    const { userId, tokenId } = index as { userId?: unknown; tokenId?: unknown }
    if (typeof userId !== 'string' || typeof tokenId !== 'string') {
      return { valid: false, reason: 'invalid' }
    }

    const record = await client.json.get(buildTokenRecordKey(userId, tokenId))
    if (!record || typeof record !== 'object') return { valid: false, reason: 'invalid' }

    const tokenRecord = record as PortableSkillTokenRecord
    if (tokenRecord.revokedAt) return { valid: false, reason: 'revoked' }
    if (!tokenHashMatches(tokenRecord.tokenHash, tokenHash)) {
      return { valid: false, reason: 'invalid' }
    }

    return {
      valid: true,
      userId: tokenRecord.userId,
      token: summarizeRecord(tokenRecord),
      allowedControlIds: getPortableSkillAllowedControlIds(tokenRecord.families)
    }
  })
}

export async function recordPortableSkillTokenControlExecution(options: {
  userId: string
  tokenId: string
  tokenLabel: string
  controlId: string
  success: boolean
  errorCode?: string | null
}): Promise<void> {
  const usedAt = nowIso()
  await redis.execute(async (client: any) => {
    const recordKey = buildTokenRecordKey(options.userId, options.tokenId)
    const record = await client.json.get(recordKey)
    if (record && typeof record === 'object') {
      await client.json.set(recordKey, '$', {
        ...(record as PortableSkillTokenRecord),
        lastUsedAt: usedAt,
        updatedAt: usedAt
      })
    }

    const logEntry = {
      timestamp: usedAt,
      userId: options.userId,
      tokenId: options.tokenId,
      tokenLabel: options.tokenLabel,
      controlId: options.controlId,
      success: options.success,
      errorCode: options.errorCode ?? null
    }
    const logKey = buildExecutionLogKey(options.userId)
    await client.lPush(logKey, JSON.stringify(logEntry))
    await client.lTrim(logKey, 0, EXECUTION_LOG_LIMIT - 1)
  })
}
