import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import { redis } from '$lib/server/redis'
import { isRetiredPrimaryAgentType, normalizePrimaryAgentType } from '$lib/utils/primaryAgentType'
import { isCliSubagentType, isRetiredN8nSubagentType, normalizeSubagentType } from '$lib/utils/subagentType'
import { namesRetiredCodexCliModel, subagentCliRuntimeCandidates } from '$lib/utils/cliRuntimeIdentity'
import { resolveSubagentSlug } from '$lib/utils/subagentSlug'
import type { SubagentRow } from '$lib/types/database'
import { selectAgentChats } from '$lib/server/services/agentChatDeletion'
import { getManagedAgentRootDir } from '$lib/server/services/batshitHome'
import { buildAgentProfileId } from '$lib/server/services/managedProfileIdentity'

/**
 * SA-139 R4 add-on (Josh, 2026-10-27): a ONE-TIME sweep of what the three retired types left in
 * an instance's Redis: Codex CLI (R1), the Claude Code CLI Primary (R4) and the n8n Subagent
 * types (R2; with the older n8n Primary type, SA-106). Run by `scripts/sweep-retired-agent-types.mjs`,
 * never by the app: a dry run lists every family with its count and changes nothing; an apply
 * deletes exactly the plan the dry run printed (same plan id), after a backup.
 *
 * It runs only against a Batshit that already has R4: the running app is then the reason it is
 * safe to delete a retired record from another process (every dispatch, save and App Actions
 * subject of R4 refuses a retired record, so the app never writes one while it goes). The check
 * is the old Claude Code CLI Primary prompt: an app older than R4 seeds it at every start, and R4's
 * startup sweep of retired prompts removes it. While it is there, the apply refuses.
 *
 * Records go through their existing scoped deletion owners (D14): a retired Primary through the
 * agent DELETE route handler (its chats only when the caller says so), a retired Subagent through
 * the Subagent DELETE route handler (which also removes its assignments on surviving agents). Only
 * keys whose writer and reader are both gone are deleted here directly, one key per atomic script
 * that checks the key's type first. Each record is read again right before its owner runs, and a
 * record that is no longer of a retired type stops the apply. Nothing is selected by name.
 *
 * Never touched: Claude Code CLI Subagents (SA-139 R5 retired the type, but nothing proves the app
 * beside this sweep has R5, and an older one still runs them: they are deleted in Settings), API
 * agents (API keys, Local AI, the ChatGPT plan, the Claude plan), model presets and connections,
 * the managed Claude Code install and the Claude sign-in (both on disk, not in Redis), n8n tool
 * workflows and their settings. Kept and only counted: `claude_settings` on API agents (saved
 * aliases are checked before this sweep removes folders), and model presets on the removed Codex
 * CLI connection (model presets are not part of this sweep).
 */

export type RetiredTypeSweepFamilyId =
  | 'retired-primary-agents'
  | 'retired-subagents'
  | 'subagent-thread-keys'
  | 'n8n-callback-keys'
  | 'n8n-compatibility-keys'
  | 'codex-cleanup-warnings'
  | 'n8n-workflow-memory'
  | 'codex-settings-fields'

export type RetiredPrimaryAgentFacts = {
  /** Regular chats the delete removes with `--chats delete`, and Infinite Sessions (always removed with them). */
  chats: number
  infiniteSessions: number
  /** Locked regular chats: the delete keeps them, as the Settings dialog does. */
  keptLockedChats: number
  /** Saved memory records (`memory:<id>:*`); the agent delete removes them with the agent. */
  memories: number
  /** The first titles of the chats the delete would remove with `--chats delete`. */
  chatTitles: string[]
}

/**
 * The record's managed profile folder, which its delete removes (backups do not carry it). A
 * Subagent's folder another record also resolves to stays (`sharedWith`), by the delete's own rule.
 */
export type RetiredTypeSweepFolder = { profileId: string; path: string; exists: boolean; sharedWith?: string }

export type RetiredTypeSweepItem = {
  family: RetiredTypeSweepFamilyId
  key: string
  /** Plain words for the list Josh reads: a record's name and lane, or the key's kind. */
  label: string
  userId?: string
  /** A retired record without an owner: listed, never deleted by this sweep (no owner can run). */
  ownerless?: boolean
  primary?: RetiredPrimaryAgentFacts
  profileFolder?: RetiredTypeSweepFolder
  /** A retired Primary's Worker slot folders that exist; its delete removes those not shared (BL-393). */
  workerFolders?: RetiredTypeSweepFolder[]
}

export type RetiredTypeSweepKept = { what: string; count: number; reason: string }

export type RetiredTypeSweepPlan = {
  planId: string
  items: RetiredTypeSweepItem[]
  kept: RetiredTypeSweepKept[]
  /** Reasons the apply refuses on this instance now; empty when it may run. */
  blockers: string[]
  /** The owners of every agent and Subagent record: the instance's user (one user per instance). */
  instanceOwners: string[]
}

export const RETIRED_TYPE_SWEEP_FAMILIES: ReadonlyArray<{ id: RetiredTypeSweepFamilyId; title: string; pattern: string; owner: string }> = [
  { id: 'retired-primary-agents', title: 'Retired Primary agents (Claude Code CLI, Codex CLI, n8n)', pattern: 'agent:<id> whose type is cli or n8n', owner: 'DELETE /api/agents/[id] (the ordinary agent delete; it also removes the agent\'s memories, DMs, schedules, wake-ups and group-chat places)' },
  { id: 'retired-subagents', title: 'Retired Subagents (Codex CLI, n8n Workflow, n8n Subnode)', pattern: 'subagent:<id> of a removed type', owner: 'DELETE /api/subagents/[id] (the ordinary Subagent delete; it also removes its assignments on other agents)' },
  { id: 'subagent-thread-keys', title: 'n8n Workflow Subagent thread ids', pattern: 'subagent_thread:*', owner: 'none: no reader or writer since R2' },
  { id: 'n8n-callback-keys', title: 'n8n Workflow Subagent callback tokens', pattern: 'n8n:sse-callback:*', owner: 'none: no reader or writer since R2' },
  { id: 'n8n-compatibility-keys', title: 'n8n parameter compatibility cache', pattern: 'compatibility:matrix:n8n:v1, compatibility:matrix:n8n:sync-status:v1', owner: 'none: no reader or writer since R2' },
  { id: 'codex-cleanup-warnings', title: 'Codex CLI cleanup warnings', pattern: 'codex_cleanup_warnings:<chat>, codex_cleanup_warning:<chat>:<reply>', owner: 'none: no reader or writer since R1' },
  { id: 'n8n-workflow-memory', title: 'n8n Workflow Subagent chat memory written by n8n', pattern: 'subagent_sessions:<chat>:subagent:<slug>:<thread> (a list; never a live Subagent slug)', owner: 'none: only the removed n8n Workflow Subagent template wrote this five-part list; a live Subagent thread is the four-part subagent_sessions:<chat>:subagent:<slug>, which this never matches' },
  { id: 'codex-settings-fields', title: 'Codex CLI settings left on surviving records', pattern: '$.codex_settings on agent:<id> and subagent:<id>', owner: 'none: no reader since R1; every save already drops it' },
]

/** The keys only a Batshit older than SA-139 R4 seeds (its Claude Code CLI Primary prompt). */
export const PRE_R4_APP_MARKER_KEYS = ['batshit:batshit_mode4_system_prompt', 'batshit:system_prompt_meta:cli_primary'] as const

const AGENT_KEY = /^agent:([^:]+)$/
const SUBAGENT_KEY = /^subagent:([^:]+)$/
const MODEL_KEY = /^model:[^:]+$/
const N8N_MEMORY_KEY = /^subagent_sessions:([^:]+):subagent:([^:]+):([^:]+)$/
const CODEX_WARNING_INDEX_KEY = /^codex_cleanup_warnings:[^:]+$/
const CODEX_WARNING_ITEM_KEY = /^codex_cleanup_warning:[^:]+:[^:]+$/
const N8N_COMPATIBILITY_KEYS = ['compatibility:matrix:n8n:v1', 'compatibility:matrix:n8n:sync-status:v1']

/** KEYS[1] the key, ARGV[1] the type it must have, ARGV[2] 'apply' or 'dry'. Answers 1 when it matched (and went). */
const DELETE_KEY_OF_TYPE_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1])
if type(kind) == 'table' then kind = kind['ok'] end
if kind ~= ARGV[1] then return 0 end
if ARGV[2] == 'apply' then redis.call('DEL', KEYS[1]) end
return 1
`

/** KEYS[1] a JSON record, ARGV[1] 'apply' or 'dry'. Removes only `$.codex_settings`. Answers 1 when it was there. */
const DELETE_CODEX_SETTINGS_SCRIPT = `
local kind = redis.call('TYPE', KEYS[1])
if type(kind) == 'table' then kind = kind['ok'] end
if kind ~= 'ReJSON-RL' then return 0 end
local shape = redis.call('JSON.TYPE', KEYS[1], '$.codex_settings')
if type(shape) ~= 'table' or shape[1] == nil then return 0 end
if ARGV[1] == 'apply' then redis.call('JSON.DEL', KEYS[1], '$.codex_settings') end
return 1
`

/** SCAN, never KEYS: the sweep runs while the app serves requests. */
async function scanKeys(pattern: string): Promise<string[]> {
  return redis.execute(async (client) => {
    const keys = new Set<string>()
    for await (const batch of client.scanIterator({ MATCH: pattern, COUNT: 500 })) {
      for (const key of Array.isArray(batch) ? batch : [batch]) keys.add(String(key))
    }
    return [...keys].sort()
  })
}

async function keyOfType(key: string, type: string, mode: 'apply' | 'dry'): Promise<boolean> {
  const answer = await redis.execute((client) => client.eval(DELETE_KEY_OF_TYPE_SCRIPT, { keys: [key], arguments: [type, mode] }))
  return Number(answer) === 1
}

async function codexSettingsField(key: string, mode: 'apply' | 'dry'): Promise<boolean> {
  const answer = await redis.execute((client) => client.eval(DELETE_CODEX_SETTINGS_SCRIPT, { keys: [key], arguments: [mode] }))
  return Number(answer) === 1
}

async function readRecord(key: string): Promise<Record<string, any> | null> {
  const row = await redis.get(key, { throwOnError: true })
  return row && typeof row === 'object' && !Array.isArray(row) ? row as Record<string, any> : null
}

async function readRecords(pattern: string, keyShape: RegExp): Promise<Array<{ key: string; row: Record<string, any> }>> {
  const rows: Array<{ key: string; row: Record<string, any> }> = []
  for (const key of (await scanKeys(pattern)).filter((key) => keyShape.test(key))) {
    const row = await readRecord(key)
    if (row) rows.push({ key, row })
  }
  return rows
}

/**
 * A Subagent record this sweep may delete: an n8n type or alias, or a Codex CLI Subagent (refused
 * since R1, so no app beside the sweep runs it). NOT a Claude Code CLI Subagent: R5 retired that
 * type too, but an app older than R5 still runs one, and no stored key proves which app is
 * running (SA-139 R5 receipt, design 7), so those are deleted in Settings.
 */
export function isRetiredSubagentRecord(row: Record<string, any>): boolean {
  const type = normalizeSubagentType(row)
  if (isRetiredN8nSubagentType(type)) return true
  return isCliSubagentType(type) && subagentCliRuntimeCandidates(row).codex
}

function isRetiredPrimaryRecord(row: Record<string, any>): boolean {
  return isRetiredPrimaryAgentType(normalizePrimaryAgentType(row))
}

function recordName(row: Record<string, any>): string {
  return typeof row.displayName === 'string' && row.displayName.trim() ? row.displayName.trim()
    : typeof row.name === 'string' && row.name.trim() ? row.name.trim() : '(no name)'
}

function primaryLane(row: Record<string, any>): string {
  const type = normalizePrimaryAgentType(row)
  if (type === 'n8n') return 'n8n Primary'
  return namesRetiredCodexCliModel(row) ? 'Codex CLI Primary' : 'Claude Code CLI Primary'
}

function subagentLane(row: Record<string, any>): string {
  const type = normalizeSubagentType(row)
  if (type === 'n8n-workflow') return 'n8n Workflow Subagent'
  if (type === 'n8n-subnode') return 'n8n Subnode Subagent'
  return 'Codex CLI Subagent'
}

const CHAT_TITLES_SHOWN = 20

async function folderOf(profileId: string): Promise<RetiredTypeSweepFolder> {
  const folder = path.join(getManagedAgentRootDir(), profileId)
  const exists = await fs.lstat(folder).then(() => true, (error) => {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  })
  return { profileId, path: folder, exists }
}

/** The agent delete removes the folder named for the agent id (`deleteManagedProfileFolder`). */
const agentProfileFolderOf = (agentId: string) => folderOf(buildAgentProfileId(agentId))

/** The Subagent delete's own plan: the folder named for its slug, kept when another record shares it (BL-157). */
async function subagentProfileFolderOf(userId: string, row: Record<string, any>): Promise<RetiredTypeSweepFolder> {
  const { planManagedCliSubagentProfileDeletion } = await import('$lib/server/services/cliSubagentProfileSync')
  const plan = await planManagedCliSubagentProfileDeletion(userId, row as SubagentRow)
  const folder = await folderOf(plan.profileId)
  return plan.deleted ? folder : { ...folder, sharedWith: `${plan.sharedWithKind}:${plan.sharedWith}` }
}

/**
 * The agent delete's own Worker slot plan (`deleteAgentWorkerProfiles`): the folders that exist,
 * for the list, and every folder it would remove, present or not, for the shared-folder blocker.
 */
async function workerFoldersOf(userId: string, agentId: string): Promise<{ listed: RetiredTypeSweepFolder[]; removable: string[] }> {
  const { planAgentWorkerProfileDeletion } = await import('$lib/server/services/cliSubagentProfileSync')
  const plan = await planAgentWorkerProfileDeletion(userId, agentId)
  const folders = [
    ...await Promise.all(plan.deletable.map(({ profileId }) => folderOf(profileId))),
    ...await Promise.all(plan.kept.map(async ({ profileId, sharedWith, sharedWithKind }) =>
      ({ ...await folderOf(profileId), sharedWith: `${sharedWithKind}:${sharedWith}` }))),
  ]
  return { listed: folders.filter((folder) => folder.exists), removable: plan.deletable.map(({ profileId }) => profileId) }
}

/** A saved direct alias the sweep checks against folders it would remove. */
function profileAliasOf(row: Record<string, any>): string | null {
  const structured = row.claude_settings && typeof row.claude_settings === 'object' ? row.claude_settings.profileId : undefined
  const provider = row.provider_specific_settings && typeof row.provider_specific_settings === 'object' ? row.provider_specific_settings.claude_profile_id : undefined
  for (const value of [structured, provider]) if (typeof value === 'string' && value.trim()) return value.trim()
  return null
}

function planIdOf(items: RetiredTypeSweepItem[], blockers: string[]): string {
  const canonical = items.map((item) => [item.family, item.key, item.ownerless === true, item.primary ?? null, item.profileFolder ?? null, item.workerFolders ?? null])
  return createHash('sha256').update(JSON.stringify([canonical, blockers])).digest('hex').slice(0, 16)
}

/** Reads and lists. Writes nothing. */
export async function planRetiredTypeSweep(): Promise<RetiredTypeSweepPlan> {
  const items: RetiredTypeSweepItem[] = []
  const blockers: string[] = []

  for (const key of PRE_R4_APP_MARKER_KEYS) {
    if (await redis.exists(key)) {
      blockers.push(`${key} is still stored: the Batshit that runs on this Redis is older than SA-139 R4 (it seeds the old Claude Code CLI Primary prompt at every start). Install and start the R4 build first, then run the dry run again.`)
      break
    }
  }

  const sessionsByUser = new Map<string, Record<string, any>[]>()
  const sessionsOf = async (userId: string) => {
    if (!sessionsByUser.has(userId)) sessionsByUser.set(userId, await redis.getSessions(userId, true) as unknown as Record<string, any>[])
    return sessionsByUser.get(userId)!
  }

  const agents = await readRecords('agent:*', AGENT_KEY)
  /** Every Worker slot folder a retired Primary's delete would remove, present or not, by its agent key. */
  const removableWorkerFolders = new Map<string, string>()
  let apiAgentsWithClaudeSettings = 0
  for (const { key, row } of agents) {
    if (isRetiredPrimaryRecord(row)) {
      const userId = typeof row.user_id === 'string' && row.user_id ? row.user_id : undefined
      const agentId = key.slice('agent:'.length)
      const sessions = userId ? await sessionsOf(userId) : []
      const chats = selectAgentChats(sessions, agentId)
      const workers = userId ? await workerFoldersOf(userId, agentId) : null
      for (const profileId of workers?.removable ?? []) removableWorkerFolders.set(profileId, key)
      const titles = new Map(sessions.map((session) => [session.id, typeof session.title === 'string' && session.title.trim() ? session.title.trim().slice(0, 60) : '(no title)']))
      items.push({ family: 'retired-primary-agents', key, label: `${recordName(row)} (${primaryLane(row)})`, userId,
        ...(userId ? {} : { ownerless: true }),
        primary: {
          chats: chats.deletable.filter((chat) => !chat.fixed).length,
          infiniteSessions: chats.deletable.filter((chat) => chat.fixed).length,
          keptLockedChats: chats.keptLocked.length,
          memories: (await scanKeys(`memory:${agentId}:*`)).length,
          chatTitles: chats.deletable.slice(0, CHAT_TITLES_SHOWN).map((chat) => titles.get(chat.id) ?? '(no title)'),
        },
        profileFolder: await agentProfileFolderOf(agentId),
        ...(workers ? { workerFolders: workers.listed } : {}) })
    } else if (row.claude_settings && typeof row.claude_settings === 'object') {
      apiAgentsWithClaudeSettings += 1
    }
  }

  const subagents = await readRecords('subagent:*', SUBAGENT_KEY)
  const liveSubagentSlugs = new Set<string>()
  let claudeCliSubagents = 0
  for (const { key, row } of subagents) {
    if (isRetiredSubagentRecord(row)) {
      const userId = typeof row.user_id === 'string' && row.user_id ? row.user_id : undefined
      items.push({ family: 'retired-subagents', key, label: `${recordName(row)} (${subagentLane(row)})`, userId,
        ...(userId ? { profileFolder: await subagentProfileFolderOf(userId, row) } : { ownerless: true }) })
    } else {
      if (isCliSubagentType(normalizeSubagentType(row))) claudeCliSubagents += 1
      // The runtime names a Subagent's threads by its resolved slug; the raw fields are kept too.
      for (const slug of [resolveSubagentSlug({ ...row, id: row.id ?? key.slice('subagent:'.length) }), row.slug, row.id, key.slice('subagent:'.length)]) {
        if (typeof slug === 'string' && slug) liveSubagentSlugs.add(slug)
      }
    }
  }

  for (const key of await scanKeys('subagent_thread:*')) {
    if (await keyOfType(key, 'string', 'dry')) items.push({ family: 'subagent-thread-keys', key, label: 'n8n thread id' })
  }
  for (const key of await scanKeys('n8n:sse-callback:*')) {
    if (await keyOfType(key, 'string', 'dry')) items.push({ family: 'n8n-callback-keys', key, label: 'n8n callback token' })
  }
  for (const key of N8N_COMPATIBILITY_KEYS) {
    if (await keyOfType(key, 'ReJSON-RL', 'dry')) items.push({ family: 'n8n-compatibility-keys', key, label: 'n8n compatibility cache' })
  }
  for (const key of (await scanKeys('codex_cleanup_warnings:*')).filter((key) => CODEX_WARNING_INDEX_KEY.test(key))) {
    if (await keyOfType(key, 'set', 'dry')) items.push({ family: 'codex-cleanup-warnings', key, label: 'Codex warning list of a chat' })
  }
  for (const key of (await scanKeys('codex_cleanup_warning:*')).filter((key) => CODEX_WARNING_ITEM_KEY.test(key))) {
    if (await keyOfType(key, 'ReJSON-RL', 'dry')) items.push({ family: 'codex-cleanup-warnings', key, label: 'Codex warning of a reply' })
  }
  for (const key of await scanKeys('subagent_sessions:*')) {
    const match = N8N_MEMORY_KEY.exec(key)
    if (!match || liveSubagentSlugs.has(match[2])) continue
    if (await keyOfType(key, 'list', 'dry')) items.push({ family: 'n8n-workflow-memory', key, label: `n8n memory of Subagent slug ${match[2]}` })
  }

  const retiredRecordKeys = new Set(items.filter((item) => item.family === 'retired-primary-agents' || item.family === 'retired-subagents').map((item) => item.key))
  // A retired record's delete removes the folder named by its id. A surviving record's saved
  // direct alias naming that same folder would lose its target, so the apply refuses.
  const retiredFolders = new Map([
    ...items.filter((item) => item.profileFolder && !item.profileFolder.sharedWith && !item.ownerless)
      .map((item) => [item.profileFolder!.profileId, item.key] as const),
    ...removableWorkerFolders,
  ])
  for (const { key, row } of [...agents, ...subagents]) {
    if (retiredRecordKeys.has(key)) continue
    const alias = profileAliasOf(row)
    if (alias && retiredFolders.has(alias)) {
      blockers.push(`${key} (${recordName(row)}) retains a reference to profile folder ${alias}, which the delete of ${retiredFolders.get(alias)} would remove. Nothing can be deleted until that is sorted out by hand.`)
    }
  }
  for (const { key } of [...agents, ...subagents]) {
    if (retiredRecordKeys.has(key)) continue
    if (await codexSettingsField(key, 'dry')) items.push({ family: 'codex-settings-fields', key, label: 'codex_settings block' })
  }

  const codexPresets = (await readRecords('model:*', MODEL_KEY)).filter(({ row }) => {
    const connection = row.connection && typeof row.connection === 'object' ? row.connection : {}
    return connection.id === 'codex-cli' || connection.service === 'codex' || connection.service === 'openai-codex'
  }).length
  const kept: RetiredTypeSweepKept[] = [
    { what: 'claude_settings on API agents', count: apiAgentsWithClaudeSettings,
      reason: 'saved settings are retained; this sweep checks their explicit profile aliases' },
    { what: 'model presets on the removed Codex CLI connection', count: codexPresets,
      reason: 'model presets are not part of this sweep; delete them in Settings, Models, if wanted' },
    { what: 'Claude Code CLI Subagents', count: claudeCliSubagents,
      reason: 'SA-139 R5 retired the type, but nothing proves the app beside this Redis has R5; delete them in Settings' },
  ]

  const instanceOwners = [...new Set([...agents, ...subagents].map(({ row }) => row.user_id)
    .filter((owner): owner is string => typeof owner === 'string' && owner.length > 0))].sort()
  return { planId: planIdOf(items, blockers), items, kept, blockers, instanceOwners }
}

export type RetiredTypeSweepOwners = {
  deleteAgent: (agentId: string, userId: string, withChats: boolean) => Promise<Response>
  deleteSubagent: (subagentId: string, userId: string) => Promise<Response>
}

/** The real owners: the route handlers the Settings delete buttons call, run as the record's owner. */
export async function routeDeletionOwners(): Promise<RetiredTypeSweepOwners> {
  const agentRoute = await import('../../../routes/api/agents/[id]/+server')
  const subagentRoute = await import('../../../routes/api/subagents/[id]/+server')
  const call = (handler: unknown, id: string, userId: string, url: string) =>
    (handler as (event: Record<string, unknown>) => Promise<Response>)({
      params: { id }, locals: { user: { id: userId } }, url: new URL(url), request: new Request(url, { method: 'DELETE' })
    })
  return {
    deleteAgent: (agentId, userId, withChats) =>
      call(agentRoute.DELETE, agentId, userId, `http://127.0.0.1/api/agents/${encodeURIComponent(agentId)}${withChats ? '?chats=1' : ''}`),
    deleteSubagent: (subagentId, userId) =>
      call(subagentRoute.DELETE, subagentId, userId, `http://127.0.0.1/api/subagents/${encodeURIComponent(subagentId)}`),
  }
}

export type RetiredTypeSweepApplyResult = {
  plan: RetiredTypeSweepPlan
  done: RetiredTypeSweepItem[]
  /** Items whose key or record was already gone (or no longer of its kind) when their turn came. */
  gone: RetiredTypeSweepItem[]
  /** The item the apply stopped at. Its owner may have removed part of it (chats, pictures, references) before it failed. */
  failed: { item: RetiredTypeSweepItem; error: string } | null
}

/** The owner's whole answer, so a partial delete's own report (what went, what stayed) is not lost. */
async function responseError(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  return `HTTP ${response.status}${text ? `: ${text.slice(0, 1200)}` : ''}`
}

const APPLY_ORDER: RetiredTypeSweepFamilyId[] = ['retired-subagents', 'retired-primary-agents', 'subagent-thread-keys',
  'n8n-callback-keys', 'n8n-compatibility-keys', 'codex-cleanup-warnings', 'n8n-workflow-memory', 'codex-settings-fields']

function keyTypeOf(item: RetiredTypeSweepItem): string {
  if (item.family === 'codex-cleanup-warnings') return CODEX_WARNING_INDEX_KEY.test(item.key) ? 'set' : 'ReJSON-RL'
  if (item.family === 'n8n-compatibility-keys') return 'ReJSON-RL'
  if (item.family === 'n8n-workflow-memory') return 'list'
  return 'string'
}

/**
 * Deletes the plan's items. The caller passes the plan id the dry run printed; when the instance
 * no longer matches it, or the running app is older than R4, nothing is deleted. Ownerless records
 * are left as they are. Stops at the first failure and says what already went.
 * Subagents go first, so their assignments leave surviving agents before any agent delete reads them.
 */
export async function applyRetiredTypeSweep(options: {
  expectedPlanId: string
  chats: 'delete' | 'keep' | null
  owners?: RetiredTypeSweepOwners
}): Promise<RetiredTypeSweepApplyResult> {
  const plan = await planRetiredTypeSweep()
  if (plan.blockers.length > 0) {
    throw new Error(`Nothing was deleted. ${plan.blockers.join(' ')}`)
  }
  if (plan.planId !== options.expectedPlanId) {
    throw new Error(`The instance changed since the dry run (plan ${plan.planId}, expected ${options.expectedPlanId}). Nothing was deleted. Run the dry run again.`)
  }
  if (plan.items.some((item) => item.family === 'retired-primary-agents' && !item.ownerless) && options.chats !== 'delete' && options.chats !== 'keep') {
    throw new Error('The plan deletes retired Primary agents. Say what happens to their chats with --chats delete or --chats keep. Nothing was deleted.')
  }
  const owners = options.owners ?? await routeDeletionOwners()
  const done: RetiredTypeSweepItem[] = []
  const gone: RetiredTypeSweepItem[] = []
  for (const family of APPLY_ORDER) {
    for (const item of plan.items.filter((entry) => entry.family === family && !entry.ownerless)) {
      try {
        if (family === 'retired-subagents' || family === 'retired-primary-agents') {
          // Read again right before the owner runs: a record that changed type since the plan stops the apply.
          const row = await readRecord(item.key)
          if (!row) { gone.push(item); continue }
          if (family === 'retired-subagents' ? !isRetiredSubagentRecord(row) : !isRetiredPrimaryRecord(row)) {
            throw new Error('the record is no longer of a retired type, so it was not deleted')
          }
          const id = item.key.slice(item.key.indexOf(':') + 1)
          const response = family === 'retired-subagents'
            ? await owners.deleteSubagent(id, item.userId!)
            : await owners.deleteAgent(id, item.userId!, options.chats === 'delete')
          if (!response.ok) throw new Error(await responseError(response))
          done.push(item)
        } else {
          const removed = family === 'codex-settings-fields'
            ? await codexSettingsField(item.key, 'apply')
            : await keyOfType(item.key, keyTypeOf(item), 'apply')
          ;(removed ? done : gone).push(item)
        }
      } catch (error) {
        return { plan, done, gone, failed: { item, error: error instanceof Error ? error.message : String(error) } }
      }
    }
  }
  return { plan, done, gone, failed: null }
}
