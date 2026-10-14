// @vitest-environment node
/**
 * SA-122 A-1z F1 — managed Codex/Claude caller parity for the fixed Settings writes, model-free.
 *
 * B1 (`send-routed-chatgpt-plan.test.ts`) proves the API lane's originating chain. A managed CLI
 * reply reaches the same Settings owners another way, and this file proves that way:
 *
 *   the shipped helper (`scripts/mode4-controls-mcp.cjs`, a real child process spoken to over
 *   MCP stdio, the way Codex and Claude speak to it) → real loopback HTTP → the real
 *   `/api/controls/use` route (and the Codex helper's `/api/native-tools/guard-result`) → a real
 *   run credential from `mintCliRunCredential`, the bridges' own seam → the real Stop registry
 *   and interrupt route → `useControl`, Settings admission, the risk gate and approval records →
 *   the conditional Settings owner on real Redis.
 *
 * Stand-ins, named: the vendor CLI (the MCP SDK client chooses the call, a mocked scheduler), and
 * the originating run's two call sites (`registerStreamAbort` as send-routed calls it, and the
 * mint and revoke as the bridges call them). Not used, because they are not equivalent: a body
 * identity, an unminted token, a never-aborting controller, a request signal.
 *
 * BL-1314: a Settings write is admitted only on the Stop of the EXACT reply its credential names.
 * C6 holds a still-valid credential of an earlier reply while a newer reply runs; it is refused.
 *
 * The Settings store needs real Redis (EVAL), so the lane is real only.
 */
import path from 'node:path'
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { mintCliRunCredential } from '$lib/server/services/cliHelperToken'
import { revokeRunCredential } from '$lib/server/services/agentRunCredentials'
import {
  __resetStreamAbortRegistryForTests,
  abortStream,
  clearStreamAbort,
  getActiveStream,
  registerStreamAbort
} from '$lib/server/services/streamAbortRegistry'
import { decideApproval, getControlApproval, listSessionApprovals } from '$lib/server/services/controlApprovals'
import { POST as controlsUse } from './+server'
import { POST as guardResult } from '../../native-tools/guard-result/+server'
import { POST as interrupt } from '../../messages/interrupt/+server'

useRedisTestServer()

const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'
const USER = 'a1z-parity-user'
const AGENT = 'a1z_parity_agent'
const SESSION = 'a1z-parity-session'
const REPLY_ONE = 'a1z-parity-reply-1'
const REPLY_TWO = 'a1z-parity-reply-2'
const IDENTITY = 'sys.ui.settings_agent_identity_update'
const MEMORY = 'sys.ui.settings_agent_memory_update'
const HELPER = path.resolve('scripts/mode4-controls-mcp.cjs')
const OWNER = { actor: { kind: 'agent' as const, userId: USER, actingAgentId: AGENT }, check() {} }

type Runtime = 'codex' | 'claude'
type Hit = { path: string; status: number; headers: IncomingHttpHeaders; requestBody: any; body: any }

describe.runIf(REAL_REDIS_LANE)('SA-122 F1 managed caller parity for the fixed Settings writes', () => {
  let hits: Hit[]
  let server: Server
  let baseUrl: string

  beforeEach(async () => {
    __resetStreamAbortRegistryForTests()
    hits = []
    // The app's two helper routes on one loopback socket, in this process: the Stop registry the
    // route reads is the one this file registers into (as send-routed does in the app process).
    server = createServer(async (incoming, outgoing) => {
      const pathname = new URL(incoming.url ?? '/', 'http://127.0.0.1').pathname
      try {
        const chunks: Buffer[] = []
        for await (const chunk of incoming) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks)
        const route = pathname === '/api/controls/use' ? controlsUse
          : pathname === '/api/native-tools/guard-result' ? guardResult
            : null
        if (!route) {
          hits.push({ path: pathname, status: 404, headers: incoming.headers, requestBody: null, body: null })
          outgoing.writeHead(404, { 'content-type': 'application/json' })
          outgoing.end('{}')
          return
        }
        const reply = await route({
          locals: {},
          request: new Request(`http://127.0.0.1${incoming.url}`, {
            method: incoming.method,
            headers: incoming.headers as HeadersInit,
            body: raw
          })
        } as any)
        const text = await reply.text()
        hits.push({
          path: pathname,
          status: reply.status,
          headers: incoming.headers,
          requestBody: raw.length > 0 ? JSON.parse(raw.toString('utf8')) : null,
          body: text ? JSON.parse(text) : null
        })
        outgoing.writeHead(reply.status, Object.fromEntries(reply.headers))
        outgoing.end(text)
      } catch (error) {
        hits.push({ path: pathname, status: 500, headers: incoming.headers, requestBody: null, body: { error: String(error) } })
        outgoing.writeHead(500, { 'content-type': 'application/json' })
        outgoing.end(JSON.stringify({ error: String(error) }))
      }
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    const address = server.address()
    if (!address || typeof address === 'string') throw new Error('The app route fixture has no port')
    baseUrl = `http://127.0.0.1:${address.port}`

    await redis.createAgent({ id: AGENT, user_id: USER, name: 'Parity Fixture', agentType: 'cli', memory_enabled: false } as any)
    await redis.execute((client) => client.json.set(`agent:${AGENT}`, '$.displayName', 'Fixture Name'))
    await redis.createSession({ id: SESSION, user_id: USER, title: 'A-1z managed parity', agent_id: AGENT } as any)
  })

  afterEach(async () => {
    vi.restoreAllMocks()
    __resetStreamAbortRegistryForTests()
    server.closeAllConnections()
    if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  /** What the bridge does at run start: one credential for this user, agent, chat and reply. */
  async function mint(runtime: Runtime, messageId: string | null) {
    return await mintCliRunCredential({ userId: USER, agentId: AGENT, sessionId: SESSION, messageId, runtime })
  }

  /** What send-routed does before the bridge runs (`send-routed/+server.ts`, registerStreamAbort). */
  function startReply(messageId: string) {
    const controller = new AbortController()
    registerStreamAbort(SESSION, messageId, controller)
    return controller
  }

  /** The shipped helper with the env the managed profile forwards; the MCP client plays the CLI. */
  async function withHelper<T>(
    runtime: Runtime,
    credential: { token: string },
    messageId: string | null,
    use: (call: (controlId: string, input: Record<string, unknown>) => Promise<unknown>) => Promise<T>
  ): Promise<T> {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [HELPER],
      stderr: 'pipe',
      env: {
        PATH: process.env.PATH ?? '',
        // The helper exits at startup without a user id (`--user` or BATSHIT_USER_ID); the
        // managed profiles pass it. It is never sent: the credential names the user.
        BATSHIT_USER_ID: USER,
        BATSHIT_AGENT_ID: AGENT,
        BATSHIT_SESSION_ID: SESSION,
        BATSHIT_AGENT_TOKEN: credential.token,
        BATSHIT_CLI_RUNTIME: runtime,
        BATSHIT_CLI_HELPER_BASE_URL: baseUrl,
        ...(messageId ? { BATSHIT_MESSAGE_ID: messageId } : {})
      }
    })
    const client = new Client({ name: 'a1z-managed-parity', version: '1' })
    await client.connect(transport)
    try {
      // The assertions read the route's own answers (`hits`). A Codex helper posts every result to
      // the guard route, which refuses a credential with no reply or a revoked one; the helper then
      // throws, and the MCP call rejects. That rejection is the CLI's business, not this proof's.
      return await use(async (controlId, input) => {
        try {
          return await client.callTool({ name: 'batshit_tool_use', arguments: { ref: `fabric:${controlId}`, input } })
        } catch (error) {
          return { rejected: String(error) }
        }
      })
    } finally {
      await client.close()
    }
  }

  /** The user's Stop, through the actual interrupt route. */
  async function userStop(messageId: string) {
    const response = await interrupt({
      request: new Request('http://127.0.0.1/api/messages/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: SESSION, messageId })
      }),
      locals: { user: { id: USER } }
    } as any)
    return await response.json()
  }

  async function settingsOwner() {
    return (await import('$lib/server/services/appActions/settings/server')).ownAgentSettings
  }

  async function agentRecord() {
    return await redis.execute((client) => client.json.get(`agent:${AGENT}`)) as any
  }

  /** Pass-through: the real publisher still runs; only the A-1y announcement is recorded. */
  async function watchAnnouncements() {
    const publisher = await import('$lib/server/ssePublisher')
    const seen: Array<{ userId: string; event: Record<string, unknown> }> = []
    const actual = publisher.publishUserEvent
    vi.spyOn(publisher, 'publishUserEvent').mockImplementation(async (userId, event) => {
      if (event?.type === 'agent_settings_changed') seen.push({ userId, event })
      return actual(userId, event)
    })
    return seen
  }

  function controlHits() {
    return hits.filter((hit) => hit.path === '/api/controls/use')
  }

  function why(extra: Record<string, unknown> = {}) {
    return JSON.stringify({ ...extra, hits }).slice(0, 6000)
  }

  /** The wire the helper used: header credential only, no identity in the body (SA-117). */
  function expectCredentialOnlyWire(hit: Hit, token: string, messageId: string | null) {
    expect(hit.headers['x-batshit-agent-token']).toBe(token)
    expect(hit.requestBody).not.toHaveProperty('userId')
    expect(hit.requestBody).not.toHaveProperty('agentId')
    if (messageId) expect(hit.requestBody.messageId).toBe(messageId)
    else expect(hit.requestBody).not.toHaveProperty('messageId')
  }

  describe.each(['codex', 'claude'] as const)('a %s run credential', (runtime) => {
    it('C1 Stop through the actual interrupt route during the safe identity write: nothing written, no record, no announcement', async () => {
      const ownAgentSettings = await settingsOwner()
      const before = await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)
      const recordBefore = await agentRecord()
      const reply = startReply(REPLY_ONE)
      const credential = await mint(runtime, REPLY_ONE)
      const announced = await watchAnnouncements()
      const actual = ownAgentSettings.updateIdentity
      let stopAnswer: any
      let ownerRefusal: any
      // The user's Stop lands while the reply is live, right before the real owner runs.
      const update = vi.spyOn(ownAgentSettings, 'updateIdentity').mockImplementation(async (args, context) => {
        stopAnswer = await userStop(REPLY_ONE)
        try { return await actual(args, context) } catch (error) { ownerRefusal = error; throw error }
      })

      await withHelper(runtime, credential, REPLY_ONE, (call) =>
        call(IDENTITY, { subjectAgentId: AGENT, expectedRevision: before.revision, changes: { displayName: 'Stopped Name' } }))

      const [hit] = controlHits()
      expect(controlHits(), why()).toHaveLength(1)
      expectCredentialOnlyWire(hit, credential.token, REPLY_ONE)
      expect(update, why()).toHaveBeenCalledTimes(1)
      expect(stopAnswer, why({ stopAnswer })).toMatchObject({ success: true, activeMessageId: REPLY_ONE })
      expect(reply.signal.aborted).toBe(true)
      expect(ownerRefusal?.reason, why({ ownerRefusal: String(ownerRefusal) })).toBe('caller_stopped')
      expect(hit.status, why()).toBe(200)
      expect(hit.body).toMatchObject({ auth: 'agent', actingAgentId: AGENT, success: true,
        result: { status: 'blocked', reason: 'caller_stopped' } })
      // The owner writes displayName and updated_at together; neither moved.
      expect(await agentRecord()).toMatchObject({ displayName: 'Fixture Name', updated_at: recordBefore.updated_at })
      expect((await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)).revision).toBe(before.revision)
      expect(await listSessionApprovals(SESSION, USER)).toEqual([])
      expect(announced).toEqual([])
      await revokeRunCredential(credential.credentialId, { agentId: AGENT })
    }, 30_000)

    it('C2 no live reply, a stopped reply, or a credential with no reply: both writes refused before any card or owner', async () => {
      const ownAgentSettings = await settingsOwner()
      const identityBefore = await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)
      const memoryBefore = await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)
      const updateIdentity = vi.spyOn(ownAgentSettings, 'updateIdentity')
      const updateMemory = vi.spyOn(ownAgentSettings, 'updateMemory')
      const announced = await watchAnnouncements()
      const writes: Array<[string, Record<string, unknown>]> = [
        [IDENTITY, { subjectAgentId: AGENT, expectedRevision: identityBefore.revision, changes: { displayName: 'Refused Name' } }],
        [MEMORY, { subjectAgentId: AGENT, expectedRevision: memoryBefore.revision, changes: { onMyMind: 20 } }]
      ]
      const states: Array<{ label: string; messageId: string | null; setUp: () => void }> = [
        { label: 'no live reply', messageId: REPLY_ONE, setUp: () => {} },
        { label: 'a stopped reply', messageId: REPLY_ONE, setUp: () => { startReply(REPLY_ONE); abortStream(SESSION, 'user') } },
        { label: 'a credential that names no reply', messageId: null, setUp: () => { startReply(REPLY_ONE) } }
      ]

      for (const state of states) {
        __resetStreamAbortRegistryForTests()
        hits.length = 0
        state.setUp()
        const credential = await mint(runtime, state.messageId)
        await withHelper(runtime, credential, state.messageId, async (call) => {
          for (const [controlId, input] of writes) await call(controlId, input)
        })
        const refused = controlHits()
        expect(refused, why({ state: state.label })).toHaveLength(2)
        for (const hit of refused) {
          expectCredentialOnlyWire(hit, credential.token, state.messageId)
          expect(hit.status, why({ state: state.label })).toBe(403)
          expect(hit.body, state.label).toMatchObject({ auth: 'agent', actingAgentId: AGENT, success: false,
            error: { code: 'CONTROL_CANCELLATION_REQUIRED' } })
          expect(hit.body.approvalRequest, state.label).toBeUndefined()
        }
        await revokeRunCredential(credential.credentialId, { agentId: AGENT })
      }

      expect(updateIdentity).not.toHaveBeenCalled()
      expect(updateMemory).not.toHaveBeenCalled()
      // Admission comes before the card on this lane: no approval record at all.
      expect(await listSessionApprovals(SESSION, USER)).toEqual([])
      expect((await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)).revision).toBe(identityBefore.revision)
      expect((await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)).revision).toBe(memoryBefore.revision)
      expect(announced).toEqual([])
    }, 60_000)

    it('C3-C4 the confirm-risk memory write pauses with a cli card, then an approved retry under the next run spends it once and writes once', async () => {
      const ownAgentSettings = await settingsOwner()
      const before = await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)
      const next = before.values.triggerLingerTurns === 1 ? 2 : 1
      const input = { subjectAgentId: AGENT, expectedRevision: before.revision, changes: { triggerLingerTurns: next } }
      const updateMemory = vi.spyOn(ownAgentSettings, 'updateMemory')
      const announced = await watchAnnouncements()

      // C3: the first run asks; the card is pinned to its own live reply.
      startReply(REPLY_ONE)
      const first = await mint(runtime, REPLY_ONE)
      await withHelper(runtime, first, REPLY_ONE, (call) => call(MEMORY, input))
      const [paused] = controlHits()
      expect(controlHits(), why()).toHaveLength(1)
      expectCredentialOnlyWire(paused, first.token, REPLY_ONE)
      expect(paused.status, why()).toBe(403)
      expect(paused.body).toMatchObject({ auth: 'agent', actingAgentId: AGENT, success: false,
        error: { code: 'CONTROL_RISK_REQUIRES_APPROVAL' },
        approvalRequest: { controlId: MEMORY, riskLevel: 'confirm', lane: 'cli' } })
      const approvalId = paused.body.approvalRequest.approvalId
      expect(await getControlApproval(approvalId)).toMatchObject({ status: 'pending', controlId: MEMORY, lane: 'cli',
        userId: USER, agentId: AGENT, sessionId: SESSION, messageId: REPLY_ONE })
      expect(updateMemory).not.toHaveBeenCalled()
      expect(announced).toEqual([])
      expect((await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)).revision).toBe(before.revision)

      // The run ends the way the bridge ends it, and the user clicks Approve (the click's writer).
      clearStreamAbort(SESSION, REPLY_ONE)
      await revokeRunCredential(first.credentialId, { agentId: AGENT })
      expect(await decideApproval({ userId: USER, approvalId, approved: true })).toMatchObject({ status: 'approved' })

      // C4: the click's resume turn is a NEW reply with a newly minted credential; the agent retries.
      hits.length = 0
      startReply(REPLY_TWO)
      const second = await mint(runtime, REPLY_TWO)
      await withHelper(runtime, second, REPLY_TWO, async (call) => {
        await call(MEMORY, input)
        // The same call once more: the spent approval cannot run it again.
        await call(MEMORY, input)
      })
      const [retry, again] = controlHits()
      expect(controlHits(), why()).toHaveLength(2)
      expectCredentialOnlyWire(retry, second.token, REPLY_TWO)
      expect(retry.status, why()).toBe(200)
      expect(retry.body).toMatchObject({ auth: 'agent', actingAgentId: AGENT, success: true,
        result: { status: 'completed', saved: 'saved', readback: 'verified' } })
      expect(updateMemory, why()).toHaveBeenCalledTimes(1)
      const spent = await getControlApproval(approvalId)
      expect(spent).toMatchObject({ status: 'consumed' })
      expect(spent?.decidedAt).toBeTruthy()
      expect(spent?.consumedAt).toBeTruthy()
      expect((await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)).values.triggerLingerTurns).toBe(next)
      expect((await agentRecord()).memory_linger_turns).toBe(next)
      expect(announced).toHaveLength(1)
      expect(announced[0]).toMatchObject({ userId: USER, event: { type: 'agent_settings_changed', agentId: AGENT, family: 'memory' } })

      expect(again.status, why()).toBe(403)
      expect(again.body).toMatchObject({ error: { code: 'CONTROL_RISK_REQUIRES_APPROVAL' },
        approvalRequest: { lane: 'cli' } })
      expect(again.body.approvalRequest.approvalId).not.toBe(approvalId)
      expect(updateMemory).toHaveBeenCalledTimes(1)
      const approvals = await listSessionApprovals(SESSION, USER)
      expect(approvals.map((entry) => entry.status).sort()).toEqual(['consumed', 'pending'])
      await revokeRunCredential(second.credentialId, { agentId: AGENT })
    }, 60_000)

    it('C5 a revoked credential is refused before anything runs', async () => {
      const ownAgentSettings = await settingsOwner()
      const before = await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)
      const updateIdentity = vi.spyOn(ownAgentSettings, 'updateIdentity')
      startReply(REPLY_ONE)
      const credential = await mint(runtime, REPLY_ONE)
      await revokeRunCredential(credential.credentialId, { agentId: AGENT })

      await withHelper(runtime, credential, REPLY_ONE, (call) =>
        call(IDENTITY, { subjectAgentId: AGENT, expectedRevision: before.revision, changes: { displayName: 'Revoked Name' } }))

      const [hit] = controlHits()
      expect(controlHits(), why()).toHaveLength(1)
      expect(hit.status, why()).toBe(401)
      expect(hit.body).toMatchObject({ success: false, error: { code: 'CONTROL_NOT_ALLOWED' } })
      expect(updateIdentity).not.toHaveBeenCalled()
      expect((await agentRecord()).displayName).toBe('Fixture Name')
      expect(await listSessionApprovals(SESSION, USER)).toEqual([])
    }, 30_000)

    it('C6 BL-1314: a still-valid credential of an earlier reply cannot write while a newer reply runs; the newer run can', async () => {
      const ownAgentSettings = await settingsOwner()
      const identityBefore = await ownAgentSettings.readIdentity({ subjectAgentId: AGENT }, OWNER)
      const memoryBefore = await ownAgentSettings.readMemory({ subjectAgentId: AGENT }, OWNER)
      const updateIdentity = vi.spyOn(ownAgentSettings, 'updateIdentity')
      const updateMemory = vi.spyOn(ownAgentSettings, 'updateMemory')
      const announced = await watchAnnouncements()

      // The earlier run's reply ends, but its credential is not revoked yet; a newer reply runs.
      startReply(REPLY_ONE)
      const earlier = await mint(runtime, REPLY_ONE)
      clearStreamAbort(SESSION, REPLY_ONE)
      const newer = startReply(REPLY_TWO)

      await withHelper(runtime, earlier, REPLY_ONE, async (call) => {
        await call(IDENTITY, { subjectAgentId: AGENT, expectedRevision: identityBefore.revision, changes: { displayName: 'Stale Name' } })
        await call(MEMORY, { subjectAgentId: AGENT, expectedRevision: memoryBefore.revision, changes: { onMyMind: 20 } })
      })
      const stale = controlHits()
      expect(stale, why()).toHaveLength(2)
      for (const hit of stale) {
        expectCredentialOnlyWire(hit, earlier.token, REPLY_ONE)
        // Still valid (the agent lane, not a 401), and still refused: the live reply is not its own.
        expect(hit.status, why()).toBe(403)
        expect(hit.body).toMatchObject({ auth: 'agent', actingAgentId: AGENT, success: false,
          error: { code: 'CONTROL_CANCELLATION_REQUIRED' } })
        expect(hit.body.approvalRequest).toBeUndefined()
      }
      expect(updateIdentity).not.toHaveBeenCalled()
      expect(updateMemory).not.toHaveBeenCalled()
      expect(await agentRecord()).toMatchObject({ displayName: 'Fixture Name' })
      expect(await listSessionApprovals(SESSION, USER)).toEqual([])
      expect(announced).toEqual([])
      // The newer reply was never touched.
      expect(newer.signal.aborted).toBe(false)
      expect(getActiveStream(SESSION)?.messageId).toBe(REPLY_TWO)

      // Contrast: the newer run's own credential is admitted and saves.
      hits.length = 0
      const current = await mint(runtime, REPLY_TWO)
      await withHelper(runtime, current, REPLY_TWO, (call) =>
        call(IDENTITY, { subjectAgentId: AGENT, expectedRevision: identityBefore.revision, changes: { displayName: 'Current Name' } }))
      const [saved] = controlHits()
      expect(controlHits(), why()).toHaveLength(1)
      expect(saved.status, why()).toBe(200)
      expect(saved.body).toMatchObject({ auth: 'agent', actingAgentId: AGENT, success: true, result: { saved: 'saved' } })
      expect(updateIdentity).toHaveBeenCalledTimes(1)
      expect((await agentRecord()).displayName).toBe('Current Name')
      expect(announced).toHaveLength(1)
      expect(announced[0]).toMatchObject({ userId: USER, event: { type: 'agent_settings_changed', agentId: AGENT, family: 'identity' } })
      await revokeRunCredential(earlier.credentialId, { agentId: AGENT })
      await revokeRunCredential(current.credentialId, { agentId: AGENT })
    }, 60_000)
  })
})
