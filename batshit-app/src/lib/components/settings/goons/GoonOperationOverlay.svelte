<script module lang="ts">
  export type GoonOperationProgress = {
    value: number
    maximum: number
    label?: string
  }

  export type GoonOperationState = {
    title: string
    phase: string
    detail?: string
    progress?: GoonOperationProgress | null
    cancelLabel?: string
    cancelPending?: boolean
    onCancel?: (() => void | Promise<void>) | null
  }

  export function formatGoonOperationElapsed(totalSeconds: number): string {
    const safeSeconds = Math.max(0, Math.floor(totalSeconds))
    const minutes = Math.floor(safeSeconds / 60)
    const seconds = safeSeconds % 60
    return minutes > 0
      ? `${minutes}:${seconds.toString().padStart(2, '0')}`
      : `${seconds}s`
  }
</script>

<script lang="ts">
  import { onMount } from 'svelte'
  import { Loader2, X } from '@lucide/svelte'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Button } from '$lib/components/ui/button'

  type Props = {
    operation: GoonOperationState | null
  }

  let { operation }: Props = $props()
  let elapsedSeconds = $state(0)
  let startedAt = 0
  let wasOpen = false

  const open = $derived(operation !== null)
  const progressValue = $derived.by(() => {
    if (!operation?.progress) return null
    const maximum = Math.max(0, operation.progress.maximum)
    if (maximum === 0) return 0
    return Math.min(maximum, Math.max(0, operation.progress.value))
  })

  $effect(() => {
    if (open && !wasOpen) {
      startedAt = Date.now()
      elapsedSeconds = 0
    }
    wasOpen = open
  })

  function blockEscape(event: KeyboardEvent) {
    if (!open || event.key !== 'Escape') return
    event.preventDefault()
    event.stopImmediatePropagation()
  }

  onMount(() => {
    window.addEventListener('keydown', blockEscape, { capture: true })
    const timer = window.setInterval(() => {
      if (!open || startedAt === 0) return
      elapsedSeconds = Math.max(0, Math.floor((Date.now() - startedAt) / 1000))
    }, 250)

    return () => {
      window.clearInterval(timer)
      window.removeEventListener('keydown', blockEscape, { capture: true })
    }
  })
</script>

<Dialog.Root {open} onOpenChange={() => {}}>
  <Dialog.Content
    class="sm:max-w-md"
    showCloseButton={false}
    onInteractOutside={(event: Event) => event.preventDefault()}
    onEscapeKeydown={(event: KeyboardEvent) => event.preventDefault()}
  >
    {#if operation}
      <Dialog.Header>
        <Dialog.Title>{operation.title}</Dialog.Title>
        <Dialog.Description>
          This may take a few minutes. Keep Batshit open.
        </Dialog.Description>
      </Dialog.Header>

      <div class="batshit-settings-muted-panel space-y-4" data-testid="goon-operation-overlay">
        <div class="flex items-start gap-3">
          <Loader2
            class="mt-0.5 h-5 w-5 shrink-0 animate-spin motion-reduce:animate-none"
            aria-hidden="true"
          />
          <div class="min-w-0 space-y-1">
            <div class="batshit-settings-form-label" aria-live="polite">
              {operation.phase}
            </div>
            {#if operation.detail}
              <p class="batshit-settings-caption">{operation.detail}</p>
            {/if}
          </div>
        </div>

        {#if operation.progress && progressValue !== null}
          <div class="space-y-1.5">
            {#if operation.progress.label}
              <div class="batshit-settings-caption">{operation.progress.label}</div>
            {/if}
            <progress
              class="w-full"
              value={progressValue}
              max={Math.max(1, operation.progress.maximum)}
            ></progress>
          </div>
        {/if}

        <div class="batshit-settings-form-meta">
          Elapsed: {formatGoonOperationElapsed(elapsedSeconds)}
        </div>
      </div>

      {#if operation.onCancel}
        <Dialog.Footer>
          <Button
            variant="outline"
            type="button"
            disabled={operation.cancelPending}
            onclick={() => void operation?.onCancel?.()}
          >
            {#if operation.cancelPending}
              <Loader2 class="animate-spin motion-reduce:animate-none" aria-hidden="true" />
              Canceling…
            {:else}
              <X aria-hidden="true" />
              {operation.cancelLabel ?? 'Cancel'}
            {/if}
          </Button>
        </Dialog.Footer>
      {/if}
    {/if}
  </Dialog.Content>
</Dialog.Root>
