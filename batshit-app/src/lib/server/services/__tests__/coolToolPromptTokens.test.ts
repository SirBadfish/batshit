import { describe, expect, it, vi } from 'vitest'
import { enrichCoolToolPromptTokens } from '../coolToolPromptTokens'
import { estimateMalformedCoolToolAiTokens } from '$lib/utils/coolToolAiContent'

describe('enrichCoolToolPromptTokens', () => {
  it('adds prompt-facing token metadata for legacy cool_tool zips', async () => {
    const zip = {
      id: 'cool_tool_1779416324513_abcd1',
      type: 'cool_tool',
      tokens: 180,
      content: JSON.stringify({
        type: 'tool',
        toolName: 'read_file',
        operationKind: 'read_file',
        rendererFamily: 'read_file',
        toolArgs: { path: '/Users/example/batshit/package.json' },
        toolResult: {
          path: '/Users/example/batshit/package.json',
          content: JSON.stringify({ name: 'batshit-v2' }, null, 2),
          lineCount: 3,
          language: 'json'
        }
      }),
      metadata: {}
    }

    const enriched = await enrichCoolToolPromptTokens(zip, vi.fn())

    expect(enriched.tokens).toBeLessThan(zip.tokens)
    expect(enriched.metadata.promptTokens).toBe(enriched.tokens)
    expect(enriched.metadata.aiTokens).toBe(enriched.tokens)
    expect(enriched.metadata.storageTokens).toBe(zip.tokens)
    expect(enriched.metadata.tokenBasis).toBe('ai_expanded')
  })

  it('uses raw sidecars for legacy empty read-file main payloads', async () => {
    const rawSidecarZipId = 'tool_raw_1779416324513_wxyz9'
    const mainZip = {
      id: 'cool_tool_1779416324513_abcd1',
      type: 'cool_tool',
      tokens: 220,
      content: JSON.stringify({
        type: 'tool',
        toolName: 'read_file',
        operationKind: 'read_file',
        rendererFamily: 'read_file',
        toolResult: {
          path: '/Users/example/batshit/package.json',
          content: '',
          lineCount: 0,
          language: 'json'
        },
        rawSidecar: {
          status: 'stored',
          zipId: rawSidecarZipId
        },
        metadata: {
          rawSidecarZipId
        }
      }),
      metadata: {
        rawSidecarZipId
      }
    }
    const rawZip = {
      id: rawSidecarZipId,
      type: 'tool_raw',
      content: JSON.stringify({
        type: 'tool_raw',
        toolName: 'read_file',
        operationKind: 'read_file',
        rendererFamily: 'read_file',
        toolResult: {
          path: '/Users/example/batshit/package.json',
          content: JSON.stringify({ name: 'batshit-v2', scripts: { check: 'svelte-check' } }, null, 2),
          lineCount: 6,
          language: 'json'
        }
      })
    }
    const resolveZip = vi.fn().mockResolvedValue(rawZip)

    const enriched = await enrichCoolToolPromptTokens(mainZip, resolveZip)

    expect(resolveZip).toHaveBeenCalledWith(rawSidecarZipId)
    expect(enriched.metadata.promptTokens).toBeGreaterThan(0)
    expect(enriched.metadata.promptTokens).toBe(enriched.tokens)
  })

  it('sizes malformed legacy payloads from the model-facing fallback, not stored JSON tokens', async () => {
    const zip = {
      id: 'cool_tool_1779416324513_malformed',
      type: 'cool_tool',
      tokens: 30000,
      content: '{"incomplete":"</script> still open',
      metadata: {}
    }

    const enriched = await enrichCoolToolPromptTokens(zip, vi.fn())

    expect(enriched.tokens).toBe(estimateMalformedCoolToolAiTokens(zip.id, zip.content))
    expect(enriched.tokens).toBeLessThan(10000)
    expect(enriched.metadata.storageTokens).toBe(30000)
    expect(enriched.metadata.tokenBasis).toBe('ai_expanded')
  })

  it('sizes a preferred malformed raw sidecar instead of the parseable main payload', async () => {
    const sidecarId = 'tool_raw_1779416324513_broken'
    const sidecarContent = '{"broken":"' + 'x'.repeat(40_000)
    const zip = {
      id: 'cool_tool_1779416324513_main1',
      type: 'cool_tool',
      tokens: 100,
      content: JSON.stringify({
        operationKind: 'read_file',
        rendererFamily: 'read_file',
        toolResult: { content: '' },
        rawSidecar: { zipId: sidecarId }
      }),
      metadata: {}
    }
    const resolveZip = vi.fn(async () => ({ type: 'tool_raw', content: sidecarContent }))

    const enriched = await enrichCoolToolPromptTokens(zip, resolveZip)

    expect(resolveZip).toHaveBeenCalledWith(sidecarId)
    expect(enriched.tokens).toBe(estimateMalformedCoolToolAiTokens(zip.id, sidecarContent))
    expect(enriched.tokens).toBeGreaterThanOrEqual(10000)
  })
})
