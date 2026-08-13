<script lang="ts">
  import { RotateCcw } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import {
    captureDesktopShortcut,
    detectDesktopShortcutPlatform,
    formatDesktopShortcut,
    type DesktopShortcutPlatform
  } from '$lib/goons/desktopShortcut'

  let {
    id,
    value,
    disabled = false,
    defaultValue,
    onCommit
  }: {
    id: string
    value: string
    disabled?: boolean
    defaultValue: string
    onCommit: (accelerator: string) => void
  } = $props()

  let recording = $state(false)
  let feedback = $state('')
  const platform = $derived<DesktopShortcutPlatform>(detectDesktopShortcutPlatform())
  const displayValue = $derived(
    recording ? 'Press a shortcut…' : formatDesktopShortcut(value, platform)
  )

  function finishRecording(target: HTMLInputElement) {
    recording = false
    target.blur()
  }

  function handleShortcutKeydown(event: KeyboardEvent) {
    event.preventDefault()
    event.stopPropagation()
    const result = captureDesktopShortcut(event, platform)
    if (result.kind === 'ignored') return
    if (result.kind === 'cancelled') {
      feedback = 'Shortcut unchanged.'
      finishRecording(event.currentTarget as HTMLInputElement)
      return
    }
    if (result.kind === 'reset') {
      feedback = 'Default shortcut restored.'
      onCommit(defaultValue)
      finishRecording(event.currentTarget as HTMLInputElement)
      return
    }
    if (result.kind === 'invalid') {
      feedback = result.message
      return
    }
    feedback = `${formatDesktopShortcut(result.accelerator, platform)} recorded.`
    onCommit(result.accelerator)
    finishRecording(event.currentTarget as HTMLInputElement)
  }
</script>

<div class="space-y-1.5">
  <div class="flex items-center gap-2">
    <Input
      {id}
      value={displayValue}
      readonly
      {disabled}
      aria-label="Desktop Controls shortcut recorder"
      aria-describedby={`${id}-hint ${id}-feedback`}
      class={recording ? 'border-primary ring-1 ring-primary/40' : ''}
      onfocus={() => {
        recording = true
        feedback = 'Press the shortcut you want to use.'
      }}
      onblur={() => (recording = false)}
      onkeydown={handleShortcutKeydown}
    />
    <Button
      type="button"
      variant="outline"
      size="icon"
      {disabled}
      aria-label="Restore the default Desktop Controls shortcut"
      title="Restore default shortcut"
      onclick={() => {
        feedback = 'Default shortcut restored.'
        onCommit(defaultValue)
      }}
    >
      <RotateCcw aria-hidden="true" class="h-4 w-4" />
    </Button>
  </div>
  <p id={`${id}-hint`} class="text-xs text-muted-foreground">
    Click the field, then press the shortcut. Escape cancels; Delete restores the default.
  </p>
  <p id={`${id}-feedback`} class="sr-only" aria-live="polite">{feedback}</p>
</div>
