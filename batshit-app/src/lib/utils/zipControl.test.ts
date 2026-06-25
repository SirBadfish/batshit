import { describe, expect, it } from 'vitest'

import {
  extractZipControl,
  hideStreamingHiddenControlBlocks,
  resolveZipControlZipIds,
  stripZipControlBlocks
} from './zipControl'

describe('hideStreamingHiddenControlBlocks', () => {
  it('removes complete zip, group, and cue control blocks from rendered streaming text', () => {
    const content =
      [
        'Visible before',
        '<batshit-group>{"mode":"responding"}</batshit-group>',
        '<batshit-zip-control>{"unzip":["z1"]}</batshit-zip-control>',
        'Visible after',
        '<batshit-cue>{"mood":"happy"}</batshit-cue>'
      ].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible before\n\nVisible after')
  })

  it('withholds an incomplete control block until it closes', () => {
    const content = 'Visible before\n<batshit-zip-control>{"unzip":["z1"]'

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible before')
  })

  it('removes streaming emote control tags', () => {
    const content = 'Hello <goon-emote name="wave" />there <emote name="smile"'

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Hello there')
  })

  it('removes a standalone trailing bare zip-control payload from streaming text', () => {
    const content = [
      'Visible response.',
      '{"unzip":[],"zip":[],"toolResultsSummary":[]}'
    ].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible response.')
  })

  it('keeps ordinary inline JSON visible', () => {
    const content = 'Visible example: {"unzip":[],"zip":[],"toolResultsSummary":[]}'

    expect(hideStreamingHiddenControlBlocks(content)).toBe(content)
  })

  it('removes standalone bare group and goon cue payloads from streaming text', () => {
    const content = [
      '{"mode":"responding"}',
      'Visible response.',
      '{"goon_mood":"Joy","goon_cue":"wave"}'
    ].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe('Visible response.')
  })

  it('keeps ordinary inline group and cue JSON visible', () => {
    const content =
      'Visible examples: {"mode":"responding"} and {"goon_mood":"Joy","goon_cue":"wave"}'

    expect(hideStreamingHiddenControlBlocks(content)).toBe(content)
  })

  it('does not treat a mood-only JSON object as a bare cue fallback', () => {
    const content = ['Visible response.', '{"mood":"happy"}'].join('\n')

    expect(hideStreamingHiddenControlBlocks(content)).toBe(content)
  })
})

describe('extractZipControl', () => {
  it('extracts the two zip-control actions as zip IDs', () => {
    const result = extractZipControl(
      [
        'Visible response.',
        '<batshit-zip-control>',
        '{"unzip":["cool_tool_1"],"zip":["error_1"],"toolResultsSummary":[]}',
        '</batshit-zip-control>'
      ].join('\n')
    )

    expect(result.cleaned).toBe('Visible response.')
    expect(result.payload?.unzip).toEqual(['cool_tool_1'])
    expect(result.payload?.zip).toEqual(['error_1'])
  })

  it('ignores removed zip-control action names', () => {
    const result = extractZipControl(
      [
        'Visible response.',
        '<batshit-zip-control>',
        '{"rezip":["error_1"],"keepUnzipped":["cool_tool_2"],"toolResultsSummary":[]}',
        '</batshit-zip-control>'
      ].join('\n')
    )

    expect(result.payload?.unzip).toEqual([])
    expect(result.payload?.zip).toEqual([])
  })

  it('extracts a standalone trailing bare zip-control payload', () => {
    const result = extractZipControl(
      [
        'Visible response.',
        '{"unzip":[],"zip":[],"toolResultsSummary":[]}'
      ].join('\n')
    )

    expect(result.hadBlock).toBe(true)
    expect(result.cleaned).toBe('Visible response.')
    expect(result.payload?.unzip).toEqual([])
    expect(result.payload?.zip).toEqual([])
    expect(result.payload?.toolResultsSummary).toEqual([])
  })

  it('does not extract inline visible JSON as zip control metadata', () => {
    const content = 'Visible example: {"unzip":[],"zip":[],"toolResultsSummary":[]}'
    const result = extractZipControl(content)

    expect(result.hadBlock).toBe(false)
    expect(result.cleaned).toBe(content)
  })

  it('strips malformed standalone hidden-control payloads without extracting them as zip control', () => {
    const content = ['{"mode":"responding"}', 'Visible response.', '{"goon_cue":"wave"}'].join('\n')
    const result = extractZipControl(content)

    expect(result.hadBlock).toBe(false)
    expect(stripZipControlBlocks(result.cleaned)).toBe('Visible response.')
  })
})

describe('resolveZipControlZipIds', () => {
  it('resolves requested zip IDs against the trusted session zip set', () => {
    expect(
      resolveZipControlZipIds(
        [' cool_tool_1 ', 'cool_tool_1', 'error_2'],
        ['cool_tool_1', 'error_2']
      )
    ).toEqual(['cool_tool_1', 'error_2'])
  })

  it('does not resolve tool call IDs that are not zip IDs', () => {
    expect(resolveZipControlZipIds(['call_123'], ['cool_tool_1'])).toEqual([])
  })

  it('resolves one-based current tool result aliases before normal ID matching', () => {
    const first = 'cool_tool_1780541000000_abcd1'
    const second = 'cool_tool_1780541000001_abcd2'
    const third = 'cool_tool_1780541000002_abcd3'

    expect(
      resolveZipControlZipIds(
        ['tool_result_1', 'tool_result_3'],
        [first, second, third],
        {
          currentToolZipIds: [first, second, third]
        }
      )
    ).toEqual([first, third])
  })

  it('does not resolve zero-based or out-of-range current tool result aliases', () => {
    const first = 'cool_tool_1780541000000_abcd1'

    expect(
      resolveZipControlZipIds(
        ['tool_result_0', 'tool_result_2'],
        [first],
        {
          currentToolZipIds: [first]
        }
      )
    ).toEqual([])
  })

  it('deduplicates zip IDs resolved through aliases and direct IDs', () => {
    const first = 'cool_tool_1780541000000_abcd1'

    expect(
      resolveZipControlZipIds(
        ['tool_result_1', first],
        [first],
        {
          currentToolZipIds: [first]
        }
      )
    ).toEqual([first])
  })
})
