import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RECIPE_MIGRATION_REPORT_CONTRACT,
  RECIPE_STRICT_TOLERANCE_PROFILE,
  planAppearanceRecipeMigration,
  type RecipeMigrationReport,
  type RecipeMigrationReportEntry,
  type RecipeStateSnapshot
} from '$lib/goons/recipe'
import type { GoonOperationState } from '../GoonOperationOverlay.svelte'
import RecipeBuildProgress from './RecipeBuildProgress.svelte'
import RecipeConfirmationDialogs from './RecipeConfirmationDialogs.svelte'
import RecipeDirtyGuardDialog from './RecipeDirtyGuardDialog.svelte'
import RecipeLifecycleStatus from './RecipeLifecycleStatus.svelte'
import RecipePreviewControls from './RecipePreviewControls.svelte'
import RecipeUpdateReview from './RecipeUpdateReview.svelte'
import RecipeWorkflowPanel from './RecipeWorkflowPanel.svelte'
import RecipeWorkflowControllerHarness from './RecipeWorkflowControllerHarness.test.svelte'
import { createRecipePhysicalMigrationFixture } from '$lib/goons/recipe/fixtures/recipePhysicalMigrationPair'
import type { GoonRecord } from '$lib/types/goons'
import { HAIR_STATE_CONTRACT, createHairState, parseHairState } from '$lib/goons/hairAssets'
import type {
  RecipeAuthorizedPreviewControl,
  RecipeWorkflowActions,
  RecipeWorkflowViewModel
} from './types'

const recipeServiceMocks = vi.hoisted(() => ({
  uploadCustomGoonPackage: vi.fn(),
  loadGoons: vi.fn(),
  loadCustomAvatarManifest: vi.fn(),
  computeAnatomyFitRecipeSiblingInWorker: vi.fn(),
  workflowClient: null as Record<string, any> | null
}))

vi.mock('$lib/goons/recipe', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/goons/recipe')>()
  return {
    ...actual,
    createRecipeWorkflowClient: vi.fn((...args: Parameters<typeof actual.createRecipeWorkflowClient>) =>
      recipeServiceMocks.workflowClient ?? actual.createRecipeWorkflowClient(...args)
    ),
    computeAnatomyFitRecipeSiblingInWorker: (...args: Parameters<typeof actual.computeAnatomyFitRecipeSiblingInWorker>) =>
      recipeServiceMocks.computeAnatomyFitRecipeSiblingInWorker.getMockImplementation()
        ? recipeServiceMocks.computeAnatomyFitRecipeSiblingInWorker(...args)
        : actual.computeAnatomyFitRecipeSiblingInWorker(...args)
  }
})

vi.mock('$lib/goons/customAvatar', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/goons/customAvatar')>()
  return {
    ...actual,
    loadCustomAvatarManifest: (...args: Parameters<typeof actual.loadCustomAvatarManifest>) =>
      recipeServiceMocks.loadCustomAvatarManifest.getMockImplementation()
        ? recipeServiceMocks.loadCustomAvatarManifest(...args)
        : actual.loadCustomAvatarManifest(...args)
  }
})

vi.mock('$lib/services/goons', async (importOriginal) => {
  const actual = await importOriginal<typeof import('$lib/services/goons')>()
  return {
    ...actual,
    uploadCustomGoonPackage: recipeServiceMocks.uploadCustomGoonPackage,
    loadGoons: (...args: Parameters<typeof actual.loadGoons>) =>
      recipeServiceMocks.loadGoons(...args)
  }
})

if (typeof globalThis.ResizeObserver === 'undefined') {
  Object.defineProperty(globalThis, 'ResizeObserver', {
    configurable: true,
    value: class ResizeObserverStub {
      observe() {}
      unobserve() {}
      disconnect() {}
    }
  })
}

afterEach(() => {
  recipeServiceMocks.uploadCustomGoonPackage.mockReset()
  recipeServiceMocks.loadGoons.mockReset()
  recipeServiceMocks.loadCustomAvatarManifest.mockReset()
  recipeServiceMocks.computeAnatomyFitRecipeSiblingInWorker.mockReset()
  recipeServiceMocks.workflowClient = null
})

const HASH = 'a'.repeat(64)

function entry(
  id: string,
  classification: RecipeMigrationReportEntry['classification'],
  overrides: Partial<RecipeMigrationReportEntry> = {}
): RecipeMigrationReportEntry {
  return {
    id,
    classification,
    componentId: `component.${id}`,
    oldValue: 0.25,
    proposedValue: 0.5,
    reason: `${id} has a deliberately long, plain-language migration reason.`,
    proofStatus: 'verified',
    maximumError: 1e-9,
    tolerance: 1e-6,
    proofSha256: HASH,
    requiresPreview: false,
    requiresConfirmation: false,
    ...overrides
  }
}

function report(overrides: Partial<RecipeMigrationReport> = {}): RecipeMigrationReport {
  return {
    contract: RECIPE_MIGRATION_REPORT_CONTRACT,
    reportId: 'report.recipe-update',
    directEdgeKey: 'recipe-update-edge:source:target',
    edgeSha256: HASH,
    fromRecipeRevision: 2,
    toRecipeRevision: 3,
    status: 'preserved',
    entries: [
      entry('waist_width', 'remapped'),
      entry('new_eye_fit', 'new', { oldValue: null, proposedValue: 0 }),
      entry('retired_chin', 'removed', { proposedValue: null }),
      entry('jaw_shape', 'reset-required', {
        proposedValue: 0,
        proofStatus: 'not-preserved',
        requiresPreview: true,
        requiresConfirmation: true
      })
    ],
    warnings: [],
    proof: {
      toleranceProfile: RECIPE_STRICT_TOLERANCE_PROFILE,
      wholeRecipeMaximumError: 1e-9,
      wholeRecipeRmsError: 1e-10,
      wholeRecipeTolerance: 1e-6,
      wholeRecipeProofSha256: HASH,
      reportSha256: HASH
    },
    ...overrides
  }
}

function operationLifecycleGoons(state: RecipeStateSnapshot) {
  const committed = {
    id: 'recipe-operation-goon',
    user_id: 'recipe-operation-user',
    name: 'Operation Goon',
    kind: 'custom',
    sourceProfile: 'expert-custom-glb',
    files: {},
    recipe: {
      contract: 'goon-recipe/v2',
      writeVersion: 2,
      nextRecipeRevision: 3,
      liveStatus: 'up_to_date',
      authoringRevision: { recipeRevision: 2, state },
      activeRevision: { ref: 'active-2' },
      previousRevision: { ref: 'active-1' },
      pendingAnalysis: null,
      pendingJob: null,
      lastFailure: null
    },
    appearanceDials: state.appearanceDials,
    created_at: '2026-09-20T00:00:00.000Z',
    updated_at: '2026-09-20T00:00:00.000Z'
  } as unknown as GoonRecord
  const starting = {
    ...structuredClone(committed),
    recipe: {
      ...structuredClone(committed.recipe),
      writeVersion: 1,
      nextRecipeRevision: 2,
      liveStatus: 'needs_bake',
      authoringRevision: { recipeRevision: 1, state },
      activeRevision: { ref: 'active-1' },
      previousRevision: null
    }
  } as unknown as GoonRecord
  return { starting, committed }
}

describe('Recipe R5 Settings components', () => {
  it('exposes one controller-owned workflow entry surface', () => {
    const viewModel: RecipeWorkflowViewModel = {
      lifecycle: {
        recipeStatus: 'ready',
        liveStatus: 'up_to_date',
        recipeRevision: 5,
        activeRevision: 5,
        activeVersionAvailable: true,
        canAnalyzeUpdate: true,
        fileTechnicalDetails: {
          packageLabel: 'package-sha',
          modelLabel: 'model-sha',
          manifestLabel: 'manifest-sha',
          contractVersion: 2,
          manifestName: 'Batshit Base F v1'
        }
      },
      report: null,
      review: {},
      preview: { side: 'current', controls: [] },
      build: null,
      dirtyGuard: { open: false },
      confirmations: { cleanResetOpen: false, restoreOpen: false }
    }
    const noop = vi.fn()
    const actions: RecipeWorkflowActions = {
      onFirstBake: noop,
      onRebake: noop,
      onAnalyzeUpdate: noop,
      onRequestRestorePrevious: noop,
      onCancelDirtyGuard: noop,
      onSaveAndAnalyze: noop,
      onDiscardAndAnalyze: noop,
      onUpdateAndRebuild: noop,
      onKeepCurrentPackage: noop,
      onRequestCleanReset: noop,
      onPreviewSideChange: noop,
      onPreviewControlChange: noop,
      onResumeReadyJob: noop,
      onRetryJob: noop,
      onDiscardJob: noop,
      onCloseCleanReset: noop,
      onConfirmCleanReset: noop,
      onCloseRestorePrevious: noop,
      onConfirmRestorePrevious: noop
    }

    render(RecipeWorkflowPanel, { viewModel, actions })
    expect(screen.getByText('Ready')).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update Goon File' })).toBeTruthy()
    expect(screen.queryByRole('button', { name: /Bake|Rebuild/ })).toBeNull()
    expect(screen.queryByText(/Recipe revision/)).toBeNull()
    expect(screen.getAllByRole('button', { name: 'Technical Details' })).toHaveLength(1)
  })

  it('presents plain preparation, file-update, and restore actions with internal truth under Technical Details', async () => {
    const onFirstBake = vi.fn()
    const onAnalyzeUpdate = vi.fn()
    const onRestore = vi.fn()

    render(RecipeLifecycleStatus, {
      recipeStatus: 'ready',
      liveStatus: null,
      preparationEligible: true,
      preparationFailure: 'Preparation stopped before verification.',
      recipeRevision: 4,
      activeRevision: null,
      fileTechnicalDetails: {
        packageLabel: '9d3d7f10',
        modelLabel: 'e9373d07',
        manifestLabel: '4ccaa109',
        contractVersion: 2,
        manifestName: 'Batshit Base F v1'
      },
      canFirstBake: true,
      canAnalyzeUpdate: true,
      canRestorePrevious: true,
      onFirstBake,
      onRebake: vi.fn(),
      onAnalyzeUpdate,
      onRequestRestorePrevious: onRestore
    })

    expect(screen.getByText('Preparation failed')).toBeTruthy()
    expect(screen.queryByText('Recipe ready')).toBeNull()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry Preparation' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Update Goon File' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Restore Previous Version' }))

    await fireEvent.click(screen.getByRole('button', { name: 'Technical Details' }))
    expect(screen.getByText('File identity')).toBeTruthy()
    expect(screen.getByText('9d3d7f10')).toBeTruthy()
    expect(screen.getByText('Batshit Base F v1')).toBeTruthy()
    expect(screen.getByText('Lifecycle')).toBeTruthy()
    expect(screen.getByText('Recipe state')).toBeTruthy()
    expect(screen.getByText('Recipe revision')).toBeTruthy()

    expect(onFirstBake).toHaveBeenCalledOnce()
    expect(onAnalyzeUpdate).toHaveBeenCalledOnce()
    expect(onRestore).toHaveBeenCalledOnce()
  })

  it('makes a longer appearance save visibly active in ordinary language', () => {
    render(RecipeBuildProgress, {
      status: 'baking',
      onResume: vi.fn(),
      onRetry: vi.fn(),
      onDiscard: vi.fn()
    })

    const activeStatus = screen.getByRole('status', { name: 'Updating Appearance' })
    expect(activeStatus.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.getByText(/This can take a few seconds/)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Applying')
  })

  it('turns a recovered ready candidate into explicit finish or discard actions', async () => {
    const onResume = vi.fn()
    const onDiscard = vi.fn()

    render(RecipeBuildProgress, {
      status: 'ready',
      resumable: true,
      onResume,
      onRetry: vi.fn(),
      onDiscard
    })

    expect(screen.queryByRole('status', { name: 'Updating Appearance' })).toBeNull()
    expect(screen.getByText('Appearance Update Ready')).toBeTruthy()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Ready to finish')
    await fireEvent.click(screen.getByRole('button', { name: 'Finish Update' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onResume).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()
  })

  it('finishes an exact ready checkpoint recovered after reload', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const pendingJob = {
      jobId: 'recipe-ready-after-reload-job',
      jobRef: 'recipe:job:recipe-ready-after-reload-job',
      status: 'ready',
      operation: 'rebake',
      targetWriteVersion: 2,
      targetRecipeRevision: 2,
      targetRevisionId: 'recipe-ready-after-reload-revision'
    }
    const readyGoon = {
      id: 'recipe-ready-after-reload-goon',
      user_id: 'recipe-ready-after-reload-user',
      name: 'Ready After Reload',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 2,
        nextRecipeRevision: 3,
        liveStatus: 'building',
        authoringRevision: { recipeRevision: 2, state: fixture.sourceState },
        activeRevision: { ref: 'active-1' },
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-08-04T00:00:00.000Z',
      updated_at: '2026-08-04T00:00:00.000Z'
    } as unknown as GoonRecord
    const committedGoon = {
      ...structuredClone(readyGoon),
      recipe: {
        ...structuredClone(readyGoon.recipe),
        writeVersion: 3,
        liveStatus: 'up_to_date',
        activeRevision: { ref: 'active-2' },
        previousRevision: { ref: 'active-1' },
        pendingJob: null
      }
    } as unknown as GoonRecord
    const job = {
      jobId: pendingJob.jobId,
      status: 'ready',
      operation: 'rebake'
    }
    const recovery = {
      goon: readyGoon,
      owner: readyGoon.recipe,
      job,
      reviewedState: { state: fixture.sourceState },
      candidate: { ref: 'candidate-2' },
      recovered: false
    }
    const recoverJob = vi.fn(async () => recovery)
    const resumeReadyCandidate = vi.fn(async () => ({ goon: committedGoon }))
    recipeServiceMocks.workflowClient = { recoverJob, resumeReadyCandidate }
    recipeServiceMocks.loadGoons.mockResolvedValue([committedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon: readyGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials)
    })

    await waitFor(() => expect(screen.getByText('Appearance Update Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Finish Update' }))
    await waitFor(() => expect(resumeReadyCandidate).toHaveBeenCalledOnce())
    expect(recoverJob).toHaveBeenCalledWith(pendingJob.jobId)
    await waitFor(() => expect(recipeServiceMocks.loadGoons).toHaveBeenCalled())
  })

  it('shows the real Recipe preparation failure instead of an unexplained empty action state', () => {
    render(RecipeLifecycleStatus, {
      recipeStatus: 'not-initialized',
      liveStatus: null,
      actionsUnavailableReason: 'Failed to load Custom avatar manifest (403).',
      onFirstBake: vi.fn(),
      onRebake: vi.fn(),
      onAnalyzeUpdate: vi.fn(),
      onRequestRestorePrevious: vi.fn()
    })

    expect(screen.getByRole('alert')).toHaveTextContent(
      'This Goon could not be prepared. Failed to load Custom avatar manifest (403).'
    )
    expect(screen.queryByText('No Recipe actions are available.')).toBeNull()
  })

  it('shows the exact failed stage and exposes idempotent recovery actions', async () => {
    const onRetry = vi.fn()
    const onDiscard = vi.fn()

    const view = render(RecipeBuildProgress, {
      status: 'failed',
      failureStage: 'preview-load',
      failureReason: 'The verified candidate could not load in the preview engine.',
      retryable: true,
      onResume: vi.fn(),
      onRetry,
      onDiscard
    })

    expect(screen.getAllByText('Update failed').length).toBeGreaterThan(0)
    expect(screen.getByRole('progressbar').getAttribute('aria-valuetext')).toBe(
      'Update failed'
    )
    await fireEvent.click(screen.getByRole('button', { name: 'Technical Details' }))
    expect(screen.getByText('Exact internal stage: Failed at Preview Load')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(onRetry).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()

    await view.rerender({
      status: 'interrupted',
      failureStage: 'restart',
      failureReason: 'Batshit restarted during the build.',
      retryable: true,
      onRetry,
      onDiscard
    })
    expect(screen.getAllByText('Update interrupted').length).toBeGreaterThan(0)
    expect(screen.getByText('Exact internal stage: Interrupted at Restart Recovery')).toBeTruthy()
  })

  it('gates appearance-preserving wording on complete proof and filters categorized rows', async () => {
    const view = render(RecipeUpdateReview, {
      report: report(),
      filter: 'all',
      canUpdateAndRebuild: true,
      canKeepCurrentPackage: true,
      onUpdateAndRebuild: vi.fn(),
      onKeepCurrentPackage: vi.fn(),
      onRequestCleanReset: vi.fn()
    })

    expect(screen.getByText('Your confirmation is required')).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Technical Details' }))
    expect(screen.getByText('appearance-preserving conversion verified')).toBeTruthy()
    expect(screen.getByRole('button', { name: /Remapped 1/ })).toBeTruthy()
    expect(screen.getByRole('button', { name: /Reset required 1/ })).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: /Reset required 1/ }))
    expect(screen.getByText('jaw_shape')).toBeTruthy()
    expect(screen.queryByText('waist_width')).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: /jaw_shape/ }))
    expect(screen.getByText('Current value')).toBeTruthy()
    expect(screen.getByText('jaw_shape has a deliberately long, plain-language migration reason.')).toBeTruthy()

    await view.rerender({
      report: report({
        status: 'preview-required',
        entries: [
          entry('waist_width', 'remapped', {
            requiresPreview: true,
            requiresConfirmation: true
          })
        ]
      }),
      classification: 'verified-preview-required',
      filter: 'all',
      canUpdateAndRebuild: true,
      canKeepCurrentPackage: true,
      onUpdateAndRebuild: vi.fn(),
      onKeepCurrentPackage: vi.fn(),
      onRequestCleanReset: vi.fn()
    })
    expect(screen.queryByText('Your appearance can be preserved')).toBeNull()
    expect(screen.getByText('Your confirmation is required')).toBeTruthy()
    expect(
      screen.getByText(
        'Compare Current and Updated, then approve the verified presentation change.'
      )
    ).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Update Goon' })).toBeTruthy()
  })

  it('renders Updated adjustments only from the server-verified new/reset allowlist', async () => {
    const onViewChange = vi.fn()
    const onResetControl = vi.fn()
    const onControlCommit = vi.fn()
    const verified: RecipeAuthorizedPreviewControl = {
      authorization: 'server-verified',
      id: 'new_nose_width',
      label: 'New Nose Width',
      description: 'Adjust only the verified Updated candidate.',
      classification: 'new',
      minimum: -1,
      maximum: 1,
      step: 0.01,
      neutralValue: 0,
      value: 0.4,
      reason: 'This control is new and starts at exact neutral.'
    }
    const unverified = {
      ...verified,
      authorization: 'package-metadata',
      id: 'unverified_control',
      label: 'Unverified Control'
    } as unknown as RecipeAuthorizedPreviewControl

    const view = render(RecipePreviewControls, {
      view: 'current',
      authorizedControls: [verified, unverified],
      onViewChange,
      onControlChange: vi.fn(),
      onControlCommit,
      onResetControl
    })

    await fireEvent.click(screen.getByRole('button', { name: 'Updated' }))
    expect(onViewChange).toHaveBeenCalledWith('updated')

    await view.rerender({
      view: 'updated',
      authorizedControls: [verified, unverified],
      onViewChange,
      onControlChange: vi.fn(),
      onControlCommit,
      onResetControl
    })
    expect(screen.getByText('New Nose Width')).toBeTruthy()
    expect(screen.queryByText('Unverified Control')).toBeNull()
    const slider = screen.getByRole('slider', { name: 'New Nose Width, Updated preview' })
    expect(slider).toBeTruthy()
    await fireEvent.keyDown(slider, { key: 'ArrowRight' })
    await fireEvent.keyUp(slider, { key: 'ArrowRight' })
    expect(onControlCommit).toHaveBeenCalledTimes(1)
    await fireEvent.click(screen.getByRole('button', { name: 'Reset New Nose Width to neutral' }))
    expect(onResetControl).toHaveBeenCalledWith('new_nose_width')
  })

  it('opens and preserves the Updated preview while a reviewed package update starts', async () => {
    const fixture = await createRecipePhysicalMigrationFixture({
      baseId: 'batshit-base-f-v1',
      fitFamily: 'batshit-base-f-v1'
    })
    const plan = await planAppearanceRecipeMigration({
      planId: 'migration.recipe-settings.updated-preview',
      fromRecipeRevision: 1,
      toRecipeRevision: 2,
      edge: fixture.edge,
      sourceState: fixture.sourceState,
      sourcePackage: {
        recipeSource: fixture.source.recipeSource,
        packageBytes: fixture.source.packageBytes,
        glbBytes: fixture.source.glbBytes,
        manifestBytes: fixture.source.manifestBytes
      },
      targetPackage: {
        recipeSource: fixture.target.recipeSource,
        packageBytes: fixture.target.packageBytes,
        glbBytes: fixture.target.glbBytes,
        manifestBytes: fixture.target.manifestBytes
      },
      siblingInputs: fixture.siblingInputs,
      componentMapBundle: fixture.componentMapBundle
    })
    const pendingAnalysis = {
      analysisId: 'recipe_analysis_updated_preview',
      analysisRef: { contract: 'recipe-update-analysis-context/v3', ref: 'analysis', sha256: HASH },
      basePlan: { contract: 'recipe-migration-plan/v1', ref: 'base-plan', sha256: HASH },
      selectedPlan: { contract: 'recipe-migration-plan/v1', ref: 'plan', sha256: HASH },
      migrationReport: { contract: 'recipe-migration-report/v1', ref: 'report', sha256: HASH },
      containmentReceipt: {
        contract: 'recipe-archive-containment-receipt/v1',
        ref: 'receipt',
        sha256: HASH
      },
      reviewedState: null,
      targetWriteVersion: 1
    }
    const owner = {
      contract: 'goon-recipe/v2',
      writeVersion: 1,
      nextRecipeRevision: 2,
      liveStatus: 'up_to_date',
      authoringRevision: {
        recipeRevision: 1,
        revisionId: 'recipe_revision_1_updated_preview',
        source: fixture.source.recipeSource,
        state: fixture.sourceState,
        updateReport: null
      },
      activeRevision: { ref: 'active-1' },
      previousRevision: null,
      pendingAnalysis,
      pendingJob: null,
      lastFailure: null
    }
    const goon = {
      id: 'recipe-updated-preview-goon',
      user_id: 'recipe-updated-preview-user',
      name: 'Updated Preview Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: owner,
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-08-20T00:00:00.000Z',
      updated_at: '2026-08-20T00:00:00.000Z'
    } as unknown as GoonRecord
    const hydration = {
      goon,
      owner,
      pendingAnalysis,
      plan,
      basePlan: plan,
      report: report({
        fromRecipeRevision: plan.fromRecipeRevision,
        toRecipeRevision: plan.toRecipeRevision,
        status: plan.outcome.readiness === 'preview-required' ? 'preview-required' : 'preserved'
      }),
      receipt: {},
      reviewedState: null
    }
    let rejectBuild: ((reason?: unknown) => void) | null = null
    const reviewedOwner = {
      ...structuredClone(owner),
      writeVersion: 2,
      pendingAnalysis: {
        ...structuredClone(pendingAnalysis),
        targetWriteVersion: 2
      }
    }
    const reviewedGoon = {
      ...structuredClone(goon),
      recipe: reviewedOwner
    } as unknown as GoonRecord
    const reviewedHydration = {
      ...hydration,
      goon: reviewedGoon,
      owner: reviewedOwner,
      pendingAnalysis: reviewedOwner.pendingAnalysis
    }
    const reviewAnalysisState = vi.fn(async () => reviewedHydration)
    const buildUploadStageCommit = vi.fn(
      () => new Promise<never>((_resolve, reject) => { rejectBuild = reject })
    )
    recipeServiceMocks.workflowClient = {
      hydrateAnalysis: vi.fn(async () => hydration),
      loadAnalysisTargetManifest: vi.fn(async () => fixture.target.avatarManifest),
      reviewAnalysisState,
      buildUploadStageCommit
    }
    recipeServiceMocks.loadGoons.mockResolvedValue([reviewedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials)
    })

    await waitFor(() => {
      expect(screen.getByTestId('recipe-preview-side')).toHaveTextContent('updated')
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Update Goon' }))
    await waitFor(() => expect(reviewAnalysisState).toHaveBeenCalledOnce())
    expect(screen.getByTestId('recipe-preview-side')).toHaveTextContent('updated')
    await waitFor(() => expect(buildUploadStageCommit).toHaveBeenCalledOnce())
    expect(rejectBuild).not.toBeNull()
    rejectBuild!(new Error('stop after the reviewed preview assertion'))
    await waitFor(() => expect(recipeServiceMocks.loadGoons).toHaveBeenCalled())
  })

  it('protects dirty edits with Save, Discard, and Cancel choices', async () => {
    const onCancel = vi.fn()
    const onSave = vi.fn()
    const onDiscard = vi.fn()

    render(RecipeDirtyGuardDialog, {
      open: true,
      onCancel,
      onSaveAndContinue: onSave,
      onDiscardAndContinue: onDiscard
    })

    expect(screen.getByRole('dialog', { name: 'Save appearance changes before updating the Goon file?' })).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Save & Continue' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Discard & Continue' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
    expect(onSave).toHaveBeenCalledOnce()
    expect(onDiscard).toHaveBeenCalledOnce()
    expect(onCancel).toHaveBeenCalledOnce()
  })

  it('reacts to nested Recipe dial edits before opening package analysis', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const goon = {
      id: 'recipe-dirty-guard-goon',
      user_id: 'recipe-dirty-guard-user',
      name: 'Recipe Dirty Guard',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 1,
        nextRecipeRevision: 2,
        liveStatus: 'up_to_date',
        authoringRevision: {
          recipeRevision: 1,
          state: fixture.sourceState
        },
        activeRevision: { ref: 'active' },
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob: null,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    } as unknown as GoonRecord

    render(RecipeWorkflowControllerHarness, {
      goon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials)
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Mutate nested Recipe dial' }))
    await waitFor(() => expect(screen.getByText('Appearance changes ready to save')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Update Goon File' }))

    expect(screen.getByRole('dialog', { name: 'Save appearance changes before updating the Goon file?' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Save & Continue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Discard & Continue' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeTruthy()

    await fireEvent.click(screen.getByRole('button', { name: 'Discard & Continue' }))
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: 'Save appearance changes before updating the Goon file?' })).toBeNull()
      expect(screen.getByText('Appearance changes ready to save')).toBeTruthy()
    })
  })

  it('coalesces a complete saved appearance batch into exactly one verified update workflow', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const committedGoon = {
      id: 'recipe-one-save-goon',
      user_id: 'recipe-one-save-user',
      name: 'One Save Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 2,
        nextRecipeRevision: 3,
        liveStatus: 'up_to_date',
        authoringRevision: { recipeRevision: 2, state: fixture.sourceState },
        activeRevision: { ref: 'active-2' },
        previousRevision: { ref: 'active-1' },
        pendingAnalysis: null,
        pendingJob: null,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    } as unknown as GoonRecord
    const startingGoon = {
      ...structuredClone(committedGoon),
      recipe: {
        ...structuredClone(committedGoon.recipe),
        writeVersion: 1,
        nextRecipeRevision: 2,
        authoringRevision: { recipeRevision: 1, state: fixture.sourceState },
        activeRevision: { ref: 'active-1' },
        previousRevision: null
      }
    } as unknown as GoonRecord
    const buildUploadStageCommit = vi.fn(async () => ({
      committed: { goon: committedGoon }
    }))
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    recipeServiceMocks.loadGoons.mockResolvedValue([committedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon: startingGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials)
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Mutate nested Recipe dial' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Mutate nested Recipe dial' }))
    // Save immediately, before the asynchronous dirty-preview hash is allowed
    // to settle. The Save boundary itself must classify the current batch.
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    expect(buildUploadStageCommit).toHaveBeenCalledOnce()
    expect(buildUploadStageCommit.mock.calls[0]?.[0]?.start.kind).toBe('bake')
  })

  it('includes a newly selected Hair revision in the exact Recipe state built by Save Goon', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const noneState = createHairState(null)
    const selectedState = parseHairState({
      schemaVersion: HAIR_STATE_CONTRACT,
      definitionSha256: HASH,
      selected: {
        assetId: 'style-01',
        assetRevisionId: 'style-01-r1',
        assetRevision: 1,
        assetRevisionSha256: HASH,
        fitFamily: 'batshit-base-f.v1',
        fitSha256: HASH
      },
      baseColor: '#2a1738',
      highlightColor: '#6f4a8e',
      motionSettings: {
        enabled: true,
        intensity: 1.1
      }
    })
    const committedGoon = {
      id: 'recipe-hair-save-goon',
      user_id: 'recipe-hair-save-user',
      name: 'Hair Save Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      hairState: selectedState,
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 2,
        nextRecipeRevision: 3,
        liveStatus: 'up_to_date',
        authoringRevision: { recipeRevision: 2, state: fixture.sourceState },
        activeRevision: { ref: 'active-2' },
        previousRevision: { ref: 'active-1' },
        pendingAnalysis: null,
        pendingJob: null,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-08-08T00:00:00.000Z',
      updated_at: '2026-08-08T00:00:00.000Z'
    } as unknown as GoonRecord
    const startingGoon = {
      ...structuredClone(committedGoon),
      hairState: noneState,
      recipe: {
        ...structuredClone(committedGoon.recipe),
        writeVersion: 1,
        nextRecipeRevision: 2,
        authoringRevision: { recipeRevision: 1, state: fixture.sourceState },
        activeRevision: { ref: 'active-1' },
        previousRevision: null
      }
    } as unknown as GoonRecord
    const buildUploadStageCommit = vi.fn(async () => ({
      committed: { goon: committedGoon }
    }))
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    recipeServiceMocks.loadGoons.mockResolvedValue([committedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon: startingGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      hairState: noneState,
      nextHairState: selectedState
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Select Hair style' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    expect(buildUploadStageCommit).toHaveBeenCalledOnce()
    const requestedState = buildUploadStageCommit.mock.calls[0]?.[0]?.start.request.state
    expect(requestedState.siblings).toContainEqual(
      expect.objectContaining({
        id: 'hairState',
        contract: HAIR_STATE_CONTRACT,
        state: selectedState
      })
    )
  })

  it('replaces an older failed candidate when Save Goon contains a different Hair draft', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const noneState = createHairState(null)
    const selectedState = parseHairState({
      schemaVersion: HAIR_STATE_CONTRACT,
      definitionSha256: HASH,
      selected: {
        assetId: 'painted-bun',
        assetRevisionId: 'painted-bun-r2',
        assetRevision: 2,
        assetRevisionSha256: HASH,
        fitFamily: 'batshit-base-f.v1',
        fitSha256: HASH
      },
      baseColor: '#2a1738',
      highlightColor: '#6f4a8e',
      motionSettings: {
        enabled: true,
        intensity: 1
      }
    })
    const pendingJob = {
      jobId: 'failed-old-hair-job',
      jobRef: 'recipe:job:failed-old-hair-job',
      status: 'failed',
      operation: 'rebake',
      targetWriteVersion: 1,
      targetRecipeRevision: 2,
      targetRevisionId: 'failed-old-hair-revision'
    }
    const startingOwner = {
      contract: 'goon-recipe/v2',
      writeVersion: 1,
      nextRecipeRevision: 3,
      liveStatus: 'failed',
      authoringRevision: { recipeRevision: 2, state: fixture.sourceState },
      activeRevision: { ref: 'active-1' },
      previousRevision: null,
      pendingAnalysis: null,
      pendingJob,
      lastFailure: {
        stage: 'baking',
        reason: 'The previous Hair candidate failed.'
      }
    }
    const startingGoon = {
      id: 'recipe-replace-failed-hair-goon',
      user_id: 'recipe-replace-failed-hair-user',
      name: 'Replace Failed Hair Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      hairState: noneState,
      recipe: startingOwner,
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-11T00:00:00.000Z'
    } as unknown as GoonRecord
    const discardedOwner = {
      ...structuredClone(startingOwner),
      writeVersion: 2,
      liveStatus: 'needs_bake',
      pendingJob: null,
      lastFailure: null
    }
    const discardedGoon = {
      ...structuredClone(startingGoon),
      recipe: discardedOwner
    } as unknown as GoonRecord
    const committedGoon = {
      ...structuredClone(discardedGoon),
      hairState: selectedState,
      recipe: {
        ...structuredClone(discardedOwner),
        writeVersion: 3,
        liveStatus: 'up_to_date',
        authoringRevision: { recipeRevision: 3, state: fixture.sourceState },
        activeRevision: { ref: 'active-3' },
        previousRevision: { ref: 'active-1' }
      }
    } as unknown as GoonRecord
    const recoveredJob = {
      goon: startingGoon,
      owner: startingOwner,
      job: {
        ...pendingJob,
        stateVersion: 1
      },
      reviewedState: { state: fixture.sourceState },
      candidate: null,
      recovered: true
    }
    const recoverJob = vi.fn(async () => recoveredJob)
    const discardJob = vi.fn(async () => ({
      goon: discardedGoon,
      owner: discardedOwner,
      job: {
        ...recoveredJob.job,
        status: 'discarded',
        stateVersion: 2
      }
    }))
    const buildUploadStageCommit = vi.fn(async () => ({
      committed: { goon: committedGoon }
    }))
    recipeServiceMocks.workflowClient = {
      recoverJob,
      discardJob,
      buildUploadStageCommit
    }
    recipeServiceMocks.loadGoons
      .mockResolvedValueOnce([discardedGoon])
      .mockResolvedValue([committedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon: startingGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      hairState: noneState,
      nextHairState: selectedState
    })
    await waitFor(() => expect(recoverJob).toHaveBeenCalled())
    await fireEvent.click(screen.getByRole('button', { name: 'Select Hair style' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    expect(discardJob).toHaveBeenCalledOnce()
    expect(buildUploadStageCommit).toHaveBeenCalledOnce()
    const requestedState = buildUploadStageCommit.mock.calls[0]?.[0]?.start.request.state
    expect(requestedState.siblings).toContainEqual(
      expect.objectContaining({
        id: 'hairState',
        state: selectedState
      })
    )
  })

  it('performs zero Recipe builds when Save Goon contains only runtime-owned changes', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const unchangedGoon = {
      id: 'recipe-runtime-only-save-goon',
      user_id: 'recipe-runtime-only-save-user',
      name: 'Runtime Only Save Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 1,
        nextRecipeRevision: 2,
        liveStatus: 'up_to_date',
        authoringRevision: { recipeRevision: 1, state: fixture.sourceState },
        activeRevision: { ref: 'active-1' },
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob: null,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    } as unknown as GoonRecord
    const buildUploadStageCommit = vi.fn()
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }

    render(RecipeWorkflowControllerHarness, {
      goon: unchangedGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials)
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    expect(buildUploadStageCommit).not.toHaveBeenCalled()
  })

  it('builds an unchanged draft when an explicit recovery left the Recipe needing a bake', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const recoveredGoon = {
      id: 'recipe-recovered-hair-goon',
      user_id: 'recipe-recovered-hair-user',
      name: 'Recovered Hair Goon',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 2,
        nextRecipeRevision: 3,
        liveStatus: 'needs_bake',
        authoringRevision: { recipeRevision: 1, state: fixture.sourceState },
        activeRevision: { ref: 'active-1' },
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob: null,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-08-11T00:00:00.000Z',
      updated_at: '2026-08-11T00:00:00.000Z'
    } as unknown as GoonRecord
    const committedGoon = {
      ...structuredClone(recoveredGoon),
      recipe: {
        ...structuredClone(recoveredGoon.recipe),
        writeVersion: 3,
        liveStatus: 'up_to_date',
        activeRevision: { ref: 'active-2' },
        previousRevision: { ref: 'active-1' }
      }
    } as unknown as GoonRecord
    const buildUploadStageCommit = vi.fn(async () => ({
      committed: { goon: committedGoon }
    }))
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    recipeServiceMocks.loadGoons.mockResolvedValue([committedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon: recoveredGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials)
    })
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    expect(buildUploadStageCommit).toHaveBeenCalledOnce()
    expect(buildUploadStageCommit.mock.calls[0]?.[0]?.start.kind).toBe('bake')
    expect(buildUploadStageCommit.mock.calls[0]?.[0]?.start.request.state).toEqual(
      fixture.sourceState
    )
  })

  it('automatically prepares an eligible first-party import exactly once', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const importedGoon = {
      id: 'recipe-auto-prepare-goon',
      user_id: 'recipe-auto-prepare-user',
      name: 'Batshit Base',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      customAvatar: {
        package: { filename: 'batshit-base.bgoon', url: '/uploads/batshit-base.bgoon' },
        model: { filename: 'avatar.glb', url: '/uploads/avatar.glb' },
        manifest: { filename: 'avatar.json', url: '/uploads/avatar.json' },
        manifestSummary: {
          contractVersion: 2,
          baseId: 'batshit-base-f-v1',
          recipeReady: true
        }
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    } as unknown as GoonRecord
    const initializedOwner = {
      contract: 'goon-recipe/v2',
      writeVersion: 1,
      nextRecipeRevision: 1,
      liveStatus: 'needs_bake',
      authoringRevision: { recipeRevision: 0, state: fixture.sourceState },
      activeRevision: null,
      previousRevision: null,
      pendingAnalysis: null,
      pendingJob: null,
      lastFailure: null
    }
    const initializedGoon = {
      ...importedGoon,
      recipe: initializedOwner
    } as unknown as GoonRecord
    const committedGoon = {
      ...initializedGoon,
      recipe: {
        ...initializedOwner,
        writeVersion: 2,
        nextRecipeRevision: 2,
        liveStatus: 'up_to_date',
        authoringRevision: { recipeRevision: 1, state: fixture.sourceState },
        activeRevision: { ref: 'active-1' }
      }
    } as unknown as GoonRecord
    const initializeFromCurrentPackage = vi.fn(async () => ({
      goon: initializedGoon,
      owner: initializedOwner
    }))
    const buildUploadStageCommit = vi.fn(async () => ({
      committed: { goon: committedGoon }
    }))
    recipeServiceMocks.workflowClient = {
      initializeFromCurrentPackage,
      buildUploadStageCommit
    }
    recipeServiceMocks.loadGoons.mockResolvedValue([committedGoon])

    render(RecipeWorkflowControllerHarness, {
      goon: importedGoon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      autoPrepare: true
    })

    await waitFor(() => expect(buildUploadStageCommit).toHaveBeenCalledOnce())
    expect(initializeFromCurrentPackage).toHaveBeenCalledOnce()
    expect(buildUploadStageCommit.mock.calls[0]?.[0]?.start.kind).toBe('bake')
  })

  it('carries the verified Recipe owner through discard rehydration and file selection', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const goon = {
      id: 'recipe-discard-boundary-goon',
      user_id: 'recipe-discard-boundary-user',
      name: 'Recipe Discard Boundary',
      kind: 'custom',
      sourceProfile: 'expert-custom-glb',
      files: {},
      recipe: {
        contract: 'goon-recipe/v2',
        writeVersion: 1,
        nextRecipeRevision: 2,
        liveStatus: 'up_to_date',
        authoringRevision: {
          recipeRevision: 1,
          state: fixture.sourceState
        },
        activeRevision: { ref: 'active' },
        previousRevision: null,
        pendingAnalysis: null,
        pendingJob: null,
        lastFailure: null
      },
      appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-07-18T00:00:00.000Z',
      updated_at: '2026-07-18T00:00:00.000Z'
    } as unknown as GoonRecord
    recipeServiceMocks.uploadCustomGoonPackage.mockRejectedValueOnce(
      new Error('stop after the operation boundary is verified')
    )

    const view = render(RecipeWorkflowControllerHarness, {
      goon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      clearRecipeOnDiscard: true
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Mutate nested Recipe dial' }))
    await waitFor(() => expect(screen.getByText('Appearance changes ready to save')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Update Goon File' }))
    await fireEvent.click(screen.getByRole('button', { name: 'Discard & Continue' }))

    const input = view.container.querySelector<HTMLInputElement>('input[type="file"]')
    expect(input).toBeTruthy()
    const file = new File(['fixture'], 'recipe-update.bgoon', { type: 'application/zip' })
    await fireEvent.change(input!, { target: { files: [file] } })

    await waitFor(() => {
      expect(recipeServiceMocks.uploadCustomGoonPackage).toHaveBeenCalledWith(
        goon.id,
        file
      )
    })
  })

  it('requires explicit confirmation for clean reset and whole-revision restore', async () => {
    const onCleanReset = vi.fn()
    const onRestore = vi.fn()
    const view = render(RecipeConfirmationDialogs, {
      cleanResetOpen: true,
      restoreOpen: false,
      previousRevision: 6,
      onCloseCleanReset: vi.fn(),
      onConfirmCleanReset: onCleanReset,
      onCloseRestore: vi.fn(),
      onConfirmRestore: onRestore
    })

    expect(screen.getByRole('dialog', { name: 'Reset Appearance and Update?' })).toBeTruthy()
    expect(screen.getByText(/cannot safely preserve the affected appearance values/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Reset Appearance and Update' }))
    expect(onCleanReset).toHaveBeenCalledOnce()

    await view.rerender({
      cleanResetOpen: false,
      restoreOpen: true,
      previousRevision: 6,
      onCloseCleanReset: vi.fn(),
      onConfirmCleanReset: onCleanReset,
      onCloseRestore: vi.fn(),
      onConfirmRestore: onRestore
    })
    expect(screen.getByRole('dialog', { name: 'Restore Previous Version?' })).toBeTruthy()
    expect(screen.getByText(/Restore the complete previous verified Goon version/)).toBeTruthy()
    await fireEvent.click(screen.getByRole('button', { name: 'Restore Previous Version' }))
    expect(onRestore).toHaveBeenCalledOnce()

    await view.rerender({
      cleanResetOpen: false,
      restoreOpen: false,
      previousRevision: 6,
      onCloseCleanReset: vi.fn(),
      onConfirmCleanReset: onCleanReset,
      onCloseRestore: vi.fn(),
      onConfirmRestore: onRestore
    })
    expect(screen.queryByRole('dialog', { name: 'Restore Previous Version?' })).toBeNull()
    expect(document.querySelector('[data-slot="dialog-overlay"]')).toBeNull()
  })
  it.each([['rebuild', 'committed'], ['rebuild', 'failed'], ['ready', 'committed'], ['ready', 'failed']] as const)(
    'settles a captured Retry draft only after %s recovery is %s', async (branch, outcome) => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const pendingJob = { jobId: 'retry-hair-job', jobRef: 'retry-hair-ref', status: 'failed', operation: 'rebake',
      targetWriteVersion: 1, targetRecipeRevision: 2, targetRevisionId: 'retry-hair-revision', idempotencyKey: 'retry-key' }
    const owner = { contract: 'goon-recipe/v2', writeVersion: 1, nextRecipeRevision: 3, liveStatus: 'failed',
      authoringRevision: { recipeRevision: 1, state: fixture.sourceState }, activeRevision: { ref: 'active-1' },
      previousRevision: null, pendingAnalysis: null, pendingJob, lastFailure: { stage: 'baking', reason: 'failed' } }
    const starting = { id: 'retry-hair-goon', user_id: 'retry-hair-user', name: 'Retry Hair', kind: 'custom',
      sourceProfile: 'expert-custom-glb', files: {}, recipe: owner, appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-08-11T00:00:00.000Z', updated_at: '2026-08-11T00:00:00.000Z' } as unknown as GoonRecord
    const committed = { ...structuredClone(starting), recipe: { ...structuredClone(owner), liveStatus: 'up_to_date',
      pendingJob: null, lastFailure: null, activeRevision: { ref: 'active-2' } } } as unknown as GoonRecord
    const recovery = { goon: starting, owner, job: { ...pendingJob, stateVersion: 1 },
      reviewedState: { state: fixture.sourceState }, candidate: null, recovered: true }
    const readyRecovery = { ...recovery, job: { ...recovery.job, status: 'ready' } }
    const recoverJob = vi.fn(async () => recovery).mockResolvedValueOnce(recovery).mockResolvedValue(
      branch === 'ready' ? readyRecovery : recovery)
    const retryJob = vi.fn(async () => ({ ...recovery, owner: { ...owner, writeVersion: 2 },
      job: { ...recovery.job, status: branch === 'ready' ? 'ready' : 'baking' } }))
    const buildUploadStageCommit = vi.fn(async () => {
      if (outcome === 'failed') throw new Error('retry failed')
      return { committed: { goon: committed } }
    })
    const resumeReadyCandidate = vi.fn(async () => {
      if (outcome === 'failed') throw new Error('ready recovery failed')
      return { goon: committed }
    })
    const settle = vi.fn(), onRetryBegin = vi.fn((_reviewed: RecipeStateSnapshot) => settle)
    recipeServiceMocks.workflowClient = { recoverJob, retryJob, buildUploadStageCommit, resumeReadyCandidate }
    recipeServiceMocks.loadGoons.mockResolvedValue([outcome === 'committed' ? committed : starting])
    render(RecipeWorkflowControllerHarness, { goon: starting,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials), onRetryBegin })
    await waitFor(() => expect(recoverJob).toHaveBeenCalled())
    await fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
    if (branch === 'ready') await waitFor(() => expect(resumeReadyCandidate).toHaveBeenCalledOnce())
    else await waitFor(() => expect(buildUploadStageCommit).toHaveBeenCalledOnce())
    expect(onRetryBegin).toHaveBeenCalledOnce()
    expect(onRetryBegin.mock.calls[0]![0]).toEqual(fixture.sourceState)
    expect(onRetryBegin.mock.invocationCallOrder[0]).toBeLessThan(retryJob.mock.invocationCallOrder[0]!)
    if (outcome === 'committed') await waitFor(() => expect(settle).toHaveBeenCalledWith(committed))
    else await waitFor(() => expect(recoverJob.mock.calls.length).toBeGreaterThan(1))
    if (outcome === 'failed') expect(settle).not.toHaveBeenCalled()
  })

  it('keeps a saved exact Hair sibling during an unrelated runtime-only Save', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const { createHairAssetFixture, createRigidHairGlbFixture } = await import('$lib/goons/recipe/fixtures/hairAssetFixture')
    const { recipeSiblingStateSha256, recipeStateSnapshotSha256 } = await import('$lib/goons/recipe')
    const asset = await createHairAssetFixture({
      recipeSource: fixture.source.recipeSource, mainBytes: createRigidHairGlbFixture(),
      headNode: 'HeadAnchor', sourceClass: 'builtin'
    })
    const hairState = createHairState(asset, { baseColor: '#123456', highlightColor: '#abcdef' })
    const sourceState = structuredClone(fixture.sourceState)
    sourceState.siblings.push({
      id: 'hairState', contract: hairState.schemaVersion, definitionSha256: hairState.definitionSha256!,
      stateSha256: await recipeSiblingStateSha256(hairState), state: hairState
    })
    sourceState.siblings.sort((left, right) => left.id.localeCompare(right.id))
    sourceState.stateSha256 = await recipeStateSnapshotSha256(sourceState)
    const before = JSON.stringify(sourceState)
    const goon = {
      id: 'recipe-retained-hair-runtime-save', user_id: 'recipe-runtime-only-save-user',
      name: 'Runtime Only Save Goon', kind: 'custom', sourceProfile: 'expert-custom-glb', files: {},
      recipe: { contract: 'goon-recipe/v2', writeVersion: 1, nextRecipeRevision: 2,
        liveStatus: 'up_to_date', authoringRevision: { recipeRevision: 1, state: sourceState },
        activeRevision: { ref: 'active-1' }, previousRevision: null, pendingAnalysis: null,
        pendingJob: null, lastFailure: null },
      appearanceDials: sourceState.appearanceDials, hairState,
      created_at: '2026-07-18T00:00:00.000Z', updated_at: '2026-07-18T00:00:00.000Z'
    } as unknown as GoonRecord
    const buildUploadStageCommit = vi.fn()
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    render(RecipeWorkflowControllerHarness, {
      goon, appearanceDials: structuredClone(sourceState.appearanceDials), hairState
    })
    await waitFor(() => expect(screen.getByText('Ready')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))
    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    expect(buildUploadStageCommit).not.toHaveBeenCalled()
    expect(JSON.stringify(sourceState)).toBe(before)
  })

  it('cancels previous-version preparation without late publication, then reviews the exact verified Live envelope', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const {
      GOON_LIVE_BUILD_CONTRACT,
      GOON_RECIPE_REVISION_CONTRACT,
      GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
      createRecipeRevisionEnvelope,
      recipeRevisionBundleSha256,
      verifyRecipeRevisionEnvelope
    } = await import('$lib/goons/recipe')
    const unsignedRevision = {
      contract: GOON_RECIPE_REVISION_CONTRACT,
      recipeRevision: 1,
      revisionId: 'recipe-previous-live-revision',
      revisionSha256: '0'.repeat(64),
      source: fixture.source.recipeSource,
      state: fixture.sourceState,
      liveBuildReceipt: {
        contract: GOON_LIVE_BUILD_CONTRACT,
        ref: 'goon_recipe_document:recipe-previous-live-user:recipe-previous-live-goon:receipt',
        sha256: '1'.repeat(64)
      },
      updateReport: null
    }
    const revision = {
      ...unsignedRevision,
      revisionSha256: await recipeRevisionBundleSha256(unsignedRevision)
    }
    const previousEnvelope = await createRecipeRevisionEnvelope({
      contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      revision,
      sourceContainmentReceipt: {
        contract: RECIPE_ARCHIVE_CONTAINMENT_RECEIPT_CONTRACT,
        ref: 'goon_recipe_document:recipe-previous-live-user:recipe-previous-live-goon:containment',
        sha256: '2'.repeat(64)
      },
      live: {
        package: { ref: '/uploads/goon_custom_packages/previous.bgoon', sha256: '3'.repeat(64), bytes: 300 },
        model: { ref: '/uploads/goon_custom_models/previous.glb', sha256: '4'.repeat(64), bytes: 200 },
        manifest: { ref: '/uploads/goon_custom_manifests/previous.json', sha256: '5'.repeat(64), bytes: 100 }
      }
    })
    const verifiedPreviousEnvelope = await verifyRecipeRevisionEnvelope(previousEnvelope)
    const previousRevisionRef = {
      contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
      ref: 'goon_recipe_revision:recipe-previous-live-user:recipe-previous-live-goon:recipe-previous-live-revision',
      sha256: verifiedPreviousEnvelope.envelopeSha256
    }
    const owner = {
      contract: 'goon-recipe/v2', writeVersion: 2, nextRecipeRevision: 3,
      liveStatus: 'up_to_date',
      authoringRevision: { recipeRevision: 2, source: fixture.source.recipeSource, state: fixture.sourceState },
      activeRevision: {
        contract: GOON_RECIPE_REVISION_ENVELOPE_CONTRACT,
        ref: 'goon_recipe_revision:recipe-previous-live-user:recipe-previous-live-goon:active',
        sha256: '6'.repeat(64)
      },
      previousRevision: previousRevisionRef,
      pendingAnalysis: null, pendingJob: null, lastFailure: null
    }
    const goon = {
      id: 'recipe-previous-live-goon', user_id: 'recipe-previous-live-user',
      name: 'Previous Live Review', kind: 'custom', sourceProfile: 'expert-custom-glb', files: {},
      recipe: owner, appearanceDials: fixture.sourceState.appearanceDials,
      created_at: '2026-09-17T00:00:00.000Z', updated_at: '2026-09-17T00:00:00.000Z'
    } as unknown as GoonRecord
    const response = {
      goon, owner, previous: await verifyRecipeRevisionEnvelope(verifiedPreviousEnvelope)
    }
    let resolveFirst!: (value: typeof response) => void
    const firstRequest = new Promise<typeof response>(resolve => { resolveFirst = resolve })
    const previewRollback = vi.fn(async (_options?: { signal?: AbortSignal }) => response)
      .mockImplementationOnce(() => firstRequest)
    recipeServiceMocks.workflowClient = { previewRollback }
    const onPreviewTargetChange = vi.fn()
    const onWorkflowOperationChange = vi.fn()

    render(RecipeWorkflowControllerHarness, {
      goon,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      onPreviewTargetChange,
      onWorkflowOperationChange
    })

    await waitFor(() => expect(screen.getByRole('button', { name: 'Restore Previous Version' })).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Restore Previous Version' }))
    await waitFor(() => expect(previewRollback).toHaveBeenCalledOnce())
    await waitFor(() => expect(onWorkflowOperationChange.mock.calls.at(-1)?.[0]?.onCancel).toBeTypeOf('function'))
    const operation = onWorkflowOperationChange.mock.calls.at(-1)![0] as GoonOperationState
    await operation.onCancel?.()
    await waitFor(() => expect(previewRollback.mock.calls[0][0]?.signal?.aborted).toBe(true))
    await waitFor(() => expect(onWorkflowOperationChange.mock.calls.at(-1)?.[0]).toBeNull())
    resolveFirst(response)
    await firstRequest
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(onPreviewTargetChange.mock.calls.some(([value]) => Boolean(value?.liveEnvelope))).toBe(false)
    expect(screen.queryByRole('dialog', { name: 'Restore Previous Version?' })).toBeNull()

    await fireEvent.click(screen.getByRole('button', { name: 'Restore Previous Version' }))
    await waitFor(() => expect(previewRollback).toHaveBeenCalledTimes(2))
    await waitFor(() => expect(
      onPreviewTargetChange.mock.calls.some(([value]) => Boolean(value?.liveEnvelope))
    ).toBe(true))
    const target = onPreviewTargetChange.mock.calls
      .map(([value]) => value)
      .find((value) => value?.liveEnvelope)!
    expect(target).toMatchObject({
      side: 'updated',
      state: verifiedPreviousEnvelope.revision.state,
      liveEnvelope: verifiedPreviousEnvelope
    })
    expect(target.liveEnvelope.envelopeSha256).toBe(previousRevisionRef.sha256)
    expect(target.liveEnvelope.live).toEqual(verifiedPreviousEnvelope.live)
  })

  it('publishes cancelable build phases, removes Cancel for commit, and clears the operation after success', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const { starting, committed } = operationLifecycleGoons(fixture.sourceState)
    let buildRequest: any = null
    let resolveBuild: ((value: unknown) => void) | null = null
    let resolveSavedPreview: (() => void) | null = null
    let currentOperation: GoonOperationState | null = null
    const onWorkflowOperationChange = vi.fn((operation: GoonOperationState | null) => {
      currentOperation = operation
    })
    const buildUploadStageCommit = vi.fn((request: any) => {
      buildRequest = request
      return new Promise((resolve) => { resolveBuild = resolve })
    })
    const onLoadSavedPreview = vi.fn(() => new Promise<void>((resolve) => { resolveSavedPreview = resolve }))
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    recipeServiceMocks.loadGoons.mockResolvedValue([committed])

    render(RecipeWorkflowControllerHarness, {
      goon: starting,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      onLoadSavedPreview,
      onWorkflowOperationChange
    })

    await waitFor(() => expect(screen.getByText('Appearance changes ready to save')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))
    await waitFor(() => expect(buildUploadStageCommit).toHaveBeenCalledOnce())

    buildRequest.onProgress('rewriting-model')
    await waitFor(() => expect(currentOperation?.phase).toBe('Baking the Goon model'))
    expect(currentOperation?.onCancel).toEqual(expect.any(Function))

    buildRequest.onProgress('committing')
    await waitFor(() => expect(currentOperation?.phase).toBe('Saving the Goon'))
    expect(currentOperation?.onCancel).toBeFalsy()

    resolveBuild!({ committed: { goon: committed } })
    await waitFor(() => expect(onLoadSavedPreview).toHaveBeenCalledWith(committed))
    expect(currentOperation?.phase).toBe('Loading the saved Goon')
    expect(currentOperation?.onCancel).toBeFalsy()
    expect(screen.getByTestId('save-result')).toHaveTextContent('not-run')
    expect(buildUploadStageCommit).toHaveBeenCalledOnce()

    resolveSavedPreview!()
    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    await waitFor(() => expect(currentOperation).toBeNull())
  })

  it('keeps a committed rebake saved when reopening its preview fails', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const { starting, committed } = operationLifecycleGoons(fixture.sourceState)
    let rejectSavedPreview: ((reason: Error) => void) | null = null
    let currentOperation: GoonOperationState | null = null
    const onLoadSavedPreview = vi.fn(() => new Promise<void>((_resolve, reject) => { rejectSavedPreview = reject }))
    const buildUploadStageCommit = vi.fn(async () => ({ committed: { goon: committed } }))
    const recoverJob = vi.fn()
    recipeServiceMocks.workflowClient = { buildUploadStageCommit, recoverJob }
    recipeServiceMocks.loadGoons.mockResolvedValue([committed])

    render(RecipeWorkflowControllerHarness, {
      goon: starting,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      onLoadSavedPreview,
      onWorkflowOperationChange: (operation) => { currentOperation = operation }
    })

    await waitFor(() => expect(screen.getByText('Appearance changes ready to save')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))
    await waitFor(() => expect(onLoadSavedPreview).toHaveBeenCalledWith(committed))
    expect(currentOperation?.phase).toBe('Loading the saved Goon')
    expect(currentOperation?.onCancel).toBeFalsy()
    expect(screen.getByTestId('save-result')).toHaveTextContent('not-run')

    rejectSavedPreview!(new Error('fixture preview failed'))
    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('true'))
    await waitFor(() => expect(currentOperation).toBeNull())
    expect(buildUploadStageCommit).toHaveBeenCalledOnce()
    expect(recipeServiceMocks.loadGoons).toHaveBeenCalledOnce()
    expect(recoverJob).not.toHaveBeenCalled()
  })

  it('keeps the operation blocked while cancellation and recovery settle', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const { starting } = operationLifecycleGoons(fixture.sourceState)
    let currentOperation: GoonOperationState | null = null
    let resolveRecovery: ((goons: GoonRecord[]) => void) | null = null
    const recovery = new Promise<GoonRecord[]>((resolve) => { resolveRecovery = resolve })
    const buildUploadStageCommit = vi.fn((request: any) =>
      new Promise((_resolve, reject) => {
        request.onProgress('rewriting-model')
        request.signal.addEventListener('abort', () => reject(request.signal.reason), { once: true })
      })
    )
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    recipeServiceMocks.loadGoons.mockImplementation(() => recovery)

    render(RecipeWorkflowControllerHarness, {
      goon: starting,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      onWorkflowOperationChange: (operation) => { currentOperation = operation }
    })

    await waitFor(() => expect(screen.getByText('Appearance changes ready to save')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))
    await waitFor(() => expect(currentOperation?.onCancel).toEqual(expect.any(Function)))
    currentOperation?.onCancel?.()

    await waitFor(() => expect(currentOperation?.phase).toBe('Canceling the Goon operation'))
    expect(currentOperation?.onCancel).toBeFalsy()
    expect(screen.getByTestId('save-result')).toHaveTextContent('not-run')

    resolveRecovery!([starting])
    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('false'))
    await waitFor(() => expect(currentOperation).toBeNull())
  })

  it('clears the blocking operation after a failed build finishes recovery', async () => {
    const fixture = await createRecipePhysicalMigrationFixture()
    const { starting } = operationLifecycleGoons(fixture.sourceState)
    let currentOperation: GoonOperationState | null = null
    let rejectBuild: ((reason: unknown) => void) | null = null
    const buildUploadStageCommit = vi.fn((request: any) => {
      request.onProgress('auditing-model')
      return new Promise((_resolve, reject) => { rejectBuild = reject })
    })
    recipeServiceMocks.workflowClient = { buildUploadStageCommit }
    recipeServiceMocks.loadGoons.mockResolvedValue([starting])

    render(RecipeWorkflowControllerHarness, {
      goon: starting,
      appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
      onWorkflowOperationChange: (operation) => { currentOperation = operation }
    })

    await waitFor(() => expect(screen.getByText('Appearance changes ready to save')).toBeTruthy())
    await fireEvent.click(screen.getByRole('button', { name: 'Save Goon' }))
    await waitFor(() => expect(currentOperation?.phase).toBe('Checking the baked model'))
    rejectBuild!(new Error('fixture build failed'))

    await waitFor(() => expect(screen.getByTestId('save-result')).toHaveTextContent('false'))
    await waitFor(() => expect(currentOperation).toBeNull())
  })
  it.each(['failed', 'superseded'] as const)(
    'reports a %s draft fit without replacing the last valid preview and clears errors after Cancel',
    async (outcome) => {
      const fixture = await createRecipePhysicalMigrationFixture()
      const goon = {
        id: 'recipe-preview-fit-error-goon',
        user_id: 'recipe-preview-fit-error-user',
        name: 'Recipe Preview Fit Error',
        kind: 'custom',
        sourceProfile: 'expert-custom-glb',
        files: {},
        customAvatar: { manifestSummary: { anatomyFitReady: true } },
        recipe: {
          contract: 'goon-recipe/v2',
          writeVersion: 1,
          nextRecipeRevision: 2,
          liveStatus: 'up_to_date',
          authoringRevision: {
            recipeRevision: 1,
            source: fixture.source.recipeSource,
            state: fixture.sourceState
          },
          activeRevision: { ref: 'active' },
          previousRevision: null,
          pendingAnalysis: null,
          pendingJob: null,
          lastFailure: null
        },
        appearanceDials: fixture.sourceState.appearanceDials,
        created_at: '2026-09-08T00:00:00.000Z',
        updated_at: '2026-09-08T00:00:00.000Z'
      } as unknown as GoonRecord
      const onDraftPreviewStateChange = vi.fn()
      const onDraftPreviewErrorChange = vi.fn()
      let rejectFit!: (error: Error) => void
      recipeServiceMocks.loadCustomAvatarManifest.mockImplementationOnce(
        () => new Promise((_, reject) => { rejectFit = reject })
      )
      const view = render(RecipeWorkflowControllerHarness, {
        goon,
        appearanceDials: structuredClone(fixture.sourceState.appearanceDials),
        onDraftPreviewStateChange,
        onDraftPreviewErrorChange,
      })
      await waitFor(() => expect(onDraftPreviewStateChange).toHaveBeenCalledOnce())
      const validPreview = onDraftPreviewStateChange.mock.lastCall?.[0]
      await fireEvent.click(screen.getByRole('button', { name: 'Mutate nested Recipe dial' }))
      await waitFor(() => expect(recipeServiceMocks.loadCustomAvatarManifest).toHaveBeenCalledOnce())
      const failure = new Error('The previous Anatomy Fit sibling state hash is stale.')
      if (outcome === 'failed') {
        rejectFit(failure)
        await waitFor(() => expect(onDraftPreviewErrorChange).toHaveBeenLastCalledWith(failure.message))
        expect(onDraftPreviewStateChange).toHaveBeenCalledOnce()
        expect(onDraftPreviewStateChange.mock.lastCall?.[0]).toBe(validPreview)
      }
      await fireEvent.click(screen.getByRole('button', { name: 'Cancel appearance changes' }))
      await waitFor(() => expect(onDraftPreviewStateChange).toHaveBeenCalledTimes(2))
      expect(onDraftPreviewStateChange.mock.lastCall?.[0]).toEqual(validPreview)
      expect(onDraftPreviewErrorChange).toHaveBeenLastCalledWith(null)
      if (outcome === 'superseded') {
        rejectFit(failure)
        await new Promise((resolve) => setTimeout(resolve, 0))
        expect(onDraftPreviewErrorChange).not.toHaveBeenCalledWith(failure.message)
        expect(onDraftPreviewStateChange).toHaveBeenCalledTimes(2)
      }
      view.unmount()
      expect(onDraftPreviewStateChange).toHaveBeenLastCalledWith(null)
      expect(onDraftPreviewErrorChange).toHaveBeenLastCalledWith(null)
    }
  )


})
