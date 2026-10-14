import { describe, expect, it } from 'vitest'

import {
  countZipManagerHolds,
  getHiddenRawSidecarZipIds,
  shouldShowZipManagerItem,
  ZIP_MANAGER_FILTERS,
  zipManagerEmptyCopy
} from './zipManagerRows'

describe('Zip Manager row visibility', () => {
  it('hides raw sidecar zips when their main cool tool zip is present', () => {
    const zips = [
      {
        id: 'main-cool_tool-0',
        type: 'cool_tool',
        metadata: {
          rawSidecarZipId: 'raw-tool_raw-1',
          toolCallId: 'call_skill_read_1'
        }
      },
      {
        id: 'raw-tool_raw-1',
        type: 'tool_raw',
        metadata: {
          rawSidecar: true,
          toolCallId: 'call_skill_read_1'
        }
      }
    ]

    const hiddenIds = getHiddenRawSidecarZipIds(zips)

    expect(shouldShowZipManagerItem(zips[0], hiddenIds)).toBe(true)
    expect(shouldShowZipManagerItem(zips[1], hiddenIds)).toBe(false)
  })

  it('keeps standalone raw sidecars visible when the main zip is missing', () => {
    const rawOnly = {
      id: 'raw-tool_raw-1',
      type: 'tool_raw',
      metadata: {
        rawSidecar: true,
        toolCallId: 'call_skill_read_1'
      }
    }

    const hiddenIds = getHiddenRawSidecarZipIds([rawOnly])

    expect(shouldShowZipManagerItem(rawOnly, hiddenIds)).toBe(true)
  })

  it('does not hide a different sidecar just because its id has the same normalized base', () => {
    const zips = [
      {
        id: 'main-cool_tool-0',
        type: 'cool_tool',
        metadata: {
          rawSidecarZipId: 'raw-tool_raw-1',
          toolCallId: 'call_skill_read_1'
        }
      },
      {
        id: 'raw-tool_raw-1',
        type: 'tool_raw',
        metadata: {
          rawSidecar: true,
          toolCallId: 'call_skill_read_1'
        }
      },
      {
        id: 'raw-tool_raw-2',
        type: 'tool_raw',
        metadata: {
          rawSidecar: true,
          toolCallId: 'call_skill_read_2'
        }
      }
    ]

    const hiddenIds = getHiddenRawSidecarZipIds(zips)

    expect(shouldShowZipManagerItem(zips[1], hiddenIds)).toBe(false)
    expect(shouldShowZipManagerItem(zips[2], hiddenIds)).toBe(true)
  })
})

// BL-1485 (SA-129 D1, DL-07): one vocabulary. The state is compressed or expanded; Hold, Hold for
// N messages and Release are the actions; "zip" stays the verb.
describe('Zip Manager words (BL-1485)', () => {
  it('filters read Expanded, Compressed, All', () => {
    expect(ZIP_MANAGER_FILTERS.map((filter) => filter.label)).toEqual(['Expanded', 'Compressed', 'All'])
  })

  it('every empty state says compressed or expanded, never unzipped or zipped', () => {
    const copies = ZIP_MANAGER_FILTERS.map((filter) => zipManagerEmptyCopy(filter.value))
    expect(copies).toEqual([
      'Nothing is expanded right now.',
      'No compressed results in this chat yet.',
      'No zips in this chat yet.'
    ])
    for (const copy of copies) expect(copy).not.toMatch(/unzipped|zipped|items/)
  })

  it('"N held" counts every hold, with or without a countdown, whoever holds it', () => {
    const rows = [
      { isManuallyUnzipped: true }, // Hold (you)
      { isManuallyUnzipped: true }, // Hold for 10 messages (you)
      { isManuallyUnzipped: true }, // an agent's hold on a dead copy the prompt compresses
      { isManuallyUnzipped: true }, // a Judge Juice open, two messages
      { isManuallyUnzipped: false }, // open by the buffer
      { isManuallyUnzipped: false } // compressed
    ]
    expect(countZipManagerHolds(rows)).toBe(4)
    expect(countZipManagerHolds([])).toBe(0)
  })
})
