<script lang="ts">
  import { Popover } from 'bits-ui'
  import { Copy, Presentation, X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import type { WhiteboardPanelState } from '$lib/stores/whiteboardPanel'
  import { estimateWhiteboardTokens } from '$lib/utils/reasoningRetention'
  import { copyTextToClipboard } from '$lib/utils/clipboard'

  let { state: panelState, budgetTokens, onOpenChange, onRefresh }: {
    state: WhiteboardPanelState
    budgetTokens: number
    onOpenChange: (open: boolean) => void
    onRefresh: () => void
  } = $props()
  const tokens = $derived(estimateWhiteboardTokens(panelState.board?.content ?? ''))
  const overBudget = $derived(tokens > budgetTokens)
  const copyFeedbackKey = $derived(JSON.stringify([
    panelState.owner?.userId, panelState.owner?.sessionId, panelState.owner?.agentId,
    panelState.board?.version ?? 0
  ]))
  let copyError = $state<string | null>(null)
  let copiedTarget = $state<string | null>(null)
  let triggerRef = $state<HTMLButtonElement | null>(null)
  let dismissedOutside = false
  let copyRequest = 0
  $effect(() => {
    if (panelState.open) dismissedOutside = false
  })
  $effect(() => {
    copyFeedbackKey
    copyError = null
    copiedTarget = null
    copyRequest += 1
  })

  async function copyBoard() {
    const board = panelState.board
    if (!board?.content) return
    const target = copyFeedbackKey
    const request = ++copyRequest
    copyError = null
    try {
      await copyTextToClipboard(board.content)
      if (request === copyRequest && target === copyFeedbackKey) copiedTarget = target
    } catch {
      if (request === copyRequest && target === copyFeedbackKey) {
        copyError = 'Could not copy the notes. You can select and copy the text below.'
      }
    }
  }
</script>

<Popover.Root open={panelState.open} {onOpenChange}>
  <Popover.Trigger bind:ref={triggerRef} class="whiteboard-trigger" title="Whiteboard" aria-label="Open Whiteboard" data-testid="whiteboard-trigger">
    <Presentation aria-hidden="true" />
  </Popover.Trigger>
  <Popover.Portal>
    <Popover.Content
      side="top"
      align="start"
      sideOffset={4}
      collisionPadding={8}
      class="bs-dropdown-content batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout whiteboard-popover"
      role="dialog"
      aria-label="Whiteboard"
      data-testid="whiteboard-panel"
      trapFocus={false}
      onInteractOutside={() => { dismissedOutside = true }}
      onCloseAutoFocus={(event) => {
        if (dismissedOutside) {
          event.preventDefault()
          return
        }
        // A carried panel can have opened while the former reply's trigger was disappearing.
        if (panelState.open || !panelState.visible || !triggerRef?.isConnected) return
        event.preventDefault()
        triggerRef.focus({ preventScroll: true })
      }}
    >
      <div class="whiteboard-heading">
        <span class="whiteboard-title">Whiteboard</span>
        <Button variant="ghost" size="xs" onclick={copyBoard} disabled={!panelState.confirmed || !panelState.board?.content} aria-label="Copy Whiteboard">
          <Copy aria-hidden="true" />
          <span>{copiedTarget === copyFeedbackKey ? 'Copied' : 'Copy'}</span>
        </Button>
        <Button variant="ghost" size="xs" onclick={() => onOpenChange(false)} aria-label="Close Whiteboard" title="Close Whiteboard">
          <X aria-hidden="true" />
        </Button>
      </div>
      {#if panelState.loading}
        <p class="whiteboard-meta" role="status">{panelState.confirmed ? 'Refreshing saved notes…' : 'Loading saved notes…'}</p>
      {/if}
      {#if panelState.error}
        <div class="whiteboard-error" role="alert">
          <p>{panelState.error}</p>
          <Button variant="outline" size="xs" onclick={onRefresh} disabled={panelState.loading}>Retry</Button>
        </div>
      {/if}
      {#if copyError}<p class="whiteboard-error" role="alert">{copyError}</p>{/if}
      {#if panelState.confirmed}
        {#if panelState.board}
          <p class="whiteboard-meta whiteboard-metadata-row">
            <span>Last updated <time datetime={panelState.board.updated_at}>{new Date(panelState.board.updated_at).toLocaleString()}</time></span>
            <span class="whiteboard-token-usage">
              <span aria-hidden="true">·</span>
              <span title="Token counts and limits use an estimate of roughly one token per four characters." aria-label={`${tokens.toLocaleString()} estimated tokens, ${budgetTokens.toLocaleString()} estimated token limit`}>{tokens.toLocaleString()} tokens / {budgetTokens.toLocaleString()} limit</span>
            </span>
          </p>
          {#if overBudget}
            <p class="whiteboard-meta">Above the current budget. All saved notes are shown; the next update must fit the limit.</p>
          {/if}
          {#if panelState.board.content}
            <div class="whiteboard-notes" data-testid="whiteboard-notes">{panelState.board.content}</div>
          {:else}
            <p class="whiteboard-empty">Whiteboard cleared. No saved notes.</p>
          {/if}
        {:else}
          <p class="whiteboard-empty">No saved notes yet.</p>
        {/if}
      {/if}
    </Popover.Content>
  </Popover.Portal>
</Popover.Root>

<style>
  /* The existing Memory chip and its inset popover supply this surface's material. */
  :global(.whiteboard-trigger) {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 1.5rem;
    height: 1.5rem;
    padding: 0;
    border: 1px solid oklch(from var(--muted-foreground) l c h / 0.25);
    border-radius: 999px;
    background: transparent;
    color: var(--muted-foreground);
    cursor: pointer;
  }
  :global(.whiteboard-trigger:hover), :global(.whiteboard-trigger[data-state='open']) {
    background: oklch(from var(--muted-foreground) l c h / 0.08);
  }
  :global(.whiteboard-trigger:focus-visible) { outline: 2px solid var(--ring); outline-offset: 2px; }
  :global(.whiteboard-trigger svg) { width: 0.875rem; height: 0.875rem; }
  :global(.whiteboard-popover) {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    width: min(24rem, calc(100vw - 1rem));
    max-height: min(32rem, calc(100dvh - 1rem), var(--bits-popover-content-available-height, 32rem));
    overflow-y: auto;
  }
  .whiteboard-heading { display: flex; align-items: center; gap: 0.25rem; }
  .whiteboard-title { flex: 1; font-size: 0.875rem; font-weight: 500; color: var(--foreground); }
  .whiteboard-meta { margin: 0; font-size: 0.6875rem; color: var(--muted-foreground); }
  .whiteboard-metadata-row { display: flex; flex-wrap: wrap; align-items: baseline; column-gap: 0.375rem; row-gap: 0.125rem; }
  .whiteboard-token-usage { display: inline-flex; align-items: baseline; gap: 0.375rem; }
  .whiteboard-notes { white-space: pre-wrap; overflow-wrap: anywhere; user-select: text; font-size: 0.875rem; font-weight: 300; line-height: 1.5; }
  .whiteboard-empty { margin: 0; font-size: 0.875rem; color: var(--muted-foreground); }
  .whiteboard-error { font-size: 0.75rem; color: var(--destructive); }
  .whiteboard-error p { margin: 0 0 0.25rem; }
</style>
