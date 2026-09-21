<script lang="ts">
  /**
   * SA-124 P8: manage models on KoboldCpp, LM Studio and oMLX.
   *
   * Unlike OllamaModelManager and DmrModelManager, this talks to Batshit's own
   * server route rather than to the program directly (DL-124-12): a local
   * program may carry an encrypted API key the browser must never see, and
   * Docker loopback rewriting lives server-side.
   */
  import { onMount } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import { RefreshCw, AlertCircle, Play, Square } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'

  type ManagedModel = {
    id: string
    label: string
    loaded: boolean
    sizeBytes?: number | null
    contextLength?: number | null
    format?: string | null
    path?: string | null
  }
  type ManagementState = {
    programId: string
    label: string
    manageable: boolean
    reason?: string
    canLoad: boolean
    canUnload: boolean
    canDownload: boolean
    restartsOnSwitch: boolean
    models: ManagedModel[]
  }

  let { programId, enabled = true }: { programId: string; enabled?: boolean } = $props()

  let management = $state<ManagementState | null>(null)
  let isLoading = $state(true)
  let busyModelId = $state<string | null>(null)

  onMount(() => {
    void refresh()
  })

  async function refresh() {
    isLoading = true
    try {
      const response = await fetch(
        `/api/settings/local-ai/models?program=${encodeURIComponent(programId)}`
      )
      const payload = await response.json()
      management = payload?.success ? payload.state : null
      if (!payload?.success) toast.error(payload?.error ?? 'Could not read models')
    } catch {
      management = null
      toast.error('Could not read models')
    } finally {
      isLoading = false
    }
  }

  async function act(action: 'load' | 'unload', model: ManagedModel) {
    busyModelId = model.id
    try {
      const response = await fetch('/api/settings/local-ai/models', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ program: programId, action, modelId: model.id })
      })
      const payload = await response.json()
      if (payload?.success) {
        toast.success(payload.message ?? 'Done')
        // KoboldCpp restarts itself to switch models and is briefly gone.
        // Measured at about 4 seconds, so wait before asking it anything.
        if (payload.restarted) await new Promise((resolve) => setTimeout(resolve, 6000))
        await refresh()
      } else {
        toast.error(payload?.message ?? payload?.error ?? 'That did not work')
      }
    } catch {
      toast.error('That did not work')
    } finally {
      busyModelId = null
    }
  }

  function formatSize(bytes?: number | null) {
    if (typeof bytes !== 'number' || bytes <= 0) return null
    const gb = bytes / 1024 ** 3
    return gb >= 1 ? `${gb.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
  }
</script>

<div class="batshit-settings-card-content-spacious space-y-4">
  <div class="flex items-center justify-between">
    <span class="batshit-settings-form-label">
      {management?.models.length ? `${management.models.length} available` : ''}
    </span>
    <Button variant="outline" size="icon" onclick={refresh} disabled={isLoading || !enabled}>
      <RefreshCw class={isLoading ? 'animate-spin' : ''} />
    </Button>
  </div>

  {#if !enabled}
    <div class="batshit-settings-inline-alert is-warning flex items-center gap-2">
      <AlertCircle class="h-4 w-4" />
      <span class="batshit-settings-form-label">
        Turn this program on above to manage its models.
      </span>
    </div>
  {:else if isLoading && !management}
    <p class="batshit-settings-caption">Checking.</p>
  {:else if management && !management.manageable}
    <div class="batshit-settings-inline-alert is-warning flex items-start gap-2">
      <AlertCircle class="h-4 w-4 shrink-0" />
      <span class="batshit-settings-form-label">{management.reason}</span>
    </div>
  {:else if management}
    {#if management.restartsOnSwitch}
      <p class="batshit-settings-caption">
        Switching models restarts {management.label}, so it goes quiet for a few seconds.
      </p>
    {/if}

    {#if management.models.length === 0}
      <p class="batshit-settings-caption">{management.reason ?? 'No models found.'}</p>
    {:else}
      <div class="space-y-2">
        {#each management.models as model (model.id)}
          <div class="batshit-settings-model-row flex items-center justify-between gap-3">
            <div class="min-w-0">
              <div class="batshit-settings-form-label batshit-model-id truncate">{model.label}</div>
              <div class="flex items-center gap-2">
                {#if model.loaded}
                  <span class="batshit-settings-status-badge is-success">Loaded</span>
                {/if}
                {#if formatSize(model.sizeBytes)}
                  <span class="batshit-settings-form-label">{formatSize(model.sizeBytes)}</span>
                {/if}
                {#if model.format}
                  <span class="batshit-settings-status-badge">{model.format}</span>
                {/if}
                {#if model.contextLength}
                  <span class="batshit-settings-form-label">
                    {model.contextLength.toLocaleString()} tokens
                  </span>
                {/if}
              </div>
            </div>
            <div class="flex items-center gap-1">
              {#if model.loaded && management.canUnload}
                <Button
                  variant="ghost"
                  size="icon"
                  title="Unload"
                  disabled={busyModelId !== null}
                  onclick={() => act('unload', model)}
                >
                  <Square />
                </Button>
              {:else if management.canLoad}
                <Button
                  variant="outline"
                  size="sm"
                  disabled={busyModelId !== null}
                  onclick={() => act('load', model)}
                >
                  <Play />
                  {busyModelId === model.id ? 'Working' : 'Load'}
                </Button>
              {/if}
            </div>
          </div>
        {/each}
      </div>
    {/if}
  {/if}
</div>
