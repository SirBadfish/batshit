<script lang="ts">
  import {
    AlertDialog,
    AlertDialogAction,
    AlertDialogCancel,
    AlertDialogContent,
    AlertDialogDescription,
    AlertDialogFooter,
    AlertDialogHeader,
    AlertDialogTitle
  } from '$lib/components/ui/alert-dialog'
  import { activeConfirmDialog, resolveConfirmDialog } from '$lib/stores/confirmDialog'

  const request = $derived($activeConfirmDialog)
  const open = $derived(Boolean(request))

  function handleOpenChange(nextOpen: boolean) {
    if (!nextOpen && request) {
      resolveConfirmDialog(request.id, false)
    }
  }

  function handleConfirm() {
    if (request) {
      resolveConfirmDialog(request.id, true)
    }
  }
</script>

<AlertDialog {open} onOpenChange={handleOpenChange}>
  {#if request}
    <AlertDialogContent>
      <AlertDialogHeader>
        <AlertDialogTitle>{request.title}</AlertDialogTitle>
        {#if request.descriptionLines.length > 0}
          <AlertDialogDescription class="batshit-confirm-dialog-description">
            {#each request.descriptionLines as line}
              {#if line}
                <span>{line}</span>
              {:else}
                <span aria-hidden="true"></span>
              {/if}
            {/each}
          </AlertDialogDescription>
        {/if}
      </AlertDialogHeader>
      <AlertDialogFooter>
        <AlertDialogCancel>{request.cancelLabel}</AlertDialogCancel>
        <AlertDialogAction
          onclick={handleConfirm}
          class={`batshit-confirm-dialog-action ${
            request.tone === 'destructive' ? 'is-destructive' : ''
          }`}
        >
          {request.confirmLabel}
        </AlertDialogAction>
      </AlertDialogFooter>
    </AlertDialogContent>
  {/if}
</AlertDialog>

<style>
  :global(.batshit-confirm-dialog-description) {
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  :global(.batshit-confirm-dialog-description span:empty) {
    min-height: 0.25rem;
  }

  :global(.batshit-confirm-dialog-action.is-destructive) {
    background: var(--destructive);
    color: var(--destructive-foreground);
  }

  :global(.batshit-confirm-dialog-action.is-destructive:hover) {
    background: color-mix(in oklch, var(--destructive) 90%, white 10%);
  }
</style>
