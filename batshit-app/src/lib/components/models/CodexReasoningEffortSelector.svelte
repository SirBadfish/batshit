<script lang="ts">
  import { Brain, ChevronDown } from '@lucide/svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { toast } from 'svelte-sonner'
  import * as agentStore from '$lib/stores/agents.svelte'
  import {
    CODEX_XHIGH_REASONING_HELPER_TEXT,
    supportsCodexFastMode,
    supportsCodexXhighReasoning
  } from '$lib/data/codex-models'
  import type { CodexAgentSettings, CodexPermissionMode, CodexApproval, CodexSandbox } from '$lib/types/codex'

  const REASONING_OPTIONS: Array<{
    value: 'default' | 'low' | 'medium' | 'high' | 'xhigh'
    triggerLabel: string
    menuLabel: string
    helper: string
  }> = [
    { value: 'default', triggerLabel: 'Auto', menuLabel: 'Auto', helper: 'Use provider default' },
    { value: 'low', triggerLabel: 'Low', menuLabel: 'Low', helper: 'Faster, fewer deliberations' },
    { value: 'medium', triggerLabel: 'Medium', menuLabel: 'Medium', helper: 'Balanced effort' },
    { value: 'high', triggerLabel: 'High', menuLabel: 'High', helper: 'Slowest, more careful planning' },
    { value: 'xhigh', triggerLabel: 'XHigh', menuLabel: 'Extra High', helper: CODEX_XHIGH_REASONING_HELPER_TEXT }
  ]

  let open = $state(false)
  const currentAgent = $derived(agentStore.getCurrentAgent())

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

    const approval: CodexApproval =
      safeExisting.approval === 'on-request' || safeExisting.approval === 'on-failure' || safeExisting.approval === 'untrusted'
        ? safeExisting.approval
        : 'never'

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
    return 'gpt-5'
  })

  const selectedReasoning = $derived.by(() => {
    const raw = currentAgent?.codex_settings?.reasoningEffort ?? 'default'
    const allowsXhigh = supportsCodexXhighReasoning(selectedModel)
    if (raw === 'xhigh' && !allowsXhigh) return 'high'
    return raw
  })

  const availableOptions = $derived.by(() => {
    if (supportsCodexXhighReasoning(selectedModel)) return REASONING_OPTIONS
    return REASONING_OPTIONS.filter((option) => option.value !== 'xhigh')
  })

  const activeOption = $derived.by(() => {
    return availableOptions.find((option) => option.value === selectedReasoning) ?? availableOptions[0] ?? REASONING_OPTIONS[0]
  })

  async function handleSelect(nextReasoning: (typeof REASONING_OPTIONS)[number]['value']) {
    if (!currentAgent) return
    const allowsXhigh = supportsCodexXhighReasoning(selectedModel)
    const clamped = nextReasoning === 'xhigh' && !allowsXhigh ? 'high' : nextReasoning

    try {
      const nextSettings = withDefaults(currentAgent.codex_settings, selectedModel)
      nextSettings.reasoningEffort = clamped

      const nextProviderSettings = { ...(currentAgent.provider_specific_settings ?? {}) }
      if (clamped === 'default') {
        delete nextProviderSettings.codex_reasoning_effort
      } else {
        nextProviderSettings.codex_reasoning_effort = clamped
      }

      await agentStore.updateAgentSettings(currentAgent.id, {
        codex_settings: nextSettings,
        provider_specific_settings: nextProviderSettings
      })
    } catch (error) {
      console.error('[CodexReasoningEffortSelector] Failed to update reasoning effort', error)
      toast.error('Unable to save reasoning effort')
    } finally {
      open = false
    }
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class="inline-flex h-8 min-w-[110px] items-center justify-between gap-2 rounded-full border border-input bg-background px-3 text-sm font-medium transition-colors hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring mode-selector-trigger codex-reasoning-selector"
    aria-label="Codex reasoning effort"
    title="Codex reasoning effort"
    data-testid="codex-reasoning-selector"
    data-ab-control="codex-reasoning-effort"
  >
    <div class="flex items-center gap-2 min-w-0 mode-selector-inner">
      <Brain class="h-4 w-4 shrink-0 text-muted-foreground" />
      <span class="truncate mode-selector-label">{activeOption.triggerLabel}</span>
    </div>
    <ChevronDown class="h-4 w-4 shrink-0 text-muted-foreground" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="start" class="w-[230px]">
    <DropdownMenu.Label>Reasoning effort</DropdownMenu.Label>
    <DropdownMenu.RadioGroup value={selectedReasoning}>
      {#each availableOptions as option (option.value)}
        <DropdownMenu.RadioItem
          value={option.value}
          onSelect={() => handleSelect(option.value)}
          class={`mode-item flex items-center gap-2 border-l-2 border-r-2 pl-2 pr-2 ${
            option.value === selectedReasoning ? 'border-primary text-foreground' : 'border-transparent text-muted-foreground'
          }`}
        >
          <Brain class="h-4 w-4 shrink-0" />
          <div class="flex flex-col min-w-0">
            <span class="truncate">{option.menuLabel}</span>
            <span class="text-[11px] text-muted-foreground truncate">{option.helper}</span>
          </div>
        </DropdownMenu.RadioItem>
      {/each}
    </DropdownMenu.RadioGroup>
  </DropdownMenu.Content>
</DropdownMenu.Root>
