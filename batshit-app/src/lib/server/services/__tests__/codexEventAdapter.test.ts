import { afterEach, describe, expect, it, vi } from 'vitest'
import { CodexEventAdapter } from '../codexEventAdapter'
import type { NativeModeRequest } from '../vercelBrain'

function buildRequest(overrides: Partial<NativeModeRequest> = {}): NativeModeRequest {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'agent-123',
    userId: 'user-123',
    model: 'codex/codex-cli',
    messages: [
      {
        role: 'user',
        content: 'Hello Codex'
      }
    ],
    availableTools: [],
    maxToolRounds: 1,
    ...overrides
  }
}

async function collectChunks(generator: AsyncGenerator<any>) {
  const chunks: any[] = []
  for await (const chunk of generator) {
    chunks.push(chunk)
  }
  return chunks
}

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllGlobals()
  vi.unstubAllEnvs()
})

describe('CodexEventAdapter', () => {
  it('keeps in-turn image bytes out of the stored MCP tool result (SA-105 P3)', async () => {
    // The helper bridge now returns MCP image blocks on this runtime so a
    // recalled memory photo reaches the model in-turn. The model sees it in its
    // own turn; what Batshit stores becomes an intermediate step, then a zip,
    // then compiled history — so the bytes must not survive this boundary.
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'sdk'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'batshit_gateway_managed-codex-mode4-controls',
          tool: 'batshit_tool_use',
          arguments: { ref: 'fabric:sys.memory.recall' }
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'batshit_gateway_managed-codex-mode4-controls',
          tool: 'batshit_tool_use',
          arguments: { ref: 'fabric:sys.memory.recall' },
          result: {
            content: [
              { type: 'text', text: '{"result":{"recalled":[{"id":"mem-1"}]}}' },
              { type: 'image', data: 'RECALLEDPHOTOBASE64', mimeType: 'image/png' }
            ]
          }
        }
      }
      yield { type: 'turn.completed', usage: { input_tokens: 10, output_tokens: 5 } }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const toolResult = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(toolResult).toBeDefined()
    expect(JSON.stringify(toolResult)).not.toContain('RECALLEDPHOTOBASE64')
    expect(JSON.stringify(adapter.getIntermediateSteps())).not.toContain('RECALLEDPHOTOBASE64')

    // The text half of the result — the recall summary the agent reasons over —
    // is untouched, and the removed image is explained rather than vanished.
    const content = (toolResult as any).result.content
    expect(content[0]).toEqual({ type: 'text', text: '{"result":{"recalled":[{"id":"mem-1"}]}}' })
    expect(content[1].text).toContain('Image omitted from persisted provider context')
  })

  it('emits thinking chunks for reasoning events', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'sdk'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'reason-1',
          type: 'reasoning',
          text: 'Outline next steps'
        }
      }
      yield {
        type: 'item.updated',
        item: {
          id: 'reason-1',
          type: 'reasoning',
          text: 'More detail here'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'reason-1',
          type: 'reasoning',
          text: 'Final reasoning'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          output_tokens: 5
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const thinkingChunks = chunks.filter((chunk) => chunk.type === 'thinking')

    expect(thinkingChunks).toHaveLength(3)
    expect(thinkingChunks[0].content).toContain('Outline next steps')
    expect(thinkingChunks[1].content).toContain('More detail here')
    expect(thinkingChunks[2].content).toContain('Final reasoning')
  })

  it('normalizes Responses reasoning summary stream events into thinking chunks', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'response.reasoning_summary_text.delta',
        item_id: 'rs-1',
        delta: 'Checked the constraints.'
      } as any
      yield {
        type: 'response.reasoning_summary_text.done',
        item_id: 'rs-1',
        text: 'Checked the constraints and selected the shortest valid path.'
      } as any
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 10,
          output_tokens: 8,
          reasoning_output_tokens: 3
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const thinkingChunks = chunks.filter((chunk) => chunk.type === 'thinking')

    expect(thinkingChunks).toHaveLength(2)
    expect(thinkingChunks[0]).toMatchObject({
      content: 'Checked the constraints.',
      final: false
    })
    expect(thinkingChunks[1]).toMatchObject({
      content: 'Checked the constraints and selected the shortest valid path.',
      final: true
    })
  })

  it('preserves Codex reasoning token usage from turn completion events', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 100,
          cached_input_tokens: 40,
          output_tokens: 25,
          reasoning_output_tokens: 15
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const finishChunk = chunks.find((chunk) => chunk.type === 'finish')

    expect(finishChunk?.usage).toMatchObject({
      inputTokens: 100,
      cachedInputTokens: 40,
      outputTokens: 25,
      reasoningTokens: 15,
      totalTokens: 125
    })
  })

  it('throws top-level Codex stream errors instead of dropping them', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'error',
        message: 'Codex app-server connection failed'
      } as any
    }

    await expect(collectChunks(adapter.stream(mockEvents()))).rejects.toThrow(
      'Codex app-server connection failed'
    )
  })

  it('normalizes command executions into tool events with metadata', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'ls -la'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          aggregated_output: 'total 0',
          exit_code: 0,
          status: 'succeeded'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 3,
          output_tokens: 7
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')
    const finishChunk = chunks.find((chunk) => chunk.type === 'finish')

    expect(callChunk?.toolName).toBe('batshit_server_list_files')
    expect(callChunk?.args).toMatchObject({ command: 'ls -la' })
    expect(resultChunk?.toolName).toBe('batshit_server_list_files')
    expect(resultChunk?.metadata?.toolProvider).toBe('batshit-server')
    expect(resultChunk?.result).toMatchObject({
      output: 'total 0',
      exitCode: 0,
      status: 'succeeded'
    })
    expect(finishChunk?.usage?.totalTokens).toBe(10)
  })

  it('uses shared Mode 4 bash mapping for rg searches', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-rg',
          type: 'command_execution',
          command: 'rg "zipActivation" batshit-app/src/lib'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'cmd-rg',
          type: 'command_execution',
          aggregated_output: 'batshit-app/src/lib/utils/zipActivation.ts:84:const resolvedToolName',
          exit_code: 0,
          status: 'succeeded'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 5,
          output_tokens: 9
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toBe('batshit_server_search_files')
    expect(resultChunk?.toolName).toBe('batshit_server_search_files')
  })

  it('uses shared Mode 4 bash mapping for rg --files listings', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-rg-files',
          type: 'command_execution',
          command: 'rg --files batshit-app/src/lib/components/chat'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'cmd-rg-files',
          type: 'command_execution',
          aggregated_output: 'batshit-app/src/lib/components/chat/ChatArea.svelte',
          exit_code: 0,
          status: 'succeeded'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 5,
          output_tokens: 9
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toBe('batshit_server_list_files')
    expect(callChunk?.args).toMatchObject({
      path: 'batshit-app/src/lib/components/chat',
      dirPath: 'batshit-app/src/lib/components/chat'
    })
    expect(resultChunk?.toolName).toBe('batshit_server_list_files')
  })

  it('normalizes Codex built-in web search results into structured web_search output', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'web-1',
          type: 'web_search',
          query: 'Svelte 5 runes'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'web-1',
          type: 'web_search',
          query: 'Svelte 5 runes',
          action: {
            type: 'web_search_call',
            sources: [
              {
                url: 'https://svelte.dev/docs/svelte/what-are-runes'
              }
            ]
          }
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          output_tokens: 3
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toBe('codex_web_search')
    expect(callChunk?.args).toMatchObject({ query: 'Svelte 5 runes' })
    expect(resultChunk?.toolName).toBe('codex_web_search')
    expect(resultChunk?.result).toMatchObject({
      query: 'Svelte 5 runes',
      totalMatches: 1
    })
    expect(resultChunk?.result?.results).toEqual([
      expect.objectContaining({
        title: 'https://svelte.dev/docs/svelte/what-are-runes',
        url: 'https://svelte.dev/docs/svelte/what-are-runes'
      })
    ])
  })

  it('synthesizes a web search result row for Codex open_page steps without sources', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'web-open-1',
          type: 'web_search',
          query: 'official Svelte 5 runes docs'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'web-open-1',
          type: 'web_search',
          query: 'https://svelte.dev/docs/svelte/what-are-runes',
          result: {
            type: 'open_page',
            url: 'https://svelte.dev/docs/svelte/what-are-runes',
            results: [],
            totalMatches: 0
          }
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          output_tokens: 3
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.toolName).toBe('codex_web_search')
    expect(resultChunk?.result).toMatchObject({
      query: 'https://svelte.dev/docs/svelte/what-are-runes',
      totalMatches: 1
    })
    expect(resultChunk?.result?.results).toEqual([
      expect.objectContaining({
        title: 'https://svelte.dev/docs/svelte/what-are-runes',
        url: 'https://svelte.dev/docs/svelte/what-are-runes',
        source: 'Opened page'
      })
    ])
  })

  it('preserves Codex search-only events without faking zero-result success metadata', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'web-search-only-1',
          type: 'web_search',
          query: '',
          action: {
            type: 'other'
          }
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'web-search-only-1',
          type: 'web_search',
          query: 'official Svelte 5 docs',
          action: {
            type: 'search',
            query: 'official Svelte 5 docs',
            queries: ['official Svelte 5 docs', 'Svelte 5 docs site:svelte.dev']
          }
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          output_tokens: 3
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toBe('codex_web_search')
    expect(resultChunk?.toolName).toBe('codex_web_search')
    expect(resultChunk?.args).toMatchObject({ query: 'official Svelte 5 docs' })
    expect(resultChunk?.result).toMatchObject({
      query: 'official Svelte 5 docs',
      queries: ['official Svelte 5 docs', 'Svelte 5 docs site:svelte.dev'],
      results: [],
      resultsUnavailable: true
    })
    expect(resultChunk?.result?.totalMatches).toBeUndefined()
  })

  it('maps Codex read_file commands without whitespace to the read_file renderer', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          command: 'read_file{"path":"/tmp/foo.md"}'
        }
      }
      yield {
        type: 'item.started',
        item: {
          id: 'cmd-2',
          type: 'command_execution',
          command: 'read_file("/tmp/bar.md")'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'cmd-1',
          type: 'command_execution',
          aggregated_output: 'Foo contents',
          exit_code: 0,
          status: 'completed'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'cmd-2',
          type: 'command_execution',
          aggregated_output: 'Bar contents',
          exit_code: 0,
          status: 'completed'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 5,
          output_tokens: 5
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunks = chunks.filter((chunk) => chunk.type === 'tool-call')
    const resultChunks = chunks.filter((chunk) => chunk.type === 'tool-result')

    expect(callChunks).toHaveLength(2)
    expect(callChunks[0].toolName).toBe('batshit_server_read_file')
    expect(callChunks[0].args.path).toBe('/tmp/foo.md')
    expect(callChunks[1].toolName).toBe('batshit_server_read_file')
    expect(callChunks[1].args.filePath).toBe('/tmp/bar.md')

    expect(resultChunks[0].toolName).toBe('batshit_server_read_file')
    expect(resultChunks[0].result).toMatchObject({
      content: 'Foo contents',
      filePath: '/tmp/foo.md'
    })
    expect(resultChunks[1].result).toMatchObject({
      content: 'Bar contents',
      filePath: '/tmp/bar.md'
    })
  })

  it('maps Codex file_change updates to edit_file without a started event', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.completed',
        item: {
          id: 'change-1',
          type: 'file_change',
          changes: [
            {
              path: '/tmp/notes.md',
              kind: 'update'
            }
          ],
          status: 'completed'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          output_tokens: 4
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.toolName).toBe('batshit_server_edit_file')
    expect(resultChunk?.args?.filePath).toBe('/tmp/notes.md')
    expect(resultChunk?.result).toMatchObject({ filePath: '/tmp/notes.md' })
    expect(resultChunk?.metadata?.toolProvider).toBe('batshit-server')
  })

  it('builds real Codex file_change diffs from start and completion snapshots', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest({
        projectPath: '/tmp/project'
      }),
      transport: 'cli'
    })

    const beforeContent = Array.from(
      { length: 5000 },
      (_, index) => `line ${index + 1}`
    ).join('\n')
    const afterContent = `${beforeContent}\nfinal line`

    // batshit-server reads are service-token-gated; the adapter attaches it.
    vi.stubEnv('BATSHIT_TOKEN', 'codex-adapter-test-token')

    vi.stubGlobal(
      'fetch',
      vi
        .fn()
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            content: beforeContent
          })
        })
        .mockResolvedValueOnce({
          ok: true,
          json: async () => ({
            content: afterContent
          })
        })
    )

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'change-1',
          type: 'file_change',
          changes: [
            {
              path: 'src/big.ts',
              kind: 'update'
            }
          ],
          status: 'completed'
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'change-1',
          type: 'file_change',
          changes: [
            {
              path: 'src/big.ts',
              kind: 'update'
            }
          ],
          status: 'completed'
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 2,
          output_tokens: 4
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.toolName).toBe('batshit_server_edit_file')
    expect(resultChunk?.result?.filePath).toBe('src/big.ts')
    expect(resultChunk?.result?.diff).toContain('--- Before')
    expect(resultChunk?.result?.diff).toContain('+++ After')
    expect(resultChunk?.result?.diff).toContain('... 4,997 unchanged lines omitted ...')
    expect(resultChunk?.result?.diff).toContain('+ 5001 | final line')
    expect(resultChunk?.result?.diff).not.toContain('Diff omitted to keep the tool result compact')
  })

  it.each([
    { label: 'omitted thread', input: { chatInput: 'hi there' }, expected: { chatInput: 'hi there' } },
    { label: 'fresh thread', input: { chatInput: 'hi there', thread: 'fresh' }, expected: { chatInput: 'hi there', thread: 'fresh' } },
    { label: 'resumed thread', input: { chatInput: 'hi there', thread: 'resume' }, expected: { chatInput: 'hi there', thread: 'resume' } },
    { label: 'prompt alias', input: { prompt: 'hi there', thread: 'resume' }, expected: { prompt: 'hi there', chatInput: 'hi there', thread: 'resume' } },
    { label: 'input alias', input: { input: 'hi there' }, expected: { input: 'hi there', chatInput: 'hi there' } },
    { label: 'scalar input', input: 'hi there', expected: { chatInput: 'hi there' } }
  ])('preserves $label subagent input in events and stored steps while unwrapping output', async ({ input, expected }) => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          server: 'batshit_gateway_codex-subagents',
          tool: 'subagent_batshit_subagent',
          arguments: input
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'mcp-1',
          type: 'mcp_tool_call',
          result: [
            {
              type: 'text',
              text: '[{"output":"Hello from SA","type":"text"}]'
            }
          ]
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toContain('subagent_batshit_subagent')
    expect(callChunk?.args).toEqual(expected)
    expect(resultChunk?.args).toEqual(expected)
    expect(adapter.getIntermediateSteps()).toHaveLength(1)
    expect(adapter.getIntermediateSteps()[0].toolInput).toEqual(expected)
    expect(resultChunk?.metadata?.toolProvider).toBe('subagent')
    expect(resultChunk?.metadata?.toolSource).toBe('workflow-webhook')
    expect(resultChunk?.result).toMatchObject({ output: 'Hello from SA' })
    expect(resultChunk?.metadata?.subagentName).toBe('Batshit Subagent')
  })

  it('marks managed CLI subagent MCP results with managed subagent metadata', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'mcp-2',
          type: 'mcp_tool_call',
          server: 'batshit_gateway_cli-subagents',
          tool: 'subagent_cli_helper',
          arguments: { chatInput: 'run the specialist' }
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'mcp-2',
          type: 'mcp_tool_call',
          result: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                output: 'CLI subagent done.',
                intermediateSteps: [],
                subagentType: 'cli',
                subagentId: 'cli-subagent',
                subagentName: 'CLI Helper',
                toolSource: 'managed-cli-subagent'
              })
            }
          ]
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.metadata).toMatchObject({
      toolProvider: 'subagent',
      toolSource: 'managed-cli-subagent',
      subagentType: 'cli',
      subagentId: 'cli-subagent',
      subagentName: 'CLI Helper'
    })
    expect(resultChunk?.result).toMatchObject({
      output: 'CLI subagent done.',
      subagentType: 'cli'
    })
  })

  it('reads managed subagent metadata from Codex MCP wrapper content', async () => {
    const adapter = new CodexEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'mcp-3',
          type: 'mcp_tool_call',
          server: 'batshit_gateway_cli-subagents',
          tool: 'subagent_api_helper',
          arguments: { chatInput: 'run the API specialist' }
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'mcp-3',
          type: 'mcp_tool_call',
          result: {
            content: [
              {
                type: 'text',
                text: JSON.stringify({
                  success: true,
                  output: 'API subagent done.',
                  intermediateSteps: [],
                  subagentType: 'api',
                  subagentId: 'api-subagent',
                  subagentName: 'API Helper',
                  toolSource: 'managed-api-subagent'
                })
              }
            ],
            structured_content: null,
            output: 'API subagent done.'
          }
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.metadata).toMatchObject({
      toolProvider: 'subagent',
      toolSource: 'managed-api-subagent',
      subagentType: 'api',
      subagentId: 'api-subagent',
      subagentName: 'API Helper'
    })
    expect(resultChunk?.result).toMatchObject({
      output: 'API subagent done.'
    })
  })

  it('registers reserved zip IDs from managed MCP tool results without storing the helper notice', async () => {
    const registerReservedToolZipId = vi.fn()
    const reservedZipId = 'cool_tool_1781000000000_cli01'
    const adapter = new CodexEventAdapter({
      request: buildRequest({ registerReservedToolZipId }),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'item.started',
        item: {
          id: 'mcp-zip-1',
          type: 'mcp_tool_call',
          server: 'batshit_cli_internal_tools',
          tool: 'batshit_server_bash_execute',
          arguments: { command: 'cat package.json' }
        }
      }
      yield {
        type: 'item.completed',
        item: {
          id: 'mcp-zip-1',
          type: 'mcp_tool_call',
          result: [
            {
              type: 'text',
              text: JSON.stringify({
                success: true,
                command: 'cat package.json',
                stdout: '{"name":"batshit-app"}',
                exitCode: 0,
                batshitZipControl: {
                  zipId: reservedZipId,
                  instruction: 'Use this exact zipId.'
                }
              })
            }
          ]
        }
      }
      yield {
        type: 'turn.completed',
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')
    const resultText = resultChunk?.result?.[0]?.text ?? ''

    expect(registerReservedToolZipId).toHaveBeenCalledWith({
      toolCallId: 'mcp-zip-1',
      toolName: 'mcp.batshit_cli_internal_tools.batshit_server_bash_execute',
      zipId: reservedZipId
    })
    expect((adapter as any).intermediateSteps[0]).toMatchObject({
      toolCallId: 'mcp-zip-1',
      toolName: 'mcp.batshit_cli_internal_tools.batshit_server_bash_execute'
    })
    expect(resultText).toContain('batshit-app')
    expect(resultText).not.toContain('batshitZipControl')
    expect(resultText).not.toContain(reservedZipId)
  })
})
