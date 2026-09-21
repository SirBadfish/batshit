<script lang="ts">
  /**
   * SA-120 P7 — the Jev Juice flag as the USER reads it, one block for every surface that
   * draws it in a chat: the Agent DM tool card, the wake-up message at the top of a woken
   * chat, and the notice card above an approval card.
   *
   * The words are Josh's (2026-09-17 review): "Flagged by Jev" (Jev is the model that did
   * it; Jev Juice is the feature), one CATEGORY per finding with "(96% confidence)" on every
   * line, "Potential harm: serious | minor", then the promise that it is a guess and blocked
   * nothing. It draws ONLY a flag. A DM with no flag never reaches this block, so nothing
   * here can read as "clean" (DL-120-12).
   */
  import { Zap } from '@lucide/svelte'
  import {
    UNTRUSTED_TEXT_ADVISORY_TEXT,
    UNTRUSTED_TEXT_BADGE_TEXT,
    UNTRUSTED_TEXT_CLIPPED_TEXT,
    untrustedTextCategoryLines,
    untrustedTextHarmText,
    type UntrustedTextFlagView
  } from '$lib/utils/jevJuice'

  interface Props {
    view: UntrustedTextFlagView
    /** The surface's own closing line ("The agent that read this DM was told the same."), if any. */
    closing?: string | null
    /** Off for a surface whose own title already says what this is (the notice card). */
    showTitle?: boolean
    testId?: string
  }

  let { view, closing = null, showTitle = true, testId = 'jev-juice-flag-block' }: Props = $props()

  const categoryLines = $derived(untrustedTextCategoryLines(view))
</script>

<div class="jev-flag-block" class:is-serious={view.severity === 'serious'} data-testid={testId}>
  {#if showTitle}
    <div class="jev-flag-title">
      <Zap class="jev-flag-icon" aria-hidden="true" />
      <span>{UNTRUSTED_TEXT_BADGE_TEXT}</span>
    </div>
  {/if}
  <div class="jev-flag-lines">
    {#each categoryLines as line, index (index)}
      <div class="jev-flag-line" class:is-heading={line === 'Categories:'}>{line}</div>
    {/each}
    <div class="jev-flag-line">{untrustedTextHarmText(view)}</div>
  </div>
  <div class="jev-flag-note">
    {UNTRUSTED_TEXT_ADVISORY_TEXT}
    {#if view.clipped}
      {UNTRUSTED_TEXT_CLIPPED_TEXT}
    {/if}
    {#if closing}
      {closing}
    {/if}
  </div>
</div>

<style>
  /* The amber of `batshit-settings-status-badge.is-warning`; the serious tone is the chat's own
     destructive recipe, because `--bs-settings-*` tokens do not exist outside Settings (F-P7-4). */
  .jev-flag-block {
    padding: 0.5rem 0.625rem;
    border: 1px solid oklch(0.72 0.12 78 / 0.4);
    border-radius: var(--radius);
    background: oklch(0.72 0.12 78 / 0.12);
    color: oklch(0.72 0.12 78);
    font-size: 0.75rem;
    line-height: 1.45;
  }

  .jev-flag-block.is-serious {
    border-color: oklch(from var(--destructive) l c h / 0.45);
    background: oklch(from var(--destructive) l c h / 0.12);
    color: var(--destructive);
  }

  .jev-flag-title {
    display: flex;
    align-items: center;
    gap: 0.375rem;
    font-weight: 500;
  }

  .jev-flag-title :global(.jev-flag-icon) {
    width: 0.8125rem;
    height: 0.8125rem;
    flex: 0 0 auto;
  }

  .jev-flag-lines {
    margin: 0.25rem 0;
    color: var(--foreground);
  }

  .jev-flag-line.is-heading {
    color: var(--muted-foreground);
  }

  .jev-flag-note {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    line-height: 1.45;
  }
</style>
