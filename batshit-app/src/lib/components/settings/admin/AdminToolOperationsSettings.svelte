<script lang="ts">
  import { onDestroy, untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import AdminWebSearchCard from './AdminWebSearchCard.svelte'
  import AdminAgentBrowserDefaultsCard, { type AgentBrowserOperationalPatch } from './AdminAgentBrowserDefaultsCard.svelte'
  import type { NativeWebSearchProvider } from './adminSettingsTypes'
  import { WEB_SEARCH_PROVIDER_LABELS } from './adminSettingsTypes'
  import type { ToolOperationalSettings } from '$lib/utils/toolOperationalSettings'
  import { parseToolOperationsResponse, type ToolOperationsClientSnapshot } from '$lib/utils/toolOperationalSettingsSave'
  import { acceptToolOperationsSourceAck, getToolOperationsSource, refreshToolOperationsSource, setToolOperationsOwner } from '$lib/stores/toolOperationalSettings.svelte'

  let { userId, providerAvailability, loadingProviders, providerError, availabilityLoaded = true }: {
    userId: string | null
    providerAvailability: Record<'exa' | 'perplexity', boolean>
    loadingProviders: boolean
    providerError: string | null
    availabilityLoaded?: boolean
  } = $props()
  let base = $state.raw<ToolOperationsClientSnapshot | null>(null)
  let draft = $state<ToolOperationalSettings | null>(null)
  let phase = $state<'loading' | 'ready' | 'queued' | 'saving' | 'conflict' | 'unknown' | 'failed'>('loading')
  let message = $state<string | null>(null)
  let dirty = $state(false)
  let generation = 0
  let queuedPatch: Record<string, unknown> = {}
  let timer: ReturnType<typeof setTimeout> | undefined
  const source = $derived(getToolOperationsSource())
  const disabled = $derived(phase !== 'ready' && phase !== 'queued' || !base || base.containerized === undefined || source.owner !== userId || source.status !== 'confirmed')
  function adopt(snapshot: ToolOperationsClientSnapshot) {
    base = snapshot; draft = structuredClone(snapshot.values); dirty = false; queuedPatch = {}
    phase = 'ready'; message = null
  }
  $effect(() => {
    const id = userId
    untrack(() => {
      generation += 1; clearTimeout(timer); base = null; draft = null; dirty = false; queuedPatch = {}; phase = 'loading'; message = null
      setToolOperationsOwner(id)
      if (id) void refreshToolOperationsSource(id)
    })
  })
  $effect(() => {
    const current = source
    if (current.owner !== userId) return
    untrack(() => {
      if (current.status === 'failed') {
        if (phase !== 'unknown') { clearTimeout(timer); phase = 'failed'; message = current.error }
      } else if (current.status === 'confirmed' && current.source) {
        if (!base || !dirty && phase !== 'saving' && phase !== 'unknown') adopt(current.source)
        else if (current.source.revision !== base.revision && phase !== 'saving') {
          clearTimeout(timer)
          if (phase !== 'unknown') phase = 'conflict'
          message = 'Saved global tool options changed. Your choices were kept. Read the saved options before choosing again.'
        }
      }
    })
  })
  onDestroy(() => { generation += 1; clearTimeout(timer) })

  function webLabel(provider: NativeWebSearchProvider) {
    return provider !== 'duckduckgo-html' && availabilityLoaded && !providerError && !providerAvailability[provider]
      ? `${WEB_SEARCH_PROVIDER_LABELS[provider]} (Missing API key)` : WEB_SEARCH_PROVIDER_LABELS[provider]
  }
  const providerOptions = $derived.by(() => {
    const saved = draft?.webSearchProvider
    return (['duckduckgo-html', 'exa', 'perplexity'] as NativeWebSearchProvider[])
      .filter(value => value === 'duckduckgo-html' || providerAvailability[value] || value === saved)
      .map(value => ({ value, label: webLabel(value) }))
  })
  function choose(patch: Partial<Omit<ToolOperationalSettings, 'agentBrowser'>> & { agentBrowser?: AgentBrowserOperationalPatch }) {
    if (disabled || !base || !draft || !userId) return
    const id = userId, expected = base.revision, turn = generation
    const next = { ...draft, ...patch, agentBrowser: { ...draft.agentBrowser, ...patch.agentBrowser } }
    // A cleared optional field is an explicit delete, while the displayed draft has no null fields.
    for (const key of ['executablePath', 'session', 'profilePath'] as const) if (next.agentBrowser[key] === null) delete next.agentBrowser[key]
    draft = next as ToolOperationalSettings; dirty = true; phase = 'queued'; message = null
    queuedPatch = { ...queuedPatch, ...patch,
      ...(patch.agentBrowser ? { agentBrowser: { ...(queuedPatch.agentBrowser as Record<string, unknown> ?? {}), ...patch.agentBrowser } } : {}) }
    clearTimeout(timer)
    timer = setTimeout(() => { void save(id, expected, turn, structuredClone(queuedPatch)) }, 500)
  }
  async function save(id: string, expected: string, turn: number, patch: Record<string, unknown>) {
    if (generation !== turn || userId !== id || phase !== 'queued') return
    if (source.status !== 'confirmed' || source.source?.revision !== expected) {
      phase = 'conflict'; message = 'Saved global tool options changed. Read them before choosing again.'; return
    }
    phase = 'saving'
    let issued = false
    try {
      issued = true
      const response = await fetch('/api/user/settings', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedToolOperations: expected, tool_operations_patch: patch }) })
      const result = await response.json()
      if (generation !== turn || userId !== id) return
      if (!response.ok) {
        const knownNoWrite = response.status === 400 || response.status === 409 && result?.code === 'tool_operations_changed'
        phase = knownNoWrite ? 'conflict' : 'unknown'
        message = knownNoWrite ? result?.error || 'These options were not saved. Read the saved options before choosing again.' : 'The save outcome is unconfirmed. Your choices were kept. Read the saved options before another save.'
        return
      }
      const saved = parseToolOperationsResponse(result)
      if (!acceptToolOperationsSourceAck(id, expected, saved)) {
        phase = 'conflict'; message = 'A newer saved options read arrived. Read the saved options before choosing again.'
        return
      }
      adopt(saved)
    } catch (error) {
      if (generation !== turn || userId !== id) return
      phase = issued ? 'unknown' : 'failed'
      message = issued ? 'The save outcome is unconfirmed. Read the saved options before another save.' : error instanceof Error ? error.message : 'The options could not load.'
    }
  }
  async function useSaved() {
    const id = userId, turn = generation
    if (!id || phase === 'saving') return
    clearTimeout(timer); phase = 'loading'
    const saved = await refreshToolOperationsSource(id)
    if (turn !== generation || id !== userId) return
    const current = getToolOperationsSource()
    if (saved && current.status === 'confirmed') adopt(saved)
    else { phase = 'failed'; message = current.error || 'Saved global tool options could not load.' }
  }
</script>

{#if draft && base}
  <AdminWebSearchCard
    defaultProvider={draft.webSearchProvider} defaultProviderLabel={webLabel(draft.webSearchProvider)}
    exaType={draft.webSearchExaSearchType} perplexityMaxTokensPerPage={draft.webSearchPerplexityMaxTokensPerPage}
    {providerOptions} {providerAvailability} {loadingProviders} {providerError} {disabled}
    onProviderChange={value => choose({ webSearchProvider: value })}
    onExaTypeChange={value => choose({ webSearchExaSearchType: value })}
    onPerplexityMaxTokensPerPageChange={value => choose({ webSearchPerplexityMaxTokensPerPage: value })}
  />
  <AdminAgentBrowserDefaultsCard values={draft.agentBrowser} {disabled} dockerMode={base.containerized === true} onChange={patch => choose({ agentBrowser: patch })} />
{/if}
{#if phase !== 'ready' || base?.containerized === undefined}
  <div class="batshit-settings-inline-alert" role="status">
    {#if phase === 'queued' || phase === 'saving'}Saving global tool options...
    {:else if phase === 'loading'}Loading global tool options...
    {:else}
      <p>{message || 'Global tool runtime facts could not load. Read the saved options before editing.'}</p>
      <Button variant="outline" size="sm" onclick={useSaved}>Read saved global tool options</Button>
    {/if}
  </div>
{/if}
