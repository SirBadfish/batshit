import { describe, it, expect, beforeEach, vi } from 'vitest'

vi.mock('./api', () => ({
  api: {
    getZip: vi.fn(),
    getZips: vi.fn()
  }
}))

vi.mock('$lib/services/zipping', () => ({
  zippingService: {
    isUnzipped: vi.fn(() => true),
    isRezipped: vi.fn(() => false)
  }
}))

import { compileForUserBatch, compileForAI } from './messageCompiler'
import { api } from './api'
import { zippingService } from '$lib/services/zipping'

const zipId = 'cool_tool_1779416324513_abcd1'
const legacyZipId = 'cool_tool_1779416329822_legacy1'
const normalizedZipId = 'cool_tool_1779416331234_norm1'
const cliZipId = 'cool_tool_1779416335678_cli11'
const rawReadZipId = 'tool_raw_1779416340000_read1'
const truncatedReadZipId = 'cool_tool_1779416341000_read1'
const rawEditZipId = 'tool_raw_1779416342000_edit1'
const truncatedEditZipId = 'cool_tool_1779416343000_edit1'

const payload = {
  toolName: 'batshit_server_read_file',
  toolCallId: 'call_123',
  toolInput: { path: '/tmp/demo.txt' },
  toolResult: {
    content: '"quoted" & <tag> & more "quotes" repeated '.repeat(8),
    lines: 1
  },
  metadata: { gatewayId: 'gw_1' },
  timestamp: '2025-12-10T00:00:00.000Z'
}

const payloadJson = JSON.stringify(payload)

const legacyPayload = {
  toolName: 'batshit_server_dynamic_mcp_use',
  toolCallId: 'call_web_legacy',
  toolInput: {
    toolName: 'native_web_search',
    params: {
      query: 'batshit app',
      provider: 'exa',
      maxResults: 8
    },
    gateway: 'docker-gateway'
  },
  toolResult: {
    toolName: 'native_web_search',
    executionTimeMs: 1287,
    wrapperStatus: 'ok',
    result: [
      {
        type: 'text',
        text: JSON.stringify({
          query: 'batshit app',
          provider: 'exa',
          totalMatches: 8,
          results: Array.from({ length: 8 }, (_, index) => ({
            title: `Batshit result ${index + 1}`,
            url: `https://example.com/result-${index + 1}`,
            snippet: 'A long raw snippet '.repeat(18),
            score: 0.98 - index * 0.01,
            highlights: Array.from({ length: 6 }, (_unused, highlightIndex) =>
              `highlight_${index}_${highlightIndex}_${'x'.repeat(42)}`
            )
          })),
          debugTrace: Array.from({ length: 14 }, (_unused, index) => `debug_trace_${index}`),
          providerResponse: {
            requestId: 'req_legacy_123',
            region: 'us-east-1',
            rawEnvelope: 'provider-envelope '.repeat(120)
          }
        })
      }
    ]
  },
  metadata: {
    toolProvider: 'batshit-server',
    gatewayId: 'gw_docker_1',
    gatewayName: 'Docker Gateway',
    gatewayType: 'docker',
    source: 'mode3',
    debug: {
      routedVia: 'dynamic_mcp',
      transport: 'text-array-wrapper',
      rawToolName: 'native_web_search'
    }
  },
  timestamp: '2025-12-10T00:00:00.000Z'
}

const normalizedPayload = {
  schemaVersion: 1,
  toolName: 'native_web_search',
  originalToolName: 'batshit_server_dynamic_mcp_use',
  operationKind: 'web_search',
  rendererFamily: 'web_search',
  toolCallId: 'call_web_legacy',
  toolArgs: {
    query: 'batshit app'
  },
  toolResult: {
    query: 'batshit app',
    provider: 'exa',
    totalMatches: 3,
    results: Array.from({ length: 3 }, (_, index) => ({
      title: `Batshit result ${index + 1}`,
      url: `https://example.com/result-${index + 1}`,
      snippet: 'A compact normalized snippet.',
      source: 'exa'
    }))
  },
  rawSidecar: {
    status: 'stored',
    zipId: 'tool_raw_1779416339999_raw1'
  },
  storage: {
    compacted: true,
    truncated: true,
    binaryLikeOmitted: false,
    forceCompress: false
  },
  metadata: {
    operationKind: 'web_search',
    rendererFamily: 'web_search',
    toolProvider: 'batshit-server'
  },
  timestamp: '2025-12-10T00:00:00.000Z'
}

const legacyPayloadJson = JSON.stringify(legacyPayload)
const normalizedPayloadJson = JSON.stringify(normalizedPayload)

const cliPayload = {
  toolName: 'my_custom_cli_tool',
  operationKind: 'cli_tool',
  rendererFamily: 'cli_tool',
  toolResult: {
    output: 'CLI payload output'
  }
}

const cliPayloadJson = JSON.stringify(cliPayload)

const fullReadContent = `${'full read content '.repeat(500)}END_OF_FULL_READ`
const truncatedReadPayload = {
  schemaVersion: 1,
  toolName: 'read_file',
  displayToolName: 'batshit_server_read_file',
  originalToolName: 'batshit_server_read_file',
  operationKind: 'read_file',
  rendererFamily: 'read_file',
  toolCallId: 'call_read_truncated',
  toolArgs: {
    filePath: 'docs/user-docs/index.md',
    path: 'docs/user-docs/index.md'
  },
  toolResult: {
    filePath: 'docs/user-docs/index.md',
    path: 'docs/user-docs/index.md',
    content: 'compact preview only',
    contentTruncated: true,
    contentChars: fullReadContent.length
  },
  rawSidecar: {
    status: 'stored',
    zipId: rawReadZipId
  },
  storage: {
    compacted: true,
    truncated: true,
    binaryLikeOmitted: false,
    forceCompress: false
  },
  metadata: {
    operationKind: 'read_file',
    rendererFamily: 'read_file',
    rawSidecarZipId: rawReadZipId
  }
}

const rawReadPayload = {
  schemaVersion: 1,
  type: 'tool_raw',
  toolName: 'read_file',
  displayToolName: 'batshit_server_read_file',
  originalToolName: 'batshit_server_read_file',
  operationKind: 'read_file',
  rendererFamily: 'read_file',
  toolCallId: 'call_read_truncated',
  toolArgs: {
    filePath: 'docs/user-docs/index.md',
    path: 'docs/user-docs/index.md'
  },
  toolResult: {
    filePath: 'docs/user-docs/index.md',
    content: fullReadContent,
    lineCount: 1
  },
  metadata: {
    operationKind: 'read_file',
    rendererFamily: 'read_file',
    rawSidecar: true
  }
}

const truncatedReadPayloadJson = JSON.stringify(truncatedReadPayload)
const rawReadPayloadJson = JSON.stringify(rawReadPayload)

const fullEditDiff = `${'full edit diff '.repeat(500)}END_OF_FULL_EDIT`
const truncatedEditPayload = {
  schemaVersion: 1,
  toolName: 'edit_file',
  displayToolName: 'batshit_server_edit_file',
  originalToolName: 'batshit_server_edit_file',
  operationKind: 'edit_file',
  rendererFamily: 'edit_file',
  toolCallId: 'call_edit_truncated',
  toolArgs: {
    filePath: 'AGENTS.md',
    path: 'AGENTS.md'
  },
  toolResult: {
    filePath: 'AGENTS.md',
    diff: 'compact diff preview only',
    diffTruncated: true,
    diffChars: fullEditDiff.length
  },
  rawSidecar: {
    status: 'stored',
    zipId: rawEditZipId
  },
  storage: {
    compacted: true,
    truncated: true,
    binaryLikeOmitted: false,
    forceCompress: false
  },
  metadata: {
    operationKind: 'edit_file',
    rendererFamily: 'edit_file',
    rawSidecarZipId: rawEditZipId
  }
}

const rawEditPayload = {
  schemaVersion: 1,
  type: 'tool_raw',
  toolName: 'edit_file',
  displayToolName: 'batshit_server_edit_file',
  originalToolName: 'batshit_server_edit_file',
  operationKind: 'edit_file',
  rendererFamily: 'edit_file',
  toolCallId: 'call_edit_truncated',
  toolArgs: {
    filePath: 'AGENTS.md',
    path: 'AGENTS.md'
  },
  toolResult: {
    filePath: 'AGENTS.md',
    diff: fullEditDiff
  },
  metadata: {
    operationKind: 'edit_file',
    rendererFamily: 'edit_file',
    rawSidecar: true
  }
}

const truncatedEditPayloadJson = JSON.stringify(truncatedEditPayload)
const rawEditPayloadJson = JSON.stringify(rawEditPayload)

describe('messageCompiler – cool_tool inline payloads', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(zippingService.isUnzipped).mockReturnValue(true)
    vi.mocked(zippingService.isRezipped).mockReturnValue(false)
    vi.mocked(api.getZip).mockImplementation(async (id: string) => {
      if (id === legacyZipId) {
        return {
          id,
          content: legacyPayloadJson,
          type: 'cool_tool',
          tokens: Math.ceil(legacyPayloadJson.length / 4),
          metadata: {
            toolName: 'batshit_server_dynamic_mcp_use'
          }
        }
      }

      if (id === normalizedZipId) {
        return {
          id,
          content: normalizedPayloadJson,
          type: 'cool_tool',
          tokens: Math.ceil(normalizedPayloadJson.length / 4),
          metadata: {
            operationKind: 'web_search',
            rendererFamily: 'web_search'
          }
        }
      }

      if (id === cliZipId) {
        return {
          id,
          content: cliPayloadJson,
          type: 'cool_tool',
          tokens: Math.ceil(cliPayloadJson.length / 4),
          metadata: {
            operationKind: 'cli_tool',
            toolName: 'my_custom_cli_tool'
          }
        }
      }

      if (id === truncatedReadZipId) {
        return {
          id,
          content: truncatedReadPayloadJson,
          type: 'cool_tool',
          tokens: Math.ceil(truncatedReadPayloadJson.length / 4),
          metadata: {
            operationKind: 'read_file',
            rendererFamily: 'read_file',
            rawSidecarZipId: rawReadZipId
          }
        }
      }

      if (id === rawReadZipId) {
        return {
          id,
          content: rawReadPayloadJson,
          type: 'tool_raw',
          tokens: Math.ceil(rawReadPayloadJson.length / 4),
          metadata: {
            operationKind: 'read_file',
            rendererFamily: 'read_file',
            rawSidecar: true
          }
        }
      }

      if (id === truncatedEditZipId) {
        return {
          id,
          content: truncatedEditPayloadJson,
          type: 'cool_tool',
          tokens: Math.ceil(truncatedEditPayloadJson.length / 4),
          metadata: {
            operationKind: 'edit_file',
            rendererFamily: 'edit_file',
            rawSidecarZipId: rawEditZipId
          }
        }
      }

      if (id === rawEditZipId) {
        return {
          id,
          content: rawEditPayloadJson,
          type: 'tool_raw',
          tokens: Math.ceil(rawEditPayloadJson.length / 4),
          metadata: {
            operationKind: 'edit_file',
            rendererFamily: 'edit_file',
            rawSidecar: true
          }
        }
      }

      return {
        id: zipId,
        content: payloadJson,
        type: 'cool_tool',
        tokens: Math.ceil(payloadJson.length / 4)
      }
    })
    vi.mocked(api.getZips).mockImplementation(async (ids: string[]) => {
      const result = new Map<string, any>()
      for (const id of ids) {
        const zip = await vi.mocked(api.getZip)(id)
        if (zip) result.set(id, zip)
      }
      return result
    })
  })

  it('escapes image and file attributes in user batch compilation', async () => {
    const imageZipId = 'image_1779416350000_img1'
    const fileZipId = 'file_1779416350001_file1'

    vi.mocked(api.getZips).mockResolvedValue(
      new Map([
        [
          imageZipId,
          {
            id: imageZipId,
            content: 'https://example.com/a.png?label="<bad>',
            type: 'image',
            tokens: 1
          }
        ],
        [
          fileZipId,
          {
            id: fileZipId,
            content: 'https://example.com/file?name="<bad>',
            type: 'file',
            tokens: 1,
            name: 'weird "<name>.txt'
          }
        ]
      ])
    )

    const result = await compileForUserBatch(
      `{{batshit-zip:${imageZipId}:::Alt " onclick="bad}} {{batshit-zip:${fileZipId}}}`
    )

    expect(result).toContain('src="https://example.com/a.png?label=&quot;&lt;bad&gt;"')
    expect(result).toContain('alt="Alt &quot; onclick=&quot;bad"')
    expect(result).toContain('path="weird &quot;&lt;name&gt;.txt"')
    expect(result).toContain('url="https://example.com/file?name=&quot;&lt;bad&gt;"')
    expect(result).not.toContain('onclick="bad')
  })

  it('expands cool_tool zips as lean tool transcripts for AI compilation', async () => {
    const result = await compileForAI(`{{batshit-zip:${zipId}}}`, 0, 1, {}, undefined, {})
    expect(result).toContain('Tool result: batshit_server_read_file')
    expect(result).toContain('Content:')
    expect(result).toContain('"quoted" & <tag>')
    expect(result).not.toContain('<script type="application/json" class="cool-tool-payload">')
    expect(result).not.toContain('"schemaVersion"')
    expect(result).not.toContain('data="')
  })

  it('uses the supplied zip resolver for AI compilation instead of the HTTP API path', async () => {
    const zipResolver = vi.fn(async (id: string) => ({
      id,
      content: payloadJson,
      type: 'cool_tool',
      tokens: Math.ceil(payloadJson.length / 4),
      metadata: {
        toolName: 'read_file'
      }
    }))

    const result = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      0,
      1,
      {},
      undefined,
      {},
      { zipResolver }
    )

    expect(zipResolver).toHaveBeenCalledWith(zipId)
    expect(api.getZip).not.toHaveBeenCalled()
    expect(result).toContain('Tool result: batshit_server_read_file')
  })

  it('expands truncated read-file cool_tool zips from the raw sidecar for AI history', async () => {
    const result = await compileForAI(
      `{{batshit-zip:${truncatedReadZipId}}}`,
      0,
      1,
      {},
      undefined,
      {}
    )

    expect(result).toContain('Tool result: read_file')
    expect(result).toContain('END_OF_FULL_READ')
    expect(result).not.toContain('compact preview only')
    expect(result).not.toContain('cool-tool-payload')
  })

  it('repairs empty read-file main payloads from raw sidecars during AI compilation', async () => {
    const emptyMainZipId = 'cool_tool_1779416344000_empty1'
    const rawJsonReadZipId = 'tool_raw_1779416344000_empty1'
    const packageJson = '{\n  "name": "batshit-v2",\n  "type": "module"\n}\n'
    const emptyMainPayload = {
      schemaVersion: 1,
      toolName: 'read_file',
      operationKind: 'read_file',
      rendererFamily: 'read_file',
      toolArgs: {
        filePath: 'batshit-app/package.json',
        path: 'batshit-app/package.json'
      },
      toolResult: {
        filePath: 'batshit-app/package.json',
        path: 'batshit-app/package.json',
        content: '',
        lineCount: 5,
        contentTruncated: false,
        contentChars: 0
      },
      rawSidecar: {
        status: 'stored',
        zipId: rawJsonReadZipId
      },
      storage: {
        compacted: false,
        truncated: false,
        binaryLikeOmitted: false,
        forceCompress: false
      }
    }
    const rawPayload = {
      schemaVersion: 1,
      type: 'tool_raw',
      toolName: 'read_file',
      operationKind: 'read_file',
      rendererFamily: 'read_file',
      toolArgs: emptyMainPayload.toolArgs,
      toolResult: {
        filePath: 'batshit-app/package.json',
        path: 'batshit-app/package.json',
        content: packageJson,
        lineCount: 5,
        language: 'json'
      }
    }
    const zipResolver = vi.fn(async (id: string) => {
      if (id === emptyMainZipId) {
        return {
          id,
          content: JSON.stringify(emptyMainPayload),
          type: 'cool_tool',
          tokens: 200,
          metadata: {
            operationKind: 'read_file',
            rendererFamily: 'read_file',
            rawSidecarZipId: rawJsonReadZipId
          }
        }
      }
      return {
        id,
        content: JSON.stringify(rawPayload),
        type: 'tool_raw',
        tokens: 200,
        metadata: {
          operationKind: 'read_file',
          rendererFamily: 'read_file',
          rawSidecar: true
        }
      }
    })

    const result = await compileForAI(
      `{{batshit-zip:${emptyMainZipId}}}`,
      0,
      1,
      {},
      undefined,
      {},
      { zipResolver }
    )

    expect(zipResolver).toHaveBeenCalledWith(emptyMainZipId)
    expect(zipResolver).toHaveBeenCalledWith(rawJsonReadZipId)
    expect(result).toContain('Path: batshit-app/package.json')
    expect(result).toContain('"name": "batshit-v2"')
    expect(result).not.toContain('"content": ""')
    expect(result).not.toContain('cool-tool-payload')
  })

  it('expands truncated edit-file cool_tool zips from the raw sidecar for AI history', async () => {
    const result = await compileForAI(
      `{{batshit-zip:${truncatedEditZipId}}}`,
      0,
      1,
      {},
      undefined,
      {}
    )

    expect(result).toContain('Tool result: edit_file')
    expect(result).toContain('END_OF_FULL_EDIT')
    expect(result).not.toContain('compact diff preview only')
    expect(result).not.toContain('cool-tool-payload')
  })

  it('respects buffer and threshold when the server zip resolver supplies recent tool output', async () => {
    vi.mocked(zippingService.isUnzipped).mockReturnValue(false)

    const zipResolver = vi.fn(async (id: string) => ({
      id,
      content: payloadJson,
      type: 'cool_tool',
      tokens: 900,
      metadata: {
        toolName: 'read_file',
        tokens: 900
      }
    }))

    const agentSettings = {
      buffer_size_read_file: 2,
      zip_threshold_read_file: 40
    }

    const recentResult = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      4,
      5,
      agentSettings,
      undefined,
      {},
      { zipResolver }
    )
    const olderResult = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      0,
      5,
      agentSettings,
      undefined,
      {},
      { zipResolver }
    )

    expect(recentResult).toContain('Tool result: batshit_server_read_file')
    expect(olderResult).toBe(`{{batshit-zip:${zipId}}}`)
  })

  it('lets manual zip-now override recent buffer expansion in AI compilation', async () => {
    vi.mocked(zippingService.isUnzipped).mockReturnValue(false)
    vi.mocked(zippingService.isRezipped).mockReturnValue(true)

    const zipResolver = vi.fn(async (id: string) => ({
      id,
      content: payloadJson,
      type: 'cool_tool',
      tokens: 900,
      metadata: {
        toolName: 'read_file',
        tokens: 900
      }
    }))

    const result = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      4,
      5,
      {
        buffer_size_read_file: 2,
        zip_threshold_read_file: 0
      },
      undefined,
      {},
      { zipResolver }
    )

    expect(result).toBe(`{{batshit-zip:${zipId}}}`)
    expect(result).not.toContain('Tool result: batshit_server_read_file')
  })

  it('uses agent response age instead of raw user-message age when compiling zips', async () => {
    vi.mocked(zippingService.isUnzipped).mockReturnValue(false)

    const zipResolver = vi.fn(async (id: string) => ({
      id,
      content: payloadJson,
      type: 'cool_tool',
      tokens: 90,
      metadata: {
        toolName: 'read_file',
        tokens: 90
      }
    }))

    const agentSettings = {
      buffer_size_read_file: 1,
      zip_threshold_read_file: 0
    }

    const visibleThroughNextAgentTurn = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      0,
      5,
      agentSettings,
      undefined,
      {},
      { zipResolver, agentMessagesFromEnd: 0 }
    )
    const zippedAfterNewerAgentTurn = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      0,
      5,
      agentSettings,
      undefined,
      {},
      { zipResolver, agentMessagesFromEnd: 1 }
    )

    expect(visibleThroughNextAgentTurn).toContain('Tool result: batshit_server_read_file')
    expect(zippedAfterNewerAgentTurn).toBe(`{{batshit-zip:${zipId}}}`)
  })

  it('keeps expanded AI history materially lighter with normalized tool payloads', async () => {
    const legacyCompiled = await compileForAI(`{{batshit-zip:${legacyZipId}}}`, 0, 1, {}, undefined, {})
    const normalizedCompiled = await compileForAI(
      `{{batshit-zip:${normalizedZipId}}}`,
      0,
      1,
      {},
      undefined,
      {}
    )

    const legacyTokens = Math.ceil(legacyCompiled.length / 4)
    const normalizedTokens = Math.ceil(normalizedCompiled.length / 4)

    expect(normalizedTokens).toBeLessThan(legacyTokens * 0.35)
    expect(legacyCompiled).toContain('"executionTimeMs": 1287')
    expect(legacyCompiled).toContain('debug_trace_13')
    expect(normalizedCompiled).not.toContain('"executionTimeMs":1287')
    expect(normalizedCompiled).not.toContain('debug_trace_13')
    expect(normalizedCompiled).not.toContain('"rendererFamily":"web_search"')
    expect(normalizedCompiled).toContain('"query": "batshit app"')
  })

  it('uses the specific CLI tool id when deciding group sharing', async () => {
    const sharedResult = await compileForAI(
      `{{batshit-zip:${cliZipId}}}`,
      0,
      1,
      {},
      { agent_id: 'agent-b' },
      {},
      {
        groupToolSharing: {
          currentAgentId: 'agent-a',
          sharedTools: ['my_custom_cli_tool']
        }
      }
    )

    const hiddenResult = await compileForAI(
      `{{batshit-zip:${cliZipId}}}`,
      0,
      1,
      {},
      { agent_id: 'agent-b' },
      {},
      {
        groupToolSharing: {
          currentAgentId: 'agent-a',
          sharedTools: []
        }
      }
    )

    expect(sharedResult).toContain('Tool result: my_custom_cli_tool')
    expect(hiddenResult).toContain(`{{batshit-zip:${cliZipId}}}`)
    expect(hiddenResult).not.toContain('Tool result: my_custom_cli_tool')
  })

  it('recovery hold keeps auto-zipped tool results expanded for AI compilation', async () => {
    vi.mocked(zippingService.isUnzipped).mockReturnValue(false)
    vi.mocked(zippingService.isRezipped).mockReturnValue(false)

    const compressed = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      0,
      1,
      { auto_zip_read_file: true },
      undefined,
      {}
    )
    expect(compressed).toContain(`{{batshit-zip:${zipId}`)

    const held = await compileForAI(
      `{{batshit-zip:${zipId}}}`,
      0,
      1,
      { auto_zip_read_file: true },
      undefined,
      {},
      { recoveryHold: true }
    )
    expect(held).toContain('Tool result: batshit_server_read_file')
    expect(held).not.toContain(`{{batshit-zip:${zipId}`)
  })

  it('appends a failure note for AI when the message run never completed', async () => {
    const failed = await compileForAI(
      'partial answer so far',
      0,
      1,
      {},
      { metadata: { response_failed: true, error_message: 'You exceeded your current quota.' } },
      {}
    )
    expect(failed).toContain('partial answer so far')
    expect(failed).toContain(
      '[This response was cut short by an error before completing: You exceeded your current quota.]'
    )

    const failedNoReason = await compileForAI(
      '',
      0,
      1,
      {},
      { metadata: { response_failed: true } },
      {}
    )
    expect(failedNoReason).toBe('[This response was cut short by an error before completing.]')

    const healthy = await compileForAI(
      'all good',
      0,
      1,
      {},
      { metadata: {} },
      {}
    )
    expect(healthy).not.toContain('cut short by an error')
  })

})
