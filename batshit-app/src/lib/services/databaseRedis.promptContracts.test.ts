import { afterEach, describe, expect, it, vi } from 'vitest'

const redisMock = vi.hoisted(() => ({
  get: vi.fn(),
  getSession: vi.fn(async () => null),
  getUserSettings: vi.fn(),
  getProjects: vi.fn(),
  sMembers: vi.fn(),
  getZips: vi.fn()
}))

vi.mock('$lib/server/redis', () => ({
  redis: redisMock
}))

vi.mock('$env/dynamic/public', () => ({
  env: {}
}))

vi.mock('$lib/services/apiClient', () => ({
  apiClient: {},
  BATSHIT_SERVER_URL: 'http://localhost:5600',
  BATSHIT_SERVER_API_URL: 'http://localhost:5600/api/v1'
}))

vi.mock('./sessionApiClient', () => ({
  sessionApiClient: {
    configureApi: vi.fn()
  }
}))

vi.mock('./messageApiClient', () => ({
  messageApiClient: {
    configureApi: vi.fn()
  }
}))

vi.mock('./agentStore', () => ({
  agentStore: {
    configureApi: vi.fn()
  }
}))

vi.mock('./slashCommandStore', () => ({
  slashCommandStore: {
    configureApi: vi.fn()
  }
}))

vi.mock('./userStore', () => ({
  userStore: {
    configureApi: vi.fn()
  }
}))

import { DatabaseService } from './databaseRedis.server'

describe('DatabaseService prompt and DCM contract helpers', () => {
  afterEach(() => {
    vi.useRealTimers()
    vi.unstubAllGlobals()
    vi.clearAllMocks()
  })

  it('maps the latest user message metadata into the previous DCM snapshot', () => {
    const service = new DatabaseService()

    const snapshot = (service as any).getPreviousDynamicSnapshot([
      {
        role: 'user',
        content: 'older',
        metadata: {
          projectPath: '/Users/example/old',
          fileReferences: [{ path: 'old.ts' }],
          subagentSnapshot: ['old-subagent']
        }
      },
      {
        role: 'assistant',
        content: 'reply',
        metadata: {
          projectPath: '/Users/example/assistant-ignored'
        }
      },
      {
        role: 'user',
        content: 'latest',
        metadata: {
          projectPath: '/Users/example/batshit',
          projectRules: { allowedRoots: ['/Users/example/batshit'] },
          fileReferences: [{ path: 'docs/user-docs/admin/backup-and-restore.md' }],
          subagentSnapshot: ['seed_api_subagent']
        }
      }
    ])

    expect(snapshot).toEqual({
      projectPath: '/Users/example/batshit',
      projectRules: { allowedRoots: ['/Users/example/batshit'] },
      fileReferences: [{ path: 'docs/user-docs/admin/backup-and-restore.md' }],
      subagentIds: ['seed_api_subagent']
    })
  })

  it('labels the current user message before DCM content is appended', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-05-15T16:30:00.000Z'))

    const service = new DatabaseService()
    const formatted = (service as any).formatCurrentUserMessage('Run diagnostics please', null, false, {
      userLabel: 'Josh'
    })

    expect(formatted).toContain('Josh: Run diagnostics please')
    expect(formatted).toMatch(/^\*\*.+\*\*\nJosh: Run diagnostics please$/)
  })

  it('exposes the resolved agent default project path from prompt compilation', async () => {
    redisMock.sMembers.mockResolvedValue([])
    redisMock.get.mockResolvedValue(null)
    redisMock.getZips.mockResolvedValue(new Map())

    const service = new DatabaseService()
    ;(service as any).loadSystemPrompts = vi.fn().mockResolvedValue({
      primarySystemPrompt: '',
      globalCustomPrompt: '',
      globalZipSettings: undefined,
      defaultWorkspacePath: '/Users/example/global-default',
      agentDefaultProjectPath: '/Users/example/agent-default',
      agentDefaultProjectRules: undefined
    })
    ;(service as any).compileChatHistory = vi.fn().mockResolvedValue({
      formattedMessages: [],
      currentDay: null,
      chatHistory: ''
    })
    ;(service as any).buildDynamicInfoBlock = vi.fn().mockResolvedValue('')

    const result = await service.buildFormattedChatInput(
      'session-1',
      [],
      {
        id: 'agent-api',
        primary_agent_type: 'api',
        name: 'Cody'
      },
      'hello',
      [],
      'josh',
      {
        runtimeFlavor: 'codex'
      }
    )

    expect(result.resolvedProjectPath).toBe('/Users/example/agent-default')
    expect(result.structuredInput.metadata.resolvedProjectPath).toBe('/Users/example/agent-default')
  })

  it('summarizes auto-zip content and tool settings for the DCM block', () => {
    const service = new DatabaseService()
    const summary = (service as any).buildAutoZipSummary({
      agent: {
        custom_tool_settings: [
          {
            tool_name: 'sample_echo',
            auto_zip: true
          }
        ]
      },
      globalZipSettings: {
        auto_zip_image: true,
        auto_zip_subagent: true,
        custom_tool_settings: [
          {
            tool_name: 'global_tool',
            auto_zip: true
          }
        ]
      }
    })

    expect(summary.autoZipContent).toEqual(expect.arrayContaining(['image']))
    expect(summary.autoZipContent).not.toContain('code')
    expect(summary.autoZipTools).toEqual(
      expect.arrayContaining(['subagent', 'sample_echo', 'global_tool'])
    )
  })

  it('shows exact CLI MCP tool names for assigned subagents in Codex/Claude DCM', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentRecord: {
        id: 'sample_codex_primary',
        slug: 'sample_codex_primary'
      },
      agentId: 'sample_codex_primary',
      subagentDescriptions: {
        api_subagent: 'API slice coverage',
        cli_subagent: 'CLI slice coverage'
      },
      assignedSubagents: [
        {
          id: 'sample_api_subagent',
          slug: 'api_subagent',
          name: 'API Subagent',
          displayName: 'API Subagent'
        },
        {
          id: 'sample_codex_subagent',
          slug: 'cli_subagent',
          name: 'CLI Subagent',
          displayName: 'CLI Subagent'
        }
      ],
      isCodexMode: true
    })

    expect(block).toContain(
      'CLI subagent delegation: call the MCP server/tool pair shown for the chosen subagent.'
    )
    expect(block).toContain(
      'API Subagent (api_subagent; server: batshit_gateway_sample_codex_primary-subagents; tool: subagent_sample_api_subagent; full: mcp__batshit_gateway_sample_codex_primary-subagents__subagent_sample_api_subagent)'
    )
    expect(block).toContain(
      'CLI Subagent (cli_subagent; server: batshit_gateway_sample_codex_primary-subagents; tool: subagent_sample_codex_subagent; full: mcp__batshit_gateway_sample_codex_primary-subagents__subagent_sample_codex_subagent)'
    )
  })

  it('adds concise speech-to-text guidance when the current user message was transcribed', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentId: 'voice-agent',
      voiceState: {
        stt: true,
        tts: false,
        voiceMode: 'text'
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('the user spoke this message and speech-to-text (STT) transcribed it')
    expect(block).toContain('ignore [BLANK AUDIO]')
    expect(block).toContain('"Mike check" may mean "mic check"')
    expect(block).not.toContain('your reply will be spoken aloud')
  })

  it('does not add voice runtime context for saved provider config alone', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentId: 'voice-agent',
      voiceState: {
        stt: false,
        tts: false,
        voiceMode: 'text',
        provider: 'google',
        guidance: ['Engine guidance should stay hidden unless this turn speaks.']
      }
    })

    expect(block).not.toContain('Voice runtime context:')
    expect(block).not.toContain('Provider: google')
    expect(block).not.toContain('Engine guidance should stay hidden')
  })

  it('keeps provider and engine guidance out of STT-only turns', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentId: 'voice-agent',
      voiceState: {
        stt: true,
        tts: false,
        voiceMode: 'text',
        provider: 'google',
        guidance: ['Spoken reply guidance should stay hidden.']
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('the user spoke this message and speech-to-text (STT) transcribed it')
    expect(block).not.toContain('Provider: google')
    expect(block).not.toContain('Spoken reply guidance should stay hidden')
    expect(block).not.toContain('your reply will be spoken aloud')
  })

  it('adds spoken-reply brevity guidance when Voice Mode is active', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentId: 'voice-agent',
      voiceState: {
        stt: true,
        tts: true,
        voiceMode: 'voice',
        provider: 'fish'
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('the user spoke this message and speech-to-text (STT) transcribed it')
    expect(block).toContain('your reply will be spoken aloud')
    expect(block).toContain('1-3 short sentences')
    expect(block).toContain('avoid bullets/long lists')
    expect(block).toContain('Provider: fish')
  })

  it('adds TTS engine prompt guidance only for spoken replies', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentId: 'voice-agent',
      voiceState: {
        stt: false,
        tts: true,
        voiceMode: 'voice',
        provider: 'openai',
        guidance: [
          'TTS engine prompt (openai): follow these engine-specific speaking instructions when writing text that will be spoken by this provider.',
          'Use [whispers] sparingly and keep expressive cues short.'
        ]
      }
    })

    expect(block).toContain('Voice runtime context:')
    expect(block).toContain('Provider: openai')
    expect(block).toContain('TTS engine prompt (openai)')
    expect(block).toContain('Use [whispers] sparingly')
  })

  it('adds compact runtime network guidance without baseline runtime URL aliases', async () => {
    const service = new DatabaseService()

    const block = await (service as any).buildDynamicInfoBlock({
      agentRecord: {
        id: 'api-agent',
        primary_agent_type: 'api'
      },
      agentId: 'api-agent'
    })

    expect(block).toContain('native_bash: enabled')
    expect(block).toContain('runtime_network: backend=')
    if (block.includes('runtime_network: backend=docker_sandbox')) {
      expect(block).toContain('host.docker.internal')
    } else {
      expect(block).toContain('runtime_network: backend=apple_container')
      expect(block).toContain('internal deny-network policy')
      expect(block).not.toContain('host.docker.internal')
    }
    expect(block).not.toContain('runtime_url_aliases')
    expect(block).not.toContain('comfyui_api_')
    expect(block).not.toContain('batshit_server_upload_single')
  })

  it('does not use global fetch when server prompt compilation has no event.fetch', async () => {
    redisMock.sMembers.mockResolvedValue([])
    redisMock.get.mockResolvedValue(null)
    redisMock.getZips.mockResolvedValue(new Map())

    const globalFetch = vi.fn(async () => {
      throw new Error('global fetch should not be used during server prompt compilation')
    })
    vi.stubGlobal('fetch', globalFetch)

    const service = new DatabaseService()
    ;(service as any).loadSystemPrompts = vi.fn().mockResolvedValue({
      primarySystemPrompt: '',
      globalCustomPrompt: '',
      globalZipSettings: undefined,
      defaultWorkspacePath: undefined,
      agentDefaultProjectPath: undefined,
      agentDefaultProjectRules: undefined
    })
    ;(service as any).compileChatHistory = vi.fn().mockResolvedValue({
      formattedMessages: [],
      currentDay: null,
      chatHistory: ''
    })
    ;(service as any).buildDynamicInfoBlock = vi.fn().mockResolvedValue('')

    await service.buildFormattedChatInput(
      'livekit-session',
      [],
      {
        id: 'agent-api',
        primary_agent_type: 'api',
        name: 'Kiriko'
      },
      'LiveKit true speech-to-speech voice session started.',
      [],
      'josh',
      {
        runtimeFlavor: 'vercel',
        voiceState: {
          stt: true,
          tts: true,
          voiceMode: 'speech-to-speech',
          provider: 'livekit'
        }
      }
    )

    expect(globalFetch).not.toHaveBeenCalled()
  })
})
