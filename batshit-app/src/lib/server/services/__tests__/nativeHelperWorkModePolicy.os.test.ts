/**
 * BL-854 helper policy proof using the normal Vitest config. No mock of the native dispatcher or
 * command executor is used.
 *
 * This proved Batshit's helper -> authenticated HTTP -> saved Work mode -> real filesystem
 * effect. BL-878, step 1 (Josh, 2026-09-28, 19:50 EDT): CLI agents have their own Bash, so the
 * managed helper stopped running a command under ANY Work mode, and SA-139 R5 removed the helper;
 * the agent lane's refusal in every Work mode is proven on the real route with a real credential
 * in `nativeDelegatedBashHelperLive.test.ts`. Batshit's Work mode still governs every caller that
 * keeps the dispatch (a service caller), so the test below keeps BL-854's Work-mode cases (Agent
 * mode reads and patches, refuses a shell write; Dangerous mode allows one; Never Allow refuses)
 * on that dispatch, with the same files and the same real filesystem effects.
 */
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { endLiveOwnedCommandGroups } from '../ownedCommandGroup'
import { nativeToolService } from '../nativeTools'

useRedisTestServer()

describe('BL-854: Batshit Work mode on the dispatch', () => {
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
