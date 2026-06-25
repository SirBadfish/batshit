<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import {
  Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { AlertCircle,
  Save,
  X
} from '@lucide/svelte'

  interface Props {
    open: boolean
    title: string
    description?: string
    prompt: string
    warning?: string
    readOnly?: boolean
    width?: 'default' | 'medium' | 'large' | 'full'
    onSave?: (prompt: string) => void
    onCancel?: () => void
  }

  let {
    open = $bindable(),
    title,
    description,
    prompt = $bindable(),
    warning,
    readOnly = false,
    width = 'default',
    onSave,
    onCancel
  }: Props = $props()

  let editedPrompt = $state(prompt)
  let hasChanges = $derived(editedPrompt !== prompt)

  // Reset edited prompt when dialog opens or prompt changes
  $effect(() => {
    if (open) {
      editedPrompt = prompt
    }
  })

  function handleSave() {
    if (onSave && hasChanges) {
      onSave(editedPrompt)
    }
    open = false
  }

  function handleCancel() {
    editedPrompt = prompt // Reset changes
    if (onCancel) onCancel()
    open = false
  }

  // Handle keyboard shortcuts
  function handleKeydown(e: KeyboardEvent) {
    // Cmd/Batshit + S to save
    if ((e.metaKey || e.ctrlKey) && e.key === 's' && !readOnly) {
      e.preventDefault()
      handleSave()
    }
    // Escape to cancel
    if (e.key === 'Escape') {
      e.preventDefault()
      handleCancel()
    }
  }

  // Map width prop to actual CSS classes
  const widthClasses = {
    default: 'w-full sm:max-w-md md:max-w-lg',
    medium: 'w-full sm:max-w-2xl md:max-w-3xl',
    large: 'w-full sm:max-w-3xl md:max-w-4xl lg:max-w-5xl',
    full: 'w-full sm:max-w-6xl md:max-w-7xl'
  }
</script>

<svelte:window onkeydown={handleKeydown} />

<Sheet.Root bind:open>
  <Sheet.Content
    side="left"
    class="{widthClasses[width]} overflow-hidden flex flex-col h-full"
    onInteractOutside={(e: Event) => e.preventDefault()}
  >
    <Sheet.Header class="batshit-settings-editor-header">
      <Sheet.Title class="text-xl">{title}</Sheet.Title>
      {#if description}
        <Sheet.Description class="mt-1">{description}</Sheet.Description>
      {/if}
    </Sheet.Header>

    <div class="batshit-settings-editor-body flex-1 overflow-y-auto">
      {#if warning}
        <div class="batshit-settings-inline-alert is-danger mb-4 flex gap-3">
          <AlertCircle class="h-4 w-4 text-destructive flex-shrink-0 mt-0.5" />
          <div>
            <h5 class="batshit-settings-form-label is-danger">Warning</h5>
            <p class="text-sm text-muted-foreground mt-1">{warning}</p>
          </div>
        </div>
      {/if}

      <div class="h-full">
        <Textarea
          bind:value={editedPrompt}
          placeholder="Enter system prompt..."
          readonly={readOnly}
          class="min-h-[calc(100vh-280px)] font-mono text-sm resize-none"
          spellcheck={false}
        />
      </div>
    </div>

    <div class="batshit-settings-editor-footer">
      <div class="flex items-center justify-between">
        <div class="batshit-settings-caption">
          {#if hasChanges}
            <span class="text-warning">Unsaved changes</span>
          {:else}
            <span>No changes</span>
          {/if}
        </div>

        <div class="flex gap-3">
          <Button
            variant="outline"
            onclick={handleCancel}
          >
            <X aria-hidden="true" />
            Cancel
          </Button>

          {#if !readOnly}
            <Button
              onclick={handleSave}
              disabled={!hasChanges}
            >
              <Save  />
              Save Changes
            </Button>
          {/if}
        </div>
      </div>

      {#if !readOnly}
        <p class="text-xs text-muted-foreground mt-2">
          Tip: Press <kbd class="batshit-settings-kbd">Cmd+S</kbd> or <kbd class="batshit-settings-kbd">Ctrl+S</kbd> to save
        </p>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
