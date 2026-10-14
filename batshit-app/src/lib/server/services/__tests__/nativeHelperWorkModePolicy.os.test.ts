/**
 * BL-854 helper policy proof using the normal Vitest config. No mock of the
 * native dispatcher, command executor, run credential, HTTP handler, or MCP helper is used.
 *
 * This proved Batshit's helper -> authenticated HTTP -> saved Work mode -> real filesystem
 * effect. It does NOT prove when the installed Claude model invokes its native permission
 * callback, nor that every other helper family uses Bash Work mode.
 *
 * BL-878, step 1 (Josh, 2026-09-28, 19:50 EDT): Codex and Claude agents have their own Bash, so
 * the managed helper no longer runs a command under ANY Work mode: the first test below proves
 * the same real path is now a refusal in each mode, with no file touched. Batshit's Work mode
 * still governs every caller that keeps the dispatch (an n8n Workflow Subagent's automation
 * pack, a service caller), so the second test keeps BL-854's Work-mode cases (Agent mode reads
 * and patches, refuses a shell write; Dangerous mode allows one; Never Allow refuses) on that
 * dispatch, with the same files and the same real filesystem effects.
 */
import { randomUUID } from 'node:crypto'
import { createServer } from 'node:http'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { mintRunCredential, revokeRunCredential } from '../agentRunCredentials'
import { endLiveOwnedCommandGroups } from '../ownedCommandGroup'
import { nativeToolService } from '../nativeTools'
import { POST } from '../../../../routes/api/native-tools/dispatch/+server'

useRedisTestServer()

describe('BL-854 / BL-878: Batshit Work mode and the managed Claude Bash helper', () => {
  it('BL-878: refuses every helper call in every Work mode, and touches no file', async () => {
    const suffix = randomUUID()
    const userId = `bl854-user-${suffix}`
    const agentId = `bl854-agent-${suffix}`
    const sessionId = `bl854-session-${suffix}`
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bl854-helper-'))
    const source = path.join(directory, 'SOURCE.md')
    const patched = path.join(directory, 'PATCHED.md')
    const refused = path.join(directory, 'REFUSED.txt')
    const dangerous = path.join(directory, 'DANGEROUS.txt')
    const never = path.join(directory, 'NEVER.txt')
    await writeFile(source, 'read-from-real-file\n')

    const saveAgent = async (bashAccessMode: 'agent' | 'dangerous', bashNeverAllowList: string[] = []) => {
      await redis.set(`agent:${agentId}`, {
        id: agentId, user_id: userId, agentType: 'cli', primary_model_provider: 'claude-cli',
        tool_approval_mode: 'all', claude_settings: { permissionMode: 'default' },
        provider_specific_settings: {
          nativeTools: { executionBackend: 'local', bashEnabled: true, bashAccessMode,
            bashCommandAllowList: [], bashNeverAllowList }
        }
      } as any)
    }

    let server: ReturnType<typeof createServer> | null = null
    let client: Client | null = null
    let credentialId: string | null = null
    try {
      await saveAgent('agent')
      const credential = await mintRunCredential({
        userId, agentId, sessionId, runtime: 'claude', delegated: false
      })
      credentialId = credential.credentialId

      // The child MCP helper has only HTTP access; POST runs in this Vitest worker, where
      // the saved Primary Agent and credential are stored. The default lane's in-memory Redis
      // fake is therefore shared with POST. The real-Redis lane uses its dedicated DB15.
      server = createServer(async (req, res) => {
        try {
          const chunks: Buffer[] = []
          for await (const chunk of req) chunks.push(Buffer.from(chunk))
          const reply = await POST({
            locals: {},
            request: new Request('http://127.0.0.1/api/native-tools/dispatch', {
              method: 'POST', headers: req.headers as Record<string, string>,
              body: Buffer.concat(chunks).toString('utf8')
            })
          } as any)
          res.writeHead(reply.status, { 'content-type': 'application/json' })
          res.end(await reply.text())
        } catch (error) {
          res.writeHead(500, { 'content-type': 'application/json' })
          res.end(JSON.stringify({ error: String(error) }))
        }
      })
      await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve))
      const port = (server.address() as { port: number }).port

      client = new Client({ name: 'bl854-work-mode-proof', version: '1' })
      const transport = new StdioClientTransport({
        command: process.execPath,
        args: [path.resolve('scripts/mode4-controls-mcp.cjs'),
          `--agent=${agentId}`, `--user=${userId}`, `--url=http://127.0.0.1:${port}`,
          '--runtime=claude'],
        stderr: 'pipe',
        env: {
          PATH: process.env.PATH ?? '', BATSHIT_AGENT_TOKEN: credential.token,
          BATSHIT_AGENT_ID: agentId, BATSHIT_USER_ID: userId,
          BATSHIT_SESSION_ID: sessionId, BATSHIT_PROJECT_PATH: directory
        }
      })
      await client.connect(transport)
      const call = async (command: string) => JSON.stringify(await client!.callTool({
        name: 'batshit_server_bash_execute', arguments: { command }
      }))

      const refusal = "Batshit's Bash helper is not offered to Codex and Claude agents. Use your own shell tool."
      const refuseIn = async (command: string) => {
        const result = await call(command)
        expect(result).toContain('ACTION_DISABLED')
        expect(result).toContain(refusal)
        return result
      }

      // Agent mode: a read, a managed patch, and a shell write are all refused.
      expect(await refuseIn('cat SOURCE.md')).not.toContain('read-from-real-file')
      await refuseIn(`apply_patch <<'PATCH'
*** Begin Patch
*** Add File: PATCHED.md
+managed-patch-ran
*** End Patch
PATCH`)
      await refuseIn('printf blocked > REFUSED.txt')

      // Dangerous mode and a Never Allow rule change nothing: the answer is the same refusal.
      await saveAgent('dangerous')
      await refuseIn('printf dangerous > DANGEROUS.txt')
      await saveAgent('dangerous', ['re:^\\s*printf\\s+never\\b'])
      await refuseIn('printf never > NEVER.txt')

      for (const file of [patched, refused, dangerous, never]) {
        await expect(readFile(file, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
      }
    } finally {
      await client?.close()
      server?.closeAllConnections()
      if (server?.listening) await new Promise<void>((resolve) => server!.close(() => resolve()))
      await endLiveOwnedCommandGroups()
      if (credentialId) await revokeRunCredential(credentialId, { agentId })
      await redis.del(`agent:${agentId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)

  it('BL-854: Batshit Work mode still governs the callers that keep the dispatch (Agent, Dangerous, Never Allow)', async () => {
    // Same files, same saved modes, same real filesystem effects as the helper proof used to
    // show, through the dispatch as a service caller (an n8n Workflow Subagent's automation pack
    // reaches the same non-interactive gate). Only the lane changed: the agent lane is refused.
    const suffix = randomUUID()
    const userId = `bl854-user-${suffix}`
    const agentId = `bl854-agent-${suffix}`
    const directory = await mkdtemp(path.join(os.tmpdir(), 'bl854-dispatch-'))
    const source = path.join(directory, 'SOURCE.md')
    const patched = path.join(directory, 'PATCHED.md')
    const refused = path.join(directory, 'REFUSED.txt')
    const dangerous = path.join(directory, 'DANGEROUS.txt')
    const never = path.join(directory, 'NEVER.txt')
    await writeFile(source, 'read-from-real-file\n')

    const saveAgent = async (bashAccessMode: 'agent' | 'dangerous', bashNeverAllowList: string[] = []) => {
      await redis.set(`agent:${agentId}`, {
        id: agentId, user_id: userId, agentType: 'api',
        provider_specific_settings: {
          nativeTools: { executionBackend: 'local', bashEnabled: true, bashAccessMode,
            bashCommandAllowList: [], bashNeverAllowList }
        }
      } as any)
    }
    const call = async (command: string) => JSON.stringify(await nativeToolService.dispatchNativeAutomationPackAction({
      userId, action: 'bash_execute', payloadInput: { command },
      context: { session_id: `bl854-session-${suffix}`, agent_id: agentId, mode: 'mode3', actor_type: 'primary' },
      projectPath: directory, actorType: 'service'
    } as any))

    try {
      await saveAgent('agent')
      const read = await call('cat SOURCE.md')
      expect(read).toContain('read-from-real-file')

      const patch = `apply_patch <<'PATCH'
*** Begin Patch
*** Add File: PATCHED.md
+managed-patch-ran
*** End Patch
PATCH`
      const patchResult = await call(patch)
      expect(patchResult).not.toContain('POLICY_BLOCKED')
      expect(await readFile(patched, 'utf8')).toBe('managed-patch-ran\n')

      const refusedResult = await call('printf blocked > REFUSED.txt')
      expect(refusedResult).toContain('POLICY_BLOCKED')
      await expect(readFile(refused, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })

      await saveAgent('dangerous')
      const allowedResult = await call('printf dangerous > DANGEROUS.txt')
      expect(allowedResult).not.toContain('POLICY_BLOCKED')
      expect(await readFile(dangerous, 'utf8')).toBe('dangerous')

      await saveAgent('dangerous', ['re:^\\s*printf\\s+never\\b'])
      const neverResult = await call('printf never > NEVER.txt')
      expect(neverResult).toContain('POLICY_BLOCKED')
      await expect(readFile(never, 'utf8')).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await endLiveOwnedCommandGroups()
      await redis.del(`agent:${agentId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})
