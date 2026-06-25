<script lang="ts">
  import { ChevronDown } from '@lucide/svelte'
  import * as DropdownMenu from '$lib/components/ui/dropdown-menu'
  import { toast } from 'svelte-sonner'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { CLAUDE_CLI_MODEL_CHOICES } from '$lib/data/claude-cli-models'
  import ModelProviderIcon from '$lib/components/models/ModelProviderIcon.svelte'
  import type { ClaudeAgentSettings, ClaudePermissionMode } from '$lib/types/claude'

  let open = $state(false)
  const currentAgent = $derived(agentStore.getCurrentAgent())
  const MODE4_PRELAUNCH_REPLACEMENT_PROMPT = 'You are a helpful assistant.'
  const CLAUDE_DEFAULT_MAX_THINKING_TOKENS = 1024

  function getLabel(value: string) {
    return CLAUDE_CLI_MODEL_CHOICES.find((choice) => choice.value === value)?.label ?? value
  }

  const selectedModel = $derived.by(() => {
    const raw = currentAgent?.claude_settings?.model
    if (typeof raw === 'string' && raw.trim().length) return raw.trim()
    return ''
  })

  const label = $derived.by(() => (selectedModel ? getLabel(selectedModel) : 'CLI default'))

  function withDefaults(
    existing: ClaudeAgentSettings | null | undefined,
    model: string
  ): ClaudeAgentSettings {
    const safeExisting = existing ?? ({} as Partial<ClaudeAgentSettings>)

    const rawPermission = safeExisting.permissionMode
    const permissionMode: ClaudePermissionMode =
      rawPermission === 'default' ||
      rawPermission === 'acceptEdits' ||
      rawPermission === 'plan' ||
      rawPermission === 'bypassPermissions'
        ? rawPermission
        : rawPermission === 'chat'
          ? 'default'
          : rawPermission === 'agent'
            ? 'acceptEdits'
            : rawPermission === 'agent_full'
              ? 'bypassPermissions'
              : 'default'

    const trimmedModel = model.trim()
    const alwaysThinkingEnabled = safeExisting.alwaysThinkingEnabled === true
    const maxThinkingTokens = alwaysThinkingEnabled
      ? typeof safeExisting.maxThinkingTokens === 'number' && safeExisting.maxThinkingTokens > 0
        ? safeExisting.maxThinkingTokens
        : CLAUDE_DEFAULT_MAX_THINKING_TOKENS
      : undefined

    return {
      permissionMode,
      model: trimmedModel.length ? trimmedModel : undefined,
      alwaysThinkingEnabled,
      maxThinkingTokens,
      configScope: 'managed',
      systemPromptMode: 'replace',
      systemPrompt: MODE4_PRELAUNCH_REPLACEMENT_PROMPT,
      systemPromptFile: '',
      chrome: safeExisting.chrome === true,
      addDirs: Array.isArray(safeExisting.addDirs) ? [...safeExisting.addDirs] : [],
      allowedTools: Array.isArray(safeExisting.allowedTools) ? [...safeExisting.allowedTools] : [],
      disallowedTools: Array.isArray(safeExisting.disallowedTools) ? [...safeExisting.disallowedTools] : [],
      configOverrides: Array.isArray(safeExisting.configOverrides) ? [...safeExisting.configOverrides] : [],
      workingDirectoryMode: 'project',
      customWorkingDirectory: ''
    }
  }

  async function handleSelect(nextModel: string) {
    if (!currentAgent) return
    try {
      const nextSettings = withDefaults(currentAgent.claude_settings, nextModel)
      await agentStore.updateAgentSettings(currentAgent.id, {
        claude_settings: nextSettings
      })
    } catch (error) {
      console.error('[ClaudeModelSelector] Failed to update Claude model', error)
      toast.error('Unable to save Claude model selection')
    } finally {
      open = false
    }
  }
</script>

<DropdownMenu.Root bind:open>
  <DropdownMenu.Trigger
    class="inline-flex items-center justify-between whitespace-nowrap rounded-full text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 border border-input bg-background hover:bg-accent hover:text-accent-foreground h-8 pl-1 pr-3 py-1 model-selector-trigger"
    aria-label="Claude model"
    title="Claude model"
    data-testid="claude-model-selector"
    data-ab-control="claude-model"
  >
    <div class="flex items-center gap-2 flex-1 min-w-0">
      <ModelProviderIcon
        modelId={selectedModel || 'claude'}
        modelName={label}
        provider="claude"
        badgeProvider="anthropic"
        size="md"
        showOverlay={true}
      />
      <span class="truncate model-selector-label">{label}</span>
    </div>
    <ChevronDown class="h-4 w-4 text-muted-foreground shrink-0" />
  </DropdownMenu.Trigger>

  <DropdownMenu.Content align="start" class="cli-model-selector-dropdown">
    <DropdownMenu.Label>Claude CLI models</DropdownMenu.Label>
    <DropdownMenu.Item onSelect={() => handleSelect('')} class="flex items-center gap-2">
      <ModelProviderIcon
        modelId="claude"
        modelName="CLI default"
        provider="claude"
        badgeProvider="anthropic"
        size="md"
        showOverlay={true}
      />
      <span class="cli-model-selector-label">CLI default</span>
    </DropdownMenu.Item>
    <DropdownMenu.Separator />
    {#each CLAUDE_CLI_MODEL_CHOICES as option (option.value)}
      <DropdownMenu.Item
        onSelect={() => handleSelect(option.value)}
        class={`flex items-center gap-2 ${option.value === selectedModel ? 'border-l-2 border-primary pl-2' : ''}`}
      >
        <ModelProviderIcon
          modelId={option.value}
          modelName={option.label}
          provider="claude"
          badgeProvider="anthropic"
          size="md"
          showOverlay={true}
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
    font-size: 0.75rem;
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
