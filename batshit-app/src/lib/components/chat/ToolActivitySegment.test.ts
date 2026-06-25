import { render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'
import ToolActivitySegment from './ToolActivitySegment.svelte'

const baseProps = {
  segmentIndex: 0,
  messageId: 'msg_missing_zip',
  currentSessionId: 'session_missing_zip',
  messagesAgo: 3,
  zipMetadataFromRedis: new Map<string, any>(),
  pendingCoolToolFetch: new Set<string>(),
  coolToolFromZip: new Map<string, any>(),
  showZippedBadges: false,
  zippedBadgesHoverOnly: false,
  showZippedBorders: false,
  zippedBordersHoverOnly: false,
  showUnzippedBadges: false,
  unzippedBadgesHoverOnly: false,
  showUnzippedBorders: false,
  unzippedBordersHoverOnly: false,
  alwaysShowZipBorders: false,
  resolveZipTokens: (_zipId?: string, fallback = 0) => fallback,
  resolveZipVisualState: () => ({ isUnzipped: true }),
  shouldShowAsZip: () => false,
  handleUnzip: vi.fn(),
  handleZipNow: vi.fn(),
  handleReturnAutomatic: vi.fn(),
}

describe('ToolActivitySegment', () => {
  it('renders a stable missing state for a zip-backed tool result with no hydrateable zip', () => {
    const zipId = 'cool_tool_1779416324513_missing1'

    render(ToolActivitySegment, {
      ...baseProps,
      segment: {
        type: 'cool_tool',
        zipId,
        toolName: 'read_file',
        description: 'Tool execution: read_file',
      },
      missingCoolToolZips: new Set([zipId]),
    })

    expect(
      screen.getByText('Tool result unavailable (zip missing)'),
    ).toBeInTheDocument()
    expect(screen.queryByText(/Loading/i)).not.toBeInTheDocument()
  })
})
