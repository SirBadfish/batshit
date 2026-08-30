<script lang="ts">
  import { ChevronDown, FileUp, History, Loader2, RefreshCw, TriangleAlert } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import type {
    RecipeBuildDirtyDomain,
    RecipeFailureStage,
    RecipeLiveStatus
  } from '$lib/goons/recipe'
  import type {
    RecipeEditorStatus,
    RecipeFileTechnicalDetails,
    RecipeLifecycleBusyAction
  } from './types'

  type Props = {
    recipeStatus: RecipeEditorStatus
    liveStatus: RecipeLiveStatus | null
    preparationEligible?: boolean
    preparationFailure?: string | null
    dirtyDomains?: RecipeBuildDirtyDomain[]
    activeVersionAvailable?: boolean
    recipeRevision?: number | null
    activeRevision?: number | null
    lastFailureStage?: RecipeFailureStage | null
    fileTechnicalDetails?: RecipeFileTechnicalDetails | null
    busyAction?: RecipeLifecycleBusyAction
    canFirstBake?: boolean
    canRebake?: boolean
    canAnalyzeUpdate?: boolean
    canRestorePrevious?: boolean
    actionsLoading?: boolean
    actionsUnavailableReason?: string | null
    onFirstBake: () => void | Promise<void>
    onRebake: () => void | Promise<void>
    onAnalyzeUpdate: () => void | Promise<void>
    onRequestRestorePrevious: () => void
  }

  let {
    recipeStatus,
    liveStatus,
    preparationEligible = false,
    preparationFailure = null,
    dirtyDomains = [],
    activeVersionAvailable = false,
    recipeRevision = null,
    activeRevision = null,
    lastFailureStage = null,
    fileTechnicalDetails = null,
    busyAction = null,
    canFirstBake = false,
    canRebake = false,
    canAnalyzeUpdate = false,
    canRestorePrevious = false,
    actionsLoading = false,
    actionsUnavailableReason = null,
    onFirstBake,
    onRebake,
    onAnalyzeUpdate,
    onRequestRestorePrevious
  }: Props = $props()

  let technicalOpen = $state(false)

  const stageLabels: Record<RecipeFailureStage, string> = {
    upload: 'Upload',
    validating: 'Validating',
    planning: 'Planning',
    baking: 'Baking',
    packaging: 'Packaging',
    verifying: 'Verifying',
    'preview-load': 'Preview Load',
    committing: 'Committing',
    cleanup: 'Cleanup',
    restart: 'Restart Recovery'
  }

  const ordinaryStatus = $derived.by(() => {
    if (actionsLoading || (busyAction === 'first-bake' && !activeVersionAvailable)) return 'Preparing'
    if (preparationFailure || (actionsUnavailableReason && !activeVersionAvailable)) return 'Preparation failed'
    if (recipeStatus === 'reviewing' || busyAction === 'analyze') return 'Checking update'
    if (liveStatus === 'building' || busyAction === 'rebake') return 'Applying'
    if (liveStatus === 'failed') return activeVersionAvailable ? 'Update failed' : 'Preparation failed'
    if (liveStatus === 'interrupted') return activeVersionAvailable ? 'Update interrupted' : 'Preparation interrupted'
    if (recipeStatus === 'dirty' || liveStatus === 'needs_bake') return 'Appearance changes ready to save'
    if (activeVersionAvailable || liveStatus === 'up_to_date') return 'Ready'
    return preparationEligible ? 'Preparing' : 'File details available'
  })

  const ordinaryStatusClass = $derived(
    ordinaryStatus === 'Ready'
      ? 'is-success'
      : ordinaryStatus.includes('failed')
        ? 'is-danger'
        : ordinaryStatus.includes('interrupted') || ordinaryStatus.includes('ready to save')
          ? 'is-warning'
          : ordinaryStatus === 'Preparing' || ordinaryStatus === 'Checking update' || ordinaryStatus === 'Applying'
            ? 'is-info'
            : ''
  )
  const anyBusy = $derived(busyAction !== null)
  const exactFailure = $derived(
    lastFailureStage ? `${liveStatus ?? 'failure'} at ${stageLabels[lastFailureStage]}` : liveStatus
  )

  function actionLabel(action: Exclude<RecipeLifecycleBusyAction, null>, idle: string): string {
    return busyAction === action ? `${idle}…` : idle
  }
</script>

<section class="recipe-lifecycle space-y-3" aria-labelledby="goon-file-status-title">
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <div class="min-w-0">
      <h3 id="goon-file-status-title" class="batshit-settings-section-title">Goon File</h3>
      <p class="batshit-settings-caption mt-1">
        Batshit checks and applies appearance changes safely. The current Goon stays usable until an update succeeds.
      </p>
    </div>
    <Badge variant="outline" class={`batshit-settings-status-badge ${ordinaryStatusClass}`}>
      {ordinaryStatus}
    </Badge>
  </div>

  {#if preparationFailure || (actionsUnavailableReason && !activeVersionAvailable)}
    <div class="batshit-settings-muted-panel recipe-lifecycle-alert" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div class="min-w-0">
        <div class="batshit-settings-form-label is-danger">This Goon could not be prepared.</div>
        <p class="batshit-settings-caption mt-1 break-words">
          {preparationFailure ?? actionsUnavailableReason}
        </p>
      </div>
    </div>
  {:else if actionsLoading}
    <div class="batshit-settings-empty-state is-compact" role="status">
      <span class="inline-flex items-center gap-2">
        <Loader2 class="animate-spin" aria-hidden="true" /> Preparing Goon…
      </span>
    </div>
  {/if}

  <div class="recipe-lifecycle-actions" aria-label="Goon file actions">
    {#if canFirstBake}
      <Button onclick={onFirstBake} disabled={anyBusy}>
        <RefreshCw aria-hidden="true" />
        {actionLabel('first-bake', 'Retry Preparation')}
      </Button>
    {/if}
    {#if canRebake}
      <Button onclick={onRebake} disabled={anyBusy}>
        <RefreshCw aria-hidden="true" />
        {actionLabel('rebake', 'Update Goon')}
      </Button>
    {/if}
    {#if canAnalyzeUpdate}
      <Button variant="outline" onclick={onAnalyzeUpdate} disabled={anyBusy}>
        <FileUp aria-hidden="true" />
        {actionLabel('analyze', 'Update Goon File')}
      </Button>
    {/if}
    {#if canRestorePrevious}
      <Button variant="ghost" onclick={onRequestRestorePrevious} disabled={anyBusy}>
        <History aria-hidden="true" />
        {actionLabel('restore', 'Restore Previous Version')}
      </Button>
    {/if}
  </div>

  <div class:open={technicalOpen} class="recipe-technical-disclosure">
    <Collapsible.Root open={technicalOpen}>
      <Collapsible.Trigger
        class="batshit-settings-collapsible-trigger recipe-technical-trigger"
        onclick={() => { technicalOpen = !technicalOpen }}
      >
        <span class="batshit-settings-child-label">Technical Details</span>
        <ChevronDown
          aria-hidden="true"
          class={`recipe-technical-chevron ${technicalOpen ? 'rotate-180' : ''}`}
        />
      </Collapsible.Trigger>
      {#if technicalOpen}
        <div class="recipe-technical-details">
          {#if fileTechnicalDetails}
            <section class="recipe-technical-group" aria-labelledby="goon-file-identity-title">
              <h4 id="goon-file-identity-title" class="batshit-settings-child-label">File identity</h4>
              <dl>
                <div><dt>Package</dt><dd>{fileTechnicalDetails.packageLabel}</dd></div>
                <div><dt>Model</dt><dd>{fileTechnicalDetails.modelLabel}</dd></div>
                <div><dt>Manifest</dt><dd>{fileTechnicalDetails.manifestLabel}</dd></div>
                <div><dt>Contract version</dt><dd>{fileTechnicalDetails.contractVersion}</dd></div>
                {#if fileTechnicalDetails.manifestName}
                  <div><dt>Manifest name</dt><dd>{fileTechnicalDetails.manifestName}</dd></div>
                {/if}
              </dl>
            </section>
          {/if}

          <section class="recipe-technical-group" aria-labelledby="goon-lifecycle-details-title">
            <h4 id="goon-lifecycle-details-title" class="batshit-settings-child-label">Lifecycle</h4>
            <dl>
              <div><dt>Recipe state</dt><dd>{recipeStatus}</dd></div>
              <div><dt>Live Goon state</dt><dd>{liveStatus ?? 'not initialized'}</dd></div>
              <div><dt>Recipe revision</dt><dd>{recipeRevision ?? 'none'}</dd></div>
              <div><dt>Active Live revision</dt><dd>{activeRevision ?? 'none'}</dd></div>
              <div><dt>Dirty domains</dt><dd>{dirtyDomains.length > 0 ? dirtyDomains.join(', ') : 'none'}</dd></div>
              {#if exactFailure}
                <div><dt>Last failure</dt><dd>{exactFailure}</dd></div>
              {/if}
            </dl>
          </section>
        </div>
      {/if}
    </Collapsible.Root>
  </div>
</section>

<style>
  .recipe-lifecycle-actions {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .recipe-lifecycle-actions :global(.bs-button) {
    max-width: 100%;
    white-space: normal;
    text-align: center;
  }

  .recipe-lifecycle-alert {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 0.65rem;
    border-color: var(--bs-settings-danger-line);
    background: var(--bs-settings-danger-bg);
  }

  .recipe-technical-disclosure {
    overflow: hidden;
    border: 1px solid var(--bs-settings-inner-line);
    border-radius: 0.65rem;
    background: var(--bs-settings-inset-surface);
  }

  .recipe-technical-disclosure.open {
    border-color: var(--bs-settings-line);
  }

  :global(.recipe-technical-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    padding: 0.7rem 0.8rem;
  }

  .recipe-technical-disclosure.open :global(.recipe-technical-trigger) {
    border-bottom: 1px solid var(--bs-settings-inner-line);
  }

  :global(.recipe-technical-chevron) {
    width: 0.9rem;
    height: 0.9rem;
    flex: none;
    transition: transform 180ms cubic-bezier(0.22, 1, 0.36, 1);
  }

  .recipe-technical-details {
    display: grid;
    gap: 1rem;
    padding: 0.8rem;
  }

  .recipe-technical-group {
    display: grid;
    min-width: 0;
    gap: 0.55rem;
  }

  .recipe-technical-group + .recipe-technical-group {
    border-top: 1px solid var(--bs-settings-inner-line);
    padding-top: 0.8rem;
  }

  .recipe-technical-details dl {
    display: grid;
    gap: 0.4rem;
  }

  .recipe-technical-details dl > div {
    display: grid;
    grid-template-columns: minmax(7rem, 0.45fr) minmax(0, 1fr);
    gap: 0.75rem;
  }

  .recipe-technical-details dt {
    color: var(--bs-settings-muted-text);
    font-size: 0.7rem;
    line-height: 1.35;
  }

  .recipe-technical-details dd {
    min-width: 0;
    overflow-wrap: anywhere;
    color: var(--bs-settings-label);
    font-family: var(--font-mono, ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace);
    font-size: 0.68rem;
    line-height: 1.4;
  }

  @media (max-width: 640px) {
    .recipe-technical-details dl > div {
      grid-template-columns: minmax(0, 1fr);
      gap: 0.15rem;
    }
  }

  @media (prefers-reduced-motion: reduce) {
    :global(.recipe-technical-chevron) { transition: none; }
  }
</style>
