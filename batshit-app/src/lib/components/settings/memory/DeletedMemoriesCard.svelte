<script lang="ts">
  import { untrack } from 'svelte'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import { AlertDialog, AlertDialogAction, AlertDialogCancel, AlertDialogContent, AlertDialogDescription, AlertDialogFooter, AlertDialogHeader, AlertDialogTitle } from '$lib/components/ui/alert-dialog'
  import { Trash2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  let { agentId, onChanged }: { agentId: string; onChanged: () => void | Promise<void> } = $props()
  let rows = $state<Array<Record<string, any>>>([])
  let total = $state(0)
  let loading = $state(false)
  let loaded = $state(false)
  let busy = $state(false)
  let unknown = $state(false)
  let error = $state<string | null>(null)
  let detail = $state<Record<string, any> | null>(null)
  let confirmAgent = $state<string | null>(null)
  let showEmpty = $state(false)
  let generation = 0
  let detailGeneration = 0

  async function refresh() {
    const owner = agentId, request = ++generation
    loading = true
    try {
      const response = await fetch(`/api/memory/manage/trash?${new URLSearchParams({ agentId: owner })}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok) throw new Error(payload?.error || 'Deleted Memories could not be read.')
      if (!Array.isArray(payload.results) || !Number.isSafeInteger(payload.total) || payload.total < payload.results.length) throw new Error('Deleted Memories returned an unreadable list.')
      if (owner !== agentId || request !== generation) return
      rows = payload.results; total = payload.total; loaded = true; unknown = false; error = null
      if (detail && !rows.some(row => row.id === detail?.id)) detail = null
    } catch (failure) {
      if (owner === agentId && request === generation) error = failure instanceof Error ? failure.message : 'Deleted Memories could not be read.'
    } finally { if (owner === agentId && request === generation) loading = false }
  }

  $effect(() => {
    const owner = agentId
    untrack(() => {
      generation++; detailGeneration++; rows = []; total = 0; loaded = false; detail = null
      error = null; unknown = false; showEmpty = false; confirmAgent = null
      if (owner) void refresh()
    })
  })

  async function inspect(id: string) {
    const owner = agentId, request = ++detailGeneration
    try {
      const response = await fetch(`/api/memory/manage/record?${new URLSearchParams({ agentId: owner, memoryId: id })}`, { cache: 'no-store' })
      const payload = await response.json()
      if (!response.ok || payload?.record?.id !== id || typeof payload.record.deleted_ts !== 'number') throw new Error(payload?.error || 'This memory is no longer in Deleted Memories. Refresh the list.')
      if (owner === agentId && request === detailGeneration) detail = payload.record
    } catch (failure) { if (owner === agentId && request === detailGeneration) error = failure instanceof Error ? failure.message : 'Memory could not be read.' }
  }

  async function change(action: 'restore' | 'empty', id?: string) {
    const owner = agentId
    if (!loaded || busy || unknown || action === 'empty' && confirmAgent !== owner) return
    busy = true; error = null
    let issued = false
    try {
      issued = true
      const response = await fetch(`/api/memory/manage/trash?${new URLSearchParams({ agentId: owner })}`, action === 'restore'
        ? { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ agentId: owner, memoryId: id }) }
        : { method: 'DELETE' })
      const payload = await response.json()
      if (!response.ok) {
        // Only these explicit pre-write refusals establish no effect. Other outcomes
        // may include settled partial cleanup or a save with a lost acknowledgement.
        if ([400, 403, 404, 409].includes(response.status)) issued = false
        throw new Error(payload?.error || 'Deleted Memories could not be updated.')
      }
      issued = false
      toast.success(action === 'restore' ? 'Memory restored.' : `${payload.purged} memories permanently removed.`)
      if (owner !== agentId) return
      detail = null; showEmpty = false
      await refresh(); await onChanged()
    } catch (failure) {
      if (owner !== agentId) return
      unknown = issued
      error = `${failure instanceof Error ? failure.message : 'Deleted Memories could not be updated.'}${issued ? ' Read the current list before another action; the operation may have partly or fully completed.' : ''}`
    } finally { if (owner === agentId) busy = false }
  }

  function imageUrl(mediaId: string) {
    return `/api/memory/manage/media?${new URLSearchParams({ agentId, memoryId: detail?.id ?? '', mediaId })}`
  }
</script>

<SettingsAccordionCard name="memory-deleted" title="Deleted Memories" icon={Trash2}>
  <div class="batshit-settings-action-row">
    <span class="batshit-settings-form-meta">{loaded ? `${total} deleted memories` : 'Reading deleted memories…'}</span>
    <Button size="sm" variant="outline" onclick={refresh} disabled={loading || busy}>Read current list</Button>
    <Button size="sm" variant="outline" disabled={!loaded || !total || busy || unknown} onclick={() => { confirmAgent = agentId; showEmpty = true }}>Empty Deleted Memories</Button>
  </div>
  <p class="batshit-settings-form-help">Deleted memories and their photos stay here until you restore them or empty this section. Agents cannot read or restore them.</p>
  {#if error}<p class="batshit-settings-form-help batshit-settings-warning-text" role="alert">{error}</p>{/if}
  {#if loaded && !rows.length}<p class="batshit-settings-form-meta">No deleted memories.</p>{/if}
  <div class="batshit-settings-group">
    {#each rows as row (row.id)}
      <div class="batshit-settings-subsection">
        <div class="batshit-settings-action-row">
          <Button size="sm" variant="outline" onclick={() => inspect(row.id)}>{row.gist || row.id}</Button>
          <span class="batshit-settings-status-badge">{row.deleted_at ? new Date(row.deleted_at).toLocaleDateString() : 'Deleted'}</span>
          {#if row.expired}<span class="batshit-settings-status-badge">Expired</span>{/if}
          {#if row.purge_pending}<span class="batshit-settings-form-meta">Removal needs completion</span>{/if}
          <Button size="sm" variant="outline" disabled={busy || unknown} onclick={() => change('restore', row.id)}>Restore</Button>
        </div>
      </div>
    {/each}
  </div>
  {#if total > rows.length}<p class="batshit-settings-form-meta">Showing {rows.length} of {total}. Empty Deleted Memories applies to all {total}.</p>{/if}
  {#if detail}
    <div class="batshit-settings-subsection">
      <p>{detail.content}</p>
      {#each detail.media ?? [] as media (media.id)}
        <img src={imageUrl(media.id)} alt={media.display_name || 'Memory photo'} style="max-width: 100%; max-height: 16rem; object-fit: contain;" />
      {/each}
      <p class="batshit-settings-form-meta">Restore this memory before editing it. An expired memory stays expired after restoration.</p>
    </div>
  {/if}
</SettingsAccordionCard>

<AlertDialog bind:open={showEmpty}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Empty Deleted Memories?</AlertDialogTitle>
      <AlertDialogDescription>This permanently removes all deleted memories for this agent and their owned photos. It cannot be undone. Active memories and original Clips are kept.</AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel>Cancel</AlertDialogCancel>
      <AlertDialogAction disabled={busy || confirmAgent !== agentId} onclick={() => change('empty')}>Empty Deleted Memories</AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>
