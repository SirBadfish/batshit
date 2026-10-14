<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { toast } from 'svelte-sonner'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { chatBarBlockSave } from '$lib/utils/chatBarBlockSave'
  import { CODEX_SUBMODEL_CHOICES, supportsCodexFastMode, supportsCodexXhighReasoning } from '$lib/data/codex-models'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import type { CodexAgentSettings, CodexPermissionMode, CodexApproval, CodexSandbox } from '$lib/types/codex'

  let open = $state(false)
  const currentAgent = $derived(agentStore.getCurrentAgent())

  function getLabel(value: string) {
    return CODEX_SUBMODEL_CHOICES.find((choice) => choice.value === value)?.label ?? value
  }

  function withDefaults(existing: CodexAgentSettings | null | undefined, model: string): CodexAgentSettings {
    const safeExisting = existing ?? ({} as Partial<CodexAgentSettings>)

    const permissionMode: CodexPermissionMode =
      safeExisting.permissionMode === 'agent' || safeExisting.permissionMode === 'agent_full'
        ? safeExisting.permissionMode
        : 'chat'

    const sandbox: CodexSandbox =
      safeExisting.sandbox === 'workspace-write' || safeExisting.sandbox === 'danger-full-access'
        ? safeExisting.sandbox
        : 'read-only'

    const approval: CodexApproval = safeExisting.approval === 'on-request' ? 'on-request' : 'never'

    const rawReasoning = safeExisting.reasoningEffort ?? 'default'
    const allowsXhigh = supportsCodexXhighReasoning(model)
    const reasoningEffort = rawReasoning === 'xhigh' && !allowsXhigh ? 'high' : rawReasoning
    const rawServiceTier = safeExisting.serviceTier ?? 'standard'
    const serviceTier = rawServiceTier === 'fast' && supportsCodexFastMode(model) ? 'fast' : 'standard'

    return {
      permissionMode,
      model,
      profileId: safeExisting.profileId,
      reasoningEffort,
      serviceTier,
      streamingEffect: true,
      search: safeExisting.search !== false,
      sandbox,
      approval,
      addDirs: Array.isArray(safeExisting.addDirs) ? [...safeExisting.addDirs] : [],
      enableFeatures: Array.isArray(safeExisting.enableFeatures) ? [...safeExisting.enableFeatures] : [],
      disableFeatures: Array.isArray(safeExisting.disableFeatures) ? [...safeExisting.disableFeatures] : [],
      configOverrides: Array.isArray(safeExisting.configOverrides) ? [...safeExisting.configOverrides] : [],
      workingDirectoryMode: 'project',
      customWorkingDirectory: '',
      configScope: 'managed',
      unifiedExec: true,
      historyPersistence: safeExisting.historyPersistence
    }
  }

  const selectedModel = $derived.by(() => {
    const fromAgent = currentAgent?.codex_settings?.model
    if (typeof fromAgent === 'string' && fromAgent.trim().length) return fromAgent.trim()
    return CODEX_SUBMODEL_CHOICES[0]?.value ?? 'gpt-6-astra'
  })

  async function handleSelect(nextModel: string) {
    if (!currentAgent) return
    try {
      // BL-848: only the model, always sent (a pick the copy already shows must still write it: the
      // record may hold another), and what the new model implies: a model that does not support
      // Extra High or the fast service tier always sends the reasoning effort or service tier it
      // needs, though the value equals the copy (the record may hold the one it cannot run). A
      // model that supports them leaves a reasoning effort or speed chosen in another window alone.
      // The server writes the Codex settings key by key, so every other key stays.
      const viewedSettings = withDefaults(currentAgent.codex_settings, selectedModel)
      const nextSettings = withDefaults(currentAgent.codex_settings, nextModel)
      // Trade-off: for a model without Extra High the effort sent is the COPY's, clamped
      // (`withDefaults`). It clears an Extra High another window saved (a model that cannot run it),
      // but it also writes over a supported effort saved there since (the copy shows medium, the
      // record holds low). Today every model the list holds supports both, so only a model outside
      // the list reaches this.
      const group = ['model']
      if (!supportsCodexXhighReasoning(nextModel)) group.push('reasoningEffort')
      if (!supportsCodexFastMode(nextModel)) group.push('serviceTier')
      await agentStore.updateAgentSettings(
        currentAgent.id,
        chatBarBlockSave('codex_settings', currentAgent.codex_settings, viewedSettings, nextSettings, { group })
      )
    } catch (error) {
      console.error('[CodexModelSelector] Failed to update Codex model', error)
      toast.error('Unable to save Codex model selection')
    } finally {
      open = false
    }
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class="inline-flex items-center justify-between whitespace-nowrap rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 pl-1 pr-3 py-1 model-selector-trigger"
    aria-label="Codex model"
    title="Codex model"
    data-testid="codex-model-selector"
    data-ab-control="codex-model"
  >
    <div class="flex items-center gap-2 flex-1 min-w-0">
      <ModelProviderIcon
        modelId={selectedModel}
        modelName={getLabel(selectedModel)}
        provider="openai"
        size="md"
        showOverlay={true}
        badgeProvider="codex"
      />
      <span class="truncate model-selector-label">{getLabel(selectedModel)}</span>
    </div>
    <ChevronDown class="h-4 w-4 text-muted-foreground shrink-0" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="start" class="cli-model-selector-dropdown">
    <DropdownMenu.Label>Codex models</DropdownMenu.Label>
    {#each CODEX_SUBMODEL_CHOICES as option (option.value)}
      <DropdownMenu.Item
        onSelect={() => handleSelect(option.value)}
        class={`flex items-center gap-2 ${option.value === selectedModel ? 'border-l-2 border-primary-text pl-2' : ''}`}
      >
        <ModelProviderIcon
          modelId={option.value}
          modelName={option.label}
          provider="openai"
          size="md"
          showOverlay={true}
          badgeProvider="codex"
        />
        <span class="cli-model-selector-label">{option.label}</span>
      </DropdownMenu.Item>
    {/each}
  </DropdownMenu.Content>
</DropdownMenu.Root>

<style>
  :global(.cli-model-selector-dropdown) {
    width: max-content;
    min-width: 16.25rem;
    max-width: min(26.25rem, calc(100vw - 2rem));
  }

  :global(.cli-model-selector-dropdown .bs-dropdown-item) {
    min-width: 0;
  }

  :global(.model-selector-trigger) {
    width: fit-content;
    min-width: 10rem;
    max-width: min(18rem, 32vw);
    flex: 0 1 auto;
  }

  .model-selector-label {
    min-width: 0;
    overflow: hidden;
    font-size: 0.75rem;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .cli-model-selector-label {
    flex: 1 1 auto;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @container chat-column (max-width: 650px) {
    :global(.model-selector-trigger) {
      width: 60px;
      min-width: 60px;
      max-width: 60px;
      padding-left: 0.5rem;
      padding-right: 0.5rem;
    }
  }
</style>
