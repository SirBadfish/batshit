<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
  } from '$lib/components/ui/alert-dialog'
  import { Brain } from '@lucide/svelte'
  import type {
    MemoryEmbeddingDraft,
    MemoryPresetOption
  } from '$lib/components/settings/memory/memoryPanelTypes'

  interface Props {
    draft: MemoryEmbeddingDraft
    indexMeta: Record<string, any> | null
    builtinModels: Array<{ id: string; dims: number }>
    apiProviders: string[]
    /** Saved model presets for the preset picker (utility-purpose presets first). */
    presets?: MemoryPresetOption[]
    saving?: boolean
    reindexing?: boolean
    errorText?: string | null
    /** True when the saved config no longer matches the built index (re-index owed). */
    indexMismatch?: boolean
    onDraftChange: (draft: MemoryEmbeddingDraft) => void
    onSave: () => void | Promise<void>
    onReindex: () => void | Promise<void>
  }

  let {
    draft,
    indexMeta,
    builtinModels,
    apiProviders,
    presets = [],
    saving = false,
    reindexing = false,
    errorText = null,
    indexMismatch = false,
    onDraftChange,
    onSave,
    onReindex
  }: Props = $props()

  let showReindexConfirm = $state(false)

  function patch(partial: Partial<MemoryEmbeddingDraft>) {
    onDraftChange({ ...draft, ...partial })
  }

  const laneLabel = $derived(
    draft.lane === 'builtin'
      ? 'Built-in (local, no API key)'
      : draft.lane === 'preset'
        ? 'Model preset (cloud or local)'
        : draft.lane === 'local-ai'
          ? 'Local AI runtime (legacy)'
          : 'API provider (legacy)'
  )

  // Utility-purpose presets are the intended home for embedding models; when none
  // exist yet, every preset is offered so the flow never dead-ends.
  const utilityPresets = $derived(presets.filter((preset) => preset.purpose === 'utility'))
  const presetOptions = $derived(utilityPresets.length > 0 ? utilityPresets : presets)
  const selectedPreset = $derived(
    presets.find((preset) => preset.id === draft.preset.presetId) ?? null
  )
  const presetTriggerLabel = $derived(
    selectedPreset
      ? `${selectedPreset.modelName} — ${selectedPreset.provider}`
      : draft.preset.presetId
        ? `${draft.preset.modelName || draft.preset.presetId} — ${draft.preset.provider || '?'} (preset missing)`
        : 'Choose a model preset'
  )
</script>

<SettingsAccordionCard name="memory-system" title="Memory System" icon={Brain} open>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About the Memory System" contentClass="w-96">
      <p>
        One embedding model turns memories into searchable meaning for the whole
        instance. The built-in model runs locally with no API key. Changing the model
        requires the re-index action below so every stored memory is re-embedded; until
        then, memory saves and search refuse loudly rather than mixing models.
      </p>
    </SettingsInfoMenu>
  {/snippet}

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-form-label">Embedding Source</Label.Root>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root
          type="single"
          value={draft.lane}
          onValueChange={(value) => {
            const lane = (Array.isArray(value) ? value[0] : value) as MemoryEmbeddingDraft['lane']
            if (lane) patch({ lane })
          }}
        >
          <Select.Trigger class="w-full justify-between">{laneLabel}</Select.Trigger>
          <Select.Content>
            <Select.Item value="builtin">Built-in (local, no API key)</Select.Item>
            <Select.Item value="preset">Model preset (cloud or local)</Select.Item>
            {#if draft.lane === 'local-ai'}
              <Select.Item value="local-ai">Local AI runtime (legacy)</Select.Item>
            {:else if draft.lane === 'api'}
              <Select.Item value="api">API provider (legacy)</Select.Item>
            {/if}
          </Select.Content>
        </Select.Root>
      </div>
    </div>

    {#if draft.lane === 'builtin'}
      <div class="batshit-settings-form-row is-child">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-child-label">Built-in Model</Label.Root>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={draft.modelId}
            onValueChange={(value) => {
              const modelId = Array.isArray(value) ? value[0] : value
              if (modelId) patch({ modelId })
            }}
          >
            <Select.Trigger class="w-full justify-between">
              {draft.modelId.replace('builtin:', '')}
            </Select.Trigger>
            <Select.Content>
              {#each builtinModels as model (model.id)}
                <Select.Item value={model.id}>
                  {model.id.replace('builtin:', '')} ({model.dims}d)
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>
    {:else if draft.lane === 'preset'}
      <div class="batshit-settings-form-row is-child">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-child-label">Embedding Preset</Label.Root>
            <SettingsInfoMenu ariaLabel="About Embedding Presets" contentClass="w-96">
              <p>
                Pick a saved model preset for your embedding model, cloud or local:
                create it in Settings → Models with Purpose set to Utility (for
                example OpenAI text-embedding-3-small, Google gemini-embedding, or
                nomic-embed-text on Ollama). Dimensions are detected automatically on
                save, and known models get their required text prefixes filled in for
                you. Presets routed through OpenRouter or the Vercel gateway cannot
                embed; use a direct connection.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="memory-system-grid">
            <Select.Root
              type="single"
              value={draft.preset.presetId}
              onValueChange={(value) => {
                const presetId = Array.isArray(value) ? value[0] : value
                if (!presetId) return
                const option = presets.find((candidate) => candidate.id === presetId)
                patch({
                  preset: {
                    ...draft.preset,
                    presetId,
                    provider: option?.provider ?? '',
                    modelName: option?.modelId ?? '',
                    // New preset choice: re-detect dims and prefixes on save.
                    dims: 0,
                    documentPrefix: '',
                    queryPrefix: ''
                  }
                })
              }}
            >
              <Select.Trigger class="w-full justify-between">{presetTriggerLabel}</Select.Trigger>
              <Select.Content>
                {#if presetOptions.length === 0}
                  <Select.Item value="" disabled>
                    No model presets yet — create one in Settings → Models
                  </Select.Item>
                {/if}
                {#each presetOptions as option (option.id)}
                  <Select.Item value={option.id}>
                    {option.modelName} — {option.provider}
                  </Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Input
              placeholder="Dimensions (auto-detected on save)"
              type="number"
              value={draft.preset.dims || ''}
              oninput={(event) =>
                patch({
                  preset: {
                    ...draft.preset,
                    dims: parseInt((event.target as HTMLInputElement).value, 10) || 0
                  }
                })}
            />
            <Input
              placeholder="Document prefix (auto for known models)"
              value={draft.preset.documentPrefix}
              oninput={(event) =>
                patch({
                  preset: {
                    ...draft.preset,
                    documentPrefix: (event.target as HTMLInputElement).value
                  }
                })}
            />
            <Input
              placeholder="Query prefix (auto for known models)"
              value={draft.preset.queryPrefix}
              oninput={(event) =>
                patch({
                  preset: {
                    ...draft.preset,
                    queryPrefix: (event.target as HTMLInputElement).value
                  }
                })}
            />
          </div>
          {#if utilityPresets.length === 0 && presets.length > 0}
            <p class="batshit-settings-form-meta">
              Tip: set a preset's Purpose to Utility in Settings → Models to keep this
              list focused on embedding models.
            </p>
          {/if}
        </div>
      </div>
    {:else if draft.lane === 'local-ai'}
      <div class="batshit-settings-form-row is-child">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-child-label">Runtime</Label.Root>
            <SettingsInfoMenu ariaLabel="About Local AI Embeddings" contentClass="w-80">
              <p>
                Any OpenAI-compatible local runtime (Ollama, LM Studio, llama.cpp, vLLM).
                Prefixes are per-model contracts: for nomic-embed-text use
                "search_document: " and "search_query: ". Dims must match the model's
                output exactly.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="memory-system-grid">
            <Input placeholder="Base URL (e.g. http://127.0.0.1:11434/v1)" value={draft.localAi.baseUrl}
              oninput={(event) => patch({ localAi: { ...draft.localAi, baseUrl: (event.target as HTMLInputElement).value } })} />
            <Input placeholder="Model name (e.g. nomic-embed-text)" value={draft.localAi.modelName}
              oninput={(event) => patch({ localAi: { ...draft.localAi, modelName: (event.target as HTMLInputElement).value } })} />
            <Input placeholder="Dimensions (e.g. 768)" type="number" value={draft.localAi.dims || ''}
              oninput={(event) => patch({ localAi: { ...draft.localAi, dims: parseInt((event.target as HTMLInputElement).value, 10) || 0 } })} />
            <Input placeholder="API key (optional; most local runtimes ignore it)" value={draft.localAi.apiKey}
              oninput={(event) => patch({ localAi: { ...draft.localAi, apiKey: (event.target as HTMLInputElement).value } })} />
            <Input placeholder="Document prefix (optional)" value={draft.localAi.documentPrefix}
              oninput={(event) => patch({ localAi: { ...draft.localAi, documentPrefix: (event.target as HTMLInputElement).value } })} />
            <Input placeholder="Query prefix (optional)" value={draft.localAi.queryPrefix}
              oninput={(event) => patch({ localAi: { ...draft.localAi, queryPrefix: (event.target as HTMLInputElement).value } })} />
          </div>
        </div>
      </div>
    {:else}
      <div class="batshit-settings-form-row is-child">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-child-label">Provider</Label.Root>
            <SettingsInfoMenu ariaLabel="About API Embeddings" contentClass="w-80">
              <p>
                Uses a provider embedding model with the API key saved in Settings → API
                Keys (or the environment). Supported now: OpenAI. text-embedding-3-small
                is 1536 dims; text-embedding-3-large is 3072.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="memory-system-grid">
            <Select.Root
              type="single"
              value={draft.api.provider}
              onValueChange={(value) => {
                const provider = Array.isArray(value) ? value[0] : value
                if (provider) patch({ api: { ...draft.api, provider } })
              }}
            >
              <Select.Trigger class="w-full justify-between">{draft.api.provider || 'Choose provider'}</Select.Trigger>
              <Select.Content>
                {#each apiProviders as provider (provider)}
                  <Select.Item value={provider}>{provider}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
            <Input placeholder="Model (e.g. text-embedding-3-small)" value={draft.api.modelName}
              oninput={(event) => patch({ api: { ...draft.api, modelName: (event.target as HTMLInputElement).value } })} />
            <Input placeholder="Dimensions (e.g. 1536)" type="number" value={draft.api.dims || ''}
              oninput={(event) => patch({ api: { ...draft.api, dims: parseInt((event.target as HTMLInputElement).value, 10) || 0 } })} />
          </div>
        </div>
      </div>
    {/if}

    <div class="batshit-settings-form-row is-child">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label.Root class="batshit-settings-child-label">Built Index</Label.Root>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        {#if indexMeta}
          <p class="batshit-settings-form-meta">
            {indexMeta.embedding_model} · {indexMeta.dims}d · last rebuilt
            {new Date(indexMeta.last_rebuilt_at).toLocaleString()}
          </p>
          {#if indexMismatch}
            <p class="batshit-settings-form-help batshit-settings-warning-text">
              The saved configuration does not match the built index. Memory saves and
              search will refuse until you run Re-Index Memories.
            </p>
          {/if}
        {:else}
          <p class="batshit-settings-form-meta">Not built yet (it builds on app start).</p>
        {/if}
      </div>
    </div>

    {#if errorText}
      <p class="batshit-settings-form-help batshit-settings-warning-text">{errorText}</p>
    {/if}

    <div class="batshit-settings-action-row">
      <Button size="sm" onclick={() => onSave()} disabled={saving || reindexing}>
        {saving ? 'Saving...' : 'Save Memory System'}
      </Button>
      <Button
        size="sm"
        variant="outline"
        onclick={() => (showReindexConfirm = true)}
        disabled={saving || reindexing}
      >
        {reindexing ? 'Re-indexing...' : 'Re-Index Memories'}
      </Button>
    </div>
  </div>
</SettingsAccordionCard>

<AlertDialog bind:open={showReindexConfirm}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Re-Index All Memories?</AlertDialogTitle>
      <AlertDialogDescription>
        Every stored memory and graduated segment is re-embedded with the configured
        model, then the search indexes rebuild. Nothing is deleted. This is required
        after changing the embedding model and can take a while on large stores.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel onclick={() => (showReindexConfirm = false)}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onclick={() => {
          showReindexConfirm = false
          onReindex()
        }}
      >
        Re-Index Memories
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

<style>
  .memory-system-grid {
    display: grid;
    grid-template-columns: minmax(0, 1fr) minmax(0, 1fr);
    gap: 0.5rem;
  }

  @media (max-width: 900px) {
    .memory-system-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
