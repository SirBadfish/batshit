<script lang="ts">
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Select from '$lib/components/ui/select'
  import {
  Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Textarea } from '$lib/components/ui/textarea'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import { DEFAULT_MCP_GATEWAY_ICON_REF } from '$lib/icons/iconCatalog'
  import type { IconRef } from '$lib/icons/iconTypes'
  import { Loader2,
  Plus,
  Trash2,
  X
} from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  type EnvRefRow = {
    id: string
    envVar: string
    savedKeyRef: string
  }

  const INFRA_KEYS = new Set([
    'batshit_token', 'n8n_internal_key', 'n8n_api_key', 'n8n_api_url',
    'batshit_artifact_complete_url', 'n8n_instance_mcp_token', 'ai_gateway',
    'browserbase_project_id', 'browserbase_api_url',
    'browseruse_base_url', 'kernel_base_url'
  ])

  interface Props {
    open?: boolean
    onOpenChange?: (open: boolean) => void
    onSuccess?: () => void
    userId?: string
  }

  let { open = false, onOpenChange = () => {}, onSuccess = () => {}, userId }: Props = $props()

  let name = $state('')
  let iconRef = $state<IconRef>(DEFAULT_MCP_GATEWAY_ICON_REF)
  let command = $state('')
  let argsText = $state('')
  let cwdPolicy = $state<'none' | 'project' | 'fixed'>('none')
  let cwdValue = $state('')
  let startupTimeoutMs = $state('10000')
  let toolCallTimeoutMs = $state('60000')
  let envRefs = $state<EnvRefRow[]>([])
  let availableKeys = $state<string[]>([])
  let loadingKeys = $state(false)
  let submitting = $state(false)

  function createEnvRefRow(): EnvRefRow {
    return {
      id: crypto.randomUUID(),
      envVar: '',
      savedKeyRef: ''
    }
  }

  function parseArgs(text: string): string[] {
    return text
      .split('\n')
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0)
  }

  function normalizedEnvRefs() {
    return envRefs
      .map((entry) => ({
        envVar: entry.envVar.trim(),
        savedKeyRef: entry.savedKeyRef.trim()
      }))
      .filter((entry) => entry.envVar.length > 0 || entry.savedKeyRef.length > 0)
  }

  async function loadApiKeys() {
    loadingKeys = true
    try {
      const response = await fetch('/api/settings/api-keys')
      if (!response.ok) return
      const data = await response.json()
      if (data.success && data.keys) {
        availableKeys = Object.entries(data.keys)
          .filter(([key, info]: [string, any]) => info.status === 'ready' && !INFRA_KEYS.has(key))
          .map(([key]) => key)
          .sort()
      }
    } catch (error) {
      console.error('[StdioGatewayForm] Error loading API keys:', error)
    } finally {
      loadingKeys = false
    }
  }

  $effect(() => {
    if (!open) return
    name = ''
    iconRef = DEFAULT_MCP_GATEWAY_ICON_REF
    command = 'node'
    argsText = ''
    cwdPolicy = 'none'
    cwdValue = ''
    startupTimeoutMs = '10000'
    toolCallTimeoutMs = '60000'
    envRefs = []
    loadApiKeys()
  })

  let isValid = $derived.by(() => {
    if (!name.trim()) return false
    if (!command.trim()) return false
    if (cwdPolicy === 'fixed' && !cwdValue.trim()) return false
    for (const entry of normalizedEnvRefs()) {
      if (!entry.envVar || !entry.savedKeyRef) return false
    }
    return true
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

  async function handleSubmit() {
    if (!isValid || !userId) {
      toast.error('Please complete the required STDIO fields')
      return
    }

    submitting = true
    try {
      const response = await fetch('/api/mcp/gateways', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          userId,
          name: name.trim(),
          type: 'stdio',
          icon_ref: iconRef,
          enabled: true,
          stdioConfig: {
            command: command.trim(),
            args: parseArgs(argsText),
            cwdPolicy,
            ...(cwdPolicy === 'fixed' && cwdValue.trim() ? { cwdValue: cwdValue.trim() } : {}),
            envRefs: normalizedEnvRefs(),
            startupTimeoutMs: Number(startupTimeoutMs) || 10000,
            toolCallTimeoutMs: Number(toolCallTimeoutMs) || 60000,
            lastTestStatus: 'never'
          }
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create STDIO MCP gateway')
      }

      toast.success('STDIO MCP server added successfully')
      onOpenChange(false)
      onSuccess()
    } catch (error) {
      console.error('[StdioGatewayForm] Error creating STDIO gateway:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to add STDIO MCP server')
    } finally {
      submitting = false
    }
  }

  function handleCancel() {
    onOpenChange(false)
  }

  function formatKeyLabel(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, (char) => char.toUpperCase())
  }
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
  <Dialog.Content class="batshit-settings-dialog sm:max-w-[720px] max-h-[90vh] overflow-y-auto">
    <Dialog.Header>
      <Dialog.Title>Add STDIO MCP Server</Dialog.Title>
      <Dialog.Description>
        Connect to a local MCP server launched with a command plus argv-style arguments.
      </Dialog.Description>
    </Dialog.Header>

    <form onsubmit={(event) => { event.preventDefault(); handleSubmit(); }} class="space-y-4 py-4">
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
        <div class="space-y-2">
          <Label for="stdio-name">
            Server Name <span class="batshit-settings-required-marker">*</span>
          </Label>
          <Input id="stdio-name" bind:value={name} disabled={submitting} placeholder="Context7 (local)" />
        </div>
        <div class="space-y-2">
          <Label>Icon</Label>
          <IconPicker bind:value={iconRef} disabled={submitting} triggerLabel="Choose Icon" onlineSearchHint={name} />
        </div>
      </div>

      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-2">
          <Label for="stdio-command">
            Command <span class="batshit-settings-required-marker">*</span>
          </Label>
          <Input id="stdio-command" bind:value={command} disabled={submitting} placeholder="npx" />
          <p class="batshit-settings-form-help">
            Use the executable only. Batshit stores arguments separately, not as one shell string.
          </p>
        </div>

        <div class="space-y-2">
          <Label>Working Directory</Label>
          <Select.Root
            type="single"
            value={cwdPolicy}
            onValueChange={(value) => (cwdPolicy = (value as typeof cwdPolicy) ?? 'none')}
          >
            <Select.Trigger class="w-full">
              <span data-slot="select-value" class="batshit-settings-form-label">
                {cwdPolicy === 'project' ? 'Project directory' : cwdPolicy === 'fixed' ? 'Fixed directory' : 'No custom cwd'}
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

      <div class="space-y-2">
        <Label for="stdio-args">Arguments</Label>
        <Textarea
          id="stdio-args"
          rows={4}
          bind:value={argsText}
          disabled={submitting}
          placeholder="-y&#10;@upstash/context7-mcp"
        />
        <p class="batshit-settings-form-help">
          Enter one argument per line. Batshit will send them as an argv array.
        </p>
      </div>

      {#if cwdPolicy === 'fixed'}
        <div class="space-y-2">
          <Label for="stdio-cwd">
            Fixed Directory <span class="batshit-settings-required-marker">*</span>
          </Label>
          <Input
            id="stdio-cwd"
            bind:value={cwdValue}
            disabled={submitting}
            placeholder="/path/to/my-mcp"
          />
        </div>
      {/if}

      <div class="grid gap-4 md:grid-cols-2">
        <div class="space-y-2">
          <Label for="stdio-startup-timeout">Startup Timeout (ms)</Label>
          <Input
            id="stdio-startup-timeout"
            type="number"
            min="1000"
            step="1000"
            bind:value={startupTimeoutMs}
            disabled={submitting}
          />
        </div>

        <div class="space-y-2">
          <Label for="stdio-tool-timeout">Tool Call Timeout (ms)</Label>
          <Input
            id="stdio-tool-timeout"
            type="number"
            min="1000"
            step="1000"
            bind:value={toolCallTimeoutMs}
            disabled={submitting}
          />
        </div>
      </div>

      <div class="space-y-3 rounded-lg border p-4">
        <div class="flex items-center justify-between gap-3">
          <div>
            <p class="batshit-settings-form-label">Environment References</p>
            <p class="batshit-settings-caption">
              Map saved API keys into env vars without storing raw secrets in the gateway record.
            </p>
          </div>
          <Button type="button" variant="outline" size="sm" onclick={addEnvRef}>
            <Plus  />
            Add Env Ref
          </Button>
        </div>

        {#if loadingKeys}
          <div class="batshit-settings-caption flex items-center gap-2">
            <Loader2 class="h-3 w-3 animate-spin" />
            Loading saved keys...
          </div>
        {:else if envRefs.length === 0}
          <p class="batshit-settings-note is-dashed">No env refs yet.</p>
        {:else}
          <div class="space-y-3">
            {#each envRefs as entry (entry.id)}
              <div class="batshit-settings-card-subtle-frame is-compact grid gap-3 md:grid-cols-[1fr_1fr_auto]">
                <div class="space-y-2">
                  <Label for={`env-var-${entry.id}`}>Env Var</Label>
                  <Input
                    id={`env-var-${entry.id}`}
                    value={entry.envVar}
                    oninput={(event) =>
                      updateEnvRef(entry.id, 'envVar', (event.currentTarget as HTMLInputElement).value)}
                    placeholder="GITHUB_TOKEN"
                    disabled={submitting}
                  />
                </div>

                <div class="space-y-2">
                  <Label>Saved Key</Label>
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
                      {#each availableKeys as key}
                        <Select.Item value={key}>{formatKeyLabel(key)}</Select.Item>
                      {/each}
                    </Select.Content>
                  </Select.Root>
                </div>

                <div class="flex items-end">
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon"
                    onclick={() => removeEnvRef(entry.id)}
                    disabled={submitting}
                  >
                    <Trash2  />
                  </Button>
                </div>
              </div>
            {/each}
          </div>
        {/if}
      </div>

      <div class="batshit-settings-note">
        <p class="batshit-settings-form-label">Setup Notes</p>
        <ol class="list-decimal list-inside space-y-1">
          <li>Use a real executable plus explicit argv lines.</li>
          <li>STDIO MCPs stay in the MCP lane, not the new CLI-tool lane.</li>
          <li>Use the Test button after saving to verify startup and tool discovery.</li>
        </ol>
      </div>

      <Dialog.Footer>
        <Button type="button" variant="outline" onclick={handleCancel} disabled={submitting}>
          <X aria-hidden="true" />
          Cancel
        </Button>
        <Button type="submit" disabled={!isValid || submitting}>
          {#if submitting}
            <Loader2 class="animate-spin" />
            Adding...
          {:else}
            Add STDIO MCP
          {/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
