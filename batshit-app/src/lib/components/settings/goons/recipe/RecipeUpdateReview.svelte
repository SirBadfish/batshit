<script lang="ts">
  import { ChevronDown, ShieldCheck, TriangleAlert } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import type {
    RecipeMigrationClassification,
    RecipeMigrationReport,
    RecipeMigrationReportEntry,
    RecipeAuthorUpdateClassification
  } from '$lib/goons/recipe'
  import type { RecipeUpdateFilter } from './types'

  const classifications: RecipeMigrationClassification[] = [
    'kept',
    'presentation-updated',
    'remapped',
    'new',
    'removed',
    'reset-required',
    'blocked'
  ]

  const classificationLabels: Record<RecipeMigrationClassification, string> = {
    kept: 'Kept',
    'presentation-updated': 'Presentation only',
    remapped: 'Remapped',
    new: 'New',
    removed: 'Removed',
    'reset-required': 'Reset required',
    blocked: 'Blocked'
  }

  type Props = {
    report: RecipeMigrationReport
    classification?: RecipeAuthorUpdateClassification | null
    filter?: RecipeUpdateFilter
    busy?: 'updating' | 'keeping' | 'resetting' | null
    canUpdateAndRebuild?: boolean
    canKeepCurrentPackage?: boolean
    canCleanReset?: boolean
    onFilterChange?: (filter: RecipeUpdateFilter) => void
    onUpdateAndRebuild: () => void | Promise<void>
    onKeepCurrentPackage: () => void | Promise<void>
    onRequestCleanReset: () => void
  }

  let {
    report,
    classification = null,
    filter = $bindable<RecipeUpdateFilter>('all'),
    busy = null,
    canUpdateAndRebuild = false,
    canKeepCurrentPackage = true,
    canCleanReset = false,
    onFilterChange,
    onUpdateAndRebuild,
    onKeepCurrentPackage,
    onRequestCleanReset
  }: Props = $props()

  let openRows = $state<Record<string, boolean>>({})
  let technicalOpen = $state(false)

  const counts = $derived.by(() =>
    Object.fromEntries(
      classifications.map((classification) => [
        classification,
        report.entries.filter((entry) => entry.classification === classification).length
      ])
    ) as Record<RecipeMigrationClassification, number>
  )

  const visibleEntries = $derived(
    filter === 'all'
      ? report.entries
      : report.entries.filter((entry) => entry.classification === filter)
  )

  const wholeRecipeProofVerified = $derived(report.status === 'preserved')

  const hasResetRows = $derived(counts['reset-required'] > 0)
  const hasBlockedRows = $derived(counts.blocked > 0 || report.status === 'blocked')
  const effectiveClassification = $derived.by<RecipeAuthorUpdateClassification>(() => {
    if (classification) return classification
    if (hasBlockedRows) return 'blocked-ineligible'
    if (hasResetRows) return 'reset-required'
    if (counts.remapped > 0) return 'proven-remap'
    return report.status === 'preserved'
      ? 'automatic-appearance-preserving'
      : report.status === 'preview-required'
        ? 'verified-preview-required'
        : 'blocked-ineligible'
  })

  function setFilter(nextFilter: RecipeUpdateFilter) {
    filter = nextFilter
    onFilterChange?.(nextFilter)
  }

  function toggleRow(id: string) {
    openRows = { ...openRows, [id]: !openRows[id] }
  }

  function formatValue(value: number | null): string {
    if (value === null) return 'Not present'
    return Number.isInteger(value) ? value.toString() : value.toPrecision(7).replace(/0+$/, '').replace(/\.$/, '')
  }

  function proofCopy(entry: RecipeMigrationReportEntry): string {
    if (
      entry.classification === 'remapped' &&
      entry.proofStatus === 'verified' &&
      wholeRecipeProofVerified
    ) {
      return 'appearance-preserving conversion verified'
    }
    if (
      (entry.classification === 'kept' || entry.classification === 'presentation-updated') &&
      (entry.proofStatus === 'verified' || entry.proofStatus === 'not-required')
    ) {
      return 'value preserved'
    }
    if (entry.requiresPreview || entry.classification === 'reset-required') return 'preview required'
    if (entry.classification === 'new') return 'starts at neutral'
    if (entry.classification === 'removed') return 'removed from Updated Recipe'
    if (entry.classification === 'blocked') return 'automatic update blocked'
    return entry.proofStatus === 'verified' ? 'verified' : 'review required'
  }

  function statusClass(classification: RecipeMigrationClassification): string {
    if (classification === 'kept' || classification === 'presentation-updated') return 'is-success'
    if (classification === 'blocked') return 'is-danger'
    if (classification === 'reset-required' || classification === 'removed') return 'is-warning'
    return 'is-info'
  }
</script>

<section class="recipe-update-review space-y-4" aria-labelledby="recipe-update-review-title">
  <div class="min-w-0">
    <h3 id="recipe-update-review-title" class="batshit-settings-section-title">Goon File Update</h3>
    <p class="batshit-settings-caption mt-1">
      Batshit checked whether this file can safely keep your saved appearance.
    </p>
  </div>

  {#if effectiveClassification === 'blocked-ineligible'}
    <div class="batshit-settings-muted-panel recipe-review-callout is-danger" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div class="min-w-0">
        <div class="batshit-settings-form-label is-danger">Automatic update blocked</div>
        <p class="batshit-settings-caption mt-1 break-words">
          This file cannot be applied safely. Your current Goon stays unchanged.
        </p>
      </div>
    </div>
  {:else if effectiveClassification === 'reset-required' ||
    effectiveClassification === 'verified-preview-required' ||
    report.status === 'preview-required'}
    <div class="batshit-settings-muted-panel recipe-review-callout is-warning">
      <TriangleAlert aria-hidden="true" />
      <div class="min-w-0">
        <div class="batshit-settings-form-label is-warning">Your confirmation is required</div>
        <p class="batshit-settings-caption mt-1 break-words">
          {effectiveClassification === 'reset-required'
            ? 'Compare Current and Updated, then choose whether to reset appearance and apply this file.'
            : 'Compare Current and Updated, then approve the verified presentation change.'}
        </p>
      </div>
    </div>
  {:else if effectiveClassification === 'proven-remap'}
    <div class="batshit-settings-muted-panel recipe-review-callout is-success">
      <ShieldCheck aria-hidden="true" />
      <div class="min-w-0">
        <div class="batshit-settings-form-label">Your appearance can be converted safely</div>
        <p class="batshit-settings-caption mt-1 break-words">
          Batshit verified the exact conversion supplied with this file.
        </p>
      </div>
    </div>
  {:else if effectiveClassification === 'automatic-appearance-preserving' && wholeRecipeProofVerified}
    <div class="batshit-settings-muted-panel recipe-review-callout is-success">
      <ShieldCheck aria-hidden="true" />
      <div class="min-w-0">
        <div class="batshit-settings-form-label">Your appearance can be preserved</div>
        <p class="batshit-settings-caption mt-1 break-words">
          The supported update proof passed every required check.
        </p>
      </div>
    </div>
  {/if}

  {#if report.warnings.length > 0}
    <div class="space-y-2" aria-label="Update warnings">
      {#each report.warnings as warning (warning.proofSha256)}
        <div class="batshit-settings-muted-panel recipe-review-warning">
          <TriangleAlert aria-hidden="true" />
          <span class="batshit-settings-caption break-words">{warning.message}</span>
        </div>
      {/each}
    </div>
  {/if}

  <Collapsible.Root open={technicalOpen}>
    <Collapsible.Trigger
      class="batshit-settings-collapsible-trigger recipe-review-technical-trigger"
      onclick={() => { technicalOpen = !technicalOpen }}
    >
      <span class="batshit-settings-child-label">Technical Details</span>
      <ChevronDown aria-hidden="true" class={technicalOpen ? 'rotate-180' : ''} />
    </Collapsible.Trigger>
    {#if technicalOpen}
    <div class="recipe-review-technical space-y-3">
  <div class="recipe-review-filters" role="group" aria-label="Filter update rows">
    <Button
      size="sm"
      variant={filter === 'all' ? 'secondary' : 'outline'}
      aria-pressed={filter === 'all'}
      onclick={() => setFilter('all')}
    >
      All <Badge variant="outline">{report.entries.length}</Badge>
    </Button>
    {#each classifications as classification}
      <Button
        size="sm"
        variant={filter === classification ? 'secondary' : 'outline'}
        aria-pressed={filter === classification}
        onclick={() => setFilter(classification)}
      >
        {classificationLabels[classification]}
        <Badge variant="outline">{counts[classification]}</Badge>
      </Button>
    {/each}
  </div>

  <p class="sr-only" aria-live="polite" aria-atomic="true">
    Showing {visibleEntries.length} of {report.entries.length} update rows.
  </p>

  {#if visibleEntries.length === 0}
    <div class="batshit-settings-empty-state">
      No {filter === 'all' ? '' : classificationLabels[filter].toLocaleLowerCase()} changes in this update.
    </div>
  {:else}
    <div class="recipe-review-list" role="list" aria-label="Update details">
      {#each visibleEntries as entry (entry.id)}
        {@const rowOpen = Boolean(openRows[entry.id])}
        <div class="recipe-review-row" role="listitem">
          <Collapsible.Root open={rowOpen}>
            <Collapsible.Trigger
              class="batshit-settings-collapsible-trigger recipe-review-row-trigger"
              onclick={() => toggleRow(entry.id)}
            >
              <span class="recipe-review-row-copy">
                <span class="batshit-settings-form-label break-words">{entry.id}</span>
                <span class="batshit-settings-caption break-words">{proofCopy(entry)}</span>
              </span>
              <span class="recipe-review-row-meta">
                <Badge
                  variant="outline"
                  class={`batshit-settings-status-badge ${statusClass(entry.classification)}`}
                >
                  {classificationLabels[entry.classification]}
                </Badge>
                <ChevronDown aria-hidden="true" class={rowOpen ? 'rotate-180' : ''} />
              </span>
            </Collapsible.Trigger>
            {#if rowOpen}
              <div class="recipe-review-row-details" data-recipe-row-details>
                <dl class="recipe-review-detail-grid">
                  <div>
                    <dt>Current value</dt>
                    <dd>{formatValue(entry.oldValue)}</dd>
                  </div>
                  <div>
                    <dt>Updated value</dt>
                    <dd>{formatValue(entry.proposedValue)}</dd>
                  </div>
                  <div>
                    <dt>Proof</dt>
                    <dd>{entry.proofStatus}</dd>
                  </div>
                  <div>
                    <dt>Maximum error</dt>
                    <dd>{entry.maximumError.toExponential(3)} / {entry.tolerance.toExponential(3)}</dd>
                  </div>
                </dl>
                <div class="space-y-1">
                  <div class="batshit-settings-child-label">Why</div>
                  <p class="batshit-settings-caption break-words">{entry.reason}</p>
                </div>
                <div class="recipe-review-proof-meta">
                  <span>Component: {entry.componentId}</span>
                  <span class="break-all">Proof: {entry.proofSha256}</span>
                </div>
              </div>
            {/if}
          </Collapsible.Root>
        </div>
      {/each}
    </div>
  {/if}

    </div>
    {/if}
  </Collapsible.Root>

  <div class="recipe-review-actions" aria-label="Update decisions">
    {#if effectiveClassification === 'reset-required' && canUpdateAndRebuild}
      <Button
        variant="destructive"
        onclick={onUpdateAndRebuild}
        disabled={busy !== null}
      >
        {busy === 'updating' ? 'Resetting and Updating…' : 'Reset Appearance and Update'}
      </Button>
    {:else if effectiveClassification !== 'blocked-ineligible'}
      <Button
        onclick={onUpdateAndRebuild}
        disabled={!canUpdateAndRebuild || busy !== null}
      >
        {busy === 'updating' ? 'Updating…' : 'Update Goon'}
      </Button>
    {/if}
    <Button
      variant="outline"
      onclick={onKeepCurrentPackage}
      disabled={!canKeepCurrentPackage || busy !== null}
    >
      {busy === 'keeping' ? 'Keeping Current…' : 'Keep Current'}
    </Button>
    {#if canCleanReset && !canUpdateAndRebuild}
      <Button variant="destructive" onclick={onRequestCleanReset} disabled={busy !== null}>
        {busy === 'resetting' ? 'Resetting…' : 'Reset Appearance and Update'}
      </Button>
    {/if}
  </div>
</section>

<style>
  .recipe-review-callout,
  .recipe-review-warning {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 0.65rem;
  }

  .recipe-review-callout.is-danger {
    border-color: var(--bs-settings-danger-line);
    background: var(--bs-settings-danger-bg);
  }

  .recipe-review-callout.is-warning {
    border-color: oklch(0.78 0.08 62 / 0.28);
  }

  .recipe-review-callout.is-success {
    border-color: var(--bs-app-success-line);
    background: var(--bs-app-success-bg);
  }

  .recipe-review-filters,
  .recipe-review-actions {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  :global(.recipe-review-technical-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    padding: 0.55rem 0;
  }

  .recipe-review-filters :global(.bs-button),
  .recipe-review-actions :global(.bs-button) {
    max-width: 100%;
    white-space: normal;
  }

  .recipe-review-list {
    overflow: hidden;
    border: 1px solid var(--bs-settings-line);
    border-radius: var(--bs-settings-radius-lg);
    background: var(--bs-settings-inset-surface);
  }

  .recipe-review-row + .recipe-review-row {
    border-top: 1px solid var(--bs-settings-inner-line);
  }

  :global(.recipe-review-row-trigger) {
    display: flex;
    width: 100%;
    min-width: 0;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding: 0.7rem 0.75rem;
    text-align: left;
  }

  :global(.recipe-review-row-trigger:focus-visible) {
    outline: 2px solid var(--bs-settings-primary-soft);
    outline-offset: -2px;
  }

  .recipe-review-row-copy {
    display: flex;
    min-width: 0;
    flex: 1 1 auto;
    flex-direction: column;
    gap: 0.2rem;
  }

  .recipe-review-row-meta {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 0.5rem;
  }

  .recipe-review-row-meta :global(svg) {
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .recipe-review-row-details {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.75rem;
    border-top: 1px solid var(--bs-settings-inner-line);
    padding: 0.75rem;
    overflow-wrap: anywhere;
  }

  .recipe-review-detail-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.6rem 1rem;
  }

  .recipe-review-detail-grid div {
    min-width: 0;
  }

  .recipe-review-detail-grid dt,
  .recipe-review-proof-meta {
    color: var(--bs-settings-muted-text);
    font-size: 0.68rem;
    line-height: 1.3;
  }

  .recipe-review-detail-grid dd {
    margin-top: 0.15rem;
    color: var(--bs-settings-label);
    font-family: var(--bs-font-mono, ui-monospace, monospace);
    font-size: 0.72rem;
    overflow-wrap: anywhere;
  }

  .recipe-review-proof-meta {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.2rem;
  }

  @media (max-width: 560px) {
    .recipe-review-detail-grid {
      grid-template-columns: 1fr;
    }

    :global(.recipe-review-row-trigger) {
      align-items: flex-start;
      flex-direction: column;
    }

    .recipe-review-row-meta {
      width: 100%;
      justify-content: space-between;
    }

    .recipe-review-actions :global(.bs-button) {
      width: 100%;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    .recipe-review-row-meta :global(svg) {
      transition: none;
    }
  }
</style>
