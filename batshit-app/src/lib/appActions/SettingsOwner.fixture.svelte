<script lang="ts">
  import { onDestroy, tick, untrack } from 'svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import type { ActionContext, SettingsPanelState } from './owners'
  import type { SettingsTarget } from './catalog'
  let { initialAgentId = null, initialToolsTab = 'gateway-settings', onUnsavedStateChange } = $props<{
    initialAgentId?: string | null
    initialToolsTab?: string
    onUnsavedStateChange?: (state: unknown) => void
  }>()
  let dirty = $state(false)
  let goonDraft = $state('')
  let goonSaveFails = $state(false)
  let hairImportOpen = $state(false)
  let beginHairDuringSave = $state(false)
  let editorOpen = $state(false)
  let entityId = $state<string | null>(null)
  let toolsTab = $state(untrack(() => initialToolsTab))
  // Match GoonsSettingsPanel's real destroy contract when the guarded tab is left.
  onDestroy(() => onUnsavedStateChange?.(null))
  export function readAppActionState(): SettingsPanelState {
    return { busy: false, dirty, entityId, toolsTab }
  }
  export function hasActiveHairImport() { return hairImportOpen }
  export function selectAppActionTarget(target: SettingsTarget, context: ActionContext) {
    context.check()
    entityId = target.agentId ?? target.modelId ?? target.artifactId ?? null
    if (target.toolsTab) toolsTab = target.toolsTab
  }
  $effect(() => {
    onUnsavedStateChange?.(dirty ? {
      message: 'Fixture unsaved Goon', saveLabel: 'Save',
      onSave: async () => { if (goonSaveFails) return false; if (beginHairDuringSave) { hairImportOpen = true; await tick() }; dirty = false; return true }, onDiscard: () => { dirty = false }
    } : null)
  })
</script>
<p data-testid="settings-owner-fixture">Mounted owner {entityId ?? 'list'} / {toolsTab} / launcher {initialAgentId ?? 'none'}</p>
<button type="button" onclick={() => { dirty = true }}>Make Goon draft</button>
<button type="button" onclick={() => { hairImportOpen = true }}>Begin Hair fit</button>
<button type="button" onclick={() => { hairImportOpen = false }}>Finish Hair fit</button>
{#if dirty}
  <textarea aria-label="Goon fixture draft" bind:value={goonDraft}></textarea>
  <button type="button" onclick={() => { goonSaveFails = true }}>Fail Goon save</button>
  <button type="button" onclick={() => { beginHairDuringSave = true }}>Begin Hair during Goon save</button>
{/if}
<button type="button" onclick={() => { editorOpen = true }}>Edit multiline</button>
<SettingsTextEditor bind:open={editorOpen} title="Fixture prompt" value="saved prompt" />
