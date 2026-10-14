import { getBatshitHomeDir } from './batshitHome'
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { redis } from '$lib/server/redis'
import { buildPortableSkillEnvLines } from '$lib/utils/portableSkillEnv'
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
const PORTABLE_SKILL_ENV_DIR = path.join(getBatshitHomeDir(), 'portable-skills')

/**
 * BL-787: update, rotate, and revoke each used to read the whole record and write it back at
 * `$`. Two admin actions close together could undo each other -- an update inside a rotate's
 * window wrote the old hash back (both secrets stopped working); a rotate that read before a
 * revoke wrote `revokedAt: null` and a fresh hash index (the rotated secret worked after the
 * revoke and was not listed); an update that read before a revoke reset `revokedAt`. BL-552's
 * class, on the admin writers themselves.
 *
 * Fix: one atomic Lua script per writer. Each re-reads the record's OWN current state (never a
 * value the caller read earlier) and refuses -- MISSING or REVOKED, never a partial write -- if
 * the record is gone or already revoked; otherwise it writes only the fields it owns, by path,
 * and keeps the hash index consistent with whatever `tokenHash` is actually stored at that
 * instant (never a hash the caller computed from a stale read). Redis runs a script as one
 * atomic step, so no other command can interleave between the check and the write.
 */
const UPDATE_PORTABLE_SKILL_TOKEN_SCRIPT = `
-- BATSHIT_PORTABLE_SKILL_TOKEN_UPDATE_V1
-- KEYS[1] = record key
-- ARGV[1] = updatedAt; ARGV[2] = '1'/'0' set label; ARGV[3] = label JSON;
-- ARGV[4] = '1'/'0' set families; ARGV[5] = families JSON array
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.revokedAt')[1] ~= 'null' then
  return 'REVOKED'
end
if ARGV[4] == '1' then
  local families = cjson.decode(ARGV[5])
  if #families == 0 then
    return 'EMPTY_FAMILIES'
  end
  redis.call('JSON.SET', KEYS[1], '$.families', ARGV[5])
end
if ARGV[2] == '1' then
  redis.call('JSON.SET', KEYS[1], '$.label', ARGV[3])
end
redis.call('JSON.SET', KEYS[1], '$.updatedAt', cjson.encode(ARGV[1]))
return 'OK'
`

const ROTATE_PORTABLE_SKILL_TOKEN_SCRIPT = `
-- BATSHIT_PORTABLE_SKILL_TOKEN_ROTATE_V1
-- KEYS[1] = record key; KEYS[2] = new hash index key
-- ARGV[1] = new tokenHash; ARGV[2] = new tokenPrefix; ARGV[3] = new tokenSuffix;
-- ARGV[4] = updatedAt; ARGV[5] = userId; ARGV[6] = tokenId; ARGV[7] = hash index key prefix
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.revokedAt')[1] ~= 'null' then
  return 'REVOKED'
end
if redis.call('JSON.TYPE', KEYS[1], '$.tokenHash')[1] ~= 'string' then
  return 'MALFORMED'
end
local oldHash = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.tokenHash'))[1]
redis.call('JSON.SET', KEYS[1], '$.tokenHash', cjson.encode(ARGV[1]))
redis.call('JSON.SET', KEYS[1], '$.tokenPrefix', cjson.encode(ARGV[2]))
redis.call('JSON.SET', KEYS[1], '$.tokenSuffix', cjson.encode(ARGV[3]))
redis.call('JSON.SET', KEYS[1], '$.updatedAt', cjson.encode(ARGV[4]))
redis.call('DEL', ARGV[7] .. oldHash)
redis.call('JSON.SET', KEYS[2], '$', cjson.encode({userId=ARGV[5], tokenId=ARGV[6]}))
return 'OK'
`

const REVOKE_PORTABLE_SKILL_TOKEN_SCRIPT = `
-- BATSHIT_PORTABLE_SKILL_TOKEN_REVOKE_V1
-- KEYS[1] = record key; KEYS[2] = user's token-set key
-- ARGV[1] = revokedAt; ARGV[2] = tokenId; ARGV[3] = hash index key prefix
if redis.call('EXISTS', KEYS[1]) == 0 then
  return 'MISSING'
end
if redis.call('JSON.TYPE', KEYS[1], '$.revokedAt')[1] ~= 'null' then
  return 'ALREADY_REVOKED'
end
if redis.call('JSON.TYPE', KEYS[1], '$.tokenHash')[1] ~= 'string' then
  return 'MALFORMED'
end
local hash = cjson.decode(redis.call('JSON.GET', KEYS[1], '$.tokenHash'))[1]
redis.call('JSON.SET', KEYS[1], '$.revokedAt', cjson.encode(ARGV[1]))
redis.call('JSON.SET', KEYS[1], '$.updatedAt', cjson.encode(ARGV[1]))
redis.call('DEL', ARGV[3] .. hash)
redis.call('SREM', KEYS[2], ARGV[2])
return 'OK'
`

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

// BL-787: the rotate/revoke Lua scripts recompute this key from the record's OWN current
// tokenHash (read fresh, inside the atomic script), never from a value the caller read earlier
// -- so this prefix is the one piece they need passed in as an argument.
const TOKEN_HASH_INDEX_KEY_PREFIX = 'portable_skill_token_hash:'

function buildTokenHashIndexKey(tokenHash: string) {
  return `${TOKEN_HASH_INDEX_KEY_PREFIX}${tokenHash}`
}

function buildExecutionLogKey(userId: string) {
  return `portable_skill_token_executions:${userId}`
}

function isContainerizedRuntime() {
  return process.env.BATSHIT_CONTAINERIZED === '1' || process.env.BATSHIT_RUNTIME_ENV === 'docker'
}

/** BL-341: `appOrigin` is the origin of the request that asked (the app's own address). */
function buildPortableSkillEnvPlaceholder(appOrigin: string) {
  return [
    '# Batshit Portable Skill private token file',
    '# Keep this file on your machine. Do not put it inside a downloaded portable skill bundle.',
    '# Use one multi-scope token here for all Portable Skills, or create a per-skill',
    '# override file such as artifact-creator.env only when you want a narrower token.',
    buildPortableSkillEnvLines(appOrigin, 'paste-your-portable-skill-token-here')
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

/**
 * The env-file guidance the token routes return. `appOrigin` is the app's own address as the
 * request reached it (`event.url.origin`); it fills `BATSHIT_BASE_URL` in the placeholder text and
 * in a placeholder file created now (an existing file is never rewritten). BL-341.
 */
export async function ensurePortableSkillEnvTemplates(
  appOrigin: string
): Promise<PortableSkillEnvTemplateInfo[]> {
  const placeholder = buildPortableSkillEnvPlaceholder(appOrigin)
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
  const hasLabel = options.label !== undefined
  const normalizedLabel = hasLabel ? normalizeLabel(options.label) : null
  const hasFamilies = options.families !== undefined
  const normalizedFamilies = hasFamilies ? normalizePortableSkillFamilies(options.families) : null
  if (hasFamilies && (normalizedFamilies as PortableSkillFamilyId[]).length === 0) {
    throw Object.assign(new Error('Choose at least one Portable Skills capability family.'), {
      status: 400
    })
  }

  const updatedAt = nowIso()
  const recordKey = buildTokenRecordKey(options.userId, options.tokenId)

  // BL-787: one atomic script -- see its definition for why. It refuses (MISSING/REVOKED)
  // against the record's OWN current state, never a value read earlier, and writes only
  // `label`/`families`/`updatedAt`, never touching `tokenHash` or `revokedAt`.
  const answer = await redis.execute(async (client: any) =>
    client.eval(UPDATE_PORTABLE_SKILL_TOKEN_SCRIPT, {
      keys: [recordKey],
      arguments: [
        updatedAt,
        hasLabel ? '1' : '0',
        hasLabel ? JSON.stringify(normalizedLabel) : '',
        hasFamilies ? '1' : '0',
        hasFamilies ? JSON.stringify(normalizedFamilies) : ''
      ]
    })
  )

  if (answer === 'MISSING' || answer === 'REVOKED') {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }
  if (answer === 'EMPTY_FAMILIES') {
    throw Object.assign(new Error('Choose at least one Portable Skills capability family.'), {
      status: 400
    })
  }
  if (answer !== 'OK') {
    throw new Error(`Unexpected portable skill token update result: ${String(answer)}`)
  }

  const record = await readTokenRecord(options.userId, options.tokenId)
  if (!record) {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }
  return summarizeRecord(record)
}

export async function rotatePortableSkillToken(options: {
  userId: string
  tokenId: string
}): Promise<{ token: string; record: PortableSkillTokenSummary }> {
  const secret = generateTokenSecret()
  const tokenHash = hashToken(secret)
  const updatedAt = nowIso()
  const recordKey = buildTokenRecordKey(options.userId, options.tokenId)
  const newHashIndexKey = buildTokenHashIndexKey(tokenHash)

  // BL-787: one atomic script. It reads the record's CURRENT tokenHash itself (inside the
  // script, not from an earlier JS-side read) to compute which old hash index to delete, so a
  // rotate landing after another rotate always deletes the right one; it refuses outright if
  // the record is gone or already revoked, so a rotate that raced a revoke can never bring a
  // revoked token back to life.
  const answer = await redis.execute(async (client: any) =>
    client.eval(ROTATE_PORTABLE_SKILL_TOKEN_SCRIPT, {
      keys: [recordKey, newHashIndexKey],
      arguments: [
        tokenHash,
        secret.slice(0, TOKEN_PREFIX_LENGTH),
        secret.slice(-TOKEN_SUFFIX_LENGTH),
        updatedAt,
        options.userId,
        options.tokenId,
        TOKEN_HASH_INDEX_KEY_PREFIX
      ]
    })
  )

  if (answer === 'MISSING' || answer === 'REVOKED') {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }
  if (answer !== 'OK') {
    throw new Error(`Unexpected portable skill token rotate result: ${String(answer)}`)
  }

  const record = await readTokenRecord(options.userId, options.tokenId)
  if (!record) {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }

  return {
    token: secret,
    record: summarizeRecord(record)
  }
}

export async function revokePortableSkillToken(options: {
  userId: string
  tokenId: string
}): Promise<PortableSkillTokenSummary> {
  const revokedAt = nowIso()
  const recordKey = buildTokenRecordKey(options.userId, options.tokenId)
  const setKey = buildTokenSetKey(options.userId)

  // BL-787: one atomic script. It reads the record's CURRENT tokenHash itself, so it deletes
  // whichever hash index is actually live at this instant (even if a rotate changed it after
  // this call started), and refuses outright if the record is already gone or revoked.
  const answer = await redis.execute(async (client: any) =>
    client.eval(REVOKE_PORTABLE_SKILL_TOKEN_SCRIPT, {
      keys: [recordKey, setKey],
      arguments: [revokedAt, options.tokenId, TOKEN_HASH_INDEX_KEY_PREFIX]
    })
  )

  if (answer === 'MISSING' || answer === 'ALREADY_REVOKED') {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }
  if (answer !== 'OK') {
    throw new Error(`Unexpected portable skill token revoke result: ${String(answer)}`)
  }

  const record = await readTokenRecord(options.userId, options.tokenId)
  if (!record) {
    throw Object.assign(new Error('Portable Skill Token not found.'), { status: 404 })
  }
  return summarizeRecord(record)
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
    // BL-552: path-scoped writes only (precedent: `wakeHookStore.ts` `recordWakeHookUse`,
    // lines 361-380). The old code read the whole record and wrote it back whole, which raced
    // a rotate, a revoke, or a scope (`families`) edit landing between that read and this
    // write: the stamp would silently overwrite the concurrent change with the stale read's
    // other fields (the old token hash came back, a narrowed scope widened again, a revoked
    // record lost its `revokedAt`). Setting ONLY the two fields this call owns cannot clobber
    // a sibling field. A non-root `$.field` `JSON.SET` does NOT no-op against a key that does
    // not exist -- RedisJSON REFUSES it (throws), so a record revoked/deleted before this stamp
    // runs raises here, not recreates.
    try {
      await client.json.set(recordKey, '$.lastUsedAt', usedAt)
      await client.json.set(recordKey, '$.updatedAt', usedAt)
    } catch (error) {
      // Only the expected race is silent: the record is gone (revoked/deleted) between
      // validation and this stamp, same as the wake-hook precedent. A genuine failure while
      // the record still exists (a dropped connection, a real Redis error) must still
      // propagate, exactly like the old read-then-write code did (its `client.json.get` would
      // throw on the same failure) -- a bare catch here would hide that too.
      const stillExists = (await client.exists(recordKey)) > 0
      if (stillExists) throw error
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
