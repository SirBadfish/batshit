<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SystemPromptEditor from '$lib/components/settings/SystemPromptEditor.svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import { Archive, Edit3, Loader2, RefreshCw } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { setUserSettings } from '$lib/stores/userSettings.svelte'
  import type { UserSettingsRow } from '$lib/types/database'
  import type { SavedModel } from '$lib/types/savedModels'
  import {
    DEFAULT_AUTO_COMPACT_PROMPT,
    getSmartAutoCompactTriggerTokens,
    normalizeGlobalAutoCompactSettings,
    type GlobalAutoCompactSettings
  } from '$lib/utils/contextCompaction'

  const SAVE_DEBOUNCE_MS = 500
  const MODEL_CURRENT_VALUE = 'current'
  const MODEL_PRESET_PREFIX = 'preset:'

  type PanelData = {
    user?: { id: string } | null
    userSettings?: UserSettingsRow | null
  } | null

  interface Props {
    data?: PanelData
    accordionName?: string
    open?: boolean
  }

  let { data = null, accordionName = 'auto-compact-settings', open = true }: Props = $props()

  const userId = $derived(data?.user?.id ?? null)

  let settings = $state<GlobalAutoCompactSettings>(
    normalizeGlobalAutoCompactSettings(null)
  )
  let savedModels = $state<SavedModel[]>([])
  let savedModelsLoading = $state(false)
  let savedModelsError = $state<string | null>(null)
  let isLoading = $state(true)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let persistedSignature = $state(makeSignature(normalizeGlobalAutoCompactSettings(null)))
  let promptEditorOpen = $state(false)

  const smartTriggerPreview = $derived(getSmartAutoCompactTriggerTokens(200_000))
  const modelSelectionValue = $derived(
    settings.modelMode === 'preset' && settings.modelPresetId
      ? `${MODEL_PRESET_PREFIX}${settings.modelPresetId}`
      : MODEL_CURRENT_VALUE
  )
  const selectedPreset = $derived(
    settings.modelPresetId
      ? savedModels.find((model) => model.id === settings.modelPresetId) ?? null
      : null
  )

  onMount(async () => {
    if (!userId) {
      isLoading = false
      return
    }
    await Promise.all([loadSettings(), loadSavedModels()])
  })

  const debouncedSave = debounce(async (payload: GlobalAutoCompactSettings) => {
    try {
      const response = await fetch('/api/user/settings', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          global_auto_compact_settings: payload,
          updated_at: new Date().toISOString()
        })
      })

      if (!response.ok) {
        const message = await extractError(response, 'Failed to save Auto Compact settings')
        throw new Error(message)
      }

      const result = await response.json()
      const updated: UserSettingsRow | null = result?.settings ?? null
      untrack(() => {
        persistedSignature = makeSignature(settings)
        saveState = 'saved'
        saveError = null
      })
      if (updated) setUserSettings(updated)
    } catch (error) {
      console.error('Auto Compact settings save failed:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save Auto Compact settings'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (saveState === 'saved') saveState = 'idle'
        })
      }, 1800)
    }
  }, SAVE_DEBOUNCE_MS)

  $effect(() => {
    if (isLoading || !userId) return
    const signature = makeSignature(settings)
    if (signature === persistedSignature) return

    saveState = 'saving'
    saveError = null
    debouncedSave(settings)
  })

  async function loadSettings() {
    try {
      const response = await fetch('/api/user/settings')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load Auto Compact settings')
        throw new Error(message)
      }
      const result = await response.json()
      const remoteSettings: UserSettingsRow | null = result?.settings ?? null
      const next = normalizeGlobalAutoCompactSettings(
        remoteSettings?.global_auto_compact_settings ?? data?.userSettings?.global_auto_compact_settings
      )
      untrack(() => {
        settings = next
        persistedSignature = makeSignature(next)
      })
      if (remoteSettings) setUserSettings(remoteSettings)
    } catch (error) {
      console.error('Auto Compact settings load failed:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to load Auto Compact settings')
    } finally {
      untrack(() => {
        isLoading = false
      })
    }
  }

  async function loadSavedModels() {
    savedModelsLoading = true
    savedModelsError = null
    try {
      const response = await fetch('/api/user/saved-models')
      if (!response.ok) {
        const message = await extractError(response, 'Failed to load saved models')
        throw new Error(message)
      }
      const payload = await response.json()
      savedModels = Array.isArray(payload?.models) ? payload.models : []
    } catch (error) {
      savedModelsError = error instanceof Error ? error.message : 'Failed to load saved models'
      savedModels = []
    } finally {
      savedModelsLoading = false
    }
  }

  function updateSettings(patch: Partial<GlobalAutoCompactSettings>) {
    settings = normalizeGlobalAutoCompactSettings({
      ...settings,
      ...patch
    })
  }

  function handleModelSelection(value: string | string[] | undefined) {
    const selected = Array.isArray(value) ? value[0] : value
    if (!selected || selected === MODEL_CURRENT_VALUE) {
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
      prompt: prompt.trim() || DEFAULT_AUTO_COMPACT_PROMPT
    })
  }

  function makeSignature(value: GlobalAutoCompactSettings) {
    return JSON.stringify(value)
  }

  async function extractError(response: Response, fallback: string) {
    try {
      const payload = await response.json()
      return payload?.error || payload?.message || fallback
    } catch {
      return fallback
    }
  }
</script>

{#if !userId}
  <div class="batshit-settings-group batshit-settings-caption">
    Sign in to edit Auto Compact settings.
  </div>
{:else if isLoading}
  <div class="batshit-settings-group batshit-settings-caption flex items-center gap-2">
    <Loader2 class="h-4 w-4 animate-spin" aria-hidden="true" />
    <span>Loading Auto Compact settings...</span>
  </div>
{:else}
  <SettingsAccordionCard
    name={accordionName}
    title="Auto Compact"
    icon={Archive}
    contentClass="space-y-5"
    {open}
  >
    {#snippet info()}
      <SettingsInfoMenu ariaLabel="About Auto Compact" contentClass="w-96">
        <p>
          Compact creates a permanent summary of older chat context. Manual Trim remains separate
          and reversible until compacted messages are included in a compact summary.
        </p>
      </SettingsInfoMenu>
    {/snippet}
    {#snippet actions()}
      <SettingsSaveStatus
        state={saveError ? 'error' : saveState}
        error={saveError}
        savingLabel="Saving Auto Compact..."
        savedLabel="Saved"
        sticky={false}
      />
    {/snippet}

    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Automatic Behavior</Label.Root>
            <SettingsInfoMenu ariaLabel="About Automatic Auto Compact Behavior" contentClass="w-80">
              <p>
                Ask first shows a confirmation before compacting. Run automatically compacts when the
                trigger is reached. Off disables global automatic compacting.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={settings.mode}
            onValueChange={(value) =>
              updateSettings({ mode: (Array.isArray(value) ? value[0] : value) as GlobalAutoCompactSettings['mode'] })}
          >
            <Select.Trigger class="w-full justify-between">
              {settings.mode === 'auto'
                ? 'Run automatically'
                : settings.mode === 'ask'
                  ? 'Ask first'
                  : 'Off'}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="ask">Ask first</Select.Item>
              <Select.Item value="auto">Run automatically</Select.Item>
              <Select.Item value="off">Off</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Trigger</Label.Root>
            <SettingsInfoMenu ariaLabel="About Auto Compact Trigger" contentClass="w-80">
              <p>
                Smart uses 15% remaining, clamped between 30k and 80k tokens. Custom remaining
                tokens lets you set the exact remaining-context threshold.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="flex flex-col gap-3">
            <Select.Root
              type="single"
              value={settings.triggerMode}
              onValueChange={(value) =>
                updateSettings({ triggerMode: (Array.isArray(value) ? value[0] : value) as GlobalAutoCompactSettings['triggerMode'] })}
            >
              <Select.Trigger class="w-full justify-between">
                {settings.triggerMode === 'smart'
                  ? `Smart (${Math.round(smartTriggerPreview / 1000)}k on a 200k model)`
                  : 'Custom remaining tokens'}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="smart">Smart 15%</Select.Item>
                <Select.Item value="remaining_tokens">Custom remaining tokens</Select.Item>
              </Select.Content>
            </Select.Root>
            {#if settings.triggerMode === 'remaining_tokens'}
              <Input
                type="number"
                min="1000"
                step="1000"
                value={settings.remainingTokens ?? 50_000}
                oninput={(event) =>
                  updateSettings({
                    remainingTokens: parseInt((event.target as HTMLInputElement).value, 10)
                  })}
              />
            {/if}
          </div>
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Compact Model</Label.Root>
            <SettingsInfoMenu ariaLabel="About Auto Compact Model" contentClass="w-80">
              <p>
                Current chat model uses whichever model is active when compacting starts. A saved
                model preset lets compacting use a dedicated API-compatible utility model.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="batshit-settings-field-cluster">
            <Select.Root
              type="single"
              value={modelSelectionValue}
              onValueChange={handleModelSelection}
            >
              <Select.Trigger class="w-full justify-between">
                {#if settings.modelMode === 'current'}
                  Current chat model
                {:else if selectedPreset}
                  {selectedPreset.modelName}
                {:else}
                  Choose a saved model preset
                {/if}
              </Select.Trigger>
              <Select.Content>
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
              onclick={loadSavedModels}
              disabled={savedModelsLoading}
              title="Refresh saved models"
            >
              <RefreshCw class={savedModelsLoading ? 'animate-spin' : ''} />
            </Button>
          </div>
          {#if savedModelsError}
            <p class="batshit-settings-form-meta is-error">{savedModelsError}</p>
          {/if}
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Compact Prompt</Label.Root>
            <SettingsInfoMenu ariaLabel="About Auto Compact Prompt" contentClass="w-80">
              <p>
                The compact prompt tells Batshit how to summarize older context. Use a custom prompt
                only when summaries should preserve a specific kind of detail.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control is-inline-status">
          <Badge variant="outline" class="batshit-settings-spine-badge">
            {settings.promptMode === 'custom' ? 'Custom prompt' : 'Default prompt'}
          </Badge>
          <Button variant="outline" size="sm" onclick={() => (promptEditorOpen = true)}>
            <Edit3 class="h-4 w-4" />
            Edit
          </Button>
        </div>
      </div>
    </div>
  </SettingsAccordionCard>
{/if}

<SystemPromptEditor
  bind:open={promptEditorOpen}
  title="Auto Compact Prompt"
  description="Prompt used when Batshit summarizes older chat context."
  prompt={settings.prompt}
  width="large"
  onSave={savePrompt}
/>
