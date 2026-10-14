import { afterEach, describe, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { POST } from '../../../../routes/api/native-tools/dispatch/+server'
import { mintRunCredential, revokeRunCredential } from '../agentRunCredentials'
import { bindDispatchContextIdentity } from '../actingAgentIdentity'
import { nativeToolService } from '../nativeTools'
import { hostOwnerResource } from '../hostCommandOwnership'
import { HostCommandRecordStore } from '../hostCommandRecords'
import { endLiveOwnedCommandGroups } from '../ownedCommandGroup'

useRedisTestServer()

const directories: string[] = []
const keys: string[] = []
const credentials: Array<{ credentialId: string; agentId: string }> = []
afterEach(async () => {
  await endLiveOwnedCommandGroups()
  for (const entry of credentials.splice(0)) await revokeRunCredential(entry.credentialId, { agentId: entry.agentId })
  for (const key of keys.splice(0)) await redis.del(key)
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})
const quote = (text: string) => `'${text.replace(/'/g, `'\\''`)}'`

describe('real delegated Bash authentication, dispatch and guardian ownership', () => {
  for (const kind of ['subagent', 'worker'] as const) {
    it(`${kind} helper shape is refused before any shell, and the API tool keeps the stored physical owner`, async () => {
      const suffix = randomUUID()
      const userId = `owner-proof-${suffix}`
      const parentId = `parent-${suffix}`
      const subagentId = `named-${suffix}`
      const runtimeId = `subagent_cli_${suffix.replaceAll('-', '')}`
      const sessionId = `session-${suffix}`
      const directory = await mkdtemp(path.join(os.tmpdir(), 'delegated-bash-owner-'))
      directories.push(directory)
      const marker = path.join(directory, 'command-ran')
      const nativeTools = { executionBackend: 'local', bashEnabled: true, bashAccessMode: 'dangerous' }
      await redis.set(`agent:${parentId}`, { id: parentId, user_id: userId, provider_specific_settings: { nativeTools } } as any)
      await redis.set(`subagent:${subagentId}`, { id: subagentId, user_id: userId, provider_specific_settings: { nativeTools } } as any)
      keys.push(`agent:${parentId}`, `subagent:${subagentId}`)
      const processOwner = { userId, kind: kind === 'worker' ? 'agent' as const : 'subagent' as const, id: kind === 'worker' ? parentId : subagentId }
      const run = await mintRunCredential({ userId, agentId: runtimeId, sessionId, runtime: 'codex',
        delegated: true, scopeAgentId: kind === 'worker' ? 'worker_researcher' : subagentId,
        allowedControlIds: [], processOwner, commandParentAgentId: parentId,
        delegatedBashEnabled: true } as any)
      credentials.push({ credentialId: run.credentialId, agentId: runtimeId })
      // BL-878: the managed CLI helper's Bash is refused on the agent lane before anything else
      // (BL-743 had made this exact path run; its credential fields still exist, and the agent
      // lane no longer reaches them). Historical route binding produced a virtual Primary id and
      // is refused the same way, since the refusal reads only the credential's lane.
      const helperContext = { actor_type: 'primary', mode: 'mode4' }
      const oldBinding = bindDispatchContextIdentity({ auth: 'agent', agentId: runtimeId, sessionId, delegated: true } as any, helperContext)
      expect(oldBinding.ok).toBe(true)
      const before = await nativeToolService.dispatchNativeAutomationPackAction({ userId, action: 'bash_execute',
        payloadInput: { command: 'true' }, context: (oldBinding as any).context,
        actorType: 'agent', delegatedRun: true, processOwner, projectPath: directory })
      expect(before).toMatchObject({ success: false, error: { code: 'ACTION_DISABLED' } })

      const body = { action: 'bash_execute', context: helperContext, projectPath: directory,
        processOwner: { userId, kind: 'agent', id: 'forged-owner' }, commandParentAgentId: 'forged-parent',
        input: { command: `printf owned > ${quote(marker)}; sleep 1`, timeoutMs: 5000 } }
      const invoke = () => POST({ locals: {}, request: new Request('http://localhost/api/native-tools/dispatch', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-batshit-agent-token': run.token }, body: JSON.stringify(body)
      }) } as any)
      const after = await invoke().then(async reply => ({ status: reply.status, body: await reply.json() }))
      expect(after.status, JSON.stringify(after.body)).toBe(403)
      expect(after.body).toMatchObject({ success: false, error: { code: 'ACTION_DISABLED' } })
      expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull()
      const store = new HostCommandRecordStore({ root: process.env.BATSHIT_COMMAND_RECORDS_DIR! })
      expect(store.records([hostOwnerResource(processOwner)])).toEqual([])
      // The real-owner remap is a Bash-only exception. A credential with the same
      // virtual helper context cannot borrow its parent's other tool toggles.
      const otherAction = await POST({ locals: {}, request: new Request('http://localhost/api/native-tools/dispatch', {
        method: 'POST', headers: { 'content-type': 'application/json', 'x-batshit-agent-token': run.token },
        body: JSON.stringify({ action: 'web_search', context: helperContext,
          input: { query: 'delegated owner authority' } })
      }) } as any)
      expect(otherAction.status).toBe(400)
      expect(await otherAction.json()).toMatchObject({ success: false, error: { code: 'INVALID_CONTEXT' } })
      // The API tool keeps the parent for audit, but physical command ownership stays
      // with the named Subagent (or Worker parent), just as on the managed helper lane.
      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId, agentId: parentId, processOwner, scopeAgentId: kind === 'worker' ? 'worker_researcher' : subagentId,
        delegatedBashEnabled: true, sessionId, projectPath: directory,
        providerSettings: { nativeTools: { ...nativeTools, dynamicMcpEnabled: false,
          webSearchEnabled: false, agentBrowserEnabled: false, fetchZipEnabled: false } },
        toolApprovalMode: 'off'
      })
      const apiResult = (tools.native_bash_execute as any).execute(
        { command: `printf api-owned > ${quote(marker)}; sleep 1` },
        { toolCallId: `api-${suffix}`, messages: [] }
      )
      for (let n = 0; n < 250; n++) {
        if (await readFile(marker, 'utf8').catch(() => '') === 'api-owned') break
        await new Promise(resolve => setTimeout(resolve, 20))
      }
      expect(await readFile(marker, 'utf8')).toBe('api-owned')
      expect(store.records([hostOwnerResource(processOwner)])).toEqual([
        expect.objectContaining({ kind: 'guardian', owner: processOwner, phase: 'running' })
      ])
      expect(await apiResult).toMatchObject({ success: true })
      await endLiveOwnedCommandGroups()
      // Deleting the stored owner refuses the old token even if no bridge revoked it.
      await redis.del(`${processOwner.kind}:${processOwner.id}`)
      const refused = await invoke()
      expect(refused.status).toBe(401)
    }, 15000)
  }

  for (const kind of ['subagent', 'worker'] as const) {
    for (const [parentEnabled, ownEnabled] of [[true, false], [false, true], [true, null]] as const) {
      it(`${kind} Bash denies when parent=${parentEnabled} and own=${ownEnabled}`, async () => {
        const suffix = randomUUID()
        const userId = `deny-proof-${suffix}`
        const parentId = `parent-${suffix}`
        const subagentId = `named-${suffix}`
        const runtimeId = `subagent_cli_${suffix.replaceAll('-', '')}`
        const directory = await mkdtemp(path.join(os.tmpdir(), 'delegated-bash-deny-'))
        directories.push(directory)
        const marker = path.join(directory, 'should-not-run')
        const parentTools = { executionBackend: 'local', bashEnabled: parentEnabled, bashAccessMode: 'dangerous' }
        const ownTools = { executionBackend: 'local', bashEnabled: ownEnabled ?? true, bashAccessMode: 'dangerous' }
        await redis.set(`agent:${parentId}`, { id: parentId, user_id: userId,
          provider_specific_settings: { nativeTools: parentTools } } as any)
        await redis.set(`subagent:${subagentId}`, { id: subagentId, user_id: userId,
          provider_specific_settings: { nativeTools: ownTools } } as any)
        keys.push(`agent:${parentId}`, `subagent:${subagentId}`)
        const processOwner = { userId, kind: kind === 'worker' ? 'agent' as const : 'subagent' as const,
          id: kind === 'worker' ? parentId : subagentId }
        const run = await mintRunCredential({ userId, agentId: runtimeId,
          sessionId: `session-${suffix}`, runtime: 'codex', delegated: true,
          scopeAgentId: kind === 'worker' ? 'worker_researcher' : subagentId,
          allowedControlIds: [], processOwner, commandParentAgentId: parentId,
          delegatedBashEnabled: ownEnabled ?? undefined })
        credentials.push({ credentialId: run.credentialId, agentId: runtimeId })

        const reply = await POST({ locals: {}, request: new Request('http://localhost/api/native-tools/dispatch', {
          method: 'POST', headers: { 'content-type': 'application/json', 'x-batshit-agent-token': run.token },
          body: JSON.stringify({ action: 'bash_execute', context: { actor_type: 'primary', mode: 'mode4' },
            projectPath: directory, input: { command: `touch ${quote(marker)}` } })
        }) } as any)
        expect(reply.status).toBe(403)
        expect(await reply.json()).toMatchObject({ success: false, error: { code: 'ACTION_DISABLED' } })
        expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull()
        const store = new HostCommandRecordStore({ root: process.env.BATSHIT_COMMAND_RECORDS_DIR! })
        expect(store.records([hostOwnerResource(processOwner)])).toEqual([])
        if (parentEnabled && ownEnabled === false) {
          // Even a model preset that turns Bash on cannot override the stored
          // Subagent's own grant on the in-process API lane.
          const apiTools = await nativeToolService.buildMode3NativeTools({
            userId, agentId: parentId, processOwner, scopeAgentId: kind === 'worker' ? 'worker_researcher' : subagentId,
            delegatedBashEnabled: false,
            providerSettings: { nativeTools: { ...parentTools, bashEnabled: true } },
            toolApprovalMode: 'off'
          })
          expect(apiTools.tools).not.toHaveProperty('native_bash_execute')
          const missingGrantTools = await nativeToolService.buildMode3NativeTools({
            userId, agentId: parentId, processOwner, scopeAgentId: kind === 'worker' ? 'worker_researcher' : subagentId,
            providerSettings: { nativeTools: { ...parentTools, bashEnabled: true } },
            toolApprovalMode: 'off'
          })
          expect(missingGrantTools.tools).not.toHaveProperty('native_bash_execute')
        }
        if (!parentEnabled && ownEnabled === true) {
          const apiTools = await nativeToolService.buildMode3NativeTools({
            userId, agentId: parentId, processOwner, scopeAgentId: kind === 'worker' ? 'worker_researcher' : subagentId,
            delegatedBashEnabled: true,
            providerSettings: { nativeTools: { ...ownTools, bashEnabled: true } },
            toolApprovalMode: 'off'
          })
          expect(apiTools.tools).not.toHaveProperty('native_bash_execute')
        }
      })
    }
  }
})
