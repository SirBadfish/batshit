<script lang="ts">
  import { Ban, Check, ChevronDown, Loader2, RotateCcw, TriangleAlert, X } from '@lucide/svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import { Progress } from '$lib/components/ui/progress'
  import type { RecipeFailureStage, RecipeJobStatus } from '$lib/goons/recipe'

  const buildStages: RecipeJobStatus[] = [
    'validating',
    'planning',
    'baking',
    'packaging',
    'verifying',
    'ready',
    'committing'
  ]

  const exactStatusLabels: Record<RecipeJobStatus, string> = {
    validating: 'Validating',
    planning: 'Planning',
    baking: 'Baking',
    packaging: 'Packaging',
    verifying: 'Verifying',
    ready: 'Ready to commit',
    committing: 'Committing',
    committed: 'Committed',
    failed: 'Failed',
    interrupted: 'Interrupted',
    discarded: 'Discarded'
  }

  const failureStageLabels: Record<RecipeFailureStage, string> = {
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

  type Props = {
    status: RecipeJobStatus
    initialPreparation?: boolean
    failureStage?: RecipeFailureStage | null
    failureReason?: string | null
    retryable?: boolean
    resumable?: boolean
    cancelable?: boolean
    busyAction?: 'resuming' | 'retrying' | 'discarding' | 'canceling' | null
    onResume: () => void | Promise<void>
    onRetry: () => void | Promise<void>
    onDiscard: () => void | Promise<void>
    onCancelBuild?: () => void | Promise<void>
  }

  let {
    status,
    initialPreparation = false,
    failureStage = null,
    failureReason = null,
    retryable = false,
    resumable = false,
    cancelable = false,
    busyAction = null,
    onResume,
    onRetry,
    onDiscard,
    onCancelBuild
  }: Props = $props()

  let technicalOpen = $state(false)
  const stageIndex = $derived(buildStages.indexOf(status))
  const progressValue = $derived(
    status === 'committed'
      ? buildStages.length
      : stageIndex >= 0
        ? stageIndex + (status === 'ready' ? 1 : 0.35)
        : 0
  )
  const terminalProblem = $derived(status === 'failed' || status === 'interrupted')
  const readyCheckpoint = $derived(status === 'ready' && resumable)
  const updateInProgress = $derived(
    !terminalProblem && !readyCheckpoint && status !== 'committed' && status !== 'discarded'
  )
  const ordinaryStatus = $derived.by(() => {
    if (status === 'failed') return initialPreparation ? 'Preparation failed' : 'Update failed'
    if (status === 'interrupted') return initialPreparation ? 'Preparation interrupted' : 'Update interrupted'
    if (status === 'committed') return 'Ready'
    if (status === 'ready') return readyCheckpoint ? 'Ready to finish' : 'Applying'
    if (status === 'validating' || status === 'planning') return 'Checking'
    if (status === 'discarded') return 'Discarded'
    return initialPreparation ? 'Preparing' : 'Applying'
  })
  const exactStatus = $derived.by(() => {
    if ((status === 'failed' || status === 'interrupted') && failureStage) {
      return `${exactStatusLabels[status]} at ${failureStageLabels[failureStage]}`
    }
    return exactStatusLabels[status]
  })
</script>

<section class="recipe-build-progress space-y-3" aria-labelledby="goon-update-progress-title">
  <div class="flex min-w-0 flex-wrap items-center justify-between gap-2">
    <div class="min-w-0">
      <h3
        id="goon-update-progress-title"
        class="batshit-settings-section-title recipe-progress-title"
        role={updateInProgress ? 'status' : undefined}
        aria-label={updateInProgress
          ? initialPreparation ? 'Preparing Goon' : 'Updating Appearance'
          : undefined}
        aria-live={updateInProgress ? 'polite' : undefined}
      >
        {#if updateInProgress}
          <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
        {/if}
        {readyCheckpoint
          ? initialPreparation ? 'Goon Ready to Finish' : 'Appearance Update Ready'
          : initialPreparation ? 'Preparing Goon' : 'Updating Appearance'}
      </h3>
      <p class="batshit-settings-caption mt-1">
        {readyCheckpoint
          ? initialPreparation
            ? 'This Goon passed every build check but was not activated. Finish Update to make it available, or discard this unfinished candidate.'
            : 'This appearance passed every build check but was not applied. Finish Update to make it active, or discard this unfinished candidate.'
          : initialPreparation
          ? 'Batshit is preparing and checking this Goon. This can take a few seconds. It becomes available after every check passes.'
          : 'Batshit is preparing and checking this appearance. This can take a few seconds. Your current Goon stays usable until the update is ready.'}
      </p>
    </div>
    <Badge
      variant="outline"
      class={`batshit-settings-status-badge ${
        status === 'committed'
          ? 'is-success'
          : status === 'failed'
            ? 'is-danger'
            : status === 'interrupted'
              ? 'is-warning'
              : 'is-info'
      }`}
    >
      {ordinaryStatus}
    </Badge>
  </div>

  {#if terminalProblem}
    <div class="batshit-settings-muted-panel recipe-build-failure" role="alert">
      <TriangleAlert aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="batshit-settings-form-label is-danger">{ordinaryStatus}</div>
        {#if failureReason}
          <p class="batshit-settings-caption mt-1 break-words">{failureReason}</p>
        {/if}
        <p class="batshit-settings-caption mt-1">
          Retry continues from verified saved state. Discard removes only the unfinished candidate.
        </p>
      </div>
    </div>
  {/if}

  <Progress
    value={progressValue}
    max={buildStages.length}
    aria-label={`${initialPreparation ? 'Goon preparation' : 'Goon update'}: ${ordinaryStatus}`}
    aria-valuetext={ordinaryStatus}
  />

  <div class="recipe-build-actions" aria-label="Goon update actions">
    {#if readyCheckpoint}
      <Button onclick={onResume} disabled={busyAction !== null}>
        {#if busyAction === 'resuming'}
          <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
          Finishing…
        {:else}
          <Check aria-hidden="true" />
          Finish Update
        {/if}
      </Button>
      <Button variant="destructive" onclick={onDiscard} disabled={busyAction !== null}>
        <Ban aria-hidden="true" />
        {busyAction === 'discarding' ? 'Discarding…' : 'Discard'}
      </Button>
    {/if}
    {#if terminalProblem && retryable}
      <Button onclick={onRetry} disabled={busyAction !== null}>
        <RotateCcw aria-hidden="true" />
        {busyAction === 'retrying' ? 'Retrying…' : 'Retry'}
      </Button>
    {/if}
    {#if terminalProblem}
      <Button variant="destructive" onclick={onDiscard} disabled={busyAction !== null}>
        <Ban aria-hidden="true" />
        {busyAction === 'discarding' ? 'Discarding…' : 'Discard'}
      </Button>
    {/if}
    {#if cancelable && onCancelBuild && !terminalProblem}
      <Button variant="outline" onclick={onCancelBuild} disabled={busyAction !== null}>
        <X aria-hidden="true" />
        {busyAction === 'canceling' ? 'Canceling…' : 'Cancel Update'}
      </Button>
    {/if}
  </div>

  <Collapsible.Root open={technicalOpen}>
    <Collapsible.Trigger
      class="batshit-settings-collapsible-trigger recipe-technical-trigger"
      onclick={() => { technicalOpen = !technicalOpen }}
    >
      <span class="batshit-settings-child-label">Technical Details</span>
      <ChevronDown aria-hidden="true" class={technicalOpen ? 'rotate-180' : ''} />
    </Collapsible.Trigger>
    {#if technicalOpen}
      <div class="batshit-settings-muted-panel space-y-3">
        <p class="batshit-settings-code-caption">Exact internal stage: {exactStatus}</p>
        <ol class="recipe-build-stages" aria-label="Internal build stages">
          {#each buildStages as stage, index (stage)}
            <li
              class:current={stage === status}
              class:complete={stageIndex > index || status === 'committed'}
              aria-current={stage === status ? 'step' : undefined}
            >
              <span class="recipe-build-stage-marker" aria-hidden="true"></span>
              <span>{exactStatusLabels[stage]}</span>
            </li>
          {/each}
        </ol>
      </div>
    {/if}
  </Collapsible.Root>
</section>

<style>
  .recipe-build-stages {
    display: grid;
    grid-template-columns: repeat(7, minmax(0, 1fr));
    gap: 0.3rem;
    margin: 0;
    padding: 0;
    list-style: none;
  }

  .recipe-progress-title {
    display: inline-flex;
    align-items: center;
    gap: 0.45rem;
  }

  .recipe-progress-title :global(svg) {
    width: 0.95rem;
    height: 0.95rem;
    flex: none;
  }

  .recipe-build-stages li {
    display: flex;
    min-width: 0;
    flex-direction: column;
    align-items: center;
    gap: 0.3rem;
    color: var(--bs-settings-muted-text);
    font-size: 0.66rem;
    line-height: 1.2;
    text-align: center;
    overflow-wrap: anywhere;
  }

  .recipe-build-stage-marker {
    width: 100%;
    height: 0.22rem;
    border-radius: 999px;
    background: var(--bs-settings-inner-line);
  }

  .recipe-build-stages li.complete,
  .recipe-build-stages li.current { color: var(--bs-settings-label); }
  .recipe-build-stages li.complete .recipe-build-stage-marker { background: var(--bs-app-success-text); }
  .recipe-build-stages li.current .recipe-build-stage-marker { background: var(--bs-settings-primary); }

  .recipe-build-failure {
    display: flex;
    min-width: 0;
    align-items: flex-start;
    gap: 0.65rem;
    border-color: var(--bs-settings-danger-line);
    background: var(--bs-settings-danger-bg);
  }

  .recipe-build-actions {
    display: flex;
    min-width: 0;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  :global(.recipe-technical-trigger) {
    display: flex;
    width: 100%;
    align-items: center;
    justify-content: space-between;
    padding: 0.55rem 0;
  }

  @media (max-width: 640px) {
    .recipe-build-stages { grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 0.55rem; }
    .recipe-build-stages li { align-items: flex-start; text-align: left; }
    .recipe-build-actions :global(.bs-button) { width: 100%; }
  }
</style>
