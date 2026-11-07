<script lang="ts">
  import { Brain, ChevronDown } from '@lucide/svelte'
  import { untrack, onMount } from 'svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import * as Select from '$lib/components/ui/select'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import * as Label from '$lib/components/ui/label'
  import { parseReasoningBudget } from '$lib/utils/modelReasoningBudget'
  import type { ReasoningBudget } from '$lib/utils/modelReasoningBudget'
  import { toast } from 'svelte-sonner'
  import type { SavedModel } from '$lib/types/savedModels'
  import { isOllamaReasoningConnection } from '$lib/data/reasoning-controls'
  import { LIVE_SETTINGS_EVENTS } from '$lib/utils/liveSettingsEvents'
  import type { LocalReasoningContract } from '$lib/types/reasoningControls'
  import type { ReasoningControlSelection } from '$lib/types/reasoningControls'
  import * as agentStore from '$lib/stores/agents.svelte'
  import * as savedModelsStore from '$lib/stores/savedModels.svelte'
  import { getAgentReasoningSave, saveAgentReasoningControl } from '$lib/stores/agentReasoningSaves.svelte'
  import { agentReasoningContext } from '$lib/utils/agentReasoningContext'
  import { REASONING_CONTROL_IDS } from '$lib/utils/modelReasoningControls'
  import { previewModelReasoningControls } from '$lib/utils/modelReasoningPreview'
  import type { ReasoningControlId } from '$lib/types/reasoningControls'

  let { agentId = null, preset = undefined, surface = 'chat', disabled = false, canEdit = () => true }: {
    agentId?: string | null; preset?: SavedModel | null; surface?: 'chat' | 'settings'
    disabled?: boolean; canEdit?: () => boolean
  } = $props()
  let budgetOpen = $state(false)
  let budgetDraft = $state('')
  let budgetError = $state<string | null>(null)
  let budgetOwner = $state<{ agentId: string; modelKey: string; key: string; budget: ReasoningBudget } | null>(null)
  const budgetSaving = $derived(Boolean(budgetOwner && getAgentReasoningSave(budgetOwner.agentId, budgetOwner.key)?.pending))
  let open = $state(false)
  let openedControlId = $state<ReasoningControlId | null>(null)
  let openedOwner = $state<{ agentId: string; key: string } | null>(null)
  const agent = $derived(agentId ? agentStore.getAgentById(agentId) : agentStore.getCurrentAgent())
  const model = $derived(preset === undefined
    ? savedModelsStore.getSavedModels().find(model => model.id === agent?.primary_model_preset_id) ?? null : preset)
  let localContract = $state<LocalReasoningContract | null>(null)
  const context = $derived(agentReasoningContext(agent, model, localContract))
  const localOllama = $derived(isOllamaReasoningConnection(context?.identity.connection))
  let contractError = $state<string | null>(null)
  let contractLoading = $state(false)
  let statusRequest = 0
  let loadedScope = ''
  let requestingScope = ''
  const api = $derived.by(() => {
    if (!agent || !context) return { controls: [], error: null }
    const overrides = { ...agent.model_reasoning_overrides }
    for (const id of REASONING_CONTROL_IDS) {
      const draft = getAgentReasoningSave(agent.id, context.keys[id])
      if (!draft) continue
      if (draft.selection === null) delete overrides[context.keys[id]]
      else overrides[context.keys[id]] = draft.selection
    }
    return previewModelReasoningControls({ identity: context.identity, provider: context.provider, settings: context.settings, capabilities: context.capabilities, localReasoning: localContract, overrides })
  })
  const controlLabel = $derived(api.controls.length > 1 ? 'Reasoning controls' : api.controls[0]?.label ?? 'Reasoning effort')
  const saved = $derived(agent && context ? getAgentReasoningSave(agent.id, context.key) : undefined)
  const selection = $derived(saved ? saved.selection : context ? agent?.model_reasoning_overrides?.[context.key] ?? null : null)
  const visible = $derived(Boolean(context && (context.binding || api.controls.length > 0 || selection !== null)))

  async function refreshReasoningContract() {
    if (!localOllama || !agent || !context) return
    const owner = { agentId: agent.id, key: context.keys.thinking }
    const scope = JSON.stringify(owner)
    if (contractLoading && requestingScope === scope) return
    requestingScope = scope
    const request = ++statusRequest
    contractLoading = true
    contractError = null
    localContract = null
    try {
      const response = await fetch(`/api/settings/local-ai/models?program=ollama&mode=reasoning&agentId=${encodeURIComponent(owner.agentId)}`)
      const body = await response.json().catch(() => null)
      if (!response.ok || body?.reasoning?.key !== owner.key || !['verified', 'unverified'].includes(body?.reasoning?.contract?.status)) {
        throw new Error('Reasoning options could not be checked. Your saved choice was kept.')
      }
      if (request !== statusRequest || agent?.id !== owner.agentId || context?.keys.thinking !== owner.key) return
      localContract = body.reasoning.contract
    } catch (error) {
      if (request === statusRequest) {
        contractError = error instanceof Error ? error.message : 'Reasoning options could not be checked.'
        localContract = null
      }
    } finally { if (request === statusRequest) contractLoading = false }
  }
  $effect(() => {
    const scope = localOllama && agent && context ? JSON.stringify(['ollama', agent.id, context.key]) : ''
    if (scope === loadedScope) return
    loadedScope = scope
    untrack(() => {
      statusRequest += 1
      contractLoading = false
      localContract = null
      contractError = null
      if (scope) void refreshReasoningContract()
    })
  })

  onMount(() => {
    const invalidate = () => {
      if (!localOllama) return
      statusRequest += 1
      contractLoading = false
      localContract = null
      void refreshReasoningContract()
    }
    window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, invalidate)
    return () => window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, invalidate)
  })

  function handleOpenChange(next: boolean, controlId: ReasoningControlId | null = null) {
    if (!next) { if (controlId === openedControlId) open = false; return }
    if (disabled || !canEdit() || !agent || !context) return
    openedOwner = { agentId: agent.id, key: context.key }
    openedControlId = controlId
    open = true
    if (localOllama) void refreshReasoningContract()
  }
  $effect(() => {
    if (openedOwner && (disabled || !canEdit() || agent?.id !== openedOwner.agentId || context?.key !== openedOwner.key)) {
      open = false
      openedOwner = null
    }
  })

  async function handleApiSelect(id: ReasoningControlId, value: string) {
    const owner = openedOwner
    const control = api.controls.find(control => control.id === id)
    const option = control?.options.find(option => option.value === value)
    if (!owner || !agent || !context || disabled || !canEdit() || owner.agentId !== agent.id || owner.key !== context.key ||
      surface === 'settings' && openedControlId !== id || !control || !option?.available) return
    open = false
    if (value === 'custom-budget' && control.budget) {
      budgetOwner = { agentId: owner.agentId, modelKey: owner.key, key: control.key, budget: control.budget }
      const previous = control.selection?.mode === 'value' ? control.selection.value : control.effectiveValue
      budgetDraft = typeof previous === 'number' ? String(previous) : ''
      budgetError = null
      budgetOpen = true
      return
    }
    const next: ReasoningControlSelection | null = value === 'inherit' ? null
      : value === 'provider-default' ? { mode: 'provider-default' } : { mode: 'value', value: option.selectionValue! }
    try { await saveAgentReasoningControl(owner.agentId, control.key, next) }
    catch (error) { toast.error(error instanceof Error ? error.message : 'Could not save the reasoning setting') }
  }

  $effect(() => {
    if (budgetOpen && budgetOwner && (agent?.id !== budgetOwner.agentId || context?.key !== budgetOwner.modelKey)) {
      budgetOpen = false
      budgetOwner = null
    }
  })
  async function saveBudget() {
    const owner = budgetOwner
    if (!owner || budgetSaving || disabled || !canEdit() || agent?.id !== owner.agentId || context?.key !== owner.modelKey) return
    let value: number
    try { value = parseReasoningBudget(budgetDraft, owner.budget) }
    catch (error) { budgetError = error instanceof Error ? error.message : 'Enter a valid thinking budget.'; return }
    const control = api.controls.find(control => control.key === owner.key)
    const candidate = previewModelReasoningControls({ identity: context.identity, provider: context.provider, settings: context.settings, capabilities: context.capabilities, localReasoning: localContract,
      overrides: { ...agent.model_reasoning_overrides, [owner.key]: { mode: 'value', value } } })
    if (!control || candidate.error) { budgetError = candidate.error ?? 'This budget no longer belongs to the selected model.'; return }
    budgetError = null
    try {
      await saveAgentReasoningControl(owner.agentId, owner.key, { mode: 'value', value })
      if (budgetOwner === owner) budgetOpen = false
    } catch (error) { if (budgetOwner === owner) budgetError = error instanceof Error ? error.message : 'The budget save could not be confirmed.' }
  }
</script>

{#if visible}
  {#if surface === 'chat'}
    <DropdownMenu.Root {open} onOpenChange={(next) => handleOpenChange(next)}>
      <DropdownMenu.Trigger
        class="inline-flex h-8 min-w-[110px] items-center justify-between gap-2 rounded-full border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mode-selector-trigger api-reasoning-selector"
        aria-label={controlLabel} title={controlLabel} aria-busy={Boolean(agent && api.controls.some(control => getAgentReasoningSave(agent.id, control.key)?.pending))} {disabled}
        data-testid="model-reasoning-selector"
        data-ab-control="model-reasoning-effort">
        <div class="flex items-center gap-2 min-w-0 mode-selector-inner">
          <Brain class="h-4 w-4 shrink-0 text-muted-foreground" />
          <span class="truncate mode-selector-label">{localOllama && !context?.binding ? contractLoading ? 'Checking…' : 'Unverified' : api.controls[0]?.unavailable ? 'Unavailable' : api.controls[0]?.activeLabel ?? 'Reasoning'}</span>
        </div>
        <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
      </DropdownMenu.Trigger>
      <DropdownMenu.Content align="start" class="w-[230px]">
        {#each api.controls as control (control.id)}
          {@const controlSave = agent ? getAgentReasoningSave(agent.id, control.key) : undefined}
          <DropdownMenu.Label>{control.label}</DropdownMenu.Label>
          <DropdownMenu.RadioGroup value={control.selectedValue}>
            {#each control.options.filter(option => option.available || option.value === 'provider-default') as option (option.value)}
              <DropdownMenu.RadioItem value={option.value} disabled={!option.available} onSelect={() => handleApiSelect(control.id, option.value)}
                class={`mode-item flex items-center gap-2 border-l-2 border-r-2 pl-2 pr-2 ${option.value === control.selectedValue ? 'border-primary-text text-foreground' : 'border-transparent text-muted-foreground'}`}>
                <Brain class="h-4 w-4 shrink-0" />
                <div class="flex flex-col min-w-0"><span class="truncate">{option.label}</span>
                  {#if option.helper}<span class="text-[11px] text-muted-foreground truncate">{option.helper}</span>{/if}
                </div>
              </DropdownMenu.RadioItem>
            {/each}
          </DropdownMenu.RadioGroup>
          {#if controlSave?.pending}<DropdownMenu.Label>Saving…</DropdownMenu.Label>{/if}
          {#if controlSave?.error}<DropdownMenu.Label>{controlSave.error}</DropdownMenu.Label>{/if}
          {#if control.unavailable}<DropdownMenu.Label>Saved choice: {control.literal} (unavailable). Choose another setting.</DropdownMenu.Label>{/if}
        {/each}
        {#if localOllama && contractLoading}<DropdownMenu.Label>Checking Thinking options…</DropdownMenu.Label>{/if}
        {#if localOllama && contractError}<DropdownMenu.Label>{contractError}</DropdownMenu.Label>{/if}
        {#if localOllama && !contractLoading && !context?.binding}<DropdownMenu.Label>Thinking options are not verified for this model and Ollama version.</DropdownMenu.Label>{/if}
        {#if api.error}<DropdownMenu.Label>{api.error}</DropdownMenu.Label>{/if}
      </DropdownMenu.Content>
    </DropdownMenu.Root>
  {:else}
    {#each api.controls as control (control.id)}
      {@const controlSave = agent ? getAgentReasoningSave(agent.id, control.key) : undefined}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy"><span class="batshit-settings-form-label">{control.label}</span></div>
        <div class="batshit-settings-form-control">
          <Select.Root type="single" open={open && openedControlId === control.id} onOpenChange={(next) => handleOpenChange(next, control.id)} value={control.selectedValue} onValueChange={(value) => handleApiSelect(control.id, value)}>
            <Select.Trigger class="w-full justify-between" aria-label={control.label} {disabled}>{control.unavailable ? `Saved: ${control.literal} (unavailable)` : control.activeLabel}</Select.Trigger>
            <Select.Content>
              {#each control.options.filter(option => option.available || option.value === 'provider-default') as option (option.value)}
                <Select.Item value={option.value} disabled={!option.available}>{option.label}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {#if control.selectedValue === 'inherit'}<p class="batshit-settings-form-meta">{control.inheritedHelper}</p>{/if}
          {#if controlSave?.pending}<p class="batshit-settings-form-meta">Saving…</p>{/if}
          {#if controlSave?.error}<p class="batshit-settings-form-meta is-error">{controlSave.error}</p>{/if}
          {#if control.unavailable}<p class="batshit-settings-form-meta is-error">Saved choice: {control.literal} (unavailable). Choose another setting.</p>{/if}
        </div>
      </div>
    {/each}
    {#if localOllama && contractLoading}<p class="batshit-settings-form-meta">Checking Thinking options…</p>{/if}
    {#if localOllama && contractError}<p class="batshit-settings-form-meta is-error">{contractError}</p>{/if}
    {#if localOllama && !contractLoading && !context?.binding}<p class="batshit-settings-form-meta">Thinking options are not verified for this model and Ollama version.</p>{/if}
    {#if api.error}<p class="batshit-settings-form-meta is-error">{api.error}</p>{/if}
  {/if}
{/if}

<Dialog.Root open={budgetOpen} onOpenChange={(next) => { if (!budgetSaving) budgetOpen = next }}>
  <Dialog.Content>
    <Dialog.Header>
      <Dialog.Title>Set thinking budget</Dialog.Title>
      <Dialog.Description>A requested reasoning token budget; the model may use fewer or more tokens. Choose Use preset in the menu to clear your override.</Dialog.Description>
    </Dialog.Header>
    <form onsubmit={(event) => { event.preventDefault(); void saveBudget() }}>
      <div class="space-y-2">
        <Label.Root for={`${surface}-reasoning-budget`}>Requested token budget</Label.Root>
        <Input id={`${surface}-reasoning-budget`} value={budgetDraft} disabled={budgetSaving} inputmode="numeric"
          oninput={(event) => { budgetDraft = event.currentTarget.value; budgetError = null }} />
        {#if budgetOwner}<p class="text-sm text-muted-foreground">{api.controls.find(control => control.key === budgetOwner?.key)?.budgetHint}</p>{/if}
        {#if disabled || !canEdit()}<p class="text-sm text-muted-foreground">Wait for Settings to finish updating.</p>{/if}
        {#if budgetError}<p class="text-sm text-destructive" role="alert">{budgetError}</p>{/if}
      </div>
      <Dialog.Footer class="mt-4">
        <Button type="button" variant="outline" disabled={budgetSaving} onclick={() => { budgetOpen = false; budgetError = null }}>Cancel</Button>
        <Button type="submit" disabled={budgetSaving || disabled || !canEdit()}>{budgetSaving ? 'Saving…' : 'Save'}</Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
