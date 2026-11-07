<script lang="ts">
  import { page } from '$app/state'
  import AppActionsOperationReview from '$lib/components/settings/agent/AppActionsOperationReview.svelte'
  const operationId = $derived(page.params.operationId ?? '')
</script>

<svelte:head><title>Review App Actions Request | Batshit</title></svelte:head>
<main class="batshit-settings-dialog h-full overflow-y-auto">
  <div class="mx-auto max-w-3xl p-4">{#key operationId}<AppActionsOperationReview {operationId} />{/key}</div>
</main>
