import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import os from 'node:os'
import path from 'node:path'
import { chmod, mkdir, mkdtemp, readFile, realpath, rm, stat, writeFile } from 'node:fs/promises'
import { nativeToolService, normalizeNativeControlUseInput } from '../nativeTools'
import { mcpGatewayDiscovery } from '../mcpGatewayDiscovery'
import { mcpGatewayService } from '../mcpGatewayService'
import { apiKeyService } from '$lib/services/apiKey.server'
import { redis } from '$lib/server/redis'
import { resolveDynamicMcpGatewayScope } from '../mcpSelectionResolver'
import * as fabricRegistry from '../fabricRegistry'
import {
  buildSkillScriptCommand,
  executeSkillRuntimeAction,
  findBundleFileByPath,
  readSkillBundleFileText,
  resolveBundleFileAbsolutePath,
  resolveSkillRuntimeForTool
} from '../skillRuntimeToolService'
import * as runtimeAddons from '../runtimeAddons'
import { resolveEnabledMode4InternalHelperTools } from '../mode4InternalTools'
import { isBrokerAvailable, resolveBrokerToolToggles } from '$lib/utils/brokerAvailability'
import { createEphemeralImageRegistry } from '../toolResultImageDelivery'

const skillRuntimeToolMocks = vi.hoisted(() => ({
  resolveSkillRuntimeForTool: vi.fn(),
  findBundleFileByPath: vi.fn(),
  readSkillBundleFileText: vi.fn(),
  resolveBundleFileAbsolutePath: vi.fn(),
  buildSkillScriptCommand: vi.fn(),
  normalizeBundleFiles: vi.fn(),
  executeSkillRuntimeAction: vi.fn()
}))

const skillRegistryMocks = vi.hoisted(() => ({
  getSkill: vi.fn(),
  evaluateSkillDependencies: vi.fn()
}))

const nativeToolEnv = vi.hoisted(() => ({
  BATSHIT_ENABLE_AGENT_BROWSER: 'false'
} as Record<string, string | undefined>))

// SA-105 P2: recall delivery reads bytes at delivery time. The loader is mocked
// so these tests exercise the DELIVERY decision, not Redis or the upload store.
const memoryMediaMocks = vi.hoisted(() => ({
  loadMemoryMedia: vi.fn()
}))

vi.mock('../memory/memoryMedia', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../memory/memoryMedia')>()),
  loadMemoryMedia: memoryMediaMocks.loadMemoryMedia
}))

const appleContainerSandboxMocks = vi.hoisted(() => ({
  cleanupAppleContainerSandboxesForSession: vi.fn(),
  executeAppleContainerSandboxCommand: vi.fn(),
  getAppleContainerSandboxStatus: vi.fn(),
  recoverAppleContainerSandbox: vi.fn()
}))

vi.mock('$env/dynamic/private', () => ({
  env: nativeToolEnv
}))

vi.mock('$env/dynamic/public', () => ({
  env: {}
}))

vi.mock('$lib/services/apiClient', () => ({
  apiClient: {},
  BATSHIT_SERVER_URL: 'http://localhost:5600',
  BATSHIT_SERVER_API_URL: 'http://localhost:5600/api/v1'
}))

vi.mock('$lib/server/redis', () => ({
  RedisService: vi.fn(function RedisServiceMock(this: any) {
    this.getClient = vi.fn().mockResolvedValue({
      sMembers: vi.fn().mockResolvedValue([]),
      json: {
        get: vi.fn().mockResolvedValue(null),
        set: vi.fn().mockResolvedValue('OK')
      }
    })
  }),
  redis: {
    get: vi.fn(),
    execute: vi.fn(),
    json: {
      get: vi.fn()
    },
    getZip: vi.fn(),
    getSession: vi.fn(),
    getUserSettings: vi.fn(),
    getProjectPreferences: vi.fn()
  }
}))

vi.mock('../mcpGatewayDiscovery', () => ({
  mcpGatewayDiscovery: {
    loadToolsForUser: vi.fn()
  }
}))

vi.mock('../mcpGatewayService', () => ({
  mcpGatewayService: {
    listEnabled: vi.fn()
  }
}))

vi.mock('../mcpSelectionResolver', () => ({
  resolveDynamicMcpGatewayScope: vi.fn()
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    exists: vi.fn(),
    retrieve: vi.fn()
  }
}))

vi.mock('../skillRuntimeToolService', () => ({
  resolveSkillRuntimeForTool: skillRuntimeToolMocks.resolveSkillRuntimeForTool,
  findBundleFileByPath: skillRuntimeToolMocks.findBundleFileByPath,
  readSkillBundleFileText: skillRuntimeToolMocks.readSkillBundleFileText,
  resolveBundleFileAbsolutePath: skillRuntimeToolMocks.resolveBundleFileAbsolutePath,
  buildSkillScriptCommand: skillRuntimeToolMocks.buildSkillScriptCommand,
  normalizeBundleFiles: skillRuntimeToolMocks.normalizeBundleFiles,
  executeSkillRuntimeAction: skillRuntimeToolMocks.executeSkillRuntimeAction
}))

vi.mock('../skillRegistry', () => ({
  getSkill: skillRegistryMocks.getSkill,
  evaluateSkillDependencies: skillRegistryMocks.evaluateSkillDependencies
}))

vi.mock('../appleContainerSandbox', () => ({
  cleanupAppleContainerSandboxesForSession:
    appleContainerSandboxMocks.cleanupAppleContainerSandboxesForSession,
  ensureBatshitHomeSandboxMountPath: vi.fn(async () => path.join(os.homedir(), '.batshit')),
  executeAppleContainerSandboxCommand:
    appleContainerSandboxMocks.executeAppleContainerSandboxCommand,
  getAppleContainerSandboxStatus: appleContainerSandboxMocks.getAppleContainerSandboxStatus,
  isPathInsideSandboxRoot: (targetPath: string, rootPath: string) => {
    const relative = path.relative(path.resolve(rootPath), path.resolve(targetPath))
    return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))
  },
  recoverAppleContainerSandbox: appleContainerSandboxMocks.recoverAppleContainerSandbox
}))

describe('nativeToolService hardening', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    for (const key of Object.keys(nativeToolEnv)) {
      delete nativeToolEnv[key]
    }
    delete process.env.BATSHIT_CONTAINERIZED
    delete process.env.BATSHIT_RUNTIME_ENV
    delete process.env.BATSHIT_NATIVE_DOCKER_SANDBOX_DRIVER
    delete process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL
    delete process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN
    delete process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TIMEOUT_MS
    delete process.env.BATSHIT_DOCKER_SANDBOX_CLI
    delete process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL
    delete process.env.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN
    delete process.env.BATSHIT_AGENT_BROWSER_TMP_DIR
    delete nativeToolEnv.BATSHIT_CONTAINERIZED
    vi.mocked(redis.getSession).mockResolvedValue(null as any)
    nativeToolEnv.BATSHIT_ENABLE_AGENT_BROWSER = 'false'
    nativeToolService.__setAgentBrowserCliRunnerForTests(null)
    vi.mocked(resolveDynamicMcpGatewayScope).mockImplementation(async ({ selectedGateways }: any) => ({
      resolvedGateways: Array.isArray(selectedGateways) ? selectedGateways : [],
      defaultGateways: null,
      source: Array.isArray(selectedGateways) ? 'selected' : 'user-global'
    }))
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          execute: vi.fn().mockResolvedValue({ ok: true })
        }
      },
      metadata: new Map()
    } as any)
    vi.mocked(mcpGatewayService.listEnabled).mockResolvedValue([])
    vi.mocked(redis.get).mockResolvedValue(null as any)
    vi.mocked((redis as any).execute).mockImplementation(async (callback: any) => {
      return await callback({
        json: {
          get: vi.fn().mockResolvedValue(null),
          set: vi.fn().mockResolvedValue('OK')
        },
        expire: vi.fn().mockResolvedValue(1),
        lPush: vi.fn().mockResolvedValue(1),
        lTrim: vi.fn().mockResolvedValue('OK')
      })
    })
    vi.mocked(redis.json.get).mockResolvedValue(null as any)
    vi.mocked(redis.getUserSettings).mockResolvedValue(null as any)
    vi.mocked(redis.getProjectPreferences).mockResolvedValue(null as any)
    vi.mocked(apiKeyService.exists).mockResolvedValue(false)
    vi.mocked(apiKeyService.retrieve).mockResolvedValue(null)
    vi.mocked(skillRegistryMocks.getSkill).mockResolvedValue(null)
    vi.mocked(skillRegistryMocks.evaluateSkillDependencies).mockResolvedValue({
      allRequiredAvailable: true,
      statuses: []
    })
    vi.mocked(appleContainerSandboxMocks.cleanupAppleContainerSandboxesForSession).mockResolvedValue([])
    vi.mocked(appleContainerSandboxMocks.executeAppleContainerSandboxCommand).mockResolvedValue({
      ok: false,
      reason: 'Apple Container sandbox mock not configured'
    })
    vi.mocked(appleContainerSandboxMocks.getAppleContainerSandboxStatus).mockResolvedValue({
      available: false,
      installed: false,
      supported: true,
      backend: 'apple_container',
      driver: 'apple_container',
      version: null,
      network: 'batshit-apple-sandbox-internal',
      image: 'bash:5.2',
      policy: 'internal-network',
      reason: 'Apple Container sandbox mock not configured',
      installUrl: 'https://github.com/apple/container/releases/latest',
      capabilities: ['status', 'recover', 'execute', 'cleanup']
    })
    vi.mocked(appleContainerSandboxMocks.recoverAppleContainerSandbox).mockRejectedValue(
      new Error('Apple Container sandbox mock not configured')
    )
    vi.mocked(resolveSkillRuntimeForTool).mockResolvedValue({
      runtime: null,
      error: 'resolveSkillRuntimeForTool mock not configured'
    })
    vi.mocked(executeSkillRuntimeAction).mockResolvedValue({
      success: false,
      action: 'list',
      error: 'executeSkillRuntimeAction mock not configured'
    } as any)
    vi.mocked(findBundleFileByPath).mockImplementation((files: any[], targetPath: string) =>
      files.find((file: any) => file.path === targetPath) ?? null
    )
    vi.mocked(readSkillBundleFileText).mockImplementation((file: any) => ({
      content: String(file?.content ?? ''),
      truncated: false,
      originalChars: String(file?.content ?? '').length
    }))
    vi.mocked(resolveBundleFileAbsolutePath).mockImplementation((_cacheDir: string, file: any) =>
      `/tmp/${String(file?.path ?? 'script.sh')}`
    )
    vi.mocked(buildSkillScriptCommand).mockImplementation((scriptPath: string, args: string[] = []) =>
      [scriptPath, ...args].join(' ')
    )
    skillRuntimeToolMocks.normalizeBundleFiles.mockImplementation((files: any) =>
      Array.isArray(files) ? files : []
    )
  })

  afterEach(() => {
    nativeToolService.__setAgentBrowserCliRunnerForTests(null)
    vi.unstubAllGlobals()
    vi.unstubAllEnvs()
    vi.restoreAllMocks()
  })

  it('blocks read-only command chaining patterns', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'pwd; ls',
      policyMode: 'read_only',
      requireApproval: false,
      workspaceRoot: process.cwd()
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/command chaining/i)
  })

  it('allows diff commands in read-only mode', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'diff --version',
      policyMode: 'read_only',
      requireApproval: false,
      workspaceRoot: process.cwd()
    })

    expect(result.success).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.mappedToolName).toBe('native_bash_execute')
  })

  it('blocks cwd paths outside workspace root', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'pwd',
      cwd: '/tmp',
      policyMode: 'workspace',
      requireApproval: false,
      workspaceRoot: process.cwd()
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/outside allowed workspace root/i)
  })

  it('blocks execution when no active project or default workspace is configured', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'pwd',
      policyMode: 'workspace',
      requireApproval: false
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(result.reason).toMatch(/default project directory|active project/i)
  })

  it('uses Default Project Directory when no active project path is provided', async () => {
    vi.mocked(redis.getProjectPreferences).mockResolvedValue({
      default_workspace_path: process.cwd()
    } as any)

    const result = await nativeToolService.nativeBashExecute({
      userId: 'josh',
      command: 'pwd',
      policyMode: 'read_only',
      requireApproval: false
    })

    expect(result.success).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.workspaceRoot).toBe(result.cwd)
    expect(redis.getProjectPreferences).toHaveBeenCalledWith('josh')
  })

  it('prefers active project path over Default Project Directory', async () => {
    vi.mocked(redis.getProjectPreferences).mockResolvedValue({
      default_workspace_path: '/tmp'
    } as any)

    const result = await nativeToolService.nativeBashExecute({
      userId: 'josh',
      projectPath: process.cwd(),
      command: 'pwd',
      policyMode: 'read_only',
      requireApproval: false
    })

    expect(result.success).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.workspaceRoot).toBe(result.cwd)
    expect(redis.getProjectPreferences).not.toHaveBeenCalled()
  })

  it('returns mapped output for allowed read-only command', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'pwd',
      policyMode: 'read_only',
      requireApproval: false,
      workspaceRoot: process.cwd()
    })

    expect(result.success).toBe(true)
    expect(result.blocked).toBe(false)
    expect(typeof result.cwd).toBe('string')
    expect(result.mappedToolName).toBe('native_bash_execute')
  })

  it('enforces Agent Settings bash policy mode for Mode 3 native tool calls', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashPolicyMode: 'workspace',
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          agentBrowserEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()

    const result = await bashTool.execute({
      command: "printf 'ok' > /dev/null",
      // Even if a model tries to pass read_only, the tool must enforce persisted Agent Settings.
      policyMode: 'read_only'
    } as any)

    expect(result.success).toBe(true)
    expect(result.blocked).toBe(false)
    expect(result.policyMode).toBe('workspace')
  })

  it('allows markdown-only writes in Plan mode', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-plan-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: "cat > PLAN.md <<'EOF'\n# Plan\nEOF",
        accessMode: 'plan',
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.success).toBe(true)
      expect(result.blocked).toBe(false)
      expect(result.accessMode).toBe('plan')
      expect(result.mappedToolName).toBe('batshit_server_overwrite_file')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks redirect writes into protected system skill bundles', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-protected-skill-'))
    const protectedFile = path.join(
      tempWorkspace,
      'batshit-app',
      'src',
      'lib',
      'server',
      'system-skills',
      'speech-setup',
      'SKILL.md'
    )

    try {
      await mkdir(path.dirname(protectedFile), { recursive: true })
      await writeFile(protectedFile, '# Original\n', 'utf8')

      const result = await nativeToolService.nativeBashExecute({
        command: "cat > batshit-app/src/lib/server/system-skills/speech-setup/SKILL.md <<'EOF'\n# Mutated\nEOF",
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local'
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/system skill bundles are protected/i)
      expect(await readFile(protectedFile, 'utf8')).toBe('# Original\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks apply_patch edits into protected system skill bundles', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-protected-skill-'))
    const protectedDir = path.join(
      tempWorkspace,
      'batshit-app',
      'src',
      'lib',
      'server',
      'system-skills',
      'speech-setup'
    )
    const protectedFile = path.join(protectedDir, 'SKILL.md')

    try {
      await mkdir(protectedDir, { recursive: true })
      await writeFile(protectedFile, '# Original\n', 'utf8')

      const result = await nativeToolService.nativeBashExecute({
        command: [
          "apply_patch <<'EOF'",
          '*** Begin Patch',
          '*** Update File: batshit-app/src/lib/server/system-skills/speech-setup/SKILL.md',
          '@@',
          '-# Original',
          '+# Mutated',
          '*** End Patch',
          'EOF'
        ].join('\n'),
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local'
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/system skill bundles are protected/i)
      expect(await readFile(protectedFile, 'utf8')).toBe('# Original\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks redirect writes into protected system skill runtime cache copies', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-protected-skill-cache-'))
    const tempHome = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-protected-home-'))
    const homedirSpy = vi.spyOn(os, 'homedir').mockReturnValue(tempHome)
    const systemSkillSource = path.join(
      tempWorkspace,
      'batshit-app',
      'src',
      'lib',
      'server',
      'system-skills',
      'speech-setup',
      'SKILL.md'
    )
    const protectedFile = path.join(
      tempHome,
      '.batshit',
      'skills',
      'speech_setup',
      'SKILL.md'
    )

    try {
      await mkdir(path.dirname(systemSkillSource), { recursive: true })
      await writeFile(systemSkillSource, '# Source\n', 'utf8')
      await mkdir(path.dirname(protectedFile), { recursive: true })
      await writeFile(protectedFile, '# Original Cache\n', 'utf8')

      const result = await nativeToolService.nativeBashExecute({
        command: `cat > ${protectedFile} <<'EOF'\n# Mutated Cache\nEOF`,
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local'
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/system skill bundles are protected/i)
      expect(await readFile(protectedFile, 'utf8')).toBe('# Original Cache\n')
    } finally {
      homedirSpy.mockRestore()
      await rm(tempWorkspace, { recursive: true, force: true })
      await rm(tempHome, { recursive: true, force: true })
    }
  })

  it('blocks bash writes into the Batshit product repo outside system skill bundles', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-protected-repo-'))
    const protectedDir = path.join(tempWorkspace, 'batshit-app', 'src', 'routes')
    const protectedFile = path.join(protectedDir, '+page.svelte')
    const serverDir = path.join(tempWorkspace, 'batshit-server')

    try {
      await mkdir(protectedDir, { recursive: true })
      await mkdir(serverDir, { recursive: true })
      await writeFile(protectedFile, '<h1>Original</h1>\n', 'utf8')

      const result = await nativeToolService.nativeBashExecute({
        command: "cat > batshit-app/src/routes/+page.svelte <<'EOF'\n<h1>Mutated</h1>\nEOF",
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local'
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/product source is read-only/i)
      expect(await readFile(protectedFile, 'utf8')).toBe('<h1>Original</h1>\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks apply_patch edits into Batshit repo docs', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-protected-docs-'))
    const docsDir = path.join(tempWorkspace, 'docs')
    const protectedFile = path.join(docsDir, 'notes.md')
    const appDir = path.join(tempWorkspace, 'batshit-app')
    const serverDir = path.join(tempWorkspace, 'batshit-server')

    try {
      await mkdir(docsDir, { recursive: true })
      await mkdir(appDir, { recursive: true })
      await mkdir(serverDir, { recursive: true })
      await writeFile(protectedFile, '# Original\n', 'utf8')

      const result = await nativeToolService.nativeBashExecute({
        command: [
          "apply_patch <<'EOF'",
          '*** Begin Patch',
          '*** Update File: docs/notes.md',
          '@@',
          '-# Original',
          '+# Mutated',
          '*** End Patch',
          'EOF'
        ].join('\n'),
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local'
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/product source is read-only/i)
      expect(await readFile(protectedFile, 'utf8')).toBe('# Original\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('allows quoted-heredoc markdown writes in Plan mode even when content includes backticks', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-plan-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: "cat > NOTES.md <<'EOF'\n```md\nplan\n```\nEOF",
        accessMode: 'plan',
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.blocked).toBe(false)
      expect(result.accessMode).toBe('plan')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('does not treat semicolons inside markdown heredoc body as command chaining in Plan mode', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-plan-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: "cat > NOTES.md <<'EOF'\nAlpha; Beta\nEOF",
        accessMode: 'plan',
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.blocked).toBe(false)
      expect(result.accessMode).toBe('plan')
      expect(result.mappedToolName).toBe('batshit_server_overwrite_file')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks non-markdown writes in Plan mode', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-plan-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: "echo 'console.log(1)' > app.js",
        accessMode: 'plan',
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(result.reason).toMatch(/plan mode/i)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it.each(['local', 'docker_sandbox'] as const)(
    'applies managed apply_patch in native_bash_execute on %s backend',
    async (backend) => {
      const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-apply-patch-'))
      try {
        const targetFile = path.join(tempWorkspace, 'README.md')
        await writeFile(targetFile, 'Hello\nworld\n', 'utf8')
        const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: README.md
@@
-Hello
+Hi
*** End Patch
PATCH`

        const result = await nativeToolService.nativeBashExecute({
          command,
          backend,
          accessMode: 'dangerous',
          requireApproval: false,
          workspaceRoot: tempWorkspace
        })

        expect(result.success).toBe(true)
        expect(result.backend).toBe(backend)
        expect(result.mappedToolName).toBe('batshit_server_edit_file')
        expect(result.managedApplyPatch?.managed).toBe(true)
        expect(result.managedApplyPatch?.operationsApplied).toBe(1)
        expect(result.managedApplyPatch?.touchedPaths).toEqual(expect.arrayContaining(['README.md']))
        expect(result.mappedToolInput?.touchedPaths).toEqual(expect.arrayContaining(['README.md']))
        expect(await readFile(targetFile, 'utf8')).toBe('Hi\nworld\n')
      } finally {
        await rm(tempWorkspace, { recursive: true, force: true })
      }
    }
  )

  it('enforces markdown-only apply_patch targets in Plan mode', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-plan-patch-'))
    try {
      const targetFile = path.join(tempWorkspace, 'app.ts')
      await writeFile(targetFile, 'const value = 1\n', 'utf8')
      const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: app.ts
@@
-const value = 1
+const value = 2
*** End Patch
PATCH`

      const result = await nativeToolService.nativeBashExecute({
        command,
        accessMode: 'plan',
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(result.errorCode).toBe('POLICY_BLOCKED')
      expect(result.reason).toMatch(/markdown \(\.md\) apply_patch targets/i)
      expect(result.reason).toMatch(/app\.ts/i)
      expect(await readFile(targetFile, 'utf8')).toBe('const value = 1\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('returns INVALID_INPUT for malformed managed apply_patch payloads', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-apply-invalid-'))
    try {
      const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: README.md
*** End Patch
PATCH`

      const result = await nativeToolService.nativeBashExecute({
        command,
        accessMode: 'dangerous',
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(false)
      expect(result.errorCode).toBe('INVALID_INPUT')
      expect(result.reason).toMatch(/requires at least one hunk/i)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('uses Agent allow list to skip approval prompts when Approval Policy is On Failure', async () => {
    const { tools, toolApprovals } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          bashEnabled: true,
          bashAccessMode: 'agent',
          bashAgentApprovalCardsEnabled: true,
          bashCommandAllowList: ['re:^\\s*npm\\s+run\\s+check\\b'],
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          agentBrowserEnabled: false
        }
      },
      toolApprovalMode: 'all'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()
    const bashApproval = toolApprovals.native_bash_execute
    expect(typeof bashApproval).toBe('function')

    expect(await bashApproval({ command: 'npm run check' })).toBeUndefined()
    expect(await bashApproval({ command: 'npm run build' })).toBe('user-approval')
    expect(await bashApproval('{"command":"mkdir scratch"}')).toBe('user-approval')
    expect(await bashApproval("cat > NOTES.md <<'EOF'\nhello\nEOF")).toBeUndefined()
    expect(
      await bashApproval(
        "apply_patch <<'PATCH'\n*** Begin Patch\n*** Add File: NOTES.md\n+hello\n*** End Patch\nPATCH"
      )
    ).toBeUndefined()
  })

  it('disables Agent-mode approval prompts by default (policy-only)', async () => {
    const { tools, toolApprovals } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          bashEnabled: true,
          bashAccessMode: 'agent',
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          agentBrowserEnabled: false
        }
      },
      toolApprovalMode: 'off'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()
    expect(toolApprovals.native_bash_execute).toBeUndefined()

    const blockedResult = await bashTool.execute({ command: 'mkdir scratch' })
    expect(blockedResult.success).toBe(false)
    expect(blockedResult.blocked).toBe(true)
    expect(String(blockedResult.reason || '')).toMatch(/blocked by agent mode policy/i)
  })

  it('enforces Never Allow list even in Dangerous mode', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-dangerous-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: 'rm -rf scratch',
        accessMode: 'dangerous',
        neverAllowList: ['re:^\\s*rm\\s+-rf\\s+scratch\\b'],
        requireApproval: false,
        workspaceRoot: tempWorkspace
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(result.reason).toMatch(/never allow/i)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('returns not found when native_fetch_zip cannot locate the zip', async () => {
    vi.mocked(redis.getZip).mockResolvedValue(null as any)

    const result = await nativeToolService.nativeFetchZip({
      userId: 'josh',
      zipId: 'zip_missing_123'
    })

    expect(result.found).toBe(false)
    expect(result.zipId).toBe('zip_missing_123')
  })

  it('blocks native_fetch_zip when zip ownership does not match the active user', async () => {
    vi.mocked(redis.getZip).mockResolvedValue({
      id: 'zip_other_user',
      type: 'tool',
      content: 'secret',
      metadata: {
        sessionId: 'session_other'
      }
    } as any)
    vi.mocked(redis.getSession).mockResolvedValue({
      id: 'session_other',
      user_id: 'someone-else'
    } as any)

    const result = await nativeToolService.nativeFetchZip({
      userId: 'josh',
      zipId: 'zip_other_user'
    })

    expect(result.found).toBe(false)
    expect(result.reason).toMatch(/different user/i)
  })

  it('returns truncated content metadata for native_fetch_zip when maxChars is set', async () => {
    const longContent = 'a'.repeat(120)
    vi.mocked(redis.getZip).mockResolvedValue({
      id: 'zip_demo',
      type: 'tool',
      content: longContent,
      tokens: 3,
      description: 'Demo zip',
      metadata: {
        sessionId: 'session_same'
      }
    } as any)
    vi.mocked(redis.getSession).mockResolvedValue({
      id: 'session_same',
      user_id: 'josh'
    } as any)

    const result = await nativeToolService.nativeFetchZip({
      userId: 'josh',
      zipId: 'zip_demo',
      maxChars: 64
    })

    expect(result.found).toBe(true)
    expect(result.content).toBe('a'.repeat(64))
    expect(result.contentLength).toBe(120)
    expect(result.contentTruncated).toBe(true)
  })

  it('exposes Fetch Zip through broker Fabric ref instead of direct native_fetch_zip', async () => {
    vi.mocked(redis.getZip).mockResolvedValue({
      id: 'zip_demo',
      type: 'tool',
      description: 'Demo zip',
      content: 'hello from zip',
      metadata: {
        sessionId: 'session_zip'
      }
    } as any)
    vi.mocked(redis.getSession).mockResolvedValue({
      id: 'session_zip',
      user_id: 'josh'
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_zip',
      agentId: 'agent_main',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: true,
          dynamicMcpEnabled: false,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: true,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)

    expect((tools as any).native_fetch_zip).toBeUndefined()
    const brokerSearch = (tools as any).native_batshit_tool_search
    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerSearch).toBeTruthy()
    expect(brokerUse).toBeTruthy()

    const searchResult = await brokerSearch.execute({
      family: 'fabric',
      query: 'fetch zip',
      schemaMode: 'compact'
    } as any)
    const fetchZipRefs = searchResult.results
      .map((entry: any) => entry.ref)
      .filter((ref: string) => ref === 'fabric:sys.zip.fetch')
    expect(fetchZipRefs).toHaveLength(1)

    const useResult = await brokerUse.execute({
      ref: 'fabric:sys.zip.fetch',
      input: {
        zipId: 'zip_demo',
        includeContent: true,
        maxChars: 16000
      }
    } as any)

    expect(useResult).toMatchObject({
      success: true,
      family: 'fabric',
      target: 'sys.zip.fetch',
      operationKind: 'fetch_zip',
      rendererFamily: 'generic_tool',
      found: true,
      zipId: 'zip_demo',
      content: 'hello from zip'
    })

    const modelOutput = await brokerUse.toModelOutput({ output: useResult })
    expect(String(modelOutput.value)).toContain('fetch_zip succeeded: zip_demo')
  })

  it('hides brokered Fetch Zip search result when Fetch Zip is disabled', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_zip_disabled',
      agentId: 'agent_main',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: true,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)

    expect((tools as any).native_fetch_zip).toBeUndefined()
    const brokerSearch = (tools as any).native_batshit_tool_search
    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerSearch).toBeTruthy()
    expect(brokerUse).toBeTruthy()

    const searchResult = await brokerSearch.execute({
      family: 'fabric',
      query: 'fetch zip',
      schemaMode: 'compact'
    } as any)

    expect(searchResult.results.map((entry: any) => entry.ref)).not.toContain('fabric:sys.zip.fetch')
    await expect(
      brokerUse.execute({
        ref: 'fabric:sys.zip.fetch',
        input: { zipId: 'zip_demo' }
      } as any)
    ).resolves.toMatchObject({
      success: false,
      code: 'OUT_OF_SCOPE'
    })
  })

  it('blocks internal-only fabric control tools in native dynamic use', async () => {
    const result = await nativeToolService.nativeDynamicMcpUse({
      userId: 'josh',
      toolName: 'mcp_fabric_use',
      params: {}
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/internal-only/i)
    expect(mcpGatewayDiscovery.loadToolsForUser).not.toHaveBeenCalled()
  })

  it('returns timeout-style error when web search aborts', async () => {
    const fetchSpy = vi
      .spyOn(globalThis, 'fetch')
      .mockRejectedValue(new DOMException('Aborted', 'AbortError'))

    const result = await nativeToolService.nativeWebSearch({
      query: 'Batshit',
      timeoutMs: 1000
    })

    expect(result.success).toBe(false)
    expect(result.error).toMatch(/timed out/i)
    fetchSpy.mockRestore()
  })

  it('uses Exa when configured and key exists', async () => {
    vi.mocked(apiKeyService.exists).mockImplementation(async (service, userId) => {
      return service === 'exa' && userId === 'josh'
    })
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (service === 'exa' && userId === 'josh') return 'exa-test-key'
      return null
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Batshit Docs',
              url: 'https://batshit.ai/docs',
              text: 'Native tools documentation.'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    )

    const result = await nativeToolService.nativeWebSearch({
      userId: 'josh',
      query: 'Batshit native tools',
      provider: 'exa'
    })

    expect(result.success).toBe(true)
    expect(result.provider).toBe('exa')
    expect(result.searchType).toBe('auto')
    expect(result.providerOptions?.exaSearchType).toBe('auto')
    expect(result.results?.[0]?.url).toBe('https://batshit.ai/docs')
    expect(apiKeyService.exists).toHaveBeenCalledWith('exa', 'josh')
    expect(apiKeyService.retrieve).toHaveBeenCalledWith('exa', 'josh')

    const request = fetchSpy.mock.calls[0]
    const payload = JSON.parse(String(request?.[1]?.body ?? '{}'))
    expect(payload.type).toBe('auto')
    fetchSpy.mockRestore()
  })

  it('applies request-level Exa search type override over agent/admin defaults', async () => {
    vi.mocked(redis.getUserSettings).mockResolvedValue({
      admin_settings: {
        web_search_exa_type: 'fast'
      }
    } as any)
    vi.mocked(apiKeyService.exists).mockImplementation(async (service, userId) => {
      return service === 'exa' && userId === 'josh'
    })
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (service === 'exa' && userId === 'josh') return 'exa-test-key'
      return null
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Batshit Docs',
              url: 'https://batshit.ai/docs',
              text: 'Native tools documentation.'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    )

    const result = await nativeToolService.nativeWebSearch({
      userId: 'josh',
      query: 'Batshit native tools',
      provider: 'exa',
      agentDefaultExaSearchType: 'neural',
      exaSearchType: 'deep'
    })

    expect(result.success).toBe(true)
    expect(result.provider).toBe('exa')
    expect(result.searchType).toBe('deep')
    expect(result.providerOptions?.exaSearchType).toBe('deep')
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(payload.type).toBe('deep')
    fetchSpy.mockRestore()
  })

  it('falls back to DuckDuckGo when selected provider key is missing', async () => {
    vi.mocked(apiKeyService.exists).mockResolvedValue(false)

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        `
          <html>
            <body>
              <div class="result">
                <a class="result__a" href="https://duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com">Example</a>
                <div class="result__snippet">Example snippet.</div>
              </div>
            </body>
          </html>
        `,
        { status: 200, headers: { 'Content-Type': 'text/html' } }
      ) as any
    )

    const result = await nativeToolService.nativeWebSearch({
      userId: 'josh',
      query: 'fallback check',
      provider: 'exa'
    })

    expect(result.success).toBe(true)
    expect(result.provider).toBe('duckduckgo-html')
    expect(result.providerFallbackReason).toMatch(/exa api key is not configured/i)
    expect(result.providerRequested).toBe('exa')
    expect(result.results?.[0]?.url).toBe('https://example.com')
    fetchSpy.mockRestore()
  })

  it('applies admin default perplexity max tokens per page when provider resolves to perplexity', async () => {
    vi.mocked(redis.getUserSettings).mockResolvedValue({
      admin_settings: {
        web_search_perplexity_max_tokens_per_page: 2048
      }
    } as any)
    vi.mocked(apiKeyService.exists).mockImplementation(async (service, userId) => {
      return service === 'perplexity' && userId === 'josh'
    })
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (service === 'perplexity' && userId === 'josh') return 'perplexity-test-key'
      return null
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Example',
              url: 'https://example.com',
              snippet: 'Example snippet'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    )

    const result = await nativeToolService.nativeWebSearch({
      userId: 'josh',
      query: 'perplexity defaults',
      provider: 'perplexity'
    })

    expect(result.success).toBe(true)
    expect(result.provider).toBe('perplexity')
    expect(result.maxTokensPerPage).toBe(2048)
    expect(result.providerOptions?.perplexityMaxTokensPerPage).toBe(2048)
    const payload = JSON.parse(String(fetchSpy.mock.calls[0]?.[1]?.body ?? '{}'))
    expect(payload.max_tokens_per_page).toBe(2048)
    fetchSpy.mockRestore()
  })

  it('Mode 3 native web search uses saved settings instead of model-supplied provider overrides', async () => {
    vi.mocked(apiKeyService.exists).mockImplementation(async (service, userId) => {
      return service === 'perplexity' && userId === 'josh'
    })
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (service === 'perplexity' && userId === 'josh') return 'perplexity-test-key'
      return null
    })

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          results: [
            {
              title: 'Example',
              url: 'https://example.com',
              snippet: 'Example snippet'
            }
          ]
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    )

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      providerSettings: {
        nativeTools: {
          webSearchEnabled: true,
          webSearchProvider: 'perplexity',
          webSearchPerplexityMaxTokensPerPage: 2048
        }
      }
    } as any)

    const nativeWebSearch = (tools as any).native_web_search
    expect(nativeWebSearch).toBeTruthy()
    expect((nativeWebSearch.inputSchema as any).shape.provider).toBeUndefined()
    expect((nativeWebSearch.inputSchema as any).shape.exaSearchType).toBeUndefined()
    expect((nativeWebSearch.inputSchema as any).shape.perplexityMaxTokensPerPage).toBeUndefined()

    const result = await nativeWebSearch.execute({
      query: 'Mode 3 should follow saved search settings'
    } as any)

    expect(result.success).toBe(true)
    expect(result.provider).toBe('perplexity')
    expect(result.providerRequested).toBeNull()
    expect(result.providerAgentDefault).toBe('perplexity')
    expect(result.maxTokensPerPage).toBe(2048)
    fetchSpy.mockRestore()
  })

  it('native Dynamic MCP resolves and executes tools by original MCP name', async () => {
    const execute = vi.fn().mockResolvedValue({ ok: true })
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        youtube_get_video_info: {
          execute,
          description: 'Fetch YouTube video details'
        }
      },
      metadata: new Map([
        [
          'youtube_get_video_info',
          {
            gatewayId: 'gw_youtube',
            gatewayName: 'YouTube Gateway',
            gatewayType: 'custom',
            mcpServerName: 'youtube',
            originalToolName: 'youtube.get_video_info'
          }
        ]
      ])
    } as any)

    const findResult = await nativeToolService.nativeDynamicMcpFind({
      userId: 'josh',
      tool: 'youtube.get_video_info',
      exact: true
    })
    expect(findResult.totalMatches).toBe(1)
    expect(findResult.results?.[0]?.toolName).toBe('youtube_get_video_info')
    expect(findResult.results?.[0]?.originalToolName).toBe('youtube.get_video_info')

    const useResult = await nativeToolService.nativeDynamicMcpUse({
      userId: 'josh',
      toolName: 'youtube.get_video_info',
      params: { id: 'abc123' }
    })
    expect(useResult.success).toBe(true)
    expect(useResult.toolName).toBe('youtube_get_video_info')
    expect(useResult.requestedToolName).toBe('youtube.get_video_info')
    expect(execute).toHaveBeenCalledWith({ id: 'abc123' })
  })

  it('native Dynamic MCP respects hidden MCP groups and tools from DCM display settings', async () => {
    const visibleExecute = vi.fn().mockResolvedValue({ ok: true })
    const hiddenExecute = vi.fn().mockResolvedValue({ ok: false })
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        visible_tool: {
          execute: visibleExecute,
          description: 'Visible tool'
        },
        hidden_tool: {
          execute: hiddenExecute,
          description: 'Hidden tool'
        },
        hidden_group_tool: {
          execute: hiddenExecute,
          description: 'Hidden group tool'
        }
      },
      metadata: new Map([
        [
          'visible_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'visible',
            originalToolName: 'visible_tool'
          }
        ],
        [
          'hidden_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'visible',
            originalToolName: 'hidden_tool'
          }
        ],
        [
          'hidden_group_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'hidden_group',
            originalToolName: 'hidden_group_tool'
          }
        ]
      ])
    } as any)

    const dcmDisplaySettings = {
      version: 1 as const,
      groups: {
        'gw_ctx::hidden_group': 'hidden'
      },
      tools: {
        'gw_ctx::hidden_tool': 'hidden'
      }
    }

    const findResult = await nativeToolService.nativeDynamicMcpFind({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      query: 'tool',
      dcmDisplaySettings
    })

    expect(findResult.results.map((entry: any) => entry.toolName)).toEqual(['visible_tool'])

    const hiddenUseResult = await nativeToolService.nativeDynamicMcpUse({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      toolName: 'hidden_tool',
      dcmDisplaySettings
    })
    expect(hiddenUseResult.success).toBe(false)
    expect(String(hiddenUseResult.error)).toMatch(/hidden_tool.*not found/i)
    expect(hiddenExecute).not.toHaveBeenCalled()
  })

  it('Mode 3 native Dynamic MCP uses resolved gateway scope (ignores per-call selectedGateways override)', async () => {
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          execute: vi.fn().mockResolvedValue({ ok: true }),
          description: 'Sample tool'
        }
      },
      metadata: new Map([
        [
          'sample_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'sample',
            originalToolName: 'sample_tool'
          }
        ]
      ])
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true
        }
      }
    } as any)

    const brokerFind = (tools as any).native_batshit_tool_search
    expect(brokerFind).toBeTruthy()

    await brokerFind.execute({
      query: 'sample',
      family: 'mcp',
      selectedGateways: []
    } as any)

    const selectedGatewayArg = vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mock.calls.at(-1)?.[1]
    expect(selectedGatewayArg).toEqual(['gw_ctx'])
  })

  it('Mode 3 Batshit tool search returns typed MCP refs with broker renderer metadata', async () => {
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          description: 'Search sample data',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            },
            required: ['query']
          },
          execute: vi.fn().mockResolvedValue({ ok: true })
        }
      },
      metadata: new Map([
        [
          'sample_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'sample',
            originalToolName: 'sample_tool'
          }
        ]
      ])
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerFind = (tools as any).native_batshit_tool_search
    expect(brokerFind).toBeTruthy()

    const result = await brokerFind.execute({
      query: 'sample',
      family: 'mcp',
      schemaMode: 'compact'
    } as any)

    expect(result.operationKind).toBe('tool_find')
    expect(result.rendererFamily).toBe('tool_find')
    expect(result.results[0]).toMatchObject({
      ref: 'mcp:sample_tool',
      family: 'mcp',
      title: 'sample_tool'
    })
    expect(result.results[0].hint).toContain('query')
  })

  it('Mode 3 memory scope: sys.memory.* refs appear only for memory-enabled primary contexts (SA-104 P3)', async () => {
    const baseContext = {
      userId: 'josh',
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: false,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: true,
          webSearchEnabled: false,
          bashEnabled: false,
          fetchZipEnabled: false
        }
      }
    }

    // Subagent-style caller (broad Fabric closed, memory off): no family is reachable,
    // so the broker pair is not even registered — memory tools are structurally inert.
    const subagentBuild = await nativeToolService.buildMode3NativeTools({
      ...baseContext,
      allowFabricControlTools: false,
      memoryControlsEnabled: false
    } as any)
    expect((subagentBuild.tools as any).native_batshit_tool_search).toBeFalsy()

    // Memory-enabled primary with the broad control plane still closed: the fabric family
    // opens with ONLY the memory scope.
    const { tools } = await nativeToolService.buildMode3NativeTools({
      ...baseContext,
      allowFabricControlTools: false,
      memoryControlsEnabled: true
    } as any)
    const brokerFind = (tools as any).native_batshit_tool_search
    expect(brokerFind).toBeTruthy()

    const result = await brokerFind.execute({ query: 'memory', family: 'fabric' } as any)
    const refs = (result.results ?? []).map((row: any) => row.ref)
    expect(refs).toContain('fabric:sys.memory.save')
    expect(refs).toContain('fabric:sys.memory.search')
    expect(refs.some((ref: string) => ref.startsWith('fabric:sys.artifact.'))).toBe(false)
  })

  it('Mode 3 Batshit tool use routes typed MCP refs through Dynamic MCP use metadata', async () => {
    const executeMock = vi.fn().mockResolvedValue({ ok: true })
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          execute: executeMock
        }
      },
      metadata: new Map()
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const result = await brokerUse.execute({
      ref: 'mcp:sample_tool',
      input: {
        query: 'hello'
      }
    } as any)

    expect(executeMock).toHaveBeenCalledWith({ query: 'hello' })
    expect(result).toMatchObject({
      success: true,
      ref: 'mcp:sample_tool',
      family: 'mcp',
      target: 'sample_tool',
      operationKind: 'dynamic_use',
      rendererFamily: 'generic_tool'
    })
  })

  it('Mode 3 broker reuses scoped MCP discovery across search and exact use', async () => {
    const executeMock = vi.fn().mockResolvedValue({ ok: true })
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          description: 'Search sample data',
          execute: executeMock
        }
      },
      metadata: new Map([
        [
          'sample_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'sample',
            originalToolName: 'sample_tool'
          }
        ]
      ])
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      agentId: 'agent_main',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerSearch = (tools as any).native_batshit_tool_search
    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerSearch).toBeTruthy()
    expect(brokerUse).toBeTruthy()

    const searchResult = await brokerSearch.execute({
      query: 'sample',
      family: 'mcp'
    } as any)
    expect(searchResult.results[0]?.ref).toBe('mcp:sample_tool')

    const useResult = await brokerUse.execute({
      ref: 'mcp:sample_tool',
      input: {
        query: 'hello'
      }
    } as any)

    expect(useResult.success).toBe(true)
    expect(executeMock).toHaveBeenCalledWith({ query: 'hello' })
    expect(mcpGatewayDiscovery.loadToolsForUser).toHaveBeenCalledTimes(1)
  })

  it('Mode 3 Batshit tool use rejects malformed refs with a clear error', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    await expect(brokerUse.execute({ ref: 'not-a-typed-ref' } as any)).rejects.toThrow(
      /Invalid Batshit tool ref/
    )
  })

  it('Mode 3 Batshit tool search reports unavailable families for unsupported actors', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_subagent_api_artifacts',
      agentId: 'agent_sub_api',
      providerSettings: {
        nativeTools: {
          artifactRuntimeEnabled: true,
          batshitToolsEnabled: true,
          dynamicMcpEnabled: false,
          cliToolsEnabled: false,
          fetchZipEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      allowArtifactRuntimeTools: true,
      allowFabricControlTools: false
    } as any)

    const brokerFind = (tools as any).native_batshit_tool_search
    expect(brokerFind).toBeTruthy()

    const result = await brokerFind.execute({
      family: 'fabric',
      query: 'artifact'
    } as any)

    expect(result.results).toEqual([])
    expect(result.families).toEqual([])
    expect(result.unavailableFamilies).toEqual([
      {
        family: 'fabric',
        reason: 'Fabric tools are not enabled for this actor/runtime.'
      }
    ])
  })

  it('Mode 3 Batshit tool search blocks Agent Browser family in unsupported API actor context', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          agentBrowserEnabled: true,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerFind = (tools as any).native_batshit_tool_search
    expect(brokerFind).toBeTruthy()

    const result = await brokerFind.execute({
      family: 'agent_browser',
      query: 'open'
    } as any)

    expect(result.results).toEqual([])
    expect(result.families).toEqual([])
    expect(result.unavailableFamilies).toEqual([
      {
        family: 'agent_browser',
        reason: 'Agent Browser tools are not enabled for this actor/runtime.'
      }
    ])
  })

  it('Mode 3 Batshit tool use cannot execute hidden MCP refs outside selected gateway scope', async () => {
    const visibleExecute = vi.fn().mockResolvedValue({ ok: true })
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        visible_tool: {
          execute: visibleExecute
        }
      },
      metadata: new Map([
        [
          'visible_tool',
          {
            gatewayId: 'gw_visible',
            gatewayName: 'Visible Gateway',
            gatewayType: 'custom',
            mcpServerName: 'visible',
            originalToolName: 'visible_tool'
          }
        ]
      ])
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_visible'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: true,
          cliToolsEnabled: false,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const result = await brokerUse.execute({
      ref: 'mcp:hidden_tool',
      input: {
        query: 'nope'
      }
    } as any)

    expect(result).toMatchObject({
      success: false,
      ref: 'mcp:hidden_tool',
      family: 'mcp',
      target: 'hidden_tool',
      operationKind: 'dynamic_use'
    })
    expect(String(result.error)).toMatch(/hidden_tool.*not found/i)
    expect(visibleExecute).not.toHaveBeenCalled()
  })

  it('Mode 3 Batshit tool use cannot execute hidden CLI refs outside selected tool scope', async () => {
    const now = '2026-06-02T00:00:00.000Z'
    const hiddenCliTool = {
      toolId: 'hidden_tool',
      title: 'Hidden Tool',
      description: 'Hidden CLI tool',
      tags: [],
      origin: 'manual',
      status: 'active',
      executable: 'node',
      argsTemplate: [{ kind: 'literal', value: '--version' }],
      inputSchema: {
        type: 'object',
        properties: {}
      },
      outputMode: 'text',
      parseMode: 'text',
      cwdPolicy: 'none',
      timeoutMs: 60_000,
      riskLevel: 'safe',
      allowNetwork: false,
      allowWrite: false,
      createdAt: now,
      updatedAt: now,
      lastValidationStatus: 'never'
    }
    vi.mocked((redis as any).execute).mockImplementation(async (callback: any) => {
      return await callback({
        json: {
          get: vi.fn().mockResolvedValue({
            version: 1,
            records: [hiddenCliTool]
          }),
          set: vi.fn().mockResolvedValue('OK')
        },
        expire: vi.fn().mockResolvedValue(1),
        lPush: vi.fn().mockResolvedValue(1),
        lTrim: vi.fn().mockResolvedValue('OK')
      })
    })

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedCliToolIds: ['visible_tool'],
      providerSettings: {
        nativeTools: {
          dynamicMcpEnabled: false,
          cliToolsEnabled: true,
          artifactRuntimeEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const result = await brokerUse.execute({
      ref: 'cli:hidden_tool',
      input: {}
    } as any)

    expect(result).toMatchObject({
      success: false,
      ref: 'cli:hidden_tool',
      family: 'cli',
      target: 'hidden_tool',
      operationKind: 'cli_tool',
      rendererFamily: 'cli_tool',
      code: 'OUT_OF_SCOPE'
    })
    expect(String(result.error)).toMatch(/outside the active agent tool scope/i)
  })

  it('Mode 3 native Fabric use preserves passthrough input fields while blocking reserved keys', async () => {
    const useControlSpy = vi.spyOn(fabricRegistry, 'useControl').mockResolvedValue({
      success: true,
      controlId: 'artifact.artifact_123.field.zone.set',
      result: { ok: true }
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const parsed = brokerUse.inputSchema.safeParse({
      ref: 'fabric:artifact.artifact_123.field.zone.set',
      selectedGateways: ['panel'],
      zone: 'panel',
      targetZone: 'header',
      prompt: 'run this artifact now',
      transport: 'mode3'
    })
    expect(parsed.success).toBe(true)
    if (!parsed.success) return
    expect((parsed.data as any).selectedGateways).toEqual(['panel'])
    expect((parsed.data as any).zone).toBe('panel')
    expect((parsed.data as any).targetZone).toBe('header')
    expect((parsed.data as any).prompt).toBe('run this artifact now')

    const output = await brokerUse.execute(parsed.data as any)
    expect(output).toMatchObject({
      success: true,
      ref: 'fabric:artifact.artifact_123.field.zone.set',
      family: 'fabric',
      operationKind: 'fabric_use'
    })
    const lastCall = useControlSpy.mock.calls.at(-1)?.[0] as any
    expect(lastCall.input).toMatchObject({
      zone: 'panel',
      targetZone: 'header',
      prompt: 'run this artifact now',
      transport: 'mode3'
    })
    expect(lastCall.input.selectedGateways).toBeUndefined()
    expect(lastCall.input.ref).toBeUndefined()

    expect(
      normalizeNativeControlUseInput({
        controlId: 'artifact.artifact_123.field.zone.set',
        input: { zone: 'header', prompt: 'prefer nested prompt' },
        zone: 'panel',
        targetZone: 'trigger',
        prompt: 'top-level prompt'
      })
    ).toMatchObject({
      zone: 'header',
      targetZone: 'trigger',
      prompt: 'prefer nested prompt'
    })

    const valid = brokerUse.inputSchema.safeParse({
      ref: 'fabric:artifact.artifact_123.field.zone.set',
      input: {
        zone: 'panel'
      },
      allowRisky: true
    })
    expect(valid.success).toBe(true)

    useControlSpy.mockRestore()
  })

  it('Mode 3 native artifact use forwards use.artifact.* allow-list to useControl', async () => {
    const useControlSpy = vi
      .spyOn(fabricRegistry, 'useControl')
      .mockResolvedValue({
        success: true,
        controlId: 'use.artifact.demo',
        output: { ok: true }
      } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const output = await brokerUse.execute({
      ref: 'artifact:use.artifact.demo',
      input: {
        prompt: 'smoke'
      }
    } as any)

    const lastCall = useControlSpy.mock.calls.at(-1)?.[0] as any
    expect(lastCall?.allowedControlIds).toEqual(expect.arrayContaining(['use.artifact.*']))
    expect(lastCall?.allowedControlIds).not.toEqual(expect.arrayContaining(['sys.artifact.*']))

    const modelOutput = await brokerUse.toModelOutput({ output })
    expect(String(modelOutput.value)).toContain('batshit_tool_use succeeded: artifact:use.artifact.demo')

    useControlSpy.mockRestore()
  })

  it('Mode 3 native Fabric use allows approved runtime add-on controls', async () => {
    const useControlSpy = vi.spyOn(fabricRegistry, 'useControl').mockResolvedValue({
      success: true,
      controlId: 'sys.runtime_addon.prepare',
      result: {
        addon: {
          id: 'fbx2vrma',
          canStartAutomatically: false,
          requiresOperator: true
        }
      }
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session-runtime-addon-prepare',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const output = await brokerUse.execute({
      ref: 'fabric:sys.runtime_addon.prepare',
      input: {
        addonId: 'fbx2vrma'
      }
    } as any)

    expect(output).toMatchObject({
      success: true,
      controlId: 'sys.runtime_addon.prepare',
      ref: 'fabric:sys.runtime_addon.prepare',
      family: 'fabric',
      operationKind: 'fabric_use'
    })
    const lastCall = useControlSpy.mock.calls.at(-1)?.[0] as any
    expect(lastCall).toMatchObject({
      userId: 'josh',
      sessionId: 'session-runtime-addon-prepare',
      controlId: 'sys.runtime_addon.prepare',
      input: {
        addonId: 'fbx2vrma'
      }
    })
    expect(lastCall?.allowedControlIds).toEqual(
      expect.arrayContaining(['sys.runtime_addon.*'])
    )
    expect(lastCall?.allowedControlIds).not.toEqual(expect.arrayContaining(['use.artifact.*']))

    useControlSpy.mockRestore()
  })

  it('Mode 3 native Fabric use allows model catalog search in normal tool context', async () => {
    const useControlSpy = vi.spyOn(fabricRegistry, 'useControl').mockResolvedValue({
      success: true,
      controlId: 'sys.model_catalog.search',
      result: {
        success: true,
        results: [
          {
            displayName: 'Gemini 3.1 Flash Image',
            modelIdForArtifact: 'gemini-3.1-flash-image'
          }
        ]
      }
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session-model-catalog-search',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const output = await brokerUse.execute({
      ref: 'fabric:sys.model_catalog.search',
      input: {
        query: 'Nano Banana 2',
        provider: 'google',
        purpose: 'visual'
      }
    } as any)

    expect(output).toMatchObject({
      success: true,
      controlId: 'sys.model_catalog.search',
      ref: 'fabric:sys.model_catalog.search',
      family: 'fabric',
      operationKind: 'fabric_use'
    })
    const lastCall = useControlSpy.mock.calls.at(-1)?.[0] as any
    expect(lastCall).toMatchObject({
      userId: 'josh',
      sessionId: 'session-model-catalog-search',
      controlId: 'sys.model_catalog.search',
      input: {
        query: 'Nano Banana 2',
        provider: 'google',
        purpose: 'visual'
      }
    })
    expect(lastCall?.allowedControlIds).toEqual(
      expect.arrayContaining(['sys.model_catalog.search'])
    )
    expect(lastCall?.allowedControlIds).not.toEqual(expect.arrayContaining(['use.artifact.*']))

    useControlSpy.mockRestore()
  })

  it.each([
    ['local', 'http://127.0.0.1:8000'],
    ['docker_sandbox', 'http://host.docker.internal:8000']
  ] as const)(
    'Mode 3 native helper parity keeps ComfyUI preflight contract on %s backend',
    async (executionBackend, expectedBaseUrl) => {
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } },
            CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ) as any
      )

      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId: 'josh',
        providerSettings: {
          nativeTools: {
            batshitToolsEnabled: true,
            executionBackend
          }
        }
      } as any)

      expect((tools as any).native_comfyui_object_info).toBeUndefined()

      const brokerSearch = (tools as any).native_batshit_tool_search
      const brokerUse = (tools as any).native_batshit_tool_use
      expect(brokerSearch).toBeTruthy()
      expect(brokerUse).toBeTruthy()

      const searchResult = await brokerSearch.execute({
        family: 'fabric',
        query: 'ComfyUI object info',
        schemaMode: 'compact'
      } as any)
      expect(searchResult.results.map((entry: any) => entry.ref)).toContain('fabric:sys.comfyui.object_info')

      const result = await brokerUse.execute({
        ref: 'fabric:sys.comfyui.object_info',
        input: {
          baseUrl: 'comfyui_api_desktop'
        }
      } as any)

      expect(result).toMatchObject({
        success: true,
        operationKind: 'fabric_use',
        rendererFamily: 'generic_tool',
        target: 'sys.comfyui.object_info',
        helper: 'native_comfyui_object_info',
        backend: executionBackend,
        baseUrl: expectedBaseUrl,
        objectInfoUrl: `${expectedBaseUrl}/object_info`
      })
      expect(result.error).toBeUndefined()
      expect(fetchSpy).toHaveBeenCalledWith(
        `${expectedBaseUrl}/object_info`,
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/json' })
        })
      )

      const modelOutput = await brokerUse.toModelOutput({ output: result })
      expect(String(modelOutput.value)).toContain('comfyui_object_info: success')

      fetchSpy.mockRestore()
    }
  )

  it.each(['local', 'docker_sandbox'] as const)(
    'direct ComfyUI host helper keeps preflight result contract on %s backend',
    async (executionBackend) => {
      const expectedBaseUrl =
        executionBackend === 'docker_sandbox'
          ? 'http://host.docker.internal:8000'
          : 'http://127.0.0.1:8000'
      const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
        new Response(
          JSON.stringify({
            KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } },
            CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } }
          }),
          { status: 200, headers: { 'Content-Type': 'application/json' } }
        ) as any
      )

      const result = await nativeToolService.nativeComfyUiObjectInfo({
        backend: executionBackend,
        baseUrl: 'comfyui_api_desktop'
      } as any)

      expect(result).toMatchObject({
        success: true,
        helper: 'native_comfyui_object_info',
        backend: executionBackend,
        baseUrl: expectedBaseUrl,
        objectInfoUrl: `${expectedBaseUrl}/object_info`
      })
      expect(result.error).toBeUndefined()
      expect(fetchSpy).toHaveBeenCalledWith(
        `${expectedBaseUrl}/object_info`,
        expect.objectContaining({
          headers: expect.objectContaining({ Accept: 'application/json' })
        })
      )

      fetchSpy.mockRestore()
    }
  )

  it.each(['local', 'docker_sandbox'] as const)(
    'Mode 3 native helper parity keeps artifact create/update/apply_patch/publish contract on %s backend',
    async (executionBackend) => {
      const useControlSpy = vi.spyOn(fabricRegistry, 'useControl').mockImplementation(async (options: any) => ({
        success: true,
        controlId: options.controlId,
        result: {
          artifactId: options.input?.artifactId ?? 'artifact_123',
          ok: true
        }
      }))

      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId: 'josh',
        sessionId: `session-parity-${executionBackend}`,
        selectedGateways: ['gw_ctx'],
        providerSettings: {
          nativeTools: {
            fabricEnabled: true,
            executionBackend
          }
        }
      } as any)

      const brokerUse = (tools as any).native_batshit_tool_use
      expect(brokerUse).toBeTruthy()

      const scenarios = [
        {
          controlId: 'sys.artifact.create',
          input: {
            name: 'Parity Artifact',
            content: '<div>v1</div>'
          }
        },
        {
          controlId: 'sys.artifact.update',
          input: {
            artifactId: 'artifact_123',
            content: '<div>v2</div>'
          }
        },
        {
          controlId: 'sys.artifact.apply_patch',
          input: {
            artifactId: 'artifact_123',
            patch: `*** Begin Patch
*** Update File: artifact.html
@@
-<div>v2</div>
+<div>v3</div>
*** End Patch`
          }
        },
        {
          controlId: 'sys.artifact.publish',
          input: {
            artifactId: 'artifact_123',
            publish: true
          }
        }
      ] as const

      const outputs: Array<Record<string, any>> = []
      for (const scenario of scenarios) {
        const output = await brokerUse.execute({
          ref: `fabric:${scenario.controlId}`,
          input: scenario.input
        } as any)
        outputs.push(output)
        expect(output).toMatchObject({
          success: true,
          controlId: scenario.controlId,
          ref: `fabric:${scenario.controlId}`,
          family: 'fabric',
          operationKind: 'fabric_use'
        })
      }

      expect(useControlSpy).toHaveBeenCalledTimes(scenarios.length)
      for (const [index, call] of useControlSpy.mock.calls.entries()) {
        const args = call[0] as any
        expect(args.runtimeMode).toBe('mode3')
        expect(args.allowedControlIds).toEqual(
          expect.arrayContaining([
            'sys.artifact.*',
            'sys.model_catalog.search',
            'sys.cli_tool.*',
            'sys.runtime_addon.*'
          ])
        )
        expect(args.allowedControlIds).not.toEqual(expect.arrayContaining(['use.artifact.*']))
        expect(args.controlId).toBe(scenarios[index].controlId)
        expect(args.input).toEqual(scenarios[index].input)
      }

      const finalModelOutput = await brokerUse.toModelOutput({
        output: outputs[outputs.length - 1]
      })
      expect(String(finalModelOutput.value)).toContain(
        'batshit_tool_use succeeded: fabric:sys.artifact.publish'
      )

      useControlSpy.mockRestore()
    }
  )

  it('Mode 3 native Fabric use caches risky payloads and reuses them on allowRisky retry', async () => {
    const useControlSpy = vi
      .spyOn(fabricRegistry, 'useControl')
      .mockResolvedValueOnce({
        success: false,
        controlId: 'sys.artifact.update',
        error: {
          code: 'CONTROL_RISK_REQUIRES_APPROVAL',
          message: 'Approval required.'
        }
      } as any)
      .mockResolvedValueOnce({
        success: true,
        controlId: 'sys.artifact.update',
        result: { ok: true }
      } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session-risk-retry',
      selectedGateways: ['gw_ctx'],
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const first = await brokerUse.execute({
      ref: 'fabric:sys.artifact.update',
      input: {
        artifactId: 'artifact_123',
        content: '<html><body>large payload</body></html>'
      }
    } as any)

    expect(first.success).toBe(false)
    expect(first.retryPayload?.cached).toBe(true)
    expect(first.retryPayload?.inputBytes).toBeGreaterThan(0)

    const second = await brokerUse.execute({
      ref: 'fabric:sys.artifact.update',
      allowRisky: true
    } as any)

    expect(second.success).toBe(true)
    expect(second.retryPayloadReused).toBe(true)

    const firstCall = useControlSpy.mock.calls[0]?.[0] as any
    const secondCall = useControlSpy.mock.calls[1]?.[0] as any
    expect(secondCall.allowRisky).toBe(true)
    expect(secondCall.input).toEqual(firstCall.input)

    const secondModelOutput = await brokerUse.toModelOutput({ output: second })
    expect(String(secondModelOutput.value)).toContain('reused cached payload')

    useControlSpy.mockRestore()
  })

  it('Mode 3 native Fabric use adds a helper-specific retry hint for local voice setup approval gates', async () => {
    const useControlSpy = vi
      .spyOn(fabricRegistry, 'useControl')
      .mockResolvedValueOnce({
        success: false,
        controlId: 'sys.voice.engine.complete_local_setup',
        error: {
          code: 'CONTROL_RISK_REQUIRES_APPROVAL',
          message: 'Approval required.'
        }
      } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session-voice-local-setup-risk-retry',
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const first = await brokerUse.execute({
      ref: 'fabric:sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'chatterbox-local',
        installRoot: '/Users/example/.batshit/installs/chatterbox-local'
      }
    } as any)

    expect(first.success).toBe(false)
    expect(first.retryPayload?.cached).toBe(true)

    const modelOutput = await brokerUse.toModelOutput({ output: first })
    expect(String(modelOutput.value)).toContain('allowRisky: true')
    expect(String(modelOutput.value)).toContain(
      'Do not switch to sys.voice.engine.register / update / health_check / enable or ad-hoc bash'
    )
    expect(String(modelOutput.value)).toContain(
      'Retry sys.voice.engine.complete_local_setup itself so the helper keeps ownership'
    )

    useControlSpy.mockRestore()
  })

  it('Mode 3 native Fabric use blocks allowRisky retry when payload bytes differ', async () => {
    const useControlSpy = vi
      .spyOn(fabricRegistry, 'useControl')
      .mockResolvedValueOnce({
        success: false,
        controlId: 'sys.artifact.update',
        error: {
          code: 'CONTROL_RISK_REQUIRES_APPROVAL',
          message: 'Approval required.'
        }
      } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session-risk-retry-mismatch',
      providerSettings: {
        nativeTools: {
          fabricEnabled: true
        }
      }
    } as any)

    const brokerUse = (tools as any).native_batshit_tool_use
    expect(brokerUse).toBeTruthy()

    const first = await brokerUse.execute({
      ref: 'fabric:sys.artifact.update',
      input: {
        artifactId: 'artifact_123',
        content: '<html><body>payload-v1</body></html>'
      }
    } as any)

    expect(first.success).toBe(false)
    expect(first.retryPayload?.cached).toBe(true)

    const mismatch = await brokerUse.execute({
      ref: 'fabric:sys.artifact.update',
      allowRisky: true,
      input: {
        artifactId: 'artifact_123',
        content: '<html><body>payload-v2</body></html>'
      }
    } as any)

    expect(mismatch.success).toBe(false)
    expect(mismatch.error?.code).toBe('INVALID_INPUT')
    expect(String(mismatch.error?.message || '')).toMatch(/payload mismatch/i)
    expect(useControlSpy).toHaveBeenCalledTimes(1)

    useControlSpy.mockRestore()
  })

  it('native_comfyui_object_info resolves backend-aware alias targets in docker_sandbox', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } },
          CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    )

    const result = await nativeToolService.nativeComfyUiObjectInfo({
      backend: 'docker_sandbox',
      baseUrl: 'comfyui_api_desktop'
    } as any)

    expect(result.success).toBe(true)
    expect(result.baseUrl).toBe('http://host.docker.internal:8000')
    expect(result.objectInfoUrl).toBe('http://host.docker.internal:8000/object_info')
    expect(result.nodeCount).toBe(2)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://host.docker.internal:8000/object_info',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' })
      })
    )

    fetchSpy.mockRestore()
  })

  it('native_comfyui_object_info falls back to loopback host when docker alias is unreachable', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const asString = String(url)
      if (asString.includes('host.docker.internal')) {
        throw new TypeError('fetch failed')
      }
      return new Response(
        JSON.stringify({
          KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    })

    const result = await nativeToolService.nativeComfyUiObjectInfo({
      backend: 'docker_sandbox',
      baseUrl: 'comfyui_api_desktop'
    } as any)

    expect(result.success).toBe(true)
    expect(result.baseUrl).toBe('http://127.0.0.1:8000')
    expect(result.objectInfoUrl).toBe('http://127.0.0.1:8000/object_info')
    expect(Array.isArray(result.attempts)).toBe(true)
    expect(result.attempts.length).toBeGreaterThanOrEqual(2)
    expect(result.attempts[0].objectInfoUrl).toBe('http://host.docker.internal:8000/object_info')
    expect(result.attempts[0].success).toBe(false)
    expect(String(result.attempts[0].error || '')).toMatch(/request failed/i)
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://host.docker.internal:8000/object_info',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' })
      })
    )
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/object_info',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' })
      })
    )

    fetchSpy.mockRestore()
  })

  it('native_comfyui_object_info returns filtered schema and missing class types', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } },
          CLIPTextEncode: { input: { required: { text: ['STRING', {}] } } }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    )

    const result = await nativeToolService.nativeComfyUiObjectInfo({
      backend: 'local',
      baseUrl: 'comfyui_api_desktop',
      includeSchema: true,
      classTypes: ['KSampler', 'MissingNode']
    } as any)

    expect(result.success).toBe(true)
    expect(result.schema).toHaveProperty('KSampler')
    expect(result.schema).not.toHaveProperty('CLIPTextEncode')
    expect(result.missingClassTypes).toEqual(['MissingNode'])

    fetchSpy.mockRestore()
  })

  it('native_comfyui_object_info falls back from desktop alias to standalone alias', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const asString = String(url)
      if (asString.includes(':8000/object_info')) {
        return new Response('not found', { status: 404 }) as any
      }
      return new Response(
        JSON.stringify({
          KSampler: { input: { required: { steps: ['INT', { default: 20 }] } } }
        }),
        { status: 200, headers: { 'Content-Type': 'application/json' } }
      ) as any
    })

    const result = await nativeToolService.nativeComfyUiObjectInfo({
      backend: 'docker_sandbox'
    } as any)

    expect(result.success).toBe(true)
    expect(result.baseUrl).toBe('http://host.docker.internal:8188')
    expect(Array.isArray(result.attempts)).toBe(true)
    expect(result.attempts.length).toBeGreaterThanOrEqual(4)
    expect(result.attempts[0].status).toBe(404)
    expect(result.attempts.some((attempt: any) => attempt.objectInfoUrl === 'http://127.0.0.1:8000/object_info')).toBe(true)
    expect(result.attempts.some((attempt: any) => attempt.objectInfoUrl === 'http://localhost:8000/object_info')).toBe(true)
    expect(result.attempts.some((attempt: any) => attempt.objectInfoUrl === 'http://host.docker.internal:8188/object_info' && attempt.success === true)).toBe(true)

    fetchSpy.mockRestore()
  })

  it('native_comfyui_object_info rejects invalid base URL input with deterministic error', async () => {
    const result = await nativeToolService.nativeComfyUiObjectInfo({
      backend: 'local',
      baseUrl: 'totally-not-a-url'
    } as any)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_INPUT')
  })

  it('native_comfyui_workflows lists saved workflows via userdata endpoint', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(JSON.stringify(['z-image.json', 'image_qwen_Image_2512.json']), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      }) as any
    )

    const result = await nativeToolService.nativeComfyUiWorkflows({
      backend: 'local',
      action: 'list',
      baseUrl: 'comfyui_api_desktop'
    } as any)

    expect(result.success).toBe(true)
    expect(result.action).toBe('list')
    expect(result.baseUrl).toBe('http://127.0.0.1:8000')
    expect(result.workflows).toEqual(['image_qwen_Image_2512.json', 'z-image.json'])
    expect(fetchSpy).toHaveBeenCalledWith(
      'http://127.0.0.1:8000/userdata?dir=workflows',
      expect.objectContaining({
        headers: expect.objectContaining({ Accept: 'application/json' })
      })
    )

    fetchSpy.mockRestore()
  })

  it('native_comfyui_workflows fetches workflow JSON with userdata fallback variants', async () => {
    const workflowPayload = {
      id: 'wf_1',
      nodes: [
        { id: 11, type: 'KSampler' },
        { id: 12, type: 'LoraLoader' }
      ]
    }

    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url: any) => {
      const asString = String(url)
      if (asString === 'http://127.0.0.1:8000/userdata/workflows%2Fz-image.json') {
        return new Response('not found', { status: 404 }) as any
      }
      if (asString === 'http://127.0.0.1:8000/api/userdata/workflows%2Fz-image.json') {
        return new Response(JSON.stringify(workflowPayload), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        }) as any
      }
      return new Response('not found', { status: 404 }) as any
    })

    const result = await nativeToolService.nativeComfyUiWorkflows({
      backend: 'local',
      action: 'get',
      baseUrl: 'comfyui_api_desktop',
      workflowName: 'z-image.json',
      includeWorkflow: true
    } as any)

    expect(result.success).toBe(true)
    expect(result.action).toBe('get')
    expect(result.workflowName).toBe('z-image.json')
    expect(result.workflowFormat).toBe('ui')
    expect(result.workflowNodeCount).toBe(2)
    expect(result.workflow).toEqual(workflowPayload)
    expect(Array.isArray(result.attempts)).toBe(true)
    expect(result.attempts[0].requestUrl).toBe('http://127.0.0.1:8000/userdata/workflows%2Fz-image.json')
    expect(result.attempts[0].status).toBe(404)
    expect(result.attempts[1].requestUrl).toBe('http://127.0.0.1:8000/api/userdata/workflows%2Fz-image.json')
    expect(result.attempts[1].success).toBe(true)

    fetchSpy.mockRestore()
  })

  it('native_comfyui_workflows requires workflowName when action=get', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response('[]', { status: 200, headers: { 'Content-Type': 'application/json' } }) as any
    )

    const result = await nativeToolService.nativeComfyUiWorkflows({
      backend: 'local',
      action: 'get',
      baseUrl: 'comfyui_api_desktop'
    } as any)

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_INPUT')
    expect(fetchSpy).not.toHaveBeenCalled()

    fetchSpy.mockRestore()
  })

  it('native Agent Browser find returns native command catalog with runtime probe', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: '',
        stderr: 'unexpected',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserFind({
      userId: 'josh',
      query: 'open',
      limit: 3
    })

    expect(result.available).toBe(true)
    expect(result.supportLevel).toBe('native-cli')
    expect(result.runtime?.version).toContain('0.3.0')
    expect(result.totalMatches).toBeGreaterThan(0)
    expect(Array.isArray(result.results)).toBe(true)
    expect(result.results[0]?.toolName).toBe('open')
    expect(runner).toHaveBeenCalled()
  })

  it('reports the pinned Agent Browser runtime metadata in admin status', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.9.2',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: '',
        stderr: 'unexpected',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const status = await nativeToolService.getAgentBrowserRuntimeStatus()

    expect(status.installed).toBe(true)
    expect(status.version).toBe('0.9.2')
    expect(status.testedVersion).toBe('0.24.1')
    expect(status.packageSpec).toBe('agent-browser@0.24.1')
    expect(status.packageTarballUrl).toContain('agent-browser-0.24.1.tgz')
    expect(status.packageIntegrity).toMatch(/^sha512-/)
    expect(status.runtimeMatchesTestedVersion).toBe(false)
    expect(String(status.reason || '')).toMatch(/tested runtime 0.24.1/i)
  })

  it('reports Agent Browser as a Docker sidecar when sidecar health is reachable', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    const runner = vi.fn()
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: RequestInfo | URL) => {
        expect(String(input)).toBe('http://agent-browser.test/health')
        return Response.json({
          ok: true,
          service: 'batshit-agent-browser-sidecar',
          mode: 'docker-sidecar',
          version: 'agent-browser 0.24.1'
        })
      })
    )

    const status = await nativeToolService.getAgentBrowserRuntimeStatus()

    expect(status.installed).toBe(true)
    expect(status.supported).toBe(true)
    expect(status.dockerUnsupported).toBe(false)
    expect(status.supportLevel).toBe('docker-sidecar')
    expect(status.installScope).toBe('docker-sidecar')
    expect(status.command).toBe('agent-browser')
    expect(status.version).toBe('0.24.1')
    expect(status.runtimeMatchesTestedVersion).toBe(true)
    expect(runner).not.toHaveBeenCalled()
  })

  it('blocks Agent Browser install and uninstall in Docker', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    vi.stubGlobal(
      'fetch',
      vi.fn(async () =>
        Response.json({
          ok: true,
          service: 'batshit-agent-browser-sidecar',
          mode: 'docker-sidecar',
          version: 'agent-browser 0.24.1'
        })
      )
    )

    const install = await nativeToolService.installAgentBrowserRuntime()
    const uninstall = await nativeToolService.uninstallAgentBrowserRuntime()

    expect(install).toMatchObject({
      installed: true,
      supported: true,
      dockerUnsupported: true,
      run: null
    })
    expect(uninstall).toMatchObject({
      uninstalled: false,
      installed: true,
      supported: true,
      dockerUnsupported: true,
      run: null
    })
  })

  it('returns a Docker Agent Browser catalog when the sidecar is stopped', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    const runner = vi.fn()
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('sidecar offline')
      })
    )

    const result = await nativeToolService.nativeAgentBrowserFind({
      userId: 'josh',
      query: 'open',
      limit: 3
    })

    expect(result.available).toBe(false)
    expect(result.supported).toBe(true)
    expect(result.dockerUnsupported).toBe(false)
    expect(result.supportLevel).toBe('docker-sidecar')
    expect(result.reason).toMatch(/sidecar is not reachable/i)
    expect(result.results.map((entry: any) => entry.toolName)).toContain('open')
    expect(runner).not.toHaveBeenCalled()
  })

  it('routes Agent Browser use through the Docker sidecar', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    nativeToolEnv.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN = 'sidecar-token'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_TOKEN = 'sidecar-token'
    const runner = vi.fn()
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://agent-browser.test/health') {
        return Response.json({
          ok: true,
          service: 'batshit-agent-browser-sidecar',
          mode: 'docker-sidecar',
          version: 'agent-browser 0.24.1'
        })
      }
      if (url === 'http://agent-browser.test/v1/run') {
        expect((init?.headers as Record<string, string>)?.authorization).toBe('Bearer sidecar-token')
        const body = JSON.parse(String(init?.body || '{}'))
        expect(body.args).toEqual(['--json', 'open', 'http://host.docker.internal:5620/'])
        return Response.json({
          ok: true,
          run: {
            command: 'agent-browser',
            args: body.args,
            stdout: JSON.stringify({ success: true, data: { url: 'http://host.docker.internal:5620/' } }),
            stderr: '',
            exitCode: 0,
            signal: null,
            timedOut: false,
            durationMs: 25,
            truncated: false
          }
        })
      }
      throw new Error(`Unexpected fetch ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: { url: 'http://localhost:5620', headed: true },
      settings: {
        liveViewEnabled: true,
        runtimeMode: 'chrome-cdp',
        cdpPort: 9222,
        provider: 'local',
        executablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
        extraFlags: [],
        timeoutMs: 45_000
      }
    })

    expect(result.success).toBe(true)
    expect(result.supportLevel).toBe('docker-sidecar')
    expect(result.runtime?.dockerSidecar).toMatchObject({
      headedDisabled: true,
      executablePathIgnored: true,
      urlRewrite: {
        originalUrl: 'http://localhost:5620',
        sidecarUrl: 'http://host.docker.internal:5620/'
      }
    })
    expect(runner).not.toHaveBeenCalled()
  })

  it('blocks Agent Browser bash commands in Docker with Agent Browser wording', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CONTAINERIZED = '1'

    const result = await nativeToolService.nativeBashExecute({
      command: 'agent-browser open https://example.com',
      accessMode: 'dangerous',
      backend: 'docker_sandbox',
      agentBrowserSettings: {
        enabled: true
      }
    })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BACKEND_UNAVAILABLE')
    expect(result.agentBrowser).toMatchObject({
      dockerUnsupported: false,
      supported: true,
      supportLevel: 'docker-sidecar',
      rawBashUnsupported: true
    })
    expect(result.reason).toMatch(/Agent Browser tools/i)
  })

  it('native Agent Browser find supports natural-language query tokens', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: '',
        stderr: 'unexpected',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserFind({
      userId: 'josh',
      query: 'screenshot command',
      limit: 5
    })

    expect(result.available).toBe(true)
    expect(result.totalMatches).toBeGreaterThan(0)
    expect(Array.isArray(result.results)).toBe(true)
    expect(result.results.map((entry: any) => entry.toolName)).toContain('screenshot')
  })

  it('native Agent Browser use executes CLI command with normalized params', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: JSON.stringify({
          success: true,
          data: {
            ok: true
          }
        }),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'get title',
      params: {}
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('get_title')
    expect(result.result?.ok).toBe(true)

    const executeCall = runner.mock.calls[1]?.[0]
    expect(executeCall.command).toBe('agent-browser')
    expect(executeCall.args).toEqual(['--headed', '--json', 'get', 'title'])
  })

  it('native Agent Browser open prepares live preview by closing stale default session first', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.9.2',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'close') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({ success: true, data: { closed: true }, error: null }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'open') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: { title: 'Example Domain', url: 'https://example.com/' },
            error: null
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error(`unexpected args: ${JSON.stringify(args)}`)
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: { url: 'https://example.com', liveView: true }
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('open')
    expect(result.bootstrap?.attempted).toBe(false)
    expect(result.livePreviewPreparation?.attempted).toBe(true)
    expect(result.livePreviewPreparation?.succeeded).toBe(true)

    const argCalls = runner.mock.calls.map((call) => call[0]?.args)
    expect(argCalls).toContainEqual(['--headed', '--json', 'close'])
    expect(argCalls).toContainEqual(['--headed', '--json', 'open', 'https://example.com'])
  })

  it('native Agent Browser use auto-bootstraps with close + tab new when browser is not launched', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.9.2',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'close') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({ success: true, data: { closed: true }, error: null }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'tab' && args[3] === 'new') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({ success: true, data: { index: 0, total: 1 }, error: null }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'open') {
        const openCallCount =
          runner.mock.calls.filter((call) => Array.isArray(call[0]?.args) && call[0].args[2] === 'open').length

        if (openCallCount <= 2) {
          return {
            command: 'agent-browser',
            args,
            stdout: JSON.stringify({
              success: false,
              data: null,
              error: 'Browser not launched. Call launch first.'
            }),
            stderr: '',
            exitCode: 1,
            signal: null,
            timedOut: false,
            durationMs: 5,
            truncated: false
          }
        }

        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: { title: 'Example Domain', url: 'https://example.com/' },
            error: null
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error(`unexpected args: ${JSON.stringify(args)}`)
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: { url: 'https://example.com' }
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('open')
    expect(result.bootstrap?.attempted).toBe(true)
    expect(result.bootstrap?.succeeded).toBe(true)

    const argCalls = runner.mock.calls.map((call) => call[0]?.args)
    expect(argCalls).toContainEqual(['--headed', '--json', 'close'])
    expect(argCalls).toContainEqual(['--headed', '--json', 'tab', 'new'])
    expect(
      argCalls.filter((args) => Array.isArray(args) && args[2] === 'open' && args[3] === 'https://example.com').length
    ).toBe(3)
  })

  it('native Agent Browser use auto-recovers from closed browser context errors', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.9.2',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'close') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({ success: true, data: { closed: true }, error: null }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'open') {
        const isRetry =
          runner.mock.calls.filter((call) => Array.isArray(call[0]?.args) && call[0].args[2] === 'open').length >
          1
        if (!isRetry) {
          return {
            command: 'agent-browser',
            args,
            stdout: JSON.stringify({
              success: false,
              data: null,
              error: 'browserContext.newPage: Target page, context or browser has been closed'
            }),
            stderr: '',
            exitCode: 1,
            signal: null,
            timedOut: false,
            durationMs: 5,
            truncated: false
          }
        }

        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: { title: 'Example Domain', url: 'https://example.com/' },
            error: null
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error(`unexpected args: ${JSON.stringify(args)}`)
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: { url: 'https://example.com' }
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('open')
    expect(result.bootstrap?.attempted).toBe(true)
    expect(result.bootstrap?.succeeded).toBe(true)

    const argCalls = runner.mock.calls.map((call) => call[0]?.args)
    expect(argCalls).toContainEqual(['--headed', '--json', 'close'])
    expect(argCalls).toContainEqual(['--headed', '--json', 'open', 'https://example.com'])
  })

  it('native Agent Browser tab_new auto-bootstraps by closing stale session when needed', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.9.2',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'tab' && args[3] === 'new') {
        const isRetry =
          runner.mock.calls.filter((call) => Array.isArray(call[0]?.args) && call[0].args[2] === 'tab' && call[0].args[3] === 'new').length >
          1
        if (!isRetry) {
          return {
            command: 'agent-browser',
            args,
            stdout: JSON.stringify({
              success: false,
              data: null,
              error: 'browserContext.newPage: Target page, context or browser has been closed'
            }),
            stderr: '',
            exitCode: 1,
            signal: null,
            timedOut: false,
            durationMs: 5,
            truncated: false
          }
        }

        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: { index: 0, total: 1 },
            error: null
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'close') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({ success: true, data: { closed: true }, error: null }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error(`unexpected args: ${JSON.stringify(args)}`)
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'tab_new',
      params: {}
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('tab_new')
    expect(result.bootstrap?.attempted).toBe(true)
    expect(result.bootstrap?.succeeded).toBe(true)

    const argCalls = runner.mock.calls.map((call) => call[0]?.args)
    expect(argCalls).toContainEqual(['--headed', '--json', 'close'])
    expect(
      argCalls.filter((args) => Array.isArray(args) && args[2] === 'tab' && args[3] === 'new').length
    ).toBe(2)
  })

  it('native Agent Browser launch alias maps to tab_new for CLI compatibility', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.9.2',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'tab' && args[3] === 'new') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: { index: 0, total: 1 },
            error: null
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error(`unexpected args: ${JSON.stringify(args)}`)
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'launch',
      params: {}
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('tab_new')

    const argCalls = runner.mock.calls.map((call) => call[0]?.args)
    expect(argCalls).toContainEqual(['--headed', '--json', 'tab', 'new'])
  })

  it('native Agent Browser screenshot generates a default output path when none is provided', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'wait') {
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: {
              waitedMs: Number(args[3] ?? 0)
            }
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: JSON.stringify({
          success: true,
          data: {
            path: '/tmp/screenshot.png'
          }
        }),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'screenshot',
      params: {}
    })

    expect(result.success).toBe(true)
    expect(result.toolName).toBe('screenshot')
    expect(result.preScreenshotWait?.attempted).toBe(true)
    expect(result.preScreenshotWait?.success).toBe(true)
    expect(result.preScreenshotWait?.waitMs).toBe(1500)

    const waitCall = runner.mock.calls
      .map((call) => call[0])
      .find((call) => Array.isArray(call.args) && call.args[2] === 'wait')
    expect(waitCall?.args).toEqual(['--headed', '--json', 'wait', '1500'])

    const executeCall = runner.mock.calls
      .map((call) => call[0])
      .find((call) => Array.isArray(call.args) && call.args[2] === 'screenshot')
    expect(executeCall?.command).toBe('agent-browser')
    expect(executeCall?.args[0]).toBe('--headed')
    expect(executeCall?.args[1]).toBe('--json')
    expect(executeCall?.args[2]).toBe('screenshot')
    expect(typeof executeCall?.args[3]).toBe('string')
    expect(executeCall?.args[3]).toMatch(/batshit-agent-browser-.*\.png$/)
  })

  it('native Agent Browser screenshot can disable the default pre-capture wait', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: JSON.stringify({
          success: true,
          data: {
            path: '/tmp/screenshot.png'
          }
        }),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'screenshot',
      params: {
        autoWaitBeforeScreenshot: false
      }
    })

    expect(result.success).toBe(true)
    expect(result.preScreenshotWait).toBeUndefined()

    const waitCall = runner.mock.calls
      .map((call) => call[0])
      .find((call) => Array.isArray(call.args) && call.args[2] === 'wait')
    expect(waitCall).toBeUndefined()
  })

  it('native Agent Browser screenshot uploads to a tunnel URL for model visibility when tunnel access is configured', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      if (Array.isArray(args) && args[2] === 'screenshot') {
        const screenshotPath = String(args[3] || '')
        if (screenshotPath) {
          await writeFile(
            screenshotPath,
            Buffer.from('iVBORw0KGgo=', 'base64')
          )
        }
        return {
          command: 'agent-browser',
          args,
          stdout: JSON.stringify({
            success: true,
            data: {
              path: screenshotPath
            }
          }),
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error(`unexpected args: ${JSON.stringify(args)}`)
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    vi.mocked(redis.getUserSettings).mockResolvedValue({
      ui_settings: {
        upload_settings: {
          strategy: 'local',
          storage_mode: 'local',
          tunnel_url: 'https://tunnel.example',
          use_https: true,
          tunnel_provider: 'manual'
        }
      }
    } as any)

    // batshit-server uploads are service-token-gated; the upload helper throws without it.
    vi.stubEnv('BATSHIT_TOKEN', 'native-tools-test-token')

    const originalFetch = global.fetch
    const fetchMock = vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({
        file: {
          storageMode: 'local',
          tunnelPath: '/uploads/agent-browser-shot.png',
          localUrl: 'http://localhost:5600/uploads/agent-browser-shot.png',
          uploadStrategy: 'local'
        }
      })
    })) as any
    ;(global as any).fetch = fetchMock

    try {
      const result = await nativeToolService.nativeAgentBrowserUse({
        userId: 'josh',
        sessionId: 'session-123',
        toolName: 'screenshot',
        params: {
          autoWaitBeforeScreenshot: false
        }
      })

      expect(result.success).toBe(true)
      expect(result.toolName).toBe('screenshot')
      expect(result.modelImageUrl).toBe('https://tunnel.example/uploads/agent-browser-shot.png')
      expect((result.result as any)?.url).toBe('https://tunnel.example/uploads/agent-browser-shot.png')
      expect(fetchMock).toHaveBeenCalled()
      const uploadCall = fetchMock.mock.calls.find(
        (call) => call[0] === 'http://localhost:5600/api/upload/single'
      )
      expect(uploadCall).toBeTruthy()
    } finally {
      ;(global as any).fetch = originalFetch
    }
  })

  it('native Agent Browser use returns install help when runtime is unavailable', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: '',
          stderr: 'not installed',
          exitCode: 127,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error('should not execute command when unavailable')
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: {
        url: 'https://example.com'
      }
    })

    expect(result.success).toBe(false)
    expect(String(result.error || '')).toMatch(/install with/i)
  })

  it('native Agent Browser use blocks cloud provider execution when provider key is missing', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }
      throw new Error('should not execute without provider credentials')
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.mocked(apiKeyService.retrieve).mockResolvedValue(null)

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: {
        url: 'https://example.com',
        provider: 'browserbase'
      }
    })

    expect(result.success).toBe(false)
    expect(String(result.error || '')).toMatch(/settings -> api keys -> agent browser cloud providers/i)
  })

  it('native Agent Browser use blocks Browserbase execution when project ID is missing', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }
      throw new Error('should not execute without Browserbase project id')
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (service === 'browserbase' && userId === 'josh') return 'browserbase-test-key'
      return null
    })

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'open',
      params: {
        url: 'https://example.com',
        provider: 'browserbase'
      }
    })

    expect(result.success).toBe(false)
    expect(String(result.error || '')).toMatch(/project id is missing/i)
  })

  it('native Agent Browser settings shape CLI runtime args (cdp/provider/live view)', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }
      return {
        command: 'agent-browser',
        args,
        stdout: JSON.stringify({ success: true, data: { ok: true } }),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (service === 'browserbase' && userId === 'josh') return 'browserbase-test-key'
      if (service === 'browserbase_project_id' && userId === 'josh') return 'bb-project-123'
      if (service === 'browserbase_api_url' && userId === 'josh') return 'https://api.browserbase.local'
      return null
    })

    const result = await nativeToolService.nativeAgentBrowserUse({
      userId: 'josh',
      toolName: 'get_url',
      params: {},
      settings: {
        runtimeMode: 'chrome-cdp',
        cdpPort: 9333,
        provider: 'browserbase',
        liveViewEnabled: false,
        extraFlags: ['--trace'],
        timeoutMs: 45_000
      }
    })

    expect(result.success).toBe(true)

    const executeCall = runner.mock.calls
      .map((call) => call[0])
      .find(
        (call) =>
          Array.isArray(call.args) &&
          call.args.includes('get') &&
          call.args.includes('url') &&
          call.args.includes('--cdp')
      )
    expect(executeCall?.args).toEqual([
      '--cdp',
      'http://127.0.0.1:9333',
      '-p',
      'browserbase',
      '--trace',
      '--json',
      'get',
      'url'
    ])
    expect(executeCall?.env?.BROWSERBASE_API_KEY).toBe('browserbase-test-key')
    expect(executeCall?.env?.BROWSERBASE_PROJECT_ID).toBe('bb-project-123')
    expect(executeCall?.env?.BROWSERBASE_API_URL).toBe('https://api.browserbase.local')
    expect(executeCall?.env?.BROWSERBASE_URL).toBe('https://api.browserbase.local')
  })

  it('keeps bash tool enabled and does not expose Agent Browser wrapper tools by default', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: null
    })

    expect(tools.native_bash_execute).toBeDefined()
    expect(tools.native_agent_browser_find).toBeUndefined()
    expect(tools.native_agent_browser_use).toBeUndefined()
  })

  it('auto-allowlists agent-browser commands in Agent mode when Agent Browser is enabled', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true,
          executionBackend: 'local'
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()

    const result = await bashTool.execute({
      command: 'agent-browser --help'
    })

    expect(result.blocked).not.toBe(true)
    expect(String(result.reason || '')).not.toMatch(/blocked by agent mode policy/i)
  })

  it('blocks agent-browser commands in Agent mode when Agent Browser is disabled', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: false,
          executionBackend: 'local'
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()

    const result = await bashTool.execute({
      command: 'agent-browser --help'
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(String(result.reason || '')).toMatch(/blocked by agent mode policy/i)
  })

  it('allows explicit regex patterns for npx agent-browser commands when Agent Browser is enabled', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true,
          // Pin the backend: under the docker_sandbox default (Linux hosts), Agent
          // Browser commands reroute to the managed local runtime BEFORE the cwd
          // boundary check, so the forced out-of-root block below would never fire.
          executionBackend: 'apple_container'
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()

    const result = await bashTool.execute({
      command: 'npx -y agent-browser --help',
      // Force a deterministic pre-execution block so we only validate policy matching here.
      cwd: '/tmp'
    })

    expect(result.blocked).toBe(true)
    expect(String(result.reason || '')).toMatch(/outside allowed workspace root/i)
    expect(String(result.reason || '')).not.toMatch(/blocked by agent mode policy/i)
  })

  it('applies Agent Browser runtime defaults to native_bash_execute commands', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          executionBackend: 'local',
          agentBrowserEnabled: true,
          agentBrowserRuntimeMode: 'chrome-cdp',
          agentBrowserCdpPort: 9333,
          agentBrowserLiveViewEnabled: true,
          agentBrowserProvider: 'local',
          agentBrowserSession: 'qa-agent',
          agentBrowserProfilePath: '~/.batshit/ab-profile',
          agentBrowserExecutablePath: '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
          agentBrowserExtraFlags: ['--debug', '--slow-mo 150'],
          agentBrowserTimeoutMs: 45_000
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()

    const result = await bashTool.execute({
      command: 'agent-browser snapshot -i || true'
    })

    expect(result.blocked).not.toBe(true)
    expect(result.command).toContain('agent-browser')
    expect(result.command).toContain('--cdp http://127.0.0.1:9333')
    expect(result.command).toContain('--headed')
    expect(result.command).toContain('--session qa-agent')
    expect(result.command).toContain("--profile '~/.batshit/ab-profile'")
    expect(result.command).toContain('--executable-path')
    expect(result.command).toContain('--debug')
    expect(result.command).toContain('--slow-mo 150')
    expect(result.requestedCommand).toBe('agent-browser snapshot -i || true')
    expect(result.agentBrowser?.appliedDefaults).toEqual(
      expect.arrayContaining(['runtime', 'liveView', 'session', 'profile', 'executablePath', 'extraFlags'])
    )
    expect(result.agentBrowser?.timeoutMsApplied).toBe(45_000)
  })

  it('routes agent-browser bash commands to managed local runtime when backend is docker_sandbox', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-managed-'))
    const fakeAgentBrowserPath = path.join(tempWorkspace, 'agent-browser')
    const previousManagedPath = process.env.BATSHIT_AGENT_BROWSER_BIN

    try {
      await writeFile(
        fakeAgentBrowserPath,
        `#!/bin/zsh
set -euo pipefail
if [[ "\${1:-}" == "--version" ]]; then
  echo "agent-browser 0.9.2"
  exit 0
fi
echo "managed-agent-browser-ok"
`,
        { encoding: 'utf8' }
      )
      await chmod(fakeAgentBrowserPath, 0o755)
      process.env.BATSHIT_AGENT_BROWSER_BIN = fakeAgentBrowserPath

      const result = await nativeToolService.nativeBashExecute({
        command: 'npx agent-browser --help',
        accessMode: 'dangerous',
        requireApproval: false,
        backend: 'docker_sandbox',
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        agentBrowserSettings: {
          enabled: true,
          runtimeMode: 'chrome-cdp',
          cdpPort: 9222,
          liveViewEnabled: true,
          provider: 'local'
        }
      })

      expect(result.success).toBe(true)
      expect(result.backend).toBe('local')
      expect(result.backendLabel).toBe('Local shell')
      expect(result.requestedCommand).toBe('npx agent-browser --help')
      expect(result.agentBrowser?.backendOverride).toBe('local')
      expect(result.agentBrowser?.managedRuntimeCommand).toBe(fakeAgentBrowserPath)
      expect(String(result.stdout || '')).toContain('managed-agent-browser-ok')
      expect(result.sandboxName).toBeUndefined()
    } finally {
      if (typeof previousManagedPath === 'string' && previousManagedPath.length > 0) {
        process.env.BATSHIT_AGENT_BROWSER_BIN = previousManagedPath
      } else {
        delete process.env.BATSHIT_AGENT_BROWSER_BIN
      }
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks agent-browser bash commands in docker_sandbox when managed runtime is unavailable', async () => {
    const runner = vi.fn(async ({ command, args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: String(command ?? 'agent-browser'),
          args,
          stdout: '',
          stderr: 'not installed',
          exitCode: 127,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      throw new Error('runtime command should not execute when managed runtime is unavailable')
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)

    const result = await nativeToolService.nativeBashExecute({
      command: 'npx agent-browser --help',
      accessMode: 'dangerous',
      requireApproval: false,
      backend: 'docker_sandbox',
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      agentBrowserSettings: {
        enabled: true,
        runtimeMode: 'chrome-cdp',
        cdpPort: 9222,
        liveViewEnabled: true,
        provider: 'local'
      }
    })

    expect(result.success).toBe(false)
    expect(result.errorCode).toBe('BACKEND_UNAVAILABLE')
    expect(String(result.reason || '')).toMatch(/managed agent browser runtime|install with/i)
    expect(result.backend).toBe('docker_sandbox')
    expect(result.command).toBe('npx agent-browser --help')
    expect(result.agentBrowser?.managedRuntimeRequired).toBe(true)

    const nonVersionCalls = runner.mock.calls.filter((call) => {
      const args = call?.[0]?.args
      return !Array.isArray(args) || args[0] !== '--version'
    })
    expect(nonVersionCalls.length).toBe(0)
  })

  it('auto-recovers native_bash_execute Agent Browser startup errors with close + tab new', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-recover-'))
    const fakeAgentBrowserPath = path.join(tempWorkspace, 'agent-browser')
    const statePath = path.join(tempWorkspace, 'ab-ready.state')
    const callLogPath = path.join(tempWorkspace, 'ab-calls.log')

    const script = `#!/bin/zsh
set -euo pipefail

STATE_FILE=${JSON.stringify(statePath)}
CALL_LOG=${JSON.stringify(callLogPath)}

subcommand=""
for arg in "$@"; do
  if [[ "$arg" == --* || "$arg" == -* ]]; then
    continue
  fi
  subcommand="$arg"
  break
done

printf '%s\\n' "$subcommand" >> "$CALL_LOG"

if [[ "$subcommand" == "close" ]]; then
  rm -f "$STATE_FILE"
  printf '{"success":true,"data":{"closed":true},"error":null}\\n'
  exit 0
fi

if [[ "$subcommand" == "tab" ]]; then
  touch "$STATE_FILE"
  printf '{"success":true,"data":{"index":0,"total":1},"error":null}\\n'
  exit 0
fi

if [[ "$subcommand" == "open" ]]; then
  if [[ ! -f "$STATE_FILE" ]]; then
    printf 'Browser not launched. Call launch first.\\n' >&2
    exit 1
  fi
  printf '{"success":true,"data":{"title":"Recovered"},"error":null}\\n'
  exit 0
fi

printf '{"success":true,"data":{},"error":null}\\n'
`

    await writeFile(fakeAgentBrowserPath, script, 'utf8')
    await chmod(fakeAgentBrowserPath, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${tempWorkspace}:${originalPath ?? ''}`

    try {
      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId: 'josh',
        projectPath: tempWorkspace,
        providerSettings: {
          nativeTools: {
            fetchZipEnabled: false,
            dynamicMcpEnabled: false,
            webSearchEnabled: false,
            bashEnabled: true,
            bashAccessMode: 'dangerous',
            executionBackend: 'local',
            agentBrowserEnabled: true,
            agentBrowserRuntimeMode: 'chromium',
            agentBrowserProvider: 'local'
          }
        },
        toolApprovalMode: 'none'
      } as any)

      const bashTool = (tools as any).native_bash_execute
      expect(bashTool).toBeTruthy()

      const result = await bashTool.execute({
        command: `PATH=${tempWorkspace}:$PATH agent-browser --headed open https://example.com`
      })

      expect(result.success).toBe(true)
      expect(result.agentBrowser?.recovery?.attempted).toBe(true)
      expect(result.agentBrowser?.recovery?.succeeded).toBe(true)

      const calls = (await readFile(callLogPath, 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
      expect(calls.filter((entry) => entry === 'open').length).toBe(2)
      expect(calls).toContain('close')
      expect(calls).toContain('tab')
    } finally {
      process.env.PATH = originalPath
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('injects controlled screenshot paths for agent-browser bash screenshot commands', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-shot-cmd-'))
    const fakeAgentBrowserPath = path.join(tempWorkspace, 'agent-browser')
    const script = `#!/bin/zsh
set -euo pipefail
printf 'ok\\n'
`
    await writeFile(fakeAgentBrowserPath, script, 'utf8')
    await chmod(fakeAgentBrowserPath, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${tempWorkspace}:${originalPath ?? ''}`

    try {
      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId: 'josh',
        projectPath: tempWorkspace,
        providerSettings: {
          nativeTools: {
            fetchZipEnabled: false,
            dynamicMcpEnabled: false,
            webSearchEnabled: false,
            bashEnabled: true,
            bashAccessMode: 'dangerous',
            executionBackend: 'local',
            agentBrowserEnabled: true,
            agentBrowserRuntimeMode: 'chromium',
            agentBrowserProvider: 'local'
          }
        },
        toolApprovalMode: 'none'
      } as any)

      const bashTool = (tools as any).native_bash_execute
      expect(bashTool).toBeTruthy()

      const result = await bashTool.execute({
        command: `PATH=${tempWorkspace}:$PATH agent-browser screenshot || true`
      })

      expect(result.command).toContain('agent-browser')
      expect(result.command).toContain('screenshot')
      expect(result.command).toMatch(/batshit-agent-browser-.*\.png/)
      expect(result.agentBrowser?.appliedDefaults).toEqual(
        expect.arrayContaining(['screenshotPath'])
      )
    } finally {
      process.env.PATH = originalPath
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  // SA-105 P1 (DL-105-11, AMD-105-12): these two tests previously pinned the
  // DEPRECATED `image-url` / `image-data` shapes with toEqual, which made them a
  // tripwire for the helper migration rather than coverage of it. They now pin
  // the current `file` shape AND the lane the run resolved.
  it('native_bash_execute maps Agent Browser screenshot URLs to a current file part on a tool_result lane', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      imageDelivery: { lane: 'tool_result', reason: 'test_anthropic' },
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(typeof bashTool?.toModelOutput).toBe('function')

    const modelOutput = await bashTool.toModelOutput({
      toolCallId: 'tool_call_1',
      input: { command: 'agent-browser screenshot' },
      output: {
        agentBrowser: {
          command: 'screenshot',
          screenshot: {
            command: 'screenshot',
            modelImageUrl: 'https://tunnel.example/uploads/agent-browser-shot.png',
            mediaType: 'image/png'
          }
        }
      }
    })

    expect(modelOutput).toEqual({
      type: 'content',
      value: [
        { type: 'text', text: 'Agent Browser screenshot:' },
        {
          type: 'file',
          mediaType: 'image/png',
          data: { type: 'url', url: new URL('https://tunnel.example/uploads/agent-browser-shot.png') }
        }
      ]
    })
    // The deprecated shims logged an AI SDK warning on every call.
    const serialized = JSON.stringify(modelOutput)
    expect(serialized).not.toContain('image-url')
    expect(serialized).not.toContain('image-data')
  })

  it('native_bash_execute maps local Agent Browser screenshots to a current file data part and cleans up temp files', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-shot-'))
    const screenshotPath = path.join(tempWorkspace, 'test-shot.png')
    await writeFile(screenshotPath, Buffer.from('iVBORw0KGgo=', 'base64'))

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      imageDelivery: { lane: 'tool_result', reason: 'test_anthropic' },
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(typeof bashTool?.toModelOutput).toBe('function')

    try {
      const modelOutput = await bashTool.toModelOutput({
        toolCallId: 'tool_call_2',
        input: { command: 'agent-browser screenshot' },
        output: {
          agentBrowser: {
            command: 'screenshot',
            screenshot: {
              command: 'screenshot',
              path: screenshotPath,
              mediaType: 'image/png'
            }
          }
        }
      })

      expect(modelOutput?.type).toBe('content')
      expect(Array.isArray(modelOutput?.value)).toBe(true)
      expect(modelOutput?.value?.[0]).toEqual({ type: 'text', text: 'Agent Browser screenshot:' })
      expect(modelOutput?.value?.[1]?.type).toBe('file')
      expect(modelOutput?.value?.[1]?.mediaType).toBe('image/png')
      expect(modelOutput?.value?.[1]?.data?.type).toBe('data')
      expect(typeof modelOutput?.value?.[1]?.data?.data).toBe('string')

      await expect(stat(screenshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  // SA-105 P1 → P5 (DL-105-11): the actual defect fix, completed. On a provider
  // whose tool results serialize as text, the old path handed the model a
  // JSON-stringified base64 blob — one measured screenshot cost ~141,125 tokens
  // of text and the model replied "RECEIVED TEXT NOT IMAGE". P1 made it withhold
  // honestly; P5 delivers the screenshot through the same per-run synthetic
  // registry memory recall uses, so `prepareStep` appends it as a user image
  // message within the run. The tool result itself must stay byte-free.
  it('native_bash_execute hands a local screenshot to the synthetic registry on a text-only lane', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-lane-'))
    const screenshotPath = path.join(tempWorkspace, 'text-lane-shot.png')
    await writeFile(screenshotPath, Buffer.from('iVBORw0KGgo=', 'base64'))
    const registry = createEphemeralImageRegistry()

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      imageDelivery: {
        lane: 'synthetic_user',
        reason: 'provider_togetherai_serializes_tool_results_as_text'
      },
      ephemeralImages: registry,
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute

    try {
      const modelOutput = await bashTool.toModelOutput({
        toolCallId: 'tool_call_text_lane',
        input: { command: 'agent-browser screenshot' },
        output: {
          agentBrowser: {
            command: 'screenshot',
            screenshot: { command: 'screenshot', path: screenshotPath, mediaType: 'image/png' }
          }
        }
      })

      // A content output here would be JSON.stringify'd into base64 text.
      expect(modelOutput?.type).toBe('text')
      expect(modelOutput?.value).toContain('within this same reply')
      expect(JSON.stringify(modelOutput)).not.toContain('iVBORw0KGgo')

      // The bytes went to the registry, keyed by this call, labelled as a
      // screenshot rather than as recalled memory media.
      const taken = registry.take('tool_call_text_lane')
      expect(taken?.source).toBe('native_bash_execute')
      expect(taken?.purpose).toBe('Agent Browser screenshot')
      expect(taken?.images).toHaveLength(1)
      expect(taken?.images[0]?.mediaType).toBe('image/png')
      expect(taken?.images[0]?.data).toBe('iVBORw0KGgo=')
      // take() clears, so the screenshot is injected exactly once.
      expect(registry.take('tool_call_text_lane')).toBeUndefined()
      // Temp file is cleaned up once the bytes are in the registry.
      await expect(stat(screenshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('native_bash_execute hands an uploaded screenshot URL to the synthetic registry on a text-only lane', async () => {
    const registry = createEphemeralImageRegistry()
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      imageDelivery: { lane: 'synthetic_user', reason: 'provider_openrouter_serializes_tool_results_as_text' },
      ephemeralImages: registry,
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const modelOutput = await (tools as any).native_bash_execute.toModelOutput({
      toolCallId: 'tool_call_text_lane_url',
      input: { command: 'agent-browser screenshot' },
      output: {
        agentBrowser: {
          command: 'screenshot',
          screenshot: {
            command: 'screenshot',
            modelImageUrl: 'https://tunnel.example/uploads/text-lane-shot.png',
            mediaType: 'image/png'
          }
        }
      }
    })

    expect(modelOutput?.type).toBe('text')
    expect(modelOutput?.value).toContain('within this same reply')
    // The uploaded file is gone by delivery time, so the registry carries the
    // model-visible URL rather than bytes — the same source the tool_result
    // lane would have used.
    const taken = registry.take('tool_call_text_lane_url')
    expect(taken?.images).toEqual([
      { mediaType: 'image/png', url: 'https://tunnel.example/uploads/text-lane-shot.png' }
    ])
  })

  it('native_bash_execute withholds a screenshot on a text-only lane when no synthetic channel was opened', async () => {
    // Only the brain opens the synthetic channel, and only on text lanes. A
    // caller that resolved a text lane but passed no registry must not send
    // bytes that would arrive as base64 text.
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-noreg-'))
    const screenshotPath = path.join(tempWorkspace, 'no-registry-shot.png')
    await writeFile(screenshotPath, Buffer.from('iVBORw0KGgo=', 'base64'))

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      imageDelivery: { lane: 'synthetic_user', reason: 'image_delivery_context_missing' },
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true
        }
      },
      toolApprovalMode: 'none'
    } as any)

    try {
      const modelOutput = await (tools as any).native_bash_execute.toModelOutput({
        toolCallId: 'tool_call_no_registry',
        input: { command: 'agent-browser screenshot' },
        output: {
          agentBrowser: {
            command: 'screenshot',
            screenshot: { command: 'screenshot', path: screenshotPath, mediaType: 'image/png' }
          }
        }
      })

      expect(modelOutput?.type).toBe('text')
      expect(modelOutput?.value).toContain('not shown to you')
      expect(JSON.stringify(modelOutput)).not.toContain('iVBORw0KGgo')
      await expect(stat(screenshotPath)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  // SA-105 P5: the PERSISTED screenshot payload (what send-routed reads for the
  // sanitized tool card) must tell the same truth the model was told.
  it('nativeBashExecute records a lane-aware modelVisibleInLoop on the screenshot payload', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-lane-flag-'))
    const fakeAgentBrowserPath = path.join(tempWorkspace, 'agent-browser')
    // The fake CLI writes a tiny PNG to the screenshot path Batshit injected as
    // the final argument, so the payload sees a real file.
    const script = `#!/bin/zsh
set -euo pipefail
printf 'iVBORw0KGgo=' | base64 -d > "\${@[-1]}"
printf 'ok\n'
`
    await writeFile(fakeAgentBrowserPath, script, 'utf8')
    await chmod(fakeAgentBrowserPath, 0o755)
    const originalPath = process.env.PATH
    process.env.PATH = `${tempWorkspace}:${originalPath ?? ''}`

    const runScreenshot = (imageDelivery: any) =>
      nativeToolService.nativeBashExecute({
        userId: 'josh',
        projectPath: tempWorkspace,
        command: 'agent-browser screenshot',
        accessMode: 'dangerous',
        backend: 'local',
        agentBrowserSettings: {
          enabled: true,
          runtimeMode: 'chromium',
          provider: 'local'
        } as any,
        imageDelivery
      })

    try {
      const blind = await runScreenshot({ lane: 'none', reason: 'model_capabilities_vision_false' })
      expect(blind.agentBrowser?.screenshot?.modelVisibleInLoop).toBe(false)
      expect(blind.agentBrowser?.screenshot?.lane).toBe('none')
      expect(blind.agentBrowser?.screenshot?.historyRetention).toBe('none')

      const synthetic = await runScreenshot({
        lane: 'synthetic_user',
        reason: 'provider_openrouter_serializes_tool_results_as_text'
      })
      expect(synthetic.agentBrowser?.screenshot?.modelVisibleInLoop).toBe(true)
      expect(synthetic.agentBrowser?.screenshot?.lane).toBe('synthetic_user')

      // No lane at all (Workflow Subagent dispatch): the flag keeps its older
      // meaning — an image payload exists — and carries no lane fields.
      const dispatch = await runScreenshot(undefined)
      expect(dispatch.agentBrowser?.screenshot?.modelVisibleInLoop).toBe(true)
      expect(dispatch.agentBrowser?.screenshot?.lane).toBeUndefined()
    } finally {
      process.env.PATH = originalPath
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('native_bash_execute withholds a screenshot when the model cannot accept images at all', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      imageDelivery: { lane: 'none', reason: 'model_capabilities_vision_false' },
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          agentBrowserEnabled: true
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const modelOutput = await (tools as any).native_bash_execute.toModelOutput({
      toolCallId: 'tool_call_no_vision',
      input: { command: 'agent-browser screenshot' },
      output: {
        agentBrowser: {
          command: 'screenshot',
          screenshot: {
            command: 'screenshot',
            modelImageUrl: 'https://tunnel.example/uploads/shot.png',
            mediaType: 'image/png'
          }
        }
      }
    })

    expect(modelOutput?.type).toBe('text')
    expect(modelOutput?.value).toContain('cannot accept image input')
    expect(JSON.stringify(modelOutput)).not.toContain('tunnel.example')
  })

  it('returns a clear API key error when agent-browser bash command uses Browserbase without credentials', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          executionBackend: 'local',
          agentBrowserEnabled: true,
          agentBrowserProvider: 'browserbase'
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const bashTool = (tools as any).native_bash_execute
    expect(bashTool).toBeTruthy()

    const result = await bashTool.execute({
      command: 'agent-browser open https://example.com'
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(false)
    expect(String(result.reason || result.error || '')).toMatch(/browserbase key is missing/i)
  })

  it('uses API Keys credentials when provider is set via agent-browser bash command flag', async () => {
    vi.mocked(apiKeyService.retrieve).mockImplementation(async (service, userId) => {
      if (userId !== 'josh') return null
      if (service === 'browserbase') return 'browserbase-test-key'
      if (service === 'browserbase_project_id') return 'bb-project-123'
      return null
    })

    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-native-ab-provider-'))
    const fakeAgentBrowserPath = path.join(tempWorkspace, 'agent-browser')
    const script = `#!/bin/zsh
set -euo pipefail
printf 'ok\\n'
`
    await writeFile(fakeAgentBrowserPath, script, 'utf8')
    await chmod(fakeAgentBrowserPath, 0o755)

    try {
      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId: 'josh',
        projectPath: process.cwd(),
        providerSettings: {
          nativeTools: {
            fetchZipEnabled: false,
            dynamicMcpEnabled: false,
            webSearchEnabled: false,
            bashEnabled: true,
            bashAccessMode: 'dangerous',
            executionBackend: 'local',
            agentBrowserEnabled: true,
            agentBrowserProvider: 'local'
          }
        },
        toolApprovalMode: 'none'
      } as any)

      const bashTool = (tools as any).native_bash_execute
      expect(bashTool).toBeTruthy()

      const result = await bashTool.execute({
        command: `PATH=${tempWorkspace}:$PATH agent-browser -p browserbase open https://example.com || true`
      })

      expect(result.blocked).not.toBe(true)
      expect(result.agentBrowser?.provider).toBe('browserbase')
      expect(result.agentBrowser?.providerCredentialsInjected).toBe(true)
      expect(apiKeyService.retrieve).toHaveBeenCalledWith('browserbase', 'josh')
      expect(apiKeyService.retrieve).toHaveBeenCalledWith('browserbase_project_id', 'josh')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('defaults execution backend to Apple Container on native macOS and Docker Sandbox elsewhere', () => {
    const settings = nativeToolService.resolveNativeToolSettings(null)
    expect(settings.executionBackend).toBe(
      process.platform === 'darwin' ? 'apple_container' : 'docker_sandbox'
    )
  })

  it('defaults execution backend to docker_sandbox in containerized native tool settings', () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CONTAINERIZED = '1'
    const settings = nativeToolService.resolveNativeToolSettings(null)
    expect(settings.executionBackend).toBe('docker_sandbox')
  })

  it('infers local execution backend when dangerous bash mode is set without an explicit backend', () => {
    const settings = nativeToolService.resolveNativeToolSettings({
      nativeTools: {
        bashAccessMode: 'dangerous'
      }
    } as any)

    expect(settings.bashAccessMode).toBe('dangerous')
    expect(settings.executionBackend).toBe('local')
  })

  it('resolves the native macOS default dispatch backend to Apple Container', async () => {
    if (process.platform !== 'darwin') return

    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          bashAccessMode: 'plan'
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { command: 'pwd' },
      context: {
        session_id: 'session_apple_default_unavailable',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.backend).toBe('apple_container')
  })

  it('blocks machine-wide Python version mutation commands', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'brew install python@3.12',
      accessMode: 'dangerous',
      backend: 'local'
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(String(result.reason || '')).toMatch(/machine Python installation is blocked/i)
  })

  it('blocks bare global pip install commands', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: 'pip3 install qwen-tts',
      accessMode: 'dangerous',
      backend: 'local'
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(String(result.reason || '')).toMatch(/Global Python package mutation is blocked/i)
  })

  it('allows venv-targeted pip install commands to proceed past policy evaluation', async () => {
    const result = await nativeToolService.nativeBashExecute({
      command: '/tmp/demo/.venv/bin/pip install qwen-tts --dry-run',
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      accessMode: 'dangerous',
      backend: 'local'
    })

    expect(result.blocked).not.toBe(true)
    expect(String(result.reason || '')).not.toMatch(/Global Python package mutation is blocked/i)
  })

  it('returns INVALID_CONTEXT when subagent dispatch context omits parent agent id', async () => {
    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { command: 'pwd' },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_sub',
        mode: 'mode1',
        actor_type: 'subagent'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_CONTEXT')
  })

  it("keeps primary_agent_type 'n8n' as the Category 2 subagent wire value (SA-106)", async () => {
    // SA-106 DL-106-01. The n8n PRIMARY agent type is retired, but BOTH surviving
    // official `n8n Workflow Subagent` templates hardcode `primary_agent_type: 'n8n'`
    // with `actor_type: 'subagent'`, and PUBLIC_PRIMARY_AGENT_TYPE_TO_NATIVE_MODE maps
    // that value to 'mode2'. Dropping 'n8n' from the dispatch context vocabulary reads
    // like obvious retired-lane cleanup and would break every already-imported
    // Workflow Subagent workflow in every user's n8n instance.
    //
    // It costs nothing to keep: every mode3/mode4 gate is scoped to
    // `actor_type === 'primary'`, so a subagent caller never reaches them.
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          fetchZipEnabled: true
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_search',
      payloadInput: { query: 'workflow tools' },
      context: {
        session_id: 'session_demo',
        agent_id: 'subagent_workflow',
        primary_agent_type: 'n8n',
        actor_type: 'subagent',
        // Required for subagent actors by NATIVE_AUTOMATION_CONTEXT_SCHEMA; both
        // official Workflow Subagent templates send it.
        parent_agent_id: 'agent_parent_api'
      }
    })

    // The context parsed and resolved rather than being rejected as an unknown type:
    // that is the whole point of this test.
    expect(result.context.mode).toBe('mode2')
    expect(result.context.actor_type).toBe('subagent')
    expect(result.error?.code).not.toBe('INVALID_CONTEXT')
  })

  it('dispatches agent_browser_find through the native automation pack for primary agents', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: '',
        stderr: 'unexpected',
        exitCode: 1,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          agentBrowserEnabled: true,
          agentBrowserProvider: 'browserbase',
          agentBrowserLiveViewEnabled: false
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'agent_browser_find',
      payloadInput: {
        query: 'screenshot'
      },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('agent_browser_find')
    expect(result.data?.available).toBe(true)
    expect(result.data?.defaults?.provider).toBe('browserbase')
    expect(result.data?.defaults?.liveViewEnabled).toBe(false)
    expect(runner).toHaveBeenCalled()
  })

  it('dispatches Agent Browser find as a Docker sidecar catalog when stopped', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_AGENT_BROWSER_SIDECAR_URL = 'http://agent-browser.test'
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          agentBrowserEnabled: true
        }
      }
    } as any)
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => {
        throw new Error('sidecar offline')
      })
    )

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'agent_browser_find',
      payloadInput: {
        query: 'screenshot'
      },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.data?.available).toBe(false)
    expect(result.data?.supportLevel).toBe('docker-sidecar')
    expect(result.data?.results.map((entry: any) => entry.toolName)).toContain('screenshot')
  })

  it('allows n8n bash_execute to use the local app-container shell in Docker', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-container-bash-'))
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CONTAINERIZED = '1'
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)

    try {
      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command: 'printf DOCKER_CONTAINER_LOCAL_BASH_OK' },
        projectPath: tempWorkspace,
        context: {
          session_id: 'session_demo',
          agent_id: 'agent_primary',
          mode: 'mode1',
          actor_type: 'primary'
        }
      })

      expect(result.success).toBe(true)
      expect(result.backend).toBe('local')
      expect(result.data?.stdout).toContain('DOCKER_CONTAINER_LOCAL_BASH_OK')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('returns command exit failures as tool data instead of dispatch errors', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { command: "printf 'missing file\\n' >&2; exit 2" },
      projectPath: process.cwd(),
      context: {
        session_id: 'session_command_exit_failure',
        agent_id: 'agent_primary',
        primary_agent_type: 'n8n',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.error).toBeUndefined()
    expect(result.data?.success).toBe(false)
    expect(result.data?.exitCode).toBe(2)
    expect(result.data?.stderr).toContain('missing file')
    expect(result.data?.failureMessage).toContain('missing file')
    expect(result.data?.policyProfile).toMatchObject({
      type: 'non_interactive',
      accessMode: 'dangerous'
    })
  })

  it('uses explicit managed-helper projectPath over stale session project metadata for bash_execute', async () => {
    const staleWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-stale-helper-root-'))
    const activeWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-active-helper-root-'))
    const activeRealPath = await realpath(activeWorkspace)

    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)
    vi.mocked(redis.getSession).mockResolvedValue({
      metadata: {
        projectPath: staleWorkspace
      }
    } as any)

    try {
      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command: 'pwd' },
        context: {
          session_id: 'session_stale_helper_root',
          agent_id: 'agent_primary',
          mode: 'mode4',
          actor_type: 'primary'
        },
        projectPath: activeWorkspace
      })

      expect(result.success).toBe(true)
      expect(result.data?.cwd).toBe(activeRealPath)
      expect(result.data?.workspaceRoot).toBe(activeRealPath)
      expect(String(result.data?.stdout || '')).toContain(activeRealPath)
      expect(String(result.data?.stdout || '')).not.toContain(staleWorkspace)
    } finally {
      await rm(staleWorkspace, { recursive: true, force: true })
      await rm(activeWorkspace, { recursive: true, force: true })
    }
  })

  it('names requested cwd and allowed root when bash_execute blocks stale-root cwd drift', async () => {
    const staleWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-stale-cwd-'))
    const activeWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-active-cwd-'))
    const staleRealPath = await realpath(staleWorkspace)
    const activeRealPath = await realpath(activeWorkspace)

    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)

    try {
      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: {
          command: 'pwd',
          cwd: staleWorkspace
        },
        context: {
          session_id: 'session_stale_helper_cwd',
          agent_id: 'agent_primary',
          mode: 'mode4',
          actor_type: 'primary'
        },
        projectPath: activeWorkspace
      })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('POLICY_BLOCKED')
      expect(result.error?.message).toContain(staleWorkspace)
      expect(result.error?.message).toContain(staleRealPath)
      expect(result.error?.message).toContain(activeRealPath)
    } finally {
      await rm(staleWorkspace, { recursive: true, force: true })
      await rm(activeWorkspace, { recursive: true, force: true })
    }
  })

  it('accepts bash_execute input via innerCommand alias for automation-pack dispatch', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { innerCommand: 'pwd' },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(result.error?.code).not.toBe('INVALID_INPUT')
    expect(result.error?.message ?? '').not.toMatch(/Invalid input for action "bash_execute"/i)
  })

  it('accepts bash_execute input via nested input.command for automation-pack dispatch', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: {
        input: {
          command: 'pwd'
        }
      },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(result.error?.code).not.toBe('INVALID_INPUT')
    expect(result.error?.message ?? '').not.toMatch(/Invalid input for action "bash_execute"/i)
  })

  it('dispatches native_skill through the shared skill runtime for automation-pack contexts', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)
    vi.mocked(executeSkillRuntimeAction).mockResolvedValue({
      success: true,
      action: 'invoke',
      skillId: 'agent_browser',
      skillName: 'agent-browser',
      skillMarkdown: '# agent-browser'
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'native_skill',
      payloadInput: {
        skillId: 'agent_browser',
        action: 'invoke'
      },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(executeSkillRuntimeAction).toHaveBeenCalledWith({
      userId: 'josh',
      skillId: 'agent_browser',
      action: 'invoke',
      path: undefined,
      maxChars: undefined
    })
    expect(result.success).toBe(true)
    expect(result.action).toBe('native_skill')
    expect(result.data?.skillId).toBe('agent_browser')
  })

  it('normalizes snake_case native_skill automation-pack input aliases', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      }
    } as any)
    vi.mocked(executeSkillRuntimeAction).mockResolvedValue({
      success: true,
      action: 'invoke',
      skillId: 'agent_browser',
      skillName: 'agent-browser',
      skillMarkdown: '# agent-browser'
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'native_skill',
      payloadInput: {
        skill_id: 'agent_browser',
        action: 'invoke'
      },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(executeSkillRuntimeAction).toHaveBeenCalledWith({
      userId: 'josh',
      skillId: 'agent_browser',
      action: 'invoke',
      path: undefined,
      maxChars: undefined
    })
    expect(result.success).toBe(true)
    expect(result.action).toBe('native_skill')
    expect(result.data?.skillId).toBe('agent_browser')
  })

  it.each([
    ['mode1', 'local'],
    ['mode1', 'docker_sandbox'],
    ['mode2', 'local'],
    ['mode2', 'docker_sandbox']
  ] as const)(
    'dispatch bash_execute keeps managed apply_patch contract for %s on %s backend',
    async (mode, executionBackend) => {
      const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-dispatch-apply-patch-'))
      try {
        const targetFile = path.join(tempWorkspace, 'NOTES.md')
        await writeFile(targetFile, 'alpha\n', 'utf8')
        vi.mocked(redis.getProjectPreferences).mockResolvedValue({
          default_workspace_path: tempWorkspace
        } as any)
        vi.mocked(redis.get).mockResolvedValue({
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              bashEnabled: true,
              executionBackend,
              bashAccessMode: 'dangerous'
            }
          }
        } as any)

        const command = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: NOTES.md
@@
-alpha
+beta
*** End Patch
PATCH`

        const result = await nativeToolService.dispatchNativeAutomationPackAction({
          userId: 'josh',
          action: 'bash_execute',
          payloadInput: { command },
          context: {
            session_id: `session_${mode}_${executionBackend}`,
            agent_id: 'agent_primary',
            mode,
            actor_type: 'primary'
          }
        })

        expect(result.success).toBe(true)
        expect(result.backend).toBe(executionBackend)
        expect(result.data?.mappedToolName).toBe('batshit_server_edit_file')
        expect(result.data?.managedApplyPatch?.managed).toBe(true)
        expect(result.data?.managedApplyPatch?.operationsApplied).toBe(1)
        expect(result.data?.mappedToolInput?.touchedPaths).toEqual(expect.arrayContaining(['NOTES.md']))
        expect(await readFile(targetFile, 'utf8')).toBe('beta\n')
      } finally {
        await rm(tempWorkspace, { recursive: true, force: true })
      }
    }
  )

  it('dispatch bash_execute preserves INVALID_INPUT from managed apply_patch parsing', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-dispatch-apply-invalid-'))
    try {
      vi.mocked(redis.getProjectPreferences).mockResolvedValue({
        default_workspace_path: tempWorkspace
      } as any)
      vi.mocked(redis.get).mockResolvedValue({
        user_id: 'josh',
        provider_specific_settings: {
          nativeTools: {
            bashEnabled: true,
            executionBackend: 'local',
            bashAccessMode: 'dangerous'
          }
        }
      } as any)

      const malformedCommand = `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: NOTES.md
*** End Patch
PATCH`

      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command: malformedCommand },
        context: {
          session_id: 'session_invalid_patch',
          agent_id: 'agent_primary',
          mode: 'mode1',
          actor_type: 'primary'
        }
      })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('INVALID_INPUT')
      expect(result.error?.message).toMatch(/requires at least one hunk/i)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('returns SANDBOX_UNAVAILABLE when docker sandbox backend is selected but docker is unavailable', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'docker_sandbox',
          automationBashAllowList: ['re:^\\s*pwd\\b']
        }
      }
    } as any)

    const originalPath = process.env.PATH
    process.env.PATH = ''

    try {
      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command: 'pwd' },
        context: {
          session_id: 'session_demo',
          agent_id: 'agent_primary',
          mode: 'mode1',
          actor_type: 'primary'
        }
      })

      expect(result.success).toBe(false)
      expect(result.error?.code).toBe('SANDBOX_UNAVAILABLE')
      expect(result.error?.message).toMatch(/docker/i)
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('treats Docker Sandbox as the built-in operator-backed route in Docker installs', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_CONTAINERIZED = '1'
    const fetchMock = vi.spyOn(globalThis, 'fetch')

    const status = await nativeToolService.getSandboxBackendStatus()

    expect(status.available).toBe(false)
    expect(status.supported).toBe(true)
    expect(status.dockerUnsupported).toBe(false)
    expect(status.containerized).toBe(true)
    expect(status.backend).toBe('docker_sandbox')
    expect(status.reason).toMatch(/operator is not configured/i)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('uses the configured Docker Sandbox operator for containerized status checks', async () => {
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL = 'http://host.docker.internal:5629'
    nativeToolEnv.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN = 'operator-token'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL = 'http://host.docker.internal:5629'
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN = 'operator-token'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          available: true,
          supported: true,
          cli: 'sbx',
          version: 'sbx v0.99.0'
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    )

    const status = await nativeToolService.getSandboxBackendStatus()

    expect(status.available).toBe(true)
    expect(status.dockerUnsupported).toBe(false)
    expect(status.cli).toBe('sbx')
    expect(status.version).toBe('sbx v0.99.0')
    expect(fetchMock).toHaveBeenCalledWith(
      'http://host.docker.internal:5629/v1/sandbox/status',
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: 'Bearer operator-token'
        })
      })
    )
  })

  it('executes docker_sandbox bash through the configured containerized operator', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-sandbox-operator-workspace-'))
    nativeToolEnv.BATSHIT_CONTAINERIZED = '1'
    nativeToolEnv.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL = 'http://host.docker.internal:5629'
    nativeToolEnv.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN = 'operator-token'
    process.env.BATSHIT_CONTAINERIZED = '1'
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_URL = 'http://host.docker.internal:5629'
    process.env.BATSHIT_DOCKER_SANDBOX_OPERATOR_TOKEN = 'operator-token'
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      new Response(
        JSON.stringify({
          ok: true,
          sandboxName: 'batshit-josh-operator',
          run: {
            command: 'operator sandbox exec',
            stdout: 'operator ok\n',
            stderr: '',
            exitCode: 0,
            signal: null,
            timedOut: false,
            durationMs: 12,
            truncated: false
          }
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    )

    try {
      const expectedWorkspace = await realpath(tempWorkspace)
      const result = await nativeToolService.nativeBashExecute({
        userId: 'josh',
        sessionId: 'session_operator',
        command: 'pwd',
        cwd: tempWorkspace,
        workspaceRoot: tempWorkspace,
        backend: 'docker_sandbox',
        accessMode: 'dangerous'
      })

      expect(result.success).toBe(true)
      expect(result.stdout).toContain('operator ok')
      expect(result.sandboxName).toBe('batshit-josh-operator')
      expect(fetchMock).toHaveBeenCalledWith(
        'http://host.docker.internal:5629/v1/sandbox/execute',
        expect.objectContaining({
          method: 'POST',
          headers: expect.objectContaining({
            authorization: 'Bearer operator-token'
          }),
          body: expect.any(String)
        })
      )
      const request = fetchMock.mock.calls[0]?.[1] as RequestInit
      const body = JSON.parse(String(request.body))
      expect(body).toMatchObject({
        userId: 'josh',
        sessionId: 'session_operator',
        workspaceRoot: expectedWorkspace,
        cwd: expectedWorkspace,
        command: 'pwd'
      })
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('executes bash through the Apple Container sandbox backend when explicitly selected', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-container-workspace-'))
    try {
      const expectedWorkspace = await realpath(tempWorkspace)
      vi.mocked(appleContainerSandboxMocks.executeAppleContainerSandboxCommand).mockResolvedValue({
        ok: true,
        sandboxName: 'batshit-apple-sandbox-josh-session',
        cleanupWarnings: [],
        run: {
          command: 'container exec batshit-apple-sandbox-josh-session bash -lc pwd',
          stdout: 'apple ok\n',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 12,
          truncated: false
        }
      })

      const result = await nativeToolService.nativeBashExecute({
        userId: 'josh',
        sessionId: 'session_apple',
        command: 'pwd',
        cwd: tempWorkspace,
        workspaceRoot: tempWorkspace,
        backend: 'apple_container',
        accessMode: 'dangerous'
      })

      expect(result.success).toBe(true)
      expect(result.backend).toBe('apple_container')
      expect(result.backendLabel).toBe('Apple Container Sandbox')
      expect(result.stdout).toContain('apple ok')
      expect(result.sandboxName).toBe('batshit-apple-sandbox-josh-session')
      expect(
        appleContainerSandboxMocks.executeAppleContainerSandboxCommand
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          userId: 'josh',
          sessionId: 'session_apple',
          workspaceRoot: expectedWorkspace,
          cwd: expectedWorkspace,
          command: 'pwd',
          timeoutMs: 30_000
        })
      )
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('returns SANDBOX_UNAVAILABLE without falling back when Apple Container execution fails', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-apple-unavailable-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        userId: 'josh',
        sessionId: 'session_apple_unavailable',
        command: 'pwd',
        cwd: tempWorkspace,
        workspaceRoot: tempWorkspace,
        backend: 'apple_container',
        accessMode: 'dangerous'
      })

      expect(result.success).toBe(false)
      expect(result.errorCode).toBe('SANDBOX_UNAVAILABLE')
      expect(result.backend).toBe('apple_container')
      expect(result.reason).toContain('Apple Container sandbox mock not configured')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('exposes Apple Container sandbox status and recovery helpers', async () => {
    vi.mocked(appleContainerSandboxMocks.getAppleContainerSandboxStatus).mockResolvedValue({
      available: true,
      installed: true,
      supported: true,
      backend: 'apple_container',
      driver: 'apple_container',
      version: 'container CLI version 0.12.3',
      network: 'batshit-apple-sandbox-internal',
      image: 'bash:5.2',
      policy: 'internal-network',
      reason: null,
      installUrl: 'https://github.com/apple/container/releases/latest',
      capabilities: ['status', 'recover', 'execute', 'cleanup']
    })
    vi.mocked(appleContainerSandboxMocks.recoverAppleContainerSandbox).mockResolvedValue({
      success: true,
      recovered: true,
      backend: 'apple_container',
      sandboxName: 'batshit-apple-sandbox-josh-recovered',
      workspaceRoot: process.cwd(),
      cwd: process.cwd(),
      network: 'batshit-apple-sandbox-internal',
      image: 'bash:5.2',
      version: 'container CLI version 0.12.3'
    })

    const status = await nativeToolService.getAppleContainerSandboxBackendStatus()
    const recovery = await nativeToolService.recoverAppleContainerSandboxBackend({
      userId: 'josh',
      workspaceRoot: process.cwd()
    })

    expect(status.available).toBe(true)
    expect(recovery.success).toBe(true)
    expect(recovery.backend).toBe('apple_container')
    expect(recovery.sandboxName).toBe('batshit-apple-sandbox-josh-recovered')
  })

  it('cleans Apple Container session sandboxes with the unified execution cleanup hook', async () => {
    vi.mocked(appleContainerSandboxMocks.cleanupAppleContainerSandboxesForSession).mockResolvedValue([
      'apple cleanup warning'
    ])

    const warnings = await nativeToolService.cleanupExecutionSandboxesForSession(
      'session_apple_cleanup'
    )

    expect(appleContainerSandboxMocks.cleanupAppleContainerSandboxesForSession).toHaveBeenCalledWith(
      'session_apple_cleanup'
    )
    expect(warnings).toContain('apple cleanup warning')
  })

  it('reuses one docker sandbox across a session run and cleans it up at run end', async () => {
    const fakeDockerDir = await mkdtemp(path.join(os.tmpdir(), 'batshit-fake-docker-'))
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-sandbox-workspace-'))
    const stateFile = path.join(fakeDockerDir, 'sandbox-state.txt')
    const eventLogFile = path.join(fakeDockerDir, 'sandbox-event-log.txt')
    const fakeDockerPath = path.join(fakeDockerDir, 'docker')
    const staleSandboxName = 'batshit-josh-stale000'
    const sessionId = 'session_demo_reuse'

    const fakeDockerScript = `#!/bin/bash
set -eu
STATE_FILE=${JSON.stringify(stateFile)}
EVENT_LOG=${JSON.stringify(eventLogFile)}
touch "$STATE_FILE" "$EVENT_LOG"

if [ "\${1:-}" != "sandbox" ]; then
  echo "unsupported command: \${1:-}" >&2
  exit 1
fi

subcommand="\${2:-}"
shift 2 || true

case "$subcommand" in
  version)
    echo "v0.11.0"
    ;;
  ls)
    printf "SANDBOX                     AGENT   STATUS    WORKSPACE\\n"
    if [ -s "$STATE_FILE" ]; then
      while IFS='|' read -r name status workspace; do
        [ -n "$name" ] || continue
        printf "%s  codex   %s  %s\\n" "$name" "$status" "$workspace"
      done < "$STATE_FILE"
    fi
    ;;
  create)
    sandbox_name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then
        sandbox_name="$2"
        shift 2
      else
        break
      fi
    done
    agent="\${1:-}"
    workspace="\${2:-}"
    tmp_file="$STATE_FILE.tmp.$$"
    if [ -f "$STATE_FILE" ]; then
      awk -F'|' -v target="$sandbox_name" '$1 != target { print $0 }' "$STATE_FILE" > "$tmp_file"
    else
      : > "$tmp_file"
    fi
    printf "%s|running|%s\\n" "$sandbox_name" "$workspace" >> "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
    echo "create:$sandbox_name" >> "$EVENT_LOG"
    ;;
  network)
    ;;
  exec)
    sandbox_name=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --workdir)
          shift 2
          ;;
        --env)
          shift 2
          ;;
        *)
          sandbox_name="$1"
          shift
          break
          ;;
      esac
    done
    echo "exec:$sandbox_name" >> "$EVENT_LOG"
    echo "sandbox ok"
    ;;
  rm)
    for sandbox_name in "$@"; do
      echo "rm:$sandbox_name" >> "$EVENT_LOG"
      tmp_file="$STATE_FILE.tmp.$$"
      if [ -f "$STATE_FILE" ]; then
        awk -F'|' -v target="$sandbox_name" '$1 != target { print $0 }' "$STATE_FILE" > "$tmp_file"
      else
        : > "$tmp_file"
      fi
      mv "$tmp_file" "$STATE_FILE"
    done
    ;;
  stop)
    for sandbox_name in "$@"; do
      tmp_file="$STATE_FILE.tmp.$$"
      awk -F'|' -v target="$sandbox_name" 'BEGIN { OFS = "|" } { if ($1 == target) $2 = "stopped"; print $0 }' "$STATE_FILE" > "$tmp_file"
      mv "$tmp_file" "$STATE_FILE"
    done
    ;;
  *)
    echo "unsupported sandbox subcommand: $subcommand" >&2
    exit 1
    ;;
esac
`

    await writeFile(stateFile, `${staleSandboxName}|stopped|/tmp/legacy-workspace\n`, 'utf8')
    await writeFile(eventLogFile, '', 'utf8')
    await writeFile(fakeDockerPath, fakeDockerScript, 'utf8')
    await chmod(fakeDockerPath, 0o755)

    const originalPath = process.env.PATH ?? ''
    const originalSandboxCli = process.env.BATSHIT_DOCKER_SANDBOX_CLI
    process.env.PATH = `${fakeDockerDir}:${originalPath}`
    process.env.BATSHIT_DOCKER_SANDBOX_CLI = 'docker-sandbox'

    try {
      const firstResult = await nativeToolService.nativeBashExecute({
        userId: 'josh',
        sessionId,
        command: 'pwd',
        cwd: tempWorkspace,
        workspaceRoot: tempWorkspace,
        backend: 'docker_sandbox',
        accessMode: 'dangerous'
      })

      const secondResult = await nativeToolService.nativeBashExecute({
        userId: 'josh',
        sessionId,
        command: 'pwd',
        cwd: tempWorkspace,
        workspaceRoot: tempWorkspace,
        backend: 'docker_sandbox',
        accessMode: 'dangerous'
      })

      expect(firstResult.success).toBe(true)
      expect(secondResult.success).toBe(true)
      expect(typeof firstResult.sandboxName).toBe('string')
      expect(firstResult.sandboxName).toBe(secondResult.sandboxName)

      const eventsBeforeCleanup = (await readFile(eventLogFile, 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      expect(
        eventsBeforeCleanup.filter((event) => event === `create:${firstResult.sandboxName}`).length
      ).toBe(1)
      expect(
        eventsBeforeCleanup.filter((event) => event === `exec:${firstResult.sandboxName}`).length
      ).toBe(2)
      expect(eventsBeforeCleanup).not.toContain(`rm:${firstResult.sandboxName}`)

      const cleanupWarnings =
        await nativeToolService.cleanupDockerSandboxesForSession(sessionId)
      expect(cleanupWarnings).toEqual([])

      const eventsAfterCleanup = (await readFile(eventLogFile, 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      expect(eventsAfterCleanup).toContain(`rm:${firstResult.sandboxName}`)
      expect(eventsAfterCleanup).toContain(`rm:${staleSandboxName}`)

      const remainingState = (await readFile(stateFile, 'utf8')).trim()
      expect(remainingState).toBe('')
    } finally {
      process.env.PATH = originalPath
      if (originalSandboxCli === undefined) {
        delete process.env.BATSHIT_DOCKER_SANDBOX_CLI
      } else {
        process.env.BATSHIT_DOCKER_SANDBOX_CLI = originalSandboxCli
      }
      await rm(fakeDockerDir, { recursive: true, force: true })
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('prefers standalone sbx for docker sandbox execution when available', async () => {
    const fakeSbxDir = await mkdtemp(path.join(os.tmpdir(), 'batshit-fake-sbx-'))
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-sbx-workspace-'))
    const stateFile = path.join(fakeSbxDir, 'sandbox-state.txt')
    const eventLogFile = path.join(fakeSbxDir, 'sandbox-event-log.txt')
    const fakeSbxPath = path.join(fakeSbxDir, 'sbx')

    const fakeSbxScript = `#!/bin/bash
set -eu
STATE_FILE=${JSON.stringify(stateFile)}
EVENT_LOG=${JSON.stringify(eventLogFile)}
touch "$STATE_FILE" "$EVENT_LOG"

command="\${1:-}"
shift || true

case "$command" in
  version)
    echo "sbx v0.99.0"
    ;;
  ls)
    printf "SANDBOX                     AGENT   STATUS    PORTS  WORKSPACE\\n"
    if [ -s "$STATE_FILE" ]; then
      while IFS='|' read -r name status workspace; do
        [ -n "$name" ] || continue
        printf "%s  codex   %s  -  %s\\n" "$name" "$status" "$workspace"
      done < "$STATE_FILE"
    fi
    ;;
  create)
    sandbox_name=""
    while [ "$#" -gt 0 ]; do
      if [ "$1" = "--name" ]; then
        sandbox_name="$2"
        shift 2
      else
        break
      fi
    done
    agent="\${1:-}"
    workspace="\${2:-}"
    tmp_file="$STATE_FILE.tmp.$$"
    if [ -f "$STATE_FILE" ]; then
      awk -F'|' -v target="$sandbox_name" '$1 != target { print $0 }' "$STATE_FILE" > "$tmp_file"
    else
      : > "$tmp_file"
    fi
    printf "%s|running|%s\\n" "$sandbox_name" "$workspace" >> "$tmp_file"
    mv "$tmp_file" "$STATE_FILE"
    echo "create:$agent:$sandbox_name:$workspace" >> "$EVENT_LOG"
    ;;
  policy)
    if [ "\${1:-}" = "deny" ] && [ "\${2:-}" = "network" ]; then
      sandbox_name="\${3:-}"
      resource="\${4:-}"
      echo "policy-deny:$sandbox_name:$resource" >> "$EVENT_LOG"
      exit 0
    fi
    echo "unsupported policy command" >&2
    exit 1
    ;;
  exec)
    sandbox_name=""
    while [ "$#" -gt 0 ]; do
      case "$1" in
        --workdir)
          shift 2
          ;;
        --env)
          shift 2
          ;;
        *)
          sandbox_name="$1"
          shift
          break
          ;;
      esac
    done
    echo "exec:$sandbox_name" >> "$EVENT_LOG"
    echo "sbx ok"
    ;;
  rm)
    if [ "\${1:-}" = "--force" ]; then
      shift
    fi
    for sandbox_name in "$@"; do
      echo "rm:$sandbox_name" >> "$EVENT_LOG"
      tmp_file="$STATE_FILE.tmp.$$"
      if [ -f "$STATE_FILE" ]; then
        awk -F'|' -v target="$sandbox_name" '$1 != target { print $0 }' "$STATE_FILE" > "$tmp_file"
      else
        : > "$tmp_file"
      fi
      mv "$tmp_file" "$STATE_FILE"
    done
    ;;
  stop)
    for sandbox_name in "$@"; do
      echo "stop:$sandbox_name" >> "$EVENT_LOG"
    done
    ;;
  *)
    echo "unsupported sbx command: $command" >&2
    exit 1
    ;;
esac
`

    await writeFile(stateFile, '', 'utf8')
    await writeFile(eventLogFile, '', 'utf8')
    await writeFile(fakeSbxPath, fakeSbxScript, 'utf8')
    await chmod(fakeSbxPath, 0o755)

    const originalPath = process.env.PATH ?? ''
    const originalSandboxCli = process.env.BATSHIT_DOCKER_SANDBOX_CLI
    process.env.PATH = `${fakeSbxDir}:${originalPath}`
    process.env.BATSHIT_DOCKER_SANDBOX_CLI = 'sbx'

    try {
      const result = await nativeToolService.nativeBashExecute({
        userId: 'josh',
        command: 'pwd',
        cwd: tempWorkspace,
        workspaceRoot: tempWorkspace,
        backend: 'docker_sandbox',
        accessMode: 'dangerous'
      })

      expect(result.success).toBe(true)
      expect(result.stdout).toContain('sbx ok')
      expect(typeof result.sandboxName).toBe('string')

      const events = (await readFile(eventLogFile, 'utf8'))
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)

      expect(events).toContain(`create:codex:${result.sandboxName}:${result.workspaceRoot}`)
      expect(events).toContain(`policy-deny:${result.sandboxName}:**`)
      expect(events).toContain(`exec:${result.sandboxName}`)
      expect(events).toContain(`rm:${result.sandboxName}`)
    } finally {
      process.env.PATH = originalPath
      if (originalSandboxCli === undefined) {
        delete process.env.BATSHIT_DOCKER_SANDBOX_CLI
      } else {
        process.env.BATSHIT_DOCKER_SANDBOX_CLI = originalSandboxCli
      }
      await rm(fakeSbxDir, { recursive: true, force: true })
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks non-allowlisted automation commands in Agent mode', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'agent'
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { command: 'mkdir scratch' },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('POLICY_BLOCKED')
    expect(result.error?.message).toMatch(/agent mode policy/i)
  })

  it('auto-allows setup-wrapped heredoc writes in Agent mode automation dispatch', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-dispatch-agent-write-'))
    try {
      const targetFile = path.join(tempWorkspace, 'notes.txt')
      vi.mocked(redis.getProjectPreferences).mockResolvedValue({
        default_workspace_path: tempWorkspace
      } as any)
      vi.mocked(redis.get).mockResolvedValue({
        user_id: 'josh',
        provider_specific_settings: {
          nativeTools: {
            bashEnabled: true,
            executionBackend: 'local',
            bashAccessMode: 'agent'
          }
        }
      } as any)

      const command = `set -euo pipefail
mkdir -p ${tempWorkspace}
cat > ${targetFile} <<'EOF'
alpha
beta
gamma
EOF
wc -l ${targetFile}`

      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command },
        context: {
          session_id: 'session_agent_mode_write',
          agent_id: 'agent_primary',
          mode: 'mode1',
          actor_type: 'primary'
        }
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.data?.mappedToolName).toBe('batshit_server_overwrite_file')
      expect(result.data?.mappedToolInput?.filePath).toBe(targetFile)
      expect(await readFile(targetFile, 'utf8')).toBe('alpha\nbeta\ngamma\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('auto-allows setup-wrapped apply_patch edits in Agent mode automation dispatch', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-dispatch-agent-edit-'))
    try {
      const targetFile = path.join(tempWorkspace, 'NOTES.md')
      await writeFile(targetFile, 'alpha\n', 'utf8')
      vi.mocked(redis.getProjectPreferences).mockResolvedValue({
        default_workspace_path: tempWorkspace
      } as any)
      vi.mocked(redis.get).mockResolvedValue({
        user_id: 'josh',
        provider_specific_settings: {
          nativeTools: {
            bashEnabled: true,
            executionBackend: 'local',
            bashAccessMode: 'agent'
          }
        }
      } as any)

      const command = `set -euo pipefail
cd ${tempWorkspace}
apply_patch <<'PATCH'
*** Begin Patch
*** Update File: NOTES.md
@@
-alpha
+beta
*** End Patch
PATCH`

      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command },
        context: {
          session_id: 'session_agent_mode_edit',
          agent_id: 'agent_primary',
          mode: 'mode1',
          actor_type: 'primary'
        }
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.data?.mappedToolName).toBe('batshit_server_edit_file')
      expect(result.data?.managedApplyPatch?.managed).toBe(true)
      expect(await readFile(targetFile, 'utf8')).toBe('beta\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('auto-allows in-place edits even when a verification heredoc follows in Agent mode automation dispatch', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-dispatch-agent-edit-verify-'))
    try {
      const targetFile = path.join(tempWorkspace, 'notes.txt')
      await writeFile(targetFile, 'alpha\nbeta\ngamma\n', 'utf8')
      vi.mocked(redis.getProjectPreferences).mockResolvedValue({
        default_workspace_path: tempWorkspace
      } as any)
      vi.mocked(redis.get).mockResolvedValue({
        user_id: 'josh',
        provider_specific_settings: {
          nativeTools: {
            bashEnabled: true,
            executionBackend: 'local',
            bashAccessMode: 'agent'
          }
        }
      } as any)

      const command = `perl -pi -e 's/^beta$/bravo/' ${targetFile}
python3 - <<'PY'
from pathlib import Path
p=Path(${JSON.stringify(targetFile)})
print(p.read_text())
PY`

      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command },
        context: {
          session_id: 'session_agent_mode_edit_verify',
          agent_id: 'agent_primary',
          mode: 'mode1',
          actor_type: 'primary'
        }
      })

      expect(result.success).toBe(true)
      expect(result.error).toBeUndefined()
      expect(result.data?.mappedToolName).toBe('batshit_server_edit_file')
      expect(result.data?.before).toBe('alpha\nbeta\ngamma\n')
      expect(result.data?.after).toBe('alpha\nbravo\ngamma\n')
      expect(await readFile(targetFile, 'utf8')).toBe('alpha\nbravo\ngamma\n')
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('applies subagent native overrides while inheriting backend from the parent primary agent', async () => {
    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key === 'agent:agent_parent') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              bashEnabled: true,
              executionBackend: 'local',
              bashAccessMode: 'dangerous'
            }
          }
        } as any
      }

      return null as any
    })

    vi.mocked(redis.json.get).mockImplementation(async (key: string) => {
      if (key === 'subagent:agent_sub') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              bashAccessMode: 'plan',
              executionBackend: 'docker_sandbox'
            }
          }
        } as any
      }

      return null as any
    })

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { command: 'mkdir scratch' },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_sub',
        mode: 'mode1',
        actor_type: 'subagent',
        parent_agent_id: 'agent_parent'
      }
    })

    expect(result.backend).toBe('local')
    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('POLICY_BLOCKED')
    expect(result.error?.message).toMatch(/plan mode/i)
  })

  it('inherits the parent session project path for workflow-backed subagent bash execution', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-subagent-project-'))
    const resolvedWorkspace = await realpath(tempWorkspace).catch(() => tempWorkspace)

    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key === 'agent:agent_parent') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              bashEnabled: true,
              executionBackend: 'local',
              bashAccessMode: 'dangerous'
            }
          }
        } as any
      }

      return null as any
    })

    vi.mocked(redis.json.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true
        }
      }
    } as any)

    vi.mocked(redis.getSession).mockResolvedValue({
      metadata: {
        projectPath: tempWorkspace
      }
    } as any)

    try {
      const result = await nativeToolService.dispatchNativeAutomationPackAction({
        userId: 'josh',
        action: 'bash_execute',
        payloadInput: { command: 'pwd' },
        context: {
          session_id: 'session_subagent_project',
          agent_id: 'agent_sub',
          mode: 'mode3',
          actor_type: 'subagent',
          parent_agent_id: 'agent_parent'
        }
      })

      expect(result.success).toBe(true)
      expect(result.data?.cwd).toBe(resolvedWorkspace)
      expect(result.data?.workspaceRoot).toBe(resolvedWorkspace)
      expect(String(result.data?.stdout || '')).toContain(resolvedWorkspace)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('lets subagent native overrides enable agent_browser_use while inheriting backend from the parent primary agent', async () => {
    const runner = vi.fn(async ({ args }) => {
      if (Array.isArray(args) && args[0] === '--version') {
        return {
          command: 'agent-browser',
          args,
          stdout: 'agent-browser 0.3.0',
          stderr: '',
          exitCode: 0,
          signal: null,
          timedOut: false,
          durationMs: 5,
          truncated: false
        }
      }

      return {
        command: 'agent-browser',
        args,
        stdout: JSON.stringify({
          success: true,
          data: {
            title: 'Example Title'
          }
        }),
        stderr: '',
        exitCode: 0,
        signal: null,
        timedOut: false,
        durationMs: 5,
        truncated: false
      }
    })
    nativeToolService.__setAgentBrowserCliRunnerForTests(runner)
    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key === 'agent:agent_parent') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              agentBrowserEnabled: false,
              executionBackend: 'local'
            }
          }
        } as any
      }

      return null as any
    })

    vi.mocked(redis.json.get).mockImplementation(async (key: string) => {
      if (key === 'subagent:agent_sub') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              agentBrowserEnabled: true,
              agentBrowserRuntimeMode: 'chrome-cdp',
              agentBrowserCdpPort: 9444
            }
          }
        } as any
      }

      return null as any
    })

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'agent_browser_use',
      payloadInput: {
        toolName: 'get title'
      },
      context: {
        session_id: 'session_subagent_browser',
        agent_id: 'agent_sub',
        mode: 'mode3',
        actor_type: 'subagent',
        parent_agent_id: 'agent_parent'
      }
    })

    expect(result.success).toBe(true)
    expect(result.backend).toBe('local')
    expect(result.action).toBe('agent_browser_use')
    expect(result.data?.toolName).toBe('get_title')
    expect(result.data?.result?.title).toBe('Example Title')

    const executeCall = runner.mock.calls[1]?.[0]
    expect(executeCall.args).toEqual([
      '--cdp',
      'http://127.0.0.1:9444',
      '--headed',
      '--json',
      'get',
      'title'
    ])
  })

  it('dispatches artifact_find through the native automation pack for primary agents', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          artifactRuntimeEnabled: true
        }
      }
    } as any)

    const findControlsSpy = vi.spyOn(fabricRegistry, 'findControls').mockResolvedValue({
      results: [
        {
          controlId: 'use.artifact.demo_tool',
          sourceType: 'artifact',
          executorType: 'artifact_use',
          title: 'Demo Tool',
          description: 'Demo runtime tool',
          riskLevel: 'safe',
          status: 'published',
          tags: ['artifact'],
          schemaHint: 'prompt (string)'
        }
      ],
      totalMatches: 1,
      query: 'demo',
      limit: 5
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'artifact_find',
      payloadInput: {
        query: 'demo',
        includeSchema: true,
        limit: 5
      },
      context: {
        session_id: 'session_artifact_find_primary',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('artifact_find')
    expect(result.data?.totalMatches).toBe(1)
    expect(findControlsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'josh',
        agentId: 'agent_primary',
        runtimeMode: 'mode2',
        query: 'demo',
        includeSchema: true,
        limit: 5,
        allowedControlIds: expect.arrayContaining(['use.artifact.*'])
      })
    )

    findControlsSpy.mockRestore()
  })

  it('dispatches artifact_use through the native automation pack with subagent scope', async () => {
    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key === 'agent:agent_parent') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              artifactRuntimeEnabled: true,
              executionBackend: 'local'
            }
          }
        } as any
      }

      return null as any
    })

    vi.mocked(redis.json.get).mockImplementation(async (key: string) => {
      if (key === 'subagent:agent_sub') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              artifactRuntimeEnabled: true
            }
          }
        } as any
      }

      return null as any
    })

    const useControlSpy = vi.spyOn(fabricRegistry, 'useControl').mockResolvedValue({
      success: true,
      controlId: 'use.artifact.demo_tool',
      dryRun: false,
      riskLevel: 'safe',
      status: 'published',
      result: {
        ok: true
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'artifact_use',
      payloadInput: {
        control_id: 'use.artifact.demo_tool',
        prompt: 'Generate a hero image',
        zone: 'panel'
      },
      context: {
        session_id: 'session_artifact_use_subagent',
        agent_id: 'agent_sub',
        mode: 'mode3',
        actor_type: 'subagent',
        parent_agent_id: 'agent_parent'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('artifact_use')
    expect(result.data?.controlId).toBe('use.artifact.demo_tool')
    expect(useControlSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'josh',
        controlId: 'use.artifact.demo_tool',
        agentId: 'agent_sub',
        sessionId: 'session_artifact_use_subagent',
        runtimeMode: 'mode3',
        input: {
          prompt: 'Generate a hero image',
          zone: 'panel'
        },
        allowedControlIds: expect.arrayContaining(['use.artifact.*'])
      })
    )

    useControlSpy.mockRestore()
  })

  it('returns ACTION_DISABLED when artifact runtime is turned off for automation-pack requests', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          artifactRuntimeEnabled: false
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'artifact_find',
      payloadInput: {
        query: 'demo'
      },
      context: {
        session_id: 'session_artifact_disabled',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('ACTION_DISABLED')
    expect(result.error?.message).toMatch(/artifact_find/i)
  })

  it('returns ACTION_DISABLED when CLI Tools are turned off for automation-pack requests', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          cliToolsEnabled: false
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'cli_tool_find',
      payloadInput: {
        query: 'demo'
      },
      context: {
        session_id: 'session_cli_tools_disabled',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('ACTION_DISABLED')
    expect(result.error?.message).toMatch(/cli_tool_find/i)
  })

  it('dispatches batshit_tool_search through the native automation pack with typed MCP refs', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          dynamicMcpEnabled: true
        }
      }
    } as any)
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          description: 'Search sample data',
          inputSchema: {
            type: 'object',
            properties: {
              query: { type: 'string' }
            },
            required: ['query']
          },
          execute: vi.fn()
        }
      },
      metadata: new Map([
        [
          'sample_tool',
          {
            gatewayId: 'gw_ctx',
            gatewayName: 'Context Gateway',
            gatewayType: 'custom',
            mcpServerName: 'sample',
            originalToolName: 'sample_tool'
          }
        ]
      ])
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_search',
      payloadInput: {
        family: 'mcp',
        query: 'sample'
      },
      context: {
        session_id: 'session_broker_search',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('batshit_tool_search')
    expect(result.data?.operationKind).toBe('tool_find')
    expect(result.data?.results?.[0]).toMatchObject({
      ref: 'mcp:sample_tool',
      family: 'mcp',
      title: 'sample_tool'
    })
    expect(result.data?.results?.[0]?.hint).toContain('query')
  })

  it('dispatches subagent batshit_tool_search with subagent artifact visibility scope', async () => {
    vi.mocked(redis.get).mockImplementation(async (key: string) => {
      if (key === 'agent:agent_parent') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              artifactRuntimeEnabled: true
            }
          }
        } as any
      }

      return null as any
    })

    vi.mocked(redis.json.get).mockImplementation(async (key: string) => {
      if (key === 'subagent:agent_sub') {
        return {
          user_id: 'josh',
          provider_specific_settings: {
            nativeTools: {
              artifactRuntimeEnabled: true
            }
          }
        } as any
      }

      return null as any
    })

    vi.mocked(resolveDynamicMcpGatewayScope).mockResolvedValue({
      resolvedGateways: [],
      source: 'none'
    } as any)

    const findControlsSpy = vi.spyOn(fabricRegistry, 'findControls').mockResolvedValue({
      results: [
        {
          controlId: 'use.artifact.sample-run-only-artifact',
          sourceType: 'artifact',
          executorType: 'artifact_use',
          title: 'Sample Run Only Artifact',
          description: 'Invoke run-only artifact trigger.',
          riskLevel: 'safe',
          status: 'published',
          tags: ['artifact', 'run-only'],
          schemaHint: 'run-only trigger'
        }
      ],
      totalMatches: 1,
      query: 'Sample Run Only Artifact',
      limit: 5
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_search',
      payloadInput: {
        family: 'artifact',
        query: 'Sample Run Only Artifact',
        limit: 5
      },
      context: {
        session_id: 'session_broker_search_subagent',
        agent_id: 'agent_sub',
        parent_agent_id: 'agent_parent',
        mode: 'mode3',
        actor_type: 'subagent'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('batshit_tool_search')
    expect(result.data?.results?.[0]).toMatchObject({
      ref: 'artifact:use.artifact.sample-run-only-artifact',
      family: 'artifact',
      title: 'Sample Run Only Artifact'
    })
    expect(findControlsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        userId: 'josh',
        agentId: 'agent_sub',
        runtimeMode: 'mode3',
        query: 'Sample Run Only Artifact',
        allowedControlIds: expect.arrayContaining(['use.artifact.*'])
      })
    )

    findControlsSpy.mockRestore()
  })

  it('dispatches batshit_tool_use through the native automation pack with typed MCP refs', async () => {
    const executeMock = vi.fn().mockResolvedValue({ ok: true })
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          dynamicMcpEnabled: true
        }
      }
    } as any)
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        sample_tool: {
          execute: executeMock
        }
      },
      metadata: new Map()
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_use',
      payloadInput: {
        ref: 'mcp:sample_tool',
        input: {
          query: 'hello'
        }
      },
      context: {
        session_id: 'session_broker_use',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('batshit_tool_use')
    expect(executeMock).toHaveBeenCalledWith({ query: 'hello' })
    expect(result.data).toMatchObject({
      success: true,
      ref: 'mcp:sample_tool',
      family: 'mcp',
      target: 'sample_tool',
      operationKind: 'dynamic_use'
    })
  })

  it('passes the scoped callback project path into n8n brokered MCP search and use', async () => {
    const executeMock = vi.fn().mockResolvedValue({ ok: true })
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          dynamicMcpEnabled: true
        }
      }
    } as any)
    vi.mocked(redis.getSession).mockResolvedValue({
      metadata: {
        projectPath: '/Users/example/hello'
      }
    } as any)
    vi.mocked(mcpGatewayDiscovery.loadToolsForUser).mockResolvedValue({
      tools: {
        read_text_file: {
          execute: executeMock
        }
      },
      metadata: new Map()
    } as any)

    const searchResult = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_search',
      payloadInput: {
        family: 'mcp',
        query: 'read text file'
      },
      context: {
        session_id: 'session_project_mcp',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      },
      projectPath: '/Users/example/batshit'
    })

    expect(searchResult.success).toBe(true)
    expect(mcpGatewayDiscovery.loadToolsForUser).toHaveBeenLastCalledWith(
      'josh',
      [],
      undefined,
      {
        skipFiltering: true,
        projectPath: '/Users/example/batshit'
      }
    )

    const useResult = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_use',
      payloadInput: {
        ref: 'mcp:read_text_file',
        input: {
          path: '/Users/example/batshit/README.md'
        }
      },
      context: {
        session_id: 'session_project_mcp',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      },
      projectPath: '/Users/example/batshit'
    })

    expect(useResult.success).toBe(true)
    expect(executeMock).toHaveBeenCalledWith({
      path: '/Users/example/batshit/README.md'
    })
    expect(mcpGatewayDiscovery.loadToolsForUser).toHaveBeenLastCalledWith(
      'josh',
      [],
      undefined,
      {
        skipFiltering: true,
        projectPath: '/Users/example/batshit'
      }
    )
  })

  it('rejects direct dynamic_mcp actions in the n8n automation pack', async () => {
    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'dynamic_mcp_find',
      payloadInput: {
        query: 'filesystem'
      },
      context: {
        session_id: 'session_direct_dynamic_rejected',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('INVALID_ACTION')
    expect(result.error?.message).not.toContain('dynamic_mcp_find')
    expect(result.error?.message).toContain('batshit_tool_search')
    expect(result.error?.message).toContain('batshit_tool_use')
  })

  it('blocks broad Fabric refs through the n8n native automation broker', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          batshitToolsEnabled: true
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'batshit_tool_use',
      payloadInput: {
        ref: 'fabric:sys.artifact.list',
        input: {}
      },
      context: {
        session_id: 'session_broker_fabric_blocked',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.action).toBe('batshit_tool_use')
    expect(result.error?.message).toMatch(/Fabric tools are not enabled/i)
    expect(result.error?.details).toMatchObject({
      ref: 'fabric:sys.artifact.list',
      family: 'fabric',
      target: 'sys.artifact.list'
    })
  })

  it('dispatches runtime_addon_prepare through the native automation pack without broad Fabric', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          batshitToolsEnabled: true
        }
      }
    } as any)

    const prepareSpy = vi.spyOn(runtimeAddons, 'prepareRuntimeAddon').mockResolvedValue({
      id: 'fbx2vrma',
      title: 'FBX-to-VRMA Worker',
      route: 'sidecar/profile',
      state: 'waiting',
      running: false,
      supported: false,
      dockerUnsupported: true,
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker',
      nextSteps: ['Run the approved Compose command, then re-check status.']
    } as any)
    const useControlSpy = vi.spyOn(fabricRegistry, 'useControl')

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'runtime_addon_prepare',
      payloadInput: {
        addon_id: 'fbx2vrma'
      },
      context: {
        session_id: 'session_runtime_addon_prepare',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('runtime_addon_prepare')
    expect(result.data?.addon).toMatchObject({
      id: 'fbx2vrma',
      canStartAutomatically: false,
      requiresOperator: true
    })
    expect(prepareSpy).toHaveBeenCalledWith('fbx2vrma')
    expect(useControlSpy).not.toHaveBeenCalled()

    prepareSpy.mockRestore()
    useControlSpy.mockRestore()
  })

  it('dispatches runtime_addon_start through the native automation pack via the operator bridge', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          batshitToolsEnabled: true
        }
      }
    } as any)

    const controlSpy = vi.spyOn(runtimeAddons, 'controlRuntimeAddon').mockResolvedValue({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma',
      alreadySatisfied: false,
      operator: {
        configured: true,
        available: true,
        url: 'http://127.0.0.1:5629',
        reason: null,
        checkedAt: '2026-05-24T00:00:00.000Z',
        controls: ['start', 'stop']
      },
      before: {
        id: 'fbx2vrma',
        running: false
      },
      after: {
        id: 'fbx2vrma',
        running: true
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'runtime_addon_start',
      payloadInput: {
        addon_id: 'fbx2vrma'
      },
      context: {
        session_id: 'session_runtime_addon_start',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(true)
    expect(result.action).toBe('runtime_addon_start')
    expect(result.data?.addon).toMatchObject({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma'
    })
    expect(controlSpy).toHaveBeenCalledWith('fbx2vrma', 'start')

    controlSpy.mockRestore()
  })

  it('maps runtime_addon_start operator failures to BACKEND_UNAVAILABLE', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          batshitToolsEnabled: true
        }
      }
    } as any)

    const controlSpy = vi.spyOn(runtimeAddons, 'controlRuntimeAddon').mockResolvedValue({
      success: false,
      operation: 'start',
      addonId: 'cloudflared',
      alreadySatisfied: false,
      error: 'Runtime add-on operator is not configured.',
      operator: {
        configured: false,
        available: false,
        url: null,
        reason: 'Runtime add-on operator is not configured.',
        checkedAt: '2026-05-24T00:00:00.000Z',
        controls: []
      },
      before: {
        id: 'cloudflared',
        running: false
      },
      after: null
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'runtime_addon_start',
      payloadInput: {
        addonId: 'cloudflared'
      },
      context: {
        session_id: 'session_runtime_addon_start_failure',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('BACKEND_UNAVAILABLE')
    expect(result.error?.message).toMatch(/operator is not configured/i)

    controlSpy.mockRestore()
  })

  it('returns ACTION_DISABLED for runtime_addon_prepare when Batshit tools are turned off', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          batshitToolsEnabled: false
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'runtime_addon_prepare',
      payloadInput: {
        addonId: 'cloudflared'
      },
      context: {
        session_id: 'session_runtime_addon_disabled',
        agent_id: 'agent_primary',
        mode: 'mode2',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('ACTION_DISABLED')
    expect(result.error?.message).toMatch(/runtime_addon_prepare/i)
  })

  it('can expose artifact runtime tools without broad Fabric control tools', async () => {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_subagent_api_artifacts',
      agentId: 'agent_sub_api',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          artifactRuntimeEnabled: true,
          batshitToolsEnabled: true,
          dynamicMcpEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      allowArtifactRuntimeTools: true,
      allowFabricControlTools: false,
      toolApprovalMode: 'none'
    } as any)

    expect((tools as any).native_batshit_tool_search).toBeTruthy()
    expect((tools as any).native_batshit_tool_use).toBeTruthy()
    expect((tools as any).native_artifact_find).toBeUndefined()
    expect((tools as any).native_artifact_use).toBeUndefined()
    expect((tools as any).native_fabric_find).toBeUndefined()
    expect((tools as any).native_fabric_use).toBeUndefined()
  })

  it('keeps dangerous bash hard-deny rules even when automation allow-list matches', async () => {
    vi.mocked(redis.get).mockResolvedValue({
      user_id: 'josh',
      provider_specific_settings: {
        nativeTools: {
          bashEnabled: true,
          executionBackend: 'local',
          automationBashAllowList: ['re:^\\s*rm\\b']
        }
      }
    } as any)

    const result = await nativeToolService.dispatchNativeAutomationPackAction({
      userId: 'josh',
      action: 'bash_execute',
      payloadInput: { command: 'rm -rf /' },
      context: {
        session_id: 'session_demo',
        agent_id: 'agent_primary',
        mode: 'mode1',
        actor_type: 'primary'
      }
    })

    expect(result.success).toBe(false)
    expect(result.error?.code).toBe('POLICY_BLOCKED')
    expect(result.error?.message).toMatch(/Destructive root deletion is blocked/i)
  })

  it('uses native_skill action=invoke instead of exposing legacy invoke_skill', async () => {
    vi.mocked(executeSkillRuntimeAction).mockResolvedValue({
      success: true,
      action: 'invoke',
      skill: {
        id: 'skill-alpha',
        name: 'skill-alpha',
        displayName: 'Skill Alpha',
        references: ['references/guide.md'],
        scripts: ['scripts/run.sh']
      },
      skillMarkdown: '# Skill Alpha',
      warnings: []
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_skill',
      agentId: 'agent_main',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)

    expect((tools as any).invoke_skill).toBeUndefined()
    const invokeTool = (tools as any).native_skill
    expect(invokeTool).toBeTruthy()

    const invokeResult = await invokeTool.execute({
      skillId: 'skill-alpha',
      action: 'invoke'
    })

    expect(invokeResult.success).toBe(true)
    expect(invokeResult.skill.references).toEqual(['references/guide.md'])
    expect(invokeResult.skill.scripts).toEqual(['scripts/run.sh'])
    expect(invokeResult.skillMarkdown).toContain('# Skill Alpha')
    expect(executeSkillRuntimeAction).toHaveBeenCalledWith({
      userId: 'josh',
      skillId: 'skill-alpha',
      action: 'invoke',
      path: undefined,
      maxChars: undefined
    })

    const modelOutput = await invokeTool.toModelOutput({
      toolCallId: 'tool_call_skill',
      input: { skillId: 'skill-alpha', action: 'invoke' },
      output: invokeResult
    })
    expect(modelOutput?.type).toBe('text')
    expect(String(modelOutput?.value || '')).toContain('SKILL')
    expect(String(modelOutput?.value || '')).toContain('native_skill')
  })

  it('supports on-demand skill reference listing and reads by skillId', async () => {
    vi.mocked(resolveSkillRuntimeForTool).mockResolvedValue({
      runtime: {
        skill: {
          id: 'skill-alpha',
          name: 'skill-alpha',
          displayName: 'Skill Alpha'
        },
        cacheDir: '/tmp/skill-alpha',
        bundleFiles: [
          {
            path: 'references/guide.md',
            kind: 'reference',
            encoding: 'utf8',
            content: 'Guide text',
            sha256: 'abc',
            size: 10
          }
        ]
      },
      error: null
    } as any)
    vi.mocked(readSkillBundleFileText).mockReturnValue({
      content: 'Guide text',
      truncated: false,
      originalChars: 10
    })
    vi.mocked(executeSkillRuntimeAction).mockImplementation(async (input: any) => {
      const runtimeResult = await resolveSkillRuntimeForTool('josh', input.skillId)
      if (!runtimeResult.runtime) {
        return {
          success: false,
          action: input.action ?? 'list',
          error: runtimeResult.error
        }
      }

      const references = runtimeResult.runtime.bundleFiles.filter((file: any) => file.kind === 'reference')
      if ((input.action ?? 'list') === 'list') {
        return {
          success: true,
          action: 'list',
          skillId: runtimeResult.runtime.skill.id,
          skillName: runtimeResult.runtime.skill.displayName,
          totalReferences: references.length,
          references: references.map((file: any) => file.path)
        }
      }

      const file = findBundleFileByPath(references as any, input.path)
      if (!file) {
        return {
          success: false,
          action: 'read',
          error: 'Reference not found.'
        }
      }

      const decoded = readSkillBundleFileText(file as any, input.maxChars)
      return {
        success: true,
        action: 'read',
        skillId: runtimeResult.runtime.skill.id,
        skillName: runtimeResult.runtime.skill.displayName,
        path: file.path,
        content: decoded.content,
        contentTruncated: decoded.truncated,
        originalChars: decoded.originalChars,
        returnedChars: decoded.content.length
      }
    })

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_skill',
      agentId: 'agent_main',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)

    const referenceTool = (tools as any).native_skill
    expect(referenceTool).toBeTruthy()

    const listResult = await referenceTool.execute({ skillId: 'skill-alpha', action: 'list' })
    expect(listResult.success).toBe(true)
    expect(listResult.references).toEqual(['references/guide.md'])

    const readResult = await referenceTool.execute({
      skillId: 'skill-alpha',
      action: 'read',
      path: 'references/guide.md'
    })
    expect(readResult.success).toBe(true)
    expect(readResult.content).toBe('Guide text')
    expect(findBundleFileByPath).toHaveBeenCalled()

    const modelOutput = await referenceTool.toModelOutput({
      toolCallId: 'tool_call_ref',
      input: { skillId: 'skill-alpha', action: 'read', path: 'references/guide.md' },
      output: readResult
    })
    expect(modelOutput?.type).toBe('text')
    expect(String(modelOutput?.value || '')).toContain('SKILL REFERENCE')
  })

  it('mediates skill script run through native bash policy path', async () => {
    vi.mocked(resolveSkillRuntimeForTool).mockResolvedValue({
      runtime: {
        skill: {
          id: 'skill-alpha',
          name: 'skill-alpha',
          displayName: 'Skill Alpha'
        },
        cacheDir: '/tmp/skill-alpha',
        bundleFiles: [
          {
            path: 'scripts/run.sh',
            kind: 'script',
            encoding: 'utf8',
            content: 'echo hi',
            sha256: 'abc',
            size: 7
          }
        ]
      },
      error: null
    } as any)
    vi.mocked(resolveBundleFileAbsolutePath).mockReturnValue('/tmp/skill-alpha/scripts/run.sh')
    vi.mocked(buildSkillScriptCommand).mockReturnValue("printf 'skill-script-ok'")

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_skill',
      agentId: 'agent_main',
      projectPath: process.cwd(),
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: true,
          executionBackend: 'local',
          bashAccessMode: 'dangerous'
        }
      },
      toolApprovalMode: 'none'
    } as any)

    expect((tools as any).native_skill_script).toBeUndefined()
    const scriptTool = (tools as any).native_skill
    expect(scriptTool).toBeTruthy()

    const runResult = await scriptTool.execute({
      skillId: 'skill-alpha',
      action: 'script_run',
      path: 'scripts/run.sh',
      args: ['--demo']
    })

    expect(runResult.success).toBe(true)
    expect(buildSkillScriptCommand).toHaveBeenCalledWith('/tmp/skill-alpha/scripts/run.sh', ['--demo'])
    expect(runResult.execution?.stdout).toContain('skill-script-ok')
  })

  it('blocks skill script run when native bash is disabled', async () => {
    vi.mocked(resolveSkillRuntimeForTool).mockResolvedValue({
      runtime: {
        skill: {
          id: 'skill-alpha',
          name: 'skill-alpha',
          displayName: 'Skill Alpha'
        },
        cacheDir: '/tmp/skill-alpha',
        bundleFiles: [
          {
            path: 'scripts/run.sh',
            kind: 'script',
            encoding: 'utf8',
            content: 'echo hi',
            sha256: 'abc',
            size: 7
          }
        ]
      },
      error: null
    } as any)

    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_skill',
      agentId: 'agent_main',
      providerSettings: {
        nativeTools: {
          fetchZipEnabled: false,
          dynamicMcpEnabled: false,
          batshitToolsEnabled: false,
          webSearchEnabled: false,
          bashEnabled: false
        }
      },
      toolApprovalMode: 'none'
    } as any)

    expect((tools as any).native_skill_script).toBeUndefined()
    const scriptTool = (tools as any).native_skill
    const runResult = await scriptTool.execute({
      skillId: 'skill-alpha',
      action: 'script_run',
      path: 'scripts/run.sh'
    })

    expect(runResult.success).toBe(false)
    expect(runResult.blocked).toBe(true)
    expect(String(runResult.error || '')).toMatch(/native_bash_execute is disabled/i)
    expect(buildSkillScriptCommand).not.toHaveBeenCalled()
  })

  // ---------------------------------------------------------------------
  // SA-105 P2 — in-turn delivery of recalled memory images
  // ---------------------------------------------------------------------
  describe('SA-105 P2 recall media delivery', () => {
    const PNG_BYTES = Buffer.from('iVBORw0KGgo=', 'base64')

    function recallOutput(media: Array<Record<string, any>>, memoryId = 'mem_maggie') {
      return {
        success: true,
        controlId: 'sys.memory.recall',
        target: 'sys.memory.recall',
        ref: 'fabric:sys.memory.recall',
        family: 'fabric',
        result: {
          recalled: [
            {
              id: memoryId,
              lane: 'ltm',
              gist: 'Maggie the dog',
              content: 'Maggie is my dog.',
              ...(media.length ? { media } : {})
            }
          ],
          note: 'Full content above.'
        }
      }
    }

    const oneImage = [
      { media_id: 'md_1', filename: 'maggie.png', mime_type: 'image/png', bytes: 1024 }
    ]

    async function brokerUseWith(imageDelivery: any, ephemeralImages?: any) {
      const { tools } = await nativeToolService.buildMode3NativeTools({
        userId: 'josh',
        agentId: 'agent_1',
        projectPath: process.cwd(),
        imageDelivery,
        ephemeralImages,
        memoryControlsEnabled: true,
        providerSettings: { nativeTools: { fabricEnabled: true } },
        toolApprovalMode: 'none'
      } as any)
      return (tools as any).native_batshit_tool_use
    }

    beforeEach(() => {
      memoryMediaMocks.loadMemoryMedia.mockReset()
      memoryMediaMocks.loadMemoryMedia.mockResolvedValue({
        media: { id: 'md_1', mime_type: 'image/png' },
        bytes: PNG_BYTES,
        dataUrl: `data:image/png;base64,${PNG_BYTES.toString('base64')}`,
        url: '/uploads/memory-media/agent_1/mem_maggie/md_1.png'
      })
    })

    it('attaches the recalled image to the same tool result on a tool_result lane', async () => {
      const brokerUse = await brokerUseWith({ lane: 'tool_result', reason: 'test' })
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_1',
        output: recallOutput(oneImage)
      })

      expect(modelOutput.type).toBe('content')
      const file = modelOutput.value.find((p: any) => p.type === 'file')
      expect(file?.mediaType).toBe('image/png')
      expect(file?.data?.type).toBe('data')
      expect(file?.data?.data).toBe(PNG_BYTES.toString('base64'))

      // The note the model reads must match what it actually received.
      const text = modelOutput.value.find((p: any) => p.type === 'text')?.text ?? ''
      expect(text).toContain('available during THIS reply')
      expect(text).not.toContain('arrives in your REMEMBERED MEDIA')
      expect(text).toContain('"delivery": "in_turn"')
    })

    it('hands images to the synthetic registry, not the tool result, on a text-only lane', async () => {
      const registry = createEphemeralImageRegistry()
      const brokerUse = await brokerUseWith(
        { lane: 'synthetic_user', reason: 'test' },
        registry
      )
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_2',
        output: recallOutput(oneImage)
      })

      // A content output here would be JSON.stringify'd into base64 text.
      expect(modelOutput.type).toBe('text')
      expect(String(modelOutput.value)).not.toContain(PNG_BYTES.toString('base64'))

      const taken = registry.take('call_2')
      expect(taken?.source).toBe('sys.memory.recall')
      expect(taken?.images).toHaveLength(1)
      expect(taken?.images[0]?.data).toBe(PNG_BYTES.toString('base64'))
      // take() clears, so a delivery can only be injected once.
      expect(registry.take('call_2')).toBeUndefined()
    })

    it('defers to the next message when the model cannot take images at all', async () => {
      const brokerUse = await brokerUseWith({ lane: 'none', reason: 'model_capabilities_vision_false' })
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_3',
        output: recallOutput(oneImage)
      })

      expect(modelOutput.type).toBe('text')
      expect(String(modelOutput.value)).toContain('REMEMBERED MEDIA')
      expect(String(modelOutput.value)).toContain('"delivery": "next_message"')
      expect(String(modelOutput.value)).toContain('lane_none')
      expect(memoryMediaMocks.loadMemoryMedia).not.toHaveBeenCalled()
    })

    it('caps in-turn images at four and explains the overflow', async () => {
      const six = Array.from({ length: 6 }, (_, i) => ({
        media_id: `md_${i}`,
        filename: `img_${i}.png`,
        mime_type: 'image/png',
        bytes: 10
      }))
      const brokerUse = await brokerUseWith({ lane: 'tool_result', reason: 'test' })
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_4',
        output: recallOutput(six)
      })

      expect(modelOutput.value.filter((p: any) => p.type === 'file')).toHaveLength(4)
      const text = modelOutput.value.find((p: any) => p.type === 'text')?.text ?? ''
      expect(text).toContain('over_count')
    })

    it('defers an unsupported image type instead of sending it', async () => {
      const brokerUse = await brokerUseWith({ lane: 'tool_result', reason: 'test' })
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_5',
        output: recallOutput([
          { media_id: 'md_svg', filename: 'a.svg', mime_type: 'image/svg+xml', bytes: 10 }
        ])
      })

      expect(modelOutput.type).toBe('text')
      expect(String(modelOutput.value)).toContain('unsupported_mime')
    })

    it('degrades to a next-message note when the image can no longer be loaded', async () => {
      // A memory deleted between execute and render must not fail the send.
      memoryMediaMocks.loadMemoryMedia.mockRejectedValue(new Error('gone'))
      const brokerUse = await brokerUseWith({ lane: 'tool_result', reason: 'test' })
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_6',
        output: recallOutput(oneImage)
      })

      expect(modelOutput.type).toBe('text')
      expect(String(modelOutput.value)).toContain('source_unavailable')
    })

    it('DL-105-13 parity: a recall with no media is untouched on every lane', async () => {
      const plain = recallOutput([])
      const before = JSON.stringify(plain)

      for (const lane of ['tool_result', 'synthetic_user', 'none'] as const) {
        const brokerUse = await brokerUseWith({ lane, reason: 'test' })
        const modelOutput = await brokerUse.toModelOutput({ toolCallId: 'c', output: plain })
        expect(modelOutput.type).toBe('text')
        expect(String(modelOutput.value)).not.toContain('media_note')
        expect(String(modelOutput.value)).not.toContain('recallMedia')
      }
      // The output object itself is never mutated.
      expect(JSON.stringify(plain)).toBe(before)
    })

    it('AMD-105-14 guard: the plan stays nested and byte-free at the top level', async () => {
      const brokerUse = await brokerUseWith({ lane: 'tool_result', reason: 'test' })
      const modelOutput = await brokerUse.toModelOutput({
        toolCallId: 'call_7',
        output: recallOutput(oneImage)
      })
      const text = modelOutput.value.find((p: any) => p.type === 'text')?.text ?? ''
      const json = JSON.parse(text.slice(text.indexOf('{')))

      // send-routed's looksLikeImagePayload sniffs these top-level keys; any of
      // them would route a recall through the image-zip path by mistake.
      for (const key of ['data', 'image', 'images', 'base64', 'b64_json']) {
        expect(json).not.toHaveProperty(key)
      }
      expect(json.result.recalled[0].media[0]).toHaveProperty('media_id')
      // Byte-free: the EV record names the image, it does not carry it.
      expect(json.recallMedia.inTurn[0]).toEqual({
        memoryId: 'mem_maggie',
        mediaId: 'md_1',
        filename: 'maggie.png',
        bytes: 1024
      })
      expect(JSON.stringify(json)).not.toContain(PNG_BYTES.toString('base64'))
    })
  })

})

describe('protected Batshit repo write guardrail', () => {
  async function findRepoRoot(): Promise<string> {
    let current = process.cwd()
    while (true) {
      try {
        await stat(path.join(current, 'batshit-app'))
        await stat(path.join(current, 'batshit-server'))
        return current
      } catch {
        const parent = path.dirname(current)
        if (parent === current) throw new Error('Batshit repo root not found from test cwd')
        current = parent
      }
    }
  }

  it('blocks sed -i edits into Batshit repo files from an outside workspace (all modes incl. dangerous)', async () => {
    const repoRoot = await findRepoRoot()
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-protected-repo-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: `sed -i '' 's/a/b/' ${repoRoot}/batshit-app/__guardrail_test_nonexistent__.ts`,
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local',
        requireApproval: false
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/read-only from in-app agents/i)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('blocks tee writes into Batshit repo files (previously unmapped write shape)', async () => {
    const repoRoot = await findRepoRoot()
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-protected-repo-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: `echo hi | tee ${repoRoot}/batshit-app/__guardrail_test_nonexistent__.txt`,
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local',
        requireApproval: false
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/read-only from in-app agents/i)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('still allows read-only commands that reference Batshit repo paths', async () => {
    const repoRoot = await findRepoRoot()
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-protected-repo-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: `ls ${repoRoot}/batshit-app`,
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local',
        requireApproval: false
      })

      expect(result.success).toBe(true)
      expect(result.blocked).toBe(false)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('allows writes into the gitignored _local area of the repo', async () => {
    const repoRoot = await findRepoRoot()
    const guardTestDir = path.join(repoRoot, '_local', '.guardrail-test-tmp')
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: `mkdir -p ${guardTestDir}`,
        workspaceRoot: repoRoot,
        cwd: repoRoot,
        accessMode: 'dangerous',
        backend: 'local',
        requireApproval: false
      })

      expect(result.success).toBe(true)
      expect(result.blocked).toBe(false)
    } finally {
      await rm(guardTestDir, { recursive: true, force: true })
    }
  })

  it('blocks apply_patch into repo files when the workspace is the repo itself', async () => {
    const repoRoot = await findRepoRoot()
    const result = await nativeToolService.nativeBashExecute({
      command: [
        "apply_patch <<'EOF'",
        '*** Begin Patch',
        '*** Update File: batshit-app/package.json',
        '@@',
        '-x',
        '+y',
        '*** End Patch',
        'EOF'
      ].join('\n'),
      workspaceRoot: repoRoot,
      cwd: repoRoot,
      accessMode: 'dangerous',
      backend: 'local',
      requireApproval: false
    })

    expect(result.success).toBe(false)
    expect(result.blocked).toBe(true)
    expect(String(result.reason || '')).toMatch(/read-only from in-app agents/i)
  })

  it('blocks oversized plain commands with an instructive message', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-length-cap-'))
    try {
      const result = await nativeToolService.nativeBashExecute({
        command: `echo ${'a'.repeat(4_100)}`,
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local',
        requireApproval: false
      })

      expect(result.success).toBe(false)
      expect(result.blocked).toBe(true)
      expect(String(result.reason || '')).toMatch(/limit 4000/)
      expect(String(result.reason || '')).toMatch(/apply_patch/)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })

  it('allows managed apply_patch commands above 4k chars and ignores shell-dangerous text inside the payload', async () => {
    const tempWorkspace = await mkdtemp(path.join(os.tmpdir(), 'batshit-length-cap-'))
    try {
      const contentLines = Array.from({ length: 200 }, (_, index) =>
        `+line ${index} ${'x'.repeat(30)}`
      )
      contentLines.push('+notes: sudo reboot is mentioned here as plain text')
      const result = await nativeToolService.nativeBashExecute({
        command: [
          "apply_patch <<'EOF'",
          '*** Begin Patch',
          '*** Add File: big-managed-patch.txt',
          ...contentLines,
          '*** End Patch',
          'EOF'
        ].join('\n'),
        workspaceRoot: tempWorkspace,
        cwd: tempWorkspace,
        accessMode: 'dangerous',
        backend: 'local',
        requireApproval: false
      })

      expect(result.success).toBe(true)
      expect(result.blocked).toBe(false)
      const written = await readFile(path.join(tempWorkspace, 'big-managed-patch.txt'), 'utf8')
      expect(written).toContain('sudo reboot is mentioned here as plain text')
      expect(written.length).toBeGreaterThan(4_000)
    } finally {
      await rm(tempWorkspace, { recursive: true, force: true })
    }
  })
})

describe('SA-096 P5 — broker registration pins the documented availability rules', () => {
  // The compiled system prompt gates its broker guidance on isBrokerAvailable(). Both the
  // gate and the registration sites derive families from $lib/utils/brokerAvailability, so
  // comparing them to each other proves nothing. These cases instead restate the intended
  // condition independently and walk the whole toggle matrix through the REAL registration
  // path — a change to either side that is not also a deliberate contract change fails here.
  const BROKER_TOGGLE_KEYS = [
    'dynamicMcpEnabled',
    'cliToolsEnabled',
    'artifactRuntimeEnabled',
    'batshitToolsEnabled',
    'fetchZipEnabled'
  ] as const

  type ToggleCase = Record<string, boolean>

  const buildCases = (): ToggleCase[] => {
    const cases: ToggleCase[] = []
    for (let mask = 0; mask < 1 << BROKER_TOGGLE_KEYS.length; mask += 1) {
      const settings: ToggleCase = {
        webSearchEnabled: false,
        bashEnabled: false,
        agentBrowserEnabled: false
      }
      BROKER_TOGGLE_KEYS.forEach((key, index) => {
        settings[key] = Boolean(mask & (1 << index))
      })
      cases.push(settings)
    }
    return cases
  }

  it.each([false, true])(
    'registers the mode 3 broker exactly when a family is reachable (allowFabricControlTools=%s)',
    async (allowFabricControlTools) => {
      const cases = buildCases()
      expect(cases).toHaveLength(32)
      const registrations: boolean[] = []

      for (const nativeTools of cases) {
        const { tools } = await nativeToolService.buildMode3NativeTools({
          userId: 'josh',
          sessionId: 'session_sa096_p5',
          providerSettings: { nativeTools },
          selectedCliToolIds: [],
          allowArtifactRuntimeTools: true,
          allowFabricControlTools
        } as any)

        const registered = Boolean((tools as any).native_batshit_tool_search)
        registrations.push(registered)

        // Independent restatement of buildMode3NativeTools' documented condition. Agent
        // Browser is deliberately absent: it is a separate native tool on this lane, and
        // selectedCliToolIds is empty so the cli family can never open here.
        const expected =
          nativeTools.dynamicMcpEnabled ||
          nativeTools.artifactRuntimeEnabled ||
          nativeTools.fetchZipEnabled ||
          (nativeTools.batshitToolsEnabled && allowFabricControlTools)

        expect({ nativeTools, registered }).toEqual({ nativeTools, registered: expected })
        expect(Boolean((tools as any).native_batshit_tool_use)).toBe(expected)
      }

      // Guards against a matrix that silently collapses to one answer.
      expect(registrations).toContain(true)
      expect(registrations).toContain(false)
    }
  )

  it('registers the mode 3 cli family only when a CLI Tool is actually selected', async () => {
    const providerSettings = {
      nativeTools: {
        dynamicMcpEnabled: false,
        cliToolsEnabled: true,
        artifactRuntimeEnabled: false,
        batshitToolsEnabled: false,
        fetchZipEnabled: false,
        agentBrowserEnabled: false,
        webSearchEnabled: false,
        bashEnabled: false
      }
    }

    const withoutSelection = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_sa096_p5_cli_empty',
      providerSettings,
      selectedCliToolIds: []
    } as any)
    expect((withoutSelection.tools as any).native_batshit_tool_search).toBeUndefined()

    const withSelection = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_sa096_p5_cli_selected',
      providerSettings,
      selectedCliToolIds: ['cli_tool_alpha']
    } as any)
    expect((withSelection.tools as any).native_batshit_tool_search).toBeTruthy()
  })

  it('exposes the mode 4 broker helpers exactly when a family is reachable', () => {
    const registrations: boolean[] = []

    for (const settings of buildCases()) {
      for (const agentBrowserEnabled of [false, true]) {
        for (const hasCliTools of [false, true]) {
          const input = { ...settings, agentBrowserEnabled }
          const registered = resolveEnabledMode4InternalHelperTools(input, {
            hasCliTools
          }).includes('batshit_tool_search')
          registrations.push(registered)

          // Independent restatement of the managed-CLI condition. Fetch-zip is deliberately
          // absent: it ships as its own helper (batshit_server_fetch_zip) on this lane.
          const expected =
            input.dynamicMcpEnabled ||
            (input.cliToolsEnabled && hasCliTools) ||
            input.agentBrowserEnabled ||
            input.artifactRuntimeEnabled ||
            input.batshitToolsEnabled

          expect({ input, hasCliTools, registered }).toEqual({
            input,
            hasCliTools,
            registered: expected
          })
        }
      }
    }

    expect(registrations).toContain(true)
    expect(registrations).toContain(false)
  })

  // SA-096 P4 — the Fabric control-id scope the broker will serve.
  //
  // The DCM capability index states a Fabric count, so that count has to be the set
  // registration actually opens. Probing through native_batshit_tool_use's OUT_OF_SCOPE
  // response pins the real registered allowlist rather than re-calling the shared helper,
  // which is the mistake the P5 pins already had to be rewritten to avoid.
  async function probeFabricRef(
    nativeTools: Record<string, boolean>,
    ref: string,
    allowFabricControlTools = true
  ): Promise<string | undefined> {
    const { tools } = await nativeToolService.buildMode3NativeTools({
      userId: 'josh',
      sessionId: 'session_sa096_p4_fabric_scope',
      providerSettings: { nativeTools },
      selectedCliToolIds: [],
      allowArtifactRuntimeTools: true,
      allowFabricControlTools
    } as any)

    const result = await (tools as any).native_batshit_tool_use.execute({ ref, input: {} })
    return result?.code
  }

  const FABRIC_ONLY_FETCH_ZIP = {
    dynamicMcpEnabled: false,
    cliToolsEnabled: false,
    artifactRuntimeEnabled: false,
    batshitToolsEnabled: false,
    fetchZipEnabled: true,
    agentBrowserEnabled: false,
    webSearchEnabled: false,
    bashEnabled: false
  }

  it('opens only fetch-zip on the Fabric lane when Batshit Tools is off', async () => {
    await expect(probeFabricRef(FABRIC_ONLY_FETCH_ZIP, 'fabric:sys.zip.fetch')).resolves.not.toBe(
      'OUT_OF_SCOPE'
    )
    await expect(
      probeFabricRef(FABRIC_ONLY_FETCH_ZIP, 'fabric:sys.artifact.update')
    ).resolves.toBe('OUT_OF_SCOPE')
    await expect(
      probeFabricRef(FABRIC_ONLY_FETCH_ZIP, 'fabric:sys.voice.engine.enable')
    ).resolves.toBe('OUT_OF_SCOPE')
  })

  it('opens the Batshit Tools control scope when that toggle is on', async () => {
    const withBatshitTools = { ...FABRIC_ONLY_FETCH_ZIP, batshitToolsEnabled: true }
    await expect(
      probeFabricRef(withBatshitTools, 'fabric:sys.artifact.update')
    ).resolves.not.toBe('OUT_OF_SCOPE')
    await expect(
      probeFabricRef(withBatshitTools, 'fabric:sys.voice.engine.enable')
    ).resolves.not.toBe('OUT_OF_SCOPE')
  })

  it('closes the Fabric control plane for an actor that may not use it, keeping fetch-zip', async () => {
    const withBatshitTools = { ...FABRIC_ONLY_FETCH_ZIP, batshitToolsEnabled: true }
    await expect(
      probeFabricRef(withBatshitTools, 'fabric:sys.artifact.update', false)
    ).resolves.toBe('OUT_OF_SCOPE')
    await expect(
      probeFabricRef(withBatshitTools, 'fabric:sys.zip.fetch', false)
    ).resolves.not.toBe('OUT_OF_SCOPE')
  })

  it('opens the Dynamic MCP Fabric pair only when Dynamic MCP is on', async () => {
    const withBatshitTools = { ...FABRIC_ONLY_FETCH_ZIP, batshitToolsEnabled: true }
    await expect(
      probeFabricRef(withBatshitTools, 'fabric:sys.mcp.dynamic.find')
    ).resolves.toBe('OUT_OF_SCOPE')
    await expect(
      probeFabricRef(
        { ...withBatshitTools, dynamicMcpEnabled: true },
        'fabric:sys.mcp.dynamic.find'
      )
    ).resolves.not.toBe('OUT_OF_SCOPE')
  })


})
