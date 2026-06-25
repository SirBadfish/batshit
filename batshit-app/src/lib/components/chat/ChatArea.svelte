<script lang="ts">
  import type { Message } from '$lib/stores/messages.svelte'
  import type { VoiceSettings } from '$lib/types/voice'
  import ChatMessageComponent from './ChatMessage.svelte'
  import LoadingIndicator from './LoadingIndicator.svelte'
  import { onDestroy, onMount, tick } from 'svelte'
  import { zippingService } from '$lib/services/zipping'
  import { calculateAgentMessagesFromEndByIndex } from '$lib/utils/zipMessageAge'
  import { normalizeId } from '$lib/utils/idNormalizer'
  
  let { 
    messages = [], 
    trimmedMessageIds = [],
    compactedMessageIds = [],
    sessionId = null,
    isWaitingForResponse = false,
    isWaitingForToolCall = false,
    activeToolMessageIds = [],
    toolCallNamesByMessageId = {},
    thinkingSubjects = {},
    planSubjects = {},
    voiceSettings,
    composerClipCount = 0
  } = $props<{ 
    messages: Message[],
    trimmedMessageIds?: string[],
    compactedMessageIds?: string[],
    sessionId: string | null,
    isWaitingForResponse?: boolean,
    isWaitingForToolCall?: boolean,
    activeToolMessageIds?: string[],
    toolCallNamesByMessageId?: Record<string, string>,
    thinkingSubjects?: Record<string, string>,
    planSubjects?: Record<string, { content?: string; items?: any[] }>
    voiceSettings?: VoiceSettings
    composerClipCount?: number
  }>()
  
  const BOTTOM_THRESHOLD_PX = 64

  let scrollContainer: HTMLDivElement
  let chatThread: HTMLDivElement
  let autoScroll = $state(true)
  let scrollScheduled = false
  let scrollFrame: number | null = null
  let resizeObserver: ResizeObserver | null = null
  let userScrollIntentUntil = 0
  let userBottomReleaseUntil = 0
  let programmaticScrollUntil = 0
  let lastTouchY: number | null = null
  const trimmedMessageIdSet = $derived(new Set(trimmedMessageIds))
  const compactedMessageIdSet = $derived(new Set(compactedMessageIds))
  const activeToolMessageIdSet = $derived(new Set(activeToolMessageIds))
  const agentMessagesFromEndByIndex = $derived(calculateAgentMessagesFromEndByIndex(messages))

  // Update pinning service when session changes
  $effect(() => {
    zippingService.setCurrentSession(sessionId).catch(err => {
      console.error('[ChatArea] Failed to set session for zipping service:', err)
    })
  })
  
  // Keep bottom-anchored chats pinned through streamed content, tool rows, and composer resizing.
  $effect(() => {
    messages
    activeToolMessageIds
    toolCallNamesByMessageId
    thinkingSubjects
    planSubjects
    composerClipCount
    isWaitingForResponse
    isWaitingForToolCall

    if (messages.length && autoScroll) {
      scheduleScrollToBottom()
    }
  })
  
  async function scheduleScrollToBottom() {
    if (scrollScheduled) return
    scrollScheduled = true
    await tick()

    const run = () => {
      scrollScheduled = false
      scrollFrame = null
      if (scrollContainer && autoScroll) {
        programmaticScrollUntil = Date.now() + 250
        scrollContainer.scrollTop = scrollContainer.scrollHeight
      }
    }

    if (typeof requestAnimationFrame === 'function') {
      scrollFrame = requestAnimationFrame(run)
    } else {
      run()
    }
  }

  function scrollToBottom() {
    if (scrollContainer) {
      programmaticScrollUntil = Date.now() + 250
      scrollContainer.scrollTop = scrollContainer.scrollHeight
    }
  }

  function escapeSelectorValue(value: string) {
    if (typeof CSS !== 'undefined' && typeof CSS.escape === 'function') {
      return CSS.escape(value)
    }
    return value.replace(/["\\]/g, '\\$&')
  }

  function getLocateCandidateIds(
    zipId?: string | null,
    normalizedZipId?: string | null,
    candidateZipIds: string[] = []
  ) {
    const ids = new Set<string>()
    const add = (id?: string | null) => {
      if (!id) return
      ids.add(id)
      ids.add(normalizeId(id))
      ids.add(id.replace(/-cool_tool-\d+$/, '-cool_tool-0'))
    }

    add(zipId)
    add(normalizedZipId)
    candidateZipIds.forEach(add)

    return Array.from(ids).filter(Boolean)
  }

  function findZipLocateTarget(candidateIds: string[]) {
    for (const candidate of candidateIds) {
      const target = chatThread?.querySelector(
        `[data-zip-id="${escapeSelectorValue(candidate)}"]`
      )
      if (target instanceof HTMLElement) return target
    }

    return null
  }

  function findToolActivityGroup(candidateIds: string[]) {
    for (const candidate of candidateIds) {
      const group = chatThread?.querySelector(
        `[data-tool-activity-zip-ids~="${escapeSelectorValue(candidate)}"]`
      )
      if (group instanceof HTMLElement) return group
    }

    return null
  }

  function findMessageLocateTarget(messageId?: string | null) {
    if (messageId) {
      const messageTarget = chatThread?.querySelector(
        `[data-message-id="${escapeSelectorValue(messageId)}"]`
      )
      if (messageTarget instanceof HTMLElement) return messageTarget
    }

    return null
  }

  async function handleLocateZip(event: Event) {
    const detail = (event as CustomEvent<{
      zipId?: string
      normalizedZipId?: string
      candidateZipIds?: string[]
      messageId?: string
    }>).detail
    const candidateIds = getLocateCandidateIds(
      detail?.zipId,
      detail?.normalizedZipId,
      Array.isArray(detail?.candidateZipIds) ? detail.candidateZipIds : []
    )
    let target = findZipLocateTarget(candidateIds)

    if (!target) {
      const toolGroup = findToolActivityGroup(candidateIds)
      const toggle = toolGroup?.querySelector('.tool-activity-strip[aria-expanded="false"]')
      if (toggle instanceof HTMLButtonElement) {
        toggle.click()
        await tick()
        target = findZipLocateTarget(candidateIds)
      }
    }

    target = target ?? findMessageLocateTarget(detail?.messageId)
    if (!target) return

    autoScroll = false
    programmaticScrollUntil = Date.now() + 500
    target.scrollIntoView({ behavior: 'smooth', block: 'center', inline: 'nearest' })
    target.classList.remove('zip-locate-highlight')
    void target.offsetWidth
    target.classList.add('zip-locate-highlight')
    window.setTimeout(() => {
      target.classList.remove('zip-locate-highlight')
    }, 1900)
  }

  function isNearBottom() {
    if (!scrollContainer) return true
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer
    return scrollHeight - scrollTop - clientHeight < BOTTOM_THRESHOLD_PX
  }

  function isAtBottom() {
    if (!scrollContainer) return true
    const { scrollTop, scrollHeight, clientHeight } = scrollContainer
    return scrollHeight - scrollTop - clientHeight <= 2
  }
  
  function hasRecentUserScrollIntent() {
    return Date.now() < userScrollIntentUntil
  }

  function markUserScrollIntent() {
    userScrollIntentUntil = Date.now() + 900
  }

  function releaseBottomFollow() {
    const now = Date.now()
    userScrollIntentUntil = now + 900
    userBottomReleaseUntil = now + 1200
    programmaticScrollUntil = 0
    autoScroll = false
  }

  function handleWheel(event: WheelEvent) {
    if (event.deltaY < 0) {
      releaseBottomFollow()
      return
    }

    markUserScrollIntent()
  }

  function handlePointerDown() {
    markUserScrollIntent()
    programmaticScrollUntil = 0
  }

  function handleTouchStart(event: TouchEvent) {
    markUserScrollIntent()
    lastTouchY = event.touches[0]?.clientY ?? null
    programmaticScrollUntil = 0
  }

  function handleTouchMove(event: TouchEvent) {
    const currentY = event.touches[0]?.clientY ?? null
    if (currentY === null || lastTouchY === null) return

    if (currentY > lastTouchY) {
      releaseBottomFollow()
    } else {
      markUserScrollIntent()
    }

    lastTouchY = currentY
  }

  function handleTouchEnd() {
    lastTouchY = null
  }

  function handleScroll() {
    if (!scrollContainer) return
    if (isAtBottom()) {
      autoScroll = true
      return
    }

    if (Date.now() < userBottomReleaseUntil) {
      autoScroll = false
      return
    }

    if (isNearBottom() && autoScroll) {
      return
    }

    if (Date.now() < programmaticScrollUntil) {
      return
    }

    if (hasRecentUserScrollIntent()) {
      autoScroll = false
      return
    }

    if (autoScroll) {
      scheduleScrollToBottom()
    }
  }
  
  onMount(() => {
    if (typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver(() => {
        if (autoScroll) {
          scheduleScrollToBottom()
        } else if (isAtBottom()) {
          autoScroll = true
        }
      })
      if (scrollContainer) resizeObserver.observe(scrollContainer)
      if (chatThread) resizeObserver.observe(chatThread)
    }
    scheduleScrollToBottom()
    window.addEventListener('batshit:locate-zip', handleLocateZip)
  })

  onDestroy(() => {
    window.removeEventListener('batshit:locate-zip', handleLocateZip)
    resizeObserver?.disconnect()
    resizeObserver = null
    if (scrollFrame !== null && typeof cancelAnimationFrame === 'function') {
      cancelAnimationFrame(scrollFrame)
    }
  })
</script>

<div 
  bind:this={scrollContainer}
  onscroll={handleScroll}
  onwheel={handleWheel}
  onpointerdown={handlePointerDown}
  ontouchstart={handleTouchStart}
  ontouchmove={handleTouchMove}
  ontouchend={handleTouchEnd}
  ontouchcancel={handleTouchEnd}
  role="region"
  aria-label="Chat conversation"
  class="chat-scroll-region"
  class:has-composer-clips={composerClipCount > 0}
>
  <div class="chat-thread" bind:this={chatThread}>
    {#if messages.length === 0}
      <div class="chat-empty-state">
        <p>Welcome to Batshit v2!</p>
        <p class="chat-empty-state-subtitle">The frontend built FOR our revolutionary backend 🚀</p>
      </div>
    {:else}
      {#each messages as message, index (message.id)}
        {@const messageWaitingForTool = message.status === 'in_progress' && activeToolMessageIdSet.has(message.id)}
        {@const messageToolCallName = messageWaitingForTool ? toolCallNamesByMessageId?.[message.id] ?? null : null}
        <ChatMessageComponent 
          {message} 
          isTrimmed={trimmedMessageIdSet.has(message.id)}
          isCompacted={compactedMessageIdSet.has(message.id)}
          messageIndex={index} 
          totalMessages={messages.length}
          agentMessagesFromEnd={agentMessagesFromEndByIndex[index] ?? 0}
          {isWaitingForResponse}
          isWaitingForToolCall={messageWaitingForTool}
          toolCallName={messageToolCallName}
          {sessionId}
          thinkingSubject={thinkingSubjects?.[message.id]}
          planSubject={planSubjects?.[message.id]}
          {voiceSettings}
        />
      {/each}
      <div class="chat-bottom-sentinel" aria-hidden="true"></div>
    {/if}
  </div>
</div>

<style>
  .chat-scroll-region {
    box-sizing: border-box;
    flex: 1 1 0;
    overflow-y: auto;
    overflow-x: hidden;
    padding: 1.75rem;
    background: var(--background);
    color: var(--bs-app-text);
    min-width: 0;
    min-height: 0;
    overflow-anchor: none;
  }

  .chat-scroll-region.has-composer-clips {
    padding-bottom: calc(1.75rem + 3.15rem);
  }

  :global(body.goon-immersive) .chat-scroll-region {
    background: transparent;
  }

  .chat-thread {
    box-sizing: border-box;
    width: min(100%, 52rem);
    min-width: 0;
    max-width: 100%;
    margin-inline: auto;
    display: flex;
    flex-direction: column;
    gap: 1rem;
    overflow-anchor: none;
  }

  .chat-bottom-sentinel {
    flex: 0 0 1px;
    height: 1px;
    margin-top: -1rem;
    overflow-anchor: auto;
  }

  .chat-empty-state {
    padding-block: 2rem;
    text-align: center;
    color: var(--bs-app-muted-text);
  }

  .chat-empty-state-subtitle {
    margin-top: 0.5rem;
    font-size: 0.875rem;
  }

  :global(.message-row.zip-locate-highlight) {
    animation: message-locate-pulse 1800ms ease-out;
  }

  @keyframes message-locate-pulse {
    0% {
      filter: drop-shadow(0 0 0.8rem oklch(from var(--success-color) l c h / 0.32));
    }
    100% {
      filter: none;
    }
  }
</style>
