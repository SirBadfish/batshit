<script lang="ts">
  import { onMount, untrack } from 'svelte'
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
  import type { IconRef } from '$lib/icons/iconTypes'
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
  import type { UserSettingsRow } from '$lib/types/database'
  import { dispatchLocalAiSettingsUpdated } from '$lib/utils/liveSettingsEvents'

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
  let isLoading = $state(true)
  let loadError = $state<string | null>(null)
  let saveState = $state<'idle' | 'saving' | 'saved'>('idle')
  let saveError = $state<string | null>(null)
  let persistedSignature = $state(makeSignature(defaultServers))

  type ServerStatus = {
    state: 'unknown' | 'checking' | 'online' | 'offline'
    message?: string
  }

  let openServerId = $state<string | null>(null)
  let serverStatus = $state<Record<string, ServerStatus>>({})
  type ModelListState = {
    state: 'idle' | 'loading' | 'loaded' | 'error'
    models: string[]
    error?: string
  }

  const LOCAL_AI_ICON_REFS: Partial<Record<string, IconRef>> = {
    ollama: { kind: 'brand', slug: 'ollama-mono', fixed: true },
    dmr: { kind: 'brand', slug: 'docker-color', fixed: true },
    lmstudio: { kind: 'brand', slug: 'lmstudio-mono', fixed: true },
    'llama-cpp': { kind: 'brand', slug: 'llamacpp-color', fixed: true },
    vllm: { kind: 'brand', slug: 'vllm-color', fixed: true }
  }

  function getLocalAiIconRef(serverId: string): IconRef {
    return LOCAL_AI_ICON_REFS[serverId] ?? { kind: 'lucide', id: 'server' }
  }
  let modelListState = $state<Record<string, ModelListState>>({})

  function toggleServerOpen(id: string) {
    openServerId = openServerId === id ? null : id
  }

  onMount(async () => {
    await loadServers()
  })

  async function loadServers() {
    isLoading = true
    loadError = null

    try {
      const response = await fetch('/api/settings/local-ai')
      if (!response.ok) {
        throw new Error('Failed to load local AI servers')
      }
      const payload = await response.json()
      servers = payload?.servers ?? defaultServers
      persistedSignature = makeSignature(servers)
      modelListState = {}
    } catch (error) {
      console.error('Failed to load local AI servers:', error)
      loadError = error instanceof Error ? error.message : 'Failed to load local AI servers'
      servers = [...defaultServers]
      persistedSignature = makeSignature(servers)
      modelListState = {}
    } finally {
      isLoading = false
    }
  }

  function updateStatus(id: string, next: ServerStatus) {
    serverStatus = {
      ...serverStatus,
      [id]: next
    }
  }

  async function checkServer(server: LocalAiServerSummary) {
    const target = `${server.baseUrl}${server.openaiPath}/models`
    updateStatus(server.id, { state: 'checking' })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)

    try {
      const response = await fetch(target, { signal: controller.signal })
      if (response.ok) {
        updateStatus(server.id, { state: 'online' })
      } else {
        updateStatus(server.id, { state: 'offline', message: `HTTP ${response.status}` })
      }
    } catch (error) {
      updateStatus(server.id, {
        state: 'offline',
        message: error instanceof Error ? error.message : 'Connection failed'
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  function updateModelList(id: string, next: ModelListState) {
    modelListState = {
      ...modelListState,
      [id]: next
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
    const target = `${server.baseUrl}${server.openaiPath}/models`
    updateModelList(server.id, { state: 'loading', models: [] })

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 4000)

    try {
      const response = await fetch(target, { signal: controller.signal })
      if (!response.ok) {
        updateModelList(server.id, {
          state: 'error',
          models: [],
          error: `HTTP ${response.status}`
        })
        return
      }
      const payload = await response.json().catch(() => null)
      const models = parseModelList(payload)
      updateModelList(server.id, { state: 'loaded', models })
    } catch (error) {
      updateModelList(server.id, {
        state: 'error',
        models: [],
        error: error instanceof Error ? error.message : 'Failed to load models'
      })
    } finally {
      clearTimeout(timeout)
    }
  }

  function makeSignature(list: LocalAiServerSummary[]) {
    return list
      .map(
        (server) =>
          `${server.id}:${server.baseUrl}:${server.openaiPath}:${server.enabled}:${server.imageTransport}:${server.imageBaseUrl}`
      )
      .join('|')
  }

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
    if (isLoading) return

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

    {#if loadError}
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
    {:else}
      {#each servers as server (server.id)}
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
                  {server.supports.management ? 'Managed' : 'Connect Only'}
                </Badge>
                <Badge variant={server.source === 'stored' ? 'secondary' : 'outline'}>
                  {server.source === 'stored' ? 'Saved' : 'Default'}
                </Badge>
                <Badge variant={server.enabled ? 'secondary' : 'outline'}>
                  {server.enabled ? 'Enabled' : 'Disabled'}
                </Badge>
                {#if serverStatus[server.id]?.state}
                  <Badge
                    variant={serverStatus[server.id].state === 'online' ? 'secondary' : 'outline'}
                  >
                    {serverStatus[server.id].state === 'checking'
                      ? 'Checking'
                      : serverStatus[server.id].state === 'online'
                        ? 'Online'
                        : 'Offline'}
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
                          servers = servers.map((row) =>
                            row.id === server.id ? { ...row, enabled } : row
                          )
                          if (!enabled) {
                            updateStatus(server.id, { state: 'unknown' })
                            updateModelList(server.id, { state: 'idle', models: [] })
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
                          <p>The root URL for this runtime’s local API.</p>
                        </SettingsInfoMenu>
                      </div>
                    </div>
                    <div class="batshit-settings-form-control">
                      <Input
                        value={server.baseUrl}
                        oninput={(event) => {
                          const target = event.currentTarget as HTMLInputElement
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
                    <div class="batshit-settings-form-control">
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
                        ? 'Batshit can manage models for this runtime.'
                        : 'Manage models in the runtime itself.'}
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
                        disabled={!server.enabled || serverStatus[server.id]?.state === 'checking'}
                      >
                        {serverStatus[server.id]?.state === 'checking' ? 'Checking…' : 'Check Status'}
                      </Button>
                      {#if serverStatus[server.id]?.message}
                        <span class="batshit-settings-form-label">{serverStatus[server.id].message}</span>
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
                  </Card.Content>
                </Card.Root>
              {/if}

              {#if server.supports.modelList && server.id !== 'ollama' && server.id !== 'dmr'}
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
                      disabled={!server.enabled || modelListState[server.id]?.state === 'loading'}
                    >
                      <RefreshCw
                        class={`${modelListState[server.id]?.state === 'loading' ? 'animate-spin' : ''}`}
                      />
                      Refresh
                    </Button>
                  </Card.Header>
                  <Card.Content>
                    {#if modelListState[server.id]?.state === 'error'}
                      <div class="flex items-center gap-2 text-yellow-600">
                        <AlertCircle class="h-4 w-4" />
                        <span class="batshit-settings-form-label">
                          {modelListState[server.id]?.error ?? 'Failed to load models'}
                        </span>
                      </div>
                    {:else if modelListState[server.id]?.state === 'loaded'}
                      {#if modelListState[server.id]?.models.length}
                        <div class="space-y-2">
                          {#each modelListState[server.id]?.models ?? [] as model}
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
                          ? 'Load models when the server is running.'
                          : 'Enable this runtime to load models.'}
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
