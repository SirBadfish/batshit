<script lang="ts">
  import { getContext, onMount, untrack } from 'svelte'
  import { APP_ACTIONS_SETTINGS_DRAFT_SCOPE, registerAppActionDraft } from '$lib/appActions/owners'
  import * as Sheet from '$lib/components/ui/sheet'
  import {
  Button } from '$lib/components/ui/button'
  import { Textarea } from '$lib/components/ui/textarea'
  import { AlertCircle,
  Loader2,
  Save,
  X
} from '@lucide/svelte'

  interface Props {
    open: boolean
    title: string
    value: string
    description?: string
    warning?: string
    placeholder?: string
    maxLength?: number
    readOnly?: boolean
    width?: 'default' | 'medium' | 'large' | 'full'
    saveLabel?: string
    onSave?: (value: string) => void | Promise<void>
    onCancel?: () => void
  }

  let {
    open = $bindable(),
    title,
    value,
    description,
    warning,
    placeholder = 'Enter text...',
    maxLength,
    readOnly = false,
    width = 'default',
    saveLabel = 'Save Changes',
    onSave,
    onCancel
  }: Props = $props()

  let editedValue = $state('')
  let isSaving = $state(false)
  let saveError = $state<string | null>(null)
  // The saved value the draft is lined up with: the one the editor opened with, or the last one it
  // followed. `null` while the editor is closed. It is what tells an untouched draft (follow a new
  // saved value) from an edited one (keep it, and say the saved value changed).
  let draftBase = $state<string | null>(null)

  const hasChanges = $derived(editedValue !== value)
  // P1 reads the real editor draft. It never saves, discards or closes this editor.
  const appActionsSettingsScope = getContext<boolean>(APP_ACTIONS_SETTINGS_DRAFT_SCOPE) === true
  onMount(() => appActionsSettingsScope ? registerAppActionDraft(() => open && (hasChanges || isSaving)) : undefined)
  // Not while this editor's own save is in flight: the panel updates the saved value as part of it.
  const savedValueChangedWhileEditing = $derived(
    draftBase !== null && !isSaving && value !== draftBase && editedValue !== value
  )

  // BL-816: the draft is taken when the editor OPENS, never on every `value` change. The only
  // values that may re-run this effect are `open` and `value`; everything it writes (and the
  // `draftBase` / `editedValue` it compares) is read inside `untrack`, so it cannot re-run itself.
  $effect(() => {
    const isOpen = open
    const saved = value
    untrack(() => {
      if (!isOpen) {
        draftBase = null
        return
      }
      if (draftBase === null) {
        editedValue = saved
        draftBase = saved
        saveError = null
        isSaving = false
        return
      }
      if (saved !== draftBase && editedValue === draftBase) {
        editedValue = saved
        draftBase = saved
      }
    })
  })

  async function handleSave() {
    if (readOnly || !hasChanges || !onSave) {
      open = false
      return
    }

    saveError = null
    isSaving = true

    try {
      await onSave(editedValue)
      open = false
    } catch (error) {
      saveError = error instanceof Error ? error.message : 'Failed to save changes'
    } finally {
      isSaving = false
    }
  }

  function handleCancel() {
    editedValue = value
    saveError = null
    if (onCancel) onCancel()
    open = false
  }

  function handleKeydown(event: KeyboardEvent) {
    // BL-891: only this editor's own sheet hears its keys (the handler is on `Sheet.Content`, not on
    // the window: a panel mounts several editors, and a closed editor's draft is empty or stale and
    // must never be saved). `open` is asked as well, for the sheet's close animation.
    if (!open) return

    if ((event.metaKey || event.ctrlKey) && event.key === 's' && !readOnly) {
      event.preventDefault()
      void handleSave()
    }

    if (event.key === 'Escape' && !isSaving) {
      event.preventDefault()
      handleCancel()
    }
  }

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
    class={`${widthClasses[width]} flex h-full flex-col overflow-hidden`}
    onInteractOutside={(event: Event) => event.preventDefault()}
    onkeydown={handleKeydown}
  >
    <Sheet.Header class="batshit-settings-editor-header">
      <Sheet.Title class="text-xl">{title}</Sheet.Title>
      {#if description}
        <Sheet.Description class="mt-1">{description}</Sheet.Description>
      {/if}
    </Sheet.Header>

    <div class="batshit-settings-editor-body flex-1 overflow-y-auto">
      {#if savedValueChangedWhileEditing}
        <div
          class="batshit-settings-inline-alert is-warning mb-4 flex gap-3"
          data-testid="settings-text-editor-saved-value-changed"
        >
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0" />
          <div>
            <h5 class="batshit-settings-form-label is-warning">Saved value changed</h5>
            <p class="batshit-settings-caption mt-1">
              The saved value changed while you were editing. Your text is kept, and saving replaces the
              saved value with it. Cancel discards your text.
            </p>
          </div>
        </div>
      {/if}

      {#if warning}
        <div class="batshit-settings-inline-alert is-danger mb-4 flex gap-3">
          <AlertCircle class="mt-0.5 h-4 w-4 shrink-0 text-destructive" />
          <div>
            <h5 class="batshit-settings-form-label is-danger">Warning</h5>
            <p class="batshit-settings-caption mt-1">{warning}</p>
          </div>
        </div>
      {/if}

      <Textarea
        bind:value={editedValue}
        placeholder={placeholder}
        maxlength={maxLength}
        readonly={readOnly}
        class="min-h-[calc(100vh-280px)] resize-none font-mono text-sm"
        spellcheck={false}
      />
      {#if maxLength}
        <p class="mt-2 text-xs text-muted-foreground">
          {editedValue.length}/{maxLength}
        </p>
      {/if}
    </div>

    <div class="batshit-settings-editor-footer">
      <div class="flex items-center justify-between gap-4">
        <div class="batshit-settings-caption">
          {#if saveError}
            <span class="text-destructive">{saveError}</span>
          {:else if hasChanges}
            <span class="text-warning">Unsaved changes</span>
          {:else}
            <span>No changes</span>
          {/if}
        </div>

        <div class="flex gap-3">
          <Button variant="outline" onclick={handleCancel} disabled={isSaving}><X aria-hidden="true" />Cancel</Button>
          {#if !readOnly}
            <Button onclick={handleSave} disabled={isSaving || !hasChanges}>
              {#if isSaving}
                <Loader2 class="animate-spin" />
                Saving...
              {:else}
                <Save  />
                {saveLabel}
              {/if}
            </Button>
          {/if}
        </div>
      </div>

      {#if !readOnly}
        <p class="mt-2 text-xs text-muted-foreground">
          Tip: Press <kbd class="batshit-settings-kbd">Cmd+S</kbd> or
          <kbd class="batshit-settings-kbd">Ctrl+S</kbd> to save
        </p>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>
