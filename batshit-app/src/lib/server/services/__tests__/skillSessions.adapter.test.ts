// @vitest-environment node
import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs/promises'
import path from 'node:path'

/**
 * The existing adapter suite mocks zip persistence; the lifecycle suite begins with manually
 * stored canonical zips. This boundary needs both real owners: API utility step -> zip adapter ->
 * stored zip -> immediate skill admission, before reply finalization. Default Redis fake only. No
 * transport process, socket, provider call or installed runtime. SA-139 R5 removed the managed
 * Claude Code CLI lane and its event adapter (the only producer of the managed CLI helper's
 * `native_skill` step), so that lane's half of these cases went with it.
 */
const isolatedHome = vi.hoisted(() => ({ directory: '', previousBatshitHome: process.env.BATSHIT_HOME_DIR }))
vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>()
  const nodePath = await import('node:path')
  isolatedHome.directory = nodePath.join(actual.tmpdir(), `batshit-skill-adapter-home-${process.pid}-${Date.now()}`)
  // getBatshitHomeDir also honors this explicit override; isolate it before any skill module loads.
  process.env.BATSHIT_HOME_DIR = nodePath.join(isolatedHome.directory, '.batshit')
  const homedir = () => isolatedHome.directory
  return { ...actual, homedir, default: { ...actual, homedir } }
})
vi.mock('../systemSlashCommands', () => ({ ensureSystemSlashCommands: vi.fn() }))

import { redis } from '$lib/server/redis'
import { useSkillSessionCommitTwin } from '$lib/test-utils/skillSessionCommitTwin'
useSkillSessionCommitTwin()
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { initializedBuiltinPluginEntries, assertInitializedBuiltinPlugin } from '$lib/test-utils/initialized-builtin-plugin'
import { adaptCoolToolsToZipSystem } from '$lib/server/coolToolZipAdapter'
import { parseCoolToolPayload } from '$lib/utils/coolToolAiContent'
import { normalizeId } from '$lib/utils/idNormalizer'
import { normalizeToolArgs } from '../sseToolNormalization'
import { API_UTILITY_CONTROL_IDS } from '$lib/utils/apiUtilityControls'
import { executeSkillRuntimeAction } from '../skillRuntimeToolService'
import { readOpenSkillSessions, closeSkillSession } from '../skillSessions'

useRedisTestServer()
const actor = { userId: 'skill-adapter-user', sessionId: 'skill-adapter-chat', agentId: 'skill-adapter-primary' }
const skillId = 'artifact_creator'
let sequence = 0

beforeEach(async () => {
  for (const [key, value] of initializedBuiltinPluginEntries(actor.userId)) {
    await redis.json.set(key, '$', key === `agent_plugin:${actor.userId}:batshit`
      ? { ...value, enabled_agent_ids: [actor.agentId] } : value)
  }
  await assertInitializedBuiltinPlugin(actor.userId, (key) => redis.json.get(key))
  await redis.createSession({ id: actor.sessionId, user_id: actor.userId, agent_id: actor.agentId, title: 'Skill adapter test' } as any)
  await redis.createAgent({ id: actor.agentId, user_id: actor.userId, name: 'Reader', agentType: 'api' } as any)
})

afterAll(async () => {
  try {
    // Only the shipped built-in package is read; this suite must not materialize a skill install.
    await expect(fs.access(path.join(isolatedHome.directory, '.batshit', 'skills'))).rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    await fs.rm(isolatedHome.directory, { recursive: true, force: true })
    if (isolatedHome.previousBatshitHome === undefined) delete process.env.BATSHIT_HOME_DIR
    else process.env.BATSHIT_HOME_DIR = isolatedHome.previousBatshitHome
  }
})

/** The API lane's broker step for a skill read, as the utility runtime records it. */
function transportStep(args: Record<string, any>, raw: Record<string, any>, callId: string, failed = false): Record<string, any> {
  const target = API_UTILITY_CONTROL_IDS.skill
  return {
    toolName: 'native_batshit_tool_use', toolSource: 'native-tool', toolProvider: 'batshit-server', toolCallId: callId,
    toolArgs: normalizeToolArgs({ ref: `batshit:${target}`, input: args }, 'native_batshit_tool_use'),
    toolResult: { success: raw.success !== false, ref: `batshit:${target}`, family: 'batshit', target, controlId: target,
      operationKind: 'skill_read', rendererFamily: 'skill_read', result: raw },
    ...(failed ? { error: 'The skill read failed.' } : {})
  }
}

async function actualRead(action: 'invoke' | 'read' | 'list' = 'invoke', offset = 0) {
  const args = { skillId, action, ...(action === 'read' ? { path: 'SKILL.md', maxChars: 64, offset } : {}) }
  const raw = await executeSkillRuntimeAction({ userId: actor.userId, actor: { kind: 'agent', agentId: actor.agentId }, ...args })
  expect(raw.success).toBe(true)
  return { args, raw: raw as Record<string, any> }
}

async function persist(args: Record<string, any>, raw: Record<string, any>, options: { trusted?: boolean; failed?: boolean; claims?: boolean } = {}) {
  const callId = `skill-adapter-call-${++sequence}`
  const messageId = `skill-adapter-reply-${sequence}`
  const rawZipId = `cool_tool_1790000000000_adapter${sequence}x`
  const step = transportStep(args, raw, callId, options.failed)
  if (options.claims) {
    step.skillSessionActor = actor
    step.metadata = { ...step.metadata, skillSessionActor: actor, userId: actor.userId, agentId: actor.agentId, primary: true }
    step.toolResult = { ...step.toolResult, skillSessionActor: actor, primary: true }
  }
  const settings = { reservedZipIdsByToolCallId: new Map([[callId, rawZipId]]),
    ...(options.trusted === false ? {} : { skillSessionActor: { userId: actor.userId, agentId: actor.agentId } }) }
  const references = await adaptCoolToolsToZipSystem([step], actor.sessionId, messageId, {}, undefined, settings)
  expect(references).toHaveLength(1)
  const stored = await redis.getZip(rawZipId)
  expect(stored?.metadata).toMatchObject({ sessionId: actor.sessionId, messageId, toolCallId: callId })
  return { references, stored, step, settings, messageId, rawZipId }
}

describe.each(['api'] as const)('%s skill-read persistence reaches immediate lifecycle admission', () => {
  it('opens on the actual invoke result before any reply finalization and keeps transport provenance', async () => {
    const { args, raw } = await actualRead()
    const { references, stored, rawZipId } = await persist(args, raw)
    expect(references[0].skillSessionError).toBeUndefined()
    expect(references[0].skillSessionChanged).toBe(true)
    const sessions = await readOpenSkillSessions(actor)
    expect(sessions).toHaveLength(1)
    expect(sessions[0]).toMatchObject({ skillId, generation: 1, status: 'open', reads: [{ path: 'SKILL.md', rawZipId }] })
    expect(stored?.metadata?.skillSessionAdmission).toMatchObject({ agentId: actor.agentId, skillId, generation: 1, automatic: true })
    expect(stored?.metadata?.operationKind).toBe('skill_read')
    const payload = parseCoolToolPayload(stored?.content)!
    expect(payload.toolArgs).toMatchObject({ skillId, action: 'invoke', path: 'SKILL.md' })
    expect(payload.originalToolName).toContain('native_batshit_tool_use')
    expect(stored?.metadata?.toolProvider).toBe('batshit-server')
    expect(stored?.metadata?.toolSource).toBe('native-tool')
  })

  it('holds two real partial windows separately and keeps original offsets/content in their retained RAW records', async () => {
    const windows = await Promise.all([actualRead('read', 64), actualRead('read', 128)])
    for (const { args, raw } of windows) {
      const { references, stored, rawZipId } = await persist(args, raw)
      expect(references[0].skillSessionChanged).toBe(true)
      const payload = parseCoolToolPayload(stored?.content)!
      expect(payload.toolArgs).toMatchObject({ skillId, path: 'SKILL.md', action: 'read' })
      const retained = await redis.getZip(payload.rawSidecar.zipId)
      expect(retained?.type).toBe('tool_raw')
      expect(retained?.content).toContain(JSON.stringify('offset') + ':' + args.offset)
      // Inspect the actual retained wire shape rather than reconstructing a normalized fake.
      const retainedPayload = parseCoolToolPayload(retained?.content)!
      const wireRead = retainedPayload.toolResult.result
      expect(wireRead).toMatchObject({ skillId, path: 'SKILL.md', offset: args.offset, content: raw.content })
      const hold = await redis.json.get(`unzipped_item:${actor.sessionId}:${normalizeId(rawZipId)}`) as any
      expect(hold).toMatchObject({ permanent: true, agentId: actor.agentId, skillSession: { skillId, automatic: true } })
    }
    const [session] = await readOpenSkillSessions(actor)
    expect(session.reads).toHaveLength(2)
    expect(new Set(session.reads.map((read) => read.rawZipId)).size).toBe(2)
  })

  it('does not reopen a user-closed session when the same reserved call is finalized twice', async () => {
    const { args, raw } = await actualRead()
    const first = await persist(args, raw)
    expect((await closeSkillSession({ ...actor, skillId, provenance: 'user' })).status).toBe('closed')
    const zipIdsBefore = await redis.sMembers(`session:${actor.sessionId}:zips`)
    const repeated = await adaptCoolToolsToZipSystem([first.step, { ...first.step }], actor.sessionId, first.messageId, {}, undefined, first.settings)
    expect(repeated).toHaveLength(1)
    expect(repeated[0].skillSessionChanged).toBe(false)
    expect(repeated[0].skillSessionError).toBeUndefined()
    expect(await readOpenSkillSessions(actor)).toEqual([])
    const stored = await redis.getZip(first.rawZipId)
    expect(stored?.metadata?.skillSessionAdmission).toEqual(first.stored?.metadata?.skillSessionAdmission)
    expect(stored).toEqual(first.stored)
    expect(await redis.sMembers(`session:${actor.sessionId}:zips`)).toEqual(zipIdsBefore)
    expect(await redis.json.get(`unzipped_item:${actor.sessionId}:${normalizeId(first.rawZipId)}`)).toBeNull()
  })

  it('refuses same-call finalize on a failed previous-source read before rewriting original or RAW data', async () => {
    const { args, raw } = await actualRead()
    const first = await persist(args, raw)
    await closeSkillSession({ ...actor, skillId, provenance: 'user' })
    const zipIds = await redis.sMembers(`session:${actor.sessionId}:zips`)
    const originals = await Promise.all(zipIds.map((id) => redis.json.get(`zip:${id}`)))
    const originalGet = (redis.json.get as any).getMockImplementation()
    const read = vi.spyOn(redis.json, 'get').mockImplementation(async (key, ...rest) => {
      if (key === `zip:${first.rawZipId}`) throw new Error('injected unavailable previous source')
      return originalGet(key, ...rest)
    })
    try {
      const repeated = await adaptCoolToolsToZipSystem([first.step], actor.sessionId, first.messageId, {}, undefined, first.settings)
      expect(repeated).toMatchObject([{ reference: '', skillSessionError: expect.stringContaining('did not rewrite or reopen') }])
    } finally { read.mockRestore() }
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await redis.sMembers(`session:${actor.sessionId}:zips`)).toEqual(zipIds)
    expect(await Promise.all(zipIds.map((id) => redis.json.get(`zip:${id}`)))).toEqual(originals)
  })

  it('does not turn an unconfirmed first admission into a new read during finalize', async () => {
    const { args, raw } = await actualRead()
    const originalGet = (redis.json.getRaw as any).getMockImplementation()
    const read = vi.spyOn(redis.json, 'getRaw').mockImplementation(async (key, ...rest) => {
      if (key === `skill_sessions:${actor.sessionId}`) throw new Error('injected unavailable lifecycle')
      return originalGet(key, ...rest)
    })
    let first: Awaited<ReturnType<typeof persist>>
    try { first = await persist(args, raw) }
    finally { read.mockRestore() }
    expect(first.references[0].skillSessionError).toBeTruthy()
    expect(first.stored?.metadata?.skillSessionReadReceipt).toBeTruthy()
    expect(first.stored?.metadata?.skillSessionAdmission).toBeUndefined()
    const repeated = await adaptCoolToolsToZipSystem([first.step], actor.sessionId, first.messageId, {}, undefined, first.settings)
    expect(repeated[0].skillSessionError).toContain('not confirmed open')
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await redis.getZip(first.rawZipId)).toEqual(first.stored)
  })

  it('never accepts caller claims or a delegated persistence path as Primary admission authority', async () => {
    const { args, raw } = await actualRead()
    const { references } = await persist(args, { ...raw, userId: 'forged-user', agentId: 'forged-agent' }, { trusted: false, claims: true })
    expect(references[0].skillSessionChanged).toBe(false)
    expect(await readOpenSkillSessions(actor)).toEqual([])
    expect(await redis.json.get(`skill_sessions:${actor.sessionId}`)).toBeNull()
  })

  it.each(['refused', 'failed', 'list'] as const)('%s results cannot open a skill', async (kind) => {
    const read = await actualRead(kind === 'list' ? 'list' : 'invoke')
    const raw = kind === 'refused' ? { success: false, action: 'invoke', skillId, blocked: true, errorCode: 'SKILL_NOT_ENABLED', error: 'Skill access refused.' }
      : kind === 'failed' ? { success: false, action: 'invoke', skillId, error: 'Skill read failed.' } : read.raw
    const { references } = await persist(read.args, raw, { failed: kind === 'failed' })
    expect(references[0].skillSessionChanged).not.toBe(true)
    expect(await readOpenSkillSessions(actor)).toEqual([])
  })
})
