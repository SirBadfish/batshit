<script lang="ts">
  /**
   * SA-120 P7 (Josh's review, 2026-09-17) — the flag on the wake-up message itself, at the top
   * of a chat a DM or a webhook started. It is the one place the flagged text is actually
   * read, and where the notice card's "Show the message" lands. Draws only a flag, or the
   * quiet note that the screen could not run; a message with no flag draws nothing.
   */
  import JevJuiceNote from './JevJuiceNote.svelte'
  import JevJuiceFlagBlock from './JevJuiceFlagBlock.svelte'
  import { getDmBrief, requestDmBrief } from '$lib/stores/dmBriefs.svelte'
  import { UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT, untrustedTextSkippedNote } from '$lib/utils/jevJuice'

  interface Props {
    dmId: string
  }

  let { dmId }: Props = $props()

  $effect(() => {
    requestDmBrief(dmId)
  })
  const screen = $derived(getDmBrief(dmId)?.screen ?? null)
</script>

{#if screen?.status === 'flagged'}
  <div class="jev-wake-flag" data-testid="jev-juice-wake-message-flag">
    <JevJuiceFlagBlock view={screen} closing={UNTRUSTED_TEXT_WAKE_MESSAGE_TOLD_TEXT} />
  </div>
{:else if screen?.status === 'skipped'}
  <div class="jev-wake-flag" data-testid="jev-juice-wake-message-skipped">
    <JevJuiceNote notes={[untrustedTextSkippedNote(screen)]} />
  </div>
{/if}

<style>
  .jev-wake-flag {
    margin-top: 0.5rem;
  }
</style>
