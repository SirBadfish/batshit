import { afterEach, describe, expect, it, vi } from 'vitest'
import { ClaudeEventAdapter } from '../claudeEventAdapter'
import type { NativeModeRequest } from '../vercelBrain'

function buildRequest(overrides: Partial<NativeModeRequest> = {}): NativeModeRequest {
  return {
    sessionId: 'sess-1',
    messageId: 'msg-1',
    agentId: 'agent-123',
    userId: 'user-123',
    model: 'claude-code',
    messages: [
      {
        role: 'user',
        content: 'Hello Claude'
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
})

describe('ClaudeEventAdapter', () => {
  it('normalizes built-in web search into the web_search lane', async () => {
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'server_tool_use',
              id: 'web-1',
              name: 'WebSearch',
              input: {
                query: 'Batshit AI'
              }
            },
            {
              type: 'web_search_tool_result',
              tool_use_id: 'web-1',
              content: [
                {
                  type: 'web_search_result',
                  title: 'Batshit',
                  url: 'https://batshit.ai',
                  content: 'Batshit is an AI workspace.'
                }
              ]
            },
            {
              type: 'text',
              text: 'Found batshit.ai.'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 4,
          output_tokens: 6
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toBe('claude_web_search')
    expect(callChunk?.args).toMatchObject({ query: 'Batshit AI' })
    expect(resultChunk?.toolName).toBe('claude_web_search')
    expect(resultChunk?.metadata?.toolProvider).toBe('claude')
    expect(resultChunk?.result).toMatchObject({
      totalMatches: 1
    })
    expect(resultChunk?.result?.results).toEqual([
      expect.objectContaining({
        title: 'Batshit',
        url: 'https://batshit.ai'
      })
    ])
  })

  it('expands Claude prompt-caching usage into total processed input', async () => {
    let finished: any = null
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli',
      onFinish: (payload) => {
        finished = payload
      }
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'EV_CLAUDE_CACHE_TEST'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 3,
          output_tokens: 15,
          cache_read_input_tokens: 6297,
          cache_creation_input_tokens: 12687
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const finishChunk = chunks.find((chunk) => chunk.type === 'finish')

    expect(finishChunk?.usage).toMatchObject({
      inputTokens: 18987,
      outputTokens: 15,
      totalTokens: 19002,
      cachedInputTokens: 6297,
      cacheCreationInputTokens: 12687
    })
    expect(finished?.totalUsage).toMatchObject({
      inputTokens: 18987,
      totalTokens: 19002
    })
  })

  it('flattens Claude tool_result web search payloads into real result rows', async () => {
    let finished: any = null
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli',
      onFinish: (payload) => {
        finished = payload
      }
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'web-2',
              name: 'WebSearch',
              input: {
                query: 'site:svelte.dev runes documentation'
              }
            }
          ]
        }
      }
      yield {
        type: 'user',
        tool_use_result: {
          query: 'site:svelte.dev runes documentation',
          results: [
            {
              tool_use_id: 'srvtool_1',
              content: [
                {
                  title: 'What are runes? • Svelte Docs',
                  url: 'https://svelte.dev/docs/svelte/what-are-runes'
                },
                {
                  title: '$props • Svelte Docs',
                  url: 'https://svelte.dev/docs/svelte/$props'
                }
              ]
            },
            'I found the Svelte runes documentation.'
          ]
        },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'web-2',
              content:
                'Web search results for query: "site:svelte.dev runes documentation"\n\nLinks: [{"title":"What are runes? • Svelte Docs","url":"https://svelte.dev/docs/svelte/what-are-runes"},{"title":"$props • Svelte Docs","url":"https://svelte.dev/docs/svelte/$props"}]\n\nI found the Svelte runes documentation.'
            }
          ]
        }
      }
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'Found the docs.'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 4,
          output_tokens: 6
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.result).toMatchObject({
      query: 'site:svelte.dev runes documentation',
      totalMatches: 2,
      summary: 'I found the Svelte runes documentation.'
    })
    expect(resultChunk?.result?.results).toEqual([
      expect.objectContaining({
        title: 'What are runes? • Svelte Docs',
        url: 'https://svelte.dev/docs/svelte/what-are-runes'
      }),
      expect.objectContaining({
        title: '$props • Svelte Docs',
        url: 'https://svelte.dev/docs/svelte/$props'
      })
    ])
    expect(finished?.steps?.[0]).toMatchObject({
      toolName: 'claude_web_search',
      toolResult: {
        totalMatches: 2
      }
    })
  })

  it('preserves Claude web search tool errors as error steps', async () => {
    let finished: any = null
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli',
      onFinish: (payload) => {
        finished = payload
      }
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'web-3',
              name: 'WebSearch',
              input: {
                query: 'Svelte runes official documentation',
                allowed_domains: 'svelte.dev'
              }
            }
          ]
        }
      }
      yield {
        type: 'user',
        tool_use_result:
          'InputValidationError: [{"expected":"array","code":"invalid_type","path":["allowed_domains"],"message":"Invalid input: expected array, received string"}]',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'web-3',
              is_error: true,
              content:
                '<tool_use_error>InputValidationError: WebSearch failed due to the following issue:\nThe parameter `allowed_domains` type is expected as `array` but provided as `string`</tool_use_error>'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 4,
          output_tokens: 6
        }
      }
    }

    await collectChunks(adapter.stream(mockEvents()))

    expect(finished?.steps?.[0]).toMatchObject({
      type: 'tool_error',
      toolName: 'claude_web_search',
      error: expect.stringContaining('allowed_domains')
    })
  })

  it('normalizes Claude built-in Grep files-with-matches output into search_files', async () => {
    let finished: any = null
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli',
      onFinish: (payload) => {
        finished = payload
      }
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'grep-1',
              name: 'Grep',
              input: {
                pattern: '\\bworkspace\\b',
                path: '/Users/example/hello',
                output_mode: 'files_with_matches'
              }
            }
          ]
        }
      }
      yield {
        type: 'user',
        tool_use_result: {
          mode: 'files_with_matches',
          filenames: ['hello.md'],
          numFiles: 1,
          filePath: '/Users/example/hello',
          input: {
            pattern: '\\bworkspace\\b',
            path: '/Users/example/hello',
            output_mode: 'files_with_matches'
          }
        },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'grep-1',
              content: 'The match is hello.md.'
            }
          ]
        }
      }
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'text',
              text: 'The match is hello.md.'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 4,
          output_tokens: 6
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(callChunk?.toolName).toBe('batshit_server_search_files')
    expect(callChunk?.args).toMatchObject({
      query: '\\bworkspace\\b',
      filePath: '/Users/example/hello'
    })
    expect(resultChunk?.toolName).toBe('batshit_server_search_files')
    expect(resultChunk?.result).toMatchObject({
      query: '\\bworkspace\\b',
      totalMatches: 1,
      totalMatchingFiles: 1
    })
    expect(resultChunk?.result?.results).toEqual([
      expect.objectContaining({
        path: '/Users/example/hello/hello.md',
        matchCount: 1,
        matches: []
      })
    ])
    expect(finished?.steps?.[0]).toMatchObject({
      toolName: 'batshit_server_search_files',
      toolResult: {
        totalMatches: 1,
        totalMatchingFiles: 1
      }
    })
  })

  it('marks managed API subagent MCP results with managed subagent metadata', async () => {
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'subagent-1',
              name: 'mcp__batshit_gateway_cli_subagents__subagent_api_helper',
              input: {
                chatInput: 'ask the API helper'
              }
            }
          ]
        }
      }
      yield {
        type: 'user',
        tool_use_result: [
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
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'subagent-1',
              content: 'API subagent done.'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const resultChunk = chunks.find((chunk) => chunk.type === 'tool-result')

    expect(resultChunk?.toolName).toBe('mcp.batshit_gateway_cli_subagents.subagent_api_helper')
    expect(resultChunk?.metadata).toMatchObject({
      toolProvider: 'subagent',
      toolSource: 'managed-api-subagent',
      subagentType: 'api',
      subagentId: 'api-subagent',
      subagentName: 'API Helper'
    })
    expect(resultChunk?.result).toMatchObject({
      output: 'API subagent done.',
      subagentType: 'api'
    })
  })

  it('reads managed subagent metadata from Claude MCP wrapper content', async () => {
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'subagent-2',
              name: 'mcp__batshit_gateway_cli_subagents__subagent_cli_helper',
              input: {
                chatInput: 'ask the CLI helper'
              }
            }
          ]
        }
      }
      yield {
        type: 'user',
        tool_use_result: {
          content: [
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
          ],
          structured_content: null,
          output: 'CLI subagent done.'
        },
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'subagent-2',
              content: 'CLI subagent done.'
            }
          ]
        }
      }
      yield {
        type: 'result',
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
      output: 'CLI subagent done.'
    })
  })

  it('registers reserved zip IDs from managed MCP tool results without storing the helper notice', async () => {
    const registerReservedToolZipId = vi.fn()
    const reservedZipId = 'cool_tool_1781000000000_cla01'
    const adapter = new ClaudeEventAdapter({
      request: buildRequest({ registerReservedToolZipId }),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'mcp-zip-claude',
              name: 'mcp__batshit_cli_internal_tools__batshit_server_bash_execute',
              input: {
                command: 'cat package.json'
              }
            }
          ]
        }
      }
      yield {
        type: 'user',
        tool_use_result: [
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
        ],
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'mcp-zip-claude',
              content: '{"name":"batshit-app"}'
            }
          ]
        }
      }
      yield {
        type: 'result',
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
      toolCallId: 'mcp-zip-claude',
      toolName: 'mcp.batshit_cli_internal_tools.batshit_server_bash_execute',
      zipId: reservedZipId
    })
    expect((adapter as any).intermediateSteps[0]).toMatchObject({
      toolCallId: 'mcp-zip-claude',
      toolName: 'mcp.batshit_cli_internal_tools.batshit_server_bash_execute'
    })
    expect(resultText).toContain('batshit-app')
    expect(resultText).not.toContain('batshitZipControl')
    expect(resultText).not.toContain(reservedZipId)
  })
})

describe('ClaudeEventAdapter tool name normalization pins (DL-5 / G-0002)', () => {
  // Pins the server-side normalizeToolName contract: Claude CLI built-in names map to
  // batshit_server_* names CASE-SENSITIVELY, mcp__ raw names split into dotted MCP names
  // consuming only the first two separators, and everything else passes through unchanged.
  async function pinToolName(name: string, input: Record<string, any>) {
    const adapter = new ClaudeEventAdapter({
      request: buildRequest(),
      transport: 'cli'
    })

    async function* mockEvents() {
      yield {
        type: 'assistant',
        message: {
          content: [
            {
              type: 'tool_use',
              id: 'pin-1',
              name,
              input
            }
          ]
        }
      }
      yield {
        type: 'user',
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'pin-1',
              content: 'ok'
            }
          ]
        }
      }
      yield {
        type: 'result',
        usage: {
          input_tokens: 1,
          output_tokens: 1
        }
      }
    }

    const chunks = await collectChunks(adapter.stream(mockEvents()))
    const callChunk = chunks.find((chunk) => chunk.type === 'tool-call')
    return callChunk?.toolName
  }

  it('maps PascalCase CLI built-ins to batshit_server_* names', async () => {
    expect(await pinToolName('Read', { file_path: '/tmp/x.md' })).toBe('batshit_server_read_file')
    expect(await pinToolName('Write', { file_path: '/tmp/x.md', content: 'hi' })).toBe(
      'batshit_server_overwrite_file'
    )
    expect(
      await pinToolName('Edit', { file_path: '/tmp/x.md', old_string: 'a', new_string: 'b' })
    ).toBe('batshit_server_edit_file')
  })

  it('is case-sensitive: lowercase built-in names pass through unchanged', async () => {
    expect(await pinToolName('read', { file_path: '/tmp/x.md' })).toBe('read')
  })

  it('splits mcp__ raw names on the first two separators only', async () => {
    expect(await pinToolName('mcp__github__search_issues', { query: 'x' })).toBe(
      'mcp.github.search_issues'
    )
    expect(await pinToolName('mcp__a__b__c', {})).toBe('mcp.a.b__c')
  })

  it('passes dotted mcp names and unknown tools through unchanged', async () => {
    expect(await pinToolName('mcp.already.dotted', {})).toBe('mcp.already.dotted')
    expect(await pinToolName('totally_custom_tool', {})).toBe('totally_custom_tool')
  })
})
