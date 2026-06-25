<script lang="ts">
  import type { Component } from 'svelte'
  import { AlertTriangle, Loader2, RefreshCw } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'

  type PanelLoader = () => Promise<{ default: Component<any> }>

  interface Props {
    active?: boolean
    label: string
    loader: PanelLoader
    panelProps?: Record<string, unknown>
  }

  let { active = false, label, loader, panelProps = {} }: Props = $props()

  let Panel = $state<Component<any> | null>(null)
  let loading = $state(false)
  let errorMessage = $state<string | null>(null)
  let loadAttempt = $state(0)

  async function loadPanel() {
    if (Panel || loading) return

    const attempt = loadAttempt + 1
    loadAttempt = attempt
    loading = true
    errorMessage = null

    try {
      const module = await loader()
      if (attempt !== loadAttempt) return
      Panel = module.default
    } catch (error) {
      console.error(`Failed to load ${label} settings panel`, error)
      errorMessage = error instanceof Error ? error.message : 'Unknown loading error'
    } finally {
      if (attempt === loadAttempt) {
        loading = false
      }
    }
  }

  function retryLoad() {
    Panel = null
    errorMessage = null
    void loadPanel()
  }

  $effect(() => {
    if (active && !Panel && !loading && !errorMessage) {
      void loadPanel()
    }
  })
</script>

{#if Panel}
  <Panel {...panelProps} />
{:else if active}
  <div class="flex min-h-[220px] items-center justify-center p-6">
    {#if errorMessage}
      <div class="max-w-md space-y-3 rounded-md border border-destructive/40 bg-destructive/5 p-4 text-sm">
        <div class="flex items-center gap-2 font-medium text-destructive">
          <AlertTriangle class="size-4" aria-hidden="true" />
          <span>Could not load {label} settings.</span>
        </div>
        <p class="text-muted-foreground">{errorMessage}</p>
        <Button type="button" variant="outline" size="sm" onclick={retryLoad}>
          <RefreshCw class="size-4" aria-hidden="true" />
          Retry
        </Button>
      </div>
    {:else}
      <div class="flex items-center gap-2 text-sm text-muted-foreground">
        <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        <span>Loading {label} settings...</span>
      </div>
    {/if}
  </div>
{/if}
