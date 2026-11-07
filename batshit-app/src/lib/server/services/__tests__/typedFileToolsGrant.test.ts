import { afterEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises'
import { redis } from '$lib/server/redis'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { nativeToolService } from '../nativeTools'
import { VercelAIBrain } from '../vercelBrain'
import { STOPPED_WITHOUT_RESULT_REASON, withToolResultsOnStop } from '../lateToolResults'
import {
  __setTypedFileAfterCommitForTests,
  TYPED_EDIT_FILE_DESCRIPTION,
  TYPED_EDIT_FILE_DESCRIPTION_REFRESHED,
  TYPED_EDIT_FILE_PRECISE,
  TYPED_FILE_TOOL_NAMES
} from '../typedFileTools'
import { AnchoredProjectWriter } from '../anchoredProjectWriter'

/**
 * The materialized typed-file grant on the real tool builder, with Bash the upper bound; an API Subagent or Worker needs
 * its own record's value AND the parent's AND the physical owner, and a preset's value never
 * counts. With the grant off the tool list is exactly today's. Then one call through the SDK
 * wrapper `vercelBrain.ts` hands every API tool: a Stop after the rename keeps the applied edit.
 */

useRedisTestServer()

const cleanup: string[] = []
const keys: string[] = []
let counter = 0

afterEach(async () => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
  __setTypedFileAfterCommitForTests(null)
  for (const key of keys.splice(0)) await redis.del(key)
  while (cleanup.length) await rm(cleanup.pop()!, { recursive: true, force: true })
})

async function project(): Promise<string> {
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), 'sa136-grant-')))
  cleanup.push(dir)
  return dir
}

const baseNativeTools = {
  bashEnabled: true,
  executionBackend: 'local',
  bashAccessMode: 'dangerous',
  fetchZipEnabled: false,
  dynamicMcpEnabled: false,
  webSearchEnabled: false,
  agentBrowserEnabled: false
}

async function userWith(globalValue?: boolean | null): Promise<string> {
  counter += 1
  const userId = `typed-user-${counter}-${Date.now()}`
  if (globalValue !== undefined) {
    await redis.json.set(`user:${userId}:settings`, '$', { global_tool_grid_settings: { typed_file_tools: globalValue } } as any)
    keys.push(`user:${userId}:settings`)
  }
  return userId
}

async function build(userId: string, projectPath: string, nativeTools: Record<string, unknown>, extra: Record<string, unknown> = {}) {
  const { tools } = await nativeToolService.buildMode3NativeTools({
    userId,
    projectPath,
    providerSettings: { nativeTools: { ...baseNativeTools, ...nativeTools } },
    toolApprovalMode: 'none',
    ...extra
  } as any)
  return tools as Record<string, any>
}

const typedNames = (tools: Record<string, unknown>) => TYPED_FILE_TOOL_NAMES.filter((name) => name in tools)

describe('container Docker typed admission on the real tool builder', () => {
  function operator(root: string, options: { revision?: number; change?: (value: Record<string, any>) => unknown; onAdmission?: () => void; timeout?: boolean } = {}) {
    vi.spyOn(os, 'platform').mockReturnValue('linux')
    vi.spyOn(os, 'release').mockReturnValue('7.0.14-linuxkit')
    const hostRoot = '/Users/proof/host-workspace'
    for (const [key, value] of Object.entries({
      BATSHIT_CONTAINERIZED: '1', BATSHIT_RUNTIME_ENV: 'docker',
      BATSHIT_WORKSPACE_CONTAINER_PATH: root, BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT: root, BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT: hostRoot,
      BATSHIT_DOCKER_SANDBOX_OPERATOR_URL: 'http://operator.test', BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN: 'unit-operator-token',
      BATSHIT_DOCKER_SANDBOX_OPERATOR_TIMEOUT_MS: '1000', BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER: ''
    })) vi.stubEnv(key, value)
    const calls: Array<{ body: any; headers: Headers }> = []
    const fetcher = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url, init) => {
      if (String(url).endsWith('/health')) return new Response(JSON.stringify({ sandboxRevision: options.revision ?? 13 }))
      expect(String(url)).toBe('http://operator.test/v1/sandbox/workspace/admit')
      const body = JSON.parse(String(init?.body))
      calls.push({ body, headers: new Headers(init?.headers) })
      options.onAdmission?.()
      if (options.timeout) return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
      const value = { ok: true, admitted: true, v: 1, hostPlatform: 'darwin', requestedWorkspaceRoot: body.workspaceRoot, requestedCwd: body.cwd,
        containerRoot: root, configuredHostRoot: hostRoot, hostRoot,
        hostWorkspaceRoot: path.posix.resolve(hostRoot, path.posix.relative(root, body.workspaceRoot)),
        hostCwd: path.posix.resolve(hostRoot, path.posix.relative(root, body.cwd)) }
      return new Response(JSON.stringify(options.change ? options.change(value) : value))
    })
    return { calls, fetcher }
  }

  it('offers the configured Linux-app tools and uses authenticated read-only admission before the app writer', async () => {
    const root = await project()
    const { calls } = operator(root)
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    const tools = await build(await userWith(), root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' })
    expect(typedNames(tools)).toEqual([...TYPED_FILE_TOOL_NAMES])
    const result = await tools.write_file.execute({ path: 'a.txt', content: 'app bytes\n' }, { toolCallId: 'write', messages: [] })
    expect(result).toMatchObject({ success: true, typedFileWrite: { outcome: 'applied' } })
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('app bytes\n')
    expect(calls).toHaveLength(1)
    expect(calls[0].body).toEqual({ v: 1, workspaceRoot: root, cwd: root, expectedContainerRoot: root, expectedHostRoot: '/Users/proof/host-workspace' })
    expect(calls[0].headers.get('authorization')).toBe('Bearer unit-operator-token')
    expect(admit).toHaveBeenCalledWith(root, expect.any(Object))
  })

  it.each([
    { name: 'revision12', revision: 12 },
    { name: 'empty', change: () => ({}) },
    { name: 'not admitted', change: (v: Record<string, any>) => ({ ...v, admitted: false }) },
    { name: 'wrong version', change: (v: Record<string, any>) => ({ ...v, v: 2 }) },
    { name: 'unqualified host', change: (v: Record<string, any>) => ({ ...v, hostPlatform: 'linux' }) },
    { name: 'different cwd', change: (v: Record<string, any>) => ({ ...v, requestedCwd: `${v.requestedCwd}/other` }) },
    { name: 'different config', change: (v: Record<string, any>) => ({ ...v, configuredHostRoot: '/another' }) },
    { name: 'different mapping', change: (v: Record<string, any>) => ({ ...v, hostWorkspaceRoot: `${v.hostRoot}/other` }) },
    { name: 'unknown field', change: (v: Record<string, any>) => ({ ...v, surprise: true }) }
  ])('refuses $name before writer admission or staging', async (options) => {
    const root = await project()
    await writeFile(path.join(root, 'a.txt'), 'old')
    operator(root, options)
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    const tools = await build(await userWith(), root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' })
    const result = await tools.write_file.execute({ path: 'a.txt', content: 'new' }, { toolCallId: 'write', messages: [] })
    expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED', typedFileWrite: { outcome: 'unapplied' } })
    expect(admit).not.toHaveBeenCalled()
    expect(await readFile(path.join(root, 'a.txt'), 'utf8')).toBe('old')
  })

  it.each(['stopped', 'timeout'] as const)('ends %s admission without opening a file helper', async (kind) => {
    const root = await project()
    const stop = new AbortController()
    const { calls } = operator(root, { timeout: kind === 'timeout', onAdmission: kind === 'stopped' ? () => stop.abort() : undefined })
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    const tools = await build(await userWith(), root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' })
    const result = await tools.write_file.execute({ path: 'a.txt', content: 'new' }, { toolCallId: 'write', messages: [], abortSignal: stop.signal })
    expect(calls).toHaveLength(1)
    expect(result).toMatchObject({ success: false, errorCode: kind === 'stopped' ? 'STOPPED' : 'POLICY_BLOCKED' })
    expect(admit).not.toHaveBeenCalled()
  })

  it('keeps named-volume Local available while missing bind mapping makes Sandbox unavailable', async () => {
    const root = await project()
    const { fetcher } = operator(root)
    vi.stubEnv('BATSHIT_SANDBOX_HOST_WORKSPACE_ROOT', '')
    const user = await userWith()
    expect(typedNames(await build(user, root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' }))).toEqual([])
    expect(typedNames(await build(user, root, { typedFileToolsEnabled: true, executionBackend: 'local' }))).toEqual([...TYPED_FILE_TOOL_NAMES])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['disabled', 'off', 'none', ' LOCAL-CLI '])('does not offer operator file tools for driver %s', async (driver) => {
    const root = await project()
    const { fetcher } = operator(root)
    vi.stubEnv('BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER', driver)
    expect(typedNames(await build(await userWith(), root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' }))).toEqual([])
    expect(fetcher).not.toHaveBeenCalled()
  })

  it.each(['/', '/root'])('does not let operator namespace %s select app filesystem authority', async (namespace) => {
    const root = await project()
    const { fetcher } = operator(root)
    const user = await userWith()
    const tools = await build(user, root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' })
    vi.stubEnv('BATSHIT_SANDBOX_CONTAINER_WORKSPACE_ROOT', namespace)
    expect(typedNames(await build(user, root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' }))).toEqual([])
    const admit = vi.spyOn(AnchoredProjectWriter, 'open')
    const result = await tools.write_file.execute({ path: 'a.txt', content: 'new' }, { toolCallId: 'write', messages: [] })
    expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
    expect(admit).not.toHaveBeenCalled()
    expect(fetcher).not.toHaveBeenCalled()
  })
})

describe('the typed_file_tools grant on a Primary API agent', () => {
  it('requires the materialized explicit grant and ignores every retired global value', async () => {
    const root = await project()
    const plain = await userWith()
    expect(typedNames(await build(plain, root, {}))).toEqual([])
    expect(typedNames(await build(plain, root, { typedFileToolsEnabled: true }))).toEqual([...TYPED_FILE_TOOL_NAMES])
    const globalOn = await userWith(true)
    expect(typedNames(await build(globalOn, root, {}))).toEqual([])
    expect(typedNames(await build(globalOn, root, { typedFileToolsEnabled: null }))).toEqual([])
    expect(typedNames(await build(globalOn, root, { typedFileToolsEnabled: false }))).toEqual([])
    const globalOff = await userWith(false)
    expect(typedNames(await build(globalOff, root, { typedFileToolsEnabled: true }))).toEqual([...TYPED_FILE_TOOL_NAMES])
  })

  it('keeps explicit grant facts when unrelated user-settings reads are unavailable', async () => {
    const root = await project(), user = await userWith()
    vi.spyOn(redis, 'getUserSettings').mockRejectedValue(new Error('old global unavailable'))
    expect(typedNames(await build(user, root, { typedFileToolsEnabled: true }))).toEqual([...TYPED_FILE_TOOL_NAMES])
    expect(typedNames(await build(user, root, {}))).toEqual([])
  })

  it('offers the anchored tools for Mac Local, Apple and Docker Sandbox mounts (SA-137 Round 2)', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    const root = await project()
    const globalOn = await userWith(true)
    expect(typedNames(await build(globalOn, root, { typedFileToolsEnabled: true, executionBackend: 'apple_container' }))).toEqual([...TYPED_FILE_TOOL_NAMES])
    expect(typedNames(await build(globalOn, root, { typedFileToolsEnabled: true, executionBackend: 'docker_sandbox' }))).toEqual([...TYPED_FILE_TOOL_NAMES])
    expect(typedNames(await build(globalOn, root, { typedFileToolsEnabled: true, executionBackend: 'local' }))).toEqual([...TYPED_FILE_TOOL_NAMES])
  })

  it.each(['darwin', 'win32'] as const)('refuses typed admission in an unsupported %s app-container even with a saved grant', async platform => {
    vi.spyOn(os, 'platform').mockReturnValue(platform)
    vi.stubEnv('BATSHIT_CONTAINERIZED', '1')
    const root = await project()
    const globalOn = await userWith(true)
    expect(typedNames(await build(globalOn, root, { typedFileToolsEnabled: true, executionBackend: 'local' }))).toEqual([])
  })

  it('refuses Apple workspaces containing, inside or aliased to protected homes before writer admission', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    const root = await project()
    const home = path.join(root, 'managed')
    const agents = path.join(home, 'agents')
    await mkdir(agents, { recursive: true })
    await writeFile(path.join(agents, 'sentinel.txt'), 'HOST_ONLY')
    const alias = path.join(root, 'alias')
    await symlink(agents, alias)
    vi.stubEnv('BATSHIT_SANDBOX_PROTECTED_HOME_DIR', home)
    const writer = vi.spyOn(AnchoredProjectWriter, 'open')
    const user = await userWith(true)
    for (const [workspace, file] of [[root, 'managed/agents/sentinel.txt'], [agents, 'sentinel.txt'], [alias, 'sentinel.txt']]) {
      const tools = await build(user, workspace, { typedFileToolsEnabled: true, executionBackend: 'apple_container' })
      const read = await tools.read_file.execute({ path: file }, {})
      const write = await tools.write_file.execute({ path: file, content: 'FORBIDDEN' }, {})
      expect(read).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
      expect(write).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
      expect(read.reason).toContain('Sandbox workspace exposes managed agent homes or protected runtime/Pinokio data.')
    }
    expect(writer).not.toHaveBeenCalled()
    expect(await readFile(path.join(agents, 'sentinel.txt'), 'utf8')).toBe('HOST_ONLY')
    // Explicit Local keeps its existing host authority; no sandbox mount claim is made.
    const local = await build(user, agents, { typedFileToolsEnabled: true, executionBackend: 'local' })
    expect(await local.read_file.execute({ path: 'sentinel.txt' }, {})).toMatchObject({ success: true, content: 'HOST_ONLY' })
    expect(writer).toHaveBeenCalledTimes(1)
  })

  it('resolves absent protected leaves through aliased configured homes and fails closed on invalid custody metadata', async () => {
    vi.spyOn(os, 'platform').mockReturnValue('darwin')
    const root = await project()
    const physicalHome = path.join(root, 'physical')
    const homeAlias = path.join(root, 'home-alias')
    await mkdir(physicalHome)
    await symlink(physicalHome, homeAlias)
    await writeFile(path.join(physicalHome, 'ordinary.txt'), 'KEEP')
    vi.stubEnv('BATSHIT_HOME_DIR', homeAlias)
    const writer = vi.spyOn(AnchoredProjectWriter, 'open')
    const user = await userWith(true)
    const tools = await build(user, physicalHome, { typedFileToolsEnabled: true, executionBackend: 'apple_container' })
    expect(await tools.read_file.execute({ path: 'ordinary.txt' }, {})).toMatchObject({ success: false, blocked: true })
    vi.stubEnv('BATSHIT_HOME_DIR', '')
    vi.stubEnv('BATSHIT_SANDBOX_PROTECTED_HOME_DIR', 'not-an-absolute-custody-root')
    const invalid = await build(user, root, { typedFileToolsEnabled: true, executionBackend: 'apple_container' })
    const result = await invalid.read_file.execute({ path: 'physical/ordinary.txt' }, {})
    expect(result).toMatchObject({ success: false, blocked: true, errorCode: 'POLICY_BLOCKED' })
    expect(result.reason).toContain('must name an absolute folder')
    expect(writer).not.toHaveBeenCalled()
  })

  it('never exists without Bash, and a top-level key is not a grant', async () => {
    const root = await project()
    const globalOn = await userWith(true)
    expect(typedNames(await build(globalOn, root, { bashEnabled: false, typedFileToolsEnabled: true }))).toEqual([])
    const plain = await userWith()
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: plain,
      projectPath: root,
      providerSettings: { nativeTools: baseNativeTools, typedFileToolsEnabled: true },
      toolApprovalMode: 'none'
    } as any)
    expect(typedNames(tools)).toEqual([])
  })

  it('leaves the tool list exactly as today when off, and adds no approval policy when on', async () => {
    const root = await project()
    const plain = await userWith()
    const off = await nativeToolService.buildMode3NativeTools({ userId: plain, projectPath: root, providerSettings: { nativeTools: baseNativeTools }, toolApprovalMode: 'all' } as any)
    const on = await nativeToolService.buildMode3NativeTools({
      userId: plain,
      projectPath: root,
      providerSettings: { nativeTools: { ...baseNativeTools, typedFileToolsEnabled: true } },
      toolApprovalMode: 'all'
    } as any)
    expect(Object.keys(on.tools).filter((name) => !TYPED_FILE_TOOL_NAMES.includes(name as any))).toEqual(Object.keys(off.tools))
    expect((on.tools as any).native_bash_execute.description).toBe((off.tools as any).native_bash_execute.description)
    expect(Object.keys(on.toolApprovals)).toEqual(Object.keys(off.toolApprovals))
  })

  it('drops the "fresh read" sentence from edit_file only on a turn that runs Refreshed File Reads (Josh, 2026-10-22)', async () => {
    const root = await project()
    const plain = await userWith()
    const usual = await build(plain, root, { typedFileToolsEnabled: true })
    const refreshed = await build(plain, root, { typedFileToolsEnabled: true }, { refreshedFileReadsTurn: true })
    expect(usual.edit_file.description).toBe(TYPED_EDIT_FILE_DESCRIPTION)
    expect(usual.edit_file.description).toContain('Copy oldText from a fresh read. ')
    expect(refreshed.edit_file.description).toBe(TYPED_EDIT_FILE_DESCRIPTION_REFRESHED)
    expect(refreshed.edit_file.description).not.toContain('fresh read')
    // Only that sentence differs; read_file and write_file keep their text.
    expect(TYPED_EDIT_FILE_DESCRIPTION.replace('Copy oldText from a fresh read. ', '')).toBe(TYPED_EDIT_FILE_DESCRIPTION_REFRESHED)
    // Josh (2026-10-23): both texts ask for small, merged edits, as Pi steers its edit tool.
    for (const text of [TYPED_EDIT_FILE_DESCRIPTION, TYPED_EDIT_FILE_DESCRIPTION_REFRESHED]) {
      expect(text).toContain(TYPED_EDIT_FILE_PRECISE)
    }
    expect(TYPED_EDIT_FILE_PRECISE).toContain('Keep each oldText as small as it can be while it is still unique')
    expect(refreshed.read_file.description).toBe(usual.read_file.description)
    expect(refreshed.write_file.description).toBe(usual.write_file.description)
    const plan = await build(plain, root, { typedFileToolsEnabled: true, bashAccessMode: 'plan' }, { refreshedFileReadsTurn: true })
    expect(plan.edit_file.description).toBe(`${TYPED_EDIT_FILE_DESCRIPTION_REFRESHED} Plan mode: only .md files.`)
  })
})

describe('the grant on an API Subagent or Worker', () => {
  async function delegated(parentValue: unknown, ownValue: boolean | null | undefined, presetValue?: boolean, globalValue?: boolean) {
    const root = await project()
    const userId = await userWith(globalValue)
    counter += 1
    const parentId = `parent-${counter}`
    await redis.set(`agent:${parentId}`, { id: parentId, user_id: userId, provider_specific_settings: { nativeTools: { ...baseNativeTools, typedFileToolsEnabled: parentValue } } } as any)
    keys.push(`agent:${parentId}`)
    const tools = await build(userId, root, presetValue === undefined ? {} : { typedFileToolsEnabled: presetValue }, {
      agentId: parentId,
      scopeAgentId: `sub-${counter}`,
      processOwner: { userId, kind: 'subagent', id: `sub-${counter}` },
      delegatedBashEnabled: true,
      ...(ownValue === undefined ? {} : { delegatedTypedFileToolsValue: ownValue })
    })
    return typedNames(tools)
  }

  it('needs its own value AND the parent value; a preset value never counts; an unstated own value is off', async () => {
    expect(await delegated(true, true)).toEqual([...TYPED_FILE_TOOL_NAMES])
    expect(await delegated(false, true)).toEqual([])
    expect(await delegated(true, false)).toEqual([])
    expect(await delegated(true, null)).toEqual([])
    expect(await delegated(true, undefined)).toEqual([])
    expect(await delegated(true, false, true)).toEqual([])
  })

  it('requires BOTH materialized values and never restores retired global inheritance', async () => {
    expect(await delegated(null, null, undefined, true)).toEqual([])
    expect(await delegated(false, null, undefined, true)).toEqual([])
    expect(await delegated(null, false, undefined, true)).toEqual([])
    expect(await delegated(null, null, undefined, false)).toEqual([])
  })

  it('with the global value ON: an unstated own value, no physical owner, or no parent record is still off', async () => {
    expect(await delegated(null, undefined, undefined, true)).toEqual([])
    const root = await project()
    const userId = await userWith(true)
    counter += 1
    const parentId = `parent-${counter}`
    await redis.set(`agent:${parentId}`, { id: parentId, user_id: userId, provider_specific_settings: { nativeTools: { ...baseNativeTools, typedFileToolsEnabled: true } } } as any)
    keys.push(`agent:${parentId}`)
    const noOwner = await build(userId, root, {}, { agentId: parentId, scopeAgentId: `sub-${counter}`, delegatedBashEnabled: true, delegatedTypedFileToolsValue: true })
    expect(typedNames(noOwner)).toEqual([])
    const noParent = await build(userId, root, {}, {
      agentId: `missing-${counter}`,
      scopeAgentId: `sub-${counter}`,
      processOwner: { userId, kind: 'subagent', id: `sub-${counter}` },
      delegatedBashEnabled: true,
      delegatedTypedFileToolsValue: true
    })
    expect(typedNames(noParent)).toEqual([])
  })
})

describe('a call through the SDK wrapper', () => {
  it('writes in the project, and a Stop after the rename keeps the applied edit in the saved part', async () => {
    const root = await project()
    const userId = await userWith()
    await writeFile(path.join(root, 'a.ts'), 'old\n')
    const tools = await build(userId, root, { typedFileToolsEnabled: true })
    const sdkTools = (new VercelAIBrain() as any).wrapToolsWithReadableModelOutput(tools, {
      userId, sessionId: 's', messageId: 'm', agentId: 'agent-1', fetchZipAllowed: false
    })
    const stop = new AbortController()
    let release!: () => void
    const held = new Promise<void>((resolve) => (release = resolve))
    __setTypedFileAfterCommitForTests(async () => {
      stop.abort('user')
      await held
    })
    const input = { path: 'a.ts', edits: [{ oldText: 'old', newText: 'new' }] }
    const execution: Promise<unknown> = sdkTools.edit_file.execute(input, { toolCallId: 'call_typed_stop', abortSignal: stop.signal, messages: [] })
    async function* sdkStream() {
      yield { type: 'tool-call', toolCallId: 'call_typed_stop', toolName: 'edit_file', input }
      while (!stop.signal.aborted) await new Promise((resolve) => setTimeout(resolve, 5))
      yield { type: 'abort', reason: 'user' }
    }
    const parts: Array<Record<string, any>> = []
    for await (const part of withToolResultsOnStop(sdkStream(), stop.signal, { waitMs: 50 })) parts.push(part)
    release()
    await execution
    const handedOn = parts.find((part) => part.type === 'tool-result')!
    expect(handedOn.output).toMatchObject({
      success: false,
      stopped: true,
      neverReturned: true,
      reason: STOPPED_WITHOUT_RESULT_REASON,
      filePath: 'a.ts',
      typedFileEdit: { v: 1, outcome: 'applied', editsApplied: 1 }
    })
    expect(await readFile(path.join(root, 'a.ts'), 'utf8')).toBe('new\n')
  })
})
