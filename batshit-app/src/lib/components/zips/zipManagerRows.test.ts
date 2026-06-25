import { describe, expect, it } from 'vitest'

import {
  getHiddenRawSidecarZipIds,
  shouldShowZipManagerItem
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
