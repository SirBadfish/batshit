<script lang="ts">
  import { onMount, untrack } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import MemorySystemCard from '$lib/components/settings/memory/MemorySystemCard.svelte'
  import type {
    MemoryEmbeddingDraft,
    MemoryPresetOption
  } from '$lib/components/settings/memory/memoryPanelTypes'
  import MemoryRecordDetail from '$lib/components/settings/memory/MemoryRecordDetail.svelte'
  import MemoryDreamingCard from '$lib/components/settings/memory/MemoryDreamingCard.svelte'
  import EntityAvatar from '$lib/components/avatar/EntityAvatar.svelte'
  import { DEFAULT_AGENT_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import * as agentStore from '$lib/stores/agents.svelte'
  import { resolveAgentMemoryEnabled } from '$lib/utils/memoryControl'
  import { BookOpen, Brain, History, Loader2, RefreshCw, Search, Zap } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  /**
   * SA-104 — Memory Panel (DL-104-16 full visibility), restructured 2026-08-26 into
   * one card per lane (Josh's three-card model): Awareness (the always-compiled
   * entries, exact prompt order), Trigger Memories (STM), and Long-Term Memories
   * (LTM), plus the read-only Graduated History browser for summarized old chat.
   * Ownership-gated — memories of a currently memory-disabled agent stay fully
   * visible and manageable.
   */

  let isLoading = $state(true)
  let agents = $state<Array<Record<string, any>>>([])
  let selectedAgentId = $state<string | null>(null)

  // Memory System card state
  let embeddingDraft = $state<MemoryEmbeddingDraft>({
    lane: 'builtin',
    modelId: 'builtin:embeddinggemma-300m',
    preset: { presetId: '', provider: '', modelName: '', dims: 0, documentPrefix: '', queryPrefix: '' },
    localAi: { baseUrl: '', modelName: '', apiKey: '', documentPrefix: '', queryPrefix: '', dims: 0 },
    api: { provider: 'openai', modelName: 'text-embedding-3-small', dims: 1536 }
  })
  let builtinModels = $state<Array<{ id: string; dims: number }>>([])
  let apiProviders = $state<string[]>(['openai'])
  let presetOptions = $state<MemoryPresetOption[]>([])
  let indexMeta = $state<Record<string, any> | null>(null)
  let indexMismatch = $state(false)
  let configSaving = $state(false)
  let reindexing = $state(false)
  let configError = $state<string | null>(null)

  // Browse state (one fetch, grouped into the lane cards)
  let awarenessEntries = $state<Array<Record<string, any>>>([])
  let listResults = $state<Array<Record<string, any>>>([])
  let listTotal = $state(0)
  let listLoading = $state(false)
  let listError = $state<string | null>(null)
  let searchQuery = $state('')
  let includeSuperseded = $state(true)
  let selectedMemoryId = $state<string | null>(null)
  let detail = $state<Record<string, any> | null>(null)
  let detailLoading = $state(false)

  // Graduated History state
  let segmentRows = $state<Array<Record<string, any>>>([])
  let segmentsTotal = $state(0)
  let segmentsLoading = $state(false)
  let segmentsError = $state<string | null>(null)
  let segmentQuery = $state('')
  let expandedSegmentId = $state<string | null>(null)

  const selectedAgent = $derived(
    agents.find((agent) => agent.id === selectedAgentId) ?? null
  )
  const selectedAgentMemoryEnabled = $derived(resolveAgentMemoryEnabled(selectedAgent))
  const searchActive = $derived(searchQuery.trim().length >= 2)
  const stmRows = $derived(listResults.filter((row) => row.lane === 'stm'))
  const ltmRows = $derived(listResults.filter((row) => row.lane === 'ltm'))
  const awarenessBrowseRows = $derived(listResults.filter((row) => row.lane === 'awareness'))
  // Awareness rows stored but not compiling (superseded or expired) — visible, never hidden.
  const awarenessDormantRows = $derived.by(() => {
    if (searchActive) return []
    const compiling = new Set(awarenessEntries.map((entry) => entry.id))
    return awarenessBrowseRows.filter((row) => !compiling.has(row.id))
  })

  onMount(async () => {
    try {
      await Promise.all([loadAgents(), loadConfig(), loadPresetOptions()])
    } finally {
      isLoading = false
    }
  })

  async function loadPresetOptions() {
    try {
      const response = await fetch('/api/user/saved-models')
      if (!response.ok) throw new Error(`HTTP ${response.status}`)
      const payload = await response.json()
      const rows: Array<Record<string, any>> = Array.isArray(payload)
        ? payload
        : (payload?.models ?? [])
      presetOptions = rows.map((row) => ({
        id: String(row.id ?? ''),
        modelId: String(row.modelId ?? ''),
        modelName: String(row.modelName ?? row.modelId ?? row.id ?? ''),
        provider: String(row.provider ?? ''),
        purpose: typeof row.purpose === 'string' ? row.purpose : undefined
      }))
    } catch (error) {
      console.error('[MemoryPanel] Failed to load model presets:', error)
      presetOptions = []
    }
  }

  async function loadAgents() {
    try {
      const response = await fetch('/api/agents')
      if (!response.ok) throw new Error(`Failed to load agents (HTTP ${response.status}).`)
      const payload = await response.json()
      const rows: Array<Record<string, any>> = Array.isArray(payload) ? payload : (payload?.agents ?? [])
      agents = rows
      const initial = untrack(() => selectedAgentId)
      if (!initial && rows.length > 0) {
        // Pre-select the chat bar's current agent (2026-08-29, matching Agent
        // Settings); fall back to the first memory-enabled agent, then the first.
        const chatAgentId = agentStore.getCurrentAgentId()
        const chatAgent = chatAgentId ? rows.find((agent) => agent.id === chatAgentId) : null
        const firstEnabled = rows.find((agent) => resolveAgentMemoryEnabled(agent))
        selectedAgentId = (chatAgent ?? firstEnabled ?? rows[0]).id
      }
    } catch (error) {
      console.error('[MemoryPanel] Failed to load agents:', error)
      toast.error('Failed to load agents for the Memory panel.')
    }
  }

  async function loadConfig() {
    try {
      const response = await fetch('/api/memory/config')
      if (!response.ok) throw new Error(`Failed to load memory config (HTTP ${response.status}).`)
      const payload = await response.json()
      hydrateEmbeddingDraft(payload?.embedding ?? null)
      builtinModels = Array.isArray(payload?.builtinModels) ? payload.builtinModels : []
      apiProviders = Array.isArray(payload?.apiProviders) ? payload.apiProviders : ['openai']
      indexMeta = payload?.indexMeta ?? null
      indexMismatch = Boolean(payload?.indexMismatch)
      configError = null
    } catch (error) {
      console.error('[MemoryPanel] Failed to load memory config:', error)
      configError = error instanceof Error ? error.message : 'Failed to load memory config.'
    }
  }

  function hydrateEmbeddingDraft(embedding: Record<string, any> | null) {
    if (!embedding) return
    embeddingDraft = {
      lane:
        embedding.lane === 'preset' ||
        embedding.lane === 'local-ai' ||
        embedding.lane === 'api'
          ? embedding.lane
          : 'builtin',
      modelId:
        typeof embedding.modelId === 'string' && embedding.modelId
          ? embedding.modelId
          : 'builtin:embeddinggemma-300m',
      preset: {
        presetId: embedding.preset?.presetId ?? '',
        provider: embedding.preset?.provider ?? '',
        modelName: embedding.preset?.modelName ?? '',
        dims: embedding.preset?.dims ?? 0,
        documentPrefix: embedding.preset?.documentPrefix ?? '',
        queryPrefix: embedding.preset?.queryPrefix ?? ''
      },
      localAi: {
        baseUrl: embedding.localAi?.baseUrl ?? '',
        modelName: embedding.localAi?.modelName ?? '',
        apiKey: embedding.localAi?.apiKey ?? '',
        documentPrefix: embedding.localAi?.documentPrefix ?? '',
        queryPrefix: embedding.localAi?.queryPrefix ?? '',
        dims: embedding.localAi?.dims ?? 0
      },
      api: {
        provider: embedding.api?.provider ?? 'openai',
        modelName: embedding.api?.modelName ?? 'text-embedding-3-small',
        dims: embedding.api?.dims ?? 1536
      }
    }
  }

  function buildEmbeddingPayload(): Record<string, any> {
    if (embeddingDraft.lane === 'builtin') {
      return { lane: 'builtin', modelId: embeddingDraft.modelId }
    }
    if (embeddingDraft.lane === 'preset') {
      const preset: Record<string, any> = {
        presetId: embeddingDraft.preset.presetId,
        dims: embeddingDraft.preset.dims
      }
      // Empty prefix fields mean "auto-fill for known models" (server-side).
      if (embeddingDraft.preset.documentPrefix.trim()) {
        preset.documentPrefix = embeddingDraft.preset.documentPrefix
      }
      if (embeddingDraft.preset.queryPrefix.trim()) {
        preset.queryPrefix = embeddingDraft.preset.queryPrefix
      }
      return { lane: 'preset', modelId: embeddingDraft.modelId, preset }
    }
    if (embeddingDraft.lane === 'local-ai') {
      const localAi: Record<string, any> = {
        baseUrl: embeddingDraft.localAi.baseUrl.trim(),
        modelName: embeddingDraft.localAi.modelName.trim(),
        dims: embeddingDraft.localAi.dims
      }
      if (embeddingDraft.localAi.apiKey.trim()) localAi.apiKey = embeddingDraft.localAi.apiKey.trim()
      if (embeddingDraft.localAi.documentPrefix) localAi.documentPrefix = embeddingDraft.localAi.documentPrefix
      if (embeddingDraft.localAi.queryPrefix) localAi.queryPrefix = embeddingDraft.localAi.queryPrefix
      return { lane: 'local-ai', modelId: `local-ai:${localAi.modelName}`, localAi }
    }
    return {
      lane: 'api',
      modelId: `api:${embeddingDraft.api.provider}:${embeddingDraft.api.modelName}`,
      api: {
        provider: embeddingDraft.api.provider.trim(),
        modelName: embeddingDraft.api.modelName.trim(),
        dims: embeddingDraft.api.dims
      }
    }
  }

  async function handleConfigSave() {
    configSaving = true
    configError = null
    try {
      const response = await fetch('/api/memory/config', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ embedding: buildEmbeddingPayload() })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `Save failed (HTTP ${response.status}).`)
      toast.success('Memory system configuration saved.')
      await loadConfig()
      if (indexMismatch) {
        toast.info('The embedding model changed. Run Re-Index Memories to finish the switch.')
      }
    } catch (error) {
      configError = error instanceof Error ? error.message : 'Failed to save memory config.'
    } finally {
      configSaving = false
    }
  }

  async function handleReindex() {
    reindexing = true
    configError = null
    try {
      const response = await fetch('/api/memory/reindex', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reembed: true })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `Re-index failed (HTTP ${response.status}).`)
      toast.success(
        `Re-indexed: ${payload.reembeddedMemories} memories and ${payload.reembeddedSegments} segments re-embedded.`
      )
      await loadConfig()
    } catch (error) {
      configError = error instanceof Error ? error.message : 'Memory re-index failed.'
    } finally {
      reindexing = false
    }
  }

  async function refreshBrowse() {
    const agentId = selectedAgentId
    if (!agentId) return
    listLoading = true
    listError = null
    try {
      const params = new URLSearchParams({ agentId })
      params.set('includeSuperseded', includeSuperseded ? 'true' : 'false')
      const query = searchQuery.trim()
      let rows: Array<Record<string, any>> = []
      if (query.length >= 2) {
        params.set('query', query)
        const response = await fetch(`/api/memory/manage/search?${params.toString()}`)
        const payload = await response.json().catch(() => null)
        if (!response.ok) throw new Error(payload?.error || `Search failed (HTTP ${response.status}).`)
        rows = payload?.results ?? []
        listTotal = rows.length
      } else {
        const response = await fetch(`/api/memory/manage/list?${params.toString()}`)
        const payload = await response.json().catch(() => null)
        if (!response.ok) throw new Error(payload?.error || `List failed (HTTP ${response.status}).`)
        rows = payload?.results ?? []
        listTotal = payload?.total ?? rows.length
      }
      listResults = rows
      if (selectedMemoryId && !rows.some((row) => row.id === selectedMemoryId)) {
        selectedMemoryId = null
        detail = null
      }
    } catch (error) {
      listError = error instanceof Error ? error.message : 'Failed to load memories.'
      listResults = []
    } finally {
      listLoading = false
    }
  }

  async function refreshAwareness() {
    const agentId = selectedAgentId
    if (!agentId) return
    try {
      const response = await fetch(
        `/api/memory/manage/awareness?agentId=${encodeURIComponent(agentId)}`
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      awarenessEntries = payload?.entries ?? []
    } catch (error) {
      console.error('[MemoryPanel] Failed to load Awareness entries:', error)
      awarenessEntries = []
    }
  }

  async function refreshSegments() {
    const agentId = selectedAgentId
    if (!agentId) return
    segmentsLoading = true
    segmentsError = null
    try {
      const params = new URLSearchParams({ agentId })
      const query = segmentQuery.trim()
      if (query.length >= 2) params.set('query', query)
      const response = await fetch(`/api/memory/manage/segments?${params.toString()}`)
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      segmentRows = payload?.results ?? []
      segmentsTotal = payload?.total ?? segmentRows.length
    } catch (error) {
      segmentsError = error instanceof Error ? error.message : 'Failed to load graduated history.'
      segmentRows = []
    } finally {
      segmentsLoading = false
    }
  }

  async function openDetail(memoryId: string) {
    const agentId = selectedAgentId
    if (!agentId) return
    selectedMemoryId = memoryId
    detailLoading = true
    try {
      const response = await fetch(
        `/api/memory/manage/record?agentId=${encodeURIComponent(agentId)}&memoryId=${encodeURIComponent(memoryId)}`
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      detail = payload
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load memory details.')
      detail = null
      selectedMemoryId = null
    } finally {
      detailLoading = false
    }
  }

  async function handleDetailChanged() {
    await Promise.all([refreshBrowse(), refreshAwareness()])
    if (selectedMemoryId) await openDetail(selectedMemoryId)
  }

  async function handleDetailDeleted() {
    selectedMemoryId = null
    detail = null
    await Promise.all([refreshBrowse(), refreshAwareness()])
  }

  function refreshAll() {
    void refreshBrowse()
    void refreshAwareness()
    void refreshSegments()
  }

  // Reload browse data when the selected agent changes (guarded against load loops).
  let lastBrowsedAgentId = $state<string | null>(null)
  $effect(() => {
    const agentId = selectedAgentId
    if (!agentId || agentId === untrack(() => lastBrowsedAgentId)) return
    lastBrowsedAgentId = agentId
    selectedMemoryId = null
    detail = null
    expandedSegmentId = null
    refreshAll()
  })

  function laneBadge(lane: string): string {
    return lane === 'awareness' ? 'Awareness' : lane === 'stm' ? 'STM' : 'LTM'
  }

  function agentAvatarUrl(agent: Record<string, any>): string | null {
    return (
      agent.avatar_url || agent.avatar || (agent.avatar_icon_ref ? null : '/assets/batshit_default_AI_Avatar_1.png')
    )
  }

  function agentAvatarIconRef(agent: Record<string, any>) {
    return agent.avatar_icon_ref ? normalizeIconRef(agent.avatar_icon_ref, DEFAULT_AGENT_ICON_REF) : null
  }

  function agentInitials(agent: Record<string, any>): string {
    const name = String(agent.displayName || agent.name || agent.id || '?')
    return name.slice(0, 2).toUpperCase()
  }

  function graduatedByLabel(value: unknown): string {
    switch (value) {
      case 'nap':
        return 'nap'
      case 'dreaming':
        return 'dreaming'
      case 'idle':
        return 'idle chat'
      case 'session_close':
        return 'chat closed'
      default:
        return String(value ?? 'graduated')
    }
  }

  function formatShortDate(value: unknown): string {
    if (!value) return ''
    const parsed = new Date(String(value))
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: 'numeric' })
      : ''
  }

  function segmentDateRange(row: Record<string, any>): string {
    const first = formatShortDate(row.first_message_at)
    const last = formatShortDate(row.last_message_at)
    if (first && last) return first === last ? first : `${first} to ${last}`
    return first || last || ''
  }
</script>

{#snippet memoryRow(row: Record<string, any>, options: { showLaneBadge?: boolean; showTriggers?: boolean } = {})}
  <button
    type="button"
    class={`memory-list-row ${selectedMemoryId === row.id ? 'is-selected' : ''}`}
    onclick={() => openDetail(row.id)}
    data-testid={`memory-row-${row.id}`}
  >
    <span class="memory-list-gist">{row.gist}</span>
    <span class="memory-list-meta">
      {#if options.showLaneBadge}
        <Badge variant="outline" class="batshit-settings-spine-badge">{laneBadge(row.lane)}</Badge>
      {/if}
      {#if options.showTriggers && Array.isArray(row.trigger_terms)}
        {#each row.trigger_terms.slice(0, 6) as term (term)}
          <span class="batshit-settings-status-badge is-accent">{term}</span>
        {/each}
        {#if row.trigger_terms.length > 6}
          <span class="batshit-settings-form-meta">+{row.trigger_terms.length - 6} more</span>
        {/if}
      {/if}
      {#if row.superseded}
        <Badge variant="outline" class="batshit-settings-spine-badge">superseded</Badge>
      {/if}
      {#if row.clip_count}
        <Badge variant="outline" class="batshit-settings-spine-badge">media</Badge>
      {/if}
      {#if row.linger_override !== undefined}
        <Badge variant="outline" class="batshit-settings-spine-badge">
          {row.linger_override === 'episode' ? 'lingers all episode' : `lingers ${row.linger_override}`}
        </Badge>
      {/if}
      <span class="batshit-settings-status-badge is-info">imp {row.importance}</span>
      <span class="batshit-settings-status-badge">{formatShortDate(row.saved_at)}</span>
    </span>
  </button>
{/snippet}

{#snippet laneEmpty(text: string)}
  <p class="batshit-settings-form-meta">{text}</p>
{/snippet}

{#if isLoading}
  <div class="flex items-center justify-center p-12">
    <Loader2 class="h-6 w-6 animate-spin text-muted-foreground" aria-hidden="true" />
    <span class="ml-2 text-sm text-muted-foreground">Loading memory...</span>
  </div>
{:else}
  <div class="batshit-settings-surface">
    <div class="space-y-4">
      <div class="flex min-w-0 items-center gap-1.5">
        <Brain class="h-4 w-4" />
        <h3 class="batshit-settings-section-title">Memory</h3>
        <SettingsInfoMenu ariaLabel="About Memory" contentClass="w-96">
          <p>
            Everything a memory-enabled agent stores lives here: its Awareness entries,
            its Trigger Memories, its searchable long-term store, and the graduated
            history of older chats. You can view, edit, and delete all of it — nothing
            an agent remembers is hidden. Enable memory per agent in Agent Settings →
            Core.
          </p>
        </SettingsInfoMenu>
      </div>

      <MemorySystemCard
        draft={embeddingDraft}
        {indexMeta}
        {builtinModels}
        {apiProviders}
        presets={presetOptions}
        saving={configSaving}
        {reindexing}
        errorText={configError}
        {indexMismatch}
        onDraftChange={(next) => (embeddingDraft = next)}
        onSave={handleConfigSave}
        onReindex={handleReindex}
      />

      <div class="memory-browse-header">
        <Select.Root
          type="single"
          value={selectedAgentId ?? ''}
          onValueChange={(value) => {
            const id = Array.isArray(value) ? value[0] : value
            if (id) selectedAgentId = id
          }}
        >
          <Select.Trigger class="memory-agent-select justify-between">
            {#if selectedAgent}
              <span class="memory-agent-option">
                <EntityAvatar
                  avatarUrl={agentAvatarUrl(selectedAgent)}
                  iconRef={agentAvatarIconRef(selectedAgent)}
                  iconFit={selectedAgent.avatar_icon_fit}
                  label={selectedAgent.displayName || selectedAgent.name || selectedAgent.id}
                  fallback={agentInitials(selectedAgent)}
                  class="h-5 w-5"
                />
                <span class="memory-agent-option-name">
                  {selectedAgent.displayName || selectedAgent.name || selectedAgent.id}{selectedAgentMemoryEnabled ? '' : ' (memory off)'}
                </span>
              </span>
            {:else}
              Choose an agent
            {/if}
          </Select.Trigger>
          <Select.Content>
            {#each agents as agent (agent.id)}
              <Select.Item value={agent.id}>
                <span class="memory-agent-option">
                  <EntityAvatar
                    avatarUrl={agentAvatarUrl(agent)}
                    iconRef={agentAvatarIconRef(agent)}
                    iconFit={agent.avatar_icon_fit}
                    label={agent.displayName || agent.name || agent.id}
                    fallback={agentInitials(agent)}
                    class="h-5 w-5"
                  />
                  <span class="memory-agent-option-name">
                    {agent.displayName || agent.name || agent.id}{resolveAgentMemoryEnabled(agent) ? '' : ' (memory off)'}
                  </span>
                </span>
              </Select.Item>
            {/each}
          </Select.Content>
        </Select.Root>
        <Button
          variant="ghost"
          size="icon"
          onclick={refreshAll}
          disabled={listLoading}
          title="Refresh memories"
          aria-label="Refresh memories"
        >
          <RefreshCw class={listLoading ? 'animate-spin' : ''} />
        </Button>
      </div>

      {#if selectedAgentId}
        {#if !selectedAgentMemoryEnabled}
          <p class="batshit-settings-form-help">
            Memory is currently off for this agent. Stored memories stay saved and
            manageable here; enable memory in Agent Settings → Core to let the agent use
            them again.
          </p>
        {/if}

        <div class="memory-filter-row">
          <div class="memory-filter-search">
            <Search class="memory-filter-search-icon" aria-hidden="true" />
            <Input
              placeholder="Search memories (meaning or keywords)"
              value={searchQuery}
              oninput={(event) => (searchQuery = (event.target as HTMLInputElement).value)}
              onkeydown={(event) => event.key === 'Enter' && refreshBrowse()}
            />
          </div>
          <label class="memory-superseded-toggle">
            <Switch.Root
              checked={includeSuperseded}
              onCheckedChange={(checked) => {
                includeSuperseded = Boolean(checked)
                void refreshBrowse()
              }}
            />
            <span class="batshit-settings-form-meta">Show superseded</span>
          </label>
          <Button size="sm" variant="outline" onclick={() => refreshBrowse()} disabled={listLoading}>
            {searchActive ? 'Search' : 'Apply'}
          </Button>
        </div>

        {#if listError}
          <p class="batshit-settings-form-help batshit-settings-warning-text">{listError}</p>
        {/if}

        <div class="memory-browse-grid">
          <div class="memory-list-lane">
            <SettingsAccordionCard name="memory-awareness" title="Awareness" icon={Brain} open>
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Awareness" contentClass="w-96">
                  <p>
                    Memories the agent keeps present at all times: they compile into its
                    system prompt on every message, in exactly this order. Permanent
                    unless edited, or temporary with an expiry the agent sets. Expired
                    and superseded entries stop compiling but stay stored.
                  </p>
                </SettingsInfoMenu>
              {/snippet}
              {#if searchActive}
                {#if awarenessBrowseRows.length === 0}
                  {@render laneEmpty('No Awareness matches.')}
                {:else}
                  <div class="memory-list" data-testid="memory-awareness-matches">
                    {#each awarenessBrowseRows as row (row.id)}
                      {@render memoryRow(row, {})}
                    {/each}
                  </div>
                {/if}
              {:else if awarenessEntries.length === 0}
                {@render laneEmpty('No Awareness entries yet.')}
              {:else}
                <div class="memory-omm-list">
                  {#each awarenessEntries as entry (entry.id)}
                    <button
                      type="button"
                      class="memory-omm-row"
                      onclick={() => openDetail(entry.id)}
                      data-testid={`memory-awareness-row-${entry.id}`}
                    >
                      <span class="memory-omm-content">{entry.content}</span>
                      <span class="memory-omm-meta">
                        <span class="batshit-settings-status-badge is-info">imp {entry.importance}</span>
                        <span class="batshit-settings-status-badge">{formatShortDate(entry.saved_at)}</span>
                        {#if entry.expires_at}
                          <span class="batshit-settings-form-meta">
                            {entry.expired ? 'expired' : `expires ${formatShortDate(entry.expires_at)}`}
                          </span>
                        {/if}
                      </span>
                    </button>
                  {/each}
                </div>
                {#if awarenessDormantRows.length > 0}
                  <p class="batshit-settings-form-meta memory-lane-subhead">
                    Stored but not compiling (expired or superseded):
                  </p>
                  <div class="memory-list">
                    {#each awarenessDormantRows as row (row.id)}
                      {@render memoryRow(row, {})}
                    {/each}
                  </div>
                {/if}
              {/if}
            </SettingsAccordionCard>

            <SettingsAccordionCard
              name="memory-stm"
              title="Trigger Memories (STM)"
              icon={Zap}
              open
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Trigger Memories" contentClass="w-96">
                  <p>
                    Cued recall: when one of a memory's trigger words comes up in
                    conversation, the memory is inserted instantly, with no search and no
                    tool call. Trigger Memories can carry Clip photos.
                  </p>
                </SettingsInfoMenu>
              {/snippet}
              {#if listLoading && stmRows.length === 0}
                {@render laneEmpty('Loading...')}
              {:else if stmRows.length === 0}
                {@render laneEmpty(searchActive ? 'No STM matches.' : 'No Trigger Memories yet.')}
              {:else}
                <div class="memory-list" data-testid="memory-stm-list">
                  {#each stmRows as row (row.id)}
                    {@render memoryRow(row, { showTriggers: true })}
                  {/each}
                </div>
              {/if}
            </SettingsAccordionCard>

            <SettingsAccordionCard
              name="memory-ltm"
              title="Long-Term Memories (LTM)"
              icon={BookOpen}
              open
            >
              {#snippet info()}
                <SettingsInfoMenu ariaLabel="About Long-Term Memories" contentClass="w-96">
                  <p>
                    Saved facts the agent finds by searching: by meaning, by keywords,
                    and by time. The default home for most memories. Graduated old-chat
                    summaries live in Graduated History below and are searched the same
                    way.
                  </p>
                </SettingsInfoMenu>
              {/snippet}
              {#if listLoading && ltmRows.length === 0}
                {@render laneEmpty('Loading...')}
              {:else if ltmRows.length === 0}
                {@render laneEmpty(searchActive ? 'No LTM matches.' : 'No long-term memories yet.')}
              {:else}
                <div class="memory-list" data-testid="memory-ltm-list">
                  {#each ltmRows as row (row.id)}
                    {@render memoryRow(row, {})}
                  {/each}
                </div>
              {/if}
            </SettingsAccordionCard>

            {#if listTotal > listResults.length}
              <p class="batshit-settings-form-meta">
                Showing {listResults.length} of {listTotal}. Narrow with search.
              </p>
            {/if}
          </div>

          <div class="memory-detail-lane">
            {#if detailLoading}
              <p class="batshit-settings-form-meta">Loading details...</p>
            {:else if detail && selectedMemoryId}
              <MemoryRecordDetail
                agentId={selectedAgentId}
                detail={detail as never}
                onChanged={handleDetailChanged}
                onDeleted={handleDetailDeleted}
              />
            {:else}
              <p class="batshit-settings-form-meta">Select a memory to view and edit it.</p>
            {/if}
          </div>
        </div>

        <SettingsAccordionCard name="memory-graduated-history" title="Graduated History" icon={History}>
          {#snippet info()}
            <SettingsInfoMenu ariaLabel="About Graduated History" contentClass="w-96">
              <p>
                Summaries of older conversation that graduated into searchable memory:
                finished episodes and idle chats, condensed by naps, dreaming, or chat
                close. The original messages are never deleted; these are the readable
                summaries the agent searches. Read-only for now.
              </p>
            </SettingsInfoMenu>
          {/snippet}
          <div class="memory-filter-row memory-segment-filter">
            <div class="memory-filter-search">
              <Search class="memory-filter-search-icon" aria-hidden="true" />
              <Input
                placeholder="Search graduated history"
                value={segmentQuery}
                oninput={(event) => (segmentQuery = (event.target as HTMLInputElement).value)}
                onkeydown={(event) => event.key === 'Enter' && refreshSegments()}
              />
            </div>
            <Button size="sm" variant="outline" onclick={() => refreshSegments()} disabled={segmentsLoading}>
              {segmentQuery.trim().length >= 2 ? 'Search' : 'Refresh'}
            </Button>
          </div>
          {#if segmentsError}
            <p class="batshit-settings-form-help batshit-settings-warning-text">{segmentsError}</p>
          {:else if segmentsLoading && segmentRows.length === 0}
            {@render laneEmpty('Loading graduated history...')}
          {:else if segmentRows.length === 0}
            {@render laneEmpty(
              segmentQuery.trim().length >= 2
                ? 'No matches in graduated history.'
                : 'No graduated history yet. Finished episodes and idle chats appear here after naps, dreaming, or chat close.'
            )}
          {:else}
            <div class="memory-list" data-testid="memory-segments-list">
              {#each segmentRows as row (row.id)}
                <button
                  type="button"
                  class={`memory-list-row ${expandedSegmentId === row.id ? 'is-selected' : ''}`}
                  onclick={() => (expandedSegmentId = expandedSegmentId === row.id ? null : row.id)}
                  data-testid={`memory-segment-row-${row.id}`}
                >
                  <span class={`memory-segment-summary ${expandedSegmentId === row.id ? '' : 'is-clamped'}`}>
                    {row.summary}
                  </span>
                  <span class="memory-list-meta">
                    <Badge variant="outline" class="batshit-settings-spine-badge">{graduatedByLabel(row.graduated_by)}</Badge>
                    <span class="batshit-settings-status-badge">{segmentDateRange(row)}</span>
                    <span class="batshit-settings-form-meta">
                      {Array.isArray(row.message_ids) ? row.message_ids.length : 0} messages · chat {row.session_id}
                    </span>
                  </span>
                </button>
              {/each}
            </div>
            {#if segmentsTotal > segmentRows.length}
              <p class="batshit-settings-form-meta">
                Showing {segmentRows.length} of {segmentsTotal}. Narrow with search.
              </p>
            {/if}
          {/if}
        </SettingsAccordionCard>

        <MemoryDreamingCard agentId={selectedAgentId} memoryEnabled={selectedAgentMemoryEnabled} />
      {:else}
        <p class="batshit-settings-form-meta">No agents yet. Create an agent first.</p>
      {/if}
    </div>
  </div>
{/if}

<style>
  .memory-browse-header {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .memory-browse-header > :global(.memory-agent-select) {
    min-width: 16rem;
  }

  .memory-browse-header :global(.memory-agent-option),
  :global(.memory-agent-option) {
    display: inline-flex;
    min-width: 0;
    align-items: center;
    gap: 0.45rem;
  }

  :global(.memory-agent-option-name) {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .memory-filter-row {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
  }

  .memory-segment-filter {
    margin-bottom: 0.5rem;
  }

  .memory-filter-search {
    position: relative;
    flex: 1 1 16rem;
    min-width: 12rem;
  }

  .memory-filter-search :global(input) {
    padding-left: 1.9rem;
  }

  .memory-filter-row :global(.memory-filter-search-icon) {
    position: absolute;
    top: 50%;
    left: 0.55rem;
    z-index: 1;
    width: 0.85rem;
    height: 0.85rem;
    transform: translateY(-50%);
    color: var(--muted-foreground);
    pointer-events: none;
  }

  .memory-superseded-toggle {
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
  }

  .memory-browse-grid {
    display: grid;
    grid-template-columns: minmax(0, 5fr) minmax(0, 7fr);
    gap: 0.75rem;
    align-items: start;
  }

  @media (max-width: 1000px) {
    .memory-browse-grid {
      grid-template-columns: minmax(0, 1fr);
    }
  }

  .memory-list-lane {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .memory-list {
    display: flex;
    flex-direction: column;
  }

  .memory-lane-subhead {
    margin-top: 0.5rem;
  }

  .memory-list-row,
  .memory-omm-row {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    padding: 0.5rem 0.625rem;
    border: 0;
    border-bottom: 1px solid var(--bs-settings-inner-line, oklch(0.23 0 0));
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .memory-list-row:hover,
  .memory-omm-row:hover {
    background: var(--bs-settings-display-surface-hover, oklch(0.25 0.02 285));
  }

  .memory-list-row.is-selected {
    background: var(--bs-settings-display-surface-active, oklch(0.27 0.02 285));
  }

  .memory-list-gist,
  .memory-omm-content {
    font-size: 0.8125rem;
    font-weight: 300;
    line-height: 1.4;
    overflow-wrap: anywhere;
  }

  .memory-segment-summary {
    font-size: 0.8125rem;
    font-weight: 300;
    line-height: 1.45;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .memory-segment-summary.is-clamped {
    display: -webkit-box;
    -webkit-box-orient: vertical;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    overflow: hidden;
  }

  .memory-list-meta,
  .memory-omm-meta {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.375rem;
    font-size: 0.6875rem;
    color: var(--muted-foreground);
  }

  .memory-omm-list {
    display: flex;
    flex-direction: column;
  }
</style>
