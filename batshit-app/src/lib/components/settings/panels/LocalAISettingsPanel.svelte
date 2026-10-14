<script lang="ts">
  import { onDestroy, onMount, untrack } from 'svelte'
  import { debounce } from '$lib/utils/debounce'
  import * as Card from '$lib/components/ui/card'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import { Input } from '$lib/components/ui/input'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import BatshitIcon from '$lib/components/icons/BatshitIcon.svelte'
  import IconRenderer from '$lib/components/icons/IconRenderer.svelte'
  import { getLocalAiIconRef } from '$lib/data/localAiIcons'
  import {
    AlertCircle,
    Boxes,
    ChevronDown,
    Loader2,
    PlugZap,
    RefreshCw,
    RotateCcw
  } from '@lucide/svelte'
  import { LOCAL_AI_SERVER_DEFINITIONS } from '$lib/data/localAiServers'
  import type { LocalAiImageTransport, LocalAiServerSummary, LocalAiServerUpdate } from '$lib/types/localAi'
  import OllamaModelManager from '../OllamaModelManager.svelte'
  import DmrModelManager from '../DmrModelManager.svelte'
  import LocalAiModelManager from '../LocalAiModelManager.svelte'
  // SA-124 P8: the programs whose own API can actually load a model. The other
  // three (llama.cpp, vLLM, SGLang) take one model per process from a launch
  // flag, so they keep the read-only Detected Models card.
  const MANAGEABLE_PROGRAMS = new Set(['koboldcpp', 'lmstudio', 'omlx', 'ollama', 'llama-cpp'])
  import type { UserSettingsRow } from '$lib/types/database'
  import {
    dispatchLocalAiSettingsUpdated,
    LIVE_SETTINGS_EVENTS,
    type ModelConnectionsUpdatedDetail
  } from '$lib/utils/liveSettingsEvents'

  const SAVE_DEBOUNCE_MS = 600
  const IMAGE_TRANSPORT_OPTIONS: Array<{ value: LocalAiImageTransport; label: string; helper: string }> = [
    {
      value: 'auto',
      label: 'Automatic',
      helper: 'Use structured image data when Batshit has local bytes.'
    },
    {
      value: 'url',
      label: 'Force URL',
      helper: 'Use fetchable image URLs through the Image Base URL.'
    }
  ]

  type PanelData = {
    user?: { id: string } | null
    userSettings?: UserSettingsRow | null
  } | null

  let { data = null }: { data?: PanelData } = $props()

  const defaultServers: LocalAiServerSummary[] = LOCAL_AI_SERVER_DEFINITIONS.map((definition) => ({
    ...definition,
    baseUrl: definition.defaultBaseUrl,
    openaiPath: definition.openaiPath,
    enabled: definition.enabledByDefault,
    imageTransport: definition.defaultImageTransport,
    imageBaseUrl: definition.defaultImageBaseUrl,
    source: 'default'
  }))

  let servers = $state<LocalAiServerSummary[]>([...defaultServers])

  const LOAD_FAILED_MESSAGE = 'Failed to load local AI servers'

  let isLoading = $state(true)
  let loadError = $state<string | null>(null)
  // BL-962: `servers` holds saved values only after a real read of `/api/settings/local-ai`
  // succeeded. Until then it holds the built-in defaults, which may never be written back: the
  // route writes a whole record for every server it is sent, so a save built from the defaults
  // erases every saved address and switch. The server cards are not offered then, and the
  // autosave returns. Once a read succeeded the copy stays, and a later failed Reload keeps it
  // (it never swaps it for the defaults).
  let settingsLoaded = $state(false)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let persistedSignature = $state(makeSignature(defaultServers))

  type ServerStatus = {
    state: 'unknown' | 'checking' | 'online' | 'unreachable' | 'access-required'
    identity: string
    message?: string
  }

  let openServerId = $state<string | null>(null)
  let serverStatus = $state<Record<string, ServerStatus>>({})
  type ModelListState = {
    state: 'idle' | 'loading' | 'loaded' | 'error'
    models: string[]
    identity: string
    error?: string
  }

  let modelListState = $state<Record<string, ModelListState>>({})
  let serverReadVersion = $state(0)
  let apiKeyReadVersion = $state(0)
  let endpointDraftVersions = $state<Record<string, number>>({})
  const statusRequestVersions = new Map<string, number>()
  const modelListRequestVersions = new Map<string, number>()

  function toggleServerOpen(id: string) {
    openServerId = openServerId === id ? null : id
  }

  onMount(() => {
    const refreshOpenServer = () => {
      const server = servers.find((row) => row.id === openServerId)
      if (server?.enabled) void checkServer(server)
    }
    const handleModelConnectionsUpdated = (event: Event) => {
      const detail = (event as CustomEvent<ModelConnectionsUpdatedDetail>).detail
      if (detail?.source === 'api-keys') {
        // The actual key stays in the encrypted server store. This version marks status reads
        // from before a key edit as stale without putting secret material in browser state.
        apiKeyReadVersion += 1
        refreshOpenServer()
      } else if (detail?.source === 'local-ai') {
        refreshOpenServer()
      }
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') refreshOpenServer()
    }
    window.addEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, handleModelConnectionsUpdated)
    window.addEventListener('focus', refreshOpenServer)
    document.addEventListener('visibilitychange', handleVisibilityChange)
    void loadServers()
    return () => {
      window.removeEventListener(LIVE_SETTINGS_EVENTS.modelConnectionsUpdated, handleModelConnectionsUpdated)
      window.removeEventListener('focus', refreshOpenServer)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
    }
  })

  onDestroy(() => {
    statusRequestVersions.clear()
    modelListRequestVersions.clear()
  })

  async function loadServers() {
    isLoading = true
    loadError = null

    try {
      const response = await fetch('/api/settings/local-ai')
      if (!response.ok) {
        // The route's own words when it sent some ({ error } or { message } as JSON); the plain
        // sentence when the answer is not JSON or names nothing.
        const body = await response.json().catch(() => null)
        const detail = [body?.error, body?.message].find(
          (value): value is string => typeof value === 'string' && value.trim().length > 0
        )
        throw new Error(detail?.trim() ?? LOAD_FAILED_MESSAGE)
      }
      const payload = await response.json()
      // An answer with no server list is not a read of the saved servers.
      if (!Array.isArray(payload?.servers)) {
        throw new Error(LOAD_FAILED_MESSAGE)
      }
      servers = payload.servers
      serverReadVersion += 1
      persistedSignature = makeSignature(servers)
      modelListState = {}
      settingsLoaded = true
    } catch (error) {
      console.error('Failed to load local AI servers:', error)
      // BL-962: a failed read changes nothing but the failure. `servers` stays what it was (the
      // defaults before a first good read, the loaded copy after one).
      loadError = error instanceof Error ? error.message : LOAD_FAILED_MESSAGE
    } finally {
      isLoading = false
    }
  }

  function endpointIdentity(server: LocalAiServerSummary) {
    return JSON.stringify([
      server.baseUrl,
      server.openaiPath,
      server.enabled,
      serverReadVersion,
      apiKeyReadVersion,
      endpointDraftVersions[server.id] ?? 0
    ])
  }

  function bumpEndpointDraftVersion(id: string) {
    endpointDraftVersions = {
      ...endpointDraftVersions,
      [id]: (endpointDraftVersions[id] ?? 0) + 1
    }
  }

  function currentServer(id: string) {
    return servers.find((server) => server.id === id)
  }

  function statusFor(server: LocalAiServerSummary) {
    const status = serverStatus[server.id]
    return status?.identity === endpointIdentity(server) ? status : undefined
  }

  function modelListFor(server: LocalAiServerSummary) {
    const list = modelListState[server.id]
    return list?.identity === endpointIdentity(server) ? list : undefined
  }

  function nextRequestVersion(versions: Map<string, number>, id: string) {
    const version = (versions.get(id) ?? 0) + 1
    versions.set(id, version)
    return version
  }

  function updateStatus(id: string, identity: string, next: Omit<ServerStatus, 'identity'>) {
    serverStatus = {
      ...serverStatus,
      [id]: { ...next, identity }
    }
  }

  function canonicalBaseUrl(value: string) {
    return value.trim().replace(/\/+$/, '')
  }

  function canonicalOpenAiPath(value: string) {
    const trimmed = value.trim().replace(/\/+$/, '')
    return trimmed || ''
  }

  async function readAvailability(server: LocalAiServerSummary) {
    const identity = endpointIdentity(server)
    const statusRequestVersion = nextRequestVersion(statusRequestVersions, server.id)
    const listRequestVersion = nextRequestVersion(modelListRequestVersions, server.id)
    updateStatus(server.id, identity, { state: 'checking' })
    updateModelList(server.id, identity, { state: 'loading', models: [] })

    const isCurrentRequest = () =>
      statusRequestVersions.get(server.id) === statusRequestVersion &&
      modelListRequestVersions.get(server.id) === listRequestVersion &&
      endpointIdentity(currentServer(server.id) ?? server) === identity

    const setCurrentStatus = (next: Omit<ServerStatus, 'identity'>) => {
      if (isCurrentRequest()) updateStatus(server.id, identity, next)
    }
    const setCurrentList = (next: Omit<ModelListState, 'identity'>) => {
      if (isCurrentRequest()) updateModelList(server.id, identity, next)
    }

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 10_000)

    try {
      const response = await fetch(
        `/api/settings/local-ai/models?program=${encodeURIComponent(server.id)}&mode=availability`,
        { signal: controller.signal }
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok || payload?.success !== true) {
        throw new Error(payload?.error || payload?.message || 'Failed to check the saved Local AI connection.')
      }

      const savedEndpointMatchesDraft =
        canonicalBaseUrl(payload.baseUrl ?? '') === canonicalBaseUrl(server.baseUrl) &&
        canonicalOpenAiPath(payload.openaiPath ?? '') === canonicalOpenAiPath(server.openaiPath)
      if (!savedEndpointMatchesDraft) {
        const message = 'Save the connection before checking its availability.'
        setCurrentStatus({ state: 'unknown', message })
        setCurrentList({ state: 'error', models: [], error: message })
        return
      }

      if (payload.availability === 'reachable') {
        if (!Array.isArray(payload.models?.data)) {
          throw new Error('The saved connection did not return a valid model list.')
        }
        const models = parseModelList(payload.models)
        setCurrentStatus({ state: 'online' })
        setCurrentList({ state: 'loaded', models })
      } else if (payload.availability === 'access-required') {
        const message = payload.message || 'The program requires a valid API key. Check Settings -> API Keys -> Local AI.'
        setCurrentStatus({ state: 'access-required', message })
        setCurrentList({ state: 'error', models: [], error: message })
      } else if (payload.availability === 'unreachable') {
        const message = payload.message || 'Batshit could not reach the saved connection.'
        setCurrentStatus({ state: 'unreachable', message })
        setCurrentList({ state: 'error', models: [], error: message })
      } else {
        throw new Error('The Local AI availability route returned an unknown status.')
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Failed to check Local AI availability.'
      setCurrentStatus({ state: 'unreachable', message })
      setCurrentList({ state: 'error', models: [], error: message })
    } finally {
      clearTimeout(timeout)
    }
  }

  async function checkServer(server: LocalAiServerSummary) {
    await readAvailability(server)
  }

  function updateModelList(id: string, identity: string, next: Omit<ModelListState, 'identity'>) {
    modelListState = {
      ...modelListState,
      [id]: { ...next, identity }
    }
  }

  function parseModelList(payload: any): string[] {
    const list = Array.isArray(payload?.data)
      ? payload.data
      : Array.isArray(payload?.models)
        ? payload.models
        : Array.isArray(payload)
          ? payload
          : []

    return list
      .map((entry: any) => {
        if (!entry) return null
        if (typeof entry === 'string') return entry
        return entry.id || entry.name || entry.model || null
      })
      .filter((value: any): value is string => Boolean(value))
  }

  async function loadModelList(server: LocalAiServerSummary) {
    await readAvailability(server)
  }

  function makeSignature(list: LocalAiServerSummary[]) {
    return list
      .map(
        (server) =>
          `${server.id}:${server.baseUrl}:${server.openaiPath}:${server.enabled}:${server.imageTransport}:${server.imageBaseUrl}`
      )
      .join('|')
  }

  /**
   * SA-102 P5 (DL-102-10): two enabled programs on the same address.
   *
   * oMLX and vLLM both default to port 8000, and Batshit merges models from
   * every enabled program — so with stock defaults the same models appear twice
   * under two different program names, with nothing saying why. Josh's call:
   * WARN and point at the fix. Do not block; every one of these accepts a
   * custom port, and blocking a working setup would be worse than explaining it.
   */
  const duplicateBaseUrlWarning = $derived.by(() => {
    const byAddress = new Map<string, string[]>()
    for (const server of servers) {
      if (server.enabled === false) continue
      const address = `${server.baseUrl.trim().toLowerCase().replace(/\/+$/, '')}`
      if (!address) continue
      byAddress.set(address, [...(byAddress.get(address) ?? []), server.label])
    }
    for (const [address, labels] of byAddress) {
      if (labels.length > 1) {
        return `${labels.join(' and ')} are both set to ${address}, so the same models will show up twice. Give one of them a different port, then update its address here.`
      }
    }
    return null
  })

  function validateServers(list: LocalAiServerSummary[]): string | null {
    for (const server of list) {
      const baseUrl = server.baseUrl.trim()
      if (!baseUrl) {
        return `Base URL is required for ${server.label}.`
      }
      if (!/^https?:\/\//i.test(baseUrl)) {
        return `Base URL for ${server.label} must start with http or https.`
      }
      const openaiPath = server.openaiPath.trim()
      if (openaiPath && !openaiPath.startsWith('/')) {
        return `OpenAI path for ${server.label} must start with /.`
      }
      const imageBaseUrl = server.imageBaseUrl.trim()
      if (!imageBaseUrl) {
        return `Image base URL is required for ${server.label}.`
      }
      if (!/^https?:\/\//i.test(imageBaseUrl)) {
        return `Image base URL for ${server.label} must start with http or https.`
      }
    }
    return null
  }

  const debouncedSave = debounce(async (updates: LocalAiServerUpdate[]) => {
    try {
      const response = await fetch('/api/settings/local-ai', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ servers: updates })
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        const message = payload?.error || 'Failed to save local AI settings'
        throw new Error(message)
      }

      const payload = await response.json()
      const updated = payload?.servers

      untrack(() => {
        servers = updated ?? servers
        persistedSignature = makeSignature(servers)
        saveState = 'saved'
        saveError = null
      })
      dispatchLocalAiSettingsUpdated()
    } catch (error) {
      console.error('Local AI save failed:', error)
      untrack(() => {
        saveState = 'idle'
        saveError = error instanceof Error ? error.message : 'Failed to save local AI settings'
      })
    } finally {
      setTimeout(() => {
        untrack(() => {
          if (saveState === 'saved') {
            saveState = 'idle'
          }
        })
      }, 2000)
    }
  }, SAVE_DEBOUNCE_MS)

  $effect(() => {
    // BL-962: never a write built while no read of the saved servers succeeded (the cards are
    // not offered then either; this line keeps the whole list from being sent if one ever is).
    if (isLoading || !settingsLoaded) return

    const signature = makeSignature(servers)
    if (signature === persistedSignature) return

    const validationError = validateServers(servers)
    if (validationError) {
      saveError = validationError
      return
    }

    saveState = 'saving'
    saveError = null

    const updates: LocalAiServerUpdate[] = servers.map((server) => ({
      id: server.id,
      baseUrl: server.baseUrl,
      openaiPath: server.openaiPath,
      enabled: server.enabled,
      imageTransport: server.imageTransport,
      imageBaseUrl: server.imageBaseUrl
    }))

    debouncedSave(updates)
  })

  function resetServer(serverId: string) {
    const definition = LOCAL_AI_SERVER_DEFINITIONS.find((entry) => entry.id === serverId)
    if (!definition) return

    bumpEndpointDraftVersion(serverId)

    servers = servers.map((server) =>
      server.id === serverId
        ? {
            ...server,
            baseUrl: definition.defaultBaseUrl,
            openaiPath: definition.openaiPath,
            imageTransport: definition.defaultImageTransport,
            imageBaseUrl: definition.defaultImageBaseUrl
          }
        : server
    )
  }
</script>

<div class="batshit-settings-surface">
  <div class="space-y-4">
    <div class="flex min-w-0 items-center gap-1.5">
      <BatshitIcon id="local-ai" class="h-4 w-4" />
      <h3 class="batshit-settings-section-title">Local AI</h3>
      <SettingsInfoMenu ariaLabel="About Local AI" contentClass="w-80">
        <p>
          Configure the local runtimes Batshit can call directly, keep their endpoints healthy, and
          expose their local model lists to API agents.
        </p>
      </SettingsInfoMenu>
    </div>

    {#if settingsLoaded && duplicateBaseUrlWarning}
      <Card.Root class="batshit-settings-card-info-callout">
        <Card.Content class="batshit-settings-card-content-spacious flex items-center gap-2">
          <AlertCircle class="h-4 w-4 shrink-0" />
          <span>{duplicateBaseUrlWarning}</span>
        </Card.Content>
      </Card.Root>
    {/if}

    {#if !settingsLoaded && !isLoading}
      <!-- BL-962: the server cards wait for a real read of the saved servers. -->
      <div class="batshit-settings-inline-alert is-danger" data-testid="local-ai-load-error">
        <div class="flex items-center justify-between gap-2">
          <span>
            Local AI servers could not load, so the server cards are hidden. Press Retry to load
            them.
            {#if loadError && loadError !== LOAD_FAILED_MESSAGE}Details: {loadError}{/if}
          </span>
          <Button variant="outline" size="sm" onclick={loadServers}>
            <RefreshCw class="h-3.5 w-3.5" />
            Retry
          </Button>
        </div>
      </div>
    {:else if loadError}
      <Card.Root class="batshit-settings-card-danger">
        <Card.Content class="batshit-settings-card-content-spacious flex items-center gap-2">
          <AlertCircle class="h-4 w-4 shrink-0" />
          <span>{loadError}</span>
        </Card.Content>
      </Card.Root>
    {/if}

    {#if isLoading}
      <Card.Root class="batshit-settings-card batshit-settings-card-default">
        <Card.Content class="batshit-settings-card-content-spacious flex items-center gap-2">
          <Loader2 class="h-4 w-4 animate-spin" />
          Loading local AI settings...
        </Card.Content>
      </Card.Root>
    {:else if settingsLoaded}
      {#each servers as server (server.id)}
        {@const visibleStatus = statusFor(server)}
        <Card.Root class="batshit-settings-card batshit-settings-card-default batshit-settings-l1-card">
          <Collapsible.Root open={openServerId === server.id}>
            <button
              type="button"
              class="batshit-settings-l1-card-header flex w-full items-center justify-between gap-4 px-5 py-2 text-left"
              aria-expanded={openServerId === server.id}
              onclick={() => toggleServerOpen(server.id)}
            >
              <div class="flex min-w-0 items-center gap-3">
                <div class="batshit-settings-icon-frame h-9 w-9 shrink-0">
                  <IconRenderer
                    ref={getLocalAiIconRef(server.id)}
                    label={server.label}
                    iconClass="h-4 w-4 text-muted-foreground"
                  />
                </div>
                <div class="min-w-0 space-y-1">
                  <div class="flex items-center gap-1.5">
                    <p class="batshit-settings-form-label truncate">{server.label}</p>
                    <SettingsInfoMenu ariaLabel={`About ${server.label}`} contentClass="w-80">
                      <p>{server.description}</p>
                    </SettingsInfoMenu>
                  </div>
                  <p class="truncate font-mono text-[11px] text-muted-foreground">
                    {server.baseUrl}{server.openaiPath}
                  </p>
                </div>
              </div>

              <div class="flex flex-wrap items-center justify-end gap-2">
                <Badge variant={server.supports.management ? 'secondary' : 'outline'}>
                  {server.supports.management ? 'Model Tools' : 'Connect Only'}
                </Badge>
                <Badge variant={server.source === 'stored' ? 'secondary' : 'outline'}>
                  {server.source === 'stored' ? 'Saved' : 'Default'}
                </Badge>
                <Badge
                  variant="outline"
                  class={server.enabled ? 'batshit-settings-status-badge is-enabled' : 'batshit-settings-status-badge'}
                >
                  {server.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                {#if visibleStatus && visibleStatus.state !== 'unknown'}
                  <Badge
                    variant="outline"
                    class={`batshit-settings-status-badge ${visibleStatus.state === 'online' ? 'is-success' : visibleStatus.state === 'access-required' ? 'is-warning' : visibleStatus.state === 'unreachable' ? 'is-danger' : ''}`}
                  >
                    {visibleStatus.state === 'checking'
                      ? 'Checking'
                      : visibleStatus.state === 'online'
                        ? 'Online'
                        : visibleStatus.state === 'access-required'
                          ? 'Access Required'
                          : 'Unreachable'}
                  </Badge>
                {/if}
                <ChevronDown
                  class={`h-4 w-4 shrink-0 transition-transform ${openServerId === server.id ? 'rotate-180' : ''}`}
                />
              </div>
            </button>

            <Collapsible.Content class="space-y-4 px-6 py-4">
              <Card.Root class="batshit-settings-card-subtle-frame">
                <Card.Header class="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
                  <div class="flex items-center gap-1.5">
                    <Card.Title class="flex items-center gap-2">
                      <PlugZap class="h-4 w-4" />
                      Connection Settings
                    </Card.Title>
                    <SettingsInfoMenu ariaLabel={`About ${server.label} Connection Settings`} contentClass="w-80">
                      <p>
                        Set the runtime URL Batshit should call, whether it is enabled, and which
                        image-host URL the runtime can reach.
                      </p>
                    </SettingsInfoMenu>
                  </div>
                  {#if openServerId === server.id}
                    <SettingsSaveStatus
                      state={saveError ? 'error' : saveState}
                      error={saveError}
                      savedLabel="Saved"
                      sticky={false}
                    />
                  {/if}
                </Card.Header>

                <Card.Content class="space-y-4">
                <div class="batshit-settings-form-stack">
                  <div class="batshit-settings-toggle-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Enabled</Label.Root>
                        <SettingsInfoMenu ariaLabel={`About ${server.label} Enabled`}>
                          <p>
                            Disabled runtimes stay in the list but Batshit will not check them or pull
                            their models into the picker.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="flex items-center gap-3">
                      <span class="batshit-settings-form-label">
                        {server.enabled ? 'Enabled' : 'Disabled'}
                      </span>
                      <Switch.Root
                        checked={server.enabled}
                        onCheckedChange={(checked) => {
                          const enabled = checked === true
                          bumpEndpointDraftVersion(server.id)
                          servers = servers.map((row) =>
                            row.id === server.id ? { ...row, enabled } : row
                          )
                          if (!enabled) {
                            updateStatus(server.id, endpointIdentity(server), { state: 'unknown' })
                            updateModelList(server.id, endpointIdentity(server), { state: 'idle', models: [] })
                          }
                        }}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Base URL</Label.Root>
                        <SettingsInfoMenu ariaLabel={`About ${server.label} Base URL`}>
                          <p>The root URL for {server.label}’s local API.</p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-wide">
                      <Input
                        value={server.baseUrl}
                        oninput={(event) => {
                          const target = event.currentTarget as HTMLInputElement
                          bumpEndpointDraftVersion(server.id)
                          servers = servers.map((row) =>
                            row.id === server.id ? { ...row, baseUrl: target.value } : row
                          )
                        }}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">OpenAI Path</Label.Root>
                        <SettingsInfoMenu ariaLabel={`About ${server.label} OpenAI Path`}>
                          <p>
                            The path segment Batshit appends when calling the runtime’s
                            OpenAI-compatible endpoints.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        value={server.openaiPath}
                        oninput={(event) => {
                          const target = event.currentTarget as HTMLInputElement
                          bumpEndpointDraftVersion(server.id)
                          servers = servers.map((row) =>
                            row.id === server.id ? { ...row, openaiPath: target.value } : row
                          )
                        }}
                      />
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Image Transport</Label.Root>
                        <SettingsInfoMenu ariaLabel={`About ${server.label} Image Transport`} contentClass="w-80">
                          <p>
                            Automatic may send PNG/JPEG data URLs as image inputs, not prompt text.
                            Use Force URL only for runtimes that need to fetch uploaded images by URL.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Select.Root
                        type="single"
                        value={server.imageTransport}
                        onValueChange={(value) => {
                          const nextValue = Array.isArray(value) ? value[0] : value
                          if (nextValue !== 'auto' && nextValue !== 'url') return
                          servers = servers.map((row) =>
                            row.id === server.id
                              ? { ...row, imageTransport: nextValue as LocalAiImageTransport }
                              : row
                          )
                        }}
                      >
                        <Select.Trigger>
                          <span>
                            {IMAGE_TRANSPORT_OPTIONS.find((option) => option.value === server.imageTransport)?.label ||
                              'Automatic'}
                          </span>
                        </Select.Trigger>
                        <Select.Content>
                          {#each IMAGE_TRANSPORT_OPTIONS as option (option.value)}
                            <Select.Item value={option.value}>
                              <div class="flex flex-col">
                                <span>{option.label}</span>
                                <span class="text-xs text-muted-foreground">{option.helper}</span>
                              </div>
                            </Select.Item>
                          {/each}
                        </Select.Content>
                      </Select.Root>
                    </div>
                  </div>

                  <div class="batshit-settings-form-row">
                    <div class="batshit-settings-form-copy">
                      <div class="batshit-settings-form-label-line">
                        <Label.Root class="batshit-settings-form-label">Image Base URL</Label.Root>
                        <SettingsInfoMenu ariaLabel={`About ${server.label} Image Base URL`} contentClass="w-80">
                          <p>
                            This is the host the runtime uses when it needs to fetch an uploaded image
                            by URL. Docker Desktop often needs
                            <code>http://host.docker.internal:5600</code>.
                          </p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control is-wide">
                      <Input
                        value={server.imageBaseUrl}
                        oninput={(event) => {
                          const target = event.currentTarget as HTMLInputElement
                          servers = servers.map((row) =>
                            row.id === server.id ? { ...row, imageBaseUrl: target.value } : row
                          )
                        }}
                      />
                    </div>
                  </div>
                </div>

                <div class="grid gap-3 text-xs text-muted-foreground md:grid-cols-3">
                  <div class="batshit-settings-card-subtle-frame is-compact">
                    <div class="batshit-settings-form-label">OpenAI Base</div>
                    <code class="block break-all pt-1">{server.baseUrl}{server.openaiPath}</code>
                  </div>
                  <div class="batshit-settings-card-subtle-frame is-compact">
                    <div class="batshit-settings-form-label">Image Base</div>
                    <code class="block break-all pt-1">{server.imageBaseUrl}</code>
                  </div>
                  <div class="batshit-settings-card-subtle-frame is-compact">
                    <div class="batshit-settings-form-label">Management</div>
                    <div class="pt-1">
                      {server.supports.management
                        ? `Available model tools depend on the native API exposed by ${server.label}.`
                        : `Manage models in ${server.label} itself.`}
                    </div>
                  </div>
                </div>

                <div class="batshit-settings-action-row">
                  <div class="flex flex-wrap items-center justify-between gap-2">
                    <div class="flex flex-wrap items-center gap-2">
                      <Button
                        size="sm"
                        variant="secondary"
                        onclick={() => resetServer(server.id)}
                      >
                        <RotateCcw aria-hidden="true" />

                        Reset to Default
                      </Button>
                      <Button
                        size="sm"
                        variant="secondary"
                        onclick={() => checkServer(server)}
                        disabled={!server.enabled || statusFor(server)?.state === 'checking'}
                      >
                        {statusFor(server)?.state === 'checking' ? 'Checking…' : 'Check Status'}
                      </Button>
                      {#if statusFor(server)?.message}
                        <span class="batshit-settings-form-meta is-warning">{statusFor(server)?.message}</span>
                      {/if}
                    </div>
                    <Button size="sm" variant="ghost" onclick={loadServers}>
                      <RefreshCw  />
                      Reload
                    </Button>
                  </div>
                </div>
                </Card.Content>
              </Card.Root>

              {#if server.id === 'ollama'}
                <Card.Root class="batshit-settings-card-subtle-frame">
                  <Card.Header>
                    <div class="flex items-center gap-1.5">
                      <Card.Title class="flex items-center gap-2">
                        <Boxes class="h-4 w-4" />
                        Ollama Models
                      </Card.Title>
                      <SettingsInfoMenu ariaLabel="About Ollama Models">
                        <p>Manage locally installed Ollama models so they appear in the model picker.</p>
                      </SettingsInfoMenu>
                    </div>
                  </Card.Header>
                  <Card.Content class="batshit-settings-card-content-flush">
                    <OllamaModelManager baseUrl={server.baseUrl} />
                  </Card.Content>
                </Card.Root>
              {/if}

              {#if server.id === 'dmr'}
                <Card.Root class="batshit-settings-card-subtle-frame">
                  <Card.Header>
                    <div class="flex items-center gap-1.5">
                      <Card.Title class="flex items-center gap-2">
                        <Boxes class="h-4 w-4" />
                        Docker Model Runner Models
                      </Card.Title>
                      <SettingsInfoMenu ariaLabel="About Docker Model Runner Models" contentClass="w-80">
                        <p>
                          Create and remove Docker Model Runner models so they appear in the model
                          picker.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </Card.Header>
                  <Card.Content class="batshit-settings-card-content-flush">
                    <DmrModelManager baseUrl={server.baseUrl} openaiPath={server.openaiPath} />
                    <p class="batshit-settings-caption">
                      Download/delete controls do not describe model residency. Native unloading can discard Docker Model Runner's per-model runtime configuration; use Docker's own residency controls.
                    </p>
                  </Card.Content>
                </Card.Root>
              {/if}

              {#if MANAGEABLE_PROGRAMS.has(server.id)}
                <Card.Root class="batshit-settings-card-subtle-frame">
                  <Card.Header>
                    <div class="flex items-center gap-1.5">
                      <Card.Title class="flex items-center gap-2">
                        <Boxes class="h-4 w-4" />
                        {server.label} Models
                      </Card.Title>
                      <SettingsInfoMenu ariaLabel={`About ${server.label} Models`} contentClass="w-80">
                        <p>
                          Load keeps a model ready in memory. Unload releases it without deleting
                          its files and can interrupt active work. Controls appear only when
                          {server.label} exposes the required native API. llama.cpp needs router
                          mode; KoboldCpp needs its existing admin configuration.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                  </Card.Header>
                  <Card.Content class="batshit-settings-card-content-flush">
                    <LocalAiModelManager
                      programId={server.id}
                      enabled={server.enabled}
                      connectionReady={saveState !== 'saving' && makeSignature(servers) === persistedSignature}
                      onAvailabilityChange={() => checkServer(currentServer(server.id) ?? server)}
                    />
                  </Card.Content>
                </Card.Root>
              {/if}

              {#if server.supports.modelList && server.id !== 'ollama' && server.id !== 'dmr' && (!MANAGEABLE_PROGRAMS.has(server.id) || server.id === 'llama-cpp')}
                {@const currentModelList = modelListFor(server)}
                <Card.Root class="batshit-settings-card-subtle-frame">
                  <Card.Header class="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                    <div class="flex items-center gap-1.5">
                      <Card.Title class="flex items-center gap-2">
                        <PlugZap class="h-4 w-4" />
                        Detected Models
                      </Card.Title>
                      <SettingsInfoMenu ariaLabel={`About ${server.label} Detected Models`} contentClass="w-80">
                        <p>
                          Pull the currently available models from {server.label} so Batshit can
                          show them in the model picker.
                        </p>
                      </SettingsInfoMenu>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onclick={() => loadModelList(server)}
                      disabled={!server.enabled || currentModelList?.state === 'loading'}
                    >
                      <RefreshCw
                        class={`${currentModelList?.state === 'loading' ? 'animate-spin' : ''}`}
                      />
                      Refresh
                    </Button>
                  </Card.Header>
                  <Card.Content>
                    {#if currentModelList?.state === 'error'}
                      <div class="flex items-center gap-2 text-yellow-600">
                        <AlertCircle class="h-4 w-4" />
                        <span class="batshit-settings-form-label">
                          {currentModelList?.error ?? 'Failed to load models'}
                        </span>
                      </div>
                    {:else if currentModelList?.state === 'loaded'}
                      {#if server.id === 'vllm' || server.id === 'sglang'}
                        <p class="batshit-settings-caption">
                          This server loads its model at startup. Its memory release/resume controls affect the whole engine and can interrupt work; individual model Load/Unload is unavailable here.
                        </p>
                      {/if}
                      {#if currentModelList?.models.length}
                        <div class="space-y-2">
                          {#each currentModelList?.models ?? [] as model}
                            <div class="batshit-settings-model-row flex items-center justify-between">
                              <span class="truncate">{model}</span>
                            </div>
                          {/each}
                        </div>
                      {:else}
                        <p class="batshit-settings-caption">No models detected.</p>
                      {/if}
                    {:else}
                      <p class="batshit-settings-caption">
                        {server.enabled
                          ? `Load models when ${server.label} is running.`
                          : `Turn ${server.label} on to load models.`}
                      </p>
                    {/if}
                  </Card.Content>
                </Card.Root>
              {/if}
            </Collapsible.Content>
          </Collapsible.Root>
        </Card.Root>
      {/each}
    {/if}
  </div>
</div>
