<script lang="ts">
  import { Infinity, Clock, Hand, Lock, Sparkles } from '@lucide/svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import { buildZipStatusPresentation } from '$lib/utils/zipStatusPresentation'

  let {
    isZipped = false,
    zipId = '',
    source = 'USER',
    tokens = undefined,
    isUnzipped = false,
    expandedReason = undefined,
    isPermanent = false,
    manualZip = false,
    agentControlled = false,
    aboutToZip = false,
    remainingMessages = undefined,
    autoZip = false,
    name = '',
    description = '',
    // Visual indicator settings
    showZippedBadges = true,
    zippedBadgesHoverOnly = false,
    showZippedBorders = true,
    zippedBordersHoverOnly = true,
    showUnzippedBadges = true,
    unzippedBadgesHoverOnly = false,
    showUnzippedBorders = true,
    unzippedBordersHoverOnly = true,
    // DEPRECATED
    alwaysShowZipBorders = false,
    children,
    onToggleUnzip = (permanent: boolean, name?: string, description?: string, tokens?: number) => {},
    onZipNow = undefined,
    onReturnAutomatic = undefined
  }: {
    isZipped?: boolean
    zipId?: string
    source?: string
    tokens?: number | undefined
    isUnzipped?: boolean
    expandedReason?: 'buffer' | 'user' | 'agent'
    isPermanent?: boolean
    manualZip?: boolean
    agentControlled?: boolean
    aboutToZip?: boolean
    remainingMessages?: number | null
    autoZip?: boolean
    name?: string
    description?: string
    // Visual indicator settings
    showZippedBadges?: boolean
    zippedBadgesHoverOnly?: boolean
    showZippedBorders?: boolean
    zippedBordersHoverOnly?: boolean
    showUnzippedBadges?: boolean
    unzippedBadgesHoverOnly?: boolean
    showUnzippedBorders?: boolean
    unzippedBordersHoverOnly?: boolean
    // DEPRECATED
    alwaysShowZipBorders?: boolean
    children?: any
    onToggleUnzip?: (permanent: boolean, name?: string, description?: string, tokens?: number) => void
    onZipNow?: (zipId: string, name?: string, description?: string, tokens?: number) => void
    onReturnAutomatic?: (zipId: string) => void
  } = $props()

  let showControls = $state(false)
  let isHovering = $state(false)
  let toolHeaderExpanded = $state(false)
  const isExpanded = $derived.by(
    () => !isZipped && (isUnzipped || Boolean(expandedReason))
  )
  const canManualUnzip = $derived.by(
    () => isZipped || (!isUnzipped && expandedReason === 'buffer')
  )
  const canZipNow = $derived.by(
    () => Boolean(onZipNow) && Boolean(zipId) && !isZipped
  )
  const canReturnAutomatic = $derived.by(
    () => Boolean(onReturnAutomatic) && Boolean(zipId) && (isUnzipped || manualZip)
  )
  const canShowManualControls = $derived.by(
    () => canManualUnzip || canZipNow || canReturnAutomatic
  )

  // Determine visibility based on settings
  const shouldShowBadge = $derived.by(() => {
    if (isExpanded) {
      if (!showUnzippedBadges) return false
      return !unzippedBadgesHoverOnly || isHovering
    } else {
      if (!showZippedBadges) return false
      return !zippedBadgesHoverOnly || isHovering
    }
  })

  const shouldShowBorder = $derived.by(() => {
    if (isExpanded) {
      if (!showUnzippedBorders) return false
      return !unzippedBordersHoverOnly || isHovering
    } else {
      if (!showZippedBorders) return false
      return !zippedBordersHoverOnly || isHovering
    }
  })

  const statusPresentation = $derived.by(() =>
    buildZipStatusPresentation({
      isZipped,
      isUnzipped,
      expandedReason,
      isPermanent,
      remainingMessages,
      manualZip,
      autoZip,
      agentControlled,
      aboutToZip
    })
  )

  const badgeTooltip = $derived(statusPresentation.tooltip)

  const hasTokenCount = $derived.by(
    () => typeof tokens === 'number' && Number.isFinite(tokens) && tokens > 0
  )
  const badgeVisible = $derived((isZipped || isExpanded) && shouldShowBadge)
  const tokenLabel = $derived.by(
    () => (typeof tokens === 'number' && Number.isFinite(tokens) ? tokens.toLocaleString() : '')
  )
  const tokenBadgeTextWidth = $derived.by(() =>
    hasTokenCount ? `${tokenLabel.length + ' tokens'.length}ch` : '0ch'
  )


	  function handleUnzip10Click() {
	    onToggleUnzip(false, name, description, tokens)
	  }

	  function handleUnzipPermanentClick() {
	    onToggleUnzip(true, name, description, tokens)
	  }

	  function handleRezipClick() {
	    if (zipId) onZipNow?.(zipId, name, description, tokens)
	  }

	  function handleReturnAutomaticClick() {
	    if (zipId) onReturnAutomatic?.(zipId)
	  }

  function toolHeaderExpansionObserver(node: HTMLElement) {
    const selector = [
      '.zip-content > .full-tool > .tool-header-button',
      '.zip-content > .compact-tool > .compact-header',
      '.zip-content > .image-tool > .tool-header-button'
    ].join(', ')

    const sync = () => {
      const header = node.querySelector(selector)
      toolHeaderExpanded = header?.getAttribute('aria-expanded') === 'true'
    }

    sync()
    const observer = new MutationObserver(sync)
    observer.observe(node, {
      attributes: true,
      attributeFilter: ['aria-expanded'],
      childList: true,
      subtree: true
    })

    return {
      destroy() {
        observer.disconnect()
      }
    }
  }
</script>

<div
  class="batshit-zip-wrapper"
  class:zipped={isZipped}
  class:unzipped={isUnzipped}
  class:manual-zipped={manualZip}
  class:expanded={isExpanded}
  class:about-to-zip={aboutToZip}
  class:agent-controlled={agentControlled}
  class:countdown-warning={statusPresentation.tone === 'warning'}
  class:show-border={shouldShowBorder}
  class:always-show={alwaysShowZipBorders && isZipped}
  class:has-token-badge={badgeVisible}
  class:has-token-count={hasTokenCount}
  class:tool-header-expanded={toolHeaderExpanded}
  role={isZipped ? "region" : "none"}
  aria-label={isZipped ? "Zipped content" : undefined}
  data-zip-id={zipId || undefined}
  style={`--zip-badge-token-text-width: ${tokenBadgeTextWidth};`}
  use:toolHeaderExpansionObserver
  onmouseenter={() => isHovering = true}
  onmouseleave={() => isHovering = false}
>
  <!-- The actual content - always rendered -->
  <div class="zip-content">
    {@render children?.()}
  </div>

  <!-- Token badge with icons - show based on settings -->
  {#if badgeVisible}
    <div
      class="token-badge-container"
      role="region"
      aria-label="Zip controls"
      title={badgeTooltip}
      onmouseenter={() => showControls = true}
      onmouseleave={() => showControls = false}
    >
      {#if showControls && canShowManualControls}
        <div class="unzip-button-group">
          {#if canManualUnzip}
            <button
              class="unzip-button unzip"
              onclick={handleUnzip10Click}
              aria-label="Unzip for 10 messages"
              title="Unzip for 10 messages"
            >
              <BatshitIcon id="unzip" class="h-3 w-3" />
              <span class="unzip-label">10</span>
            </button>
            <button
              class="unzip-button unzip"
              onclick={handleUnzipPermanentClick}
              aria-label="Unzip indefinitely"
              title="Unzip indefinitely"
            >
              <BatshitIcon id="unzip" class="h-3 w-3" />
              <Infinity class="h-2.5 w-2.5" />
            </button>
          {/if}
          {#if canZipNow}
            <button
              class="unzip-button rezip"
              onclick={handleRezipClick}
              aria-label="Zip now"
              title="Zip now"
            >
              <BatshitIcon id="zip" class="h-3 w-3" />
            </button>
          {/if}
          {#if canReturnAutomatic}
            <button
              class="unzip-button automatic"
              onclick={handleReturnAutomaticClick}
              aria-label="Return to automatic"
              title="Return to automatic"
            >
              <Clock class="h-3 w-3" />
            </button>
          {/if}
        </div>
      {:else}
        <!-- Show current status when not hovering -->
        <div class="status-icon" aria-label={statusPresentation.ariaLabel}>
          {#if isZipped}
            {#if autoZip}
              <Lock class="auto-zip-lock-icon" size={16} strokeWidth={2} />
            {:else}
              <BatshitIcon id="zip" class="h-4 w-4" />
            {/if}
          {:else}
            <BatshitIcon id="unzip" class="h-4 w-4" />
            {#if statusPresentation.actor === 'user'}
              <Hand class="status-modifier-icon user-zip-control-icon" size={11} strokeWidth={2.2} aria-label="User zip control" />
            {:else if statusPresentation.actor === 'agent'}
              <Sparkles class="status-modifier-icon agent-zip-control-icon" size={10} strokeWidth={2.4} aria-label="Agent zip control" />
            {/if}
            {#if isPermanent}
              <Infinity class="h-2.5 w-2.5 ml-0.5 opacity-80" />
            {:else if statusPresentation.duration === 'countdown' && statusPresentation.remainingMessages !== null}
              <span class="zip-countdown" aria-hidden="true">
                <Clock class="zip-countdown-icon" size={10} strokeWidth={2.2} />
                <span class="zip-countdown-number">{statusPresentation.remainingMessages}</span>
              </span>
            {/if}
          {/if}
        </div>
      {/if}

      <!-- Token badge always on the right -->
      {#if hasTokenCount}
        <div class="token-badge">
          <span>{tokenLabel} tokens</span>
        </div>
      {/if}
    </div>
  {/if}

</div>

<style>
  /* Themeable zip/unzip colors */
  :root {
    --zip-color: var(--destructive);      /* Pink-red for zipped state/actions */
    --unzip-color: var(--success-color);  /* Teal success for unzipped state/actions */
    --zip-warning-color: oklch(70% 0.18 85); /* Yellow/orange for about-to-zip */
  }

  .batshit-zip-wrapper {
    --zip-header-height-collapsed: calc(1.75rem - 1px);
    --zip-header-height-expanded: calc(1.75rem + 1px);
    --zip-header-height: var(--zip-header-height-collapsed);
    --zip-badge-token-text-width: 0ch;
    --zip-badge-reserved-width: 2.35rem;

    position: relative;
    transition: all 0.2s ease;
    overflow: visible;
    display: block;
    width: 100%;
    min-width: 0;
    max-width: 100%;
    outline: 1px dashed transparent;
    outline-offset: 0;
    border-radius: 0.5rem;
  }

  .batshit-zip-wrapper.has-token-count {
    --zip-badge-reserved-width: max(4.9rem, calc(var(--zip-badge-token-text-width) + 1.75rem));
  }

  .batshit-zip-wrapper.has-token-count:hover {
    --zip-badge-reserved-width: max(8rem, calc(var(--zip-badge-token-text-width) + 4.25rem));
  }

  .batshit-zip-wrapper.tool-header-expanded {
    --zip-header-height: var(--zip-header-height-expanded);
  }

  .zip-content {
    min-width: 0;
    max-width: 100%;
  }

  /* Base outline structure for zipped items */
  .batshit-zip-wrapper.zipped {
    transition: outline-color 0.2s ease, background-color 0.2s ease;
  }

  /* Show red dashed border for zipped content when show-border is active */
  .batshit-zip-wrapper.zipped.show-border:not(.expanded) {
    outline-color: oklch(from var(--zip-color) l c h / 0.38);
    outline-style: dashed;
  }

  /* Hover state for zipped items - make border more visible */
  .batshit-zip-wrapper.zipped:hover:not(.expanded) {
    outline-color: oklch(from var(--zip-color) l c h / 0.55);
    background-color: oklch(from var(--zip-color) l c h / 0.05);
  }

  /* User-unzipped items - show green dashed border when show-border is active */
.batshit-zip-wrapper.expanded.show-border {
    outline-color: oklch(from var(--unzip-color) l c h / 0.38);
    outline-style: dashed;
  }

  /* Hover states for unzipped items - make borders more visible */
.batshit-zip-wrapper.expanded:hover {
    outline-color: oklch(from var(--unzip-color) l c h / 0.55);
    background-color: oklch(from var(--unzip-color) l c h / 0.05);
  }

  /* Legacy always-show support (for backwards compatibility) */
  .batshit-zip-wrapper.zipped.always-show:not(.expanded) {
    outline-color: oklch(from var(--zip-color) l c h / 0.28);
  }

.batshit-zip-wrapper.always-show.expanded {
    outline-color: oklch(from var(--unzip-color) l c h / 0.28);
  }

  .token-badge-container {
    --token-badge-container-background: oklch(0.26 0.02 284.93);

    position: absolute;
    top: 0;
    right: 0;
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 0.28rem;
    z-index: 5;
    font-size: 0.625rem;
    line-height: 1;
    width: max-content;
    max-width: calc(100% - 0.4rem);
    height: var(--zip-header-height);
    background: var(--token-badge-container-background);
    padding: 0 0.45rem;
    border-radius: 0 10px 10px 0;
    border: 1px solid var(--bs-app-inner-line);
    border-left-style: dashed;
    transition: width 150ms ease-out, height 150ms ease-out, border-radius 150ms ease-out;
  }

  .batshit-zip-wrapper:not(.tool-header-expanded) .token-badge-container {
    border-radius: 0 10px 10px 0;
    height: calc(var(--zip-header-height) + 2px);
  }

  .batshit-zip-wrapper.tool-header-expanded .token-badge-container {
    border-radius: 0 10px 0 0;
  }

  .batshit-zip-wrapper.zipped:not(.expanded) .token-badge-container {
    border-color: oklch(from var(--zip-color) l c h / 0.05);
  }

  .batshit-zip-wrapper.expanded .token-badge-container {
    border-color: oklch(from var(--unzip-color) l c h / 0.05);
  }

  .status-icon {
    color: var(--muted-foreground);
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.125rem;
    opacity: 0.7;
    line-height: 1; /* Consistent line-height */
    height: 1rem; /* Match button height */
    transition: all 0.2s ease;
  }

  .status-icon :global(svg),
  .status-icon :global(.batshit-icon) {
    width: 16px;
    height: 16px;
    flex: 0 0 16px;
  }

  .status-icon :global(.auto-zip-lock-icon) {
    width: 16px !important;
    height: 16px !important;
    min-width: 16px;
    max-width: 16px;
    flex: 0 0 16px;
  }

  .status-icon :global(.status-modifier-icon),
  .status-icon :global(.agent-zip-control-icon),
  .status-icon :global(.user-zip-control-icon) {
    width: 10px !important;
    height: 10px !important;
    min-width: 10px;
    max-width: 10px;
    flex: 0 0 10px;
    margin-left: -0.05rem;
    opacity: 0.9;
  }

  .status-icon :global(.user-zip-control-icon) {
    width: 11px !important;
    height: 11px !important;
    min-width: 11px;
    max-width: 11px;
  }

  /* Color the zipped icon red when not unzipped */
  .batshit-zip-wrapper.zipped:not(.expanded) .status-icon {
    color: var(--zip-color);
  }

  /* Removed unused .clickable styles */

  .token-badge {
    color: var(--muted-foreground);
    font-size: 1em;
    font-weight: 400;
    display: flex;
    align-items: center;
    opacity: 0.6;
    transition: opacity 0.2s ease;
    line-height: 1;
    white-space: nowrap; /* Prevent wrapping */
    margin-left: 0.25rem; /* 3-4px space from everything else */
  }

  .batshit-zip-wrapper:hover .token-badge,
  .batshit-zip-wrapper:hover .status-icon {
    opacity: 1;
  }

  /* Color the status icon based on unzip state */
  .batshit-zip-wrapper.expanded .status-icon {
    color: var(--unzip-color);
  }

  .batshit-zip-wrapper.countdown-warning .status-icon {
    color: var(--zip-warning-color);
  }

  .batshit-zip-wrapper.countdown-warning .token-badge-container {
    border-color: oklch(from var(--zip-warning-color) l c h / 0.05);
    background: var(--token-badge-container-background);
  }

  .zip-countdown {
    display: inline-flex;
    align-items: center;
    gap: 0.075rem;
    margin-left: 0.05rem;
    font-size: 0.58rem;
    font-weight: 600;
    line-height: 1;
  }

  .zip-countdown :global(.zip-countdown-icon) {
    width: 10px !important;
    height: 10px !important;
    min-width: 10px;
    max-width: 10px;
    flex: 0 0 10px;
  }

  .zip-countdown-number {
    min-width: 0.42rem;
  }

  :global(.batshit-zip-wrapper.zip-locate-highlight) {
    animation: zip-locate-pulse 1800ms ease-out;
    outline-color: oklch(from var(--unzip-color) l c h / 0.78);
    background-color: oklch(from var(--unzip-color) l c h / 0.08);
  }

  @keyframes zip-locate-pulse {
    0% {
      outline-color: oklch(from var(--unzip-color) l c h / 0.95);
      background-color: oklch(from var(--unzip-color) l c h / 0.16);
      box-shadow: 0 0 0 1px oklch(from var(--unzip-color) l c h / 0.18);
    }
    100% {
      outline-color: oklch(from var(--unzip-color) l c h / 0.2);
      background-color: transparent;
      box-shadow: none;
    }
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.full-tool > .tool-header-button),
  .batshit-zip-wrapper.has-token-badge .zip-content :global(.compact-tool > .compact-header),
  .batshit-zip-wrapper.has-token-badge .zip-content :global(.image-tool > .tool-header-button) {
    min-height: var(--zip-header-height);
    height: var(--zip-header-height);
    padding: 0 var(--zip-badge-reserved-width) 0 0.55rem;
    font-size: 0.75rem;
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.full-tool > .tool-header-button[aria-expanded='false']),
  .batshit-zip-wrapper.has-token-badge .zip-content :global(.compact-tool > .compact-header[aria-expanded='false']),
  .batshit-zip-wrapper.has-token-badge .zip-content :global(.image-tool > .tool-header-button[aria-expanded='false']) {
    border-top-right-radius: 0;
    border-bottom-right-radius: 0;
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.full-tool > .tool-header-button[aria-expanded='true']),
  .batshit-zip-wrapper.has-token-badge .zip-content :global(.compact-tool > .compact-header[aria-expanded='true']),
  .batshit-zip-wrapper.has-token-badge .zip-content :global(.image-tool > .tool-header-button[aria-expanded='true']) {
    border-top-right-radius: 0;
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.tool-header) {
    gap: 0.35rem;
    font-size: 0.7rem;
    line-height: 1;
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.tool-header-text) {
    gap: 0.35rem;
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.tool-header svg) {
    width: 1rem;
    height: 1rem;
  }

  .batshit-zip-wrapper.has-token-badge:not(.tool-header-expanded) .zip-content :global(.tool-header svg) {
    width: 1rem;
    height: 1rem;
  }

  .batshit-zip-wrapper.has-token-badge .zip-content :global(.subtitle) {
    font-size: 0.68rem;
  }

  .zip-content {
    /* Content styles handled by child components */
    display: block;
    width: 100%;
    min-width: 0;
    max-width: 100%;
  }

  .unzip-label {
    font-size: 0.5rem;
    font-weight: 600;
    margin-left: -0.125rem;
  }

  .unzip-button-group {
    display: flex;
    align-items: center;
    margin-right: 0.25rem; /* Add space between buttons and tokens */
    line-height: 1; /* Consistent line-height */
    height: 1rem; /* Consistent height */
  }

  .unzip-button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 0.125rem;
    padding: 0.125rem 0.25rem;
    background-color: var(--muted);
    border: 1px solid var(--border);
    color: var(--muted-foreground);
    font-size: 0.625rem;
    line-height: 1; /* Match the container line-height */
    transition: all 0.2s ease;
    cursor: pointer;
    height: 1rem;
  }

  .unzip-button.unzip:hover {
    background-color: var(--accent);
    color: var(--unzip-color) !important;
    border-color: var(--accent);
  }

  .unzip-button.rezip:hover {
    background-color: var(--accent);
    color: var(--zip-color) !important;
    border-color: var(--accent);
  }

  .unzip-button.automatic:hover {
    background-color: var(--accent);
    color: var(--foreground) !important;
    border-color: var(--accent);
  }

  .unzip-button:not(:last-child) {
    border-right: none;
  }

  .unzip-button:first-child {
    border-radius: var(--radius) 0 0 var(--radius);
  }

  .unzip-button:last-child {
    border-radius: 0 var(--radius) var(--radius) 0;
  }

  .unzip-button:only-child {
    border-radius: var(--radius);
    border-right: 1px solid var(--border);
  }
</style>
