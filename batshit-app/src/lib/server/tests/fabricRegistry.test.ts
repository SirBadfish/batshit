import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mockLoadToolsForUser = vi.fn()
const mockShouldHideInternalMcpTool = vi.fn(() => false)
const mockResolveDynamicMcpGatewayScope = vi.fn()

const MockArtifactsService = vi.fn(function MockArtifactsService(this: Record<string, unknown>) {
  Object.assign(this, mockArtifactService)
})

const mockArtifactService = {
  create: vi.fn(),
  listByUser: vi.fn(),
  getAccessible: vi.fn(),
  getOwned: vi.fn(),
  update: vi.fn(),
  validateStructure: vi.fn(),
  applyPatch: vi.fn(),
  addVersion: vi.fn(),
  rollbackToVersion: vi.fn(),
  deleteVersion: vi.fn()
}

const mockCliToolService = {
  listCliTools: vi.fn(),
  getCliTool: vi.fn(),
  createCliTool: vi.fn(),
  updateCliTool: vi.fn(),
  deleteCliTool: vi.fn(),
  validateCliTool: vi.fn()
}

const mockRedisJsonGet = vi.fn()
const mockRedisJsonSet = vi.fn()
const mockRedisGet = vi.fn()
const mockRedisSet = vi.fn()
const mockRedisExpire = vi.fn()
const mockRedisLPush = vi.fn()
const mockRedisLTrim = vi.fn()
const mockGetSession = vi.fn()
const mockGetSessionMessages = vi.fn()
const mockGetRecentMessages = vi.fn()
const mockGetUserSettings = vi.fn()
const mockUpdateUserSettings = vi.fn()
const mockGetAgents = vi.fn()
const mockUpdateAgent = vi.fn()
const mockGetVoiceProfiles = vi.fn()
const mockDeleteVoiceProfile = vi.fn()
const mockCompleteLocalVoiceEngineSetup = vi.fn()
const mockRuntimeAddons = {
  listRuntimeAddons: vi.fn(),
  getRuntimeAddonStatus: vi.fn(),
  prepareRuntimeAddon: vi.fn(),
  controlRuntimeAddon: vi.fn()
}
const mockFetchVercelModelCatalog = vi.fn()
const mockApiKeyRetrieve = vi.fn()
const mockPrivateEnv = vi.hoisted(() => ({
  values: {
    BATSHIT_TOKEN: 'test-batshit-token',
    BATSHIT_FRONTEND_URL: 'http://localhost:5620',
    BATSHIT_ARTIFACT_COMPLETE_URL: 'http://localhost:5620/api/artifacts/complete',
    BATSHIT_PROJECT_ROOT: '/tmp',
    BATSHIT_CONTAINERIZED: '',
    PORT: ''
  } as Record<string, string>
}))
// SA-116 P1: the risk gate runs the REAL `controlApprovals.ts` inside this suite rather
// than a stub, so what is proved here is the wiring an agent actually hits. That needs the
// ZSET and key commands the approval store uses, backed by the same in-test maps the JSON
// mocks already use.
const zsetStore = new Map<string, Map<string, number>>()
const ensureZset = (key: string) => {
  if (!zsetStore.has(key)) zsetStore.set(key, new Map())
  return zsetStore.get(key)!
}
const mockRedisZAdd = vi.fn(async (key: string, entries: any) => {
  const list = Array.isArray(entries) ? entries : [entries]
  const zset = ensureZset(key)
  for (const entry of list) zset.set(String(entry.value), Number(entry.score))
  return list.length
})
const mockRedisZRange = vi.fn(async (key: string) =>
  Array.from(ensureZset(key).entries())
    .sort((left, right) => left[1] - right[1])
    .map(([member]) => member)
)
const mockRedisDel = vi.fn(async (key: string) => {
  zsetStore.delete(key)
  return 1
})
const mockRedisExists = vi.fn(async () => 0)
const mockRedisExecute = vi.fn(async (operation: any) =>
  operation({
    get: mockRedisGet,
    set: mockRedisSet,
    json: { get: mockRedisJsonGet, set: mockRedisJsonSet },
    expire: mockRedisExpire,
    lPush: mockRedisLPush,
    lTrim: mockRedisLTrim,
    zAdd: mockRedisZAdd,
    zRange: mockRedisZRange,
    del: mockRedisDel,
    exists: mockRedisExists
  })
)

vi.mock('$env/dynamic/private', () => ({
  env: mockPrivateEnv.values
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: (...args: any[]) => mockApiKeyRetrieve(...args)
  }
}))

vi.mock('$lib/server/redis', () => ({
  redis: {
    getZip: vi.fn(),
    getSession: (...args: any[]) => mockGetSession(...args),
    getSessionMessages: (...args: any[]) => mockGetSessionMessages(...args),
    getRecentMessages: (...args: any[]) => mockGetRecentMessages(...args),
    getUserSettings: (...args: any[]) => mockGetUserSettings(...args),
    updateUserSettings: (...args: any[]) => mockUpdateUserSettings(...args),
    getAgents: (...args: any[]) => mockGetAgents(...args),
    updateAgent: (...args: any[]) => mockUpdateAgent(...args),
    getVoiceProfiles: (...args: any[]) => mockGetVoiceProfiles(...args),
    deleteVoiceProfile: (...args: any[]) => mockDeleteVoiceProfile(...args),
    get: (...args: any[]) => mockRedisGet(...args),
    json: {
      get: (key: string) => mockRedisJsonGet(key),
      set: (key: string, path: string, value: any) => mockRedisJsonSet(key, path, value)
    },
    expire: (...args: any[]) => mockRedisExpire(...args),
    del: (...args: any[]) => mockRedisDel(...args),
    execute: (...args: any[]) => mockRedisExecute(...args)
  }
}))

vi.mock('../services/mcpGatewayDiscovery', () => ({
  mcpGatewayDiscovery: {
    loadToolsForUser: (...args: any[]) => mockLoadToolsForUser(...args)
  }
}))

vi.mock('../services/nativeToolConstants', () => ({
  shouldHideInternalMcpTool: (...args: any[]) => mockShouldHideInternalMcpTool(...args)
}))

vi.mock('../services/mcpSelectionResolver', () => ({
  resolveDynamicMcpGatewayScope: (...args: any[]) => mockResolveDynamicMcpGatewayScope(...args)
}))

vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: MockArtifactsService
}))

vi.mock('$lib/server/services/cliToolRegistry', () => ({
  listCliTools: (...args: any[]) => mockCliToolService.listCliTools(...args),
  getCliTool: (...args: any[]) => mockCliToolService.getCliTool(...args),
  createCliTool: (...args: any[]) => mockCliToolService.createCliTool(...args),
  updateCliTool: (...args: any[]) => mockCliToolService.updateCliTool(...args),
  deleteCliTool: (...args: any[]) => mockCliToolService.deleteCliTool(...args),
  validateCliTool: (...args: any[]) => mockCliToolService.validateCliTool(...args)
}))

vi.mock('$lib/server/services/voiceLocalEngineSetup', () => ({
  completeLocalVoiceEngineSetup: (...args: any[]) => mockCompleteLocalVoiceEngineSetup(...args)
}))

vi.mock('$lib/server/services/runtimeAddons', () => ({
  RUNTIME_ADDON_IDS: [
    'cloudflared',
    'fbx2vrma',
    'comfyui-validation',
    'comfyui',
    'local-ai',
    'voice-engines',
    'livekit',
    'agent-browser'
  ],
  listRuntimeAddons: (...args: any[]) => mockRuntimeAddons.listRuntimeAddons(...args),
  getRuntimeAddonStatus: (...args: any[]) => mockRuntimeAddons.getRuntimeAddonStatus(...args),
  prepareRuntimeAddon: (...args: any[]) => mockRuntimeAddons.prepareRuntimeAddon(...args),
  controlRuntimeAddon: (...args: any[]) => mockRuntimeAddons.controlRuntimeAddon(...args)
}))

// SA-113 F-SEC-1b: the gate dynamic-imports this to stamp the DM. Mocked so the test can
// see the stamp without standing up the whole DM store, and so a stamp failure can never be
// what makes a refusal test pass.
vi.mock('$lib/server/services/dm/dmStore', () => ({
  stampDmNeedsUser: vi.fn(async () => undefined)
}))

vi.mock('$lib/server/services/vercelModelCatalog', () => ({
  fetchVercelModelCatalog: (...args: any[]) => mockFetchVercelModelCatalog(...args)
}))

describe('controlRegistry artifact capability controls', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  beforeEach(() => {
    vi.clearAllMocks()
    Object.assign(mockPrivateEnv.values, {
      BATSHIT_TOKEN: 'test-batshit-token',
      BATSHIT_FRONTEND_URL: 'http://localhost:5620',
      BATSHIT_ARTIFACT_COMPLETE_URL: 'http://localhost:5620/api/artifacts/complete',
      BATSHIT_PROJECT_ROOT: '/tmp',
      BATSHIT_CONTAINERIZED: '',
      PORT: ''
    })
    mockShouldHideInternalMcpTool.mockReturnValue(false)
    mockResolveDynamicMcpGatewayScope.mockResolvedValue({
      resolvedGateways: [],
      defaultGateways: null,
      source: 'agent'
    })
    mockApiKeyRetrieve.mockResolvedValue(null)
    mockFetchVercelModelCatalog.mockResolvedValue({
      fetchedAt: '2026-06-06T00:00:00.000Z',
      models: []
    })
    mockRedisGet.mockResolvedValue(null)
    mockRedisSet.mockResolvedValue('OK')
    let storedVoiceSettings: Record<string, any> | undefined
    const jsonStore = new Map<string, any>()

    mockRedisJsonGet.mockImplementation(async (key: string) => jsonStore.get(key) ?? null)
    // Path-aware, because SA-116's approval store writes `$.status` onto an EXISTING record
    // and a path write must NOT create the root. A path-blind fake would have made both the
    // "swept approval stays gone" rule and the whole-record-write bug it guards against
    // untestable here — and it would have silently replaced each record with a status string.
    mockRedisJsonSet.mockImplementation(async (key: string, path: string, value: any) => {
      if (path === '$' || !path) {
        jsonStore.set(key, value)
        return 'OK'
      }
      const field = path.startsWith('$.') ? path.slice(2) : path
      const existing = jsonStore.get(key)
      if (!existing || typeof existing !== 'object') {
        throw new Error("ERR new objects must be created at the root")
      }
      jsonStore.set(key, { ...existing, [field]: value })
      return 'OK'
    })
    zsetStore.clear()
    mockRedisDel.mockImplementation(async (key: string) => {
      zsetStore.delete(key)
      jsonStore.delete(key)
      return 1
    })
    mockGetSession.mockResolvedValue({
      id: 'session-1',
      user_id: 'user-1'
    })
    mockGetSessionMessages.mockResolvedValue([])
    // Default: an ordinary chat the user typed in. SA-113 F-SEC-1 reads this to tell a
    // woken turn from a typed one, and every pre-existing risk test in this file assumes
    // the typed answer.
    mockGetRecentMessages.mockResolvedValue([
      { role: 'user', content: 'hello', metadata: {} }
    ])

    mockGetUserSettings.mockImplementation(async () => ({
      id: 'settings_user-1',
      user_id: 'user-1',
      voice_settings: storedVoiceSettings
    }))
    mockGetAgents.mockResolvedValue([])
    mockUpdateAgent.mockResolvedValue(undefined)
    mockGetVoiceProfiles.mockResolvedValue([])
    mockDeleteVoiceProfile.mockResolvedValue(undefined)

    mockUpdateUserSettings.mockImplementation(async (_userId: string, updates: Record<string, any>) => {
      storedVoiceSettings = updates.voice_settings
      return {
        id: 'settings_user-1',
        user_id: 'user-1',
        voice_settings: storedVoiceSettings
      }
    })

    mockArtifactService.create.mockResolvedValue({
      id: 'artifact_123',
      name: 'Demo Artifact'
    })
    mockArtifactService.listByUser.mockResolvedValue([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Demo Artifact',
        slug: 'demo-artifact',
        mode: 'edit',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_allowlist: ['agent-1'],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])
    mockArtifactService.getAccessible.mockResolvedValue({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'edit'
    })
    mockArtifactService.getOwned.mockResolvedValue({
      id: 'artifact_123',
      user_id: 'user-1',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      type: 'html',
      mode: 'published',
      zone: 'panel',
      version: 2,
      content: '<div>Old</div>',
      versions: [],
      updated_at: '2026-03-04T00:00:00.000Z',
      published_at: '2026-03-04T00:00:00.000Z'
    })
    mockArtifactService.update.mockResolvedValue({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'published'
    })
    mockArtifactService.validateStructure.mockResolvedValue({
      valid: true,
      canSave: true,
      canDefer: false,
      enforced: true,
      mode: 'edit',
      artifactId: 'artifact_123',
      usesBuilderKit: true,
      usesStandardControls: true,
      hasFabricRuntimeContract: true,
      hasFabricBindings: true,
      runOnly: false,
      fabricFieldIds: ['prompt'],
      issues: [],
      advisories: [],
      message: 'Artifact structure is valid for save.'
    })
    mockArtifactService.applyPatch.mockResolvedValue({
      id: 'artifact_123',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      type: 'html',
      mode: 'edit',
      zone: 'panel',
      version: 2,
      content: '<div>Patched</div>',
      versions: [
        {
          id: 'v1',
          version: 1,
          content: '<div>Hello</div>',
          created_at: '2026-03-05T00:00:00.000Z',
          created_by: 'user-1'
        },
        {
          id: 'v2',
          version: 2,
          content: '<div>Patched</div>',
          created_at: '2026-03-06T00:00:00.000Z',
          created_by: 'user-1'
        }
      ],
      updated_at: '2026-03-06T00:00:00.000Z',
      published_at: null
    })
    mockArtifactService.addVersion.mockResolvedValue({
      id: 'artifact_123',
      version: 2
    })
    mockArtifactService.rollbackToVersion.mockResolvedValue({
      id: 'artifact_123',
      version: 3
    })
    mockArtifactService.deleteVersion.mockResolvedValue({
      id: 'artifact_123',
      version: 3
    })

    mockCliToolService.listCliTools.mockResolvedValue([
      {
        toolId: 'repo_snapshot',
        title: 'Repo Snapshot',
        description: 'Capture a quick repo snapshot.',
        tags: ['git', 'snapshot'],
        origin: 'manual',
        status: 'active',
        executable: 'node',
        argsTemplate: [{ kind: 'literal', value: 'scripts/snapshot.js' }],
        inputSchema: {
          type: 'object',
          properties: {}
        },
        outputMode: 'json',
        parseMode: 'json',
        cwdPolicy: 'project',
        timeoutMs: 60000,
        riskLevel: 'safe',
        allowNetwork: false,
        allowWrite: false,
        createdAt: '2026-03-13T00:00:00.000Z',
        updatedAt: '2026-03-13T00:00:00.000Z',
        lastValidationStatus: 'passed',
        lastValidationSummary: 'Validation input executed successfully'
      }
    ])
    mockCliToolService.getCliTool.mockImplementation(async (_userId: string, toolId: string) =>
      toolId === 'repo_snapshot'
        ? {
            toolId: 'repo_snapshot',
            title: 'Repo Snapshot',
            description: 'Capture a quick repo snapshot.',
            tags: ['git', 'snapshot'],
            origin: 'manual',
            status: 'active',
            executable: 'node',
            argsTemplate: [{ kind: 'literal', value: 'scripts/snapshot.js' }],
            inputSchema: {
              type: 'object',
              properties: {}
            },
            outputMode: 'json',
            parseMode: 'json',
            cwdPolicy: 'project',
            timeoutMs: 60000,
            riskLevel: 'safe',
            allowNetwork: false,
            allowWrite: false,
            createdAt: '2026-03-13T00:00:00.000Z',
            updatedAt: '2026-03-13T00:00:00.000Z',
            lastValidationStatus: 'passed',
            lastValidationSummary: 'Validation input executed successfully'
          }
        : null
    )
    mockCliToolService.createCliTool.mockImplementation(async (_userId: string, input: any) => ({
      toolId: input.toolId ?? 'repo_snapshot',
      title: input.title ?? 'Repo Snapshot',
      description: input.description ?? 'Capture a quick repo snapshot.',
      tags: input.tags ?? [],
      origin: input.origin ?? 'manual',
      status: input.status ?? 'active',
      executable: input.executable ?? 'node',
      argsTemplate: input.argsTemplate ?? [{ kind: 'literal', value: 'scripts/snapshot.js' }],
      inputSchema: input.inputSchema ?? { type: 'object', properties: {} },
      outputMode: input.outputMode ?? 'json',
      parseMode: input.parseMode ?? 'json',
      cwdPolicy: input.cwdPolicy ?? 'project',
      timeoutMs: input.timeoutMs ?? 60000,
      riskLevel: input.riskLevel ?? 'safe',
      allowNetwork: input.allowNetwork ?? false,
      allowWrite: input.allowWrite ?? false,
      createdAt: '2026-03-13T00:00:00.000Z',
      updatedAt: '2026-03-13T00:00:00.000Z'
    }))
    mockCliToolService.updateCliTool.mockImplementation(async (_userId: string, toolId: string, updates: any) => ({
      toolId,
      title: updates.title ?? 'Repo Snapshot',
      description: updates.description ?? 'Capture a quick repo snapshot.',
      tags: updates.tags ?? ['git'],
      origin: 'manual',
      status: updates.status ?? 'active',
      executable: updates.executable ?? 'node',
      argsTemplate: updates.argsTemplate ?? [{ kind: 'literal', value: 'scripts/snapshot.js' }],
      inputSchema: updates.inputSchema ?? { type: 'object', properties: {} },
      outputMode: updates.outputMode ?? 'json',
      parseMode: updates.parseMode ?? 'json',
      cwdPolicy: updates.cwdPolicy ?? 'project',
      timeoutMs: updates.timeoutMs ?? 60000,
      riskLevel: updates.riskLevel ?? 'safe',
      allowNetwork: updates.allowNetwork ?? false,
      allowWrite: updates.allowWrite ?? false,
      createdAt: '2026-03-13T00:00:00.000Z',
      updatedAt: '2026-03-13T00:00:00.000Z'
    }))
    mockCliToolService.deleteCliTool.mockResolvedValue(undefined)
    mockCliToolService.validateCliTool.mockResolvedValue({
      success: true,
      toolId: 'repo_snapshot',
      executable: 'node',
      args: ['scripts/snapshot.js'],
      cwd: '/Users/example/batshit',
      exitCode: 0,
      stdout: '{"ok":true}',
      stderr: '',
      summary: 'Validation input executed successfully'
    })
    mockRuntimeAddons.listRuntimeAddons.mockResolvedValue([
      {
        id: 'cloudflared',
        title: 'Cloudflared Clip Tunnel',
        route: 'sidecar/profile',
        composeProfile: 'cloudflared'
      },
      {
        id: 'fbx2vrma',
        title: 'FBX-to-VRMA Worker',
        route: 'sidecar/profile',
        composeProfile: 'fbx2vrma'
      }
    ])
    mockRuntimeAddons.getRuntimeAddonStatus.mockResolvedValue({
      id: 'fbx2vrma',
      title: 'FBX-to-VRMA Worker',
      state: 'waiting',
      running: false,
      supported: false,
      dockerUnsupported: true,
      composeProfile: 'fbx2vrma',
      operatorCommand:
        'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker'
    })
    mockRuntimeAddons.prepareRuntimeAddon.mockResolvedValue({
      id: 'fbx2vrma',
      title: 'FBX-to-VRMA Worker',
      state: 'waiting',
      running: false,
      supported: false,
      dockerUnsupported: true,
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker',
      operator: {
        configured: false,
        available: false,
        url: null,
        reason: 'Runtime add-on operator is not configured.'
      },
      nextSteps: [
        'Ask the user/operator to run the approved Compose command from the folder containing compose.yaml and .env.docker.'
      ]
    })
    mockRuntimeAddons.controlRuntimeAddon.mockResolvedValue({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma',
      alreadySatisfied: false,
      operator: {
        configured: true,
        available: true,
        url: 'http://127.0.0.1:5629',
        reason: null
      },
      before: {
        id: 'fbx2vrma',
        running: false
      },
      after: {
        id: 'fbx2vrma',
        running: true
      }
    })
  })

  it('publishes sys.artifact.* controls through findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.artifact.',
      includeDraft: true,
      limit: 200
    })

    const artifactIds = result.results
      .filter((item) => item.controlId.startsWith('sys.artifact.'))
      .map((item) => item.controlId)
      .sort()

    expect(artifactIds).toEqual([
      'sys.artifact.add_version',
      'sys.artifact.analyze_url',
      'sys.artifact.apply_patch',
      'sys.artifact.check_requirements',
      'sys.artifact.create',
      'sys.artifact.delete_version',
      'sys.artifact.get',
      'sys.artifact.list',
      'sys.artifact.publish',
      'sys.artifact.rollback',
      'sys.artifact.run_logs.get',
      'sys.artifact.run_logs.list',
      'sys.artifact.set_webhook',
      'sys.artifact.set_zone',
      'sys.artifact.update',
      'sys.artifact.validate_structure'
    ])
  })

  it('publishes the SA-104 P3 sys.memory.* control family through findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.memory.',
      includeDraft: true,
      limit: 200
    })

    const memoryIds = result.results
      .filter((item) => item.controlId.startsWith('sys.memory.'))
      .map((item) => item.controlId)
      .sort()

    expect(memoryIds).toEqual([
      'sys.memory.close_episode',
      'sys.memory.delete',
      'sys.memory.hold_episode',
      'sys.memory.list',
      'sys.memory.move_lane',
      'sys.memory.recall',
      'sys.memory.save',
      'sys.memory.search',
      'sys.memory.supersede',
      'sys.memory.unsupersede',
      'sys.memory.update',
      'sys.memory.whiteboard'
    ])

    const deleteControl = result.results.find((item) => item.controlId === 'sys.memory.delete')
    expect(deleteControl?.riskLevel).toBe('confirm')
    const saveControl = result.results.find((item) => item.controlId === 'sys.memory.save')
    expect(saveControl?.riskLevel).toBe('safe')
    // SA-104 P5: episode boundary controls ride the same wildcard scope, risk safe.
    const closeControl = result.results.find((item) => item.controlId === 'sys.memory.close_episode')
    expect(closeControl?.riskLevel).toBe('safe')
    const holdControl = result.results.find((item) => item.controlId === 'sys.memory.hold_episode')
    expect(holdControl?.riskLevel).toBe('safe')
    // SA-104 P6: the whiteboard control joins the family, risk safe.
    const whiteboardControl = result.results.find(
      (item) => item.controlId === 'sys.memory.whiteboard'
    )
    expect(whiteboardControl?.riskLevel).toBe('safe')
  })

  it('excludes sys.memory.* from a broker allowlist without the memory scope', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const withoutMemory = await findControls({
      query: 'memory',
      limit: 200,
      allowedControlIds: ['sys.artifact.*', 'sys.zip.fetch']
    })
    expect(
      withoutMemory.results.some((item) => item.controlId.startsWith('sys.memory.'))
    ).toBe(false)

    const withMemory = await findControls({
      query: 'memory',
      limit: 200,
      allowedControlIds: ['sys.memory.*']
    })
    expect(
      withMemory.results.filter((item) => item.controlId.startsWith('sys.memory.')).length
    ).toBe(12)
  })

  it('publishes the SA-113 P2 sys.dm.* control family through findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.dm.',
      includeDraft: true,
      limit: 200
    })

    const dmIds = result.results
      .filter((item) => item.controlId.startsWith('sys.dm.'))
      .map((item) => item.controlId)
      .sort()

    expect(dmIds).toEqual([
      'sys.dm.agents',
      'sys.dm.blocked',
      'sys.dm.claim',
      'sys.dm.done',
      'sys.dm.list',
      'sys.dm.read',
      'sys.dm.send'
    ])

    // DL-113-03: every DM control is `safe` — the control is the recipient's settings and
    // the Admin switch, not a per-call confirmation prompt.
    for (const control of result.results.filter((item) => item.controlId.startsWith('sys.dm.'))) {
      expect(control.riskLevel).toBe('safe')
    }
  })

  it('excludes sys.dm.* from a broker allowlist without the DM scope', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const withoutDms = await findControls({
      query: 'dm',
      limit: 200,
      allowedControlIds: ['sys.artifact.*', 'sys.memory.*']
    })
    expect(withoutDms.results.some((item) => item.controlId.startsWith('sys.dm.'))).toBe(false)

    const withDms = await findControls({
      query: 'dm',
      limit: 200,
      allowedControlIds: ['sys.dm.*']
    })
    expect(
      withDms.results.filter((item) => item.controlId.startsWith('sys.dm.')).length
    ).toBe(7)
  })

  it('publishes the SA-115 P2 sys.schedule.* control family through findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.schedule.',
      includeDraft: true,
      limit: 200
    })

    const scheduleControls = result.results.filter((item) =>
      item.controlId.startsWith('sys.schedule.')
    )
    expect(scheduleControls.map((item) => item.controlId).sort()).toEqual([
      'sys.schedule.create',
      'sys.schedule.delete',
      'sys.schedule.list',
      'sys.schedule.update'
    ])

    // DL-115-10: reading is safe; every WRITE is `confirm`. Putting an agent on a clock is
    // a spend decision that repeats until somebody stops it, so it goes past a person once.
    const riskByControl = Object.fromEntries(
      scheduleControls.map((item) => [item.controlId, item.riskLevel])
    )
    expect(riskByControl).toEqual({
      'sys.schedule.list': 'safe',
      'sys.schedule.create': 'confirm',
      'sys.schedule.update': 'confirm',
      'sys.schedule.delete': 'confirm'
    })
  })

  it('excludes sys.schedule.* from a broker allowlist without the schedule scope', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const without = await findControls({
      query: 'schedule',
      limit: 200,
      allowedControlIds: ['sys.artifact.*', 'sys.memory.*', 'sys.dm.*']
    })
    expect(without.results.some((item) => item.controlId.startsWith('sys.schedule.'))).toBe(false)

    const withSchedules = await findControls({
      query: 'schedule',
      limit: 200,
      allowedControlIds: ['sys.schedule.*']
    })
    expect(
      withSchedules.results.filter((item) => item.controlId.startsWith('sys.schedule.')).length
    ).toBe(4)
  })

  it('matches multi-token artifact control queries in findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.artifact.create sys.artifact.publish',
      includeDraft: false,
      limit: 50
    })

    const ids = result.results.map((item) => item.controlId)
    expect(ids).toContain('sys.artifact.create')
    expect(ids).toContain('sys.artifact.publish')
  })

  it('publishes sys.cli_tool.* controls through findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.cli_tool.',
      includeDraft: true,
      limit: 200
    })

    const cliToolIds = result.results
      .filter((item) => item.controlId.startsWith('sys.cli_tool.'))
      .map((item) => item.controlId)
      .sort()

    expect(cliToolIds).toEqual([
      'sys.cli_tool.archive',
      'sys.cli_tool.create',
      'sys.cli_tool.delete',
      'sys.cli_tool.get',
      'sys.cli_tool.list',
      'sys.cli_tool.test',
      'sys.cli_tool.update'
    ])
  })

  it('publishes sys.runtime_addon.* controls through findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.runtime_addon.',
      includeDraft: true,
      limit: 50
    })

    const runtimeAddonIds = result.results
      .filter((item) => item.controlId.startsWith('sys.runtime_addon.'))
      .map((item) => item.controlId)
      .sort()

    expect(runtimeAddonIds).toEqual([
      'sys.runtime_addon.list',
      'sys.runtime_addon.prepare',
      'sys.runtime_addon.start',
      'sys.runtime_addon.status',
      'sys.runtime_addon.stop'
    ])
  })

  it('executes sys.runtime_addon.prepare without starting Docker containers', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.runtime_addon.prepare',
      input: {
        addonId: 'fbx2vrma'
      }
    })

    expect(result.success).toBe(true)
    expect(mockRuntimeAddons.prepareRuntimeAddon).toHaveBeenCalledWith('fbx2vrma')
    if (!result.success) return
    expect((result.result as any).addon).toMatchObject({
      id: 'fbx2vrma',
      canStartAutomatically: false,
      requiresOperator: true,
      operatorCommand:
        'docker compose --env-file .env.docker --profile fbx2vrma up -d --build fbx2vrma-worker'
    })
  })

  it('confirm-gates sys.runtime_addon.start and executes through the approved operator path', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const denied = await useControl({
      userId: 'user-1',
      controlId: 'sys.runtime_addon.start',
      input: {
        addonId: 'fbx2vrma'
      }
    })

    expect(denied.success).toBe(false)
    if (denied.success) return
    expect(denied.error?.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')

    const approved = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.runtime_addon.start',
      input: {
        addonId: 'fbx2vrma'
      }
    })

    expect(approved.success).toBe(true)
    expect(mockRuntimeAddons.controlRuntimeAddon).toHaveBeenCalledWith('fbx2vrma', 'start')
    if (!approved.success) return
    expect((approved.result as any).addon).toMatchObject({
      success: true,
      operation: 'start',
      addonId: 'fbx2vrma'
    })
  })

  it('executes sys.cli_tool.create without allowRisky and applies authoring defaults', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.cli_tool.create',
      input: {
        title: 'Repo Snapshot',
        description: 'Capture a quick repo snapshot.',
        executable: 'node',
        argsTemplate: [{ kind: 'literal', value: 'scripts/snapshot.js' }],
        inputSchema: { type: 'object', properties: {} },
        outputMode: 'json',
        parseMode: 'json',
        cwdPolicy: 'project',
        riskLevel: 'safe',
        allowNetwork: false,
        allowWrite: false
      }
    })

    expect(mockCliToolService.createCliTool).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        title: 'Repo Snapshot',
        origin: 'generated',
        status: 'active'
      })
    )
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.controlId).toBe('sys.cli_tool.create')
    expect((result.result as any).cliTool.title).toBe('Repo Snapshot')
    expect((result.result as any).cliTool.origin).toBe('generated')
    expect((result.result as any).cliTool.basic.connectedTo).toBe('node')
  })

  /* ---------------------------------------------------------------- *
   * SA-116 — the click is the approval (DL-116-01, DL-116-03, DL-116-09, DL-116-10)
   *
   * SA-113's F-SEC-1 suite lived here and pinned an outright refusal for a woken turn.
   * A woken turn now PAUSES for the same card as any other turn, so those tests are
   * rewritten rather than deleted: every load-bearing property they protected is still
   * asserted below, in its new shape.
   *
   * These run the real `controlApprovals.ts` against this file's Redis mock, so what is
   * proved is the wiring `useControl` actually has.
   * ---------------------------------------------------------------- */

  /** The wake primitive's user message: `metadata.wake` is what makes a turn a woken one. */
  const wokenUserMessage = (dmId?: string) => ({
    role: 'user',
    content: '[Agent DM — from Cooper, not from the user] assignment — Check the build',
    metadata: { wake: { chainDepth: 1, ...(dmId ? { dmId } : {}) } }
  })

  /** Every `ControlAuditEntry` this test wrote, in order (DL-116-12). */
  const auditEntriesWritten = () =>
    mockRedisJsonSet.mock.calls
      .filter((call) => String(call[0] ?? '').startsWith('control_audit:'))
      .map((call) => call[2] as any)

  const riskWindowKeysWritten = () =>
    mockRedisSet.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((key) => key.startsWith('control_risk_approval:'))

  /** Every pending approval record this test caused (SA-116 F-P1-2). */
  const approvalRecordsWritten = () =>
    mockRedisJsonSet.mock.calls
      .map((call) => String(call[0] ?? ''))
      .filter((key) => key.startsWith('control_approval:'))

  /**
   * Run a risky control the way a user does now: it pauses, the user clicks Approve, and
   * the very same call runs.
   *
   * Before SA-116 these sites simply passed `allowRisky: true`, which the server now
   * ignores on every lane but the Portable Skill one — so a test that still passed the flag
   * would be asserting against a gate that no longer reads it. This helper is what "the
   * user clicked Approve" looks like from a test.
   */
  const useControlWithApproval = async (options: any) => {
    const { useControl } = await import('../services/fabricRegistry')
    const { decideApproval } = await import('../services/controlApprovals')
    const first = await useControl(options)
    if (first.success || first.error.code !== 'CONTROL_RISK_REQUIRES_APPROVAL') return first
    const approvalId = first.error.details?.approvalId
    expect(typeof approvalId).toBe('string')
    await decideApproval({ userId: options.userId, approvalId, approved: true })
    // The grant is how send-routed's resume names the record it is spending. It matters for
    // a call with no `sessionId` (the service lane): the index is session-scoped, so there
    // is nothing for the implicit lookup to search.
    return await useControl({ ...options, approval: { kind: 'sdk', approvalId } })
  }

  /** Approve the pending card a paused `useControl` just raised. */
  const approveThePause = async (result: any) => {
    const { decideApproval } = await import('../services/controlApprovals')
    const approvalId = result?.error?.details?.approvalId
    expect(typeof approvalId).toBe('string')
    const decided = await decideApproval({ userId: 'user-1', approvalId, approved: true })
    expect(decided?.status).toBe('approved')
    return approvalId as string
  }

  it('pauses sys.cli_tool.test for a card, and the click runs it exactly once', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const paused = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' }
    })

    expect(paused.success).toBe(false)
    if (paused.success) return
    expect(paused.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockCliToolService.validateCliTool).not.toHaveBeenCalled()
    // DL-116-07: the block send-routed persists the card from, on every lane.
    expect(paused.error.details?.approvalRequest).toEqual(
      expect.objectContaining({
        approvalId: paused.error.details?.approvalId,
        controlId: 'sys.cli_tool.test',
        riskLevel: 'confirm',
        inputSummary: { toolId: 'repo_snapshot' }
      })
    )
    // The model is told to stop, not to retry with a flag. This call names no message, so
    // its lane is `service` and no card can render for it — DL-116-13 makes the refusal
    // say that plainly instead of claiming the user was asked (P2-EVIDENCE §6).
    expect(paused.error.details?.approvalRequest?.lane).toBe('service')
    expect(paused.error.message).toContain('no chat to show an Approve button in')
    expect(paused.error.message).toContain('then stop')
    expect(paused.error.message).not.toContain('asked the user to approve it.')

    await approveThePause(paused)

    const approved = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' }
    })
    expect(approved.success).toBe(true)
    expect(mockCliToolService.validateCliTool).toHaveBeenCalledWith('user-1', 'repo_snapshot', {
      projectPath: null
    })

    // Consume-once: the same call again is a new card, not a second free run.
    mockCliToolService.validateCliTool.mockClear()
    const replay = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' }
    })
    expect(replay.success).toBe(false)
    if (replay.success) return
    expect(replay.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockCliToolService.validateCliTool).not.toHaveBeenCalled()
  })

  it('DL-116-01: the model passing allowRisky alone runs nothing, and caches nothing', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // The exact move the old `approval_hint` taught, on the API broker's own path (the
    // broker passes `input.allowRisky` straight through and declares no actorType).
    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      runtimeMode: 'mode3',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' },
      allowRisky: true
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockCliToolService.validateCliTool).not.toHaveBeenCalled()
    // ...and nothing was written that a later call could read as consent.
    expect(riskWindowKeysWritten()).toEqual([])
  })

  it('DL-116-09: a Portable Skill Token still runs its scoped control', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // The token's family scope IS the consent, and there is no chat to click in.
    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' },
      actorType: 'portable-skill',
      allowRisky: true
    })

    expect(result.success).toBe(true)
    expect(mockCliToolService.validateCliTool).toHaveBeenCalled()
    // DL-116-12: recorded as a scope, never as a click.
    const audited = auditEntriesWritten().at(-1)
    expect(audited?.approval).toEqual(
      expect.objectContaining({ kind: 'portable-skill-scope', approvalId: null })
    )
  })

  it('a risky control with unusable input fails first, without costing a click', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // AMD-116-02's lesson, one step further along: a pause on a call that could never run
    // spends a click and a turn on a card, and the control then fails anyway.
    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 42 } as any
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_INPUT_INVALID')
    // No card was raised for a call that cannot happen.
    expect(auditEntriesWritten().at(-1)?.paused).toBe(false)
  })

  it('DL-116-10: a risky control in a group chat is refused, not carded', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockGetSession.mockResolvedValue({
      id: 'session-group',
      user_id: 'user-1',
      metadata: { group_chat: { group_id: 'grp_1' } }
    })

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-group',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' }
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_UNAVAILABLE_IN_GROUP')
    expect(result.error.message).toContain('direct chat')
    expect(mockCliToolService.validateCliTool).not.toHaveBeenCalled()
  })

  it('DL-116-12: the audit entry carries the agent, the session, and the approval', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const paused = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' }
    })
    const pausedAudit = auditEntriesWritten().at(-1)
    expect(pausedAudit).toEqual(
      expect.objectContaining({ agentId: 'agent-1', sessionId: 'session-1', paused: true })
    )
    expect(pausedAudit?.approval).toBeNull()

    const approvalId = await approveThePause(paused)
    await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' },
      approval: { kind: 'sdk', approvalId }
    })
    const ranAudit = auditEntriesWritten().at(-1)
    expect(ranAudit?.paused).toBe(false)
    expect(ranAudit?.approval).toEqual(
      expect.objectContaining({ approvalId, kind: 'sdk' })
    )
  })

  it('a safe control never pauses, in a woken turn or anywhere else', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockGetRecentMessages.mockResolvedValue([wokenUserMessage()])

    // The gate is risk-scoped. Every `sys.dm.*` control is `safe`, which is what keeps a
    // woken agent able to read, claim, and close the DM that woke it.
    const result = await useControl({
      userId: 'user-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.create',
      input: {
        title: 'Repo Snapshot',
        description: 'Summarise the repo',
        connectedTo: 'node',
        command: 'node scripts/snapshot.mjs'
      }
    })

    expect(result.success).toBe(true)
    expect(mockCliToolService.createCliTool).toHaveBeenCalled()
  })

  it('SA-113 F-SEC-1, kept: a woken turn pauses and cannot ride a window', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockGetRecentMessages.mockResolvedValue([wokenUserMessage()])

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' },
      // The webhook body's move: outside text telling a compliant model the user said yes.
      allowRisky: true
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockCliToolService.validateCliTool).not.toHaveBeenCalled()
    expect(riskWindowKeysWritten()).toEqual([])
  })

  it('SA-113 F-SEC-1, kept: an unreadable session pauses rather than assuming a human', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockGetRecentMessages.mockRejectedValue(new Error('redis is down'))

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' },
      allowRisky: true
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockCliToolService.validateCliTool).not.toHaveBeenCalled()
  })

  it('F-SEC-1b, kept: the pause stamps the DM that woke the chat as needing the user', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    const { stampDmNeedsUser } = await import('$lib/server/services/dm/dmStore')
    mockGetRecentMessages.mockResolvedValue([wokenUserMessage('dm_stuck')])

    await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' }
    })

    expect(stampDmNeedsUser).toHaveBeenCalledWith(
      'dm_stuck',
      expect.stringContaining('waiting for you to approve')
    )
  })

  it('F-SEC-1b, kept: a woken turn with no DM id (a webhook wake) still pauses', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    const { stampDmNeedsUser } = await import('$lib/server/services/dm/dmStore')
    mockGetRecentMessages.mockResolvedValue([wokenUserMessage()])

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.cli_tool.test',
      input: { toolId: 'repo_snapshot' },
      allowRisky: true
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(stampDmNeedsUser).not.toHaveBeenCalled()
  })

  it('ranks use.artifact.* ahead of per-instance controls for artifact-use intent', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Demo Artifact',
        slug: 'demo-artifact',
        mode: 'published',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_allowlist: ['agent-1'],
        metadata: {
          fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
        },
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact use',
      includeDraft: true,
      // SA-115: was 30, which the registry has outgrown. The claim here is a RELATIVE
      // ordering between two controls, but a fixed window turns "the registry gained four
      // entries" into "the lower-ranked one is missing" — a ranking failure that is not
      // one. The 30 nearest matches for "artifact use" are now filled out with DM, memory,
      // voice, and schedule controls that are not about artifacts either, so neither of
      // the two items being compared was in it. 200 matches the other findControls tests
      // in this file and lets the ordering assertion below mean what it says.
      limit: 200
    })

    const ids = result.results.map((item) => item.controlId)
    const typedUseIndex = ids.indexOf('use.artifact.demo-artifact')
    const perInstanceIndex = ids.indexOf('artifact.artifact_123.action.run.run')

    expect(typedUseIndex).toBeGreaterThanOrEqual(0)
    expect(perInstanceIndex).toBeGreaterThanOrEqual(0)
    expect(typedUseIndex).toBeLessThan(perInstanceIndex)
  })

  it('keeps use.artifact.* discoverable under default limit pressure for artifact-use queries', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const buildArtifact = (index: number) => ({
      id: `artifact_${index}`,
      user_id: 'user-1',
      name: index === 1 ? 'Demo Artifact' : `Demo Artifact ${index}`,
      slug: index === 1 ? 'demo-artifact' : `demo-artifact-${index}`,
      mode: 'published',
      zone: 'panel',
      zone_compatibility: {
        profile: 'multi-zone',
        primaryZone: 'panel',
        compatibleZones: ['panel', 'header'],
        fitReport: {
          panel: { status: 'fit' },
          header: { status: 'fit' },
          trigger: { status: 'blocked', note: 'Not supported.' }
        }
      },
      agent_allowlist: ['agent-1'],
      metadata: {
        fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
      },
      created_at: '2026-02-22T00:00:00.000Z',
      updated_at: '2026-02-22T00:00:00.000Z'
    })

    mockArtifactService.listByUser.mockResolvedValue(Array.from({ length: 6 }, (_, idx) => buildArtifact(idx + 1)))

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact use',
      includeDraft: true,
      limit: 20
    })

    expect(result.results.some((entry) => entry.controlId === 'use.artifact.demo-artifact')).toBe(true)
  })

  it('keeps core sys.* controls before non-core controls after relevance sorting', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact',
      includeDraft: true,
      limit: 50
    })

    let seenNonCore = false
    for (const row of result.results) {
      if (row.controlId.startsWith('sys.')) {
        expect(seenNonCore).toBe(false)
      } else {
        seenNonCore = true
      }
    }
  })

  it('enforces risk approval for restricted artifact controls', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.rollback',
      input: {
        artifactId: 'artifact_123',
        targetVersion: 1
      }
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
  })

  it('DL-116-04: one click covers one action, and leaves no window behind it', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // Until SA-116 an approved risky control wrote `control_risk_approval:{user}:{agent}:
    // {controlId}` with a five-minute TTL, and the next call of that control ran with no
    // card at all. Approving "roll artifact A back" therefore also approved rolling it back
    // again, and approving "delete memory X" approved deleting memory Y.
    const approved = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.artifact.rollback',
      input: { artifactId: 'artifact_123', targetVersion: 1 }
    })
    expect(approved.success).toBe(true)
    expect(mockArtifactService.rollbackToVersion).toHaveBeenCalledTimes(1)

    // Nothing unscoped is written any more...
    expect(riskWindowKeysWritten()).toEqual([])

    // ...and even if a stale marker were sitting in Redis, no unscoped read looks for one.
    mockRedisGet.mockResolvedValue('cached-risk-approval')
    const second = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.rollback',
      input: { artifactId: 'artifact_123', targetVersion: 1 }
    })
    expect(second.success).toBe(false)
    if (second.success) return
    expect(second.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockArtifactService.rollbackToVersion).toHaveBeenCalledTimes(1)
  })

  it('F-P1-2: a dry run on a risky control costs no click and writes no record', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // P1 left the `dryRun` return BELOW the gate, so the model's natural preflight
    // ("dry-run, then ask") raised a card for a call that runs nothing — two clicks per
    // action, which is the friction that makes people ask for the blanket window this story
    // removed. Nobody clicks Approve anywhere in this test.
    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.artifact.rollback',
      input: {
        artifactId: 'artifact_123',
        targetVersion: 1
      },
      dryRun: true
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.dryRun).toBe(true)
    expect(result.result).toEqual({ validated: true })
    expect(approvalRecordsWritten()).toEqual([])
    expect(mockArtifactService.rollbackToVersion).not.toHaveBeenCalled()
  })

  it('F-P1-2: a dry run still validates its input before returning', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // The `dryRun` return moved ABOVE the gate but stays BELOW validation (AMD-116-04). A
    // dry run whose input does not parse must still say so — that is what a dry run is for.
    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.artifact.rollback',
      input: { artifactId: 'artifact_123' },
      dryRun: true
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_INPUT_INVALID')
    expect(approvalRecordsWritten()).toEqual([])
  })

  it('a real (non-dry) run of the same risky control still pauses for a card', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const paused = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      controlId: 'sys.artifact.rollback',
      input: { artifactId: 'artifact_123', targetVersion: 1 }
    })

    expect(paused.success).toBe(false)
    if (paused.success) return
    expect(paused.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(approvalRecordsWritten().length).toBeGreaterThan(0)
  })

  it('executes sys.artifact.create without allowRisky (safe lifecycle control)', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.create',
      input: {
        name: 'Demo Artifact',
        content: '<div>Hello</div>'
      }
    })

    expect(result.success).toBe(true)
    expect(mockArtifactService.create).toHaveBeenCalledWith('user-1', {
      name: 'Demo Artifact',
      content: '<div>Hello</div>'
    })
  })

  it.each([
    [
      'sys.artifact.update',
      {
        artifactId: 'artifact_123',
        content: '<div>Updated</div>'
      }
    ],
    [
      'sys.artifact.validate_structure',
      {
        artifactId: 'artifact_123'
      }
    ],
    [
      'sys.artifact.apply_patch',
      {
        artifactId: 'artifact_123',
        patch: `*** Begin Patch
*** Update File: artifact.html
@@
-<div>Hello</div>
+<div>Updated</div>
*** End Patch`
      }
    ],
    [
      'sys.artifact.publish',
      {
        artifactId: 'artifact_123',
        publish: true
      }
    ]
  ] as const)('executes %s without allowRisky (safe lifecycle control)', async (controlId, input) => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId,
      input
    })

    expect(result.success).toBe(true)
  })

  it('executes sys.artifact.validate_structure via ArtifactsService and returns validation details', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.validate_structure',
      input: {
        artifactId: 'artifact_123',
        content: '<div>Preview</div>'
      }
    })

    expect(mockArtifactService.validateStructure).toHaveBeenCalledWith('user-1', {
      artifactId: 'artifact_123',
      content: '<div>Preview</div>',
      metadata: undefined,
      mode: undefined
    })
    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).valid).toBe(true)
    expect((result.result as any).validation).toMatchObject({
      artifactId: 'artifact_123',
      usesBuilderKit: true
    })
  })

  it('searches the model catalog with artifact-ready provider, developer, and model ID guidance', async () => {
    mockFetchVercelModelCatalog.mockResolvedValueOnce({
      fetchedAt: '2026-06-06T00:00:00.000Z',
      models: [
        {
          id: 'google/gemini-3.1-flash-image',
          canonicalId: 'google/gemini-3.1-flash-image',
          provider: 'google',
          upstreamProvider: 'google',
          name: 'gemini-3.1-flash-image',
          displayName: 'Gemini 3.1 Flash Image',
          description: 'Image generation model.',
          tags: ['gemini', 'image', 'nano-banana'],
          contextWindow: 128000,
          maxOutputTokens: 8192,
          features: { vision: true, imageGeneration: true },
          purpose: 'visual',
          idVariants: {
            'vercel-gateway': {
              developerId: 'google',
              modelId: 'gemini-3.1-flash-image',
              effectiveId: 'google/gemini-3.1-flash-image',
              source: 'vercel'
            },
            'direct:google': {
              developerId: 'google',
              modelId: 'gemini-3.1-flash-image',
              effectiveId: 'gemini-3.1-flash-image',
              source: 'direct'
            }
          },
          source: 'vercel',
          transport: 'vercel-gateway',
          connectionId: 'vercel-gateway',
          availableConnections: ['vercel-gateway', 'direct:google']
        },
        {
          id: 'fal-ai/gemini-3.1-flash-image-preview/edit',
          provider: 'google',
          upstreamProvider: 'google',
          name: 'gemini-3.1-flash-image-preview/edit',
          displayName: 'Gemini 3.1 Flash Image Preview',
          tags: ['gemini', 'image'],
          features: { vision: true, imageGeneration: true },
          purpose: 'visual',
          idVariants: {
            'direct:fal': {
              developerId: 'google',
              modelId: 'gemini-3.1-flash-image-preview/edit',
              effectiveId: 'fal-ai/gemini-3.1-flash-image-preview/edit',
              source: 'direct'
            }
          },
          source: 'direct',
          transport: 'direct',
          connectionId: 'direct:fal',
          availableConnections: ['direct:fal']
        },
        {
          id: 'openai/gpt-5.5',
          provider: 'openai',
          name: 'gpt-5.5',
          displayName: 'GPT-5.5',
          tags: ['chat'],
          features: {},
          purpose: 'chat',
          idVariants: {
            'direct:openai': {
              developerId: 'openai',
              modelId: 'gpt-5.5',
              effectiveId: 'gpt-5.5',
              source: 'direct'
            }
          },
          source: 'direct',
          transport: 'direct',
          connectionId: 'direct:openai',
          availableConnections: ['direct:openai']
        }
      ]
    })

    const { useControl } = await import('../services/fabricRegistry')
    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.model_catalog.search',
      input: {
        query: 'Nano Banana 2',
        provider: 'google',
        purpose: 'visual',
        limit: 5
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(mockFetchVercelModelCatalog).toHaveBeenCalledWith(false)
    expect((result.result as any).results).toHaveLength(1)
    expect((result.result as any).results[0]).toMatchObject({
      developer: 'google',
      catalogModelId: 'gemini-3.1-flash-image',
      modelIdForArtifact: 'gemini-3.1-flash-image',
      artifact: {
        runtime: {
          model: 'gemini-3.1-flash-image',
          purpose: 'visual',
          outputKind: 'image',
          connection: {
            id: 'direct:google',
            type: 'direct',
            service: 'google'
          },
          savedApiKeyService: 'google'
        },
        mustInclude: expect.arrayContaining([
          expect.stringContaining('model_config'),
          expect.stringContaining('generatedFileCount')
        ])
      }
    })
    expect((result.result as any).guidance.artifactModelConfig).toEqual({
      mode: 'basic',
      primary: {
        source: 'manual',
        modelId: 'gemini-3.1-flash-image'
      }
    })
    expect((result.result as any).guidance.artifactRuntimeRequirements).toMatchObject({
      model: 'gemini-3.1-flash-image',
      purpose: 'visual',
      outputKind: 'image'
    })
  })

  it('matches canonical Z.ai developer searches without rewriting the selected runtime ID', async () => {
    mockFetchVercelModelCatalog.mockResolvedValueOnce({
      fetchedAt: '2026-09-01T00:00:00.000Z',
      models: [
        {
          id: 'zai/glm-5.3',
          canonicalId: 'zai/glm-5.3',
          provider: 'zai',
          upstreamProvider: 'deepinfra',
          name: 'glm-5.3',
          displayName: 'GLM-5.3',
          tags: ['chat', 'reasoning'],
          features: { reasoning: true },
          purpose: 'chat',
          idVariants: {
            'direct:deepinfra': {
              developerId: 'zai-org',
              modelId: 'GLM-5.3',
              effectiveId: 'zai-org/GLM-5.3',
              source: 'direct'
            }
          },
          source: 'direct',
          transport: 'direct',
          connectionId: 'direct:deepinfra',
          availableConnections: ['direct:deepinfra']
        }
      ]
    })

    const { useControl } = await import('../services/fabricRegistry')
    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.model_catalog.search',
      input: {
        developer: 'z-ai',
        provider: 'deepinfra',
        modelId: 'glm-5.3'
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).results[0]).toMatchObject({
      canonicalDeveloper: 'zai',
      developer: 'zai-org',
      modelIdForArtifact: 'zai-org/GLM-5.3'
    })
  })

  it('executes sys.artifact.create via ArtifactsService (no legacy MCP adapter)', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.artifact.create',
      input: {
        name: 'Demo Artifact',
        content: '<div>Hello</div>'
      },
      actorType: 'service'
    })

    expect(mockArtifactService.create).toHaveBeenCalledWith('user-1', {
      name: 'Demo Artifact',
      content: '<div>Hello</div>'
    })
    expect(mockLoadToolsForUser).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
  })

  it('returns compact artifact summaries for lifecycle write controls', async () => {
    mockArtifactService.update.mockResolvedValueOnce({
      id: 'artifact_123',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      type: 'html',
      mode: 'published',
      zone: 'panel',
      version: 3,
      content: '<div>Updated</div>',
      versions: [
        {
          id: 'v1',
          version: 1,
          content: '<div>Old</div>',
          created_at: '2026-03-05T00:00:00.000Z',
          created_by: 'user-1'
        }
      ],
      brain_type: 'built_in',
      agent_use_enabled: true,
      blueprint: 'Build notes',
      updated_at: '2026-03-05T00:00:00.000Z',
      published_at: '2026-03-05T00:00:00.000Z'
    })

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.update',
      input: {
        artifactId: 'artifact_123',
        content: '<div>Updated</div>'
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).artifactView).toBe('summary')
    expect((result.result as any).artifact).toMatchObject({
      id: 'artifact_123',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      version: 3,
      versionCount: 1,
      contentChars: '<div>Updated</div>'.length,
      hasBlueprint: true,
      webhookConfigured: false
    })
    expect((result.result as any).artifact.content).toBeUndefined()
    expect((result.result as any).artifact.versions).toBeUndefined()
    expect((result.result as any).contentChanged).toBe(true)
    expect((result.result as any).diff).toContain('--- Before')
    expect((result.result as any).diff).toContain('+++ After')
    expect((result.result as any).diff).toContain('-   1 | <div>Old</div>')
    expect((result.result as any).diff).toContain('+   1 | <div>Updated</div>')
  })

  it('labels metadata-only artifact updates without claiming a content diff', async () => {
    mockArtifactService.update.mockResolvedValueOnce({
      id: 'artifact_123',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      type: 'html',
      mode: 'published',
      zone: 'panel',
      version: 3,
      content: '<div>Unchanged</div>',
      versions: [],
      brain_type: 'built_in',
      updated_at: '2026-03-05T00:00:00.000Z',
      published_at: '2026-03-05T00:00:00.000Z'
    })

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.update',
      input: {
        artifactId: 'artifact_123',
        model_config: {
          mode: 'basic',
          primary: {
            source: 'manual',
            modelId: 'gemini-3.1-flash-image'
          }
        }
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).contentChanged).toBe(false)
    expect((result.result as any).diff).toBeUndefined()
    expect((result.result as any).artifactUpdate).toMatchObject({
      kind: 'model_config',
      contentChanged: false,
      updatedFields: ['model_config']
    })
  })

  it('executes sys.artifact.apply_patch via ArtifactsService and keeps the response compact', async () => {
    const patch = `*** Begin Patch
*** Update File: artifact.html
@@
-<div>Hello</div>
+<div>Patched</div>
*** End Patch`

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.apply_patch',
      input: {
        artifactId: 'artifact_123',
        patch,
        versionDescription: 'Patched markup'
      }
    })

    expect(mockArtifactService.applyPatch).toHaveBeenCalledWith(
      'artifact_123',
      'user-1',
      patch,
      expect.objectContaining({
        versionDescription: 'Patched markup'
      })
    )
    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).artifactView).toBe('summary')
    expect((result.result as any).artifact).toMatchObject({
      id: 'artifact_123',
      slug: 'demo-artifact',
      version: 2,
      versionCount: 2,
      contentChars: '<div>Patched</div>'.length
    })
    expect((result.result as any).artifact.content).toBeUndefined()
  })

  it('keeps sys.artifact.get detailed but trims historical version bodies by default', async () => {
    mockArtifactService.getAccessible.mockResolvedValueOnce({
      id: 'artifact_123',
      user_id: 'user-1',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      type: 'html',
      content: '<div>Current</div>',
      mode: 'edit',
      version: 2,
      description: '',
      tags: [],
      metadata: {},
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-05T00:00:00.000Z',
      published_at: null,
      versions: [
        {
          id: 'v1',
          version: 1,
          content: '<div>Old</div>',
          description: 'Initial version',
          created_at: '2026-03-04T00:00:00.000Z',
          created_by: 'user-1'
        },
        {
          id: 'v2',
          version: 2,
          content: '<div>Current</div>',
          description: 'Updated version',
          created_at: '2026-03-05T00:00:00.000Z',
          created_by: 'user-1'
        }
      ]
    })

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.get',
      input: {
        artifactId: 'artifact_123'
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).artifactView).toBe('detail')
    expect((result.result as any).artifact.content).toBe('<div>Current</div>')
    expect((result.result as any).artifact.contentChars).toBe('<div>Current</div>'.length)
    expect((result.result as any).artifact.versionCount).toBe(2)
    expect((result.result as any).artifact.versions).toEqual([
      expect.objectContaining({
        id: 'v1',
        version: 1,
        contentChars: '<div>Old</div>'.length
      }),
      expect.objectContaining({
        id: 'v2',
        version: 2,
        contentChars: '<div>Current</div>'.length
      })
    ])
    expect((result.result as any).artifact.versions[0].content).toBeUndefined()
  })

  it('allows sys.artifact.get to include historical version bodies when explicitly requested', async () => {
    mockArtifactService.getAccessible.mockResolvedValueOnce({
      id: 'artifact_123',
      user_id: 'user-1',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      type: 'html',
      content: '<div>Current</div>',
      mode: 'edit',
      version: 2,
      description: '',
      tags: [],
      metadata: {},
      created_at: '2026-03-05T00:00:00.000Z',
      updated_at: '2026-03-05T00:00:00.000Z',
      published_at: null,
      versions: [
        {
          id: 'v1',
          version: 1,
          content: '<div>Old</div>',
          description: 'Initial version',
          created_at: '2026-03-04T00:00:00.000Z',
          created_by: 'user-1'
        }
      ]
    })

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.get',
      input: {
        artifactId: 'artifact_123',
        includeVersionContents: true
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect((result.result as any).artifact.versions[0].content).toBe('<div>Old</div>')
  })

  it('executes per-instance artifact run control without dynamic MCP tool lookup', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        `${JSON.stringify({ type: 'chunk', content: 'hello' })}\n${JSON.stringify({ type: 'finish', content: ' world', usage: { outputTokens: 2 } })}\n`,
        { status: 200 }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.action.run.run',
      input: {
        prompt: 'Generate status summary'
      },
      actorType: 'session'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:5620/api/artifacts/complete',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'x-batshit-token': 'test-batshit-token'
        })
      })
    )
    expect(mockLoadToolsForUser).not.toHaveBeenCalled()
    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.result).toMatchObject({
      success: true,
      text: 'hello world'
    })
  })

  it('rewrites loopback artifact completion URLs to the app container port in Docker', async () => {
    mockPrivateEnv.values.BATSHIT_CONTAINERIZED = '1'
    mockPrivateEnv.values.PORT = '3000'
    mockPrivateEnv.values.BATSHIT_ARTIFACT_COMPLETE_URL = 'http://localhost:5613/api/artifacts/complete'

    const fetchMock = vi.fn().mockResolvedValue(
      new Response(`${JSON.stringify({ type: 'finish', content: 'ok' })}\n`, { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.action.run.run',
      input: {
        prompt: 'Generate status summary'
      },
      actorType: 'session'
    })

    expect(fetchMock).toHaveBeenCalledWith(
      'http://127.0.0.1:3000/api/artifacts/complete',
      expect.objectContaining({
        method: 'POST'
      })
    )
    expect(result.success).toBe(true)
  })

  it('captures artifact file events and auto-shares to chat without leaking base64 in control results', async () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://localhost:5620/api/artifacts/complete') {
        const ndjson = [
          JSON.stringify({ type: 'file', base64: imageDataUrl, mediaType: 'image/png', index: 0 }),
          JSON.stringify({ type: 'finish', usage: { outputTokens: 1 } }),
          JSON.stringify({ type: 'end', metadata: { usage: { outputTokens: 1 } } })
        ].join('\n')
        return new Response(`${ndjson}\n`, { status: 200 })
      }

      if (url === 'http://localhost:5620/api/artifacts/share') {
        const payload = JSON.parse(String(init?.body ?? '{}'))
        expect(payload.sessionId).toBe('sess_1')
        expect(payload.initiator).toBe('agent')
        expect(payload.content).toBe(imageDataUrl)
        return new Response(JSON.stringify({ success: true, clipId: 'clip_123', messageId: 'msg_123' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'sess_1',
      controlId: 'artifact.artifact_123.action.run.run',
      input: {
        prompt: 'Generate an image'
      },
      actorType: 'session'
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.result).toMatchObject({
      success: true,
      generatedFileCount: 1,
      generatedFiles: [{ mediaType: 'image/png', index: 0 }],
      autoShare: {
        success: true,
        clipId: 'clip_123',
        messageId: 'msg_123'
      }
    })
    expect(JSON.stringify(result.result)).not.toContain(imageDataUrl)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('captures typed artifact file events and auto-shares agent output to chat', async () => {
    const imageDataUrl = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAAB'
    const typedArtifact = {
      id: 'artifact_123',
      user_id: 'user-1',
      name: 'Demo Artifact',
      slug: 'demo-artifact',
      mode: 'published',
      zone: 'panel',
      agent_use_enabled: true,
      agent_access_scope: 'all',
      metadata: {
        fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
      },
      created_at: '2026-02-22T00:00:00.000Z',
      updated_at: '2026-02-22T00:00:00.000Z'
    }
    mockArtifactService.listByUser.mockResolvedValueOnce([typedArtifact])
    mockArtifactService.getAccessible.mockResolvedValueOnce(typedArtifact)

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://localhost:5620/api/artifacts/complete') {
        const payload = JSON.parse(String(init?.body ?? '{}'))
        expect(payload.sessionId).toBe('sess_1')
        expect(payload.prompt).toBe('Generate a tiny banana astronaut')
        expect(payload.fields).toEqual({ prompt: 'Generate a tiny banana astronaut' })

        const ndjson = [
          JSON.stringify({ type: 'file', base64: imageDataUrl, mediaType: 'image/png', index: 0 }),
          JSON.stringify({ type: 'finish', usage: { outputTokens: 1 } }),
          JSON.stringify({ type: 'end', metadata: { usage: { outputTokens: 1 } } })
        ].join('\n')
        return new Response(`${ndjson}\n`, { status: 200 })
      }

      if (url === 'http://localhost:5620/api/artifacts/share') {
        const payload = JSON.parse(String(init?.body ?? '{}'))
        expect(payload.sessionId).toBe('sess_1')
        expect(payload.initiator).toBe('agent')
        expect(payload.artifactName).toBe('Demo Artifact')
        expect(payload.content).toBe(imageDataUrl)
        return new Response(JSON.stringify({ success: true, clipId: 'clip_456', messageId: 'msg_456' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        })
      }

      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'sess_1',
      controlId: 'use.artifact.demo-artifact',
      input: {
        prompt: 'Generate a tiny banana astronaut'
      },
      actorType: 'session'
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.result).toMatchObject({
      success: true,
      artifactId: 'artifact_123',
      slug: 'demo-artifact',
      generatedFileCount: 1,
      generatedFiles: [{ mediaType: 'image/png', index: 0 }],
      autoShare: {
        success: true,
        clipId: 'clip_456',
        messageId: 'msg_456'
      },
      fieldsApplied: {
        prompt: 'Generate a tiny banana astronaut'
      }
    })
    expect(JSON.stringify(result.result)).not.toContain(imageDataUrl)
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it('maps typed image artifact fields to structured completion image inputs and options', async () => {
    const sourceImageDataUrl = 'data:image/png;base64,c291cmNlLWltYWdl'
    const typedArtifact = {
      id: 'artifact_123',
      user_id: 'user-1',
      name: 'Grok Imagine Quality Generator',
      slug: 'grok-imagine-quality-generator',
      mode: 'published',
      zone: 'panel',
      agent_use_enabled: true,
      agent_access_scope: 'all',
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'grok-imagine-image-quality'
        }
      },
      metadata: {
        fabric_fields: [
          { fabricId: 'prompt', type: 'textarea', label: 'Prompt' },
          { fabricId: 'source-image-1-url', type: 'text', label: 'Source image 1' },
          { fabricId: 'source-image-2-url', type: 'text', label: 'Source image 2' },
          { fabricId: 'image-count', type: 'number', label: 'Images' },
          { fabricId: 'aspect-ratio', type: 'select', label: 'Aspect ratio' },
          { fabricId: 'resolution', type: 'select', label: 'Resolution' },
          { fabricId: 'style-hint', type: 'select', label: 'Style' }
        ]
      },
      created_at: '2026-02-22T00:00:00.000Z',
      updated_at: '2026-02-22T00:00:00.000Z'
    }
    mockArtifactService.listByUser.mockResolvedValueOnce([typedArtifact])
    mockArtifactService.getAccessible.mockResolvedValueOnce(typedArtifact)

    const fetchMock = vi.fn().mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      if (url === 'http://localhost:5620/api/artifacts/complete') {
        const payload = JSON.parse(String(init?.body ?? '{}'))
        expect(payload.prompt).toBe('Render this as a pencil sketch')
        expect(payload.fields).toEqual({
          prompt: 'Render this as a pencil sketch',
          'style-hint': 'Pencil sketch'
        })
        expect(payload.images).toEqual([
          {
            data: sourceImageDataUrl,
            mediaType: 'image/png'
          },
          {
            url: 'https://docs.x.ai/assets/api-examples/images/style-realistic.png'
          }
        ])
        expect(payload.n).toBe(2)
        expect(payload.aspectRatio).toBe('3:2')
        expect(payload.providerOptions).toEqual({ xai: { resolution: '2k' } })

        return new Response(`${JSON.stringify({ type: 'finish', usage: { outputTokens: 1 } })}\n`, {
          status: 200
        })
      }

      throw new Error(`Unexpected URL: ${url}`)
    })
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'sess_1',
      controlId: 'use.artifact.grok-imagine-quality-generator',
      input: {
        prompt: 'Render this as a pencil sketch',
        'source-image-1-url': sourceImageDataUrl,
        'source-image-2-url': 'https://docs.x.ai/assets/api-examples/images/style-realistic.png',
        'image-count': 2,
        'aspect-ratio': '3:2',
        resolution: '2k',
        'style-hint': 'Pencil sketch'
      },
      actorType: 'session'
    })

    expect(result.success).toBe(true)
    if (!result.success) return

    expect(result.result).toMatchObject({
      success: true,
      fieldsApplied: {
        prompt: 'Render this as a pencil sketch',
        'source-image-1-url': `[image data URI ${sourceImageDataUrl.length} chars]`,
        'source-image-2-url': 'https://docs.x.ai/assets/api-examples/images/style-realistic.png',
        'image-count': 2,
        'aspect-ratio': '3:2',
        resolution: '2k',
        'style-hint': 'Pencil sketch'
      }
    })
    expect(JSON.stringify(result.result)).not.toContain(sourceImageDataUrl)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it('records control audit entries with actor/risk metadata', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.list',
      actorType: 'service'
    })

    expect(mockRedisExecute).toHaveBeenCalled()
    expect(mockRedisJsonSet).toHaveBeenCalledWith(
      expect.stringMatching(/^control_audit:user-1:/),
      '$',
      expect.objectContaining({
        userId: 'user-1',
        actorType: 'service',
        controlId: 'sys.artifact.list',
        success: true,
        riskLevel: 'safe'
      })
    )
    expect(mockRedisLPush).toHaveBeenCalledWith(
      'recent_control_executions:user-1',
      expect.stringMatching(/^control_audit:user-1:/)
    )
  })

  it('SA-117 DL-117-10: names the acting agent and the run credential on the agent lane', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.list',
      actorType: 'agent',
      agentId: 'agent-cooper',
      sessionId: 'sess-1',
      credentialId: 'arc_abc123'
    })

    // "Which agent acted" has to be RECORDED to be true, and `credentialId` is what says the
    // `agentId` beside it was bound by the server rather than claimed by the request body.
    expect(mockRedisJsonSet).toHaveBeenCalledWith(
      expect.stringMatching(/^control_audit:user-1:/),
      '$',
      expect.objectContaining({
        actorType: 'agent',
        agentId: 'agent-cooper',
        sessionId: 'sess-1',
        credentialId: 'arc_abc123'
      })
    )
  })

  it('SA-117 DL-117-10: writes a null credential on every lane that has none', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    await useControl({
      userId: 'user-1',
      controlId: 'sys.artifact.list',
      actorType: 'service',
      agentId: 'agent-cooper'
    })

    // `null`, never absent: a reader must be able to tell "no credential" from a field that a
    // future writer forgot, and on this lane the `agentId` above is body text.
    expect(mockRedisJsonSet).toHaveBeenCalledWith(
      expect.stringMatching(/^control_audit:user-1:/),
      '$',
      expect.objectContaining({ actorType: 'service', credentialId: null })
    )
  })

  it('publishes sys.voice.engine.* controls in findControls without includeDraft', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'sys.voice.engine.',
      limit: 20
    })

    const ids = result.results
      .filter((item) => item.controlId.startsWith('sys.voice.engine.'))
      .map((item) => item.controlId)
      .sort()

    expect(ids).toEqual([
      'sys.voice.engine.complete_local_setup',
      'sys.voice.engine.delete',
      'sys.voice.engine.enable',
      'sys.voice.engine.health_check',
      'sys.voice.engine.model.delete',
      'sys.voice.engine.model.download',
      'sys.voice.engine.model.use',
      'sys.voice.engine.register',
      'sys.voice.engine.update'
    ])
  })

  it('matches voice-engine control queries that include punctuation separators', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const result = await findControls({
      query: 'voice-engine register',
      limit: 20
    })

    const ids = result.results.map((item) => item.controlId)
    expect(ids).toContain('sys.voice.engine.register')
  })

  it('scopes dynamic artifact controls to assigned agents in findControls', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    const assigned = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact.artifact_123.',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })
    const unassigned = await findControls({
      userId: 'user-1',
      agentId: 'agent-2',
      query: 'artifact.artifact_123.',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(assigned.results.some((entry) => entry.controlId === 'artifact.artifact_123.field.details.get')).toBe(
      true
    )
    expect(unassigned.results.some((entry) => entry.controlId.startsWith('artifact.artifact_123.'))).toBe(false)
  })

  it('hides dynamic artifact controls when agent_use_enabled is false', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Demo Artifact',
        slug: 'demo-artifact',
        mode: 'edit',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_use_enabled: false,
        agent_allowlist: ['agent-1'],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact.artifact_123.',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId.startsWith('artifact.artifact_123.'))).toBe(false)
    expect(result.results.some((entry) => entry.controlId === 'use.artifact.demo-artifact')).toBe(false)
  })

  it('hides dynamic artifact controls when agent_use_enabled is true with empty allowlist', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Demo Artifact',
        slug: 'demo-artifact',
        mode: 'edit',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_use_enabled: true,
        agent_allowlist: [],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact.artifact_123.',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId.startsWith('artifact.artifact_123.'))).toBe(false)
    expect(result.results.some((entry) => entry.controlId === 'use.artifact.demo-artifact')).toBe(false)
  })

  it('shows dynamic artifact controls to any agent when access scope is all', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Demo Artifact',
        slug: 'demo-artifact',
        mode: 'edit',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_use_enabled: true,
        agent_access_scope: 'all',
        agent_allowlist: [],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-2',
      query: 'artifact.artifact_123.',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId === 'artifact.artifact_123.field.details.get')).toBe(
      true
    )
  })

  it('hides published agent-usable artifacts without fabric_fields unless run_only=true', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Untyped Artifact',
        slug: 'untyped-artifact',
        mode: 'published',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_use_enabled: true,
        agent_allowlist: ['agent-1'],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId === 'use.artifact.untyped-artifact')).toBe(false)
    expect(result.results.some((entry) => entry.controlId.startsWith('artifact.artifact_123.'))).toBe(false)
  })

  it('registers use.artifact.* for run_only artifacts without fabric_fields', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Run Only Artifact',
        slug: 'run-only-artifact',
        mode: 'published',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_use_enabled: true,
        agent_allowlist: ['agent-1'],
        metadata: {
          run_only: true
        },
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'run only artifact',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId === 'use.artifact.run-only-artifact')).toBe(true)
  })

  it('hides user-only HuggingFace embeds from artifact runtime tools even with stale agent-use settings', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_hf_embed',
        user_id: 'user-1',
        name: 'HF Embed',
        slug: 'hf-embed',
        mode: 'published',
        zone: 'panel',
        brain_type: 'none',
        ai_enabled: false,
        agent_use_enabled: true,
        agent_access_scope: 'all',
        agent_allowlist: [],
        metadata: {
          source_type: 'huggingface',
          fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
        },
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'hf embed',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId === 'use.artifact.hf-embed')).toBe(false)
    expect(result.results.some((entry) => entry.controlId.startsWith('artifact.artifact_hf_embed.'))).toBe(false)
  })

  it('hides ComfyUI panel artifacts from artifact runtime tools even with stale agent-use settings', async () => {
    const { findControls } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValueOnce([
      {
        id: 'artifact_comfyui_panel',
        user_id: 'user-1',
        name: 'ComfyUI Panel',
        slug: 'comfyui-panel',
        mode: 'published',
        zone: 'panel',
        brain_type: 'none',
        ai_enabled: false,
        agent_use_enabled: true,
        agent_access_scope: 'all',
        agent_allowlist: [],
        metadata: {
          source_type: 'comfyui',
          fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
        },
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'comfyui panel',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 200
    })

    expect(result.results.some((entry) => entry.controlId === 'use.artifact.comfyui-panel')).toBe(false)
    expect(result.results.some((entry) => entry.controlId.startsWith('artifact.artifact_comfyui_panel.'))).toBe(false)
  })

  it('supports find->use parity for dynamic artifact control IDs', async () => {
    const { findControls, useControl } = await import('../services/fabricRegistry')

    const discovered = await findControls({
      userId: 'user-1',
      agentId: 'agent-1',
      query: 'artifact.artifact_123.field.details.get',
      sourceType: 'artifact',
      includeDraft: true,
      limit: 10
    })

    const dynamicId = discovered.results.find((entry) =>
      entry.controlId === 'artifact.artifact_123.field.details.get'
    )?.controlId

    expect(dynamicId).toBe('artifact.artifact_123.field.details.get')
    if (!dynamicId) return

    const executed = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: dynamicId
    })

    expect(executed.success).toBe(true)
  })

  it('resolves unambiguous dynamic artifact control suffixes to canonical control IDs', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'field.details.get'
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.controlId).toBe('artifact.artifact_123.field.details.get')
  })

  it('passes dynamic MCP projectPath into gateway discovery', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    mockLoadToolsForUser.mockResolvedValue({
      tools: {
        read_text_file: {
          description: 'Read a text file'
        }
      },
      metadata: new Map()
    })

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'sys.mcp.dynamic.find',
      input: {
        query: 'read file',
        projectPath: '/Users/example/batshit'
      }
    })

    expect(result.success).toBe(true)
    expect(mockLoadToolsForUser).toHaveBeenLastCalledWith('user-1', [], undefined, {
      skipFiltering: true,
      projectPath: '/Users/example/batshit'
    })
  })

  it('filters Fabric dynamic MCP find/use through agent DCM visibility', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    const hiddenExecute = vi.fn().mockResolvedValue({ ok: true })

    mockResolveDynamicMcpGatewayScope.mockResolvedValue({
      resolvedGateways: ['gw_ctx'],
      defaultGateways: null,
      source: 'agent'
    })
    mockLoadToolsForUser.mockResolvedValue({
      tools: {
        visible_tool: {
          description: 'Visible tool'
        },
        hidden_tool: {
          description: 'Hidden tool',
          execute: hiddenExecute
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
            mcpServerName: 'hidden_group',
            originalToolName: 'hidden_tool'
          }
        ]
      ])
    })
    mockRedisGet.mockImplementation(async (key: string) => {
      if (key === 'agent:agent-1') {
        return {
          dcmDisplaySettings: {
            version: 1,
            groups: {
              'gw_ctx::hidden_group': 'hidden'
            },
            tools: {
              'gw_ctx::hidden_tool': 'hidden'
            }
          }
        }
      }
      return null
    })

    const findResult = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'sys.mcp.dynamic.find',
      input: {
        query: 'tool'
      }
    })

    expect(findResult.success).toBe(true)
    expect(findResult.result.results.map((entry: any) => entry.toolName)).toEqual(['visible_tool'])

    const useResult = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'sys.mcp.dynamic.use',
      input: {
        toolName: 'hidden_tool'
      }
    })

    expect(useResult.success).toBe(false)
    expect(String(useResult.error?.message)).toMatch(/hidden_tool.*not found/i)
    expect(hiddenExecute).not.toHaveBeenCalled()
  })

  it('returns a candidate list when dynamic artifact control suffix is ambiguous', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    mockArtifactService.listByUser.mockResolvedValue([
      {
        id: 'artifact_123',
        user_id: 'user-1',
        name: 'Demo Artifact',
        slug: 'demo-artifact',
        mode: 'edit',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_allowlist: ['agent-1'],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      },
      {
        id: 'artifact_456',
        user_id: 'user-1',
        name: 'Second Artifact',
        slug: 'second-artifact',
        mode: 'edit',
        zone: 'panel',
        zone_compatibility: {
          profile: 'multi-zone',
          primaryZone: 'panel',
          compatibleZones: ['panel', 'header'],
          fitReport: {
            panel: { status: 'fit' },
            header: { status: 'fit' },
            trigger: { status: 'blocked', note: 'Not supported.' }
          }
        },
        agent_allowlist: ['agent-1'],
        metadata: {},
        created_at: '2026-02-22T00:00:00.000Z',
        updated_at: '2026-02-22T00:00:00.000Z'
      }
    ])

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'field.details.get'
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_NOT_FOUND')
    expect((result.error.details as any)?.candidates).toEqual([
      'artifact.artifact_123.field.details.get',
      'artifact.artifact_456.field.details.get'
    ])
  })

  it('accepts nested value.zone payloads for dynamic artifact zone set', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    mockArtifactService.update.mockImplementation(async (_id: string, _userId: string, updates: any) => ({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'edit',
      zone: updates.zone ?? null,
      zone_compatibility: {
        profile: 'multi-zone',
        primaryZone: updates.zone ?? null,
        compatibleZones: ['header', 'panel', 'trigger'],
        fitReport: {
          header: { status: 'fit' },
          panel: { status: 'fit' },
          trigger: { status: 'fit' }
        }
      }
    }))

    const result = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.field.zone.set',
      input: {
        value: {
          zone: 'header'
        }
      }
    })

    expect(mockArtifactService.update).toHaveBeenCalledWith('artifact_123', 'user-1', {
      zone: 'header'
    })
    expect(result.success).toBe(true)
    if (!result.success) return
    expect((result.result as any)?.artifact?.zone).toBe('header')
  })

  it('accepts alternate zone aliases for dynamic artifact zone set input', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    mockArtifactService.update.mockImplementation(async (_id: string, _userId: string, updates: any) => ({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'edit',
      zone: updates.zone ?? null,
      zone_compatibility: {
        profile: 'multi-zone',
        primaryZone: updates.zone ?? null,
        compatibleZones: ['header', 'panel', 'trigger'],
        fitReport: {
          header: { status: 'fit' },
          panel: { status: 'fit' },
          trigger: { status: 'fit' }
        }
      }
    }))

    const aliasInputs = [
      { input: { targetZone: 'header' }, expectedZone: 'header' },
      { input: { placement: 'panel' }, expectedZone: 'panel' },
      { input: { value: { zoneName: 'trigger' } }, expectedZone: 'trigger' }
    ] as const

    for (const aliasInput of aliasInputs) {
      const result = await useControlWithApproval({
        userId: 'user-1',
        agentId: 'agent-1',
        controlId: 'artifact.artifact_123.field.zone.set',
        input: aliasInput.input
      })

      expect(result.success).toBe(true)
      if (!result.success) continue
      expect((result.result as any)?.artifact?.zone).toBe(aliasInput.expectedZone)
    }
  })

  it('rejects dynamic artifact zone set calls that omit zone input', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockArtifactService.update.mockClear()

    const result = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.field.zone.set',
      input: {}
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_EXECUTION_FAILED')
    expect(result.error.message).toContain('Zone is required')
    expect(mockArtifactService.update).not.toHaveBeenCalled()
  })

  it('sets a dynamic artifact model without approval and stores a manual exact model id', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    mockArtifactService.update.mockResolvedValueOnce({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'published',
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gemini-current-image-model'
        }
      }
    })

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.field.model.set',
      input: { model: 'gemini-current-image-model' }
    })

    expect(mockArtifactService.update).toHaveBeenCalledWith('artifact_123', 'user-1', {
      model: null,
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gemini-current-image-model'
        }
      }
    })
    expect(result.success).toBe(true)
  })

  it('blocks dynamic artifact publish action when no effective zone exists', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockArtifactService.update.mockClear()
    mockArtifactService.getAccessible.mockResolvedValue({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'edit',
      zone: null
    })

    const result = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.action.publish.run',
      input: {}
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_EXECUTION_FAILED')
    expect(result.error.message).toContain('Publish requires a zone selection')
    expect(mockArtifactService.update).not.toHaveBeenCalled()
  })

  it('blocks publish when artifact zone compatibility marks requested zone as blocked', async () => {
    const { useControl } = await import('../services/fabricRegistry')
    mockArtifactService.update.mockClear()
    mockArtifactService.getAccessible.mockResolvedValue({
      id: 'artifact_123',
      name: 'Demo Artifact',
      mode: 'edit',
      zone: 'panel',
      zone_compatibility: {
        profile: 'multi-zone',
        primaryZone: 'panel',
        compatibleZones: ['panel', 'header'],
        fitReport: {
          panel: { status: 'fit' },
          header: { status: 'blocked', note: 'Header publish blocked by compatibility profile.' }
        }
      }
    })

    const result = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'artifact.artifact_123.action.publish.run',
      input: { zone: 'header' }
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_EXECUTION_FAILED')
    expect(result.error.message).toContain('Header publish blocked by compatibility profile.')
    expect((result.error.details as any)?.publish_ready).toBe(false)
    expect((result.error.details as any)?.publish_error).toContain('Choose one of')
    expect(mockArtifactService.update).not.toHaveBeenCalled()
  })

  it('blocks dynamic artifact control use for unassigned agents', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const denied = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-2',
      controlId: 'artifact.artifact_123.field.model.set',
      input: { model: 'gpt-4.1-mini' }
    })

    expect(denied.success).toBe(false)
    if (denied.success) return
    expect(denied.error.code).toBe('CONTROL_NOT_ALLOWED')
  })

  it('executes voice engine register + enable through control registry', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const register = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.register',
      input: {
        engineId: 'Parakeet',
        payload: {
          name: 'Parakeet Engine',
          baseUrl: 'http://localhost:9000',
          ttsPath: '/tts',
          sttPath: '/stt',
          iconRef: { kind: 'lucide', id: 'audio-lines' },
          supports: {
            tts: true,
            stt: true,
            clone: false
          },
          uiSchema: {
            panelTitle: 'Parakeet Controls',
            fields: [
              {
                id: 'stt-language',
                type: 'string',
                label: 'Language',
                path: 'stt.language'
              }
            ]
          }
        }
      }
    })

    expect(register.success).toBe(true)
    expect(mockRedisJsonSet).toHaveBeenCalledWith(
      'voice_engine_registry:user-1',
      '$',
      expect.objectContaining({
        version: 1,
        records: expect.arrayContaining([
          expect.objectContaining({
            id: 'parakeet',
            iconRef: { kind: 'lucide', id: 'audio-lines' }
          })
        ])
      })
    )

    const enable = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.enable',
      input: {
        engineId: 'parakeet',
        enabled: false
      }
    })

    expect(enable.success).toBe(true)
    if (!enable.success) return
    expect(enable.result).toMatchObject({
      engineId: 'parakeet',
      enabled: false
    })
  })

  it('executes local voice-engine completion through control registry', async () => {
    mockCompleteLocalVoiceEngineSetup.mockResolvedValue({
      completed: true,
      blocked: false,
      stage: 'complete',
      engineId: 'chatterbox-local',
      providerId: 'byo:chatterbox-local',
      installRoot: '/Users/example/.batshit/installs/chatterbox-local',
      installOwnership: 'batshit-managed',
      launchCwd: '/Users/example/.batshit/installs/chatterbox-local',
      logPath: '/Users/example/.batshit/runtime/voice-engines/chatterbox-local/logs/local-engine-runtime.log',
      statePath: '/Users/example/.batshit/runtime/voice-engines/chatterbox-local/.batshit-local-engine-setup.json',
      launched: true,
      alreadyRunning: false,
      pid: 4242,
      registered: true,
      enabled: true,
      health: {
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      }
    })

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'chatterbox-local',
        installRoot: '/Users/example/.batshit/installs/chatterbox-local',
        installOwnership: 'batshit-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py']
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.result).toMatchObject({
      completed: true,
      engineId: 'chatterbox-local',
      enabled: true
    })
    expect(mockCompleteLocalVoiceEngineSetup).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        engineId: 'chatterbox-local',
        installRoot: '/Users/example/.batshit/installs/chatterbox-local'
      })
    )
  })

  it('accepts canonical model and voice defaults in local voice completion payloads', async () => {
    mockCompleteLocalVoiceEngineSetup.mockResolvedValue({
      completed: true,
      blocked: false,
      stage: 'complete',
      engineId: 'kokoro',
      providerId: 'byo:kokoro',
      installRoot: '/Users/example/.batshit/installs/kokoro',
      installOwnership: 'batshit-managed',
      launchCwd: '/Users/example/.batshit/installs/kokoro',
      logPath: '/Users/example/.batshit/runtime/voice-engines/kokoro/logs/local-engine-runtime.log',
      statePath: '/Users/example/.batshit/runtime/voice-engines/kokoro/.batshit-local-engine-setup.json',
      launched: true,
      alreadyRunning: false,
      pid: 4810,
      registered: true,
      enabled: true,
      health: {
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      }
    })

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'kokoro',
        installRoot: '/Users/example/.batshit/installs/kokoro',
        installOwnership: 'batshit-managed',
        launch: {
          command: '~/.batshit/tools/mlx-audio/.venv/bin/mlx_audio.server',
          args: ['--host', '127.0.0.1', '--port', '8020']
        },
        payload: {
          name: 'Kokoro (MLX)',
          baseUrl: 'http://127.0.0.1:8020',
          requestFormat: 'openai-compatible',
          supports: {
            tts: true,
            stt: false,
            clone: false
          },
          ttsDefaults: {
            modelId: 'mlx-community/Kokoro-82M-bf16',
            voiceId: 'af_heart'
          },
          sttDefaults: {
            modelId: 'whisper-large-v3'
          }
        }
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(mockCompleteLocalVoiceEngineSetup).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        engineId: 'kokoro',
        payload: expect.objectContaining({
          ttsDefaults: expect.objectContaining({
            modelId: 'mlx-community/Kokoro-82M-bf16',
            voiceId: 'af_heart'
          }),
          sttDefaults: expect.objectContaining({
            modelId: 'whisper-large-v3'
          })
        })
      })
    )
  })

  it('DL-116-04: the chat-text sniffer is gone — typing "go ahead" approves nothing', async () => {
    mockGetSession.mockResolvedValue({
      id: 'session-speech-setup',
      user_id: 'user-1'
    })
    // Until SA-116, `useControl` read the last six user messages for "go ahead", "do it",
    // or a bare "yes" behind an install-topic guard, and a match not only ran the installer
    // but WROTE the five-minute window. Hidden magic, and a sentence in a chat is not a
    // decision the server can prove. The click replaces it.
    mockGetSessionMessages.mockResolvedValue([
      {
        id: 'msg-user-1',
        session_id: 'session-speech-setup',
        user_id: 'user-1',
        role: 'user',
        content:
          "[Skill: Speech Setup | skillId=speech_setup]\n\nLet's install chatterbox-turbo, go ahead.",
        timestamp: '2026-03-08T22:00:00.000Z',
        created_at: '2026-03-08T22:00:00.000Z',
        status: 'complete'
      }
    ])

    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-speech-setup',
      controlId: 'sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'chatterbox-local',
        installRoot: '/Users/example/.batshit/installs/chatterbox-local',
        installOwnership: 'batshit-managed',
        launch: { command: '.venv/bin/python', args: ['main.py'] },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          supports: { tts: true, stt: false, clone: false }
        }
      }
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
    expect(mockCompleteLocalVoiceEngineSetup).not.toHaveBeenCalled()
    // And nothing was written that a later call could read as consent.
    expect(riskWindowKeysWritten()).toEqual([])
  })

  it('DL-116-04: an approved voice setup seeds a window for THAT engine only', async () => {
    mockCompleteLocalVoiceEngineSetup.mockResolvedValue({
      completed: true,
      blocked: false,
      stage: 'complete',
      engineId: 'chatterbox-local',
      providerId: 'byo:chatterbox-local',
      installRoot: '/Users/example/.batshit/installs/chatterbox-local',
      installOwnership: 'batshit-managed',
      launched: true,
      registered: true,
      enabled: true
    })
    mockGetSession.mockResolvedValue({ id: 'session-speech-setup', user_id: 'user-1' })

    // The one window DL-116-04 keeps: a local install that fails partway and retries the
    // same engine inside five minutes is one action to the user, so it must not ask twice.
    const result = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-1',
      sessionId: 'session-speech-setup',
      controlId: 'sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'chatterbox-local',
        installRoot: '/Users/example/.batshit/installs/chatterbox-local',
        installOwnership: 'batshit-managed',
        launch: { command: '.venv/bin/python', args: ['main.py'] },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          supports: { tts: true, stt: false, clone: false }
        }
      }
    })

    expect(result.success).toBe(true)
    // Scoped to the engine, and seeded by the click rather than by the successful run.
    expect(mockRedisSet).toHaveBeenCalledWith(
      'control_risk_approval:user-1:agent-1:sys.voice.engine.complete_local_setup:engine%3Achatterbox-local',
      expect.any(String),
      { EX: 300 }
    )
    expect(mockCompleteLocalVoiceEngineSetup).toHaveBeenCalledTimes(1)
  })

  it('keeps local voice install approval scoped to the approved engine id', async () => {
    mockCompleteLocalVoiceEngineSetup.mockResolvedValue({
      completed: true,
      blocked: false,
      stage: 'complete',
      engineId: 'parakeet',
      providerId: 'byo:parakeet',
      installRoot: '/Users/example/.batshit/installs/parakeet',
      installOwnership: 'batshit-managed',
      launchCwd: '/Users/example/.batshit/installs/parakeet',
      logPath: '/Users/example/.batshit/runtime/voice-engines/parakeet/logs/local-engine-runtime.log',
      statePath: '/Users/example/.batshit/runtime/voice-engines/parakeet/.batshit-local-engine-setup.json',
      launched: true,
      alreadyRunning: false,
      pid: 5252,
      registered: true,
      enabled: true,
      health: {
        ready: true,
        reachable: true,
        state: 'ready',
        statusHint: 'Health check passed.'
      }
    })

    const { useControl } = await import('../services/fabricRegistry')

    const approved = await useControlWithApproval({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'parakeet',
        installRoot: '/Users/example/.batshit/installs/parakeet',
        installOwnership: 'batshit-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py']
        },
        payload: {
          name: 'Parakeet',
          baseUrl: 'http://127.0.0.1:9001',
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      }
    })
    expect(approved.success).toBe(true)

    mockRedisGet.mockImplementation(async (key: string) =>
      key ===
      'control_risk_approval:user-1:agent-1:sys.voice.engine.complete_local_setup:engine%3Achatterbox-local'
        ? null
        : 'cached-risk-approval'
    )

    const denied = await useControl({
      userId: 'user-1',
      agentId: 'agent-1',
      controlId: 'sys.voice.engine.complete_local_setup',
      input: {
        engineId: 'chatterbox-local',
        installRoot: '/Users/example/.batshit/installs/chatterbox-local',
        installOwnership: 'batshit-managed',
        launch: {
          command: '.venv/bin/python',
          args: ['main.py']
        },
        payload: {
          name: 'Chatterbox Local',
          baseUrl: 'http://127.0.0.1:4123',
          supports: {
            tts: true,
            stt: false,
            clone: false
          }
        }
      }
    })

    expect(denied.success).toBe(false)
    if (denied.success) return
    expect(denied.error.code).toBe('CONTROL_RISK_REQUIRES_APPROVAL')
  })

  it('executes voice engine health check through BYO status path', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response('ok', { status: 200 })
    )
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.register',
      input: {
        engineId: 'parakeet',
        payload: {
          name: 'Parakeet Engine',
          baseUrl: 'http://localhost:9001',
          healthPath: '/health'
        }
      }
    })

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.voice.engine.health_check',
      input: {
        engineId: 'parakeet'
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.result).toMatchObject({
      engineId: 'parakeet',
      ready: true
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9001/health',
      expect.objectContaining({
        method: 'GET'
      })
    )
  })

  it('treats initializing BYO health responses as not ready and still checks disabled records', async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          status: 'initializing',
          initialization_progress: 'Loading TTS model (this may take a while)...',
          model_loaded: false
        }),
        {
          status: 200,
          headers: { 'content-type': 'application/json' }
        }
      )
    )
    vi.stubGlobal('fetch', fetchMock)

    const { useControl } = await import('../services/fabricRegistry')

    await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.register',
      input: {
        engineId: 'warming-engine',
        payload: {
          name: 'Warming Engine',
          enabled: false,
          baseUrl: 'http://localhost:9002',
          healthPath: '/health'
        }
      }
    })

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.voice.engine.health_check',
      input: {
        engineId: 'warming-engine'
      }
    })

    expect(result.success).toBe(true)
    if (!result.success) return
    expect(result.result).toMatchObject({
      engineId: 'warming-engine',
      ready: false,
      statusHint: 'Loading TTS model (this may take a while)...'
    })
    expect(fetchMock).toHaveBeenCalledWith(
      'http://localhost:9002/health',
      expect.objectContaining({
        method: 'GET'
      })
    )
  })

  it('executes voice engine delete through control registry', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.register',
      input: {
        engineId: 'parakeet',
        payload: {
          name: 'Parakeet Engine',
          baseUrl: 'http://localhost:9001'
        }
      }
    })

    const deleted = await useControlWithApproval({
      userId: 'user-1',
      controlId: 'sys.voice.engine.delete',
      input: {
        engineId: 'parakeet'
      }
    })

    expect(deleted.success).toBe(true)
    if (!deleted.success) return
    expect(deleted.result).toMatchObject({
      engineId: 'parakeet',
      deleted: true
    })
  })
})

describe('sys.dm.send delivery modes (SA-114 DL-114-13)', () => {
  it('offers steer and its fallback field in the schema the model reads', async () => {
    const { findControls } = await import('../services/fabricRegistry')
    const result = await findControls({
      query: 'sys.dm.send',
      includeDraft: true,
      includeSchema: true,
      limit: 50
    })
    const control = result.results.find((item) => item.controlId === 'sys.dm.send')
    expect(control).toBeTruthy()

    const properties = (control as any).inputSchema?.properties
    // A value missing from this enum is a value the model will not send, whatever the
    // server accepts — the schema the broker hands over IS the offer.
    expect(properties.deliver.enum).toEqual(['wait', 'wake', 'steer'])
    // And a mode offered without the field that governs its failure case is half an offer.
    expect(properties.steer_fallback.enum).toEqual(['wait', 'wake'])
    expect(control!.schemaHint).toContain('wait | wake | steer')
    expect(control!.description).toContain('steer')
  })
})

/* -------------------------------------------------------------------------- *
 * SA-117 P2 (DL-117-05) — a control that acts as an agent needs an identity the
 * server minted.
 *
 * This is the acceptance criterion in one place: "a caller holding only the instance token
 * can no longer read, claim, or close another agent's DMs, recall its memories, or manage
 * its schedules; it can still do everything the user can through the routes that act as the
 * user." Before SA-117 every one of these ran, using whatever `agentId` the body named.
 * -------------------------------------------------------------------------- */

describe('SA-117 DL-117-05: identity-bearing controls', () => {
  const IDENTITY_BEARING = [
    'sys.dm.read',
    'sys.dm.list',
    'sys.dm.claim',
    'sys.dm.done',
    'sys.memory.recall',
    'sys.memory.search',
    'sys.schedule.list'
  ] as const

  it('refuses every identity-bearing family on the service lane, naming the agent or not', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    for (const controlId of IDENTITY_BEARING) {
      const named = await useControl({
        userId: 'user-1',
        controlId,
        // The exact shape of the old hole: the instance token, plus somebody else's name.
        agentId: 'agent-faye',
        actorType: 'service',
        input: {}
      })

      expect(named.success, `${controlId} should refuse a named agent`).toBe(false)
      if (named.success) continue
      expect(named.error.code).toBe('AGENT_IDENTITY_REQUIRED')
      expect(named.error.message).toContain('acts as an agent')

      const anonymous = await useControl({
        userId: 'user-1',
        controlId,
        actorType: 'service',
        input: {}
      })
      expect(anonymous.success, `${controlId} should refuse an unnamed caller too`).toBe(false)
    }
  })

  it('lets the credential lane, the in-process callers, and the user\'s own session through the same gate', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    for (const actorType of ['agent', 'in-process', 'n8n-callback', 'session'] as const) {
      const result = await useControl({
        userId: 'user-1',
        controlId: 'sys.dm.list',
        agentId: 'agent-cooper',
        actorType,
        input: {}
      })

      // It may still fail for its OWN reasons (no inbox in this fixture); what must never
      // happen is the identity refusal.
      if (!result.success) {
        expect(result.error.code, `${actorType} must pass the identity gate`).not.toBe(
          'AGENT_IDENTITY_REQUIRED'
        )
      }
    }
  })

  it('refuses a caller that declares no lane — the default fails closed (PR #106 review, F-1)', async () => {
    // `actorType` defaulted to `'unknown'` AND `'unknown'` was vouched, so any caller that
    // forgot the parameter was silently trusted. The dispatch route's `batshit_tool_use` path
    // reached `sys.dm.*` exactly that way with only the instance token.
    const { useControl } = await import('../services/fabricRegistry')

    const omitted = await useControl({
      userId: 'user-1',
      controlId: 'sys.dm.list',
      agentId: 'agent-cooper',
      input: {}
    })
    expect(omitted.success).toBe(false)
    if (omitted.success) return
    expect(omitted.error.code).toBe('AGENT_IDENTITY_REQUIRED')

    const declaredUnknown = await useControl({
      userId: 'user-1',
      controlId: 'sys.dm.list',
      agentId: 'agent-cooper',
      actorType: 'unknown',
      input: {}
    })
    expect(declaredUnknown.success).toBe(false)
    if (declaredUnknown.success) return
    expect(declaredUnknown.error.code).toBe('AGENT_IDENTITY_REQUIRED')
  })

  it('lets a signed-in browser act as one of the user\'s own agents (F-P2-4)', async () => {
    // The dev smoke harness reads and closes DMs as a named agent on the login cookie, and
    // `/api/dms` and `/api/schedules` already act across every agent on that same cookie. A
    // session is the user; the user is the authority over the user's agents. The refusal is
    // for a caller that only HOLDS a token — the instance token or a Portable Skill Token.
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.dm.list',
      agentId: 'agent-cooper',
      actorType: 'session',
      input: {}
    })

    if (!result.success) {
      expect(result.error.code).not.toBe('AGENT_IDENTITY_REQUIRED')
    }
  })

  it('refuses a Subagent or Worker run, whose credential is real and names nobody', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.dm.list',
      // `subagent_cli_<slug>` — the per-run runtime id, not one of the user's agents.
      agentId: 'subagent_cli_worker_agent_cooper_1',
      actorType: 'agent',
      delegatedRun: true,
      input: {}
    })

    expect(result.success).toBe(false)
    if (result.success) return
    expect(result.error.code).toBe('AGENT_IDENTITY_REQUIRED')
    expect(result.error.message).toContain('Subagent or Worker')
  })

  it('leaves controls that act as the USER alone on the service lane', async () => {
    const { useControl } = await import('../services/fabricRegistry')

    // The Docker gateway and every other service-token caller keep working for everything
    // that is "the user's". Only acting AS an agent is closed.
    const result = await useControl({
      userId: 'user-1',
      controlId: 'sys.runtime_addon.prepare',
      agentId: 'agent-faye',
      actorType: 'service',
      input: { addonId: 'fbx2vrma' }
    })

    expect(result.success).toBe(true)
  })

  /**
   * SA-118 Guard 1 (DL-118-10) — the prefix list lives HERE now.
   *
   * `ACTING_AGENT_CONTROL_PREFIXES` used to be a hand-maintained constant in
   * `fabricRegistry.ts`, a thousand lines from the definitions it classified, so a new
   * `sys.<family>.*` whose handler read `context.agentId` as an identity was un-gated by
   * omission. The flag on `ControlDefinition` is required, so forgetting it is a type error
   * — and this is the other half: the three families are the test's EXPECTATION, so adding
   * a flag without a decision is as loud as losing one.
   */
  const ACTING_AGENT_CONTROL_PREFIXES = ['sys.dm.', 'sys.memory.', 'sys.schedule.'] as const

  it('flags exactly the three acting-agent families across every code-defined control', async () => {
    const { CORE_CONTROL_ACTING_AGENT_FLAGS } = await import('../services/fabricRegistry')

    // Guards the guard: an empty or truncated readback would make the comparison below pass
    // against nothing at all.
    expect(CORE_CONTROL_ACTING_AGENT_FLAGS.length).toBeGreaterThan(40)

    const flagged = CORE_CONTROL_ACTING_AGENT_FLAGS.filter((entry) => entry.actsAsAgent)
      .map((entry) => entry.controlId)
      .sort()
    const byPrefix = CORE_CONTROL_ACTING_AGENT_FLAGS.map((entry) => entry.controlId)
      .filter((controlId) => ACTING_AGENT_CONTROL_PREFIXES.some((prefix) => controlId.startsWith(prefix)))
      .sort()

    expect(flagged).toEqual(byPrefix)
    // Each family is actually present, so the two empty sets could never agree by accident.
    for (const prefix of ACTING_AGENT_CONTROL_PREFIXES) {
      expect(flagged.some((controlId) => controlId.startsWith(prefix)), prefix).toBe(true)
    }
  })

  it('classifies the three families and nothing else as acting-as-agent', async () => {
    const { controlActsAsAgent } = await import('../services/fabricRegistry')

    for (const id of ['sys.dm.send', 'sys.memory.save', 'sys.schedule.create']) {
      expect(controlActsAsAgent(id), id).toBe(true)
    }
    for (const id of [
      'sys.mcp.use',
      'sys.artifact.update',
      'sys.cli_tool.create',
      'sys.slash_command.upsert',
      'sys.runtime_addon.start',
      'artifact.something',
      '',
      'dm.read'
    ]) {
      expect(controlActsAsAgent(id), id).toBe(false)
    }
    expect(controlActsAsAgent(undefined)).toBe(false)
    expect(controlActsAsAgent(42)).toBe(false)
  })

  it('reads the definition, so an id that merely LOOKS like a family is not vouched', async () => {
    const { controlActsAsAgent } = await import('../services/fabricRegistry')

    // Before SA-118 these three matched a prefix and were classified as acting agents even
    // though no such control exists. The flag comes from a definition or it is false.
    expect(controlActsAsAgent('sys.dm.not_a_control')).toBe(false)
    expect(controlActsAsAgent('sys.memory.nope')).toBe(false)
    expect(controlActsAsAgent('sys.schedule.')).toBe(false)
    // A real one still is.
    expect(controlActsAsAgent('sys.memory.recall')).toBe(true)
  })
})
