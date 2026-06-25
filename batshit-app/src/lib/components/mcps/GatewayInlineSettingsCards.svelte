<script lang="ts">
  import { untrack } from 'svelte'
  import * as Select from '$lib/components/ui/select'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import { DEFAULT_MCP_GATEWAY_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import { parseIconRef, type IconRef } from '$lib/icons/iconTypes'
  import { debounce } from '$lib/utils/debounce'
  import { FolderTree, Loader2, Plus, Settings2, Trash2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import type { MCPGateway, MCPGatewayEnvRef, MCPToolGrouping } from '$lib/types/database'
  import MCPToolGroupingEditor from './MCPToolGroupingEditor.svelte'

  const INFRA_KEYS = new Set([
    'batshit_token',
    'n8n_internal_key',
    'n8n_api_key',
    'n8n_api_url',
    'batshit_artifact_complete_url',
    'n8n_instance_mcp_token',
    'ai_gateway',
    'browserbase_project_id',
    'browserbase_api_url',
    'browseruse_base_url',
    'kernel_base_url'
  ])

  type SaveState = 'idle' | 'saving' | 'saved' | 'error'
  type EnvRefRow = MCPGatewayEnvRef & { id: string }

  interface Props {
    gateway: MCPGateway
    userId?: string | null
    onGatewayUpdated?: (gateway: MCPGateway) => void
  }

  let { gateway, userId = null, onGatewayUpdated = () => {} }: Props = $props()

  let hydrating = $state(false)
  let name = $state('')
  let url = $state('')
  let authKeyName = $state('')
  let availableApiKeys = $state<string[]>([])
  let loadingApiKeys = $state(false)
  let availableTools = $state<string[]>([])
  let availableToolMetadata = $state<Record<string, { mcpName?: string }>>({})
  let loadingTools = $state(false)
  let toolGroupings = $state<MCPToolGrouping[]>([])
  let iconRef = $state<IconRef>(DEFAULT_MCP_GATEWAY_ICON_REF)
  let command = $state('')
  let argsText = $state('')
  let cwdPolicy = $state<'none' | 'project' | 'fixed'>('none')
  let cwdValue = $state('')
  let startupTimeoutMs = $state('10000')
  let toolCallTimeoutMs = $state('60000')
  let envRefs = $state<EnvRefRow[]>([])
  let dockerProfile = $state('default')

  let settingsSaveState = $state<SaveState>('idle')
  let settingsSaveError = $state<string | null>(null)
  let groupingSaveState = $state<SaveState>('idle')
  let groupingSaveError = $state<string | null>(null)
  let persistedSettingsSignature = $state('')
  let persistedGroupingSignature = $state('')
  let groupInputOpen = $state(false)
  let hydratedGatewayId = $state<string | null>(null)

  const groupingGatewayTypes = new Set([
    'n8n-mcp-trigger',
    'n8n-instance-mcp',
    'docker-catalog',
    'custom',
    'stdio'
  ])

  const supportsGrouping = $derived(groupingGatewayTypes.has(gateway.type))
  const isReadOnly = $derived(gateway.type === 'n8n-mcp-client')
  const isRuntimeManagedDockerUrl = $derived(
    gateway.type === 'docker-catalog' && gateway.metadata?.runtimeManagedUrl === true
  )
  const isRuntimeManagedDockerProfile = $derived(
    gateway.type === 'docker-catalog' && gateway.metadata?.runtimeManagedProfile === true
  )
  const dockerRuntimeManagedReason = $derived(
    gateway.metadata?.runtimeManagedUrlReason === 'mac-app-docker-gateway' ? 'mac' : 'docker'
  )
  const dockerProfilePattern = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

  function createEnvRefRow(value?: Partial<MCPGatewayEnvRef>): EnvRefRow {
    return {
      id: crypto.randomUUID(),
      envVar: value?.envVar ?? '',
      savedKeyRef: value?.savedKeyRef ?? ''
    }
  }

  function parseArgsInput(value: string) {
    return value
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  function normalizeEnvRefs(value: EnvRefRow[]): MCPGatewayEnvRef[] {
    return value
      .map((entry) => ({
        envVar: entry.envVar.trim(),
        savedKeyRef: entry.savedKeyRef.trim()
      }))
      .filter((entry) => entry.envVar.length > 0 || entry.savedKeyRef.length > 0)
  }

  function sanitizeToolGroupingsInput(value: unknown): MCPToolGrouping[] {
    if (!Array.isArray(value)) return []

    const normalized: MCPToolGrouping[] = []
    for (const entry of value) {
      if (!entry || typeof entry !== 'object') continue
      const rawName = (entry as Record<string, unknown>).mcpName
      const mcpName = typeof rawName === 'string' ? rawName.trim() : ''
      if (!mcpName) continue

      const rawToolIds = (entry as Record<string, unknown>).toolIds
      const toolIds = Array.isArray(rawToolIds)
        ? Array.from(
            new Set(
              rawToolIds
                .map((toolId) => (typeof toolId === 'string' ? toolId.trim() : ''))
                .filter((toolId) => toolId.length > 0)
            )
          )
        : []

      const raw = entry as Record<string, unknown>
      const rawIconRef = Object.prototype.hasOwnProperty.call(raw, 'icon_ref')
        ? raw.icon_ref
        : raw.iconRef
      const grouping: MCPToolGrouping = { mcpName, toolIds }
      if (rawIconRef !== undefined) {
        grouping.icon_ref = rawIconRef === null ? null : parseIconRef(rawIconRef)
      }

      normalized.push(grouping)
    }

    return normalized
  }

  function formatKeyLabel(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
  }

  function normalizeDockerProfileInput(value: string) {
    return value.trim() || 'default'
  }

  function isValidDockerProfile(value: string) {
    return dockerProfilePattern.test(normalizeDockerProfileInput(value))
  }

  function getDockerProfileFromGateway(source: MCPGateway) {
    const metadata = source.metadata && typeof source.metadata === 'object'
      ? source.metadata
      : {}
    const raw = metadata.dockerProfile ?? metadata.docker_profile
    return typeof raw === 'string' && raw.trim() ? raw.trim() : 'default'
  }

  async function loadApiKeys() {
    loadingApiKeys = true
    try {
      const response = await fetch('/api/settings/api-keys')
      if (!response.ok) return
      const data = await response.json()
      if (data.success && data.keys) {
        availableApiKeys = Object.entries(data.keys)
          .filter(([key, info]: [string, any]) => info.status === 'ready' && !INFRA_KEYS.has(key))
          .map(([key]) => key)
          .sort()
      }
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error loading API keys:', error)
    } finally {
      loadingApiKeys = false
    }
  }

  async function loadToolsForGateway(gatewayId: string) {
    if (!userId || !supportsGrouping) return

    loadingTools = true
    try {
      const response = await fetch(`/api/mcp/gateways/${gatewayId}/tools?userId=${userId}`)
      if (!response.ok) throw new Error('Failed to load tools')

      const data = await response.json()
      const mcps = Array.isArray(data?.mcps) ? data.mcps : []
      const allTools: string[] = []
      const metadata: Record<string, { mcpName?: string }> = {}
      for (const mcp of mcps) {
        for (const tool of mcp.tools) {
          allTools.push(tool.id)
          metadata[tool.id] = { mcpName: tool.mcpName || mcp.name }
        }
      }

      availableTools = allTools
      availableToolMetadata = metadata
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error loading tools:', error)
      toast.error('Failed to load tools from gateway')
    } finally {
      loadingTools = false
    }
  }

  function makeSettingsSignature() {
    return JSON.stringify({
      name: name.trim(),
      iconRef,
      url: url.trim(),
      authKeyName,
      command: command.trim(),
      args: parseArgsInput(argsText),
      cwdPolicy,
      cwdValue: cwdValue.trim(),
      startupTimeoutMs: Number(startupTimeoutMs) || 10000,
      toolCallTimeoutMs: Number(toolCallTimeoutMs) || 60000,
      envRefs: normalizeEnvRefs(envRefs),
      dockerProfile: gateway.type === 'docker-catalog'
        ? normalizeDockerProfileInput(dockerProfile)
        : undefined
    })
  }

  function makeGroupingSignature() {
    return JSON.stringify(sanitizeToolGroupingsInput(toolGroupings))
  }

  const isValid = $derived.by(() => {
    if (!name.trim()) return false
    if (gateway.type === 'stdio') {
      if (!command.trim()) return false
      if (cwdPolicy === 'fixed' && !cwdValue.trim()) return false
      for (const entry of normalizeEnvRefs(envRefs)) {
        if (!entry.envVar || !entry.savedKeyRef) return false
      }
      return true
    }

    if (gateway.type === 'n8n-mcp-client') return true
    if (
      gateway.type === 'docker-catalog' &&
      !isRuntimeManagedDockerProfile &&
      !isValidDockerProfile(dockerProfile)
    ) return false
    if (!url.trim()) return false
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  })

  $effect(() => {
    hydrating = true
    untrack(() => {
      const gatewayChanged = hydratedGatewayId !== gateway.id

      name = gateway.name
      iconRef = normalizeIconRef(gateway.icon_ref, DEFAULT_MCP_GATEWAY_ICON_REF)
      url = gateway.url || ''
      authKeyName = gateway.authKeyName || ''
      command = gateway.stdioConfig?.command || ''
      argsText = Array.isArray(gateway.stdioConfig?.args) ? gateway.stdioConfig.args.join('\n') : ''
      cwdPolicy = gateway.stdioConfig?.cwdPolicy || 'none'
      cwdValue = gateway.stdioConfig?.cwdValue || ''
      startupTimeoutMs = String(gateway.stdioConfig?.startupTimeoutMs ?? 10000)
      toolCallTimeoutMs = String(gateway.stdioConfig?.toolCallTimeoutMs ?? 60000)
      dockerProfile = getDockerProfileFromGateway(gateway)
      envRefs = Array.isArray(gateway.stdioConfig?.envRefs)
        ? gateway.stdioConfig.envRefs.map((entry) => createEnvRefRow(entry))
        : []
      toolGroupings = sanitizeToolGroupingsInput(gateway.toolGroupings)
      persistedSettingsSignature = makeSettingsSignature()
      persistedGroupingSignature = makeGroupingSignature()

      if (gatewayChanged) {
        settingsSaveState = 'idle'
        settingsSaveError = null
        groupingSaveState = 'idle'
        groupingSaveError = null
        groupInputOpen = false
      }

      hydratedGatewayId = gateway.id
    })
    hydrating = false

    if (gateway.type === 'custom' || gateway.type === 'stdio') {
      void loadApiKeys()
    }
    if (supportsGrouping && userId) {
      void loadToolsForGateway(gateway.id)
    } else {
      availableTools = []
      availableToolMetadata = {}
    }
  })

  async function persistSettings() {
    if (!userId || !isValid || isReadOnly) return

    try {
      const payload =
        gateway.type === 'stdio'
          ? {
              name: name.trim(),
              icon_ref: iconRef,
              url: undefined,
              stdioConfig: {
                command: command.trim(),
                args: parseArgsInput(argsText),
                cwdPolicy,
                ...(cwdPolicy === 'fixed' && cwdValue.trim() ? { cwdValue: cwdValue.trim() } : {}),
                envRefs: normalizeEnvRefs(envRefs),
                startupTimeoutMs: Number(startupTimeoutMs) || 10000,
                toolCallTimeoutMs: Number(toolCallTimeoutMs) || 60000,
                lastTestStatus: gateway.stdioConfig?.lastTestStatus || 'never',
                lastTestAt: gateway.stdioConfig?.lastTestAt,
                lastError: gateway.stdioConfig?.lastError ?? null,
                toolCount: gateway.stdioConfig?.toolCount
              }
            }
          : {
              name: name.trim(),
              icon_ref: iconRef,
              url: url.trim(),
              ...(gateway.type === 'custom' ? { authKeyName: authKeyName || undefined } : {}),
              ...(gateway.type === 'docker-catalog'
                ? {
                    metadata: {
                      ...(gateway.metadata ?? {}),
                      ...(!isRuntimeManagedDockerProfile
                        ? { dockerProfile: normalizeDockerProfileInput(dockerProfile) }
                        : {})
                    }
                  }
                : {})
            }

      const response = await fetch(`/api/mcp/gateways/${gateway.id}?userId=${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(body.error || 'Failed to update gateway')
      }

      const updatedGateway = body.gateway as MCPGateway
      persistedSettingsSignature = makeSettingsSignature()
      settingsSaveState = 'saved'
      settingsSaveError = null
      onGatewayUpdated(updatedGateway)
      setTimeout(() => {
        if (settingsSaveState === 'saved') settingsSaveState = 'idle'
      }, 1600)
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error updating gateway:', error)
      settingsSaveState = 'idle'
      settingsSaveError = error instanceof Error ? error.message : 'Failed to update gateway'
    }
  }

  const debouncedPersistSettings = debounce(async () => {
    await persistSettings()
  }, 600)

  $effect(() => {
    if (hydrating || !userId || isReadOnly) return

    const signature = makeSettingsSignature()
    if (signature === persistedSettingsSignature) return
    if (!isValid) return

    settingsSaveState = 'saving'
    settingsSaveError = null
    debouncedPersistSettings()
  })

  async function persistGrouping() {
    if (!userId || !supportsGrouping || isReadOnly) return

    try {
      const response = await fetch(`/api/mcp/gateways/${gateway.id}?userId=${userId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          toolGroupings: sanitizeToolGroupingsInput(toolGroupings)
        })
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(body.error || 'Failed to update tool grouping')
      }

      const updatedGateway = body.gateway as MCPGateway
      persistedGroupingSignature = makeGroupingSignature()
      groupingSaveState = 'saved'
      groupingSaveError = null
      onGatewayUpdated(updatedGateway)
      setTimeout(() => {
        if (groupingSaveState === 'saved') groupingSaveState = 'idle'
      }, 1600)
    } catch (error) {
      console.error('[GatewayInlineSettingsCards] Error updating grouping:', error)
      groupingSaveState = 'idle'
      groupingSaveError = error instanceof Error ? error.message : 'Failed to update tool grouping'
    }
  }

  const debouncedPersistGrouping = debounce(async () => {
    await persistGrouping()
  }, 600)

  $effect(() => {
    if (hydrating || !userId || !supportsGrouping || isReadOnly) return

    const signature = makeGroupingSignature()
    if (signature === persistedGroupingSignature) return

    groupingSaveState = 'saving'
    groupingSaveError = null
    debouncedPersistGrouping()
  })

  function addEnvRef() {
    envRefs = [...envRefs, createEnvRefRow()]
  }

  function removeEnvRef(id: string) {
    envRefs = envRefs.filter((entry) => entry.id !== id)
  }

  function updateEnvRef(id: string, field: 'envVar' | 'savedKeyRef', value: string) {
    envRefs = envRefs.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry))
  }
</script>

{#if !isReadOnly}
  <SettingsAccordionCard
    name="mcp-source-detail-cards"
    title="Gateway Settings"
    icon={Settings2}
    open
    contentClass="space-y-4"
  >
    {#snippet actions()}
      <div class="flex items-center gap-2 sm:ml-auto">
        <SettingsSaveStatus
          state={settingsSaveError ? 'error' : settingsSaveState}
          error={settingsSaveError}
          savingLabel="Saving..."
          savedLabel="Settings Saved"
          sticky={false}
        />
      </div>
    {/snippet}

      <div class="batshit-settings-form-stack">
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label class="batshit-settings-form-label" for={`gateway-name-${gateway.id}`}>
                Gateway Name
              </Label>
            </div>
          </div>
          <div class="batshit-settings-form-control">
            <Input
              id={`gateway-name-${gateway.id}`}
              bind:value={name}
              placeholder="Gateway name"
            />
          </div>
        </div>

        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label class="batshit-settings-form-label">Icon</Label>
            </div>
          </div>
          <div class="batshit-settings-form-control is-compact-action">
            <IconPicker bind:value={iconRef} disabled={isReadOnly} triggerLabel="Choose Icon" onlineSearchHint={name} />
          </div>
        </div>
      </div>

      {#if gateway.type === 'stdio'}
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`stdio-command-${gateway.id}`}>
                  Command
                </Label>
                <SettingsInfoMenu ariaLabel="About STDIO Command">
                  <p>The executable or script Batshit launches for this local STDIO MCP source.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input id={`stdio-command-${gateway.id}`} bind:value={command} />
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label">Working Directory</Label>
                <SettingsInfoMenu ariaLabel="About Working Directory">
                  <p>
                    Choose whether this source launches from Batshit's active project, a fixed
                    directory, or no custom directory.
                  </p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Select.Root
                type="single"
                value={cwdPolicy}
                onValueChange={(value) => (cwdPolicy = (value as typeof cwdPolicy) ?? 'none')}
              >
                <Select.Trigger class="w-full">
                  <span data-slot="select-value" class="batshit-settings-form-label">
                    {cwdPolicy === 'project'
                      ? 'Project directory'
                      : cwdPolicy === 'fixed'
                        ? 'Fixed directory'
                        : 'No custom cwd'}
                  </span>
                </Select.Trigger>
                <Select.Content>
                  <Select.Item value="none">No custom cwd</Select.Item>
                  <Select.Item value="project">Project directory</Select.Item>
                  <Select.Item value="fixed">Fixed directory</Select.Item>
                </Select.Content>
              </Select.Root>
            </div>
          </div>

          {#if cwdPolicy === 'fixed'}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label class="batshit-settings-form-label" for={`stdio-cwd-${gateway.id}`}>
                    Fixed Directory
                  </Label>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <Input id={`stdio-cwd-${gateway.id}`} bind:value={cwdValue} />
              </div>
            </div>
          {/if}

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`startup-timeout-${gateway.id}`}>
                  Startup Timeout
                </Label>
                <SettingsInfoMenu ariaLabel="About Startup Timeout">
                  <p>How long Batshit waits for the STDIO server process to start, in milliseconds.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id={`startup-timeout-${gateway.id}`}
                type="number"
                min="1000"
                step="1000"
                bind:value={startupTimeoutMs}
              />
            </div>
          </div>

          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`tool-timeout-${gateway.id}`}>
                  Tool Call Timeout
                </Label>
                <SettingsInfoMenu ariaLabel="About Tool Call Timeout">
                  <p>How long one tool call may run before Batshit treats it as timed out.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id={`tool-timeout-${gateway.id}`}
                type="number"
                min="1000"
                step="1000"
                bind:value={toolCallTimeoutMs}
              />
            </div>
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="batshit-settings-form-label-line">
            <Label class="batshit-settings-form-label" for={`stdio-args-${gateway.id}`}>
              Arguments
            </Label>
            <SettingsInfoMenu ariaLabel="About STDIO Arguments">
              <p>One launch argument per line. This stays as a multiline field so long command lists stay readable.</p>
            </SettingsInfoMenu>
          </div>
          <Textarea id={`stdio-args-${gateway.id}`} rows={4} bind:value={argsText} />
        </div>

        <div class="batshit-settings-card-subtle-frame is-compact space-y-3">
          <div class="flex items-center justify-between gap-3">
            <div class="flex items-center gap-1.5">
              <p class="batshit-settings-form-label">Environment References</p>
              <SettingsInfoMenu ariaLabel="About Environment References" contentClass="w-80">
                <p>
                  Map saved API keys into environment variables without storing raw secrets in the
                  gateway record.
                </p>
              </SettingsInfoMenu>
            </div>
            <Button type="button" variant="outline" size="sm" onclick={addEnvRef}>
              <Plus  />
              Add Env Ref
            </Button>
          </div>

          {#if loadingApiKeys}
            <div class="batshit-settings-caption flex items-center gap-2">
              <Loader2 class="h-3 w-3 animate-spin" />
              Loading keys...
            </div>
          {:else if envRefs.length === 0}
            <div class="batshit-settings-note is-dashed">
              No env refs yet.
            </div>
          {:else}
            <div class="space-y-3">
              {#each envRefs as entry (entry.id)}
                <div class="batshit-settings-card-subtle-frame is-compact">
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label class="batshit-settings-form-label" for={`env-var-${entry.id}`}>
                            Env Var
                          </Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          id={`env-var-${entry.id}`}
                          value={entry.envVar}
                          oninput={(event) => updateEnvRef(entry.id, 'envVar', (event.currentTarget as HTMLInputElement).value)}
                          placeholder="GITHUB_TOKEN"
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <Label class="batshit-settings-form-label">Saved Key</Label>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={entry.savedKeyRef || undefined}
                          onValueChange={(value) => updateEnvRef(entry.id, 'savedKeyRef', value ?? '')}
                        >
                          <Select.Trigger class="w-full">
                            <span data-slot="select-value" class="batshit-settings-form-label">
                              {entry.savedKeyRef ? formatKeyLabel(entry.savedKeyRef) : 'Choose a saved key'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each availableApiKeys as key}
                              <Select.Item value={key}>{formatKeyLabel(key)}</Select.Item>
                            {/each}
                          </Select.Content>
                        </Select.Root>
                      </div>
                    </div>

                    <div class="batshit-settings-form-row is-compact">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <span class="batshit-settings-form-label">Remove Env Ref</span>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control is-compact-action">
                        <Button type="button" variant="ghost" size="icon" onclick={() => removeEnvRef(entry.id)}>
                          <Trash2  />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
          {/if}
        </div>
      {:else}
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <Label class="batshit-settings-form-label" for={`gateway-url-${gateway.id}`}>
                  {gateway.type === 'docker-catalog' ? 'Gateway URL' : 'MCP Endpoint URL'}
                </Label>
                <SettingsInfoMenu ariaLabel="About Gateway URL">
                  <p>The endpoint Batshit contacts when discovering or calling tools from this MCP source.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <div class="batshit-settings-form-control">
              <Input
                id={`gateway-url-${gateway.id}`}
                bind:value={url}
                disabled={isRuntimeManagedDockerUrl}
                placeholder={
                  gateway.type === 'docker-catalog'
                    ? 'http://localhost:8080/mcp'
                    : gateway.type === 'n8n-instance-mcp'
                      ? 'http://localhost:5678/mcp-server/http'
                      : 'http://localhost:5678/mcp/your-path'
                }
              />
              {#if isRuntimeManagedDockerUrl}
                <p class="batshit-settings-form-help">
                  {dockerRuntimeManagedReason === 'mac'
                    ? 'Managed by the Mac runtime. Restart Batshit from Runtime Doctor after changing runtime config.'
                    : 'Managed by Docker. Change .env.docker, then restart containers.'}
                </p>
              {/if}
            </div>
          </div>

          {#if gateway.type === 'docker-catalog'}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label class="batshit-settings-form-label" for={`docker-profile-${gateway.id}`}>
                    Docker Profile
                  </Label>
                  <SettingsInfoMenu ariaLabel="About Docker Profile" contentClass="w-80">
                    <p>
                      The Docker MCP profile ID passed to Docker the next time Batshit launches the
                      gateway. Relaunch Batshit after changing it.
                    </p>
                    <p class="mt-2">
                      Use letters, numbers, dots, underscores, and hyphens only.
                    </p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control-group">
                <Input
                  id={`docker-profile-${gateway.id}`}
                  bind:value={dockerProfile}
                  disabled={isRuntimeManagedDockerProfile}
                  placeholder="default"
                  aria-invalid={!isRuntimeManagedDockerProfile && !isValidDockerProfile(dockerProfile)}
                />
                {#if isRuntimeManagedDockerProfile}
                  <p class="batshit-settings-form-help">
                    Managed by Docker. Change DOCKER_MCP_PROFILE in .env.docker, then restart containers.
                  </p>
                {/if}
                {#if !isRuntimeManagedDockerProfile && !isValidDockerProfile(dockerProfile)}
                  <div class="batshit-settings-inline-alert is-danger">
                    Use the Docker MCP profile ID, such as <span class="batshit-settings-inline-strong">default</span>. Letters, numbers, dots, underscores, and hyphens only.
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          {#if gateway.type === 'custom'}
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <Label class="batshit-settings-form-label">Auth Key</Label>
                  <SettingsInfoMenu ariaLabel="About Auth Key">
                    <p>Choose a saved API key to send with this custom MCP source, or leave auth off.</p>
                  </SettingsInfoMenu>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                {#if loadingApiKeys}
                  <div class="batshit-settings-caption flex items-center gap-2">
                    <Loader2 class="h-3 w-3 animate-spin" />
                    Loading keys...
                  </div>
                {:else if availableApiKeys.length === 0}
                  <div class="batshit-settings-note is-dashed">
                    No API keys configured. Add keys in Settings -> API Keys first.
                  </div>
                {:else}
                  <Select.Root
                    type="single"
                    value={authKeyName || undefined}
                    onValueChange={(value) => (authKeyName = value ?? '')}
                  >
                    <Select.Trigger class="w-full">
                      <span data-slot="select-value" class="batshit-settings-form-label">
                        {authKeyName ? formatKeyLabel(authKeyName) : 'None (no auth)'}
                      </span>
                    </Select.Trigger>
                    <Select.Content>
                      <Select.Item value="">None (no auth)</Select.Item>
                      {#each availableApiKeys as key}
                        <Select.Item value={key}>{formatKeyLabel(key)}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                {/if}
              </div>
            </div>
          {/if}
        </div>
      {/if}
  </SettingsAccordionCard>
{/if}

<SettingsAccordionCard
  name="mcp-source-detail-cards"
  title="MCP Groups"
  icon={FolderTree}
>
  {#snippet info()}
      <SettingsInfoMenu ariaLabel="About MCP Groups" contentClass="w-96">
        <p>
          MCP groups help organize tools when a source returns one large mixed list instead of
          separating tools by MCP server.
        </p>
        <p class="mt-2">
          It is best to use group names the AI will understand clearly, such as
          <span class="batshit-settings-form-label">“firecrawl”</span>
          or
          <span class="batshit-settings-form-label">“github”</span>.
        </p>
      </SettingsInfoMenu>
  {/snippet}

  {#snippet actions()}
    <div class="flex items-center gap-2 sm:ml-auto">
      {#if supportsGrouping && !isReadOnly}
        <Button type="button" variant="outline" size="sm" onclick={() => (groupInputOpen = true)}>
          <Plus  />
          Add MCP Group
        </Button>
      {/if}

      <SettingsSaveStatus
        state={groupingSaveError ? 'error' : groupingSaveState}
        error={groupingSaveError}
        savingLabel="Saving..."
        savedLabel="Settings Saved"
        sticky={false}
      />
    </div>
  {/snippet}

    {#if isReadOnly}
      <div class="batshit-settings-note is-dashed">
        This source is auto-discovered from n8n and is managed inside n8n.
      </div>
    {:else if !supportsGrouping}
      <div class="batshit-settings-note is-dashed">
        This gateway type does not currently use tool grouping.
      </div>
    {:else if loadingTools}
      <div class="batshit-settings-caption flex items-center gap-2">
        <Loader2 class="h-4 w-4 animate-spin" />
        Loading tools…
      </div>
    {:else}
      {#if availableTools.length === 0}
        <div class="batshit-settings-note is-dashed mb-4">
          No tools are available yet. Make sure the source is reachable, then refresh it.
        </div>
      {/if}
      <MCPToolGroupingEditor
        availableTools={availableTools}
        toolMetadata={availableToolMetadata}
        bind:showNewGroupInput={groupInputOpen}
        groupings={toolGroupings}
        onChange={(nextGroupings: MCPToolGrouping[]) => {
          toolGroupings = sanitizeToolGroupingsInput(nextGroupings)
        }}
      />
    {/if}
</SettingsAccordionCard>
