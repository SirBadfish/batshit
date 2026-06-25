<script lang="ts">
  /**
   * Custom MCP Gateway Form (Svelte 5)
   * Allows users to add generic streamable MCP gateways.
   */
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Select from '$lib/components/ui/select'
  import {
  Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import IconPicker from '$lib/components/icons/IconPicker.svelte'
  import { DEFAULT_MCP_GATEWAY_ICON_REF } from '$lib/icons/iconCatalog'
  import type { IconRef } from '$lib/icons/iconTypes'
  import { Loader2,
  X
} from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

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
  const title = 'Add Custom Gateway'
  const description = 'Connect to any HTTP streamable MCP server.'

  let name = $state('')
  let url = $state('')
  let iconRef = $state<IconRef>(DEFAULT_MCP_GATEWAY_ICON_REF)
  let authKeyName = $state('')
  let availableKeys = $state<string[]>([])
  let loadingKeys = $state(false)
  let submitting = $state(false)

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
      console.error('[CustomGatewayForm] Error loading API keys:', error)
    } finally {
      loadingKeys = false
    }
  }

  $effect(() => {
    if (!open) return
    name = ''
    url = 'https://'
    iconRef = DEFAULT_MCP_GATEWAY_ICON_REF
    authKeyName = ''
    loadApiKeys()
  })

  let isValid = $derived.by(() => {
    if (!name.trim()) return false
    if (!url.trim()) return false
    try {
      new URL(url)
      return true
    } catch {
      return false
    }
  })

  async function handleSubmit() {
    if (!isValid || !userId) {
      toast.error('Please fill in all required fields')
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
          type: 'custom',
          icon_ref: iconRef,
          url: url.trim(),
          enabled: true,
          ...(authKeyName ? { authKeyName } : {})
        })
      })

      if (!response.ok) {
        const error = await response.json()
        throw new Error(error.error || 'Failed to create gateway')
      }

      toast.success('Gateway added successfully')
      onOpenChange(false)
      onSuccess()
    } catch (error) {
      console.error('[CustomGatewayForm] Error creating gateway:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to add gateway')
    } finally {
      submitting = false
    }
  }

  function handleCancel() {
    onOpenChange(false)
  }

  function formatKeyLabel(key: string): string {
    return key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
  }
</script>

<Dialog.Root {open} onOpenChange={onOpenChange}>
  <Dialog.Content class="batshit-settings-dialog sm:max-w-[560px]">
    <Dialog.Header>
      <Dialog.Title>{title}</Dialog.Title>
      <Dialog.Description>{description}</Dialog.Description>
    </Dialog.Header>

    <form onsubmit={(e) => { e.preventDefault(); handleSubmit(); }} class="space-y-4 py-4">
      <div class="grid gap-4 md:grid-cols-[minmax(0,1fr)_180px]">
        <div class="space-y-2">
          <Label for="gateway-name">
            Gateway Name <span class="batshit-settings-required-marker">*</span>
          </Label>
          <Input
            id="gateway-name"
            type="text"
            placeholder="HuggingFace MCP"
            bind:value={name}
            disabled={submitting}
            required
          />
          <p class="batshit-settings-form-help">
            A descriptive name for this gateway.
          </p>
        </div>
        <div class="space-y-2">
          <Label>Icon</Label>
          <IconPicker bind:value={iconRef} disabled={submitting} triggerLabel="Choose Icon" onlineSearchHint={name} />
        </div>
      </div>

      <div class="space-y-2">
        <Label for="gateway-url">
          MCP Endpoint URL <span class="batshit-settings-required-marker">*</span>
        </Label>
        <Input
          id="gateway-url"
          type="text"
          placeholder="https://huggingface.co/mcp"
          bind:value={url}
          disabled={submitting}
          required
        />
        <p class="batshit-settings-form-help">
          Paste the streamable MCP endpoint URL from your gateway.
        </p>
      </div>

      <div class="space-y-2">
        <Label>Auth Key (Optional)</Label>
        {#if loadingKeys}
          <div class="flex items-center gap-2 text-xs text-muted-foreground py-1">
            <Loader2 class="h-3 w-3 animate-spin" />
            Loading keys...
          </div>
        {:else if availableKeys.length === 0}
          <p class="batshit-settings-note is-dashed">
            No API keys configured. Add keys in Settings &rarr; API Keys first.
          </p>
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
              {#each availableKeys as key}
                <Select.Item value={key}>{formatKeyLabel(key)}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          <p class="batshit-settings-form-help">
            Sends the selected key as a Bearer token for authentication.
          </p>
        {/if}
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
            Add Gateway
          {/if}
        </Button>
      </Dialog.Footer>
    </form>
  </Dialog.Content>
</Dialog.Root>
