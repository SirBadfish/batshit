<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import type { SavedModel } from '$lib/types/savedModels'
  import {
    MEMORY_IDLE_GAP_MAX_HOURS,
    MEMORY_IDLE_GAP_MIN_HOURS,
    MEMORY_MAX_LINGER_TURNS,
    MEMORY_NAP_THRESHOLD_MAX,
    MEMORY_NAP_THRESHOLD_MIN,
    resolveAgentMemorySettingsDraft,
    type AgentMemorySettingsDraft,
    type MemorySummaryModelMode,
    type MemoryWindowMode
  } from '$lib/utils/memoryControl'

  const SUMMARY_INHERIT_VALUE = 'inherit'
  const SUMMARY_CURRENT_VALUE = 'current'
  const SUMMARY_PRESET_PREFIX = 'preset:'

  interface Props {
    draft?: AgentMemorySettingsDraft | null
    savedModels?: SavedModel[]
    onChange?: (draft: AgentMemorySettingsDraft) => void
  }

  let { draft = null, savedModels = [], onChange = () => {} }: Props = $props()

  const normalized = $derived(
    draft ?? resolveAgentMemorySettingsDraft(null)
  )

  // SA-104 P6: the graduation/nap summary model choice (no hidden model selection).
  const summarySelectionValue = $derived(
    normalized.window.summaryModelMode === 'current'
      ? SUMMARY_CURRENT_VALUE
      : normalized.window.summaryModelMode === 'preset' && normalized.window.summaryModelPresetId
        ? `${SUMMARY_PRESET_PREFIX}${normalized.window.summaryModelPresetId}`
        : SUMMARY_INHERIT_VALUE
  )
  const summarySelectedPreset = $derived(
    normalized.window.summaryModelPresetId
      ? savedModels.find((model) => model.id === normalized.window.summaryModelPresetId) ?? null
      : null
  )

  // SA-104 P5 enable flow (P3 §3.3): flipping ON first prepares the configured
  // embedding model with visible progress (~325MB one-time download on the builtin
  // lane), and only a successful preparation enables memory. Failure keeps it OFF
  // with the error visible.
  let preparing = $state(false)
  let prepareError = $state<string | null>(null)
  let preparePercent = $state<number | null>(null)
  let prepareFile = $state<string | null>(null)

  function patch(partial: Partial<AgentMemorySettingsDraft>) {
    onChange({ ...normalized, ...partial })
  }

  function patchBudget(key: 'onMyMind' | 'triggers' | 'recalled', value: number) {
    patch({ budgets: { ...normalized.budgets, [key]: value } })
  }

  function patchWindow(partial: Partial<AgentMemorySettingsDraft['window']>) {
    patch({ window: { ...normalized.window, ...partial } })
  }

  function handleSummaryModelSelection(value: string | string[] | undefined) {
    const selected = Array.isArray(value) ? value[0] : value
    if (!selected || selected === SUMMARY_INHERIT_VALUE) {
      patchWindow({ summaryModelMode: 'inherit' as MemorySummaryModelMode, summaryModelPresetId: null })
      return
    }
    if (selected === SUMMARY_CURRENT_VALUE) {
      patchWindow({ summaryModelMode: 'current' as MemorySummaryModelMode, summaryModelPresetId: null })
      return
    }
    if (selected.startsWith(SUMMARY_PRESET_PREFIX)) {
      patchWindow({
        summaryModelMode: 'preset' as MemorySummaryModelMode,
        summaryModelPresetId: selected.slice(SUMMARY_PRESET_PREFIX.length)
      })
    }
  }

  async function pollPreparation(): Promise<boolean> {
    for (;;) {
      await new Promise((resolve) => setTimeout(resolve, 900))
      const response = await fetch('/api/memory/embedder/status')
      if (!response.ok) throw new Error(`Preparation status failed (HTTP ${response.status}).`)
      const status = await response.json()
      preparePercent = typeof status.progressPercent === 'number' ? status.progressPercent : null
      prepareFile = typeof status.currentFile === 'string' ? status.currentFile : null
      if (status.state === 'ready') return true
      if (status.state === 'error') {
        throw new Error(status.error || 'Embedding model preparation failed.')
      }
      if (status.state === 'idle') {
        throw new Error('Embedding model preparation did not start. Try again.')
      }
    }
  }

  async function handleEnableToggle(checked: boolean) {
    if (!checked) {
      // Disabling is reversible and harmless: records stay stored; only the agent's
      // access to memory stops. No confirm needed.
      patch({ enabled: false })
      return
    }
    if (preparing) return
    preparing = true
    prepareError = null
    preparePercent = null
    prepareFile = null
    try {
      const startResponse = await fetch('/api/memory/embedder/prepare', { method: 'POST' })
      const startPayload = await startResponse.json().catch(() => null)
      if (!startResponse.ok) {
        throw new Error(startPayload?.error || `Failed to start preparation (HTTP ${startResponse.status}).`)
      }
      if (startPayload?.state !== 'ready') {
        await pollPreparation()
      }
      patch({ enabled: true })
    } catch (error) {
      prepareError = error instanceof Error ? error.message : 'Embedding model preparation failed.'
    } finally {
      preparing = false
    }
  }
</script>

<div class="batshit-settings-form-row">
  <div class="batshit-settings-form-copy">
    <div class="batshit-settings-form-label-line">
      <Label.Root class="batshit-settings-form-label">Agent Memory</Label.Root>
      <SettingsInfoMenu ariaLabel="About Agent Memory" contentClass="w-80">
        <p>
          Gives this agent a persistent memory: things it saves now stay available in future
          chats. Memory is per-agent and works in regular chats and Infinite Sessions alike.
          Enabling downloads the local embedding model once (about 325 MB) so saving and
          searching work with no API key. Everything the agent stores stays fully visible in
          Settings → Memory.
        </p>
      </SettingsInfoMenu>
    </div>
    {#if preparing}
      <p class="batshit-settings-form-help" data-testid="memory-prepare-progress">
        Preparing embedding model{preparePercent !== null ? ` — ${preparePercent}%` : '...'}
        {#if prepareFile}
          <span class="batshit-settings-form-meta">({prepareFile})</span>
        {/if}
      </p>
    {:else if prepareError}
      <p class="batshit-settings-form-help batshit-settings-warning-text">{prepareError}</p>
    {/if}
  </div>
  <div class="batshit-settings-form-control is-inline-status">
    <Switch.Root
      checked={normalized.enabled}
      disabled={preparing}
      onCheckedChange={(checked) => handleEnableToggle(Boolean(checked))}
      data-testid="agent-memory-enabled-toggle"
    />
  </div>
</div>

{#if normalized.enabled}
  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">STM Trigger Linger Default</Label.Root>
        <SettingsInfoMenu ariaLabel="About the STM Trigger Linger Default" contentClass="w-80">
          <p>
            How many messages a trigger-inserted memory stays in context after its trigger
            word was last mentioned (0-{MEMORY_MAX_LINGER_TURNS}; 0 means insert once with
            no re-holds). A Trigger Memory can override this with its own Linger setting,
            including holding for the rest of an episode.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <Input
        type="number"
        min="0"
        max={MEMORY_MAX_LINGER_TURNS}
        step="1"
        value={normalized.lingerTurns}
        oninput={(event) =>
          patch({ lingerTurns: parseInt((event.target as HTMLInputElement).value, 10) })}
      />
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Recall Linger</Label.Root>
        <SettingsInfoMenu ariaLabel="About Recall Linger" contentClass="w-80">
          <p>
            How many messages a memory the agent deliberately searched or recalled stays in
            context after its last relevance (0-{MEMORY_MAX_LINGER_TURNS}).
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <Input
        type="number"
        min="0"
        max={MEMORY_MAX_LINGER_TURNS}
        step="1"
        value={normalized.recallLingerTurns}
        oninput={(event) =>
          patch({ recallLingerTurns: parseInt((event.target as HTMLInputElement).value, 10) })}
      />
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Lane Budgets</Label.Root>
        <SettingsInfoMenu ariaLabel="About Memory Lane Budgets" contentClass="w-80">
          <p>
            Token budgets per insert lane: the Awareness block in the system prompt, trigger
            inserts, and recalled inserts. When matches exceed a budget, the agent sees a
            "More available" note instead of silent truncation.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <div class="memory-budget-grid">
        <label class="memory-budget-cell">
          <span class="batshit-settings-form-meta">Awareness</span>
          <Input
            type="number"
            min="0"
            max="20000"
            step="100"
            value={normalized.budgets.onMyMind}
            oninput={(event) =>
              patchBudget('onMyMind', parseInt((event.target as HTMLInputElement).value, 10))}
          />
        </label>
        <label class="memory-budget-cell">
          <span class="batshit-settings-form-meta">Triggers (STM)</span>
          <Input
            type="number"
            min="0"
            max="20000"
            step="100"
            value={normalized.budgets.triggers}
            oninput={(event) =>
              patchBudget('triggers', parseInt((event.target as HTMLInputElement).value, 10))}
          />
        </label>
        <label class="memory-budget-cell">
          <span class="batshit-settings-form-meta">Recalled (LTM)</span>
          <Input
            type="number"
            min="0"
            max="20000"
            step="100"
            value={normalized.budgets.recalled}
            oninput={(event) =>
              patchBudget('recalled', parseInt((event.target as HTMLInputElement).value, 10))}
          />
        </label>
      </div>
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Infinite Session Window</Label.Root>
        <SettingsInfoMenu ariaLabel="About the Infinite Session Window" contentClass="w-80">
          <p>
            How this agent's Infinite Sessions manage their context window: the guaranteed
            floor of recent conversation that never graduates away, the headroom kept free
            below the model's maximum, the nap trigger (graduate closed episodes, compress
            stale bulk, refresh the whiteboard), the idle gap that closes an episode after a
            break, and the model that writes graduation summaries.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <div class="memory-window-stack">
        <div class="memory-window-line">
          <span class="batshit-settings-form-meta">Floor</span>
          <Select.Root
            type="single"
            value={normalized.window.floorMode}
            onValueChange={(value) =>
              patchWindow({ floorMode: ((Array.isArray(value) ? value[0] : value) ?? 'auto') as MemoryWindowMode })}
          >
            <Select.Trigger class="memory-window-select">
              {normalized.window.floorMode === 'auto' ? 'Automatic' : 'Custom tokens'}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="auto">Automatic</Select.Item>
              <Select.Item value="custom">Custom tokens</Select.Item>
            </Select.Content>
          </Select.Root>
          {#if normalized.window.floorMode === 'custom'}
            <Input
              type="number"
              min="1000"
              step="1000"
              value={normalized.window.floorTokens}
              oninput={(event) =>
                patchWindow({ floorTokens: parseInt((event.target as HTMLInputElement).value, 10) })}
            />
          {/if}
        </div>
        <div class="memory-window-line">
          <span class="batshit-settings-form-meta">Ceiling headroom</span>
          <Select.Root
            type="single"
            value={normalized.window.ceilingHeadroomMode}
            onValueChange={(value) =>
              patchWindow({
                ceilingHeadroomMode: ((Array.isArray(value) ? value[0] : value) ?? 'auto') as MemoryWindowMode
              })}
          >
            <Select.Trigger class="memory-window-select">
              {normalized.window.ceilingHeadroomMode === 'auto' ? 'Automatic' : 'Custom tokens'}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="auto">Automatic</Select.Item>
              <Select.Item value="custom">Custom tokens</Select.Item>
            </Select.Content>
          </Select.Root>
          {#if normalized.window.ceilingHeadroomMode === 'custom'}
            <Input
              type="number"
              min="4096"
              step="1024"
              value={normalized.window.ceilingHeadroomTokens}
              oninput={(event) =>
                patchWindow({
                  ceilingHeadroomTokens: parseInt((event.target as HTMLInputElement).value, 10)
                })}
            />
          {/if}
        </div>
        <div class="memory-window-line">
          <span class="batshit-settings-form-meta">Nap threshold</span>
          <div class="memory-window-percent">
            <Input
              type="number"
              min={MEMORY_NAP_THRESHOLD_MIN}
              max={MEMORY_NAP_THRESHOLD_MAX}
              step="1"
              value={normalized.window.napThresholdPercent}
              oninput={(event) =>
                patchWindow({
                  napThresholdPercent: parseInt((event.target as HTMLInputElement).value, 10)
                })}
            />
            <span class="batshit-settings-form-meta">% of usable context</span>
          </div>
        </div>
        <div class="memory-window-line">
          <span class="batshit-settings-form-meta">Idle gap</span>
          <div class="memory-window-percent">
            <Input
              type="number"
              min={MEMORY_IDLE_GAP_MIN_HOURS}
              max={MEMORY_IDLE_GAP_MAX_HOURS}
              step="1"
              value={normalized.window.idleGapHours}
              oninput={(event) =>
                patchWindow({
                  idleGapHours: parseInt((event.target as HTMLInputElement).value, 10)
                })}
            />
            <span class="batshit-settings-form-meta">hours before an episode closes / an idle chat graduates</span>
          </div>
        </div>
        <div class="memory-window-line">
          <span class="batshit-settings-form-meta">Summary model</span>
          <Select.Root
            type="single"
            value={summarySelectionValue}
            onValueChange={handleSummaryModelSelection}
          >
            <Select.Trigger class="memory-window-select is-wide">
              {summarySelectionValue === SUMMARY_INHERIT_VALUE
                ? 'Use Auto Compact model choice'
                : summarySelectionValue === SUMMARY_CURRENT_VALUE
                  ? "This agent's current model"
                  : summarySelectedPreset?.modelName || summarySelectedPreset?.modelId || 'Saved preset'}
            </Select.Trigger>
            <Select.Content>
              <Select.Item value={SUMMARY_INHERIT_VALUE}>Use Auto Compact model choice</Select.Item>
              <Select.Item value={SUMMARY_CURRENT_VALUE}>This agent's current model</Select.Item>
              {#each savedModels as model (model.id)}
                <Select.Item value={`${SUMMARY_PRESET_PREFIX}${model.id}`}>
                  {model.modelName || model.modelId}
                </Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
        </div>
      </div>
    </div>
  </div>
{/if}

<style>
  .memory-budget-grid {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.5rem;
  }

  .memory-budget-cell {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.25rem;
  }

  .memory-window-stack {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .memory-window-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  /* The shared select trigger is w-full by default; inside these compact rows it
     must stay a bounded control (Josh's 300px field rule) instead of overflowing
     the form column. */
  .memory-window-line > :global(.memory-window-select) {
    flex: 0 1 auto;
    width: 18.75rem;
    max-width: 100%;
    min-width: 9.5rem;
  }

  .memory-window-line > :global(.memory-window-select.is-wide) {
    width: 18.75rem;
  }

  .memory-window-line > :global(input) {
    flex: 0 1 auto;
    width: 8rem;
    max-width: 100%;
  }

  .memory-window-percent {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
</style>
