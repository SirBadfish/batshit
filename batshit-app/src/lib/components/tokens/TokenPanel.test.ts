import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import TokenPanel from './TokenPanel.svelte'

describe('TokenPanel', () => {

  it('associates the existing speed and KoboldCpp information triggers with their actual tooltip nodes', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    render(TokenPanel, { props: {
      localProgramLabel: 'KoboldCpp', hasLatestResponse: true,
      outputTokensPerSecond: 88.46, performanceSource: 'ai-sdk',
      timeToFirstOutputMs: 234, responseTimeMs: 6800,
    } })
    for (const [label, text] of [
      ['View speed stats for the latest response', 'Speed (latest response)'],
      ['KoboldCpp performance information', 'KoboldCpp performance'],
    ]) {
      const trigger = screen.getByRole('button', { name: label })
      await fireEvent.focus(trigger)
      const title = await screen.findByText(text)
      const content = title.closest('[data-slot="tooltip-content"]') as HTMLElement
      await waitFor(() => {
        expect(content.id).not.toBe('')
        expect(content).toHaveAttribute('role', 'tooltip')
        expect(trigger).toHaveAttribute('aria-describedby', content.id)
        expect(document.getElementById(trigger.getAttribute('aria-describedby')!)).toBe(content)
      })
      await fireEvent.keyDown(content, { key: 'Escape' })
      await waitFor(() => expect(title).not.toBeInTheDocument())
      expect(trigger).not.toHaveAttribute('aria-describedby')
      await fireEvent.blur(trigger)
    }
  })

  it('shows used CLI tokens while the context limit is unknown', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    render(TokenPanel, {
      props: {
        currentTokens: 31_234, contextLimit: null, contextPercent: null,
        contextUnknownHint: 'This CLI model has not reported a context limit.'
      }
    })
    const trigger = screen.getByRole('button', { name: 'View context usage' })
    expect(trigger).toHaveTextContent('31K')
    expect(trigger).not.toHaveTextContent('%')
    await fireEvent.pointerEnter(trigger)
    await fireEvent.mouseEnter(trigger)
    await fireEvent.focus(trigger)
    expect(await screen.findByText('This CLI model has not reported a context limit.')).toBeInTheDocument()
  })

  it('renders without requiring an external tooltip provider', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        trimmedTokens: 0,
        costLabel: '$0.12',
        costDetail: 'Estimated running cost',
        delegatedDetail: 'Delegated (subagents/workers): 1,500 tokens · $0.0068',
        onTrim: vi.fn(),
        onCompact: vi.fn(),
        onResetTrim: vi.fn(),
        onOpenDiagnostics: vi.fn(),
        onOpenExecutionViewer: vi.fn(),
      },
    })

    expect(screen.getByRole('button', { name: 'Trim 50k from active send context' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Compact older chat context' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Diagnostics' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Open Execution Viewer' })).toBeInTheDocument()
    expect(screen.getByText('$0.12')).toBeInTheDocument()
  })

  it('opens diagnostics from the icon shortcut', async () => {
    const onOpenDiagnostics = vi.fn()

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        onOpenDiagnostics,
      },
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Open Diagnostics' }))

    expect(onOpenDiagnostics).toHaveBeenCalledOnce()
  })

  it('does not put native title tooltips on custom tooltip triggers', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        costLabel: '$0.12',
        costDetail: 'Estimated running cost',
        delegatedDetail: 'Delegated (subagents/workers): 1,500 tokens · $0.0068',
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
        delegatedDetail: 'Delegated (subagents/workers): 1,500 tokens · $0.0068',
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
    expect(
      screen.getByText('Delegated (subagents/workers): 1,500 tokens · $0.0068'),
    ).toBeInTheDocument()
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

  it('renders explicit unknown cache/speed readouts when nothing was reported (SA-093 P7)', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: false,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    const speedTrigger = screen.getByRole('button', {
      name: 'View speed stats for the latest response',
    })
    expect(cacheTrigger).toHaveTextContent('—')
    expect(speedTrigger).toHaveTextContent('—')

    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    expect(await screen.findByText('Prompt cache (latest response)')).toBeInTheDocument()
    expect(screen.getByText('No responses in this chat yet.')).toBeInTheDocument()
  })

  it('says the provider did not report stats once a response exists without them', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    expect(
      await screen.findByText(
        'The provider did not report this for the latest response.',
      ),
    ).toBeInTheDocument()
  })

  it('renders cache hit rate and cache token detail for the latest response', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        cacheHitPercent: 86.1,
        cacheCachedTokens: 6888,
        cacheInputTokens: 8000,
        cacheCreationTokens: 112,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    expect(cacheTrigger).toHaveTextContent('86%')

    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    expect(await screen.findByText('86% of input read from cache')).toBeInTheDocument()
    expect(screen.getByText('7K cached / 8K input tokens')).toBeInTheDocument()
    expect(screen.getByText('112 tokens newly written to cache')).toBeInTheDocument()
  })

  it('adds a whole-chat cache section to the cache popover when session data exists', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        cacheHitPercent: 86.1,
        cacheCachedTokens: 6888,
        cacheInputTokens: 8000,
        sessionCacheHitPercent: 72.4,
        sessionCacheCachedTokens: 121000,
        sessionCacheInputTokens: 167000,
        sessionCacheResponseCount: 14,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    expect(cacheTrigger).toHaveTextContent('86%')

    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    expect(await screen.findByText('Prompt cache (whole chat)')).toBeInTheDocument()
    expect(screen.getByText('72% of input read from cache')).toBeInTheDocument()
    expect(screen.getByText('121K cached / 167K input tokens')).toBeInTheDocument()
    expect(
      screen.getByText('Across 14 responses that reported cache data'),
    ).toBeInTheDocument()
  })

  it('omits the whole-chat cache section when no response reported cache data', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        sessionCacheHitPercent: null,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    expect(await screen.findByText('Prompt cache (latest response)')).toBeInTheDocument()
    expect(screen.queryByText('Prompt cache (whole chat)')).not.toBeInTheDocument()
  })

  it('renders tokens/sec, first-output time, and model time for the latest response', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        outputTokensPerSecond: 88.46,
        timeToFirstOutputMs: 413,
        responseTimeMs: 3600,
        responseModelCalls: 2,
      },
    })

    const speedTrigger = screen.getByRole('button', {
      name: 'View speed stats for the latest response',
    })
    expect(speedTrigger).toHaveTextContent('88 t/s')

    await fireEvent.pointerEnter(speedTrigger)
    await fireEvent.mouseEnter(speedTrigger)
    await fireEvent.focus(speedTrigger)
    expect(await screen.findByText('88 output tokens per second')).toBeInTheDocument()
    expect(screen.getByText('First output after 413 ms')).toBeInTheDocument()
    expect(screen.getByText('Model time 3.6 s across 2 calls')).toBeInTheDocument()
  })

  it('keeps one decimal for slow generation speeds', () => {
    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        outputTokensPerSecond: 8.46,
      },
    })

    expect(
      screen.getByRole('button', { name: 'View speed stats for the latest response' }),
    ).toHaveTextContent('8.5 t/s')
  })

  const koboldPerformanceNote = 'KoboldCpp doesn’t identify which reply its performance statistics belong to. Batshit shows measured reply speed when available.'

  it('explains selected KoboldCpp native performance on hover without changing measured speed', async () => {
    render(TokenPanel, { props: {
      localProgramLabel: 'KoboldCpp', hasLatestResponse: true,
      outputTokensPerSecond: 88.46, performanceSource: 'ai-sdk',
    } })
    expect(screen.getByRole('button', { name: 'View speed stats for the latest response' })).toHaveTextContent('88 t/s')
    const info = screen.getByRole('button', { name: 'KoboldCpp performance information' })
    expect(info).not.toHaveAttribute('title')
    await fireEvent.pointerEnter(info, { pointerType: 'mouse' })
    expect(await screen.findByText(koboldPerformanceNote)).toBeInTheDocument()
    expect(info).toHaveAttribute('aria-expanded', 'true')
    expect(screen.queryByText(/Showing Batshit-measured speed instead/)).not.toBeInTheDocument()
  })

  it('opens the KoboldCpp explanation with keyboard focus and dismisses it with Escape', async () => {
    render(TokenPanel, { props: { localProgramLabel: 'KoboldCpp' } })
    const info = screen.getByRole('button', { name: 'KoboldCpp performance information' })
    await fireEvent.focus(info)
    expect(await screen.findByText(koboldPerformanceNote)).toBeInTheDocument()
    expect(info).toHaveAttribute('aria-describedby')
    await fireEvent.keyDown(document, { key: 'Escape' })
    expect(info).toHaveAttribute('aria-expanded', 'false')
  })

  it('toggles the KoboldCpp explanation by tap without hover or focus', async () => {
    render(TokenPanel, { props: { localProgramLabel: 'KoboldCpp' } })
    const info = screen.getByRole('button', { name: 'KoboldCpp performance information' })
    await fireEvent.pointerDown(info, { pointerType: 'touch' })
    await fireEvent.pointerUp(info, { pointerType: 'touch' })
    await fireEvent.click(info)
    expect(await screen.findByText(koboldPerformanceNote)).toBeInTheDocument()
    expect(info).toHaveAttribute('aria-expanded', 'true')
    await fireEvent.click(info)
    expect(info).toHaveAttribute('aria-expanded', 'false')
  })

  it('opens on the browser touch pointerup-focus-click sequence and closes on a second activation', async () => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
    render(TokenPanel, { props: { localProgramLabel: 'KoboldCpp' } })
    const info = screen.getByRole('button', { name: 'KoboldCpp performance information' })
    // Chrome touch focuses after pointerup; that focus opens Bits UI before click.
    await fireEvent.pointerDown(info)
    await fireEvent.pointerUp(info)
    await fireEvent.focus(info)
    expect(info).toHaveAttribute('aria-expanded', 'true')
    await fireEvent.click(info, { detail: 1 })
    await waitFor(() => expect(info).toHaveAttribute('aria-expanded', 'true'))
    expect(await screen.findByText(koboldPerformanceNote)).toBeInTheDocument()
    await fireEvent.pointerDown(info)
    await fireEvent.pointerUp(info)
    await fireEvent.click(info, { detail: 1 })
    await waitFor(() => expect(info).toHaveAttribute('aria-expanded', 'false'))
    expect(screen.queryByText(koboldPerformanceNote)).not.toBeInTheDocument()
  })

  it.each([false, true])('preserves unknown speed and truthful copy with hasLatestResponse=%s', async hasLatestResponse => {
    render(TokenPanel, { props: { localProgramLabel: 'KoboldCpp', hasLatestResponse } })
    expect(screen.getByRole('button', { name: 'View speed stats for the latest response' })).toHaveTextContent('—')
    await fireEvent.click(screen.getByRole('button', { name: 'KoboldCpp performance information' }))
    expect(await screen.findByText(koboldPerformanceNote)).toBeInTheDocument()
    expect(screen.queryByText(/output tokens per second/)).not.toBeInTheDocument()
  })

  it.each([null, 'Ollama', 'LM Studio'])('has no KoboldCpp information icon for %s', localProgramLabel => {
    render(TokenPanel, { props: { localProgramLabel } })
    expect(screen.queryByRole('button', { name: 'KoboldCpp performance information' })).not.toBeInTheDocument()
  })

  it('removes an open explanation when the selected program changes and keeps it closed on return', async () => {
    const view = render(TokenPanel, { props: { localProgramLabel: 'KoboldCpp' } })
    await fireEvent.click(screen.getByRole('button', { name: 'KoboldCpp performance information' }))
    expect(await screen.findByText(koboldPerformanceNote)).toBeInTheDocument()
    await view.rerender({ localProgramLabel: 'Ollama' })
    expect(screen.queryByRole('button', { name: 'KoboldCpp performance information' })).not.toBeInTheDocument()
    expect(screen.queryByText(koboldPerformanceNote)).not.toBeInTheDocument()
    await view.rerender({ localProgramLabel: 'KoboldCpp' })
    expect(screen.getByRole('button', { name: 'KoboldCpp performance information' })).toHaveAttribute('aria-expanded', 'false')
  })

  it.each([
    ['Ollama', 'never-reports'],
    ['SGLang', 'reports'],
  ] as const)('names %s when this response omitted cache counts', async (program, reporting) => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        localProgramLabel: program,
        localCacheReporting: reporting,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    expect(
      await screen.findByText(new RegExp(`${program} did not report cache counts for this response`)),
    ).toBeInTheDocument()
    expect(screen.getByText(/cannot determine cache reuse from response speed alone/)).toBeInTheDocument()
  })

  it.each(['reports', 'never-reports'] as const)('explains a genuine zero regardless of the %s capability', async (reporting) => {
    ;(window as any).ResizeObserver ??= class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    }

    render(TokenPanel, {
      props: {
        currentTokens: 12000,
        contextLimit: 128000,
        hasLatestResponse: true,
        cacheHitPercent: 0,
        cacheCachedTokens: 0,
        cacheInputTokens: 2140,
        localProgramLabel: 'oMLX',
        localCacheReporting: reporting,
      },
    })

    const cacheTrigger = screen.getByRole('button', {
      name: 'View prompt cache hit rate for the latest response',
    })
    await fireEvent.pointerEnter(cacheTrigger)
    await fireEvent.mouseEnter(cacheTrigger)
    await fireEvent.focus(cacheTrigger)
    // oMLX caches in 4,096-token blocks, so a short conversation honestly
    // reports none until it grows past one block.
    expect(await screen.findByText(/only cache in large blocks/)).toBeInTheDocument()
  })
})
