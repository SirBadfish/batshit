import { createHash } from 'node:crypto'
import { redis } from '$lib/server/redis'
import { countOneMoreMessage, type UnzippedItem } from '$lib/services/zipping'
import { normalizeId } from '$lib/utils/idNormalizer'
import { normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { resolveAgentJevSkillSessionsEnabled } from '$lib/utils/jevJuiceControl'
import { normalizeStoredTypesafeConfig } from './typesafe/typesafeConfig'
import { captureSettingsLifecycle, SettingsLifecycleRefusal, type SettingsLifecycleSnapshot } from './appActions/settings/lifecycle'
import { commitSkillSessionState, type SkillSessionRawGuard, type SkillSessionZipChange } from './skillSessionCommit'
import { sanitizeId } from '$lib/utils/idSanitizer'
import { builtinPluginSkill } from './agentPlugins'
import { normalizeCompactTool } from '$lib/utils/toolActivityContract'
import { parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import {
  readSkillSessionRecord, type SkillSessionRecord, type SkillSessionEntry,
  type OpenSkillSession, type SkillSessionSnapshot
} from '$lib/utils/skillSessions'
import type { SkillSessionZipContext, SkillSessionUserHold } from '$lib/utils/skillSessions'
import { withZipStateLock } from './zipStateLock'
import { agentMayWriteZipState } from './zipHoldAgentState'
import { isSessionDeleting } from './streamAbortRegistry'
import { resolveSkillAccessForActor } from './slashCommandCapabilities'
import { resolveSessionZipForHold } from './resolveSessionZipForHold'
import { tooLargeCoolToolHoldTokens } from './toolResultHoldAdmission'
import { readOriginalCoolToolEvidence } from './coolToolPromptTokens'

export type { OpenSkillSession, SkillSessionSnapshot } from '$lib/utils/skillSessions'
export type SkillSessionActor = { userId: string; sessionId: string; agentId: string; agentCreatedAt?: string }
const keyOf = (sessionId: string) => `skill_sessions:${sessionId}`
const fingerprint = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex')

const recordBases = new WeakMap<SkillSessionRecord, { guards: SkillSessionRawGuard[]; lifecycle: SettingsLifecycleSnapshot }>()
function decodedRoot(raw: string | null): any {
  if (raw === null) return null
  const values = JSON.parse(raw)
  if (!Array.isArray(values) || values.length !== 1) throw new Error('A skill session source root is unavailable.')
  return values[0]
}
function rememberGuard(record: SkillSessionRecord, guard: SkillSessionRawGuard) {
  const base = recordBases.get(record)
  if (!base) throw new Error('Skill session write has no captured source basis.')
  const previous = base.guards.find((item) => item.key === guard.key)
  if (previous && JSON.stringify(previous) !== JSON.stringify(guard)) throw new Error('A skill session source changed during preparation.')
  if (!previous) base.guards.push(guard)
}
async function observedJson(record: SkillSessionRecord, key: string): Promise<any> {
  const raw = await redis.json.getRaw(key, '$')
  rememberGuard(record, { kind: 'json', key, raw })
  return decodedRoot(raw)
}

async function recordOf(actor: Pick<SkillSessionActor, 'userId' | 'sessionId'>): Promise<SkillSessionRecord> {
  const lifecycle = captureSettingsLifecycle([`session:${actor.sessionId}`,
    ...('agentId' in actor ? [`agent:${actor.agentId}`] : [])])
  const raw = await redis.json.getRaw(keyOf(actor.sessionId), '$')
  const stored = readSkillSessionRecord(decodedRoot(raw), actor.sessionId, actor.userId)
  if (raw !== null && !stored) throw new Error('The existing skill session state is unreadable; nothing was changed.')
  const record = stored ?? { version: 1 as const, userId: actor.userId, sessionId: actor.sessionId, entries: [] }
  recordBases.set(record, { guards: [{ kind: 'json', key: keyOf(actor.sessionId), raw }], lifecycle })
  // Bind every writer to the original owned chat. Deletion cannot be followed by recreating
  // lifecycle metadata or holds, even if it races after a process-local check.
  const session = await observedJson(record, `session:${actor.sessionId}`)
  if (!session || session.user_id !== actor.userId) throw new Error('The skill session chat is unavailable.')
  if ('agentId' in actor) {
    const owner = actor as SkillSessionActor
    const agent = await observedJson(record, `agent:${owner.agentId}`)
    if (!agent || agent.id !== owner.agentId || agent.user_id !== owner.userId ||
        owner.agentCreatedAt !== undefined && agent.created_at !== owner.agentCreatedAt || normalizePrimaryAgentType(agent) === 'n8n') {
      throw new Error('The skill session reader is unavailable.')
    }
  }
  return record
}

async function requireLiveActor(actor: SkillSessionActor): Promise<any> {
  const session = await redis.json.get(`session:${actor.sessionId}`) as any
  const agent = await redis.json.get(`agent:${actor.agentId}`) as any
  if (isSessionDeleting(actor.sessionId) || !session || session.user_id !== actor.userId ||
      !agent || agent.user_id !== actor.userId || actor.agentCreatedAt !== undefined && agent.created_at !== actor.agentCreatedAt || normalizePrimaryAgentType(agent) === 'n8n' || !await agentMayWriteZipState(actor.agentId)) {
    throw new Error('The skill session owner or chat is unavailable; nothing was changed.')
  }
  return agent
}

type ZipChange = SkillSessionZipChange
export class SkillSessionSourceChanged extends Error {}

/** All authority preimages and zip/lifecycle changes meet at one physical Redis write. */
async function commit(record: SkillSessionRecord, changes: ZipChange[], extra: {
  guards?: SkillSessionRawGuard[]; beforeIssue?: () => void
} = {}): Promise<void> {
  readSkillSessionRecord(record, record.sessionId, record.userId)
  const base = recordBases.get(record)
  if (!base) throw new Error('The skill session has no original write basis.')
  for (const guard of extra.guards ?? []) rememberGuard(record, guard)
  for (const change of changes) {
    for (const key of [`unzipped_item:${record.sessionId}:${change.zipId}`, `rezipped_item:${record.sessionId}:${change.zipId}`,
      ...(change.rawZipId ? [`zip:${change.rawZipId}`] : [])]) {
      if (!base.guards.some((guard) => guard.key === key)) await observedJson(record, key)
    }
  }
  const result = await commitSkillSessionState({ record, changes, guards: base.guards, lifecycle: base.lifecycle,
    beforeIssue: () => {
      if (isSessionDeleting(record.sessionId)) throw new SkillSessionSourceChanged('The chat is being deleted; nothing was changed.')
      extra.beforeIssue?.()
    } })
  if (result.status !== 'applied') throw new SkillSessionSourceChanged(`The skill session changed before its write (${result.reason}); nothing was changed.`)
}

async function accessFingerprint(userId: string, command: Record<string, any>, record?: SkillSessionRecord): Promise<string> {
  const plugin = typeof command.plugin_id === 'string'
    ? await (record ? observedJson(record, `agent_plugin:${userId}:${command.plugin_id}`) : redis.json.get(`agent_plugin:${userId}:${command.plugin_id}`)) : null
  return fingerprint({ command, plugin })
}

async function readStates(actor: SkillSessionActor, entry: SkillSessionEntry, record?: SkillSessionRecord) {
  const states = []
  for (const read of entry.reads) {
    const held = await (record ? observedJson(record, `unzipped_item:${actor.sessionId}:${read.zipId}`) : redis.json.get(`unzipped_item:${actor.sessionId}:${read.zipId}`)) as UnzippedItem | null
    const zipped = await (record ? observedJson(record, `rezipped_item:${actor.sessionId}:${read.zipId}`) : redis.json.get(`rezipped_item:${actor.sessionId}:${read.zipId}`))
    const unzipped = (await redis.sMembers(`unzipped:${actor.sessionId}`)).includes(read.zipId)
    const rezipped = (await redis.sMembers(`rezipped:${actor.sessionId}`)).includes(read.zipId)
    states.push({ read, held, zipped, unzipped, rezipped })
  }
  return states
}

export async function readOpenSkillSessions(actor: SkillSessionActor, suppliedRecord?: SkillSessionRecord): Promise<OpenSkillSession[]> {
  const record = suppliedRecord ? readSkillSessionRecord(suppliedRecord, actor.sessionId, actor.userId)! : await readSkillSessionRecordForCompile({ userId: actor.userId, sessionId: actor.sessionId })
  const ids = await redis.lRange(`messages:${actor.sessionId}`, 0, -1)
  return record.entries.filter((entry) => entry.agentId === actor.agentId && entry.status === 'open')
    .map((entry) => ({ ...entry, reads: entry.reads.map((read) => ({ ...read })),
      openMessages: ids.includes(entry.openedMessageId) ? Math.max(0, ids.length - ids.indexOf(entry.openedMessageId) - 1) : 0
    }))
}

/** Read-only preview of the display metadata a successful actual read would open. */
export async function previewOpenSkillSessions(actor: SkillSessionActor, skillId: string, name: string, messageId: string): Promise<OpenSkillSession[]> {
  const record = await recordOf(actor)
  const existing = record.entries.find(entry => entry.agentId === actor.agentId && entry.skillId === skillId)
  const preview: SkillSessionEntry = existing?.status === 'open' ? { ...existing, revision: existing.revision + 1 }
    : { ...existing, agentId: actor.agentId, agentCreatedAt: actor.agentCreatedAt, skillId,
      name: existing?.name || name, status: 'open', generation: (existing?.generation ?? 0) + 1,
      revision: (existing?.revision ?? 0) + 1, openedAt: Date.now(), openedMessageId: messageId, reads: [] }
  const entries = existing ? record.entries.map(entry => entry === existing ? preview : entry) : [...record.entries, preview]
  return readOpenSkillSessions(actor, { ...record, entries })
}

export async function readChatOpenSkillSessions(input: Pick<SkillSessionActor, 'userId' | 'sessionId'>): Promise<OpenSkillSession[]> {
  const record = await recordOf(input)
  const actors = [...new Set(record.entries.filter((entry) => entry.status === 'open').map((entry) => entry.agentId))]
  return (await Promise.all(actors.map((agentId) => readOpenSkillSessions({ ...input, agentId })))).flat()
}

export async function readSkillSessionZipContexts(input: Pick<SkillSessionActor, 'userId' | 'sessionId'>): Promise<Map<string, SkillSessionZipContext>> {
  const contexts = new Map<string, SkillSessionZipContext>()
  for (const entry of (await recordOf(input)).entries.filter((row) => row.status === 'open')) {
    for (const read of entry.reads.filter((row) => row.required !== false)) contexts.set(read.zipId, {
      agentId: entry.agentId, skillId: entry.skillId, generation: entry.generation, revision: entry.revision
    })
  }
  return contexts
}

/** Human Hold keeps the lifecycle open and binds any later scheduled expiry to this choice. */
export async function holdSkillSessionRead(input: Pick<SkillSessionActor, 'userId' | 'sessionId'> & {
  zipId: string; item: UnzippedItem
}): Promise<UnzippedItem | null> {
  return withZipStateLock(input.sessionId, async () => {
    const record = await recordOf(input)
    const entry = record.entries.find((row) => row.status === 'open' && row.reads.some((read) => read.zipId === input.zipId && read.required !== false))
    if (!entry) return null
    entry.revision += 1
    const item: UnzippedItem = { ...input.item, source: 'user', skillSessionUserHold: {
      agentId: entry.agentId, skillId: entry.skillId, generation: entry.generation, holdRevision: entry.revision
    } }
    delete item.skillSession
    delete item.skillSessionContext
    delete item.path
    delete item.agentId
    await commit(record, [{ zipId: input.zipId, hold: item }])
    return { ...item, skillSessionContext: { agentId: entry.agentId, skillId: entry.skillId,
      generation: entry.generation, revision: entry.revision } }
  })
}

export interface SkillZipClosure {
  agentId: string
  skillId: string
  changedZipIds: string[]
  preservedZipIds: string[]
  reason: 'release' | 'zip' | 'expiry'
}

function planUserSkillClosure(entry: SkillSessionEntry, items: Map<string, UnzippedItem>, zipId: string, reason: 'release' | 'zip' | 'expiry') {
  const changes: ZipChange[] = []
  const preservedZipIds: string[] = []
  for (const read of entry.reads) {
    const held = items.get(read.zipId)
    const automatic = held?.source === 'agent' && held.agentId === entry.agentId && held.skillSession?.automatic === true
    if (read.zipId === zipId || automatic) changes.push({ zipId: read.zipId, closeBy: 'user',
      reason: reason === 'expiry' ? 'user_skill_hold_expired' : reason === 'release' ? 'user_skill_release' : 'user_skill_zip' })
    else if (held) {
      const independent = { ...held }
      delete independent.skillSession
      delete independent.skillSessionUserHold
      delete independent.skillSessionContext
      changes.push({ zipId: read.zipId, hold: independent })
      preservedZipIds.push(read.zipId)
    }
  }
  return { entry: { ...entry, status: 'closed' as const, closedBy: 'user' as const, revision: entry.revision + 1 }, changes, preservedZipIds }
}

/** Read-only state owner used by the canonical compiler; no skill body is loaded here. */
export async function readSkillSessionRecordForCompile(input: Pick<SkillSessionActor, 'userId' | 'sessionId'>): Promise<SkillSessionRecord> {
  const raw = await redis.json.getRaw(keyOf(input.sessionId), '$')
  // A known-absent lifecycle contains no retained text or authority. The compiler also
  // supports known-absent speech-to-speech fallback chats; its strict session/memory owner
  // still distinguishes absence from read failure. Never use this path for a writer.
  if (raw === null) return { version: 1, userId: input.userId, sessionId: input.sessionId, entries: [] }
  const record = readSkillSessionRecord(decodedRoot(raw), input.sessionId, input.userId)
  if (!record) throw new Error('The existing skill session state is unreadable; nothing was changed.')
  const session = decodedRoot(await redis.json.getRaw(`session:${input.sessionId}`, '$'))
  if (!session || session.user_id !== input.userId) throw new Error('The skill session chat is unavailable.')
  return record
}

/** Same expiry plan as the accepted-send writer, projected without mutating Redis. */
export function projectSkillSessionsForPendingMessage(record: SkillSessionRecord, items: UnzippedItem[], pending: boolean) {
  if (!pending) return { record, unzipped: items, rezipped: [] as string[] }
  const projected: SkillSessionRecord = { ...record, entries: record.entries.map((entry) => ({ ...entry, reads: entry.reads.map((read) => ({ ...read })) })) }
  const counted = countOneMoreMessage(items)
  const kept = new Map(counted.kept.map((item) => [item.zipId, item]))
  const originals = new Map(items.map((item) => [item.zipId, item]))
  const rezipped = new Set<string>()
  for (const ended of counted.ended) {
    const stamp = ended.skillSessionUserHold
    if (!stamp || ended.source !== 'user') continue
    const entry = projected.entries.find((row) => row.status === 'open' && row.agentId === stamp.agentId && row.skillId === stamp.skillId &&
      row.generation === stamp.generation && row.reads.some((read) => read.zipId === ended.zipId && read.required !== false))
    if (!entry) continue
    const plan = planUserSkillClosure(entry, originals, ended.zipId, 'expiry')
    Object.assign(entry, plan.entry)
    for (const change of plan.changes) {
      if (change.hold) {
        if (kept.has(change.zipId)) kept.set(change.zipId, { ...change.hold, messageCount: kept.get(change.zipId)!.messageCount })
      } else { kept.delete(change.zipId); rezipped.add(change.zipId) }
    }
  }
  return { record: projected, unzipped: [...kept.values()], rezipped: [...rezipped] }
}

/**
 * Losing the FIRST required window closes this lifecycle. Other explicit pins become ordinary
 * independent holds; no user action is undone by an automatic re-hold. Old-generation and
 * superseded timers have no authority over a new/current lifecycle.
 */
export async function closeSkillSessionFromZipAction(input: Pick<SkillSessionActor, 'userId' | 'sessionId'> & {
  zipId: string; reason: 'release' | 'zip' | 'expiry'; expectedExpiry?: SkillSessionUserHold
}): Promise<SkillZipClosure | null> {
  return withZipStateLock(input.sessionId, async () => {
    const record = await recordOf(input)
    const entry = record.entries.find((row) => row.status === 'open' && row.reads.some((read) => read.zipId === input.zipId && read.required !== false))
    if (!entry) return null
    const states = await readStates({ ...input, agentId: entry.agentId }, entry, record)
    if (input.reason === 'expiry') {
      const stamp = input.expectedExpiry
      const current = states.find(({ read }) => read.zipId === input.zipId)?.held
      if (!stamp || stamp.agentId !== entry.agentId || stamp.skillId !== entry.skillId || stamp.generation !== entry.generation ||
          current?.source !== 'user' || current.skillSessionUserHold?.holdRevision !== stamp.holdRevision ||
          current.skillSessionUserHold.generation !== stamp.generation) return null
    }
    const plan = planUserSkillClosure(entry, new Map(states.filter((state) => state.held).map((state) => [state.read.zipId, state.held!])), input.zipId, input.reason)
    Object.assign(entry, plan.entry)
    await commit(record, plan.changes)
    return { agentId: entry.agentId, skillId: entry.skillId,
      changedZipIds: plan.changes.filter((change) => !change.hold).map((change) => change.zipId), preservedZipIds: plan.preservedZipIds, reason: input.reason }
  })
}

export async function readSkillSessionHintExclusions(actor: SkillSessionActor): Promise<string[]> {
  return (await recordOf(actor)).entries.filter((entry) => entry.agentId === actor.agentId &&
    (entry.status === 'open' || entry.closedBy === 'user')).map((entry) => entry.skillId)
}

export async function readSkillSessionNotices(actor: SkillSessionActor): Promise<SkillSessionEntry[]> {
  return (await recordOf(actor)).entries.filter((entry) => entry.agentId === actor.agentId &&
    entry.status === 'closed' && entry.closedBy === 'inferred' && entry.noticeToldRevision !== entry.revision)
}

export async function markSkillSessionNoticesTold(actor: SkillSessionActor, notices: Array<Pick<SkillSessionEntry, 'skillId' | 'revision'>>): Promise<void> {
  await withZipStateLock(actor.sessionId, async () => {
    await requireLiveActor(actor)
    const record = await recordOf(actor)
    let changed = false
    for (const notice of notices) {
      const entry = record.entries.find((row) => row.agentId === actor.agentId && row.skillId === notice.skillId)
      if (entry?.status !== 'closed' || entry.closedBy !== 'inferred' || entry.revision !== notice.revision) continue
      entry.noticeToldRevision = notice.revision
      changed = true
    }
    if (changed) await commit(record, [])
  })
}

export async function captureSkillSessionSnapshot(actor: SkillSessionActor): Promise<SkillSessionSnapshot[]> {
  return withZipStateLock(actor.sessionId, async () => {
    await requireLiveActor(actor)
    const result: SkillSessionSnapshot[] = []
    for (const entry of await readOpenSkillSessions(actor)) {
      const access = await resolveSkillAccessForActor(actor.userId, entry.skillId, { kind: 'agent', agentId: actor.agentId }, { readOnly: true })
      if (!access.ok) continue
      result.push({ ...entry, holdFingerprint: fingerprint(await readStates(actor, entry)), accessFingerprint: await accessFingerprint(actor.userId, access.command) })
    }
    return result
  })
}

/** A turn-private choice snapshot, captured before the skill source is read. */
export type SkillReadChoice = Readonly<{ readonly skillReadChoice: unique symbol }>
const readChoices = new WeakMap<SkillReadChoice, {
  actor: SkillSessionActor; skillId: string; messageId: string
  entry?: Pick<SkillSessionEntry, 'generation' | 'revision' | 'status'>
}>()
export async function captureSkillReadChoice(actor: SkillSessionActor, skillId: string, messageId: string): Promise<SkillReadChoice> {
  return withZipStateLock(actor.sessionId, async () => {
    await requireLiveActor(actor)
    const record = await recordOf(actor)
    const entry = record.entries.find(row => row.agentId === actor.agentId && row.skillId === skillId)
    const token = Object.freeze({}) as SkillReadChoice
    readChoices.set(token, { actor: { ...actor }, skillId, messageId,
      ...(entry ? { entry: { generation: entry.generation, revision: entry.revision, status: entry.status } } : {}) })
    return token
  })
}
/** Must be called under the shared zip lock immediately before publishing a delivered read. */
export async function assertSkillReadChoice(choice: SkillReadChoice, actor: SkillSessionActor, skillId: string, messageId: string): Promise<void> {
  const basis = readChoices.get(choice)
  if (!basis || JSON.stringify(basis.actor) !== JSON.stringify(actor) || basis.skillId !== skillId || basis.messageId !== messageId) {
    throw new Error('The skill read no longer belongs to this turn. Nothing was opened.')
  }
  await requireLiveActor(actor)
  const record = await recordOf(actor)
  const current = record.entries.find(row => row.agentId === actor.agentId && row.skillId === skillId)
  // Ordinary parallel reads in the same open generation can advance the revision. A Close,
  // including Close followed by a new read, invalidates the earlier source read's authority.
  const accepted = basis.entry?.status === 'open'
    ? current?.status === 'open' && current.generation === basis.entry.generation
    : !current && !basis.entry || current?.status === 'closed' && basis.entry?.status === 'closed' &&
        current.generation === basis.entry.generation && current.revision === basis.entry.revision ||
      current?.status === 'open' && current.openedMessageId === messageId &&
        current.generation === (basis.entry?.generation ?? 0) + 1
  if (!accepted) throw new Error('The skill was closed while this read was pending. Read it again if it is still needed.')
}

/**
 * Called only after a real Primary's tool-result zip was persisted. Actor identity comes from
 * send-routed, never the result payload. Repeated adapter/finalize delivery is idempotent.
 */
export async function openSkillSessionRead(input: SkillSessionActor & { rawZipId: string; messageId: string }): Promise<boolean> {
  return withZipStateLock(input.sessionId, async () => {
    const reader = await requireLiveActor(input)
    const record = await recordOf(input)
    const resolved = await resolveSessionZipForHold(input.sessionId, input.rawZipId, { strict: true })
    if (resolved.status !== 'found') throw new Error(`The skill read zip is ${resolved.status}; the skill could not open.`)
    const zip = await observedJson(record, `zip:${input.rawZipId}`)
    if (!zip) throw new Error('The original skill read is unavailable.')
    if (zip.metadata?.sessionId !== input.sessionId || zip.metadata?.messageId !== input.messageId) {
      throw new Error('The skill read does not belong to this reply; nothing was opened.')
    }
    // A durable admission stamp travels with this exact zip across adapter rewrites. Old
    // finalize/replay can therefore never reopen a closed generation, without growing the
    // lifecycle's tombstone into an unbounded list of every past read id.
    if (zip.metadata?.skillSessionAdmission) return false
    const payload = parseCoolToolPayload(zip.content)
    if (!payload || zip.metadata?.operationKind !== 'skill_read') return false
    const compact = normalizeCompactTool(payload as any)
    const result = compact.toolResult as any
    const skillId = result?.skillId ?? compact.toolArgs?.skillId
    const path = result?.path ?? result?.filePath ?? compact.toolArgs?.path ?? 'SKILL.md'
    if (payload.error || result?.success === false || result?.blocked === true || result?.error || !['invoke', 'read', 'script_read'].includes(result?.action ?? compact.toolArgs?.action) ||
        typeof skillId !== 'string' || typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').includes('..')) return false
    const access = await resolveSkillAccessForActor(input.userId, skillId, { kind: 'agent', agentId: input.agentId })
    if (!access.ok) throw new Error(access.message)
    const tooLarge = await tooLargeCoolToolHoldTokens(zip)
    if (tooLarge !== null) throw new Error(`Cannot open skill ${access.skillId}: this read is about ${Math.ceil(tooLarge)} tokens and is too large to hold. Read it in smaller windows.`)
    const transcriptSha256 = (await readOriginalCoolToolEvidence(zip, (id) => redis.json.get(`zip:${id}`) as Promise<any>)).digest
    let entry = record.entries.find((row) => row.agentId === input.agentId && row.skillId === access.skillId)
    if (entry?.reads.some((read) => read.rawZipId === input.rawZipId)) return false
    if (!entry) {
      entry = { agentId: input.agentId, agentCreatedAt: reader.created_at, skillId: access.skillId, name: result?.skillName || access.skillId,
        generation: 1, revision: 0, status: 'open', openedAt: Date.now(), openedMessageId: input.messageId, reads: [] }
      record.entries.push(entry)
    } else if (entry.status === 'closed') {
      entry.generation += 1
      entry.status = 'open'
      entry.openedAt = Date.now()
      entry.openedMessageId = input.messageId
      entry.reads = []
      entry.agentCreatedAt = reader.created_at
      delete entry.closedBy
    }
    const zipId = normalizeId(input.rawZipId)
    const held = await observedJson(record, `unzipped_item:${input.sessionId}:${zipId}`) as UnzippedItem | null
    const zipped = await observedJson(record, `rezipped_item:${input.sessionId}:${zipId}`) as any
    const manualRezip = (await redis.sMembers(`rezipped:${input.sessionId}`)).includes(zipId)
    if (held && held.source !== 'agent' && held.source !== 'inferred' || manualRezip && (!zipped || zipped.source === 'user')) {
      throw new Error(`The user controls this skill read; ${access.skillId} was not opened over their choice.`)
    }
    entry.revision += 1
    let automatic = true
    const changes: ZipChange[] = []
    const superseded = new Set<string>()
    const wholeRead = typeof result?.sourceSha256 === 'string' && /^[a-f0-9]{64}$/.test(result.sourceSha256) &&
      (result.offset ?? 0) === 0 && Number.isSafeInteger(result.returnedChars) &&
      result.returnedChars === result.originalChars && result.modelTextOnly !== true
    for (const earlier of entry.reads.filter((read) => read.path === path)) {
      const previous = await observedJson(record, `unzipped_item:${input.sessionId}:${earlier.zipId}`) as UnzippedItem | null
      if (previous?.source === 'agent' && previous.agentId === input.agentId && previous.skillSession?.automatic === false) automatic = false
      // A verified new whole read replaces the older windows. A user's pin remains their
      // copy and stays in the lifecycle so only human Close can remove that protection.
      if (wholeRead && (!previous || previous.source === 'agent' && previous.agentId === input.agentId)) {
        superseded.add(earlier.zipId)
        changes.push({ zipId: earlier.zipId, closeBy: 'agent', reason: 'skill_superseded' })
      } else if (wholeRead) {
        earlier.required = false
      }
    }
    entry.reads = entry.reads.filter((read) => !superseded.has(read.zipId))
    entry.reads.push({ zipId, rawZipId: input.rawZipId, messageId: input.messageId, path, transcriptSha256,
      ...Object.fromEntries(['sourceSha256', 'offset', 'returnedChars', 'originalChars']
        .filter((key) => result?.[key] !== undefined).map((key) => [key, result[key]])) })
    const hold: UnzippedItem = {
      zipId, sessionId: input.sessionId, permanent: true, unzippedAt: Date.now(), source: 'agent',
      agentId: input.agentId, path: `skill:${entry.skillId}:${path}`, name: entry.name,
      tokens: zip.tokens, skillSession: { skillId: entry.skillId, generation: entry.generation, automatic }
    }
    await commit(record, [...changes, { zipId, hold, rawZipId: input.rawZipId, transcriptSha256 }])
    return true
  })
}

export async function closeSkillSession(input: SkillSessionActor & {
  skillId: string; provenance: 'user' | 'agent' | 'inferred'; expected?: SkillSessionSnapshot
  expectedGeneration?: number; expectedRevision?: number
  judgeName?: string
  /** A trusted after-reply owner may only narrow with a fresh whole-task/source check. */
  revalidateTask?: () => Promise<boolean>
  taskGuards?: SkillSessionRawGuard[]
  beforeIssue?: () => void
}): Promise<{ status: 'closed' | 'unchanged' | 'refused'; reason?: string; changedZipIds: string[] }> {
  return withZipStateLock(input.sessionId, async () => {
    if (input.provenance !== 'user') await requireLiveActor(input)
    const record = await recordOf(input.provenance === 'user' ? { userId: input.userId, sessionId: input.sessionId } : input)
    const skillId = builtinPluginSkill(input.skillId)?.skillId ?? sanitizeId(input.skillId)
    const entry = record.entries.find((row) => row.agentId === input.agentId && row.skillId === skillId)
    if (!entry || entry.status !== 'open') return { status: 'unchanged', changedZipIds: [] }
    if (input.expectedGeneration !== undefined && input.expectedGeneration !== entry.generation ||
        input.expectedRevision !== undefined && input.expectedRevision !== entry.revision) {
      return { status: 'refused', reason: 'This skill changed while the list was open. Refresh it before closing.', changedZipIds: [] }
    }
    const states = await readStates(input, entry, record)
    if (input.provenance === 'inferred') {
      const agent = await observedJson(record, `agent:${input.agentId}`) as any
      const master = await observedJson(record, 'batshit:typesafe_config')
      if (!resolveAgentJevSkillSessionsEnabled(agent) || !normalizeStoredTypesafeConfig(master).enabled) {
        return { status: 'refused', reason: 'Skill session management is off; the skill stays open.', changedZipIds: [] }
      }
      const expected = input.expected
      const revisionKey = `slash_command_revision:${input.userId}`
      rememberGuard(record, { kind: 'string', key: revisionKey, raw: await redis.execute((client) => client.get(revisionKey)) })
      const access = await resolveSkillAccessForActor(input.userId, input.skillId, { kind: 'agent', agentId: input.agentId },
        { readOnly: true, read: (key) => observedJson(record, key) })
      if (!expected || expected.skillId !== entry.skillId || expected.agentId !== entry.agentId ||
          expected.generation !== entry.generation || expected.revision !== entry.revision ||
          expected.holdFingerprint !== fingerprint(states) || !access.ok || expected.accessFingerprint !== await accessFingerprint(input.userId, access.command, record)) {
        return { status: 'refused', reason: 'The skill changed after this judgment; it stays open.', changedZipIds: [] }
      }
      if (input.revalidateTask && !await input.revalidateTask()) {
        return { status: 'refused', reason: 'The original task or whole reply changed after this judgment; the skill stays open.', changedZipIds: [] }
      }
    }
    const protectedRead = states.some(({ held }) => held && (
      held.source !== 'agent' && held.source !== 'inferred' ||
      held.agentId !== input.agentId || input.provenance === 'inferred' && held.skillSession?.automatic !== true
    ))
    if (protectedRead && input.provenance !== 'user') {
      return { status: 'refused', reason: 'An explicit hold protects this skill; it stays open.', changedZipIds: [] }
    }
    const changes = states.filter(({ held }) => input.provenance === 'user' || input.provenance === 'inferred'
      ? input.provenance === 'user' || held?.source === 'agent' && held.agentId === input.agentId && held.skillSession?.automatic === true
      : !held || held.source === 'agent' && held.agentId === input.agentId)
      .map(({ read }) => ({ zipId: read.zipId, closeBy: input.provenance }))
    entry.status = 'closed'
    entry.closedBy = input.provenance
    if (input.provenance === 'inferred') entry.closedByJudgeName = input.judgeName || 'the judge'
    entry.revision += 1
    try {
      await commit(record, changes, input.provenance === 'inferred' ? { guards: input.taskGuards, beforeIssue: input.beforeIssue } : {})
    } catch (error) {
      if (error instanceof SkillSessionSourceChanged || error instanceof SettingsLifecycleRefusal) return { status: 'refused', reason: error.message, changedZipIds: [] }
      throw error
    }
    return { status: 'closed', changedZipIds: changes.map((change) => change.zipId) }
  })
}

/** An explicit file Hold protects automatic skill reads from an inferred close. */
export async function retainSkillSessionRead(input: SkillSessionActor & { zipId: string }): Promise<string[]> {
  return withZipStateLock(input.sessionId, async () => {
    await requireLiveActor(input)
    const record = await recordOf(input)
    const entry = record.entries.find((row) => row.agentId === input.agentId && row.status === 'open' && row.reads.some((read) => read.zipId === input.zipId))
    if (!entry) return []
    const path = entry.reads.find((read) => read.zipId === input.zipId)!.path
    const changes: ZipChange[] = []
    for (const read of entry.reads.filter((read) => read.path === path)) {
      const item = await observedJson(record, `unzipped_item:${input.sessionId}:${read.zipId}`) as UnzippedItem | null
      if (!item || item.source !== 'agent' || item.agentId !== input.agentId || !item.skillSession) continue
      changes.push({ zipId: item.zipId, hold: { ...item, skillSession: { ...item.skillSession, automatic: false } } })
    }
    entry.revision += 1
    await commit(record, changes)
    return changes.map(({ zipId }) => zipId)
  })
}

/** Called before the agent record disappears, while its deletion mark blocks new opens. */
export async function deleteAgentSkillSessions(agentId: string, userId: string): Promise<Array<{ sessionId: string; zipId: string }>> {
  const released: Array<{ sessionId: string; zipId: string }> = []
  for (const sessionId of await redis.sMembers(`user:${userId}:sessions`)) {
    await withZipStateLock(sessionId, async () => {
      const record = await recordOf({ userId, sessionId })
      const entries = record.entries.filter((entry) => entry.agentId !== agentId)
      if (entries.length === record.entries.length) return
      const changes: ZipChange[] = []
      for (const entry of record.entries.filter((row) => row.agentId === agentId)) {
        for (const read of entry.reads) {
          const hold = await redis.json.get(`unzipped_item:${sessionId}:${read.zipId}`) as UnzippedItem | null
          if (hold?.source === 'agent' && hold.agentId === agentId) changes.push({ zipId: read.zipId, closeBy: 'agent' })
        }
      }
      record.entries = entries
      await commit(record, changes)
      released.push(...changes.map(({ zipId }) => ({ sessionId, zipId })))
    })
  }
  return released
}
