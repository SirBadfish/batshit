import { describe, expect, it } from 'vitest'

import {
  normalizeToolPayload,
  numericKeyObjectToArray,
  parseJsonIfLikely,
  unwrapSinglePropertyRecord,
  unwrapStructuredToolValue,
  unwrapSubagentToolResult
} from '../toolPayloadUnwrap'

describe('toolPayloadUnwrap', () => {
  it('parses JSON-looking strings without altering plain text', () => {
    expect(parseJsonIfLikely('{"ok":true}')).toEqual({ ok: true })
    expect(parseJsonIfLikely('not json')).toBe('not json')
  })

  it('converts numeric-keyed transport objects into ordered arrays', () => {
    expect(numericKeyObjectToArray({ '1': 'b', '0': 'a', metadata: 'ignored' })).toEqual([
      'a',
      'b'
    ])
  })

  it('unwraps single-property result records with caller-selected keys', () => {
    expect(unwrapSinglePropertyRecord({ result: 'done' })).toBe('done')
    expect(unwrapSinglePropertyRecord({ response: 'done' }, ['response'])).toBe('done')
    expect(unwrapSinglePropertyRecord({ result: 'done', extra: true })).toEqual({
      result: 'done',
      extra: true
    })
  })

  it('normalizes common tool payload wrappers in one pass', () => {
    expect(normalizeToolPayload('[{"text":"{\\"output\\":\\"done\\"}"}]')).toBe('done')
  })

  it('unwraps transport web-search wrappers through text blocks and data fields', () => {
    expect(
      unwrapStructuredToolValue(
        JSON.stringify([
          {
            text: JSON.stringify({
              data: {
                results: [{ title: 'Result A', url: 'https://example.com/a' }],
                totalMatches: 1
              }
            })
          }
        ])
      )
    ).toEqual({
      results: [{ title: 'Result A', url: 'https://example.com/a' }],
      totalMatches: 1
    })
  })

  it('unwraps managed subagent text-block JSON into renderer-ready output', () => {
    expect(
      unwrapSubagentToolResult([
        {
          type: 'text',
          text: JSON.stringify([
            {
              type: 'text',
              output: 'Subagent complete',
              intermediateSteps: [{ tool: 'read_file' }]
            }
          ])
        }
      ])
    ).toEqual({
      type: 'text',
      output: 'Subagent complete',
      intermediateSteps: [{ tool: 'read_file' }]
    })
  })

  it('preserves subagent wrapper metadata while normalizing visible output', () => {
    expect(
      unwrapSubagentToolResult({
        content: [
          {
            type: 'text',
            text: JSON.stringify({
              success: true,
              output: 'API subagent done.',
              subagentType: 'api'
            })
          }
        ],
        output: 'API subagent done.'
      })
    ).toMatchObject({
      content: expect.any(Array),
      output: 'API subagent done.'
    })
  })
})
