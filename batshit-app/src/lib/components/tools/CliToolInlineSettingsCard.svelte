<script lang="ts">
  import { untrack } from 'svelte'
  import * as Collapsible from '$lib/components/ui/collapsible'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsSaveStatus from '$lib/components/settings/SettingsSaveStatus.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
  import { Button } from '$lib/components/ui/button'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import { DEFAULT_CLI_TOOL_ICON_REF } from '$lib/icons/iconCatalog'
  import { normalizeIconRef } from '$lib/icons/iconLegacy'
  import type { IconRef } from '$lib/icons/iconTypes'
  import { debounce } from '$lib/utils/debounce'
  import {
    ChevronDown,
    Pencil,
    Plus,
    Settings2,
    Trash2
  } from '@lucide/svelte'
  import type { CliToolRecord } from '$lib/types/database'

  type SaveState = 'idle' | 'saving' | 'saved' | 'error'

  type EnvRefRow = {
    id: string
    envVar: string
    savedKeyRef: string
  }

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

  interface Props {
    tool: CliToolRecord
    onToolUpdated?: (tool: CliToolRecord) => void
  }

  let { tool, onToolUpdated = () => {} }: Props = $props()

  let hydrating = $state(false)
  let title = $state('')
  let description = $state('')
  let tagsText = $state('')
  let status = $state<'active' | 'disabled' | 'archived'>('active')
  let allowNetwork = $state(false)
  let allowWrite = $state(false)
  let allowedPathsText = $state('')
  let iconRef = $state<IconRef>(DEFAULT_CLI_TOOL_ICON_REF)
  let envRefs = $state<EnvRefRow[]>([])
  let detailsOpen = $state(false)
  let descriptionEditorOpen = $state(false)
  let availableKeys = $state<string[]>([])
  let saveState = $state<SaveState>('idle')
  let saveError = $state<string | null>(null)
  let persistedSignature = $state('')

  function createEnvRefRow(value?: { envVar?: string; savedKeyRef?: string }): EnvRefRow {
    return {
      id: crypto.randomUUID(),
      envVar: value?.envVar ?? '',
      savedKeyRef: value?.savedKeyRef ?? ''
    }
  }

  function formatJson(value: unknown, fallback = 'None declared') {
    if (value === undefined || value === null) return fallback
    try {
      return JSON.stringify(value, null, 2)
    } catch {
      return fallback
    }
  }

  function formatList(value: string[] | undefined, fallback = 'None declared') {
    if (!value || value.length === 0) return fallback
    return value.join('\n')
  }

  function formatKeyLabel(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
  }

  function formatDate(value: string | undefined): string {
    if (!value) return 'Unknown'
    const parsed = new Date(value)
    if (Number.isNaN(parsed.getTime())) return value
    return parsed.toLocaleString()
  }

  function formatOutputMode(value: CliToolRecord['outputMode']): string {
    if (value === 'json') return 'JSON'
    if (value === 'mixed') return 'Mixed'
    return 'Text'
  }

  function formatParseMode(value: CliToolRecord['parseMode']): string {
    if (value === 'json_in_text') return 'JSON in text'
    if (value === 'json') return 'JSON'
    return 'Text'
  }

  function formatCwd(toolRecord: CliToolRecord): string {
    if (toolRecord.cwdPolicy === 'fixed') {
      return toolRecord.cwdValue ? `Fixed: ${toolRecord.cwdValue}` : 'Fixed'
    }
    if (toolRecord.cwdPolicy === 'project') return 'Active project'
    return 'None'
  }

  function splitLines(value: string): string[] {
    return value
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  function splitTags(value: string): string[] {
    return value
      .split(',')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  function buildEnvRefPayload() {
    return envRefs
      .map((entry) => ({
        envVar: entry.envVar.trim(),
        savedKeyRef: entry.savedKeyRef.trim()
      }))
      .filter((entry) => entry.envVar.length > 0 && entry.savedKeyRef.length > 0)
  }

  function makeSignature() {
    return JSON.stringify({
      title: title.trim(),
      description: description.trim(),
      tagsText,
      status,
      allowNetwork,
      allowWrite,
      allowedPathsText,
      iconRef,
      envRefs: envRefs.map((entry) => ({
        envVar: entry.envVar,
        savedKeyRef: entry.savedKeyRef
      }))
    })
  }

  const envRefsValid = $derived(
    envRefs.every((entry) => {
      const hasEnv = entry.envVar.trim().length > 0
      const hasKey = entry.savedKeyRef.trim().length > 0
      return (hasEnv && hasKey) || (!hasEnv && !hasKey)
    })
  )

  const isValid = $derived(
    title.trim().length > 0 &&
      description.trim().length > 0 &&
      (!allowWrite || splitLines(allowedPathsText).length > 0) &&
      envRefsValid
  )

  $effect(() => {
    hydrating = true
    untrack(() => {
      title = tool.title
      description = tool.description
      tagsText = tool.tags.join(', ')
      status = tool.status
      allowNetwork = tool.allowNetwork
      allowWrite = tool.allowWrite
      allowedPathsText = tool.allowedPaths?.join('\n') ?? ''
      iconRef = normalizeIconRef(tool.iconRef ?? tool.iconHint, DEFAULT_CLI_TOOL_ICON_REF)
      envRefs = Array.isArray(tool.envRefs) ? tool.envRefs.map((entry) => createEnvRefRow(entry)) : []
      detailsOpen = false
      descriptionEditorOpen = false
      saveState = 'idle'
      saveError = null
      persistedSignature = makeSignature()
    })
    hydrating = false
    void loadApiKeys()
  })

  async function loadApiKeys() {
    try {
      const response = await fetch('/api/settings/api-keys')
      if (!response.ok) return
      const data = await response.json()
      availableKeys = Object.entries(data.keys ?? {})
        .filter(([key, info]: [string, any]) => info.status === 'ready' && !INFRA_KEYS.has(key))
        .map(([key]) => key)
        .sort()
    } catch (error) {
      console.error('[CliToolInlineSettingsCard] Failed to load API keys:', error)
    }
  }

  async function persistTool() {
    try {
      const payload = {
        title: title.trim(),
        description: description.trim(),
        tags: splitTags(tagsText),
        status,
        allowNetwork,
        allowWrite,
        allowedPaths: splitLines(allowedPathsText),
        iconRef,
        envRefs: buildEnvRefPayload()
      }

      const response = await fetch(`/api/cli-tools/${tool.toolId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      })

      const body = await response.json().catch(() => ({}))
      if (!response.ok) {
        throw new Error(body.error || 'Failed to save CLI tool')
      }

      persistedSignature = makeSignature()
      saveState = 'saved'
      saveError = null
      onToolUpdated(body.tool as CliToolRecord)
      setTimeout(() => {
        if (saveState === 'saved') saveState = 'idle'
      }, 1600)
    } catch (error) {
      console.error('[CliToolInlineSettingsCard] Failed to save CLI tool:', error)
      saveState = 'idle'
      saveError = error instanceof Error ? error.message : 'Failed to save CLI tool'
    }
  }

  const debouncedPersistTool = debounce(async () => {
    await persistTool()
  }, 600)

  $effect(() => {
    if (hydrating) return
    const signature = makeSignature()
    if (signature === persistedSignature) return
    if (!isValid) return

    saveState = 'saving'
    saveError = null
    debouncedPersistTool()
  })

  function addEnvRef() {
    envRefs = [...envRefs, createEnvRefRow()]
  }

  function updateEnvRef(id: string, field: 'envVar' | 'savedKeyRef', value: string) {
    envRefs = envRefs.map((entry) => (entry.id === id ? { ...entry, [field]: value } : entry))
  }

  function removeEnvRef(id: string) {
    envRefs = envRefs.filter((entry) => entry.id !== id)
  }
</script>

<SettingsAccordionCard
  name="cli-tool-detail-cards"
  title="CLI Tool Settings"
  icon={Settings2}
  open
  contentClass="space-y-5"
>
  {#snippet actions()}
    <SettingsSaveStatus
      state={saveError ? 'error' : saveState}
      error={saveError}
      savedLabel="Settings Saved"
    />
  {/snippet}

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label class="batshit-settings-form-label" for={`cli-title-${tool.toolId}`}>
            Title
          </Label>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input
          id={`cli-title-${tool.toolId}`}
          bind:value={title}
          placeholder="Repo Snapshot"
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
        <IconPicker bind:value={iconRef} triggerLabel="Choose Icon" />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label class="batshit-settings-form-label" for={`cli-description-${tool.toolId}`}>
            Description
          </Label>
          <SettingsInfoMenu ariaLabel="About CLI Tool Description">
            <p>The short agent-facing description used when Batshit lists this saved CLI tool.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control is-inline-status">
        <span
          id={`cli-description-${tool.toolId}`}
          class="batshit-settings-description-preview min-w-0 flex-1 truncate"
          title={description.trim() || 'No description'}
        >
          {description.trim() || 'No description'}
        </span>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onclick={() => (descriptionEditorOpen = true)}
        >
          <Pencil />
          Edit
        </Button>
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label class="batshit-settings-form-label" for={`cli-tags-${tool.toolId}`}>
            Tags
          </Label>
          <SettingsInfoMenu ariaLabel="About CLI Tool Tags">
            <p>Comma-separated labels used for filtering and quick scanning.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Input id={`cli-tags-${tool.toolId}`} bind:value={tagsText} placeholder="git, snapshot, local" />
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <div class="batshit-settings-form-label-line">
          <Label class="batshit-settings-form-label">Status</Label>
          <SettingsInfoMenu ariaLabel="About CLI Tool Status">
            <p>Active tools can be discovered and used. Disabled or archived tools stay saved but unavailable.</p>
          </SettingsInfoMenu>
        </div>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root
          type="single"
          value={status}
          onValueChange={(value) => value && (status = value as typeof status)}
        >
          <Select.Trigger class="w-full">
            <span data-slot="select-value">{status}</span>
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="active">active</Select.Item>
            <Select.Item value="disabled">disabled</Select.Item>
            <Select.Item value="archived">archived</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
    </div>
  </div>

  <div class="batshit-settings-disclosure-row">
    <div class="batshit-settings-disclosure-trigger cursor-default hover:bg-transparent">
      <div class="flex items-center gap-1.5">
        <span class="batshit-settings-form-label">Safety & Access</span>
      </div>
    </div>
    <div class="batshit-settings-disclosure-content">
      <div class="space-y-5">
        <div class="batshit-settings-form-stack">
          <div class="batshit-settings-toggle-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-parent-label">Allow Network</span>
                <SettingsInfoMenu ariaLabel="About Allow Network">
                  <p>Declare whether this CLI tool expects internet or API access during execution.</p>
                </SettingsInfoMenu>
              </div>
            </div>
            <Switch.Root
              checked={allowNetwork}
              onCheckedChange={(checked) => (allowNetwork = checked === true)}
            />
          </div>

          <div class="batshit-settings-toggle-row">
            <div class="batshit-settings-form-copy">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-parent-label">Allow Write</span>
                <SettingsInfoMenu ariaLabel="About Allow Write">
                  <p>
                    Write-capable tools must also declare allowed paths so Batshit can keep the
                    boundary inspectable.
                  </p>
                </SettingsInfoMenu>
              </div>
            </div>
            <Switch.Root
              checked={allowWrite}
              onCheckedChange={(checked) => (allowWrite = checked === true)}
            />
          </div>
        </div>

        <div class="space-y-1.5">
          <div class="batshit-settings-form-label-line">
            <Label class="batshit-settings-form-label" for={`cli-allowed-paths-${tool.toolId}`}>
              Allowed Paths
            </Label>
            <SettingsInfoMenu ariaLabel="About Allowed Paths" contentClass="w-80">
              <p>
                One path per line. These paths define where a write-capable tool is allowed to
                edit files.
              </p>
            </SettingsInfoMenu>
          </div>
          <Textarea
            id={`cli-allowed-paths-${tool.toolId}`}
            rows={3}
            bind:value={allowedPathsText}
            placeholder="/path/to/workspace&#10;/tmp"
          />
          {#if allowWrite && splitLines(allowedPathsText).length === 0}
            <p class="batshit-settings-caption text-amber-500">
              Add at least one allowed path before write access can save.
            </p>
          {/if}
        </div>

        <div class="space-y-2">
          <div class="flex items-center justify-between">
            <div class="batshit-settings-form-label-line">
              <Label class="batshit-settings-form-label">Saved Key Env Refs</Label>
              <SettingsInfoMenu ariaLabel="About Saved Key Env Refs" contentClass="w-80">
                <p>
                  Map saved API keys into environment variables without storing raw secrets on
                  the CLI tool record.
                </p>
              </SettingsInfoMenu>
            </div>
            <Button type="button" variant="outline" size="sm" onclick={addEnvRef}>
              <Plus class="mr-2 h-3.5 w-3.5" />
              Add Env Ref
            </Button>
          </div>
          {#if envRefs.length === 0}
            <div class="rounded-md border border-dashed p-3 text-xs text-muted-foreground">
              No saved key refs yet.
            </div>
          {:else}
            <div class="space-y-2">
              {#each envRefs as entry (entry.id)}
                <div class="batshit-settings-card-subtle-frame is-compact">
                  <div class="batshit-settings-form-stack">
                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <span class="batshit-settings-form-label">Env Var</span>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Input
                          value={entry.envVar}
                          placeholder="GITHUB_TOKEN"
                          oninput={(event) =>
                            updateEnvRef(entry.id, 'envVar', (event.currentTarget as HTMLInputElement).value)}
                        />
                      </div>
                    </div>

                    <div class="batshit-settings-form-row">
                      <div class="batshit-settings-form-copy">
                        <div class="batshit-settings-form-label-line">
                          <span class="batshit-settings-form-label">Saved Key</span>
                        </div>
                      </div>
                      <div class="batshit-settings-form-control">
                        <Select.Root
                          type="single"
                          value={entry.savedKeyRef}
                          onValueChange={(value) => updateEnvRef(entry.id, 'savedKeyRef', value ?? '')}
                        >
                          <Select.Trigger class="w-full">
                            <span data-slot="select-value">
                              {entry.savedKeyRef ? formatKeyLabel(entry.savedKeyRef) : 'Choose saved key'}
                            </span>
                          </Select.Trigger>
                          <Select.Content>
                            {#each availableKeys as key}
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
                          <Trash2 class="h-4 w-4" />
                        </Button>
                      </div>
                    </div>
                  </div>
                </div>
              {/each}
            </div>
            {#if !envRefsValid}
              <p class="batshit-settings-caption text-amber-500">
                Complete both fields for each env ref before changes can save.
              </p>
            {/if}
          {/if}
        </div>
      </div>
    </div>
  </div>

  <Collapsible.Root bind:open={detailsOpen}>
    <div class="batshit-settings-disclosure-row">
      <Collapsible.Trigger class="batshit-settings-disclosure-trigger">
        <div class="flex items-center gap-1.5">
          <span class="batshit-settings-form-label">Technical Details</span>
        </div>
        <ChevronDown class={`h-4 w-4 transition-transform ${detailsOpen ? 'rotate-180' : ''}`} />
      </Collapsible.Trigger>
      <Collapsible.Content class="batshit-settings-disclosure-content">
        <div class="space-y-5">
          <div class="batshit-settings-form-stack">
            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Command or Script</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <code class="block min-w-0 overflow-x-auto whitespace-nowrap rounded bg-background/80 px-2 py-1 text-[11px]">
                  {tool.executable}
                </code>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Tool ID</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <code class="block min-w-0 overflow-x-auto whitespace-nowrap rounded bg-background/80 px-2 py-1 text-[11px]">
                  {tool.toolId}
                </code>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Origin</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{tool.origin}</span>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Output Type</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{formatOutputMode(tool.outputMode)}</span>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Parse Strategy</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{formatParseMode(tool.parseMode)}</span>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Working Directory</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{formatCwd(tool)}</span>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Timeout</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{tool.timeoutMs} ms</span>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Created</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{formatDate(tool.createdAt)}</span>
              </div>
            </div>

            <div class="batshit-settings-form-row">
              <div class="batshit-settings-form-copy">
                <div class="batshit-settings-form-label-line">
                  <span class="batshit-settings-form-label">Updated</span>
                </div>
              </div>
              <div class="batshit-settings-form-control">
                <span class="batshit-settings-description-preview">{formatDate(tool.updatedAt)}</span>
              </div>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-2">
            <div class="space-y-1.5">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-form-label">Args Template (JSON)</span>
              </div>
              <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 p-3 text-[11px] text-muted-foreground">{formatJson(tool.argsTemplate, '[]')}</pre>
            </div>

            <div class="space-y-1.5">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-form-label">Input Schema (JSON)</span>
              </div>
              <pre class="max-h-80 overflow-auto whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 p-3 text-[11px] text-muted-foreground">{formatJson(tool.inputSchema, '{"type":"object","properties":{}}')}</pre>
            </div>
          </div>

          <div class="grid gap-4 lg:grid-cols-3">
            <div class="space-y-1.5">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-form-label">Help Command Args</span>
              </div>
              <pre class="min-h-24 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 p-3 text-[11px] text-muted-foreground">{formatList(tool.helpCommand)}</pre>
            </div>

            <div class="space-y-1.5">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-form-label">Validation Input (JSON)</span>
              </div>
              <pre class="min-h-24 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 p-3 text-[11px] text-muted-foreground">{formatJson(tool.validationInput)}</pre>
            </div>

            <div class="space-y-1.5">
              <div class="batshit-settings-form-label-line">
                <span class="batshit-settings-form-label">Examples</span>
              </div>
              <pre class="min-h-24 whitespace-pre-wrap break-words rounded-md border border-border/60 bg-background/80 p-3 text-[11px] text-muted-foreground">{formatList(tool.examples)}</pre>
            </div>
          </div>
        </div>
      </Collapsible.Content>
    </div>
  </Collapsible.Root>
</SettingsAccordionCard>

<SettingsTextEditor
  bind:open={descriptionEditorOpen}
  title="CLI Tool Description"
  description="Short agent-facing description Batshit shows when this saved CLI tool is listed."
  value={description}
  placeholder="Capture a quick repo snapshot for the active project."
  saveLabel="Save Description"
  onSave={(value) => {
    description = value
  }}
/>
