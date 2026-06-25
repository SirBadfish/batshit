<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import SystemPromptEditor from '$lib/components/settings/SystemPromptEditor.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { Edit3, RefreshCw } from '@lucide/svelte'
  import type { SavedModel } from '$lib/types/savedModels'
  import {
    DEFAULT_AUTO_COMPACT_PROMPT,
    normalizeAgentAutoCompactSettings,
    type AgentAutoCompactSettings
  } from '$lib/utils/contextCompaction'

  const MODEL_INHERIT_VALUE = 'inherit'
  const MODEL_CURRENT_VALUE = 'current'
  const MODEL_PRESET_PREFIX = 'preset:'

  interface Props {
    settings?: AgentAutoCompactSettings | null
    savedModels?: SavedModel[]
    savedModelsLoading?: boolean
    savedModelsError?: string | null
    onRefreshModels?: () => void | Promise<void>
    onChange?: (settings: AgentAutoCompactSettings) => void
  }

  let {
    settings = null,
    savedModels = [],
    savedModelsLoading = false,
    savedModelsError = null,
    onRefreshModels = () => {},
    onChange = () => {}
  }: Props = $props()

  let promptEditorOpen = $state(false)
  const normalized = $derived(normalizeAgentAutoCompactSettings(settings))
  const modelSelectionValue = $derived(
    normalized.modelMode === 'inherit'
      ? MODEL_INHERIT_VALUE
      : normalized.modelMode === 'current'
        ? MODEL_CURRENT_VALUE
        : normalized.modelPresetId
          ? `${MODEL_PRESET_PREFIX}${normalized.modelPresetId}`
          : MODEL_INHERIT_VALUE
  )
  const selectedPreset = $derived(
    normalized.modelPresetId
      ? savedModels.find((model) => model.id === normalized.modelPresetId) ?? null
      : null
  )

  function updateSettings(patch: Partial<AgentAutoCompactSettings>) {
    onChange(normalizeAgentAutoCompactSettings({ ...normalized, ...patch }))
  }

  function handleModelSelection(value: string | string[] | undefined) {
    const selected = Array.isArray(value) ? value[0] : value
    if (!selected || selected === MODEL_INHERIT_VALUE) {
      updateSettings({ modelMode: 'inherit', modelPresetId: null })
      return
    }
    if (selected === MODEL_CURRENT_VALUE) {
      updateSettings({ modelMode: 'current', modelPresetId: null })
      return
    }
    if (selected.startsWith(MODEL_PRESET_PREFIX)) {
      updateSettings({
        modelMode: 'preset',
        modelPresetId: selected.slice(MODEL_PRESET_PREFIX.length)
      })
    }
  }

  function savePrompt(prompt: string) {
    updateSettings({
      promptMode: prompt.trim() === DEFAULT_AUTO_COMPACT_PROMPT ? 'default' : 'custom',
      prompt: prompt.trim()
    })
  }
</script>

  <div class="batshit-settings-form-row">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-form-label">Auto Compact</Label.Root>
        <SettingsInfoMenu ariaLabel="About Agent Auto Compact" contentClass="w-80">
          <p>
            Agent overrides can inherit global Auto Compact settings, disable compacting for this
            agent, or choose a different compact model and prompt.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <Select.Root
        type="single"
        value={normalized.mode}
        onValueChange={(value) =>
          updateSettings({ mode: (Array.isArray(value) ? value[0] : value) as AgentAutoCompactSettings['mode'] })}
      >
        <Select.Trigger class="w-full justify-between">
          {normalized.mode === 'inherit'
            ? 'Inherit global setting'
            : normalized.mode === 'auto'
              ? 'Run automatically'
              : normalized.mode === 'ask'
                ? 'Ask first'
                : 'Off'}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="inherit">Inherit global setting</Select.Item>
          <Select.Item value="ask">Ask first</Select.Item>
          <Select.Item value="auto">Run automatically</Select.Item>
          <Select.Item value="off">Off</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Trigger</Label.Root>
        <SettingsInfoMenu ariaLabel="About Agent Auto Compact Trigger" contentClass="w-80">
          <p>
            Inherit uses the global trigger. Smart uses the global smart threshold. Custom remaining
            tokens lets this agent compact at its own remaining-context threshold.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <div class="flex flex-col gap-3">
        <Select.Root
          type="single"
          value={normalized.triggerMode}
          onValueChange={(value) =>
            updateSettings({ triggerMode: (Array.isArray(value) ? value[0] : value) as AgentAutoCompactSettings['triggerMode'] })}
        >
          <Select.Trigger class="w-full justify-between">
            {normalized.triggerMode === 'inherit'
              ? 'Inherit global trigger'
              : normalized.triggerMode === 'smart'
                ? 'Smart 15%'
                : 'Custom remaining tokens'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="inherit">Inherit global trigger</Select.Item>
            <Select.Item value="smart">Smart 15%</Select.Item>
            <Select.Item value="remaining_tokens">Custom remaining tokens</Select.Item>
          </Select.Content>
        </Select.Root>
        {#if normalized.triggerMode === 'remaining_tokens'}
          <Input
            type="number"
            min="1000"
            step="1000"
            value={normalized.remainingTokens ?? 50_000}
            oninput={(event) =>
              updateSettings({
                remainingTokens: parseInt((event.target as HTMLInputElement).value, 10)
              })}
          />
        {/if}
      </div>
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Compact Model</Label.Root>
        <SettingsInfoMenu ariaLabel="About Agent Auto Compact Model" contentClass="w-80">
          <p>
            Inherit uses the global compact model. Current chat model uses this agent's active
            model, and a saved preset can pin compacting to a specific API-compatible model.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <div class="flex min-w-0 items-center gap-2">
        <Select.Root
          type="single"
          value={modelSelectionValue}
          onValueChange={handleModelSelection}
        >
          <Select.Trigger class="w-full justify-between">
            {#if normalized.modelMode === 'inherit'}
              Inherit global model
            {:else if normalized.modelMode === 'current'}
              Current chat model
            {:else if selectedPreset}
              {selectedPreset.modelName}
            {:else}
              Choose saved model preset
            {/if}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value={MODEL_INHERIT_VALUE}>Inherit global model</Select.Item>
            <Select.Item value={MODEL_CURRENT_VALUE}>Current chat model</Select.Item>
            {#if savedModelsLoading}
              <Select.Label>Loading models...</Select.Label>
            {:else if savedModels.length === 0}
              <Select.Label>No saved models yet</Select.Label>
            {:else}
              {#each savedModels as model (model.id)}
                <Select.Item value={`${MODEL_PRESET_PREFIX}${model.id}`}>
                  <div class="flex min-w-0 flex-col">
                    <span class="truncate">{model.modelName}</span>
                    <span class="batshit-settings-caption batshit-model-id truncate">{model.modelId}</span>
                  </div>
                </Select.Item>
              {/each}
            {/if}
          </Select.Content>
        </Select.Root>
        <Button
          variant="ghost"
          size="icon"
          onclick={onRefreshModels}
          disabled={savedModelsLoading}
          title="Refresh saved models"
        >
          <RefreshCw class={savedModelsLoading ? 'animate-spin' : ''} />
        </Button>
      </div>
      {#if savedModelsError}
        <p class="batshit-settings-form-meta text-destructive">{savedModelsError}</p>
      {/if}
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Compact Prompt</Label.Root>
        <SettingsInfoMenu ariaLabel="About Agent Auto Compact Prompt" contentClass="w-80">
          <p>
            Inherit uses the global compact prompt. Custom prompts only affect summaries created
            for this agent.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control is-inline-status">
      <Badge variant="outline" class="batshit-settings-spine-badge">
        {normalized.promptMode === 'inherit'
          ? 'Inherits global prompt'
          : normalized.promptMode === 'custom'
            ? 'Custom prompt'
            : 'Default prompt'}
      </Badge>
      <Button variant="outline" size="sm" onclick={() => (promptEditorOpen = true)}>
        <Edit3 class="h-4 w-4" />
        Edit
      </Button>
    </div>
  </div>

<SystemPromptEditor
  bind:open={promptEditorOpen}
  title="Agent Auto Compact Prompt"
  description="Prompt override used when this agent compacts older chat context."
  prompt={normalized.prompt || DEFAULT_AUTO_COMPACT_PROMPT}
  width="large"
  onSave={savePrompt}
/>
