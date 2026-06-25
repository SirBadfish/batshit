<script lang="ts">
  import { onMount } from 'svelte';
  import { ollamaModels, type OllamaModel } from '$lib/services/ollamaModels';
  import { Button } from '$lib/components/ui/button';
  import { Input } from '$lib/components/ui/input';
  import { Label } from '$lib/components/ui/label';
  import { Progress } from '$lib/components/ui/progress';
  import { Trash2, Download, RefreshCw, AlertCircle } from '@lucide/svelte';
  import { toast } from '$lib/components/ui/sonner/settings-toast';
  import { confirmDialog } from '$lib/stores/confirmDialog';

  let { baseUrl = 'http://localhost:11434' }: { baseUrl?: string } = $props();

  let models = $state<OllamaModel[]>([]);
  let isLoading = $state(true);
  let isOllamaRunning = $state(false);
  let newModelName = $state('');
  let isPulling = $state(false);
  let pullProgress = $state(0);
  let pullStatus = $state('');

  onMount(() => {
    checkOllamaAndLoadModels();
  });

  async function checkOllamaAndLoadModels() {
    isLoading = true;
    isOllamaRunning = await ollamaModels.isOllamaRunning(baseUrl);

    if (isOllamaRunning) {
      await loadModels();
    }
    isLoading = false;
  }

  async function loadModels() {
    try {
      models = await ollamaModels.getInstalledModels(baseUrl);
    } catch (error) {
      toast.error('Failed to load Ollama models');
    }
  }

  async function pullModel() {
    if (!newModelName.trim()) {
      toast.error('Please enter a model name');
      return;
    }

    isPulling = true;
    pullProgress = 0;
    pullStatus = 'Starting download...';

    try {
      const success = await ollamaModels.pullModel(
        newModelName.trim(),
        (progress) => {
          pullStatus = progress.status;
          if (progress.percent !== undefined) {
            pullProgress = progress.percent;
          }
        },
        baseUrl
      );

      if (success) {
        toast.success(`Successfully pulled ${newModelName}`);
        newModelName = '';
        await loadModels();
      } else {
        toast.error(`Failed to pull ${newModelName}`);
      }
    } catch (error) {
      toast.error('Error pulling model');
    } finally {
      isPulling = false;
      pullProgress = 0;
      pullStatus = '';
    }
  }

  async function deleteModel(modelName: string) {
    const confirmed = await confirmDialog({
      title: `Delete ${modelName}?`,
      description: 'This removes the local Ollama model from this machine.',
      confirmLabel: 'Delete Model',
      tone: 'destructive'
    });
    if (!confirmed) return;

    const success = await ollamaModels.deleteModel(modelName, baseUrl);
    if (success) {
      toast.success(`Deleted ${modelName}`);
      await loadModels();
    } else {
      toast.error(`Failed to delete ${modelName}`);
    }
  }

  function formatSize(bytes: number): string {
    const gb = bytes / (1024 * 1024 * 1024);
    return `${gb.toFixed(1)} GB`;
  }
</script>

<div class="batshit-settings-card-content-spacious space-y-4">
  <div class="flex items-center justify-between">
    <Button
      variant="outline"
      size="icon"
      onclick={checkOllamaAndLoadModels}
      disabled={isLoading}
    >
      <RefreshCw class={`${isLoading ? 'animate-spin' : ''}`} />
    </Button>
  </div>
    {#if !isOllamaRunning}
      <div class="batshit-settings-inline-alert is-warning flex items-center gap-2">
        <AlertCircle class="h-4 w-4" />
        <span class="batshit-settings-form-label">Ollama is not running. Please start Ollama to manage models.</span>
      </div>
    {:else}
      <!-- Pull new model -->
      <div class="space-y-2">
        <Label>Pull New Model</Label>
        <div class="flex gap-2">
          <Input
            type="text"
            placeholder="e.g., llama3:70b, mistral:latest"
            bind:value={newModelName}
            disabled={isPulling}
          />
          <Button
            onclick={pullModel}
            disabled={isPulling || !newModelName.trim()}
          >
            <Download  />
            Pull
          </Button>
        </div>
      </div>

      {#if isPulling}
        <div class="space-y-2">
          <div class="batshit-settings-form-label">{pullStatus}</div>
          <Progress value={pullProgress} max={100} />
        </div>
      {/if}

      <!-- Installed models -->
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
