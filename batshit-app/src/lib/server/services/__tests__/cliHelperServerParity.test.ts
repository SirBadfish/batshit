import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises'
import toml from '@iarna/toml'
import { buildCliSubagentMcpToolReference } from '$lib/utils/cliSubagentToolNames'

/**
 * BL-5 — the helper bridge has ONE name, and every place that names it agrees.
 *
 * Three writers name the helper server: the Codex profile (`config.toml`), the Claude profile
 * (`mcp.json`), and `ClaudeBridge`'s `--allowedTools` / `--disallowedTools` lists. The deny
 * list is the one that matters most: it is what keeps the retained helpers (Dynamic MCP, CLI
 * tool, Agent Browser find/use, the Fabric and artifact wrappers) away from Claude. A deny list
 * that names a server the profile no longer registers denies nothing, so Claude would gain
 * tools. These tests read what the REAL writers produce and compare them with each other.
 *
 * BL-159 widened it from the private resolver to the REAL arguments: `ClaudeBridge` runs a
 * stand-in `claude` that records its argv, so the `--allowedTools` / `--disallowedTools` the
 * CLI would receive are compared with the `mcp.json` the same run passed as `--mcp-config`,
 * for a primary in its default mode and in Plan mode (BL-153: the Subagent tools must carry
 * the bounded names that profile registers), and for a CLI Subagent's own profile.
 */

const { parse: parseToml } = toml

/**
 * The profile managers write under the home folder: Codex's reads `os.homedir()` when its module
 * loads, Claude's reads `process.env.HOME`. Setting `process.env.HOME` alone moves both on the
 * default (forks) lane, but on the real-Redis (threads) lane a worker's `process.env` is a copy
 * and `os.homedir()` still answers the real home, so the test would write two profile folders
 * into the real `~/.batshit/agents`. So `node:os` itself answers the temporary home, through
 * both import styles, and it refuses to answer before a test has set one.
 */
const testHome = vi.hoisted(() => ({ current: '' }))
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => {
    if (!testHome.current) throw new Error('cliHelperServerParity: no temporary home is set')
    return testHome.current
  }
  return { ...real, homedir, default: { ...real, homedir } }
})

const mockRedis = {
  execute: vi.fn(),
  getAgents: vi.fn(),
  // Profile admission reads the same persisted owner fixture as the other Redis paths.
  json: { get: vi.fn() },
  getProjectPreferences: vi.fn(),
  getProjects: vi.fn(),
  get: vi.fn(),
  getUserSettings: vi.fn()
}
const mockGatewayService = { list: vi.fn(), update: vi.fn() }
const mockResolveMCPSelections = vi.fn()
const mockApiKeyService = { retrieve: vi.fn(), store: vi.fn() }

vi.mock('$env/dynamic/private', () => ({
  env: {
    BATSHIT_CODEX_PROVIDER_ENABLED: 'true',
    BATSHIT_CLAUDE_PROVIDER_ENABLED: 'true',
    BATSHIT_CODEX_WORKDIR: '',
    BATSHIT_TOKEN: ''
  }
}))
vi.mock('$lib/server/redis', () => ({ redis: mockRedis }))
vi.mock('$lib/server/services/mcpGatewayService', () => ({ mcpGatewayService: mockGatewayService }))
vi.mock('$lib/server/services/mcpSelectionResolver', () => ({
  resolveMCPSelections: mockResolveMCPSelections
}))
vi.mock('$lib/services/apiKey.server', () => ({ apiKeyService: mockApiKeyService }))
vi.mock('$lib/server/services/dockerGatewayConfig', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/server/services/dockerGatewayConfig')>()
  return { ...actual, getDockerGatewayAuthToken: vi.fn(() => null) }
})
const mockDetectClaudeCliStatus = vi.hoisted(() => vi.fn())
vi.mock('$lib/server/services/claudeCliStatus', () => ({
  detectClaudeCliStatus: mockDetectClaudeCliStatus,
  resolveClaudeCliExecutable: vi.fn(() => '/fake/claude')
}))
// A run's credential is minted in Redis; this suite only needs the bridge to carry one.
vi.mock('$lib/server/services/cliHelperToken', () => ({
  mintCliRunCredential: vi.fn(async (options: { agentId: string }) => ({
    credentialId: 'arc_zb_parity',
    token: 'arc_zb_parity.bsac_secret',
    agentId: options.agentId
  }))
}))
vi.mock('$lib/server/services/agentRunCredentials', async (importOriginal) => ({
  ...(await importOriginal<typeof import('$lib/server/services/agentRunCredentials')>()),
  revokeRunCredential: vi.fn(async () => undefined)
}))

// The same helper settings on both lanes, with tools on AND off, so both lists are non-empty.
const NATIVE_TOOLS = {
  nativeTools: {
    fetchZipEnabled: true,
    dynamicMcpEnabled: true,
    batshitToolsEnabled: true,
    agentBrowserEnabled: false,
    bashEnabled: true
  }
}

// Long ids with slugs that differ from them: the helper server must depend on neither.
const codexAgent = {
  id: 'zb_parity_codex_agent_with_a_long_id',
  user_id: 'josh',
  displayName: 'Parity Codex',
  slug: 'parity-codex-slug',
  primary_model_provider: 'codex-cli',
  codex_settings: {},
  provider_specific_settings: NATIVE_TOOLS,
  assignedSubagents: [] as string[],
  // Workers off: `spawn_workers` is on the same bridge but outside BL-153's question.
  workers_enabled: false
}
const claudeAgent = {
  id: 'zb_parity_claude_agent_with_a_long_id',
  user_id: 'josh',
  displayName: 'Parity Claude',
  slug: 'parity-claude-slug',
  primary_model_provider: 'claude-cli',
  claude_settings: {},
  provider_specific_settings: NATIVE_TOOLS,
  assignedSubagents: [] as string[],
  workers_enabled: false
}

// BL-153: a subagent id over 16 characters and one with a hyphen, so both halves of the bounded
// name (server segment, tool key) differ from the unbounded one the allow list used to build.
const SUBAGENT_IDS = ['zb_parity_subagent_with_a_long_id', 'zb-parity-api']
const agentsByKey: Record<string, unknown> = {
  [`agent:${codexAgent.id}`]: codexAgent,
  [`agent:${claudeAgent.id}`]: claudeAgent,
  'subagent:zb_parity_sub': { id: 'zb_parity_sub', user_id: 'josh' }
}

const HELPER_SCRIPT = 'mode4-controls-mcp.cjs'
const SUBAGENT_SCRIPT = 'codex-subagent-mcp.cjs'
const runsScript = (script: string) => (entry: any) =>
  Array.isArray(entry?.args) && entry.args.some((arg: unknown) => String(arg).endsWith(script))
const isHelperEntry = runsScript(HELPER_SCRIPT)
const isSubagentEntry = runsScript(SUBAGENT_SCRIPT)

/** `mcp__<server>__<tool>` → its two parts (a server name never contains `__`). */
const splitMcpName = (name: string) => {
  const match = /^mcp__(.+?)__(.+)$/.exec(name)
  if (!match) throw new Error(`not an MCP tool name: ${name}`)
  return { server: match[1], tool: match[2] }
}
const argValue = (argv: string[], flag: string) => {
  const index = argv.indexOf(flag)
  return index >= 0 ? argv[index + 1] : undefined
}
const listArg = (argv: string[], flag: string) =>
  (argValue(argv, flag) ?? '').split(',').filter((entry) => entry.length > 0)

describe('BL-5: the managed CLI helper server name', () => {
  const originalHome = process.env.HOME
  let tempHome = ''
  let realAgentsRoot = ''

  const leakedIntoRealHome = async () => {
    const entries = await readdir(realAgentsRoot).catch(() => [] as string[])
    return entries.filter((entry) => entry.includes('zb_parity'))
  }

  beforeAll(async () => {
    // The real home, read before any test moves HOME and from the real module.
    const realOs = await vi.importActual<typeof import('node:os')>('node:os')
    realAgentsRoot = path.join(realOs.homedir(), '.batshit', 'agents')
    expect(await leakedIntoRealHome()).toEqual([])
  })

  beforeEach(async () => {
    vi.clearAllMocks()
    vi.resetModules()
    tempHome = await mkdtemp(path.join(os.tmpdir(), 'cli-helper-parity-'))
    testHome.current = tempHome
    process.env.HOME = tempHome
    codexAgent.assignedSubagents = []
    claudeAgent.assignedSubagents = []
    mockRedis.getAgents.mockResolvedValue([codexAgent, claudeAgent])
    mockRedis.json.get.mockImplementation(async (key: string) => agentsByKey[key] ?? null)
    mockRedis.execute.mockImplementation(async (fn: (client: any) => unknown) =>
      fn({ json: { get: async (key: string) => agentsByKey[key] ?? null } })
    )
    mockRedis.getProjectPreferences.mockResolvedValue(null)
    mockRedis.getProjects.mockResolvedValue([])
    mockRedis.get.mockResolvedValue(null)
    mockRedis.getUserSettings.mockResolvedValue(null)
    mockGatewayService.list.mockResolvedValue([])
    mockGatewayService.update.mockResolvedValue(undefined)
    mockApiKeyService.retrieve.mockResolvedValue(null)
    mockApiKeyService.store.mockResolvedValue(undefined)
    mockResolveMCPSelections.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: [],
      resolvedToolSelections: [],
      tools: {},
      toolMetadata: new Map(),
      gatewayToolMap: {}
    })
  })

  afterEach(async () => {
    if (originalHome === undefined) delete process.env.HOME
    else process.env.HOME = originalHome
    testHome.current = ''
    if (tempHome) await rm(tempHome, { recursive: true, force: true })
    // Safety net: this test's profiles must never land in the real home folder.
    expect(await leakedIntoRealHome()).toEqual([])
  })

  async function writeProfiles() {
    const { syncAgentCodexProfiles, buildAgentProfileId } = await import('../codexProfileManager')
    const { syncAgentClaudeProfiles, buildClaudeProfileId } = await import('../claudeProfileManager')
    await syncAgentCodexProfiles('josh')
    await syncAgentClaudeProfiles('josh')

    const codexConfig = parseToml(
      await readFile(
        path.join(tempHome, '.batshit', 'agents', buildAgentProfileId(codexAgent.id), '.codex', 'config.toml'),
        'utf8'
      )
    ) as Record<string, any>
    const claudeMcp = JSON.parse(
      await readFile(
        path.join(tempHome, '.batshit', 'agents', buildClaudeProfileId(claudeAgent.id), '.claude', 'mcp.json'),
        'utf8'
      )
    ) as Record<string, any>

    const codexHelpers = Object.entries(codexConfig.mcp_servers ?? {}).filter(([, entry]) => isHelperEntry(entry))
    const claudeHelpers = Object.entries(claudeMcp.mcpServers ?? {}).filter(([, entry]) => isHelperEntry(entry))
    return { codexConfig, claudeMcp, codexHelpers, claudeHelpers }
  }

  it('is batshit_helpers in the Codex profile and the Claude profile, whatever the agent id or slug', async () => {
    const { codexConfig, claudeMcp, codexHelpers, claudeHelpers } = await writeProfiles()

    expect(codexHelpers.map(([key]) => key)).toEqual(['batshit_helpers'])
    expect(claudeHelpers.map(([key]) => key)).toEqual(['batshit_helpers'])
    // No server in either file still carries the per-agent name.
    expect(Object.keys(codexConfig.mcp_servers ?? {}).filter((key) => key.includes('mode4'))).toEqual([])
    expect(Object.keys(claudeMcp.mcpServers ?? {}).filter((key) => key.includes('mode4'))).toEqual([])
  })

  it("names the Claude profile's helper server in every --allowedTools and --disallowedTools entry", async () => {
    const { codexHelpers, claudeHelpers } = await writeProfiles()
    const [[claudeServer]] = claudeHelpers
    const [[, codexEntry]] = codexHelpers as Array<[string, any]>

    const { ClaudeBridge } = await import('../claudeBridge')
    const { MODE4_INTERNAL_HELPER_TOOL_NAMES } = await import('../mode4InternalTools')
    const access = await (new ClaudeBridge() as any).resolveMode4InternalControlAllowTools({
      userId: 'josh',
      agentId: claudeAgent.id,
      providerSettings: claudeAgent.provider_specific_settings,
      selectedCliToolIds: []
    })

    const prefix = `mcp__${claudeServer}__`
    const allowed: string[] = access.allowTools
    const denied: string[] = access.disallowTools
    for (const name of [...allowed, ...denied]) {
      expect(name.startsWith(prefix), name).toBe(true)
    }
    const allowedTools = allowed.map((name) => name.slice(prefix.length))
    const deniedTools = denied.map((name) => name.slice(prefix.length))

    // Allow and deny split the helper set between them, and nothing is on both.
    expect([...allowedTools, ...deniedTools].sort()).toEqual([...MODE4_INTERNAL_HELPER_TOOL_NAMES].sort())
    expect(allowedTools.filter((tool) => deniedTools.includes(tool))).toEqual([])
    expect(deniedTools.length).toBeGreaterThan(0)

    // The same settings enable the same helper tools on the Codex lane.
    expect([...allowedTools].sort()).toEqual([...codexEntry.enabled_tools].sort())
    expect([...deniedTools].sort()).toEqual([...codexEntry.disabled_tools].sort())

    // BL-878: NATIVE_TOOLS saves Bash on, but Codex and Claude have their own Bash: Batshit's
    // helper is denied by name on both lanes and allowed on neither.
    expect(deniedTools).toContain('batshit_server_bash_execute')
    expect(allowedTools).not.toContain('batshit_server_bash_execute')
    expect(codexEntry.enabled_tools).not.toContain('batshit_server_bash_execute')
    expect(codexEntry.disabled_tools).toContain('batshit_server_bash_execute')
  })

  /**
   * BL-159: run `ClaudeBridge.streamNativeMode` for real against a stand-in `claude` that
   * writes down the argv and the permission env it was given, then answers one `result`.
   */
  async function runClaude(request: Record<string, unknown>) {
    const argvOut = path.join(tempHome, `claude-argv-${Math.random().toString(36).slice(2)}.json`)
    const probe = path.join(tempHome, 'claude-probe.cjs')
    await writeFile(
      probe,
      [
        `#!${process.execPath}`,
        "const fs = require('node:fs')",
        "const readline = require('node:readline')",
        'const rl = readline.createInterface({ input: process.stdin })',
        "rl.once('line', () => {",
        '  fs.writeFileSync(process.env.ZB_PARITY_ARGV_OUT, JSON.stringify({',
        '    argv: process.argv.slice(2),',
        '    planAllowTools: process.env.BATSHIT_CLAUDE_PLAN_ALLOW_TOOLS ?? null,',
        '    permissionMode: process.env.BATSHIT_CLAUDE_PERMISSION_MODE ?? null',
        '  }))',
        "  process.stdout.write(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'ok', usage: { input_tokens: 1, output_tokens: 1 } }) + '\\n')",
        '  rl.close()',
        '  process.exit(0)',
        '})'
      ].join('\n'),
      'utf8'
    )
    await chmod(probe, 0o755)
    mockDetectClaudeCliStatus.mockResolvedValue({
      available: true,
      executable: probe,
      version: '0.0.0-test',
      source: 'env'
    })

    const previousOut = process.env.ZB_PARITY_ARGV_OUT
    process.env.ZB_PARITY_ARGV_OUT = argvOut
    try {
      const { ClaudeBridge } = await import('../claudeBridge')
      const result = await new ClaudeBridge().streamNativeMode({
        userId: 'josh',
        sessionId: 'zb_parity_session',
        messageId: 'zb_parity_message',
        messages: [{ role: 'user', content: 'hello' }],
        projectPath: tempHome,
        toolApprovalMode: 'off',
        selectedCliToolIds: [],
        ...request
      } as any)
      for await (const _chunk of result.stream as AsyncIterable<unknown>) {
        // drain: the run ends at the stand-in's `result`
      }
    } finally {
      if (previousOut === undefined) delete process.env.ZB_PARITY_ARGV_OUT
      else process.env.ZB_PARITY_ARGV_OUT = previousOut
    }

    const recorded = JSON.parse(await readFile(argvOut, 'utf8')) as {
      argv: string[]
      planAllowTools: string | null
      permissionMode: string | null
    }
    const mcpConfigPath = argValue(recorded.argv, '--mcp-config')
    expect(mcpConfigPath, 'the run passes its profile as --mcp-config').toBeTruthy()
    const mcpServers = (JSON.parse(await readFile(mcpConfigPath!, 'utf8')) as Record<string, any>)
      .mcpServers as Record<string, any>
    return {
      ...recorded,
      mcpServers,
      allowed: listArg(recorded.argv, '--allowedTools'),
      denied: listArg(recorded.argv, '--disallowedTools')
    }
  }

  for (const permissionMode of ['acceptEdits', 'plan'] as const) {
    it(`BL-159/BL-153: the real Claude arguments name only servers its profile registers (${permissionMode})`, async () => {
      codexAgent.assignedSubagents = [...SUBAGENT_IDS]
      claudeAgent.assignedSubagents = [...SUBAGENT_IDS]
      const { codexConfig } = await writeProfiles()

      const run = await runClaude({
        agentId: claudeAgent.id,
        agentSlug: claudeAgent.slug,
        providerSettings: claudeAgent.provider_specific_settings,
        claudeSettings: { permissionMode, allowedTools: ['Bash(*)', 'Write'] },
        assignedSubagents: SUBAGENT_IDS.map((id) => ({ id, displayName: id }))
      })

      expect(argValue(run.argv, '--permission-mode')).toBe(permissionMode)
      // BL-389: a managed turn never saves Claude Code's own session copy of the compiled chat.
      expect(run.argv).toContain('--no-session-persistence')
      // BL-270: nor writes its Plan-mode plan into the user's own ~/.claude/plans.
      expect(run.denied).toContain(`Edit(/${path.join(tempHome, '.claude', 'plans')}/**)`)
      const registered = new Set(Object.keys(run.mcpServers))
      const mcpEntries = [...run.allowed, ...run.denied].filter((name) => name.startsWith('mcp__'))
      expect(mcpEntries.length).toBeGreaterThan(0)
      for (const name of mcpEntries) {
        expect(registered.has(splitMcpName(name).server), `${name} names a registered server`).toBe(true)
      }

      // The Subagent bridge: its allow entries are exactly the tools the Codex twin enables on its
      // own bridge (the same assigned ids), under the server the Claude profile registered.
      const [subagentServer] = Object.entries(run.mcpServers).find(([, entry]) => isSubagentEntry(entry))!
      const [, codexSubagentEntry] = Object.entries(codexConfig.mcp_servers ?? {}).find(([, entry]) =>
        isSubagentEntry(entry)
      ) as [string, any]
      const subagentAllowed = run.allowed.filter((name) => name.startsWith('mcp__') && splitMcpName(name).server === subagentServer)
      expect(subagentAllowed.map((name) => splitMcpName(name).tool).sort()).toEqual(
        [...codexSubagentEntry.enabled_tools].sort()
      )
      // ...and exactly the names the DCM roster prints for those subagents.
      expect(subagentAllowed.sort()).toEqual(
        SUBAGENT_IDS.map((id) => buildCliSubagentMcpToolReference(claudeAgent, { id })!.fullToolName).sort()
      )

      // BL-270: only a Plan-mode run is told to keep its plan in the reply.
      const { CLAUDE_MANAGED_PLAN_MODE_NOTE } = await import('../claudeBridge')
      expect(String(argValue(run.argv, '--append-system-prompt') ?? '').includes(CLAUDE_MANAGED_PLAN_MODE_NOTE)).toBe(
        permissionMode === 'plan'
      )

      if (permissionMode === 'plan') {
        // Plan mode: no approval tool, and the Plan allow list is the Subagent tools.
        expect(run.argv).not.toContain('--permission-prompt-tool')
        expect(run.permissionMode).toBe('plan')
        expect(JSON.parse(run.planAllowTools ?? '[]').sort()).toEqual(subagentAllowed.sort())
        // BL-630: the complete real argv list contains only this Plan allow list.
        expect([...run.allowed].sort()).toEqual([...subagentAllowed].sort())
      }
    })
  }

  // BL-1315: the run credential names the chat and the reply this Claude run answers.
  // `/api/controls/use` reads both off the credential, and a Settings write is admitted only on
  // the Stop of that exact reply (BL-1314), so a mint without them, or with another run's, would
  // refuse every Settings write or admit a stale one. `codexBridge.test.ts` pins the Codex mint.
  it("BL-1315: a Claude run's credential is minted for the run's own chat and reply", async () => {
    await writeProfiles()

    await runClaude({
      agentId: claudeAgent.id,
      agentSlug: claudeAgent.slug,
      providerSettings: claudeAgent.provider_specific_settings,
      claudeSettings: { permissionMode: 'acceptEdits' }
    })

    const { mintCliRunCredential } = await import('$lib/server/services/cliHelperToken')
    expect(mintCliRunCredential).toHaveBeenCalledTimes(1)
    expect(vi.mocked(mintCliRunCredential).mock.calls[0][0]).toMatchObject({
      userId: 'josh',
      agentId: claudeAgent.id,
      sessionId: 'zb_parity_session',
      messageId: 'zb_parity_message',
      runtime: 'claude',
      delegated: false
    })
  })

  // BL-267: the profile registers `spawn_workers` on the Subagent bridge for a Workers-on
  // primary, but neither allow list named it, so with approvals off Claude refused a Worker
  // call the way it refused Subagent calls before BL-153.
  it('BL-267: a Workers-on primary pre-allows spawn_workers under the bridge its profile registers', async () => {
    claudeAgent.workers_enabled = true
    try {
      await writeProfiles()
      const run = await runClaude({
        agentId: claudeAgent.id,
        agentSlug: claudeAgent.slug,
        providerSettings: claudeAgent.provider_specific_settings,
        claudeSettings: { permissionMode: 'acceptEdits' },
        assignedSubagents: [],
        workersEnabled: true
      })

      const [bridgeServer, bridgeEntry] = Object.entries(run.mcpServers).find(([, entry]) =>
        isSubagentEntry(entry)
      )!
      expect(bridgeEntry, 'the Workers-only primary still registers the bridge').toBeTruthy()
      const workerTool = `mcp__${bridgeServer}__spawn_workers`
      expect(run.allowed).toContain(workerTool)
      expect(run.denied).not.toContain(workerTool)

      // Review of BL-267: never in Plan mode, where --allowedTools would pre-allow a Worker
      // that can change files.
      const plan = await runClaude({
        agentId: claudeAgent.id,
        agentSlug: claudeAgent.slug,
        providerSettings: claudeAgent.provider_specific_settings,
        claudeSettings: { permissionMode: 'plan' },
        assignedSubagents: [],
        workersEnabled: true
      })
      expect(argValue(plan.argv, '--permission-mode')).toBe('plan')
      expect(plan.allowed).not.toContain(workerTool)
      expect(JSON.parse(plan.planAllowTools ?? '[]')).not.toContain(workerTool)

      // Workers off: the profile has no bridge, and the allow list names no Worker tool.
      claudeAgent.workers_enabled = false
      await writeProfiles()
      const off = await runClaude({
        agentId: claudeAgent.id,
        agentSlug: claudeAgent.slug,
        providerSettings: claudeAgent.provider_specific_settings,
        claudeSettings: { permissionMode: 'acceptEdits' },
        assignedSubagents: [],
        workersEnabled: false
      })
      expect(Object.values(off.mcpServers).some(isSubagentEntry)).toBe(false)
      expect(off.allowed.some((name) => name.endsWith('__spawn_workers'))).toBe(false)
    } finally {
      claudeAgent.workers_enabled = false
    }
  })

  // BL-878: the same real-argv proof for a CLI Worker, which shares the Subagent's profile
  // function and delegated run shape but has its own runtime id namespace and stored owner (its
  // parent Agent, as `subagentRunner.ts` pins it).
  for (const delegatedKind of ['CLI Subagent', 'CLI Worker'] as const) {
  it(`BL-159/BL-616: a ${delegatedKind} uses batshit_helpers, denies the separate approval callback, and carries no delegation tools`, async () => {
    // Mirror the stored same-user owner and parent the real credential minter checks.
    mockRedis.get.mockImplementation(async (key: string) => agentsByKey[key] ?? null)
    const { prepareManagedClaudeSubagentProfile } = await import('../claudeProfileManager')
    const { buildAgentProfileId } = await import('../codexProfileManager')
    const { buildCliSubagentProviderSettings } = await import('../cliSubagentProfile')
    const { MODE4_INTERNAL_HELPER_TOOL_NAMES } = await import('../mode4InternalTools')
    const { buildCliWorkerRuntimeId } = await import('$lib/utils/subagentSlug')
    const isWorker = delegatedKind === 'CLI Worker'
    const runtimeId = isWorker ? buildCliWorkerRuntimeId('zb_parity_worker') : 'subagent_cli_zb_parity_sub'
    const profileId = buildAgentProfileId(runtimeId)
    const providerSettings = buildCliSubagentProviderSettings({
      id: 'zb_parity_sub',
      provider_specific_settings: NATIVE_TOOLS
    } as any)

    await prepareManagedClaudeSubagentProfile({
      userId: 'josh',
      profileId,
      runtimeId,
      label: `Parity Sub ${delegatedKind}`,
      displayName: 'Parity Sub',
      slug: 'zb_parity_sub',
      providerSettings
    } as any)
    const run = await runClaude({
      agentId: runtimeId,
      agentSlug: 'zb_parity_sub',
      delegatedRun: true,
      processOwner: isWorker
        ? { userId: 'josh', kind: 'agent', id: claudeAgent.id }
        : { userId: 'josh', kind: 'subagent', id: 'zb_parity_sub' },
      commandParentAgentId: claudeAgent.id,
      scopeAgentId: isWorker ? 'zb_parity_worker' : 'zb_parity_sub',
      delegatedAllowedControlIds: [],
      providerSettings,
      claudeSettings: { permissionMode: 'acceptEdits', profileId },
      assignedSubagents: []
    })

    // BL-389: a Subagent's or Worker's turn saves no session copy either.
    expect(run.argv).toContain('--no-session-persistence')
    // BL-270: and never writes a plan into the user's own ~/.claude/plans.
    expect(run.denied).toContain(`Edit(/${path.join(tempHome, '.claude', 'plans')}/**)`)
    const registered = Object.keys(run.mcpServers)
    expect(registered).toContain('batshit_helpers')
    expect(Object.values(run.mcpServers).some(isSubagentEntry)).toBe(false)
    // BL-502 keeps the native permission callback off the model's tool list in
    // every managed run, including Subagents. It is a separate registered server,
    // not a helper or delegation tool. Only this exact DENIED entry is excepted.
    const approvalServer = 'batshit_gateway_claude-approvals'
    const approvalTool = `mcp__${approvalServer}__batshit_permission_prompt`
    expect(registered.sort()).toEqual(['batshit_helpers', approvalServer].sort())
    expect(runsScript('claude-permission-mcp.cjs')(run.mcpServers[approvalServer])).toBe(true)
    expect(run.allowed).not.toContain(approvalTool)
    // runClaude disables approval prompts; denial still protects the model surface.
    expect(run.argv).not.toContain('--permission-prompt-tool')
    expect(run.denied.filter((name) => name === approvalTool)).toEqual([approvalTool])

    const allowedMcp = run.allowed.filter((name) => name.startsWith('mcp__'))
    const deniedMcp = run.denied.filter((name) => name.startsWith('mcp__') && name !== approvalTool)
    for (const name of [...allowedMcp, ...deniedMcp]) {
      expect(splitMcpName(name).server, name).toBe('batshit_helpers')
    }
    const allowedTools = allowedMcp.map((name) => splitMcpName(name).tool)
    const deniedTools = deniedMcp.map((name) => splitMcpName(name).tool)
    expect([...allowedTools, ...deniedTools].sort()).toEqual([...MODE4_INTERNAL_HELPER_TOOL_NAMES].sort())
    expect(allowedTools.filter((tool) => deniedTools.includes(tool))).toEqual([])
    // The Subagent profile turns Fetch Zip off whatever the Subagent's own toggles say.
    expect(deniedTools).toContain('batshit_server_fetch_zip')
    // BL-878: NATIVE_TOOLS saves Bash on, and Claude has its own Bash: the real argv of a
    // delegated run denies Batshit's helper by name and never allows it.
    expect(deniedTools).toContain('batshit_server_bash_execute')
    expect(allowedTools).not.toContain('batshit_server_bash_execute')
  })
  }
})
