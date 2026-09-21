<script lang="ts">
  import { Zap } from '@lucide/svelte'
  import type { JevJuiceNote } from '$lib/types/typesafe'
  import { jevJuiceNoteDetail, jevJuiceNoteText } from '$lib/utils/jevJuice'

  /**
   * SA-120 P0 (DL-120-02, Josh's decision 1): the small inline note beside the memory
   * chips when a Jev Juice lane could not run for this turn. The send already went out
   * without it; this only says so. Never a pop-up, never a toast.
   */
  interface Props {
    notes: JevJuiceNote[]
  }

  let { notes }: Props = $props()
</script>

{#each notes as note, index (`${note.feature}:${note.at}:${index}`)}
  <span
    class="message-memory-chip is-jev-juice"
    role="note"
    title={jevJuiceNoteDetail(note)}
    data-testid="jev-juice-note"
    data-feature={note.feature}
  >
    <Zap class="message-memory-chip-icon" aria-hidden="true" />
    {jevJuiceNoteText(note)}
  </span>
{/each}
