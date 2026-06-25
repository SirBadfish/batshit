<script lang="ts">
  import { onMount } from 'svelte'
  import { dmrModels, type DmrModel } from '$lib/services/dmrModels'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Label } from '$lib/components/ui/label'
  import { Trash2, Download, RefreshCw, AlertCircle } from '@lucide/svelte'
  import { toast } from '$lib/components/ui/sonner/settings-toast'
  import { confirmDialog } from '$lib/stores/confirmDialog'

  let {
    baseUrl = 'http://localhost:12434',
    openaiPath = '/engines/llama.cpp/v1'
  }: { baseUrl?: string; openaiPath?: string } = $props()

  let models = $state<DmrModel[]>([])
  let isLoading = $state(true)
  let isRunning = $state(false)
  let newModelName = $state('')
  let isCreating = $state(false)

  onMount(() => {
    checkRunnerAndLoadModels()
  })

  async function checkRunnerAndLoadModels() {
    isLoading = true
    isRunning = await dmrModels.isRunnerAvailable(baseUrl)

    if (isRunning) {
      await loadModels()
    }
    isLoading = false
  }

  async function loadModels() {
    try {
      models = await dmrModels.getInstalledModels(baseUrl, openaiPath)
    } catch (error) {
      toast.error('Failed to load Docker Model Runner models')
    }
  }

  async function createModel() {
    if (!newModelName.trim()) {
      toast.error('Please enter a model name')
      return
    }

    isCreating = true

    try {
      const success = await dmrModels.createModel(newModelName.trim(), baseUrl)
      if (success) {
        toast.success(`Created ${newModelName}`)
        newModelName = ''
        await loadModels()
      } else {
        toast.error(`Failed to create ${newModelName}`)
      }
    } catch (error) {
      toast.error('Error creating model')
    } finally {
      isCreating = false
    }
  }

  async function deleteModel(modelName: string) {
    const confirmed = await confirmDialog({
      title: `Delete ${modelName}?`,
      description: 'This removes the Docker Model Runner model from this machine.',
      confirmLabel: 'Delete Model',
      tone: 'destructive'
    })
    if (!confirmed) return

    const success = await dmrModels.deleteModel(modelName, baseUrl)
    if (success) {
      toast.success(`Deleted ${modelName}`)
      await loadModels()
    } else {
      toast.error(`Failed to delete ${modelName}`)
    }
  }

  function formatSize(bytes?: number): string {
    if (!bytes) return 'Unknown size'
    const gb = bytes / (1024 * 1024 * 1024)
    if (gb >= 1) return `${gb.toFixed(1)} GB`
    const mb = bytes / (1024 * 1024)
    return `${mb.toFixed(0)} MB`
  }
</script>

<div class="batshit-settings-card-content-spacious space-y-4">
  <div class="flex items-center justify-between">
    <Button
      variant="outline"
      size="icon"
      onclick={checkRunnerAndLoadModels}
      disabled={isLoading}
    >
      <RefreshCw class={`${isLoading ? 'animate-spin' : ''}`} />
    </Button>
  </div>

  {#if !isRunning}
    <div class="batshit-settings-inline-alert is-warning flex items-center gap-2">
      <AlertCircle class="h-4 w-4" />
      <span class="batshit-settings-form-label">
        Docker Model Runner is not responding. Start it in Docker Desktop and try again.
      </span>
    </div>
  {:else}
    <div class="space-y-2">
      <Label>Pull Model</Label>
      <div class="flex gap-2">
        <Input
          type="text"
          placeholder="e.g., ai/smollm2, ai/llama3.2"
          bind:value={newModelName}
          disabled={isCreating}
        />
        <Button
          onclick={createModel}
          disabled={isCreating || !newModelName.trim()}
        >
          <Download  />
          Pull
        </Button>
      </div>
    </div>

    <div class="space-y-2">
      <Label>Installed Models ({models.length})</Label>
      {#if models.length === 0}
        <p class="batshit-settings-caption">No models installed</p>
      {:else}
        <div class="space-y-2">
          {#each models as model}
            <div class="batshit-settings-model-row flex items-center justify-between">
              <div>
                <div class="batshit-settings-form-label batshit-model-id">{model.name}</div>
                <div class="batshit-settings-form-label">
                  {formatSize(model.size)}
                </div>
              </div>
              <Button
                variant="ghost"
                size="icon"
                onclick={() => deleteModel(model.name)}
              >
                <Trash2  />
              </Button>
            </div>
          {/each}
        </div>
      {/if}
    </div>
  {/if}
</div>
