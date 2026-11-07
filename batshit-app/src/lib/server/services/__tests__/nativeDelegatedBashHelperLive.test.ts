import { describe, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
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

describe('Bash on the real dispatch route, with a retired run-token header', () => {
  it('refuses retired delegated and primary headers in every Work mode, and runs nothing', async () => {
    const id = randomUUID()
    const userId = `helper-user-${id}`
    const parentId = `helper-parent-${id}`
    const subagentId = `helper-sub-${id}`
    const runtimeId = `subagent_cli_${id.replaceAll('-', '')}`
    const sessionId = `helper-session-${id}`
    const directory = await mkdtemp(path.join(os.tmpdir(), 'agent-lane-bash-live-'))
    const marker = path.join(directory, 'executed')
    const nativeTools = (bashAccessMode: 'agent' | 'dangerous') => ({ executionBackend: 'local', bashEnabled: true, bashAccessMode })
    const save = async (bashAccessMode: 'agent' | 'dangerous') => {
      await redis.set(`agent:${parentId}`, { id: parentId, user_id: userId, agentType: 'cli',
        provider_specific_settings: { nativeTools: nativeTools(bashAccessMode) } } as any)
      await redis.set(`subagent:${subagentId}`, { id: subagentId, user_id: userId,
        provider_specific_settings: { nativeTools: nativeTools(bashAccessMode) } } as any)
    }
    await save('agent')
    // The body the managed helper sent: the route binds the agent from the credential.
    const post = (token: string, command: string) => POST({ locals: {}, request: new Request('http://127.0.0.1/api/native-tools/dispatch', {
      method: 'POST', headers: { 'content-type': 'application/json', 'x-batshit-agent-token': token },
      body: JSON.stringify({ projectPath: directory, action: 'bash_execute', input: { command },
        context: { session_id: sessionId, mode: 'mode4', actor_type: 'primary' } })
    }) } as any)
    try {
      for (const bashAccessMode of ['agent', 'dangerous'] as const) {
        await save(bashAccessMode)
        for (const [label, token] of [['delegated', 'arc_retired_sub.bsac_secret'], ['primary', 'arc_retired_primary.bsac_secret']] as const) {
          const reply = await post(token, `printf helper-owned > '${marker}'`)
          const body = await reply.json()
          expect(reply.status, `${label} in ${bashAccessMode} mode`).toBe(401)
          expect(body, `${label} in ${bashAccessMode} mode`).toMatchObject({ success: false })
          expect(await readFile(marker, 'utf8').catch(() => null)).toBeNull()
        }
      }
    } finally {
      await endLiveOwnedCommandGroups()
      await redis.del(`agent:${parentId}`)
      await redis.del(`subagent:${subagentId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})

describe('the skill script door on the real dispatch route, with a retired run-token header', () => {
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
    await redis.set(`agent:${agentId}`, { id: agentId, user_id: userId, agentType: 'api',
      provider_specific_settings: { nativeTools: { executionBackend: 'local', bashEnabled: true,
        bashAccessMode: 'dangerous' } } } as any)
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
        const reply = await post({ 'x-batshit-agent-token': 'arc_retired.bsac_secret' }, {}, {
          action: 'native_skill', input, projectPath: directory,
          context: { actor_type: 'primary', mode: 'mode4', session_id: sessionId }
        })
        const body = await reply.json()
        expect(reply.status, label).toBe(401)
        expect(body, label).toMatchObject({ success: false })
        // No skill runtime, no cache, no process.
        expect(skillMocks.resolveSkillRuntimeForTool, label).not.toHaveBeenCalled()
        expect(await readFile(marker, 'utf8').catch(() => null), label).toBeNull()
      }

      // The same bodies from the signed-in user are not refused by the lane rule: they run.
      for (const [label, input] of spellings) {
        const reply = await post({}, { user: { id: userId } }, {
          action: 'native_skill', input, projectPath: directory,
          context: { actor_type: 'primary', mode: 'mode3', session_id: sessionId, agent_id: agentId }
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
      await redis.del(`agent:${agentId}`)
      await redis.del(`session:${sessionId}`)
      await rm(directory, { recursive: true, force: true })
    }
  }, 30000)
})
