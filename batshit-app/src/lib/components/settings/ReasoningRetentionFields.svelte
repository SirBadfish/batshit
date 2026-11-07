<script lang="ts">
  import { untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { Input } from '$lib/components/ui/input'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { API_REASONING_RETENTION_DEFAULT_MODE, API_REASONING_RETENTION_MODES, resolveApiReasoningRetention,
    validWhiteboardBudget, type AgentReasoningRetention } from '$lib/utils/reasoningRetention'

  let { value, disabled = false, ownerId = '', onChange } = $props<{
    value: AgentReasoningRetention
    disabled?: boolean
    ownerId?: string
    onChange: (patch: AgentReasoningRetention) => void
  }>()
  const labels = { whiteboard: 'Whiteboard Only', preserve: 'Preserve Reasoning Only', both: 'Whiteboard + Preserved Reasoning', neither: 'Neither' }
  const effective = $derived.by(() => {
    try { return { settings: resolveApiReasoningRetention(value), error: null } }
    catch (error) { return { settings: null, error: error instanceof Error ? error.message : 'Invalid retention settings.' } }
  })
  const mode = $derived(value.api_reasoning_retention ?? API_REASONING_RETENTION_DEFAULT_MODE)
  const display = $derived(value.show_whiteboard === false ? 'disabled' : 'enabled')
  let budgetDraft = $state('')
  let budgetError = $state<string | null>(null)
  let budgetDirty = $state(false)
  let priorOwner = untrack(() => ownerId)
  let openedOwner: string | null = null
  let budgetOwner: string | null = null
  const canChange = () => !disabled && openedOwner === ownerId
  $effect(() => {
    const incoming = value.whiteboard_budget_tokens ?? 1500
    if (ownerId !== priorOwner) { priorOwner = ownerId; budgetDirty = false }
    if (!budgetDirty) { budgetDraft = String(incoming); budgetError = null }
  })
  function saveBudget() {
    if (disabled || budgetOwner !== ownerId || !budgetDirty) return
    const budget = budgetDraft.trim() ? Number(budgetDraft) : NaN
    if (!validWhiteboardBudget(budget)) { budgetError = 'Enter a whole number from 250 to 16,000.'; return }
    budgetError = null
    onChange({ whiteboard_budget_tokens: budget })
    budgetDirty = false
  }
</script>

<div class="space-y-3">
  <div class="batshit-settings-form-row">
    <div class="batshit-settings-form-copy">
      <span class="batshit-settings-form-label-line">
        <span class="batshit-settings-form-label">Reasoning Retention</span>
        <SettingsInfoMenu ariaLabel="About Reasoning Retention">
          This agent can maintain working conclusions on a Whiteboard and preserve available reasoning in later model context. These choices are independent of what you display in chat. They do not control how much reasoning a model generates. Whiteboards belong to one agent in this chat and continue across Infinite Session episodes, independently of long-term Memory.
        </SettingsInfoMenu>
      </span>
    </div>
    <div class="batshit-settings-form-control">
      <Select.Root type="single" value={mode} onOpenChange={(open) => { if (open) openedOwner = ownerId }}
        onValueChange={(next) => { if (canChange() && next) onChange({ api_reasoning_retention: next as AgentReasoningRetention['api_reasoning_retention'] }) }}>
        <Select.Trigger size="sm" class="batshit-settings-select-compact" {disabled} aria-label="Reasoning Retention">
          {labels[mode as keyof typeof labels]}
        </Select.Trigger>
        <Select.Content>
          {#each API_REASONING_RETENTION_MODES as option}<Select.Item value={option} label={labels[option]}>{labels[option]}</Select.Item>{/each}
        </Select.Content>
      </Select.Root>
      {#if effective.error}<p class="batshit-settings-form-meta is-error" role="alert">{effective.error}</p>{/if}
    </div>
  </div>
  {#if effective.settings?.whiteboardEnabled}
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <span class="batshit-settings-form-label-line">
          <span class="batshit-settings-child-label">Display Whiteboard</span>
          <SettingsInfoMenu ariaLabel="About Display Whiteboard">Shows a read-only, copyable floating panel on the latest agent reply. Hiding it keeps saving and model delivery enabled. Disabling Whiteboard in Reasoning Retention keeps the saved notes and these preferences for later.</SettingsInfoMenu>
        </span>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root type="single" value={display} onOpenChange={(open) => { if (open) openedOwner = ownerId }}
          onValueChange={(next) => { if (canChange() && next) onChange({ show_whiteboard: next === 'enabled' }) }}>
          <Select.Trigger size="sm" class="batshit-settings-select-compact" {disabled} aria-label="Display Whiteboard">
            {display === 'enabled' ? 'Enabled' : 'Disabled'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="enabled" label="Enabled">Enabled</Select.Item>
            <Select.Item value="disabled" label="Disabled">Disabled</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
    </div>
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <span class="batshit-settings-form-label-line">
          <span class="batshit-settings-child-label">Whiteboard Budget</span>
          <SettingsInfoMenu ariaLabel="About Whiteboard Budget">Estimated tokens, roughly one per four characters. This is available space, not a target. Oversized replacements are refused and the saved board stays intact. Lowering the limit keeps existing notes in full until the agent writes a shorter replacement.</SettingsInfoMenu>
        </span>
      </div>
      <div class="batshit-settings-form-control">
        <Input type="number" min="250" max="16000" step="250" aria-label="Whiteboard Budget (estimated tokens)"
          disabled={disabled} value={budgetDraft} onfocus={() => budgetOwner = ownerId} oninput={(event) => { budgetDraft = event.currentTarget.value; budgetDirty = true }} onblur={saveBudget} onkeydown={(event) => { if (event.key === 'Enter') saveBudget() }} />
        {#if budgetError}<p class="batshit-settings-form-meta is-error" role="alert">{budgetError}</p>{/if}
      </div>
    </div>
  {/if}
</div>
