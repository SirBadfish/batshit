import { readFileSync } from 'node:fs'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  looksLikeNativeAgentStreamResponse,
  MessageApiService,
  redactN8nCallbackAuthFromPayload,
  stripN8nToolInvocationTraceText,
  summarizeN8nNativeChatInput,
} from './messageApi'

describe('MessageApiService – SA-013 follow-up payload + snapshot trims', () => {
  const originalFetch = global.fetch

  afterEach(() => {
    global.fetch = originalFetch
    vi.restoreAllMocks()
  })

  it('omits a hardcoded web-search provider from the native tool bridge example', () => {
    const service = new MessageApiService('http://example.com/webhook')

    const metadata = (service as any).buildNativeToolBridgeMetadata()
    const example = metadata.contracts.actionExamples.web_search.input

    expect(metadata.actions).toContain('native_skill')
    expect(metadata.actions).toContain('runtime_addon_prepare')
    expect(metadata.actions).toContain('runtime_addon_start')
    expect(metadata.actions).not.toContain('fetch_zip')
    expect(metadata.contracts.actionExamples.runtime_addon_prepare).toEqual({
      action: 'runtime_addon_prepare',
      input: {
        addonId: 'fbx2vrma'
      }
    })
    expect(metadata.contracts.actionExamples.runtime_addon_start).toEqual({
      action: 'runtime_addon_start',
      input: {
        addonId: 'fbx2vrma'
      }
    })
    expect(metadata.contracts.actionExamples.native_skill_invoke).toEqual({
      action: 'native_skill',
      input: {
        skillId: 'agent_browser',
        action: 'invoke'
      }
    })
    expect(metadata.contracts.actionExamples.batshit_tool_use_fetch_zip).toEqual({
      action: 'batshit_tool_use',
      input: {
        ref: 'fabric:sys.zip.fetch',
        input: {
          zipId: 'zip_id_here',
          includeContent: true,
          maxChars: 16000
        }
      }
    })
    expect(example).toEqual({
      query: 'Batshit release notes',
      maxResults: 5
    })
    expect('provider' in example).toBe(false)
  })

  it('trims structured input for Execution Viewer snapshots', () => {
    const service = new MessageApiService('http://example.com/webhook')

    const structuredInput = {
      type: 'batshit_chat_input',
      messages: [
        { role: 'system', content: 'sys' },
        { role: 'user', content: 'hi' }
      ],
      clippedItems: [{ clipId: 'clip-1', content: 'BIG' }],
      metadata: {
        sessionId: 'sess-1',
        agent: {
          id: 'agent-1',
          primary_model_provider: 'openai',
          primary_model_name: 'gpt-5.1',
          extra: 'unused'
        },
        subagentModels: { my_sa: { provider: 'anthropic', model: 'claude-3-5-sonnet' } },
        systemPromptLength: 999
      }
    }

    const mergedMetadata = structuredInput.metadata
    const agent = {
      id: 'agent-1',
      primary_model_provider: 'openai',
      primary_model_name: 'gpt-5.1',
      primary_model_connection: { id: 'direct:openai' }
    }

    const trimmed = (service as any).trimStructuredInputForSnapshot(
      structuredInput,
      mergedMetadata,
      agent,
      'sess-1'
    )

    expect(trimmed.type).toBe('batshit_chat_input')
    expect(trimmed.messages).toHaveLength(2)
    expect('clippedItems' in trimmed).toBe(false)

    expect(trimmed.metadata).toMatchObject({
      sessionId: 'sess-1',
      agent: {
        id: 'agent-1',
        primary_model_provider: 'openai',
        primary_model_name: 'gpt-5.1',
        primary_model_connection: { id: 'direct:openai' }
      },
      subagentModels: { my_sa: { provider: 'anthropic', model: 'claude-3-5-sonnet' } },
      nativeToolBridge: {
        nodeName: 'Batshit Tools',
        dispatch: '/api/native-tools/dispatch'
      }
    })
    expect(trimmed.metadata.nativeToolBridge.actions).not.toContain('fetch_zip')
    expect(trimmed.metadata.nativeToolBridge.actions).toContain('native_skill')
    expect(trimmed.metadata.nativeToolBridge.actions).toContain('batshit_tool_search')
    expect(trimmed.metadata.nativeToolBridge.actions).toContain('batshit_tool_use')
    expect(trimmed.metadata.nativeToolBridge.contracts.actionExamples.batshit_tool_use_fetch_zip.input.ref).toBe('fabric:sys.zip.fetch')
    expect(trimmed.metadata.nativeToolBridge.actions).not.toContain('dynamic_mcp_find')
    expect(trimmed.metadata.nativeToolBridge.actions).not.toContain('cli_tool_find')
    expect(trimmed.metadata.nativeToolBridge.actions).not.toContain('artifact_find')
    expect(trimmed.metadata.nativeToolBridge.actions).toContain('runtime_addon_prepare')
    expect(trimmed.metadata.nativeToolBridge.actions).toContain('runtime_addon_start')
  })

  it('resolves n8n runtime callback URLs before sending webhook payloads', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/messages/n8n-runtime-callbacks')
      expect(JSON.parse(String(init?.body))).toMatchObject({
        batshit_sse_endpoint: 'http://localhost:5620/api/sse',
      })

      return {
        ok: true,
        json: async () => ({
          callbackUrls: {
            batshit_sse_endpoint: 'http://app:3000/api/sse',
          },
        }),
        text: async () => '',
      } as Response
    })
    global.fetch = fetchMock as typeof fetch

    const service = new MessageApiService('http://example.com/webhook')
    const resolved = await (service as any).resolveN8nRuntimeCallbackUrls({
      batshit_sse_endpoint: 'http://localhost:5620/api/sse',
    })

    expect(resolved).toEqual({
      batshit_sse_endpoint: 'http://app:3000/api/sse',
    })
  })

  it('creates scoped n8n callback auth payload fields for native tool dispatch', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('/api/messages/n8n-callback-token')
      expect(JSON.parse(String(init?.body))).toEqual({
        sessionId: 'sess-1',
        messageId: 'msg-1',
        agentId: 'agent-1',
        projectPath: '/Users/example/batshit',
      })

      return {
        ok: true,
        json: async () => ({
          callbackToken: 'scoped-token',
          headerName: 'x-batshit-callback-token',
          expiresAt: '2026-05-31T12:00:00.000Z',
        }),
        text: async () => '',
      } as Response
    })
    global.fetch = fetchMock as typeof fetch

    const service = new MessageApiService('http://example.com/webhook')
    const auth = await (service as any).createN8nCallbackAuth(
      'sess-1',
      'msg-1',
      'agent-1',
      '/Users/example/batshit',
    )

    expect(auth).toEqual({
      batshit_native_tool_token: 'scoped-token',
      batshitNativeToolToken: 'scoped-token',
      batshit_native_tool_header: 'x-batshit-native-tool-token',
      batshitNativeToolHeader: 'x-batshit-native-tool-token',
      batshit_sse_callback_token: 'scoped-token',
      batshitSseCallbackToken: 'scoped-token',
      batshit_sse_callback_header: 'x-batshit-callback-token',
      batshitSseCallbackHeader: 'x-batshit-callback-token',
      batshit_sse_callback_expires_at: '2026-05-31T12:00:00.000Z',
      batshitSseCallbackExpiresAt: '2026-05-31T12:00:00.000Z',
    })
  })

  it('strips n8n LangChain tool invocation traces from assistant text', () => {
    const input = [
      'Calling Batshit_Tools with input: {"action":"batshit_tool_use","input":{"ref":"mcp:read_text_file","input":{"path":"/Users/example/batshit/README.md"}},"id":"call_abc"}',
      'Calling Batshit_Tools with input: {"action":"batshit_tool_search","input":{"family":"mcp","query":"filesystem"},"id":"call_def"}',
      'Could not access/read `README.md`.'
    ].join('')

    expect(stripN8nToolInvocationTraceText(input)).toBe('Could not access/read `README.md`.')
    expect(stripN8nToolInvocationTraceText('Calling this out in prose is fine.')).toBe(
      'Calling this out in prose is fine.',
    )
  })

  it('normalizes n8n webhook network failures into a clear unavailable error', () => {
    const service = new MessageApiService('http://localhost:5678/webhook/n8n-primary-agent')
    const normalized = (service as any).normalizeN8nWebhookNetworkError(
      new TypeError('fetch failed'),
    )

    expect(normalized.message).toBe('n8n is not running or connected.')
    expect((normalized as any).code).toBe('N8N_UNAVAILABLE')
    expect((normalized as any).details).toMatch(/could not reach the n8n webhook/i)
  })

  it('normalizes inactive n8n webhooks into the same unavailable error family', () => {
    const service = new MessageApiService('http://localhost:5678/webhook/n8n-primary-agent')
    const error = (service as any).buildN8nWebhookHttpError(404, 'webhook not found')

    expect(error.message).toBe('n8n is not running or connected.')
    expect(error.code).toBe('N8N_UNAVAILABLE')
    expect(error.status).toBe(404)
    expect(error.details).toMatch(/workflow is active/i)
  })

  it('redacts n8n callback auth from stored webhook snapshots', () => {
    expect(
      redactN8nCallbackAuthFromPayload({
        chatInput: 'hello',
        batshit_native_tool_token: 'secret',
        batshitNativeToolToken: 'secret',
        batshit_native_tool_header: 'x-batshit-native-tool-token',
        batshit_sse_callback_token: 'secret',
        batshitSseCallbackToken: 'secret',
        batshit_sse_callback_header: 'x-batshit-callback-token',
      }),
    ).toEqual({
      chatInput: 'hello',
    })
  })

  it('detects native-agent NDJSON even when n8n returns a text content type', () => {
    expect(
      looksLikeNativeAgentStreamResponse(
        [
          JSON.stringify({ type: 'begin', messageId: 'msg-1' }),
          JSON.stringify({ type: 'item', content: 'hi' }),
          JSON.stringify({ type: 'end', content: 'done' }),
        ].join('\n'),
      ),
    ).toBe(true)
    expect(looksLikeNativeAgentStreamResponse('{"ok":true}')).toBe(false)
  })

  it('summarizes native n8n string chat input without image URLs', () => {
    expect(summarizeN8nNativeChatInput('plain text prompt')).toEqual({
      chatInputText: 'plain text prompt',
      imageUrls: [],
    })
  })

  it('summarizes native n8n text-plus-image chat input for binary image preprocessing', () => {
    const imageDataUrl = 'data:image/png;base64,aGVsbG8='

    expect(
      summarizeN8nNativeChatInput(
        [
          { type: 'text', text: 'first part' },
          {
            type: 'image_url',
            image_url: { url: 'http://127.0.0.1:5600/uploads/a.png' },
          },
          'second part',
          {
            type: 'image_url',
            image_url: { url: 'http://127.0.0.1:5600/uploads/a.png' },
          },
          {
            imageUrl: { url: 'https://example.com/b.png' },
          },
          {
            type: 'image_url',
            image_url: { url: imageDataUrl },
          },
        ],
        'fallback',
      ),
    ).toEqual({
      chatInputText: 'first part\n\nsecond part',
      imageUrls: [
        'http://127.0.0.1:5600/uploads/a.png',
        'https://example.com/b.png',
        imageDataUrl,
      ],
    })
  })

  it('official n8n primary template converts data image inputs into binary passthrough', () => {
    const workflowPath =
      '../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-primary-agent.json'
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'))
    const prepareNode = workflow.nodes.find(
      (node: any) => node?.name === 'Prepare Batshit Input',
    )
    expect(prepareNode?.parameters?.jsCode).toBeTypeOf('string')

    const runCodeNode = new Function('$input', prepareNode.parameters.jsCode)
    const dataUrl = 'data:image/png;base64,aGVsbG8='
    const [output] = runCodeNode({
      first: () => ({
        json: {
          body: {
            user_message: 'fallback',
            chatInput: [
              { type: 'text', text: 'look here' },
              { type: 'image_url', image_url: { url: dataUrl } },
            ],
          },
        },
      }),
    })

    expect(output.json.body.chatInputText).toBe('look here')
    expect(output.json.body.batshit_image_inputs).toEqual([dataUrl])
    expect(output.json.body.batshit_image_count).toBe(1)
    expect(output.binary.image_1).toMatchObject({
      data: 'aGVsbG8=',
      mimeType: 'image/png',
      fileName: 'batshit-image-1.png',
      fileExtension: 'png',
    })
  })

  it('official n8n primary template rejects image URLs without echoing long payloads', () => {
    const workflowPath =
      '../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates/batshit-n8n-primary-agent.json'
    const workflow = JSON.parse(readFileSync(workflowPath, 'utf8'))
    const prepareNode = workflow.nodes.find(
      (node: any) => node?.name === 'Prepare Batshit Input',
    )
    const runCodeNode = new Function('$input', prepareNode.parameters.jsCode)

    expect(() =>
      runCodeNode({
        first: () => ({
          json: {
            body: {
              chatInput: [
                {
                  type: 'image_url',
                  image_url: {
                    url: 'http://127.0.0.1:5600/uploads/image.png',
                  },
                },
              ],
            },
          },
        }),
      }),
    ).toThrow(/must be data:image/)
  })

  it('official Docker n8n templates use Docker callback fallbacks and distinct webhook paths', () => {
    const templateDir =
      '../docs/user-docs/user-templates/batshit-official-n8n-workflow-templates'
    const primary = JSON.parse(
      readFileSync(`${templateDir}/batshit-docker-n8n-primary-agent.json`, 'utf8'),
    )
    const workflowSubagent = JSON.parse(
      readFileSync(
        `${templateDir}/batshit-docker-n8n-workflow-subagent.json`,
        'utf8',
      ),
    )
    const subnodeAddon = JSON.parse(
      readFileSync(
        `${templateDir}/batshit-docker-n8n-subnode-subagent-addon.json`,
        'utf8',
      ),
    )

    const getWebhookPath = (workflow: any) =>
      workflow.nodes.find((node: any) => node?.type === 'n8n-nodes-base.webhook')
        ?.parameters?.path
    const collectToolUrls = (workflow: any) =>
      workflow.nodes
        .map((node: any) => node?.parameters?.url)
        .filter((url: unknown): url is string => typeof url === 'string')

    expect(getWebhookPath(primary)).toBe('batshit_docker_n8n_primary')
    expect(getWebhookPath(workflowSubagent)).toBe(
      'batshit_docker_n8n_workflow_subagent',
    )
    expect(primary.id).not.toBe(
      JSON.parse(
        readFileSync(`${templateDir}/batshit-n8n-primary-agent.json`, 'utf8'),
      ).id,
    )
    expect(workflowSubagent.id).not.toBe(
      JSON.parse(
        readFileSync(`${templateDir}/batshit-n8n-workflow-subagent.json`, 'utf8'),
      ).id,
    )

    const urls = [
      ...collectToolUrls(primary),
      ...collectToolUrls(workflowSubagent),
      ...collectToolUrls(subnodeAddon),
    ]
    expect(urls.length).toBeGreaterThanOrEqual(3)
    expect(urls.every((url) => url.includes('http://app:3000'))).toBe(true)
    expect(urls.every((url) => !url.includes('127.0.0.1:5620'))).toBe(true)

    const retiredImageNodes = new Set([
      'Has Batshit Images',
      'Image URL Items',
      'Fetch Batshit Image',
      'Merge Batshit Images',
    ])
    expect(
      primary.nodes.some((node: any) => retiredImageNodes.has(node?.name)),
    ).toBe(false)
    expect(
      primary.nodes
        .find((node: any) => node?.name === 'Prepare Batshit Input')
        ?.parameters?.jsCode?.includes('data:image'),
    ).toBe(true)
  })

  it('patches the n8n execution snapshot directly from the final end event', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/api/sse') {
        return {
          ok: true,
          json: async () => ({}),
          text: async () => '',
        } as Response
      }

      if (url === '/api/sessions/sess-1/execution-log') {
        return {
          ok: true,
          json: async () => ({}),
          text: async () => '',
        } as Response
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    global.fetch = fetchMock as typeof fetch

    const service = new MessageApiService('http://example.com/webhook')

    await (service as any).processNativeAgentStream(
      [
        JSON.stringify({
          type: 'item',
          content: 'streaming',
        }),
        JSON.stringify({
          type: 'end',
          content: 'Mode 2 final text',
          usage: {
            promptTokens: 120,
            completionTokens: 45,
            totalTokens: 165,
          },
          intermediateSteps: [
            {
              tool: 'Batshit Tools',
              toolArgs: { action: 'bash_execute' },
              toolResult: { ok: true },
            },
          ],
        }),
      ].join('\n'),
      'sess-1',
      'msg-1',
      {},
      42,
    )

    const executionLogCall = fetchMock.mock.calls.find(
      ([input]) => String(input) === '/api/sessions/sess-1/execution-log',
    )

    expect(executionLogCall).toBeTruthy()

    const requestInit = executionLogCall?.[1] as RequestInit
    const body = JSON.parse(String(requestInit.body))

    expect(body).toMatchObject({
      id: 'msg-1',
      hydrateN8nWebhookInput: true,
      n8nExecutionSearchLimit: 42,
      patch: {
        intermediateSteps: [
          {
            tool: 'Batshit Tools',
            toolArgs: { action: 'bash_execute' },
            toolResult: { ok: true },
          },
        ],
        responseSummary: {
          content: {
            value: 'Mode 2 final text',
            confidence: 'exact',
          },
        },
        runtime: {
          status: 'succeeded',
        },
      },
    })

    expect(body.patch.llmSummary.totalUsage).toMatchObject({
      inputTokens: { value: 120, confidence: 'exact', source: 'n8n' },
      outputTokens: { value: 45, confidence: 'exact', source: 'n8n' },
      totalTokens: { value: 165, confidence: 'exact', source: 'n8n' },
    })
    expect(body.patch.responseSummary.toolCallsCount).toMatchObject({
      value: 1,
      confidence: 'near',
      source: 'n8n',
    })
    expect(body.patch.llmSummary.callsCount).toMatchObject({
      value: 2,
      confidence: 'estimated',
      source: 'n8n',
    })
  })

  it('fails loudly when forwarding an n8n stream event to SSE fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url === '/api/sse') {
        return {
          ok: false,
          status: 503,
          json: async () => ({}),
          text: async () => 'relay down',
        } as Response
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    global.fetch = fetchMock as typeof fetch

    const service = new MessageApiService('http://example.com/webhook')

    await expect(
      (service as any).processNativeAgentStream(
        JSON.stringify({
          type: 'item',
          content: 'streaming text',
        }),
        'sess-1',
        'msg-1',
        {},
        42,
      ),
    ).rejects.toThrow('Failed to forward n8n item event to Batshit SSE (503): relay down')
  })

  it('fails loudly when forwarding the final n8n end event to SSE fails', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input)

      if (url === '/api/sessions/sess-1/execution-log') {
        return {
          ok: true,
          json: async () => ({}),
          text: async () => '',
        } as Response
      }

      if (url === '/api/sse') {
        return {
          ok: false,
          status: 502,
          json: async () => ({}),
          text: async () => '',
        } as Response
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    global.fetch = fetchMock as typeof fetch

    const service = new MessageApiService('http://example.com/webhook')

    await expect(
      (service as any).processNativeAgentStream(
        JSON.stringify({
          type: 'end',
          content: 'final text',
        }),
        'sess-1',
        'msg-1',
        {},
        42,
      ),
    ).rejects.toThrow('Failed to forward n8n final end event to Batshit SSE (502)')
  })

  it('hydrates n8n execution steps before emitting the final SSE end event', async () => {
    const fetchMock = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)

      if (url === '/api/sessions/sess-1/execution-log') {
        return {
          ok: true,
          json: async () => ({
            hydratedIntermediateSteps: [
              {
                tool: 'Batshit Tools',
                toolArgs: { action: 'fetch_zip' },
                toolResult: { ok: true },
              },
            ],
            hydratedZipReferences: [
              {
                reference:
                  '{{batshit-zip:cool_tool_1:::Batshit Tools - 1 lines}}',
              },
            ],
          }),
          text: async () => '',
        } as Response
      }

      if (url === '/api/sse') {
        return {
          ok: true,
          json: async () => ({}),
          text: async () => '',
        } as Response
      }

      throw new Error(`Unexpected fetch: ${url}`)
    })

    global.fetch = fetchMock as typeof fetch

    const service = new MessageApiService('http://example.com/webhook')

    await (service as any).processNativeAgentStream(
      [
        JSON.stringify({
          type: 'item',
          content:
            'Calling Batshit_Tools with input: {"action":"batshit_tool_use","input":{"ref":"mcp:list_allowed_directories","input":{}},"id":"call_1"}done',
        }),
        JSON.stringify({
          type: 'end',
          content:
            'Calling Batshit_Tools with input: {"action":"batshit_tool_use","input":{"ref":"mcp:list_allowed_directories","input":{}},"id":"call_2"}final',
        }),
      ].join('\n'),
      'sess-1',
      'msg-1',
      {},
      42,
    )

    const finalSseCall = fetchMock.mock.calls
      .filter(([input]) => String(input) === '/api/sse')
      .map(([, init]) => JSON.parse(String((init as RequestInit).body)))
      .find((body) => body.type === 'end')

    expect(finalSseCall).toMatchObject({
      type: 'end',
      content: 'final',
      intermediateSteps: [
        {
          tool: 'Batshit Tools',
          toolArgs: { action: 'fetch_zip' },
          toolResult: { ok: true },
        },
      ],
      zipReferences: [
        {
          reference: '{{batshit-zip:cool_tool_1:::Batshit Tools - 1 lines}}',
        },
      ],
    })
  })
})
