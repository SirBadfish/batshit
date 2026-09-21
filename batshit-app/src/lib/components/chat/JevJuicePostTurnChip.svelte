<script lang="ts">
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { Zap } from '@lucide/svelte'
  import JevJuiceNote from './JevJuiceNote.svelte'
  import type { JevJuicePostTurnRecord } from '$lib/types/typesafe'
  import {
    jevJuicePostTurnChipText,
    jevJuicePostTurnFindingBasis,
    jevJuicePostTurnFindingText,
    jevJuicePostTurnLaneLabel,
    jevJuicePostTurnToldText
  } from '$lib/utils/jevJuice'

  /**
   * SA-120 P6: what the Jev Juice after-reply check noticed about this reply. The same chip
   * and click-open popover the memory chips use, with the Jev Juice mark. It only SAYS what
   * was noticed and that the agent is told on its next turn; the reply itself is never edited.
   * A lane that could not run shows the ordinary Jev Juice note instead (DL-120-02).
   */
  interface Props {
    record: JevJuicePostTurnRecord
  }

  let { record }: Props = $props()
</script>

{#if record.findings.length > 0}
  <DropdownMenu.Root>
    <DropdownMenu.Trigger
      class="message-memory-chip is-jev-juice"
      aria-label="Show what Jev noticed about this reply"
      data-testid="jev-juice-post-turn"
    >
      <Zap class="message-memory-chip-icon" aria-hidden="true" />
      {jevJuicePostTurnChipText(record)}
    </DropdownMenu.Trigger>
    <DropdownMenu.Content
      align="start"
      side="top"
      class="batshit-settings-info-content batshit-settings-card-elevated batshit-settings-card-info-callout z-[var(--z-popover)] w-96 message-memory-popover"
    >
      <p class="message-memory-popover-title">Jev noticed after this reply:</p>
      {#each record.findings as finding, index (`${finding.id}:${index}`)}
        <div class="message-memory-popover-row" data-testid="jev-juice-post-turn-finding" data-finding-id={finding.id}>
          <span class="message-memory-popover-lane">{jevJuicePostTurnLaneLabel(finding.lane)}</span>
          <span class="message-memory-popover-gist">
            <span>{jevJuicePostTurnFindingText(finding)}</span>
            <span class="message-memory-popover-status">{jevJuicePostTurnFindingBasis(finding)}</span>
          </span>
        </div>
      {/each}
      <p class="message-memory-popover-status">{jevJuicePostTurnToldText(record)}</p>
    </DropdownMenu.Content>
  </DropdownMenu.Root>
{/if}
{#if record.notes.length > 0}
  <JevJuiceNote notes={record.notes} />
{/if}
