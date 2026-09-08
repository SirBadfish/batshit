<script lang="ts">
  import { Mail } from '@lucide/svelte'
  import * as Tooltip from '$lib/components/ui/tooltip'
  import { ensureDmInboxCountsHydrated, getDmInboxCounts } from '$lib/stores/dmInbox.svelte'

  /**
   * SA-113 P4 (DL-113-10a) — the header rail's envelope.
   *
   * Rendered ONLY for an agent with Agent DMs on, which is what keeps Josh's "invisible by
   * default" rule true: an instance where nobody turned DMs on has no envelope, no badge,
   * and no drawer.
   *
   * The count comes from the `dm_inbox_changed` events the DM store publishes, so this
   * never polls. Sits beside `UpdateAvailableIndicator` and copies its trigger shape, so
   * the two header icons are the same object at the same size.
   */

  let {
    agentId = null,
    dmsEnabled = false,
    onOpen
  } = $props<{
    agentId?: string | null
    dmsEnabled?: boolean
    onOpen?: () => void
  }>()

  // One seed per page load; the user channel keeps it current afterwards.
  //
  // SA-113 F-P4-2: this has to be an `$effect` on `dmsEnabled`, not `onMount`. Agent DMs is
  // a live setting (LS-043), so turning it on AFTER the page loaded renders the envelope
  // immediately — and with a mount-only seed that envelope would sit at 0 until the first
  // `dm_inbox_changed` event happened to arrive. `ensureDmInboxCountsHydrated` is itself
  // once-per-page-load, so re-running the effect costs nothing.
  $effect(() => {
    if (dmsEnabled) void ensureDmInboxCountsHydrated()
  })

  const counts = $derived(getDmInboxCounts(agentId))
  const open = $derived(counts.openCount)
  const needsUser = $derived(counts.needsUserCount)
  // F-SEC-1b: "needs you" outranks the open count in the label, because it is the only
  // state that asks the user to do something rather than telling them what the agents did.
  const label = $derived(
    needsUser > 0
      ? needsUser === 1
        ? 'Agent DMs — 1 needs you'
        : `Agent DMs — ${needsUser} need you`
      : open === 0
        ? 'Agent DMs'
        : open === 1
          ? 'Agent DMs — 1 open item'
          : `Agent DMs — ${open} open items`
  )
</script>

{#if dmsEnabled && agentId}
  <Tooltip.Root>
    <Tooltip.Trigger>
      {#snippet child({ props })}
        <button
          {...props}
          type="button"
          class="dm-inbox-trigger"
          aria-label={label}
          title={label}
          data-testid="dm-inbox-button"
          data-ab-control="dm-inbox"
          onclick={() => onOpen?.()}
        >
          <Mail class="dm-inbox-trigger-icon" />
          {#if open > 0}
            <span
              class="dm-inbox-badge"
              class:is-new={counts.newCount > 0}
              class:needs-user={needsUser > 0}
            >
              {open > 9 ? '9+' : open}
            </span>
          {/if}
        </button>
      {/snippet}
    </Tooltip.Trigger>
    <Tooltip.Content>
      <p>{label}</p>
    </Tooltip.Content>
  </Tooltip.Root>
{/if}

<style>
  .dm-inbox-trigger {
    position: relative;
    display: inline-flex;
    width: 40px;
    height: var(--app-header-height);
    align-items: center;
    justify-content: center;
    border: 0;
    border-radius: 0;
    background: transparent;
    color: var(--foreground);
    transition:
      background-color 150ms ease-out,
      color 150ms ease-out,
      box-shadow 150ms ease-out;
  }

  .dm-inbox-trigger:hover {
    background: color-mix(in oklab, var(--primary) 16%, transparent);
  }

  .dm-inbox-trigger:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--ring);
  }

  :global(.dm-inbox-trigger-icon) {
    width: 16px;
    height: 16px;
  }

  .dm-inbox-badge {
    position: absolute;
    top: 8px;
    right: 6px;
    display: inline-flex;
    min-width: 15px;
    height: 15px;
    align-items: center;
    justify-content: center;
    border: 1px solid var(--background);
    border-radius: 999px;
    background: color-mix(in oklab, var(--primary) 82%, var(--foreground));
    padding: 0 3px;
    color: var(--background);
    font-size: 0.625rem;
    font-weight: 500;
    line-height: 1;
  }

  /* Unclaimed mail is the only state worth a colour change: the agent has not seen it yet. */
  .dm-inbox-badge.is-new {
    background: var(--bs-app-success-text, oklch(0.72 0.115 185));
  }

  /*
   * F-SEC-1b: a woken chat stopped waiting on the user. Last rule on purpose, so it wins
   * over `.is-new` — an item that needs a person is not news, it is a to-do.
   */
  .dm-inbox-badge.needs-user {
    background: var(--bs-settings-warning, oklch(0.666 0.179 58.318));
  }
</style>
