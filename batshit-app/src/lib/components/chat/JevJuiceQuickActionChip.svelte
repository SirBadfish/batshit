<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Zap } from '@lucide/svelte'
  import {
    QUICK_ACTION_MARK_DETAIL_TEXT,
    quickActionMarkText,
    quickActionRoutingText,
    type QuickActionMark
  } from '$lib/utils/jevJuiceQuickActions'

  /**
   * SA-120 P9 (DL-120-15): the mark under a spoken user message that Batshit acted on. The user
   * always sees that it happened, what Jev decided, how sure it was, and whether anything went to
   * the agent. The same chip and click-open popover the memory and after-reply chips use.
   */
  interface Props {
    mark: QuickActionMark
    agentName: string
  }

  let { mark, agentName }: Props = $props()
</script>

<div class="jev-quick-action" data-testid="jev-juice-quick-action" data-action-id={mark.id}>
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="message-memory-chip is-jev-juice" aria-label="Show what this quick action did">
      <Zap class="message-memory-chip-icon" aria-hidden="true" />
      {quickActionMarkText(mark)}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      align="start"
      side="top"
      class="batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout z-[var(--z-popover)] w-96 message-memory-popover"
    >
      <p class="message-memory-popover-title">{quickActionMarkText(mark)}</p>
      <p class="message-memory-popover-status" data-testid="jev-juice-quick-action-routing">{quickActionRoutingText(mark, agentName)}</p>
      <p class="message-memory-popover-status">{QUICK_ACTION_MARK_DETAIL_TEXT}</p>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>

<style>
  .jev-quick-action {
    margin-top: 0.5rem;
    display: flex;
  }
</style>
