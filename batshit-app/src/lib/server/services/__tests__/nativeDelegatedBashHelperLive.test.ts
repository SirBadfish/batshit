import { describe, expect, it, vi } from 'vitest'
import { createServer } from 'node:http'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { mintRunCredential, revokeRunCredential } from '../agentRunCredentials'
import { bindDispatchContextIdentity } from '../actingAgentIdentity'
import { nativeToolService } from '../nativeTools'
import { endLiveOwnedCommandGroups } from '../ownedCommandGroup'
import { POST } from '../../../../routes/api/native-tools/dispatch/+server'

useRedisTestServer()

// The skill door below stubs ONLY the skill lookup (a database read); every other export of the
// module, the script builder included, is real, and the route, the credential, the dispatcher
// and the process runner are all real.
const skillMocks = vi.hoisted(() => ({ resolveSkillRuntimeForTool: vi.fn() }))
vi.mock('../skillRuntimeToolService', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../skillRuntimeToolService')>()),
  resolveSkillRuntimeForTool: skillMocks.resolveSkillRuntimeForTool
}))

/**
 * BL-878, step 1 (Josh, 2026-09-28, 19:50 EDT): Codex and Claude agents have their own Bash, so
 * Batshit's `batshit_server_bash_execute` is not listed for them and a call that arrives anyway
 * is refused. BL-743 (2026-09-27) once made this exact helper path WORK for a delegated run; this
 * file is now the proof that it is refused.
 *
 * It uses the shipped MCP helper (a real child process), a REAL run credential from
 * `mintRunCredential`, and real loopback HTTP to the real dispatch route. The saved settings
 * grant Bash (on, Dangerous mode, local backend) and the delegated credential says Bash is on, so
 * the refusal is the dispatch's own doing, and a marker file proves no command ran.
 */
const REFUSAL = "Batshit's Bash helper is not offered to Codex and Claude agents. Use your own shell tool."

describe('the shipped MCP Bash helper on a real local HTTP/stdio path is refused on the CLI lane', () => {
  it('refuses a delegated run: on the historical virtual-id binding and on the credential-bound one', async () => {
    const id = randomUUID()
    const userId = `helper-user-${id}`
    const parentId = `helper-parent-${id}`
    const subagentId = `helper-sub-${id}`
    const runtimeId = `subagent_cli_${id.replaceAll('-', '')}`
    const sessionId = `helper-session-${id}`
    const directory = await mkdtemp(path.join(os.tmpdir(), 'delegated-helper-live-'))
    const marker = path.join(directory, 'executed')
    const nativeTools = { executionBackend: 'local', bashEnabled: true, bashAccessMode: 'dangerous' }
    await redis.set(`agent:${parentId}`, { id: parentId, user_id: userId, provider_specific_settings: { nativeTools } } as any)
    await redis.set(`subagent:${subagentId}`, { id: subagentId, user_id: userId, provider_specific_settings: { nativeTools } } as any)
    const owner = { userId, kind: 'subagent' as const, id: subagentId }
    const credential = await mintRunCredential({ userId, agentId: runtimeId, sessionId,
      runtime: 'codex', delegated: true, scopeAgentId: subagentId, allowedControlIds: [],
      processOwner: owner, commandParentAgentId: parentId, delegatedBashEnabled: true })
    let historicalBinding = true
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const raw = Buffer.concat(chunks).toString('utf8')
        let reply: Response
        if (historicalBinding) {
          const body = JSON.parse(raw)
          const bound = bindDispatchContextIdentity({ auth: 'agent', userId, agentId: runtimeId,
            sessionId, delegated: true } as any, body.context)
          expect(bound.ok).toBe(true)
          const result = await nativeToolService.dispatchNativeAutomationPackAction({ userId,
            action: body.action, payloadInput: body.input, context: (bound as any).context,
            projectPath: directory, actorType: 'agent', delegatedRun: true, processOwner: owner,
            delegatedBashEnabled: true })
          reply = Response.json(result)
        } else {
          reply = await POST({ locals: {}, request: new Request('http://127.0.0.1/api/native-tools/dispatch', {
            method: 'POST', headers: req.headers as Record<string, string>, body: raw
          }) } as any)
        }
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(await reply.text())
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const client = new Client({ name: 'delegated-bash-proof', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('scripts/mode4-controls-mcp.cjs')], stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', BATSHIT_USER_ID: userId, BATSHIT_AGENT_ID: runtimeId,
        BATSHIT_SESSION_ID: sessionId, BATSHIT_AGENT_TOKEN: credential.token,
        BATSHIT_PROJECT_PATH: directory, BATSHIT_CLI_HELPER_BASE_URL: `http://127.0.0.1:${port}` } })
    try {
      await client.connect(transport)
      const command = `printf helper-owned > '${marker}'`
      const before = await client.callTool({ name: 'batshit_server_bash_execute', arguments: { command } })
      expect(JSON.stringify(before)).toContain('ACTION_DISABLED')
      expect(JSON.stringify(before)).toContain(REFUSAL)
      expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull()
      historicalBinding = false
      const after = await client.callTool({ name: 'batshit_server_bash_execute', arguments: { command } })
      expect(JSON.stringify(after)).toContain('ACTION_DISABLED')
      expect(JSON.stringify(after)).toContain(REFUSAL)
      expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull()
    } finally {
      await client.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await revokeRunCredential(credential.credentialId, { agentId: runtimeId })
      await redis.del(`agent:${parentId}`)
      await redis.del(`subagent:${subagentId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)

  it('refuses a primary run the same way, whatever its saved Work mode', async () => {
    const id = randomUUID()
    const userId = `helper-user-${id}`
    const agentId = `helper-primary-${id}`
    const sessionId = `helper-session-${id}`
    const directory = await mkdtemp(path.join(os.tmpdir(), 'primary-helper-live-'))
    const marker = path.join(directory, 'executed')
    const saveAgent = (bashAccessMode: 'agent' | 'dangerous') => redis.set(`agent:${agentId}`, {
      id: agentId, user_id: userId, agentType: 'cli',
      provider_specific_settings: { nativeTools: { executionBackend: 'local', bashEnabled: true, bashAccessMode } }
    } as any)
    // A credential is minted for a stored agent, so the agent exists before the run starts.
    await saveAgent('agent')
    const credential = await mintRunCredential({ userId, agentId, sessionId, runtime: 'claude', delegated: false })
    const server = createServer(async (req, res) => {
      try {
        const chunks: Buffer[] = []
        for await (const chunk of req) chunks.push(Buffer.from(chunk))
        const reply = await POST({ locals: {}, request: new Request('http://127.0.0.1/api/native-tools/dispatch', {
          method: 'POST', headers: req.headers as Record<string, string>, body: Buffer.concat(chunks).toString('utf8')
        }) } as any)
        res.writeHead(reply.status, { 'content-type': 'application/json' })
        res.end(await reply.text())
      } catch (error) { res.writeHead(500); res.end(JSON.stringify({ error: String(error) })) }
    })
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const port = (server.address() as any).port
    const client = new Client({ name: 'primary-bash-proof', version: '1' })
    const transport = new StdioClientTransport({ command: process.execPath,
      args: [path.resolve('scripts/mode4-controls-mcp.cjs')], stderr: 'pipe',
      env: { PATH: process.env.PATH ?? '', BATSHIT_USER_ID: userId, BATSHIT_AGENT_ID: agentId,
        BATSHIT_SESSION_ID: sessionId, BATSHIT_AGENT_TOKEN: credential.token,
        BATSHIT_PROJECT_PATH: directory, BATSHIT_CLI_HELPER_BASE_URL: `http://127.0.0.1:${port}` } })
    try {
      await client.connect(transport)
      for (const bashAccessMode of ['agent', 'dangerous'] as const) {
        await saveAgent(bashAccessMode)
        const result = JSON.stringify(await client.callTool({ name: 'batshit_server_bash_execute',
          arguments: { command: `printf helper-owned > '${marker}'` } }))
        expect(result, bashAccessMode).toContain('ACTION_DISABLED')
        expect(result, bashAccessMode).toContain(REFUSAL)
        expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull()
      }
    } finally {
      await client.close()
      server.closeAllConnections()
      await new Promise<void>(resolve => server.close(() => resolve()))
      await revokeRunCredential(credential.credentialId, { agentId })
      await redis.del(`agent:${agentId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 15000)
})

/**
 * BL-878: the second door. `native_skill` with `script_run` starts a process under Batshit's
 * rules, so the agent lane is refused it too. `nativeCliLaneBashRefusal.test.ts` proves every
 * spelling with `actorType` set by hand; this proves the LANE itself: a real credential from
 * `mintRunCredential`, sent to the real route, which must turn it into the agent lane by itself
 * (`resolveNativeToolUser`, then `actorType: auth.auth`). A route that mapped the credential to
 * another lane would run the script here, which is what the marker and the mock catch.
 */
const SKILL_REFUSAL =
  'Batshit does not run skill scripts for Codex and Claude agents. Read the skill with native_skill (invoke or read), then run its script with your own shell tool.'

describe('the skill script door on the real dispatch route, with a real agent-lane credential', () => {
  it('refuses script_run (top level, and run_script inside input), and runs the same bodies for a session caller', async () => {
    const id = randomUUID()
    const userId = `skill-user-${id}`
    const agentId = `skill-agent-${id}`
    const sessionId = `skill-session-${id}`
    const directory = await mkdtemp(path.join(os.tmpdir(), 'skill-door-live-'))
    const marker = path.join(directory, 'ran')
    const cacheDir = path.join(directory, 'skill-cache')
    await mkdir(path.join(cacheDir, 'scripts'), { recursive: true })
    await writeFile(path.join(cacheDir, 'scripts', 'run.sh'), `printf ran > '${marker}'\n`)
    skillMocks.resolveSkillRuntimeForTool.mockReset()
    skillMocks.resolveSkillRuntimeForTool.mockResolvedValue({
      runtime: {
        skill: { id: 'skill-alpha', name: 'skill-alpha', displayName: 'Skill Alpha' },
        cacheDir,
        bundleFiles: [
          { path: 'scripts/run.sh', kind: 'script', encoding: 'utf8', content: '', sha256: 'abc', size: 1 }
        ]
      },
      error: null
    })
    // Saved settings that GRANT Bash and scripts, so a refusal is the lane rule and nothing else.
    await redis.set(`agent:${agentId}`, { id: agentId, user_id: userId, agentType: 'cli',
      provider_specific_settings: { nativeTools: { executionBackend: 'local', bashEnabled: true,
        bashAccessMode: 'dangerous' } } } as any)
    const credential = await mintRunCredential({ userId, agentId, sessionId, runtime: 'codex', delegated: false })
    // The route reads a body `projectPath` on the agent and service lanes only; a signed-in
    // caller's project is the chat's, so the chat carries it.
    await redis.createSession({ id: sessionId, user_id: userId, agent_id: agentId, title: 'BL-878 skill door',
      metadata: { projectPath: directory } } as any)
    const post = (headers: Record<string, string>, locals: Record<string, unknown>, body: unknown) =>
      POST({ locals, request: new Request('http://127.0.0.1/api/native-tools/dispatch', {
        method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body)
      }) } as any)
    const skill = { skillId: 'skill-alpha', path: 'scripts/run.sh' }
    const spellings: Array<[string, unknown]> = [
      ['script_run at the top level', { ...skill, action: 'script_run' }],
      ['run_script inside input', { input: { ...skill, action: 'run_script' } }]
    ]
    try {
      for (const [label, input] of spellings) {
        const reply = await post({ 'x-batshit-agent-token': credential.token }, {}, {
          action: 'native_skill', input, projectPath: directory,
          context: { actor_type: 'primary', mode: 'mode4', session_id: sessionId }
        })
        const body = await reply.json()
        expect(reply.status, label).toBe(403)
        expect(body, label).toMatchObject({ success: false, error: { code: 'ACTION_DISABLED', message: SKILL_REFUSAL } })
        // No skill runtime, no cache, no process.
        expect(skillMocks.resolveSkillRuntimeForTool, label).not.toHaveBeenCalled()
        expect(await readFile(marker, 'utf8').catch(() => null), label).toBeNull()
      }

      // The same bodies from the signed-in user are not refused by the lane rule: they run.
      for (const [label, input] of spellings) {
        const reply = await post({}, { user: { id: userId } }, {
          action: 'native_skill', input, projectPath: directory,
          context: { actor_type: 'primary', mode: 'mode4', session_id: sessionId, agent_id: agentId }
        })
        const body = await reply.json()
        expect(reply.status, `${label}: ${JSON.stringify(body)}`).toBe(200)
        expect(body, label).toMatchObject({ auth: 'session', success: true, data: { runSucceeded: true } })
        expect(await readFile(marker, 'utf8'), label).toBe('ran')
        await rm(marker)
      }
      expect(skillMocks.resolveSkillRuntimeForTool).toHaveBeenCalledTimes(spellings.length)
    } finally {
      await endLiveOwnedCommandGroups()
      await revokeRunCredential(credential.credentialId, { agentId })
      await redis.del(`agent:${agentId}`)
      await redis.del(`session:${sessionId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})
