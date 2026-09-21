<script lang="ts">
  /**
   * SA-120 P7 (Josh's review, 2026-09-17) — the notice card above an approval card, in a
   * chat a wake-up message started.
   *
   * It is its OWN card, on purpose. A flag on the approval card itself made the Approve
   * button feel like approving the flag, and a flag is never approved: it is information.
   * So the notice stands above the approval card, says what Jev flagged and how sure it was,
   * quotes the start of the message, jumps to it on request, and can be closed. Closing it
   * never touches the approval card under it; Batshit remembers the close in this browser,
   * for this message, so it does not come back on every reload. The badge on the wake-up
   * message itself and in the Agent DMs drawer stays.
   *
   * It is put together HERE, in the browser, from a separate read of the DM's brief. The
   * server's risk gate never sees a screen (DL-120-12): nothing here can approve, deny,
   * delay, or pre-select anything.
   */
  import { X } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { getDmBrief, requestDmBrief } from '$lib/stores/dmBriefs.svelte'
  import {
    UNTRUSTED_TEXT_APPROVAL_HINT,
    UNTRUSTED_TEXT_DISMISS_TEXT,
    UNTRUSTED_TEXT_NOTICE_LEAD,
    UNTRUSTED_TEXT_NOTICE_TITLE,
    UNTRUSTED_TEXT_SHOW_MESSAGE_TEXT,
    untrustedTextQuote
  } from '$lib/utils/jevJuice'
  import JevJuiceFlagBlock from './JevJuiceFlagBlock.svelte'

  interface Props {
    /** The DM whose wake started this turn. */
    dmId: string
    /** The user message that carries that DM's text, for "Show the message". */
    wakeMessageId?: string | null
    /** An approval card sits under this notice, so the last line says to read the message first. */
    withApproval?: boolean
  }

  let { dmId, wakeMessageId = null, withApproval = false }: Props = $props()

  const DISMISSED_KEY = 'batshit:jev-juice-flag-notice-dismissed'

  function readDismissed(): Record<string, true> {
    try {
      const raw = globalThis.localStorage?.getItem(DISMISSED_KEY)
      const parsed = raw ? JSON.parse(raw) : null
      return parsed && typeof parsed === 'object' ? (parsed as Record<string, true>) : {}
    } catch {
      return {}
    }
  }

  function rememberDismissed(id: string): void {
    try {
      const next = { ...readDismissed(), [id]: true as const }
      globalThis.localStorage?.setItem(DISMISSED_KEY, JSON.stringify(next))
    } catch {
      // Browser storage is a convenience: with it blocked the notice simply returns next time.
    }
  }

  let dismissed = $state(false)
  $effect(() => {
    dismissed = readDismissed()[dmId] === true
  })

  $effect(() => {
    requestDmBrief(dmId)
  })
  const brief = $derived(getDmBrief(dmId))
  const flag = $derived(brief?.screen?.status === 'flagged' ? brief.screen : null)
  const quote = $derived(brief ? untrustedTextQuote(brief.subject, brief.snippet) : '')

  function close(): void {
    dismissed = true
    rememberDismissed(dmId)
  }

  function showMessage(): void {
    if (!wakeMessageId) return
    window.dispatchEvent(new CustomEvent('batshit:locate-zip', { detail: { messageId: wakeMessageId, behavior: 'auto' } }))
  }
</script>

{#if flag && !dismissed}
  <div class="jev-flag-notice" class:is-serious={flag.severity === 'serious'} data-testid="jev-juice-flag-notice">
    <div class="jev-flag-notice-header">
      <p class="jev-flag-notice-title">{UNTRUSTED_TEXT_NOTICE_TITLE}</p>
      <Button
        size="icon"
        variant="ghost"
        class="jev-flag-notice-close"
        aria-label={UNTRUSTED_TEXT_DISMISS_TEXT}
        title={UNTRUSTED_TEXT_DISMISS_TEXT}
        onclick={close}
      >
        <X aria-hidden="true" />
      </Button>
    </div>
    <p class="jev-flag-notice-lead">{UNTRUSTED_TEXT_NOTICE_LEAD}</p>
    <JevJuiceFlagBlock
      view={flag}
      showTitle={false}
      closing={withApproval ? UNTRUSTED_TEXT_APPROVAL_HINT : null}
      testId="jev-juice-flag-notice-block"
    />
    {#if quote}
      <blockquote class="jev-flag-notice-quote" data-testid="jev-juice-flag-notice-quote">“{quote}”</blockquote>
    {/if}
    {#if wakeMessageId}
      <button type="button" class="jev-flag-notice-link" onclick={showMessage}>
        {UNTRUSTED_TEXT_SHOW_MESSAGE_TEXT}
      </button>
    {/if}
  </div>
{/if}

<style>
  /* The same shell as `.message-approval-panel`, so the two cards read as one family. */
  .jev-flag-notice {
    margin-top: 0.75rem;
    border: 1px solid oklch(0.72 0.12 78 / 0.4);
    border-radius: var(--radius);
    background: oklch(from var(--card) l c h / 0.85);
    padding: 0.75rem;
  }

  .jev-flag-notice.is-serious {
    border-color: oklch(from var(--destructive) l c h / 0.45);
  }

  .jev-flag-notice-header {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .jev-flag-notice-title {
    margin: 0;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 600;
  }

  .jev-flag-notice :global(.jev-flag-notice-close) {
    width: 1.5rem;
    height: 1.5rem;
    margin: -0.25rem -0.25rem 0 0;
    color: var(--muted-foreground);
  }

  .jev-flag-notice-lead {
    margin: 0.125rem 0 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .jev-flag-notice-quote {
    margin: 0.625rem 0 0;
    padding-left: 0.625rem;
    border-left: 1px solid oklch(from var(--border) l c h / 0.8);
    color: var(--muted-foreground);
    font-size: 0.75rem;
    line-height: 1.45;
    font-style: italic;
  }

  .jev-flag-notice-link {
    margin-top: 0.5rem;
    padding: 0;
    border: 0;
    background: none;
    color: var(--primary);
    font-size: 0.75rem;
    text-decoration: underline;
    cursor: pointer;
  }
</style>
