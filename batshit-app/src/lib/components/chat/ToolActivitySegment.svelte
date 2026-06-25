<script lang="ts">
  import { buildInlineCoolToolStep } from './buildInlineCoolToolStep'
  import CoolToolRenderer from '$lib/components/renderers/tools/CoolToolRenderer.svelte'
  import ZipbatshitWrapper from '$lib/components/renderers/wrappers/ZipbatshitWrapper.svelte'
  import { normalizeId } from '$lib/utils/idNormalizer'
  import {
    estimateCoolToolAiTokens,
    parseCoolToolPayload
  } from '$lib/utils/coolToolAiContent'

  let {
    segment,
    segmentIndex,
    messageId,
    currentSessionId,
    messagesAgo,
    zipMetadataFromRedis,
    pendingCoolToolFetch,
    missingCoolToolZips,
    coolToolFromZip,
    showZippedBadges,
    zippedBadgesHoverOnly,
    showZippedBorders,
    zippedBordersHoverOnly,
    showUnzippedBadges,
    unzippedBadgesHoverOnly,
    showUnzippedBorders,
    unzippedBordersHoverOnly,
    alwaysShowZipBorders,
    resolveZipTokens,
    resolveZipVisualState,
    shouldShowAsZip,
    handleUnzip,
    handleZipNow,
    handleReturnAutomatic
  }: {
    segment: any
    segmentIndex: number
    messageId: string
    currentSessionId: string
    messagesAgo: number
    zipMetadataFromRedis: Map<string, any>
    pendingCoolToolFetch: Set<string>
    missingCoolToolZips: Set<string>
    coolToolFromZip: Map<string, any>
    showZippedBadges: boolean
    zippedBadgesHoverOnly: boolean
    showZippedBorders: boolean
    zippedBordersHoverOnly: boolean
    showUnzippedBadges: boolean
    unzippedBadgesHoverOnly: boolean
    showUnzippedBorders: boolean
    unzippedBordersHoverOnly: boolean
    alwaysShowZipBorders: boolean
    resolveZipTokens: (zipId?: string, fallback?: number) => number
    resolveZipVisualState: (options: {
      zipId: string
      zipType: string
      zipData?: any
      toolName?: string
      fallbackTokens?: number
      messagesFromEnd: number
    }) => {
      isUnzipped: boolean
      expandedReason?: 'buffer' | 'user' | 'agent'
      isPermanent?: boolean
      remainingMessages?: number | null
      aboutToZip?: boolean
      autoZip?: boolean
      agentControlled?: boolean
      manualZip?: boolean
    }
    shouldShowAsZip: (segment: any, segmentIndex: number) => boolean
    handleUnzip: (
      zipId: string,
      permanent: boolean,
      name?: string,
      description?: string,
      tokens?: number,
      autoZip?: boolean
    ) => void
    handleZipNow: (zipId: string) => void
    handleReturnAutomatic: (zipId: string) => void
  } = $props()

  let isLegacySegment = $derived(segment?.type === 'batshit')
  let rawZipId = $derived(
    segment?.zipId ||
      segment?.id ||
      `${currentSessionId || 'unknown'}-${messageId}-cool_tool-${segmentIndex}`
  )
  let normalizedZipId = $derived(
    String(rawZipId || '').replace(/-cool_tool-\d+$/, '-cool_tool-0') || normalizeId(rawZipId)
  )
  let segmentWithZipId = $derived({
    ...segment,
    zipId: normalizedZipId,
    isZip: true,
    zipType: 'cool_tool'
  })
  let toolName = $derived(
    segment?.toolName ||
      segment?.name ||
      segment?.toolData?.displayToolName ||
      segment?.toolData?.toolName ||
      'Tool Result'
  )
  let zipMetadata = $derived(
    zipMetadataFromRedis.get(rawZipId) || zipMetadataFromRedis.get(normalizedZipId)
  )
  let isPendingZip = $derived(!isLegacySegment && pendingCoolToolFetch.has(rawZipId))
  let isMissingZip = $derived(!isLegacySegment && missingCoolToolZips.has(rawZipId))
  let hydratedStep = $derived(
    !isLegacySegment && segment?.zipId ? coolToolFromZip.get(normalizedZipId) : null
  )
  let inlineStep = $derived(
    buildInlineCoolToolStep(segment?.toolData, toolName)
  )
  let promptTokenPayload = $derived.by(() => {
    const parsedFromZip = parseCoolToolPayload(zipMetadata?.content)
    return parsedFromZip || hydratedStep || inlineStep || segment?.intermediateStep || segment?.toolData || null
  })
  let tokenEstimate = $derived.by(() =>
    estimateCoolToolAiTokens(
      normalizedZipId,
      zipMetadata || {
        content: segment?.content || '',
        metadata: segment?.metadata || {}
      },
      promptTokenPayload
    )
  )
  let tokenCount = $derived(resolveZipTokens(rawZipId, tokenEstimate))
  let zipState = $derived(
    resolveZipVisualState({
      zipId: normalizedZipId,
      zipType: 'cool_tool',
      zipData: zipMetadata,
      toolName,
      fallbackTokens: tokenCount,
      messagesFromEnd: messagesAgo
    })
  )
  let isUnzippedValue = $derived(zipState.isUnzipped)
  let collapse = $derived(!isUnzippedValue && shouldShowAsZip(segmentWithZipId, segmentIndex))
  let expandedReason = $derived(!collapse ? zipState.expandedReason : undefined)
  let isPermanent = $derived(Boolean(zipState.isPermanent))
  let remainingMessages = $derived(!collapse ? zipState.remainingMessages : undefined)
  let aboutToZip = $derived(!collapse ? zipState.aboutToZip : false)
  let autoZip = $derived(Boolean(zipState.autoZip))
  let agentControlled = $derived(Boolean(zipState.agentControlled))
  let manualZip = $derived(Boolean(zipState.manualZip))
</script>

<ZipbatshitWrapper
  isZipped={collapse}
  zipId={normalizedZipId}
  tokens={tokenCount}
  isUnzipped={isUnzippedValue}
  {expandedReason}
  {isPermanent}
  {remainingMessages}
  {aboutToZip}
  autoZip={autoZip}
  {agentControlled}
  {manualZip}
  onToggleUnzip={(permanent: boolean) =>
    handleUnzip(
      normalizedZipId,
      permanent,
      toolName,
      segment?.description || `Tool execution: ${toolName}`,
      tokenCount,
      autoZip
    )}
  onZipNow={handleZipNow}
  onReturnAutomatic={handleReturnAutomatic}
  name={toolName}
  description={segment?.description || `Tool execution: ${toolName}`}
  {showZippedBadges}
  {zippedBadgesHoverOnly}
  {showZippedBorders}
  {zippedBordersHoverOnly}
  {showUnzippedBadges}
  {unzippedBadgesHoverOnly}
  {showUnzippedBorders}
  {unzippedBordersHoverOnly}
  {alwaysShowZipBorders}
>
  {#if isPendingZip}
    <CoolToolRenderer
      isPending={true}
      toolId={segment?.zipId || segment?.toolId}
      metadata={segment?.metadata || {}}
    />
  {:else if isMissingZip}
    <div class="tool-activity-missing-result">
      Tool result unavailable (zip missing)
    </div>
  {:else if hydratedStep}
    <CoolToolRenderer
      intermediateStep={hydratedStep}
      metadata={segment?.metadata || hydratedStep?.metadata || {}}
      toolId={segment?.zipId || segment?.toolId}
    />
  {:else if inlineStep}
    <CoolToolRenderer
      intermediateStep={inlineStep}
      metadata={segment?.metadata || inlineStep?.metadata || {}}
      toolId={segment?.zipId || segment?.toolId}
    />
  {:else if isLegacySegment}
    <div class="tool-activity-muted-summary">
      {segment?.description || `Tool execution: ${toolName}`}
    </div>
  {:else}
    <CoolToolRenderer
      isPending={true}
      toolId={segment?.zipId || segment?.toolId}
      metadata={segment?.metadata || {}}
    />
  {/if}
</ZipbatshitWrapper>

<style>
  .tool-activity-missing-result {
    padding: 0.25rem 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .tool-activity-muted-summary {
    font-size: 0.875rem;
    opacity: 0.75;
  }
</style>
