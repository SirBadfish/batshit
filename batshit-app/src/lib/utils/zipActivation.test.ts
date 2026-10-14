import { describe, it, expect } from 'vitest'
import { calculateZipActivation, describeReadCompressHint, READ_COMPRESS_HINT_LAST_REPLY } from './zipActivation'
import { getToolSettings } from './toolRenderMap'

describe('calculateZipActivation', () => {
  it('compresses when beyond buffer and tokens exceed threshold', () => {
    const result = calculateZipActivation({
      zipType: 'error',
      messagesFromEnd: 6,
      zipData: { tokens: 520 },
      agentSettings: {
        buffer_size_error: 3,
        zip_threshold_error: 400
      }
    })

    expect(result.bufferSize).toBe(3)
    expect(result.zipThreshold).toBe(400)
    expect(result.tokens).toBe(520)
    expect(result.shouldCompress).toBe(true)
    expect(result.exceedsBuffer).toBe(true)
    expect(result.meetsThreshold).toBe(true)
  })

  it('respects buffer and threshold when inside buffer', () => {
    const result = calculateZipActivation({
      zipType: 'terminal',
      messagesFromEnd: 1,
      zipData: { tokens: 800 },
      agentSettings: {
        buffer_size_terminal: 2,
        zip_threshold_terminal: 100
      }
    })

    expect(result.shouldCompress).toBe(false)
    expect(result.exceedsBuffer).toBe(false)
    expect(result.meetsThreshold).toBe(true)
  })

  it('returns no compression when manually unzipped', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 10,
      zipData: {
        tokens: 1000,
        metadata: { toolName: 'read_file' }
      },
      agentSettings: {
        custom_tool_settings: [
          { tool_name: 'read_file', buffer_size: 2, zip_threshold: 200 }
        ]
      },
      isUnzipped: true
    })

    expect(result.shouldCompress).toBe(false)
    expect(result.exceedsBuffer).toBe(true)
    expect(result.meetsThreshold).toBe(true)
  })

  it('honors buffer 1 for cool_tool zips when zip control is enabled', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 1,
      zipData: {
        tokens: 500,
        metadata: { toolName: 'read_file' }
      },
      agentSettings: {
        zip_agent_control_enabled: true,
        custom_tool_settings: [
          { tool_name: 'read_file', buffer_size: 1, zip_threshold: 100 }
        ]
      }
    })

    expect(result.bufferSize).toBe(1)
    expect(result.shouldCompress).toBe(true)
  })

  it('uses fallback tokens when zip metadata is missing token info', () => {
    const result = calculateZipActivation({
      zipType: 'diff',
      messagesFromEnd: 5,
      zipData: {
        metadata: {
          bufferSize: 1,
          threshold: 50
        }
      },
      fallbackTokens: 120,
      agentSettings: {
        buffer_size_diff: 1,
        zip_threshold_diff: 50
      }
    })

    expect(result.bufferSize).toBe(1)
    expect(result.zipThreshold).toBe(50)
    expect(result.tokens).toBe(120)
    expect(result.shouldCompress).toBe(true)
  })

  it('respects universal conversation buffer overrides when type-specific overrides are missing', () => {
    const result = calculateZipActivation({
      zipType: 'terminal',
      messagesFromEnd: 8,
      zipData: { tokens: 800 },
      agentSettings: {
        buffer_size: 12
      }
    })

    expect(result.bufferSize).toBe(12)
    expect(result.exceedsBuffer).toBe(false)
  })

  it('forces compression when auto-zip is enabled for a type', () => {
    const result = calculateZipActivation({
      zipType: 'image',
      messagesFromEnd: 0,
      zipData: { tokens: 10 },
      agentSettings: {},
      globalSettings: { auto_zip_image: true }
    })

    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('recovery hold blocks auto-zip so failed-run tool results stay visible', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      zipData: { tokens: 10, metadata: { toolName: 'read_file' } },
      agentSettings: { auto_zip_read_file: true },
      recoveryHold: true
    })

    expect(result.autoZip).toBe(true)
    expect(result.recoveryHold).toBe(true)
    expect(result.shouldCompress).toBe(false)
  })

  it('recovery hold blocks buffer-aging compression', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 10,
      zipData: { tokens: 5000 },
      agentSettings: {},
      globalSettings: { zip_buffer_cool_tool: 2, zip_threshold_cool_tool: 100 },
      recoveryHold: true
    })

    expect(result.shouldCompress).toBe(false)
  })

  it('manual rezip still compresses during a recovery hold', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      zipData: { tokens: 5000 },
      agentSettings: {},
      isRezipped: true,
      recoveryHold: true
    })

    expect(result.shouldCompress).toBe(true)
  })

  it('forces compression for auto-zipped tools', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      zipData: { tokens: 10, metadata: { toolName: 'read_file' } },
      agentSettings: { auto_zip_read_file: true }
    })

    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('uses native-pack operationKind instead of the Batshit_Tools wrapper for Bash auto-zip', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Batshit_Tools',
      zipData: {
        tokens: 281,
        metadata: {
          toolName: 'Batshit_Tools',
          operationKind: 'bash'
        }
      },
      agentSettings: {
        auto_zip_execute_command: true,
        buffer_size_execute_command: 2,
        zip_threshold_execute_command: 1
      }
    })

    expect(result.toolName).toBe('bash')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('auto-zips current Bash tool zip metadata with execute-command settings', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'bash',
      zipData: {
        tokens: 234,
        metadata: {
          toolName: 'bash',
          operationKind: 'bash',
          rendererFamily: 'bash'
        }
      },
      agentSettings: {
        auto_zip_execute_command: true,
        buffer_size_execute_command: 2,
        zip_threshold_execute_command: 1
      }
    })

    expect(result.toolName).toBe('bash')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('uses stored Bash operation kind when the visible zip descriptor is a display summary', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Bash - 1 lines',
      zipData: {
        tokens: 234,
        metadata: {
          toolName: 'bash',
          operationKind: 'bash',
          rendererFamily: 'bash'
        }
      },
      agentSettings: {
        auto_zip_execute_command: true,
        buffer_size_execute_command: 2,
        zip_threshold_execute_command: 1
      }
    })

    expect(result.toolName).toBe('bash')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('auto-zips current web search tool zip metadata with custom tool settings', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'web_search',
      zipData: {
        tokens: 420,
        metadata: {
          toolName: 'web_search',
          operationKind: 'web_search',
          rendererFamily: 'web_search'
        }
      },
      agentSettings: {
        custom_tool_settings: [
          { tool_name: 'web_search', auto_zip: true }
        ]
      }
    })

    expect(result.toolName).toBe('web_search')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('uses stored web search operation kind when the visible zip descriptor is a display summary', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Web Search - 1 lines',
      zipData: {
        tokens: 420,
        metadata: {
          toolName: 'web_search',
          operationKind: 'web_search',
          rendererFamily: 'web_search'
        }
      },
      agentSettings: {
        custom_tool_settings: [
          { tool_name: 'web_search', auto_zip: true }
        ]
      }
    })

    expect(result.toolName).toBe('web_search')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('uses stored read-file operation kind instead of the visible zip descriptor', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 3,
      toolName: 'Read File - 1 lines',
      zipData: {
        tokens: 1803,
        metadata: {
          toolName: 'read_file',
          operationKind: 'read_file',
          rendererFamily: 'read_file'
        }
      },
      agentSettings: {
        buffer_size_read_file: 2,
        zip_threshold_read_file: 1
      }
    })

    expect(result.toolName).toBe('read_file')
    expect(result.autoZip).toBe(false)
    expect(result.shouldCompress).toBe(true)
  })

  it('does not let all-other auto-zip override a known read-file operation', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Read File - 1 lines',
      zipData: {
        tokens: 1803,
        metadata: {
          toolName: 'read_file',
          operationKind: 'read_file',
          rendererFamily: 'read_file'
        }
      },
      agentSettings: {
        auto_zip_all_other_tools: true,
        buffer_size_read_file: 10,
        zip_threshold_read_file: 1
      }
    })

    expect(result.toolName).toBe('read_file')
    expect(result.bufferSize).toBe(10)
    expect(result.zipThreshold).toBe(1)
    expect(result.autoZip).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })

  it('does not let same-named custom settings override field-backed read-file metadata', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Read File',
      zipData: {
        tokens: 899,
        metadata: {
          toolName: 'read_file',
          operationKind: 'read_file',
          rendererFamily: 'read_file'
        }
      },
      agentSettings: {
        buffer_size_read_file: 10,
        zip_threshold_read_file: 2000,
        auto_zip_read_file: false,
        auto_zip_all_other_tools: true,
        custom_tool_settings: [
          { tool_name: 'read_file', auto_zip: true, zip_disabled: false }
        ]
      }
    })

    expect(result.toolName).toBe('read_file')
    expect(result.bufferSize).toBe(10)
    expect(result.zipThreshold).toBe(2000)
    expect(result.autoZip).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })

  it('uses renderer family as a zip-policy fallback for repaired read-file payloads', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Some wrapper label',
      zipData: {
        tokens: 1803,
        metadata: {
          toolName: 'Some wrapper label',
          operationKind: 'unknown_tool',
          rendererFamily: 'read_file'
        }
      },
      agentSettings: {
        auto_zip_all_other_tools: true,
        buffer_size_read_file: 10,
        zip_threshold_read_file: 1
      }
    })

    expect(result.toolName).toBe('read_file')
    expect(result.bufferSize).toBe(10)
    expect(result.autoZip).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })

  it('infers older unknown Batshit_Tools web-search zips from stored content', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Batshit_Tools',
      zipData: {
        tokens: 346,
        metadata: {
          toolName: 'Batshit_Tools',
          operationKind: 'unknown_tool'
        },
        content: JSON.stringify({
          toolName: 'Batshit_Tools',
          originalToolName: 'Batshit_Tools',
          operationKind: 'unknown_tool',
          rendererFamily: 'generic_tool',
          toolArgs: { action: 'web_search' },
          toolResult: [
            {
              success: true,
              action: 'web_search',
              data: {
                query: 'Docker n8n web search',
                provider: 'exa',
                results: []
              }
            }
          ]
        })
      },
      agentSettings: {
        custom_tool_settings: [
          { tool_name: 'web_search', auto_zip: true }
        ]
      }
    })

    expect(result.toolName).toBe('web_search')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('uses individual MCP tool names for dynamic MCP use zip settings', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      toolName: 'Batshit_Tools',
      zipData: {
        tokens: 180,
        metadata: {
          toolName: 'Batshit_Tools',
          operationKind: 'dynamic_use'
        },
        content: JSON.stringify({
          toolName: 'Batshit_Tools',
          originalToolName: 'Batshit_Tools',
          operationKind: 'dynamic_use',
          rendererFamily: 'generic_tool',
          toolArgs: {
            action: 'dynamic_mcp_use',
            input: {
              toolName: 'mcp_huggingface_search_models',
              params: { query: 'text to image' }
            }
          },
          toolResult: [
            {
              success: true,
              action: 'dynamic_mcp_use',
              data: {
                success: true,
                toolName: 'mcp_huggingface_search_models',
                result: { models: [] }
              }
            }
          ]
        })
      },
      agentSettings: {
        custom_tool_settings: [
          { tool_name: 'mcp_huggingface_search_models', auto_zip: true }
        ]
      }
    })

    expect(result.toolName).toBe('mcp_huggingface_search_models')
    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(true)
  })

  it('lets an active unzip override auto-zip compression', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      zipData: { tokens: 10, metadata: { toolName: 'read_file' } },
      agentSettings: { auto_zip_read_file: true },
      isUnzipped: true
    })

    expect(result.autoZip).toBe(true)
    expect(result.shouldCompress).toBe(false)
  })

  it('keeps zips expanded when a type is explicitly turned off', () => {
    const result = calculateZipActivation({
      zipType: 'error',
      messagesFromEnd: 50,
      zipData: { tokens: 50000 },
      agentSettings: {
        zip_disabled_error: true,
        auto_zip_error: true
      }
    })

    expect(result.zipDisabled).toBe(true)
    expect(result.autoZip).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })

  it('keeps large tool zips expanded when a tool is explicitly turned off', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 50,
      zipData: { tokens: 24999, metadata: { toolName: 'read_file' } },
      agentSettings: {
        custom_tool_settings: [
          { tool_name: 'read_file', zip_disabled: true, auto_zip: true }
        ]
      }
    })

    expect(result.zipDisabled).toBe(true)
    expect(result.autoZip).toBe(false)
    expect(result.shouldCompress).toBe(false)
  })

  it('ignores an old storage-size forceCompress stamp for a small transcript', () => {
    const result = calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 0,
      zipData: {
        tokens: 25,
        metadata: {
          operationKind: 'bash',
          forceCompress: true
        }
      },
      agentSettings: {
        buffer_size_execute_command: 99,
        zip_threshold_execute_command: 9999
      }
    })

    expect(result.shouldCompress).toBe(false)
    expect(result.sizeGuard).toBeNull()
  })
})

describe('calculateZipActivation: dead copies (SA-129 DL-01)', () => {
  const readZip = { tokens: 800, metadata: { operationKind: 'read_file', toolName: 'read_file' } }
  const normal = { buffer_size_read_file: 8, zip_threshold_read_file: 0, auto_zip_read_file: false }
  const activate = (overrides: Record<string, any> = {}, settings: Record<string, any> = normal) =>
    calculateZipActivation({
      zipType: 'cool_tool',
      messagesFromEnd: 1,
      zipData: readZip,
      agentSettings: settings,
      deadCopy: { reason: 'superseded', repliesUntilDead: 1 },
      ...overrides
    })

  it('a dead copy compresses inside its buffer, and names why', () => {
    const result = activate()
    expect(result.shouldCompress).toBe(true)
    expect(result.deadCopy).toBe('superseded')
    expect(result.deadCopyNamed).toBe(true)
    expect(activate({ deadCopy: null }).shouldCompress).toBe(false)
  })

  it('only an Off row and a user unzip keep a dead copy open', () => {
    const off = activate({}, { ...normal, zip_disabled_read_file: true })
    expect(off.shouldCompress).toBe(false)
    expect(off.deadCopy).toBeNull()
    const userUnzip = activate({ isUnzipped: true, isUserUnzipped: true })
    expect(userUnzip.shouldCompress).toBe(false)
    expect(userUnzip.deadCopy).toBeNull()
    // An agent's or Batshit's unzip, and a recovery hold, do not.
    expect(activate({ isUnzipped: true, isUserUnzipped: false }).shouldCompress).toBe(true)
    expect(activate({ recoveryHold: true }).shouldCompress).toBe(true)
  })

  it('names the reason only for a copy that died while the automatic rules still kept it open', () => {
    // Died after 7 of 8 replies: still open then, so the reference says why.
    expect(activate({ messagesFromEnd: 20, deadCopy: { reason: 'stale', repliesUntilDead: 7 } }).deadCopyNamed).toBe(true)
    // Died after 8 of 8 replies: the buffer had already compressed it, so its reference never changes.
    const aged = activate({ messagesFromEnd: 20, deadCopy: { reason: 'stale', repliesUntilDead: 8 } })
    expect(aged.shouldCompress).toBe(true)
    expect(aged.deadCopy).toBe('stale')
    expect(aged.deadCopyNamed).toBe(false)
    // Auto, a size-safety row, and a rezip compress it anyway: plain.
    expect(activate({}, { ...normal, auto_zip_read_file: true }).deadCopyNamed).toBe(false)
    expect(activate({ zipData: { ...readZip, tokens: 10000 } }).deadCopyNamed).toBe(false)
    expect(activate({ isRezipped: true }).deadCopyNamed).toBe(false)
    // Below the size floor the buffer never compresses it, so a late death still names why.
    expect(activate({ deadCopy: { reason: 'stale', repliesUntilDead: 30 } }, { ...normal, zip_threshold_read_file: 5000 }).deadCopyNamed).toBe(true)
  })
})

describe('describeReadCompressHint (SA-129 DL-03)', () => {
  const readZip = { tokens: 800, metadata: { operationKind: 'read_file', toolName: 'read_file' } }
  const activate = (messagesFromEnd: number, settings: Record<string, any>, extra: Record<string, any> = {}) =>
    calculateZipActivation({ zipType: 'cool_tool', messagesFromEnd, zipData: readZip, agentSettings: settings, ...extra })
  const normal = { buffer_size_read_file: 3, zip_threshold_read_file: 0, auto_zip_read_file: false }

  it('says the same line until the last reply, then warns once', () => {
    expect(describeReadCompressHint(activate(0, normal), { isUnzipped: false })).toBe('Compresses 3 replies after it was read.')
    expect(describeReadCompressHint(activate(1, normal), { isUnzipped: false })).toBe('Compresses 3 replies after it was read.')
    expect(describeReadCompressHint(activate(2, normal), { isUnzipped: false })).toBe(READ_COMPRESS_HINT_LAST_REPLY)
    // SA-129 P2 added the second way to keep a read open (DL-03: "P2 adds `or hold the file`").
    expect(READ_COMPRESS_HINT_LAST_REPLY).toBe('Compresses after this reply. Note what you need or hold the file.')
    expect(describeReadCompressHint(activate(0, { ...normal, buffer_size_read_file: 1 }), { isUnzipped: false })).toBe(READ_COMPRESS_HINT_LAST_REPLY)
  })

  it('stays about twelve tokens or fewer (the last-reply line, with P2\'s hold, about fifteen)', () => {
    expect(Math.ceil('Compresses 12 replies after it was read.'.length / 4)).toBeLessThanOrEqual(12)
    // It appears on one reply per result, then the result compresses; P2's "or hold the file" is
    // the lock's own wording (DL-03).
    expect(Math.ceil(READ_COMPRESS_HINT_LAST_REPLY.length / 4)).toBeLessThanOrEqual(17)
  })

  it('an Auto result open only through a recovery hold compresses after this reply', () => {
    const auto = { ...normal, auto_zip_read_file: true }
    expect(describeReadCompressHint(activate(0, auto, { recoveryHold: true }), { isUnzipped: false })).toBe(READ_COMPRESS_HINT_LAST_REPLY)
    // A recovery hold past the buffer: the hold ends with this reply, then the buffer compressions it.
    expect(describeReadCompressHint(activate(5, normal, { recoveryHold: true }), { isUnzipped: false })).toBe(READ_COMPRESS_HINT_LAST_REPLY)
  })

  it('says nothing for a compressed result, an Off row, a result below the size floor, or an unzip', () => {
    expect(describeReadCompressHint(activate(3, normal), { isUnzipped: false })).toBeNull()
    expect(describeReadCompressHint(activate(0, { ...normal, zip_disabled_read_file: true }), { isUnzipped: false })).toBeNull()
    expect(describeReadCompressHint(activate(9, { ...normal, zip_threshold_read_file: 5000 }), { isUnzipped: false })).toBeNull()
    expect(describeReadCompressHint(activate(9, normal, { isUnzipped: true }), { isUnzipped: true })).toBeNull()
  })
})

describe('getToolSettings', () => {
  it('falls back to universal buffer/threshold for uncategorised tools', () => {
    const settings = getToolSettings('my_custom_tool', { buffer_size: 25, zip_threshold: 1200 }, {})
    expect(settings.buffer_size).toBe(25)
    expect(settings.zip_threshold).toBe(1200)
    expect(settings.auto_zip).toBe(true)
  })

  it('lets bash operation kinds inherit execute_command settings during migration', () => {
    const settings = getToolSettings(
      'bash',
      {
        buffer_size_execute_command: 7,
        zip_threshold_execute_command: 321,
        auto_zip_execute_command: true
      },
      {}
    )

    expect(settings.buffer_size).toBe(7)
    expect(settings.zip_threshold).toBe(321)
    expect(settings.auto_zip).toBe(true)
  })

  it('can inherit read_file settings when no skill_read override exists', () => {
    const settings = getToolSettings(
      'skill_read',
      {
        buffer_size_read_file: 11,
        zip_threshold_read_file: 654
      },
      {}
    )

    expect(settings.buffer_size).toBe(11)
    expect(settings.zip_threshold).toBe(654)
  })

  it('prefers an explicit skill_read custom override over read_file defaults', () => {
    const settings = getToolSettings(
      'skill_read',
      {
        buffer_size_read_file: 11,
        zip_threshold_read_file: 654,
        custom_tool_settings: [
          { tool_name: 'skill_read', buffer_size: 4, zip_threshold: 222, auto_zip: true }
        ]
      },
      {}
    )

    expect(settings.buffer_size).toBe(4)
    expect(settings.zip_threshold).toBe(222)
    expect(settings.auto_zip).toBe(true)
  })

  it('resolves explicit custom tool zip-off settings', () => {
    const settings = getToolSettings(
      'read_file',
      {
        custom_tool_settings: [
          { tool_name: 'read_file', zip_disabled: true, auto_zip: true }
        ]
      },
      {}
    )

    expect(settings.zip_disabled).toBe(true)
    expect(settings.auto_zip).toBe(false)
  })

  it('resolves web_search from its own custom lane', () => {
    const settings = getToolSettings(
      'web_search',
      {
        custom_tool_settings: [
          { tool_name: 'web_search', buffer_size: 6, zip_threshold: 333, auto_zip: false }
        ]
      },
      {}
    )

    expect(settings.buffer_size).toBe(6)
    expect(settings.zip_threshold).toBe(333)
    expect(settings.auto_zip).toBe(false)
  })

  it('keeps all-other auto/zip-off behavior out of known tool lanes', () => {
    const settings = getToolSettings(
      'read_file',
      {
        auto_zip_all_other_tools: true,
        zip_disabled_all_other_tools: true,
        buffer_size_read_file: 10,
        zip_threshold_read_file: 1
      },
      {}
    )

    expect(settings.buffer_size).toBe(10)
    expect(settings.zip_threshold).toBe(1)
    expect(settings.auto_zip).toBe(false)
    expect(settings.zip_disabled).toBe(false)
  })

  it('can ignore colliding custom settings for field-backed built-in tool lanes', () => {
    const settings = getToolSettings(
      'Read File - 1 lines',
      {
        buffer_size_read_file: 10,
        zip_threshold_read_file: 2000,
        auto_zip_read_file: false,
        custom_tool_settings: [
          { tool_name: 'read_file', auto_zip: true, zip_disabled: false }
        ]
      },
      {},
      { ignoreCustomToolSettings: true }
    )

    expect(settings.buffer_size).toBe(10)
    expect(settings.zip_threshold).toBe(2000)
    expect(settings.auto_zip).toBe(false)
    expect(settings.zip_disabled).toBe(false)
  })

  it('still applies all-other auto behavior to uncategorized tools', () => {
    const settings = getToolSettings(
      'some_unmapped_tool',
      {
        auto_zip_all_other_tools: true,
        buffer_size_all_other_tools: 0,
        zip_threshold_all_other_tools: 0
      },
      {}
    )

    expect(settings.auto_zip).toBe(true)
    expect(settings.buffer_size).toBe(0)
    expect(settings.zip_threshold).toBe(0)
  })

  it('uses the new aggressive defaults when no settings are saved', () => {
    expect(getToolSettings('read_file', {}, {})).toMatchObject({
      buffer_size: 8,
      zip_threshold: 0,
      auto_zip: false
    })
    expect(getToolSettings('bash', {}, {})).toMatchObject({
      buffer_size: 1,
      zip_threshold: 0,
      auto_zip: false
    })
    expect(getToolSettings('web_search', {}, {})).toMatchObject({
      buffer_size: 1,
      zip_threshold: 0,
      auto_zip: true
    })
    expect(getToolSettings('some_unmapped_tool', {}, {})).toMatchObject({
      buffer_size: 1,
      zip_threshold: 0,
      auto_zip: true
    })
  })
})
