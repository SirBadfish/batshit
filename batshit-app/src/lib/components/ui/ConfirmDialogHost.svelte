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
  import { Checkbox } from '$lib/components/ui/checkbox'
  import {
    activeConfirmDialog,
    resolveConfirmDialog,
    setConfirmDialogChecked
  } from '$lib/stores/confirmDialog'

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
      {#if request.checkbox}
        <label class="batshit-confirm-dialog-checkbox">
          <Checkbox
            checked={request.checked}
            onCheckedChange={(checked: boolean) =>
              setConfirmDialogChecked(request.id, checked === true)}
            class="mt-0.5 shrink-0"
            aria-label={request.checkbox.label}
          />
          <span class="batshit-confirm-dialog-checkbox-text">
            <span class="batshit-confirm-dialog-checkbox-label">{request.checkbox.label}</span>
            {#if request.checkbox.note}
              <span class="batshit-confirm-dialog-checkbox-note">{request.checkbox.note}</span>
            {/if}
          </span>
        </label>
      {/if}
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

  :global(.batshit-confirm-dialog-checkbox) {
    display: flex;
    align-items: flex-start;
    gap: 0.6rem;
    cursor: pointer;
  }

  :global(.batshit-confirm-dialog-checkbox-text) {
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
  }

  :global(.batshit-confirm-dialog-checkbox-label) {
    font-size: 0.875rem;
    font-weight: 500;
    line-height: 1.35;
    color: var(--foreground);
  }

  :global(.batshit-confirm-dialog-checkbox-note) {
    font-size: 0.8125rem;
    font-weight: 300;
    line-height: 1.4;
    color: var(--muted-foreground);
  }

  :global(.batshit-confirm-dialog-action.is-destructive) {
    background: var(--destructive);
    color: var(--destructive-foreground);
  }

  :global(.batshit-confirm-dialog-action.is-destructive:hover) {
    background: color-mix(in oklch, var(--destructive) 90%, white 10%);
  }
</style>
