<script lang="ts">
  import { untrack } from 'svelte'
  import type { AppearanceDialValueState } from '$lib/goons/appearanceDials'
  import type { GoonRecord } from '$lib/types/goons'
  import RecipeWorkflowController from './RecipeWorkflowController.svelte'

  type Props = {
    goon: GoonRecord
    appearanceDials: AppearanceDialValueState
    clearRecipeOnDiscard?: boolean
    autoPrepare?: boolean
  }

  let {
    goon,
    appearanceDials,
    clearRecipeOnDiscard = false,
    autoPrepare = false
  }: Props = $props()
  let activeGoon = $state(untrack(() => structuredClone(goon)))
  let draft = $state(untrack(() => structuredClone(appearanceDials)))
  let controller = $state<{
    saveRecipeDraftIfNeeded: () => Promise<boolean>
  } | null>(null)
  let lastSaveResult = $state<string>('not-run')

  function mutateNestedDial() {
    draft.values.affine_control = (draft.values.affine_control ?? 0) + 0.1
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
<button onclick={saveGoon}>Save Goon</button>
<span data-testid="save-result">{lastSaveResult}</span>

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
  onSaveEditorDraft={async () => true}
  onDiscardEditorDraft={discardDraft}
  onRecipeGoonChanged={(next) => { activeGoon = structuredClone(next) }}
  onPreviewTargetChange={() => {}}
  onPreviewLiveCandidate={async () => {}}
  {autoPrepare}
/>
