<script lang="ts">
  import RecipeBuildProgress from './RecipeBuildProgress.svelte'
  import RecipeConfirmationDialogs from './RecipeConfirmationDialogs.svelte'
  import RecipeDirtyGuardDialog from './RecipeDirtyGuardDialog.svelte'
  import RecipeLifecycleStatus from './RecipeLifecycleStatus.svelte'
  import RecipePreviewControls from './RecipePreviewControls.svelte'
  import RecipeUpdateReview from './RecipeUpdateReview.svelte'
  import type { RecipeWorkflowActions, RecipeWorkflowViewModel } from './types'

  type Props = {
    viewModel: RecipeWorkflowViewModel
    actions: RecipeWorkflowActions
  }

  let { viewModel, actions }: Props = $props()
</script>

<div class="recipe-workflow-panel">
  <RecipeLifecycleStatus
    recipeStatus={viewModel.lifecycle.recipeStatus}
    liveStatus={viewModel.lifecycle.liveStatus}
    preparationEligible={viewModel.lifecycle.preparationEligible}
    preparationFailure={viewModel.lifecycle.preparationFailure}
    dirtyDomains={viewModel.lifecycle.dirtyDomains}
    activeVersionAvailable={viewModel.lifecycle.activeVersionAvailable}
    recipeRevision={viewModel.lifecycle.recipeRevision}
    activeRevision={viewModel.lifecycle.activeRevision}
    lastFailureStage={viewModel.lifecycle.lastFailureStage}
    fileTechnicalDetails={viewModel.lifecycle.fileTechnicalDetails}
    busyAction={viewModel.lifecycle.busyAction}
    canFirstBake={viewModel.lifecycle.canFirstBake}
    canRebake={viewModel.lifecycle.canRebake}
    canAnalyzeUpdate={viewModel.lifecycle.canAnalyzeUpdate}
    canRestorePrevious={viewModel.lifecycle.canRestorePrevious}
    actionsLoading={viewModel.lifecycle.actionsLoading}
    actionsUnavailableReason={viewModel.lifecycle.actionsUnavailableReason}
    onFirstBake={actions.onFirstBake}
    onRebake={actions.onRebake}
    onAnalyzeUpdate={actions.onAnalyzeUpdate}
    onRequestRestorePrevious={actions.onRequestRestorePrevious}
  />

  {#if viewModel.report}
    <div class="recipe-workflow-section">
      <RecipeUpdateReview
        report={viewModel.report}
        classification={viewModel.review.classification}
        busy={viewModel.review.busy}
        canUpdateAndRebuild={viewModel.review.canUpdateAndRebuild}
        canKeepCurrentPackage={viewModel.review.canKeepCurrentPackage}
        canCleanReset={viewModel.review.canCleanReset}
        onUpdateAndRebuild={actions.onUpdateAndRebuild}
        onKeepCurrentPackage={actions.onKeepCurrentPackage}
        onRequestCleanReset={actions.onRequestCleanReset}
      />
    </div>

    <div class="recipe-workflow-section">
      <RecipePreviewControls
        view={viewModel.preview.side}
        authorizedControls={viewModel.preview.controls}
        disabled={viewModel.preview.disabled}
        onViewChange={actions.onPreviewSideChange}
        onControlChange={actions.onPreviewControlChange}
        onControlCommit={actions.onPreviewControlCommit}
        onResetControl={actions.onResetPreviewControl}
      />
    </div>
  {/if}

  {#if viewModel.build}
    <div class="recipe-workflow-section">
      <RecipeBuildProgress
        status={viewModel.build.status}
        initialPreparation={viewModel.build.initialPreparation}
        failureStage={viewModel.build.failureStage}
        failureReason={viewModel.build.failureReason}
        retryable={viewModel.build.retryable}
        cancelable={viewModel.build.cancelable}
        busyAction={viewModel.build.busyAction}
        onRetry={actions.onRetryJob}
        onDiscard={actions.onDiscardJob}
        onCancelBuild={actions.onCancelBuild}
      />
    </div>
  {/if}
</div>

<RecipeDirtyGuardDialog
  open={viewModel.dirtyGuard.open}
  busy={viewModel.dirtyGuard.busy}
  onCancel={actions.onCancelDirtyGuard}
  onSaveAndContinue={actions.onSaveAndAnalyze}
  onDiscardAndContinue={actions.onDiscardAndAnalyze}
/>

<RecipeConfirmationDialogs
  cleanResetOpen={viewModel.confirmations.cleanResetOpen}
  restoreOpen={viewModel.confirmations.restoreOpen}
  previousRevision={viewModel.confirmations.previousRevision}
  busy={viewModel.confirmations.busy}
  onCloseCleanReset={actions.onCloseCleanReset}
  onConfirmCleanReset={actions.onConfirmCleanReset}
  onCloseRestore={actions.onCloseRestorePrevious}
  onConfirmRestore={actions.onConfirmRestorePrevious}
/>

<style>
  .recipe-workflow-panel {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 1.15rem;
  }

  .recipe-workflow-section {
    min-width: 0;
    border-top: 1px solid var(--bs-settings-inner-line);
    padding-top: 1.15rem;
  }
</style>
