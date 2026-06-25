import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import TokenPanel from './TokenPanel.svelte'

describe('TokenPanel', () => {
  it('renders without requiring an external tooltip provider', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        trimmedTokens: 0,
        costLabel: '$0.12',
        costDetail: 'Estimated running cost',
        onTrim: vi.fn(),
        onCompact: vi.fn(),
        onResetTrim: vi.fn(),
        onOpenExecutionViewer: vi.fn(),
      },
    })

    expect(screen.getByRole('button', { name: 'Trim 50k from active send context' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compact older chat context' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Execution Viewer' })).toBeInTheDocument()
    expect(screen.getByText('$0.12')).toBeInTheDocument()
  })

  it('does not put native title tooltips on custom tooltip triggers', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        costLabel: '$0.12',
        costDetail: 'Estimated running cost',
      },
    })

    expect(screen.getByLabelText('View running chat cost')).not.toHaveAttribute('title')
    expect(screen.getByLabelText('View context usage')).not.toHaveAttribute('title')
  })

  it('shows running cost and context estimate details in the cost tooltip', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 91000,
        contextLimit: 200000,
        contextPercent: 45.5,
        contextState: 'estimated',
        contextLabel: '~91K live',
        contextDetail: 'Context meter is showing a live compiled estimate after the active response changed since the last send.',
        costLabel: '$0.12',
        costDetail: 'Estimated running cost',
        onTrim: vi.fn(),
        onCompact: vi.fn(),
        onResetTrim: vi.fn(),
      },
    })

    const trigger = screen.getByRole('button', { name: 'View running chat cost' })
    await fireEvent.pointerEnter(trigger)
    await fireEvent.mouseEnter(trigger)
    await fireEvent.focus(trigger)

    expect(await screen.findByText('Running chat cost')).toBeInTheDocument()
    expect(screen.getByText('Estimated running cost')).toBeInTheDocument()
    expect(screen.getByText('Context window estimate')).toBeInTheDocument()
    expect(screen.getByText(/active response changed/)).toBeInTheDocument()
  })

  it('keeps the context tooltip focused on the simple usage summary', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 6000,
        contextLimit: 1000000,
        contextPercent: 0.6,
        contextState: 'estimated',
        contextLabel: '~6K live',
        contextDetail: 'Long context estimation copy belongs in the cost tooltip instead.',
      },
    })

    const trigger = screen.getByRole('button', { name: 'View context usage' })
    await fireEvent.pointerEnter(trigger)
    await fireEvent.mouseEnter(trigger)
    await fireEvent.focus(trigger)

    expect(screen.getByText('~1%')).toBeInTheDocument()
    expect(await screen.findByText('Context window')).toBeInTheDocument()
    expect(screen.getByText('~6K live')).toBeInTheDocument()
    expect(screen.getByText('1% used (99% left)')).toBeInTheDocument()
    expect(screen.getByText('6K / 1M tokens used')).toBeInTheDocument()
    expect(screen.queryByText(/Long context estimation copy/)).not.toBeInTheDocument()
  })

  it('keeps the manual trim reset control with the trim status before compact', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        trimmedTokens: 50000,
        compactedTokens: 0,
        onTrim: vi.fn(),
        onCompact: vi.fn(),
        onResetTrim: vi.fn(),
      },
    })

    const trimStatus = screen.getByText('50K trimmed')
    const resetButton = screen.getByRole('button', { name: 'Reset manual trim' })
    const compactButton = screen.getByRole('button', { name: 'Compact older chat context' })
    const compactStatus = screen.getByText('0 compacted')

    expect(trimStatus.compareDocumentPosition(resetButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(resetButton.compareDocumentPosition(compactButton) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
    expect(compactButton.compareDocumentPosition(compactStatus) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy()
  })

  it('formats compact context amounts as K below a million and M at million scale', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 4000,
        contextLimit: 1000000,
        trimmedTokens: 735000,
        compactedTokens: 1000000,
        onTrim: vi.fn(),
        onCompact: vi.fn(),
        onResetTrim: vi.fn(),
      },
    })

    expect(screen.getByText('735K trimmed')).toBeInTheDocument()
    expect(screen.getByText('1M compacted')).toBeInTheDocument()
  })

  it('keeps manual trim disabled when the caller marks it unavailable', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 68000,
        contextLimit: 200000,
        contextPercent: 34,
        contextState: 'exact',
        contextLabel: '68k last sent',
        contextDetail: 'Runtime usage captured by Execution Viewer.',
        trimAvailable: false,
        trimUnavailableReason: 'Manual trim is paused.',
        compactAvailable: false,
        compactUnavailableReason: 'Compact is paused.',
        onTrim: vi.fn(),
      },
    })

    expect(screen.getByRole('button', { name: 'Trim 50k from active send context' })).toBeDisabled()
    expect(screen.getByRole('button', { name: 'Compact older chat context' })).toBeDisabled()
    expect(screen.getByText('34%')).toBeInTheDocument()
  })

  it('shows a running compact status while compacting', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 68000,
        contextLimit: 200000,
        compactAvailable: true,
        compactBusy: true,
        compactStatus: 'Generating compact summary...',
        onCompact: vi.fn(),
      },
    })

    expect(screen.getByRole('button', { name: 'Compact older chat context' })).toBeDisabled()
    expect(screen.getByRole('status')).toHaveTextContent('Generating compact summary...')
  })
})
