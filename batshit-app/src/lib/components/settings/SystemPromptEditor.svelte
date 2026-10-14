<script lang="ts">
  import { untrack } from 'svelte'
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
  // The saved prompt the draft is lined up with: the one the editor opened with, or the last one it
  // followed. `null` while the editor is closed. It tells an untouched draft (follow a new saved
  // prompt) from an edited one (keep it, and say the saved prompt changed).
  let draftBase = $state<string | null>(null)
  let hasChanges = $derived(editedPrompt !== prompt)
  const savedPromptChangedWhileEditing = $derived(
    draftBase !== null && prompt !== draftBase && editedPrompt !== prompt
  )

  // BL-894 (BL-816's rule for this editor): the draft is taken when the editor OPENS, never on every
  // `prompt` change. The only values that may re-run this effect are `open` and `prompt`;
  // everything it writes (and the `draftBase` / `editedPrompt` it compares) is read inside `untrack`.
  $effect(() => {
    const isOpen = open
    const saved = prompt
    untrack(() => {
      if (!isOpen) {
        draftBase = null
        return
      }
      if (draftBase === null) {
        editedPrompt = saved
        draftBase = saved
        return
      }
      if (saved !== draftBase && editedPrompt === draftBase) {
        editedPrompt = saved
        draftBase = saved
      }
    })
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
    // BL-891: only this editor's own sheet hears its keys (the handler is on `Sheet.Content`, not on
    // the window: five files mount this editor, and a closed editor's draft can be older than its
    // prompt). `open` is asked as well, for the sheet's close animation.
    if (!open) return
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

<Sheet.Root bind:open>
  <Sheet.Content
    side="left"
    class="{widthClasses[width]} overflow-hidden flex flex-col h-full"
    onInteractOutside={(e: Event) => e.preventDefault()}
    onkeydown={handleKeydown}
  >
    <Sheet.Header class="batshit-settings-editor-header">
      <Sheet.Title class="text-xl">{title}</Sheet.Title>
      {#if description}
        <Sheet.Description class="mt-1">{description}</Sheet.Description>
      {/if}
    </Sheet.Header>

    <div class="batshit-settings-editor-body flex-1 overflow-y-auto">
      {#if savedPromptChangedWhileEditing}
        <div
          class="batshit-settings-inline-alert is-warning mb-4 flex gap-3"
          data-testid="system-prompt-editor-saved-value-changed"
        >
          <AlertCircle class="h-4 w-4 flex-shrink-0 mt-0.5" />
          <div>
            <h5 class="batshit-settings-form-label is-warning">Saved prompt changed</h5>
            <p class="text-sm text-muted-foreground mt-1">
              The saved prompt changed while you were editing. Your text is kept, and saving replaces the
              saved prompt with it. Cancel discards your text.
            </p>
          </div>
        </div>
      {/if}

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
