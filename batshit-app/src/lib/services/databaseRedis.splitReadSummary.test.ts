import { describe, expect, it, vi } from 'vitest'

vi.mock('$lib/server/redis', () => ({ redis: {}, RedisService: class {} }))
vi.mock('$env/dynamic/public', () => ({ env: {} }))

import { DatabaseService } from './databaseRedis.server'

/**
 * BL-1652: every part of a split multi-file read shares its call's Tool Note, so in the appended
 * zip index each part's line names its own file first; an ordinary zip keeps the note alone.
 */
function entry(zipId: string, description: string, metadata: Record<string, any>) {
  return {
    zipId,
    zip: { description },
    zipData: { type: 'cool_tool', metadata: { toolCallId: 'call_1', operationKind: 'read_file', ...metadata } },
    expandedContent: `content of ${zipId}`,
    message: {
      id: 'msg_1',
      timestamp: '2026-10-18T15:00:00.000Z',
      metadata: { zipControl: { toolNotes: [{ toolCallId: 'call_1', summary: 'isoWeek has the Sunday bug' }] } }
    }
  }
}

describe('the zip index line of a split read part (BL-1652)', () => {
  const service = new DatabaseService() as any

  it('starts with the part\'s own label and keeps the call\'s note after it', () => {
    const index = service.buildZipAppend([
      entry('cool_tool_1792345678901_ab3de', 'read_file: src/isoWeek.js - 3 lines', { shellReadSplitPart: { index: 0, of: 2, command: 'cat src/isoWeek.js test/x.js' } }),
      entry('cool_tool_1792345678901_s1abcdefg', 'read_file: test/x.js - 2 lines', { shellReadSplitPart: { index: 1, of: 2, command: 'cat src/isoWeek.js test/x.js' } })
    ])
    expect(index).toContain('summary: "read_file: src/isoWeek.js - 3 lines; note for the whole command: isoWeek has the Sunday bug"')
    expect(index).toContain('summary: "read_file: test/x.js - 2 lines; note for the whole command: isoWeek has the Sunday bug"')
  })

  it('leaves an ordinary zip with the note as its summary', () => {
    const index = service.buildZipAppend([entry('cool_tool_1792345678901_zz9zz', 'read_file: src/cli.js - 9 lines', {})])
    expect(index).toContain('summary: "isoWeek has the Sunday bug"')
  })
})
