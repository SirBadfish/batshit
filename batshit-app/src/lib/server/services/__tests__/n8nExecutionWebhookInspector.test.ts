import { describe, it, expect, vi, beforeEach } from 'vitest'

vi.mock('$env/dynamic/private', () => ({
  env: {}
}))

vi.mock('$lib/services/apiKey.server', () => ({
  apiKeyService: {
    retrieve: vi.fn()
  }
}))

import { apiKeyService } from '$lib/services/apiKey.server'
import { env as privateEnv } from '$env/dynamic/private'
import {
  fetchExactN8nWebhookStyleInput,
  fetchN8nExecutionInsights,
  fetchN8nExecutionTokenUsages,
  stopRunningN8nExecutionsForMessage
} from '../n8nExecutionWebhookInspector'

declare global {
  // eslint-disable-next-line no-var
  var fetch: typeof fetch
}

describe('n8nExecutionWebhookInspector', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    global.fetch = vi.fn()
    for (const key of Object.keys(privateEnv as Record<string, string | undefined>)) {
      delete (privateEnv as Record<string, string | undefined>)[key]
    }

    ;(apiKeyService.retrieve as any).mockImplementation(async (service: string) => {
      if (service === 'n8n_api_key') return 'test-n8n-api-key'
      if (service === 'n8n_api_url') return 'http://localhost:5678'
      return null
    })
  })

  it('uses the Docker runtime n8n URL when saved settings still contain host loopback', async () => {
    ;(privateEnv as Record<string, string | undefined>).BATSHIT_CONTAINERIZED = '1'
    ;(privateEnv as Record<string, string | undefined>).N8N_API_URL = 'http://n8n:5678'

    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 456 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-docker', session_id: 'sess-docker' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const result = await fetchExactN8nWebhookStyleInput({
      userId: 'josh',
      sessionId: 'sess-docker',
      messageId: 'msg-docker',
      limit: 5
    })

    expect(result?.[0]?.body?.message_id).toBe('msg-docker')
    expect((global.fetch as any).mock.calls[0][0]).toBe('http://n8n:5678/api/v1/executions?limit=5')
    expect((global.fetch as any).mock.calls[1][0]).toBe(
      'http://n8n:5678/api/v1/executions/456?includeData=true'
    )
  })

  it('returns webhook-style input when execution runData includes matching message/session', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 123 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            data: {
              resultData: {
                runData: {
                  Webhook: [
                    {
                      data: {
                        main: [
                          [
                            {
                              json: {
                                headers: { 'content-type': 'application/json' },
                                params: {},
                                query: {},
                                body: { message_id: 'msg-1', session_id: 'sess-1' }
                              }
                            }
                          ]
                        ]
                      }
                    }
                  ]
                }
              }
            }
          }
        })
      })

    const result = await fetchExactN8nWebhookStyleInput({
      userId: 'josh',
      sessionId: 'sess-1',
      messageId: 'msg-1',
      limit: 5
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result?.[0]?.body?.message_id).toBe('msg-1')
    expect(result?.[0]?.body?.session_id).toBe('sess-1')
  })

  it('stops the running n8n execution that matches the session/message pair', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 6372 }, { id: 6373 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-stop', session_id: 'sess-stop' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 6372, status: 'canceled' })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'other-msg', session_id: 'sess-stop' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const result = await stopRunningN8nExecutionsForMessage({
      userId: 'josh',
      sessionId: 'sess-stop',
      messageId: 'msg-stop',
      limit: 10
    })

    expect(result.apiConfigured).toBe(true)
    expect(result.checkedExecutionIds).toEqual([6372, 6373])
    expect(result.matchedExecutionIds).toEqual([6372])
    expect(result.stoppedExecutionIds).toEqual([6372])
    expect((global.fetch as any).mock.calls[0][0]).toBe(
      'http://localhost:5678/api/v1/executions?status=running&limit=10'
    )
    expect((global.fetch as any).mock.calls[2][0]).toBe(
      'http://localhost:5678/api/v1/executions/6372/stop'
    )
    expect((global.fetch as any).mock.calls[2][1]?.method).toBe('POST')
  })

  it('does not stop unrelated running n8n executions', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 900 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'different-msg', session_id: 'sess-stop' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const result = await stopRunningN8nExecutionsForMessage({
      userId: 'josh',
      sessionId: 'sess-stop',
      messageId: 'msg-stop',
      limit: 5
    })

    expect(result.checkedExecutionIds).toEqual([900])
    expect(result.matchedExecutionIds).toEqual([])
    expect(result.stoppedExecutionIds).toEqual([])
    expect(global.fetch).toHaveBeenCalledTimes(2)
  })

  it('uses the webhook workflow fallback when running execution details are not matchable yet', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: [
            {
              id: 'wf-1',
              nodes: [
                {
                  type: 'n8n-nodes-base.webhook',
                  parameters: { path: 'n8n-primary' }
                }
              ]
            }
          ]
        })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 901, workflowId: 'wf-1' }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { resultData: { runData: {} } } })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ id: 901, status: 'canceled' })
      })

    const result = await stopRunningN8nExecutionsForMessage({
      userId: 'josh',
      sessionId: 'sess-stop',
      messageId: 'msg-stop',
      expectedWebhookUrl: 'http://localhost:5678/webhook/n8n-primary',
      limit: 5
    })

    expect(result.matchedExecutionIds).toEqual([])
    expect(result.workflowFallbackExecutionIds).toEqual([901])
    expect(result.stoppedExecutionIds).toEqual([901])
    expect((global.fetch as any).mock.calls[3][0]).toBe(
      'http://localhost:5678/api/v1/executions/901/stop'
    )
  })

  it('reports missing n8n API auth instead of pretending cancellation succeeded', async () => {
    ;(apiKeyService.retrieve as any).mockResolvedValue(null)

    const result = await stopRunningN8nExecutionsForMessage({
      userId: 'josh',
      sessionId: 'sess-stop',
      messageId: 'msg-stop',
      limit: 5
    })

    expect(result.apiConfigured).toBe(false)
    expect(result.stoppedExecutionIds).toEqual([])
    expect(global.fetch).not.toHaveBeenCalled()
  })

  it('handles list responses wrapped in { data: { data: [...] } }', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { data: [{ id: 999 }] } })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-2', session_id: 'sess-2' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const result = await fetchExactN8nWebhookStyleInput({
      userId: 'josh',
      sessionId: 'sess-2',
      messageId: 'msg-2',
      limit: 5
    })

    expect(Array.isArray(result)).toBe(true)
    expect(result?.[0]?.body?.message_id).toBe('msg-2')
  })

  it('extracts tokenUsage from execution runData when present', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 777 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'OpenAI Chat Model',
                  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-usage-1', session_id: 'sess-usage-1' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'OpenAI Chat Model': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              tokenUsage: {
                                completionTokens: 5,
                                promptTokens: 10,
                                totalTokens: 15
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const tokenUsages = await fetchN8nExecutionTokenUsages({
      userId: 'josh',
      sessionId: 'sess-usage-1',
      messageId: 'msg-usage-1',
      limit: 5
    })

    expect(Array.isArray(tokenUsages)).toBe(true)
    expect(tokenUsages?.[0]?.kind).toBe('tokenUsage')
    expect(tokenUsages?.[0]?.promptTokens).toBe(10)
    expect(tokenUsages?.[0]?.completionTokens).toBe(5)
    expect(tokenUsages?.[0]?.totalTokens).toBe(15)
    expect(tokenUsages?.[0]?.nodeName).toBe('OpenAI Chat Model')
  })

  it('extracts tokenUsageEstimate from execution runData when present', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 778 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'Anthropic Chat Model',
                  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-usage-2', session_id: 'sess-usage-2' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'Anthropic Chat Model': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              tokenUsageEstimate: {
                                completionTokens: 7,
                                promptTokens: 12,
                                totalTokens: 19
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const tokenUsages = await fetchN8nExecutionTokenUsages({
      userId: 'josh',
      sessionId: 'sess-usage-2',
      messageId: 'msg-usage-2',
      limit: 5
    })

    expect(Array.isArray(tokenUsages)).toBe(true)
    expect(tokenUsages?.[0]?.kind).toBe('tokenUsageEstimate')
    expect(tokenUsages?.[0]?.promptTokens).toBe(12)
    expect(tokenUsages?.[0]?.completionTokens).toBe(7)
    expect(tokenUsages?.[0]?.totalTokens).toBe(19)
    expect(tokenUsages?.[0]?.nodeName).toBe('Anthropic Chat Model')
  })

  it('fetches combined webhook input + token usages via fetchN8nExecutionInsights', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 779 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'OpenAI Chat Model',
                  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-usage-3', session_id: 'sess-usage-3' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'OpenAI Chat Model': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              tokenUsage: {
                                completionTokens: 2,
                                promptTokens: 3,
                                totalTokens: 5
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const insights = await fetchN8nExecutionInsights({
      userId: 'josh',
      sessionId: 'sess-usage-3',
      messageId: 'msg-usage-3',
      limit: 5
    })

    expect(insights?.executionId).toBe(779)
    expect(Array.isArray(insights?.webhookStyleInput)).toBe(true)
    expect(insights?.webhookStyleInput?.[0]?.body?.message_id).toBe('msg-usage-3')
    expect(Array.isArray(insights?.tokenUsages)).toBe(true)
    expect(insights?.tokenUsages?.[0]?.kind).toBe('tokenUsage')
    expect(insights?.intermediateSteps?.toolCallsCount).toBe(null)
    expect(insights?.intermediateSteps?.steps).toBe(null)
  })

  it('extracts tool-call count from AI Agent intermediateSteps output', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 900 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'AI Agent',
                  type: '@n8n/n8n-nodes-langchain.agent'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-tools-1', session_id: 'sess-tools-1' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'AI Agent': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              intermediateSteps: [
                                {
                                  action: {
                                    tool: 'n8n_MCP_Trigger',
                                    toolInput: {},
                                    toolCallId: 'call_123',
                                    type: 'tool_call'
                                  },
                                  observation: 'ok'
                                }
                              ]
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const insights = await fetchN8nExecutionInsights({
      userId: 'josh',
      sessionId: 'sess-tools-1',
      messageId: 'msg-tools-1',
      limit: 5
    })

    expect(insights?.executionId).toBe(900)
    expect(insights?.intermediateSteps?.toolCallsCount).toBe(1)
    expect(Array.isArray(insights?.intermediateSteps?.steps)).toBe(true)
    expect(insights?.intermediateSteps?.steps?.length).toBe(1)
  })

  it('extracts tool-call count when intermediateSteps is stored as a JSON string', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 901 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'AI Agent',
                  type: '@n8n/n8n-nodes-langchain.agent'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-tools-2', session_id: 'sess-tools-2' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'AI Agent': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              intermediateSteps:
                                '[{\"action\":{\"tool\":\"n8n_MCP_Trigger\",\"toolCallId\":\"call_abc\",\"type\":\"tool_call\"},\"observation\":\"ok\"}]'
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const insights = await fetchN8nExecutionInsights({
      userId: 'josh',
      sessionId: 'sess-tools-2',
      messageId: 'msg-tools-2',
      limit: 5
    })

    expect(insights?.executionId).toBe(901)
    expect(insights?.intermediateSteps?.toolCallsCount).toBe(1)
    expect(Array.isArray(insights?.intermediateSteps?.steps)).toBe(true)
    expect(insights?.intermediateSteps?.steps?.length).toBe(1)
  })

  it('prefers the primary AI Agent subagent call over nested subnode tool steps', async () => {
    const subnodeToolSteps = [
      {
        action: {
          tool: 'Batshit Subagent Tools',
          toolInput: {
            action: 'bash_execute',
            input: { command: 'pwd' }
          },
          toolCallId: 'call_child_1',
          type: 'tool_call'
        },
        observation: { data: { stdout: '/workspace' } }
      },
      {
        action: {
          tool: 'Batshit Subagent Tools',
          toolInput: {
            action: 'web_search',
            input: { query: 'n8n subagent' }
          },
          toolCallId: 'call_child_2',
          type: 'tool_call'
        },
        observation: { data: { results: [] } }
      }
    ]

    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 902 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'AI Agent',
                  type: '@n8n/n8n-nodes-langchain.agent'
                },
                {
                  name: 'n8n Subnode Subagent',
                  type: '@n8n/n8n-nodes-langchain.agentTool'
                },
                {
                  name: 'Batshit Subagent Tools',
                  type: 'n8n-nodes-base.httpRequestTool'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-tools-3', session_id: 'sess-tools-3' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'AI Agent': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              intermediateSteps: [
                                {
                                  action: {
                                    tool: 'n8n Subnode Subagent',
                                    toolInput: {
                                      Prompt__User_Message_: 'Please check the filesystem.'
                                    },
                                    toolCallId: 'call_parent',
                                    type: 'tool_call'
                                  },
                                  observation: {
                                    output: 'I checked it and found the file.',
                                    intermediateSteps: subnodeToolSteps
                                  }
                                }
                              ]
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'n8n Subnode Subagent': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              intermediateSteps: subnodeToolSteps
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const insights = await fetchN8nExecutionInsights({
      userId: 'josh',
      sessionId: 'sess-tools-3',
      messageId: 'msg-tools-3',
      limit: 5
    })

    expect(insights?.executionId).toBe(902)
    expect(insights?.intermediateSteps?.toolCallsCount).toBe(1)
    expect(insights?.intermediateSteps?.steps?.[0]?.action?.tool).toBe('n8n Subnode Subagent')
    expect(insights?.intermediateSteps?.steps?.[0]?.observation?.intermediateSteps).toHaveLength(2)
  })

  it('extracts tokenUsage from ai_languageModel output shapes (n8n chat model nodes)', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 780 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'OpenAI',
                  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-usage-4', session_id: 'sess-usage-4' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                OpenAI: [
                  {
                    data: {
                      ai_languageModel: [
                        [
                          {
                            json: {
                              response: { generations: [[{ text: '' }]] },
                              tokenUsage: {
                                completionTokens: 4,
                                promptTokens: 9,
                                totalTokens: 13
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const tokenUsages = await fetchN8nExecutionTokenUsages({
      userId: 'josh',
      sessionId: 'sess-usage-4',
      messageId: 'msg-usage-4',
      limit: 5
    })

    expect(Array.isArray(tokenUsages)).toBe(true)
    expect(tokenUsages?.[0]?.kind).toBe('tokenUsage')
    expect(tokenUsages?.[0]?.promptTokens).toBe(9)
    expect(tokenUsages?.[0]?.completionTokens).toBe(4)
    expect(tokenUsages?.[0]?.totalTokens).toBe(13)
    expect(tokenUsages?.[0]?.nodeName).toBe('OpenAI')
  })

  it('ignores zeroed tokenUsageEstimate entries (e.g., model selector helpers)', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 781 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'Model Selector',
                  type: '@n8n/n8n-nodes-langchain.modelSelector'
                },
                {
                  name: 'Anthropic',
                  type: '@n8n/n8n-nodes-langchain.lmChatAnthropic'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-usage-5', session_id: 'sess-usage-5' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'Model Selector': [
                  {
                    data: {
                      ai_languageModel: [
                        [
                          {
                            json: {
                              tokenUsageEstimate: {
                                completionTokens: 0,
                                promptTokens: 0,
                                totalTokens: 0
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                Anthropic: [
                  {
                    data: {
                      ai_languageModel: [
                        [
                          {
                            json: {
                              tokenUsageEstimate: {
                                completionTokens: 1,
                                promptTokens: 10,
                                totalTokens: 11
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const tokenUsages = await fetchN8nExecutionTokenUsages({
      userId: 'josh',
      sessionId: 'sess-usage-5',
      messageId: 'msg-usage-5',
      limit: 5
    })

    expect(tokenUsages?.length).toBe(1)
    expect(tokenUsages?.[0]?.nodeName).toBe('Anthropic')
    expect(tokenUsages?.[0]?.kind).toBe('tokenUsageEstimate')
    expect(tokenUsages?.[0]?.promptTokens).toBe(10)
  })

  it('ignores non-chat-model tokenUsageEstimate entries even when non-zero', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 782 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            workflowData: {
              nodes: [
                {
                  name: 'AI Agent',
                  type: '@n8n/n8n-nodes-langchain.agent'
                },
                {
                  name: 'OpenAI',
                  type: '@n8n/n8n-nodes-langchain.lmChatOpenAi'
                }
              ]
            },
            resultData: {
              runData: {
                Webhook: [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              headers: { 'content-type': 'application/json' },
                              params: {},
                              query: {},
                              body: { message_id: 'msg-usage-6', session_id: 'sess-usage-6' }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                'AI Agent': [
                  {
                    data: {
                      main: [
                        [
                          {
                            json: {
                              tokenUsageEstimate: {
                                completionTokens: 5,
                                promptTokens: 100,
                                totalTokens: 105
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ],
                OpenAI: [
                  {
                    data: {
                      ai_languageModel: [
                        [
                          {
                            json: {
                              tokenUsageEstimate: {
                                completionTokens: 1,
                                promptTokens: 10,
                                totalTokens: 11
                              }
                            }
                          }
                        ]
                      ]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    const tokenUsages = await fetchN8nExecutionTokenUsages({
      userId: 'josh',
      sessionId: 'sess-usage-6',
      messageId: 'msg-usage-6',
      limit: 5
    })

    expect(tokenUsages?.length).toBe(1)
    expect(tokenUsages?.[0]?.nodeName).toBe('OpenAI')
    expect(tokenUsages?.[0]?.promptTokens).toBe(10)
  })

  it('throws a helpful error when n8n returns zero executions', async () => {
    ;(global.fetch as any).mockResolvedValueOnce({
      ok: true,
      json: async () => ({ data: [] })
    })

    await expect(
      fetchExactN8nWebhookStyleInput({
        userId: 'josh',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        limit: 5
      })
    ).rejects.toThrow('No n8n executions returned')
  })

  it('throws a helpful error when includeData=true yields no runData', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 1 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: { id: 1, data: {} } })
      })

    await expect(
      fetchExactN8nWebhookStyleInput({
        userId: 'josh',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        limit: 5
      })
    ).rejects.toThrow('did not include runData')
  })

  it('throws a helpful error when runData exists but no webhook-style payload is found', async () => {
    ;(global.fetch as any)
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({ data: [{ id: 2 }] })
      })
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          data: {
            resultData: {
              runData: {
                SomeOtherNode: [
                  {
                    data: {
                      main: [[{ json: { foo: 'bar' } }]]
                    }
                  }
                ]
              }
            }
          }
        })
      })

    await expect(
      fetchExactN8nWebhookStyleInput({
        userId: 'josh',
        sessionId: 'sess-1',
        messageId: 'msg-1',
        limit: 5
      })
    ).rejects.toThrow('no webhook-style payload was found')
  })
})
