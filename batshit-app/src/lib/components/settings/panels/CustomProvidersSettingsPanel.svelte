<script lang="ts">
  import { onMount } from 'svelte'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import { Button } from '$lib/components/ui/button'
  import { Badge } from '$lib/components/ui/badge'
  import * as Card from '$lib/components/ui/card'
  import { Loader2, Save, Trash2, Plus, Pencil } from '@lucide/svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmDialog } from '$lib/stores/confirmDialog'
  import type { CustomProviderSummary } from '$lib/types/customProviders'
  import { dispatchModelConnectionsUpdated } from '$lib/utils/liveSettingsEvents'

  type ProviderFormState = {
    id: string | null
    label: string
    baseUrl: string
    apiKey: string
    headersJson: string
  }

  let { embedded = false }: { embedded?: boolean } = $props()

  let providers = $state<CustomProviderSummary[]>([])
  let isLoading = $state(true)
  let loadError = $state<string | null>(null)
  let saving = $state(false)
  let deletingId = $state<string | null>(null)
  let formError = $state<string | null>(null)
  let formOpen = $state(false)

  let form = $state<ProviderFormState>({
    id: null,
    label: '',
    baseUrl: '',
    apiKey: '',
    headersJson: ''
  })

  onMount(() => {
    loadProviders()
  })

  function formatUpdatedAt(value: string) {
    if (!value) return '...'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '...'
    return `Updated ${date.toLocaleString()}`
  }

  function resetForm() {
    form = { id: null, label: '', baseUrl: '', apiKey: '', headersJson: '' }
    formError = null
  }

  function startNewProvider() {
    resetForm()
    formOpen = true
  }

  function closeForm() {
    resetForm()
    formOpen = false
  }

  function editProvider(provider: CustomProviderSummary) {
    form = {
      id: provider.id,
      label: provider.label,
      baseUrl: provider.baseUrl,
      apiKey: '',
      headersJson: provider.headers ? JSON.stringify(provider.headers, null, 2) : ''
    }
    formError = null
    formOpen = true
  }

  function parseHeaders(headersJson: string): Record<string, string> | null {
    const trimmed = headersJson.trim()
    if (!trimmed.length) return null

    try {
      const parsed = JSON.parse(trimmed)
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        formError = 'Headers must be a JSON object.'
        return null
      }
      const headers: Record<string, string> = {}
      for (const [key, value] of Object.entries(parsed)) {
        if (!key.trim() || value === null || value === undefined) continue
        headers[key.trim()] = String(value).trim()
      }
      formError = null
      return headers
    } catch (error) {
      formError = 'Headers JSON is invalid.'
      return null
    }
  }

  async function loadProviders() {
    isLoading = true
    loadError = null
    try {
      const response = await fetch('/api/settings/custom-providers')
      if (!response.ok) {
        throw new Error('Failed to load custom providers')
      }
      const payload = await response.json()
      providers = payload?.providers ?? []
    } catch (error) {
      console.error('Failed to load custom providers:', error)
      loadError = error instanceof Error ? error.message : 'Failed to load custom providers'
    } finally {
      isLoading = false
    }
  }

  async function saveProvider() {
    formError = null
    const label = form.label.trim()
    const baseUrl = form.baseUrl.trim()
    const apiKey = form.apiKey.trim()

    if (!label || !baseUrl) {
      formError = 'Name and base URL are required.'
      return
    }
    if (!form.id && !apiKey) {
      formError = 'API key is required for new providers.'
      return
    }

    const headers = parseHeaders(form.headersJson)
    if (form.headersJson.trim().length && !headers) {
      return
    }

    saving = true
    try {
      const response = await fetch('/api/settings/custom-providers', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: form.id,
          label,
          baseUrl,
          apiKey: apiKey.length ? apiKey : null,
          headers
        })
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        const message = payload?.error || 'Failed to save custom provider'
        throw new Error(message)
      }

      const payload = await response.json()
      const saved = payload?.provider as CustomProviderSummary
      if (saved) {
        const exists = providers.find((provider) => provider.id === saved.id)
        providers = exists
          ? providers.map((provider) => (provider.id === saved.id ? saved : provider))
          : [...providers, saved]
        dispatchModelConnectionsUpdated('custom-providers')
        toast.success(form.id ? 'Custom provider updated' : 'Custom provider added')
        resetForm()
        formOpen = false
      }
    } catch (error) {
      console.error('Failed to save custom provider:', error)
      formError = error instanceof Error ? error.message : 'Failed to save custom provider'
      toast.error(formError)
    } finally {
      saving = false
    }
  }

  async function deleteProvider(providerId: string) {
    const confirmed = await confirmDialog({
      title: 'Delete this custom provider?',
      description: 'This permanently removes the custom provider configuration.',
      confirmLabel: 'Delete Provider',
      tone: 'destructive'
    })
    if (!confirmed) return

    deletingId = providerId
    try {
      const response = await fetch('/api/settings/custom-providers', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ id: providerId })
      })

      if (!response.ok) {
        const payload = await response.json().catch(() => null)
        const message = payload?.error || 'Failed to delete custom provider'
        throw new Error(message)
      }

      providers = providers.filter((provider) => provider.id !== providerId)
      if (form.id === providerId) {
        closeForm()
      }
      dispatchModelConnectionsUpdated('custom-providers')
      toast.success('Custom provider removed')
    } catch (error) {
      console.error('Failed to delete custom provider:', error)
      toast.error(error instanceof Error ? error.message : 'Failed to delete custom provider')
    } finally {
      deletingId = null
    }
  }
</script>

<div class="space-y-4">
  <div class={`flex flex-wrap items-center gap-3 ${embedded ? 'justify-end' : 'justify-between'}`}>
    {#if !embedded}
      <div class="flex items-center gap-1.5">
        <h2 class="batshit-settings-section-title">Custom Providers</h2>
        <SettingsInfoMenu ariaLabel="About Custom Providers" contentClass="w-80">
          <p>
            Add OpenAI-compatible providers for API agents. Models must be entered manually.
            Leave API key blank to keep the existing key when editing.
          </p>
        </SettingsInfoMenu>
      </div>
    {/if}
    <Button size="sm" onclick={startNewProvider} disabled={saving}>
      <Plus  /> New
    </Button>
  </div>

  {#if loadError}
    <div class="batshit-settings-inline-alert is-danger">
      {loadError}
    </div>
  {/if}

  {#if formOpen}
    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <label class="batshit-settings-form-label" for="custom-provider-name">Name</label>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Input
            id="custom-provider-name"
            value={form.label}
            placeholder="Z.ai"
            oninput={(event) => (form = { ...form, label: (event.target as HTMLInputElement).value })}
          />
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <label class="batshit-settings-form-label" for="custom-provider-base-url">Base URL</label>
          </div>
        </div>
        <div class="batshit-settings-form-control is-wide">
          <Input
            id="custom-provider-base-url"
            value={form.baseUrl}
            placeholder="https://api.example.com/v1"
            oninput={(event) => (form = { ...form, baseUrl: (event.target as HTMLInputElement).value })}
          />
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <label class="batshit-settings-form-label" for="custom-provider-api-key">API Key</label>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Input
            id="custom-provider-api-key"
            type="password"
            value={form.apiKey}
            placeholder={form.id ? 'Leave blank to keep existing' : 'Paste API key…'}
            oninput={(event) => (form = { ...form, apiKey: (event.target as HTMLInputElement).value })}
          />
        </div>
      </div>

      <div class="batshit-settings-form-row is-tall">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <label class="batshit-settings-form-label" for="custom-provider-headers">Extra Headers</label>
            <SettingsInfoMenu ariaLabel="About Extra Headers">
              <p>Optional JSON headers to send with requests to this provider.</p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Textarea
            id="custom-provider-headers"
            rows={3}
            value={form.headersJson}
            placeholder={'{"X-Custom-Header": "value"}'}
            oninput={(event) => (form = { ...form, headersJson: (event.target as HTMLTextAreaElement).value })}
          />
        </div>
      </div>

      {#if formError}
        <p class="batshit-settings-form-help is-danger">{formError}</p>
      {/if}

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <span class="batshit-settings-form-label">
              {form.id ? 'Update Provider' : 'Save Provider'}
            </span>
          </div>
        </div>
        <div class="batshit-settings-form-control is-inline-status">
          <Button size="sm" onclick={saveProvider} disabled={saving}>
            {#if saving}
              <Loader2 class="animate-spin" />
            {:else}
              <Save  />
            {/if}
            {form.id ? 'Update provider' : 'Save provider'}
          </Button>
          <Button size="sm" variant="ghost" onclick={closeForm} disabled={saving}>
            <Pencil aria-hidden="true" />
            {form.id ? 'Cancel edit' : 'Cancel'}
          </Button>
        </div>
      </div>
    </div>
  {/if}

  {#if isLoading}
    <div class="flex items-center gap-2 text-sm text-muted-foreground">
      <Loader2 class="h-4 w-4 animate-spin" />
      Loading custom providers…
    </div>
  {:else}
    {#if providers.length}
      <div class="space-y-3">
        {#each providers as provider (provider.id)}
          <Card.Root class="batshit-settings-card batshit-settings-card-default">
            <Card.Content class="custom-provider-card-content flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
              <div class="space-y-1">
                <div class="flex items-center gap-2">
                  <p class="batshit-settings-form-label">{provider.label}</p>
                  <Badge variant="secondary">Ready</Badge>
                </div>
                <p class="batshit-settings-form-label">{provider.baseUrl}</p>
                <p class="batshit-settings-form-label">Stored key: {provider.maskedKey || '****'}</p>
                <p class="batshit-settings-form-label">{formatUpdatedAt(provider.updatedAt)}</p>
              </div>
              <div class="flex flex-wrap items-center gap-2">
                <Button size="sm" variant="secondary" onclick={() => editProvider(provider)}>
                  <Pencil  /> Edit
                </Button>
                <Button
                  size="sm"
                  variant="ghost"

                  onclick={() => deleteProvider(provider.id)}
                  disabled={deletingId === provider.id}
                >
                  {#if deletingId === provider.id}
                    <Loader2 class="animate-spin" />
                  {:else}
                    <Trash2  />
                  {/if}
                  Delete
                </Button>
              </div>
            </Card.Content>
          </Card.Root>
        {/each}
      </div>
    {/if}
  {/if}
</div>

<style>
  :global(.custom-provider-card-content) {
    padding: 0.95rem 1rem;
  }
</style>
