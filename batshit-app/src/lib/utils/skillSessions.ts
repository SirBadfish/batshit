/** Metadata only. Skill bodies remain in their original tool-result zips. */
export interface SkillSessionRead {
  zipId: string
  rawZipId: string
  messageId: string
  path: string
  sourceSha256?: string
  offset?: number
  returnedChars?: number
  originalChars?: number
  transcriptSha256?: string
  /** A superseded user-pinned original is retained, but is no longer a required live window. */
  required?: boolean
}

export interface SkillSessionZipContext {
  agentId: string
  skillId: string
  generation: number
  revision: number
}

export interface SkillSessionUserHold {
  agentId: string
  skillId: string
  generation: number
  holdRevision: number
}

export interface SkillSessionEntry {
  agentId: string
  /** Original persisted reader identity; a same-id replacement is a different reader. */
  agentCreatedAt?: string
  skillId: string
  name: string
  generation: number
  revision: number
  status: 'open' | 'closed'
  openedAt: number
  openedMessageId: string
  reads: SkillSessionRead[]
  closedBy?: 'user' | 'agent' | 'inferred'
  closedByJudgeName?: string
  noticeToldRevision?: number
}

export interface SkillSessionRecord {
  version: 1
  userId: string
  sessionId: string
  entries: SkillSessionEntry[]
}

export interface OpenSkillSession extends SkillSessionEntry {
  openMessages: number
}

export interface SkillSessionSnapshot extends OpenSkillSession {
  holdFingerprint: string
  accessFingerprint: string
}

export interface SkillReadHold {
  skillId: string
  generation: number
  /** An explicit Tool Notes Hold changes this to false. */
  automatic: boolean
}

export function isBareSkillId(value: string): boolean {
  return /^[a-zA-Z0-9_.-]+$/.test(value) && value !== '.' && value !== '..'
}

export function isRetiredSkillReadField(field: string): boolean {
  return /^(buffer_size|zip_threshold|auto_zip|zip_disabled)_(skill_read|skill_reference)$/.test(field)
}

export function withoutSkillReadRows(value: unknown): unknown {
  return Array.isArray(value) ? value.filter((row) => !row || typeof row !== 'object' ||
    !['skill_read', 'skill_reference'].includes(row.tool_name)) : value
}

/** All normal writers discard retired choices, including a tab open across migration. */
export function withoutSkillReadSettings(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return value
  return Object.fromEntries(Object.entries(value).filter(([field]) => !isRetiredSkillReadField(field))
    .map(([field, current]) => [field, field === 'custom_tool_settings' ? withoutSkillReadRows(current) : current]))
}

export function describeSkillReadVersion(value: Record<string, unknown>): string | null {
  if (typeof value.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(value.sourceSha256)) return null
  const offset = value.offset ?? 0
  if (!Number.isSafeInteger(offset) || Number(offset) < 0 || !Number.isSafeInteger(value.returnedChars) ||
      !Number.isSafeInteger(value.originalChars) || Number(value.returnedChars) < 0 ||
      Number(value.originalChars) < Number(offset) + Number(value.returnedChars)) return null
  return `Source SHA-256: ${value.sourceSha256}; characters ${Number(offset) + 1}-${Number(offset) + Number(value.returnedChars)} of ${value.originalChars}.`
}

const object = (value: unknown): value is Record<string, any> =>
  !!value && typeof value === 'object' && !Array.isArray(value)
const text = (value: unknown): value is string => typeof value === 'string' && value.length > 0
const integer = (value: unknown) => Number.isSafeInteger(value) && Number(value) >= 0

/** Failed or malformed state is unavailable, never an empty open-skill list. */
export function readSkillSessionRecord(value: unknown, sessionId: string, userId?: string): SkillSessionRecord | null {
  if (value === null || value === undefined) return null
  if (!object(value) || value.version !== 1 || value.sessionId !== sessionId || !text(value.userId) ||
      userId !== undefined && value.userId !== userId || !Array.isArray(value.entries)) {
    throw new Error('Skill session state is unreadable; no skill lifecycle changes were applied.')
  }
  const seen = new Set<string>()
  for (const entry of value.entries) {
    if (!object(entry) || !text(entry.agentId) || !text(entry.skillId) || !isBareSkillId(entry.skillId) ||
        entry.agentCreatedAt !== undefined && !text(entry.agentCreatedAt) ||
        !text(entry.name) || !integer(entry.generation) || entry.generation < 1 ||
        !integer(entry.revision) || entry.revision < 1 || !integer(entry.openedAt) ||
        !text(entry.openedMessageId) || !['open', 'closed'].includes(entry.status) || !Array.isArray(entry.reads) ||
        entry.closedBy !== undefined && !['user', 'agent', 'inferred'].includes(entry.closedBy) ||
        entry.closedByJudgeName !== undefined && !text(entry.closedByJudgeName) ||
        entry.noticeToldRevision !== undefined && !integer(entry.noticeToldRevision)) {
      throw new Error('Skill session state is unreadable; no skill lifecycle changes were applied.')
    }
    const key = JSON.stringify([entry.agentId, entry.skillId])
    if (seen.has(key)) throw new Error('Skill session state contains duplicate owners.')
    seen.add(key)
    const ids = new Set<string>()
    for (const read of entry.reads) {
      if (!object(read) || !text(read.zipId) || !text(read.rawZipId) || !text(read.messageId) ||
          !text(read.path) || read.path.startsWith('/') || read.path.split('/').includes('..') || ids.has(read.zipId) ||
          read.sourceSha256 !== undefined && (typeof read.sourceSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(read.sourceSha256)) ||
          read.transcriptSha256 !== undefined && (typeof read.transcriptSha256 !== 'string' || !/^[a-f0-9]{64}$/.test(read.transcriptSha256)) ||
          ['offset', 'returnedChars', 'originalChars'].some((key) => read[key] !== undefined && !integer(read[key])) ||
          read.required !== undefined && typeof read.required !== 'boolean') {
        throw new Error('Skill session read state is unreadable.')
      }
      ids.add(read.zipId)
    }
  }
  return value as SkillSessionRecord
}

export function buildOpenSkillsDcmLines(skills: readonly OpenSkillSession[],
  hints: ReadonlyMap<string, readonly string[]> = new Map(),
  availability: ReadonlyMap<string, string> = new Map()): string[] {
  if (skills.length === 0) return []
  return [
    'open_skills (close each skill when its task is done with "release": ["<skill id>"] in Tool Notes):',
    ...skills.flatMap((skill) => [
      `- ${skill.name.replace(/[\r\n]/g, ' ')} (${skill.skillId}, open ${skill.openMessages} messages)`,
      ...(availability.has(skill.skillId) ? [`  - ${availability.get(skill.skillId)}`] : []),
      ...(hints.get(skill.skillId) ?? []).map(hint => `  - ${hint}`)
    ])
  ]
}

export function withoutSkillSessionReads(record: SkillSessionRecord, rawZipIds: ReadonlySet<string>): SkillSessionRecord {
  return { ...record, entries: record.entries.map((entry) => {
    const reads = entry.reads.filter((read) => !rawZipIds.has(read.rawZipId))
    return reads.length === entry.reads.length ? entry : {
      ...entry, reads, revision: entry.revision + 1,
      ...(reads.length === 0 ? { status: 'closed' as const, closedBy: 'user' as const } : {})
    }
  }) }
}
