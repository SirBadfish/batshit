<script lang="ts">
  import { untrack } from 'svelte'
  import type { AppearanceDialValueState } from '$lib/goons/appearanceDials'
  import type { HairStateV2 } from '$lib/goons/hairAssets'
  import type {
    RecipeStateSnapshot
  } from '$lib/goons/recipe'
  import type { GoonRecord } from '$lib/types/goons'
  import type { RecipeEditorPreviewTarget, RecipeFittedPreviewState } from './types'
  import type { GoonOperationState } from '../GoonOperationOverlay.svelte'
  import RecipeWorkflowController from './RecipeWorkflowController.svelte'

  type Props = {
    goon: GoonRecord
    appearanceDials: AppearanceDialValueState
    hairState?: HairStateV2 | null
    nextHairState?: HairStateV2 | null
    clearRecipeOnDiscard?: boolean
    autoPrepare?: boolean
    onDraftPreviewStateChange?: (preview: RecipeFittedPreviewState | null) => void
    onDraftPreviewErrorChange?: (error: string | null) => void
    onRecipeDraftStateChange?: (state: RecipeStateSnapshot | null) => void
    onPreviewTargetChange?: (target: RecipeEditorPreviewTarget | null, options?: { signal?: AbortSignal }) => void | Promise<void>
    onLoadSavedPreview?: (goon: GoonRecord) => Promise<void>
    onRetryBegin?: (reviewed: RecipeStateSnapshot) => ((committed: GoonRecord) => void) | null
    onWorkflowOperationChange?: (operation: GoonOperationState | null) => void
  }

  let {
    goon,
    appearanceDials,
    hairState = null,
    nextHairState = null,
    clearRecipeOnDiscard = false,
    autoPrepare = false,
    onDraftPreviewStateChange,
    onDraftPreviewErrorChange,
    onRecipeDraftStateChange,
    onPreviewTargetChange,
    onLoadSavedPreview,
    onRetryBegin,
    onWorkflowOperationChange
  }: Props = $props()
  let activeGoon = $state(untrack(() => structuredClone(goon)))
  let draft = $state(untrack(() => structuredClone(appearanceDials)))
  let hairDraft = $state<HairStateV2 | null>(untrack(() => structuredClone(hairState)))
  let controller = $state<{
    saveRecipeDraftIfNeeded: () => Promise<boolean>
  } | null>(null)
  let lastSaveResult = $state<string>('not-run')
  let previewSide = $state<string>('none')

  function mutateNestedDial() {
    draft.values.affine_control = (draft.values.affine_control ?? 0) + 0.1
  }

  function selectHair() {
    hairDraft = nextHairState ? structuredClone(nextHairState) : null
  }

  function discardDraft() {
    draft = structuredClone(appearanceDials)
    if (clearRecipeOnDiscard) {
      activeGoon = {
        ...activeGoon,
        recipe: undefined
      }
    }
  }

  async function saveGoon() {
    lastSaveResult = String(await controller?.saveRecipeDraftIfNeeded())
  }
</script>

<button onclick={mutateNestedDial}>Mutate nested Recipe dial</button>
{#if nextHairState}
  <button onclick={selectHair}>Select Hair style</button>
{/if}
<button onclick={saveGoon}>Save Goon</button>
<button onclick={discardDraft}>Cancel appearance changes</button>
<span data-testid="save-result">{lastSaveResult}</span>
<span data-testid="recipe-preview-side">{previewSide}</span>

<RecipeWorkflowController
  bind:this={controller}
  goon={activeGoon}
  appearanceDials={draft}
  facialArtwork={null}
  eyeAppearance={null}
  oralAppearance={null}
  lipArtwork={null}
  lipArtworkPresence={null}
  nailSurface={null}
  nailSurfacePresence={null}
  skinAppearance={null}
  hairState={hairDraft}
  onSaveEditorDraft={async () => true}
  onDiscardEditorDraft={discardDraft}
  onRecipeGoonChanged={(next) => { activeGoon = structuredClone(next) }}
  {onDraftPreviewStateChange}
  {onDraftPreviewErrorChange}
  {onRecipeDraftStateChange}
  onPreviewTargetChange={async (target, options) => {
    await onPreviewTargetChange?.(target, options)
    previewSide = target?.side ?? 'none'
  }}
  onPreviewLiveCandidate={async () => {}}
  {onLoadSavedPreview}
  {onRetryBegin}
  {onWorkflowOperationChange}
  {autoPrepare}
/>
