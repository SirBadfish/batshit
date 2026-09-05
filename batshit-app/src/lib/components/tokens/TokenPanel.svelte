<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import {
    Archive,
    Bug,
    Coins,
    Database,
    FileText,
    Gauge,
    Moon,
    RotateCcw,
    Scissors
  } from '@lucide/svelte'

  let {
    currentTokens = 0,
    contextLimit = null,
    contextPercent = null,
    contextState = 'unknown',
    contextLabel = 'Unknown',
    contextDetail = 'Context usage is unavailable.',
    trimmedTokens = 0,
    costLabel = 'Unknown',
    costDetail = 'Cost is unavailable.',
    costState = 'unknown',
    delegatedDetail = null,
    trimAvailable = false,
    trimUnavailableReason = 'Manual trim is unavailable.',
    trimBusy = false,
    compactAvailable = false,
    compactUnavailableReason = 'Compact is unavailable.',
    compactBusy = false,
    compactStatus = null,
    compactedTokens = 0,
    napMode = false,
    napAvailable = false,
    napUnavailableReason = 'Nap is unavailable.',
    napBusy = false,
    napStatus = null,
    hasLatestResponse = false,
    cacheHitPercent = null,
    localProgramLabel = null,
    localCacheReporting = null,
    cacheCachedTokens = null,
    cacheInputTokens = null,
    cacheCreationTokens = null,
    sessionCacheHitPercent = null,
    sessionCacheCachedTokens = null,
    sessionCacheInputTokens = null,
    sessionCacheResponseCount = null,
    outputTokensPerSecond = null,
    timeToFirstOutputMs = null,
    responseTimeMs = null,
    responseModelCalls = null,
    performanceSource = null,
    onTrim = () => {},
    onCompact = () => {},
    onNap = () => {},
    onResetTrim = () => {},
    onOpenDiagnostics = () => {},
    onOpenExecutionViewer = () => {}
  } = $props<{
    currentTokens?: number | null
    contextLimit?: number | null
    contextPercent?: number | null
    contextState?: 'exact' | 'near' | 'estimated' | 'unknown'
    contextLabel?: string
    contextDetail?: string
    trimmedTokens?: number
    costLabel?: string
    costDetail?: string
    costState?: 'exact' | 'estimated' | 'unknown'
    delegatedDetail?: string | null
    trimAvailable?: boolean
    trimUnavailableReason?: string
    trimBusy?: boolean
    compactAvailable?: boolean
    compactUnavailableReason?: string
    compactBusy?: boolean
    compactStatus?: string | null
    compactedTokens?: number
    /** SA-104 P6: Infinite Sessions replace Compact with the nap. */
    napMode?: boolean
    napAvailable?: boolean
    napUnavailableReason?: string
    napBusy?: boolean
    napStatus?: string | null
    /** SA-093 P7: latest-response cache and speed readouts (DL-093-14). */
    hasLatestResponse?: boolean
    cacheHitPercent?: number | null
    /**
     * SA-102 P4 (DL-102-13): the local AI program's NAME, so the readout can
     * say "LM Studio does not report this" instead of "the runtime".
     */
    localProgramLabel?: string | null
    /**
     * SA-102 P4 (DL-102-13): whether that program reports cached prompt tokens
     * at all. This is a property of the PROGRAM, not of the number, because a
     * program that never reports and a program that reported a genuine miss
     * both arrive as "no number" — and before this, both were shown the same
     * way. Measured: Ollama went 43,085 ms -> 1,268 ms with no cache number at
     * any point. The cache was working; Batshit simply could not see it.
     */
    localCacheReporting?: 'reports' | 'never-reports' | null
    cacheCachedTokens?: number | null
    cacheInputTokens?: number | null
    cacheCreationTokens?: number | null
    /** Whole-chat token-weighted cache aggregate over responses that reported cache usage. */
    sessionCacheHitPercent?: number | null
    sessionCacheCachedTokens?: number | null
    sessionCacheInputTokens?: number | null
    sessionCacheResponseCount?: number | null
    outputTokensPerSecond?: number | null
    timeToFirstOutputMs?: number | null
    responseTimeMs?: number | null
    responseModelCalls?: number | null
    /** 'ai-sdk' = SDK-measured (API lane); 'measured' = Batshit wall-clock (CLI lanes). */
    performanceSource?: 'ai-sdk' | 'measured' | null
    onTrim?: (tokensToTrim: number) => void | Promise<void>
    onCompact?: () => void | Promise<void>
    onNap?: () => void | Promise<void>
    onResetTrim?: () => void
    onOpenDiagnostics?: () => void
    onOpenExecutionViewer?: () => void
  }>()

  const resolvedContextPercent = $derived.by(() => {
    if (typeof contextPercent === 'number' && Number.isFinite(contextPercent)) {
      return Math.max(0, Math.min(contextPercent, 100))
    }
    if (!contextLimit || contextLimit <= 0) return null
    const safeCurrentTokens =
      typeof currentTokens === 'number' && Number.isFinite(currentTokens) ? currentTokens : null
    if (safeCurrentTokens === null) return null
    return Math.max(0, Math.min((safeCurrentTokens / contextLimit) * 100, 100))
  })

  const contextPercentLabel = $derived.by(() => {
    if (resolvedContextPercent === null) return 'Unknown'
    const prefix = contextState === 'estimated' || contextState === 'near' ? '~' : ''
    return `${prefix}${Math.round(resolvedContextPercent)}%`
  })

  const ringCircumference = 2 * Math.PI * 16
  const ringOffset = $derived.by(() => {
    if (resolvedContextPercent === null) return ringCircumference
    return ringCircumference - (ringCircumference * resolvedContextPercent) / 100
  })

  function formatRoundedThousands(value: number | null | undefined): string {
    if (!Number.isFinite(value)) return 'Unknown'
    const safeValue = Math.max(0, Math.round(value as number))
    if (safeValue < 1000) return `${safeValue}`
    const roundedThousands = Math.round(safeValue / 1000)
    if (roundedThousands < 1000) return `${roundedThousands}K`
    const roundedMillions = Math.round((safeValue / 1_000_000) * 10) / 10
    return `${roundedMillions.toFixed(Number.isInteger(roundedMillions) ? 0 : 1)}M`
  }

  function formatPercentUsed(value: number | null): string {
    if (value === null) return 'Unknown'
    const used = Math.round(value)
    const left = Math.max(0, 100 - used)
    return `${used}% used (${left}% left)`
  }

  function handleTrimClick() {
    if (!trimAvailable || trimBusy) return
    onTrim(50_000)
  }

  function handleCompactClick() {
    if (!compactAvailable || compactBusy) return
    onCompact()
  }

  function handleNapClick() {
    if (!napAvailable || napBusy) return
    onNap()
  }

  function formatTrimmed(value: number): string {
    if (value <= 0) return '0 trimmed'
    return `${formatRoundedThousands(value)} trimmed`
  }

  // SA-093 P7 display rules (DL-093-14): a metric the runtime did not report
  // renders as an explicit em dash, never a guess.
  const cacheHitLabel = $derived.by(() => {
    if (typeof cacheHitPercent !== 'number' || !Number.isFinite(cacheHitPercent)) return '—'
    return `${Math.round(cacheHitPercent)}%`
  })

  const sessionCacheHitLabel = $derived.by(() => {
    if (
      typeof sessionCacheHitPercent !== 'number' ||
      !Number.isFinite(sessionCacheHitPercent)
    ) {
      return '—'
    }
    return `${Math.round(sessionCacheHitPercent)}%`
  })

  const speedLabel = $derived.by(() => {
    if (
      typeof outputTokensPerSecond !== 'number' ||
      !Number.isFinite(outputTokensPerSecond)
    ) {
      return '—'
    }
    const rounded =
      outputTokensPerSecond >= 10
        ? Math.round(outputTokensPerSecond).toString()
        : (Math.round(outputTokensPerSecond * 10) / 10).toString()
    return `${rounded} t/s`
  })

  function formatMs(value: number): string {
    if (value < 1000) return `${Math.round(value)} ms`
    return `${(Math.round(value / 100) / 10).toFixed(1)} s`
  }

  const unknownStatsNote = $derived.by(() =>
    hasLatestResponse
      ? 'The provider did not report this for the latest response.'
      : 'No responses in this chat yet.'
  )

  /**
   * SA-102 P4 (DL-102-13): the three-way truth about a local prompt cache.
   * Never inferred from timing, and never a zero the program did not send.
   */
  const cacheNote = $derived.by(() => {
    if (!hasLatestResponse) return 'No responses in this chat yet.'
    const program = localProgramLabel ?? 'This program'
    if (localCacheReporting != null && cacheHitPercent === 0) {
      return `${program} reported no cached tokens this time. Some programs only cache in large blocks, so a short conversation honestly reports none until it grows.`
    }
    if (localCacheReporting != null) {
      return `${program} did not report cache counts for this response. Batshit cannot determine cache reuse from response speed alone.`
    }
    return unknownStatsNote
  })

  function formatCompacted(value: number): string {
    if (value <= 0) return '0 compacted'
    return `${formatRoundedThousands(value)} compacted`
  }
</script>

<Tooltip.Provider delayDuration={0}>
  <div class="token-panel">
    <div class="token-panel-bar">
      <Tooltip.Root>
        <Tooltip.Trigger
          class="token-panel-trigger"
          aria-label="View running chat cost"
          data-ab-control="token-running-cost"
        >
          <Coins class="token-panel-trigger-icon" />
          <span>{costLabel}</span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" class="token-panel-tooltip is-cost">
          <div class="token-panel-tooltip-stack">
            <div class="token-panel-tooltip-section">
              <div class="token-panel-tooltip-title">Running chat cost</div>
              <div>{costDetail}</div>
              {#if delegatedDetail}
                <div>{delegatedDetail}</div>
              {/if}
            </div>
            {#if contextDetail}
              <div class="token-panel-tooltip-section">
                <div class="token-panel-tooltip-title">Context window estimate</div>
                <div>{contextDetail}</div>
              </div>
            {/if}
          </div>
        </Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          class="token-panel-trigger"
          aria-label="View context usage"
          data-ab-control="token-context-usage"
        >
          <span class="token-panel-ring">
            <svg class="token-panel-ring-svg" viewBox="0 0 40 40" aria-hidden="true">
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                stroke="currentColor"
                stroke-opacity="0.18"
                stroke-width="3"
              />
              <circle
                cx="20"
                cy="20"
                r="16"
                fill="none"
                stroke="currentColor"
                stroke-width="3"
                stroke-linecap="round"
                stroke-dasharray={ringCircumference}
                stroke-dashoffset={ringOffset}
                class="token-panel-ring-meter"
                class:is-danger={resolvedContextPercent !== null && resolvedContextPercent >= 90}
                class:is-warning={resolvedContextPercent !== null && resolvedContextPercent >= 80 && resolvedContextPercent < 90}
                class:is-unknown={resolvedContextPercent === null}
              />
            </svg>
          </span>
          <span>{contextPercentLabel}</span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" class="token-panel-tooltip is-context">
          <div class="token-panel-tooltip-stack">
            <div class="token-panel-tooltip-title">Context window</div>
            <div class="token-panel-tooltip-emphasis">{contextLabel}</div>
            <div>{formatPercentUsed(resolvedContextPercent)}</div>
            <div>
              {formatRoundedThousands(currentTokens)} / {formatRoundedThousands(contextLimit)} tokens used
            </div>
          </div>
        </Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          class="token-panel-trigger"
          aria-label="View prompt cache hit rate for the latest response"
          data-testid="token-cache-hit-trigger"
          data-ab-control="token-cache-hit"
        >
          <Database class="token-panel-trigger-icon" />
          <span>{cacheHitLabel}</span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" class="token-panel-tooltip is-context">
          <div class="token-panel-tooltip-stack">
            <div class="token-panel-tooltip-section">
              <div class="token-panel-tooltip-title">Prompt cache (latest response)</div>
              {#if typeof cacheHitPercent === 'number'}
                <div class="token-panel-tooltip-emphasis">{cacheHitLabel} of input read from cache</div>
                {#if cacheHitPercent === 0 && localCacheReporting != null}
                  <div>{cacheNote}</div>
                {/if}
                {#if typeof cacheCachedTokens === 'number' && typeof cacheInputTokens === 'number'}
                  <div>
                    {formatRoundedThousands(cacheCachedTokens)} cached / {formatRoundedThousands(cacheInputTokens)} input tokens
                  </div>
                {/if}
                {#if typeof cacheCreationTokens === 'number' && cacheCreationTokens > 0}
                  <div>{formatRoundedThousands(cacheCreationTokens)} tokens newly written to cache</div>
                {/if}
              {:else}
                <div>{cacheNote}</div>
              {/if}
            </div>
            {#if typeof sessionCacheHitPercent === 'number'}
              <div class="token-panel-tooltip-section">
                <div class="token-panel-tooltip-title">Prompt cache (whole chat)</div>
                <div class="token-panel-tooltip-emphasis">{sessionCacheHitLabel} of input read from cache</div>
                {#if typeof sessionCacheCachedTokens === 'number' && typeof sessionCacheInputTokens === 'number'}
                  <div>
                    {formatRoundedThousands(sessionCacheCachedTokens)} cached / {formatRoundedThousands(sessionCacheInputTokens)} input tokens
                  </div>
                {/if}
                {#if typeof sessionCacheResponseCount === 'number' && sessionCacheResponseCount > 0}
                  <div>
                    Across {sessionCacheResponseCount} response{sessionCacheResponseCount === 1 ? '' : 's'} that reported cache data
                  </div>
                {/if}
              </div>
            {/if}
          </div>
        </Tooltip.Content>
      </Tooltip.Root>

      <Tooltip.Root>
        <Tooltip.Trigger
          class="token-panel-trigger"
          aria-label="View speed stats for the latest response"
          data-testid="token-speed-trigger"
          data-ab-control="token-speed"
        >
          <Gauge class="token-panel-trigger-icon" />
          <span>{speedLabel}</span>
        </Tooltip.Trigger>
        <Tooltip.Content side="top" class="token-panel-tooltip is-context">
          <div class="token-panel-tooltip-stack">
            <div class="token-panel-tooltip-title">Speed (latest response)</div>
            {#if typeof outputTokensPerSecond === 'number' || typeof timeToFirstOutputMs === 'number' || typeof responseTimeMs === 'number'}
              {#if typeof outputTokensPerSecond === 'number'}
                <div class="token-panel-tooltip-emphasis">{speedLabel.replace(' t/s', '')} output tokens per second</div>
              {/if}
              {#if typeof timeToFirstOutputMs === 'number'}
                <div>First output after {formatMs(timeToFirstOutputMs)}</div>
              {/if}
              {#if typeof responseTimeMs === 'number'}
                <div>
                  Model time {formatMs(responseTimeMs)}{typeof responseModelCalls === 'number' && responseModelCalls > 1
                    ? ` across ${responseModelCalls} calls`
                    : ''}
                </div>
              {/if}
              {#if performanceSource === 'measured'}
                <div>Measured live by Batshit; first output includes CLI startup time.</div>
              {/if}
            {:else}
              <div>{unknownStatsNote}</div>
            {/if}
          </div>
        </Tooltip.Content>
      </Tooltip.Root>

      <Button
        size="sm"
        variant="outline"
        onclick={handleTrimClick}
        disabled={!trimAvailable || trimBusy}
        class="token-panel-trim-button"
        aria-label="Trim 50k from active send context"
        title={trimBusy ? 'Calculating trim preview' : trimAvailable ? 'Trim 50k from active send context' : trimUnavailableReason}
        data-testid="token-trim-50k-button"
        data-ab-control="token-trim-50k"
      >
        <Scissors class="token-panel-button-icon" />
        {trimBusy ? 'Calculating...' : 'Trim 50k'}
      </Button>

      <span class="token-panel-trimmed">{formatTrimmed(trimmedTokens)}</span>

      <Button
        size="icon"
        variant="ghost"
        onclick={onResetTrim}
        disabled={trimmedTokens <= 0}
        class="token-panel-icon-button is-reset"
        aria-label="Reset manual trim"
        title="Reset manual trim"
        data-testid="token-trim-reset-button"
        data-ab-control="token-trim-reset"
      >
        <RotateCcw class="token-panel-icon-button-icon" />
      </Button>

      {#if napMode}
        <Button
          size="sm"
          variant="outline"
          onclick={handleNapClick}
          disabled={!napAvailable || napBusy}
          class="token-panel-trim-button"
          aria-label="Nap: graduate episodes and tidy context"
          title={napBusy ? (napStatus || 'Napping') : napAvailable ? 'Nap: graduate closed episodes, compress stale bulk, and refresh the whiteboard' : napUnavailableReason}
          data-testid="token-nap-button"
          data-ab-control="token-nap"
        >
          {#if napBusy}
            <span class="token-panel-spinner" aria-hidden="true"></span>
          {:else}
            <Moon class="token-panel-button-icon" />
          {/if}
          {napBusy ? 'Napping...' : 'Nap'}
        </Button>
      {:else}
        <Button
          size="sm"
          variant="outline"
          onclick={handleCompactClick}
          disabled={!compactAvailable || compactBusy}
          class="token-panel-trim-button"
          aria-label="Compact older chat context"
          title={compactBusy ? (compactStatus || 'Compacting context') : compactAvailable ? 'Compact older chat context' : compactUnavailableReason}
          data-testid="token-compact-button"
          data-ab-control="token-compact"
        >
          {#if compactBusy}
            <span class="token-panel-spinner" aria-hidden="true"></span>
          {:else}
            <Archive class="token-panel-button-icon" />
          {/if}
          {compactBusy ? 'Compacting...' : 'Compact'}
        </Button>
      {/if}

      <span class="token-panel-trimmed">{formatCompacted(compactedTokens)}</span>

      <div class="token-panel-spacer"></div>

      <Button
        size="icon"
        variant="ghost"
        onclick={onOpenDiagnostics}
        class="token-panel-icon-button"
        aria-label="Open Diagnostics"
        title="Open Diagnostics"
        data-testid="token-diagnostics-button"
        data-ab-control="open-diagnostics"
      >
        <Bug class="token-panel-icon-button-icon" />
      </Button>

      <Button
        size="icon"
        variant="ghost"
        onclick={onOpenExecutionViewer}
        class="token-panel-icon-button"
        aria-label="Open Execution Viewer"
        title="Open Execution Viewer"
        data-testid="token-execution-viewer-button"
        data-ab-control="open-execution-viewer"
      >
        <FileText class="token-panel-icon-button-icon" />
      </Button>
    </div>
    {#if compactBusy}
      <div class="token-panel-compact-status" role="status" aria-live="polite">
        <span class="token-panel-spinner is-inline" aria-hidden="true"></span>
        <span>{compactStatus || 'Compacting context...'}</span>
      </div>
    {/if}
    {#if napBusy}
      <div class="token-panel-compact-status" role="status" aria-live="polite">
        <span class="token-panel-spinner is-inline" aria-hidden="true"></span>
        <span>{napStatus || 'Napping...'}</span>
      </div>
    {/if}
  </div>
</Tooltip.Provider>

<style>
  .token-panel {
    padding: 0.25rem 1rem 0.5rem;
    margin-top: 5px;
    background: var(--background);
  }

  :global(body.goon-immersive) .token-panel {
    background: transparent;
    backdrop-filter: blur(6px);
  }

  .token-panel-bar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    max-width: 52rem;
    margin: 0 auto;
    color: var(--bs-app-muted-text);
    font-size: 0.75rem;
  }

  :global(body.goon-immersive) .token-panel-bar {
    color: oklch(0.96 0.006 289.95 / 0.82);
  }

  :global(.token-panel-trigger) {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
    margin-right: 0.375rem;
    padding: 0.375rem 0.25rem;
    border: 0;
    background: transparent;
    color: var(--bs-app-muted-text);
    font-size: 0.6875rem;
    line-height: 1;
    cursor: pointer;
    transition: color 150ms ease-out;
  }

  :global(.token-panel-trigger:hover),
  :global(.token-panel-trigger:focus-visible) {
    color: var(--bs-app-title);
    outline: none;
  }

  :global(body.goon-immersive .token-panel-trigger) {
    color: oklch(0.96 0.006 289.95 / 0.8);
  }

  :global(body.goon-immersive .token-panel-trigger:hover),
  :global(body.goon-immersive .token-panel-trigger:focus-visible) {
    color: oklch(0.99 0.002 289.95);
  }

  :global(.token-panel-trigger-icon),
  :global(.token-panel-button-icon),
  :global(.token-panel-icon-button-icon) {
    width: 14px;
    height: 14px;
    color: currentColor;
  }

  :global(.token-panel-button-icon) {
    margin-right: 0.25rem;
  }

  .token-panel-spinner {
    display: inline-block;
    width: 14px;
    height: 14px;
    margin-right: 0.25rem;
    border: 2px solid currentColor;
    border-right-color: transparent;
    border-radius: 999px;
    animation: token-panel-spin 780ms linear infinite;
  }

  .token-panel-spinner.is-inline {
    margin-right: 0;
  }

  :global(.token-panel-tooltip) {
    color: var(--bs-app-text);
  }

  :global(.token-panel-tooltip.is-cost) {
    max-width: 300px;
  }

  :global(.token-panel-tooltip.is-context) {
    max-width: 240px;
  }

  .token-panel-tooltip-stack {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: 0.75rem;
  }

  .token-panel-tooltip-title {
    color: var(--bs-app-title);
    font-weight: 500;
  }

  .token-panel-tooltip-section + .token-panel-tooltip-section {
    margin-top: 0.35rem;
    padding-top: 0.45rem;
    border-top: 1px solid var(--bs-app-inner-line);
  }

  .token-panel-tooltip-emphasis {
    color: var(--bs-app-title);
    font-weight: 500;
  }

  .token-panel-ring {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 24px;
    height: 24px;
  }

  .token-panel-ring-svg {
    width: 24px;
    height: 24px;
    transform: rotate(-90deg);
  }

  .token-panel-ring-meter {
    color: var(--bs-app-primary-line);
  }

  .token-panel-ring-meter.is-danger {
    color: var(--destructive);
  }

  .token-panel-ring-meter.is-warning {
    color: oklch(0.72 0.13 64);
  }

  .token-panel-ring-meter.is-unknown {
    color: var(--bs-app-muted-text);
  }

  :global(.token-panel-trim-button) {
    height: 28px;
    padding: 0 0.75rem;
    border-radius: 999px;
    border-color: var(--bs-app-field-line);
    background: var(--bs-app-field);
    color: var(--bs-app-muted-text);
    font-size: 0.6875rem;
  }

  :global(body.goon-immersive .token-panel-trim-button),
  :global(body.goon-immersive .token-panel-icon-button) {
    border-color: oklch(0.92 0.006 289.95 / 0.22);
    background: oklch(0.13 0.02 276 / 0.42);
    color: oklch(0.96 0.006 289.95 / 0.84);
    backdrop-filter: blur(8px);
  }

  :global(.token-panel-trim-button:hover),
  :global(.token-panel-icon-button:hover) {
    background: var(--bs-app-field-hover);
    color: var(--bs-app-title);
  }

  :global(.token-panel-trim-button:disabled) {
    cursor: not-allowed;
    opacity: 0.55;
  }

  :global(body.goon-immersive .token-panel-trim-button:hover),
  :global(body.goon-immersive .token-panel-icon-button:hover) {
    border-color: oklch(0.96 0.006 289.95 / 0.32);
    background: oklch(0.18 0.025 276 / 0.66);
    color: oklch(0.99 0.002 289.95);
  }

  .token-panel-trimmed {
    margin-right: 0.375rem;
    color: var(--bs-app-muted-text);
  }

  :global(body.goon-immersive) .token-panel-trimmed {
    color: oklch(0.96 0.006 289.95 / 0.74);
  }

  .token-panel-spacer {
    margin-left: auto;
  }

  .token-panel-compact-status {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.4rem;
    width: 100%;
    max-width: 52rem;
    margin: 0.35rem auto 0;
    color: var(--bs-app-muted-text);
    font-size: 0.7rem;
    line-height: 1.2;
  }

  :global(.token-panel-icon-button) {
    width: 28px;
    height: 28px;
    border-radius: 999px;
    color: var(--bs-app-muted-text);
  }

  :global(.token-panel-icon-button.is-reset) {
    margin-left: -0.5rem;
  }

  @keyframes token-panel-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
