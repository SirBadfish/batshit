import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { afterEach, describe, expect, it, vi } from 'vitest'
import {
  RECIPE_MIGRATION_REPORT_CONTRACT,
  RECIPE_STRICT_TOLERANCE_PROFILE,
  type RecipeMigrationReport,
  type RecipeMigrationReportEntry
} from '$lib/goons/recipe'
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
  cleanup()
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
      onRetry: vi.fn(),
      onDiscard: vi.fn()
    })

    const activeStatus = screen.getByRole('status', { name: 'Updating Appearance' })
    expect(activeStatus.querySelector('.animate-spin')).toBeTruthy()
    expect(screen.getByText(/This can take a few seconds/)).toBeTruthy()
    expect(screen.getByRole('progressbar')).toHaveAttribute('aria-valuetext', 'Applying')
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
      filter: 'all',
      canUpdateAndRebuild: true,
      canKeepCurrentPackage: true,
      onUpdateAndRebuild: vi.fn(),
      onKeepCurrentPackage: vi.fn(),
      onRequestCleanReset: vi.fn()
    })
    expect(screen.queryByText('Your appearance can be preserved')).toBeNull()
    expect(screen.getByText('Your confirmation is required')).toBeTruthy()
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
})
