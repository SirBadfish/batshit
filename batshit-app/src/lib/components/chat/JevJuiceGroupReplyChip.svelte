<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Zap } from '@lucide/svelte'
  import { GROUP_REPLY_SKIPPED_DETAIL, groupReplySkippedText, type GroupReplySkipped } from '$lib/utils/groupReplySkipped'

  let { mark }: { mark: GroupReplySkipped } = $props()
</script>

<div class="jev-group-reply" data-testid="jev-juice-group-reply-skipped">
  <DropdownMenu.Root>
    <DropdownMenu.Trigger class="message-memory-chip is-jev-juice" aria-label="Show why this group reply was skipped">
      <Zap class="message-memory-chip-icon" aria-hidden="true" />
      {groupReplySkippedText(mark)}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      align="start"
      side="top"
      class="batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout z-[var(--z-popover)] w-96 message-memory-popover"
    >
      <p class="message-memory-popover-title">{groupReplySkippedText(mark)}</p>
      <p class="message-memory-popover-status">{GROUP_REPLY_SKIPPED_DETAIL}</p>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
</div>

<style>
  .jev-group-reply {
    margin-top: 0.5rem;
    display: flex;
  }
</style>
