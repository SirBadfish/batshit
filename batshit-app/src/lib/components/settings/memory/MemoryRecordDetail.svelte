<script lang="ts">
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import SettingsTextEditor from '$lib/components/settings/SettingsTextEditor.svelte'
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
  import { Edit3, ImageUp, Trash2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  interface Props {
    agentId: string
    detail: {
      record: Record<string, any>
      standingMediaCount?: number
      chain: { predecessors: Array<Record<string, any>>; successors: Array<Record<string, any>> }
    }
    onChanged: () => void | Promise<void>
    onDeleted: () => void | Promise<void>
  }

  let { agentId, detail, onChanged, onDeleted }: Props = $props()

  const record = $derived(detail.record)

  // Draft fields hydrate from the loaded record; edits are explicit (Save Changes).
  let draftGist = $state('')
  let draftImportance = $state(5)
  let draftLane = $state('ltm')
  let draftTriggerTerms = $state('')
  let draftLingerMode = $state<'default' | 'turns' | 'episode'>('default')
  let draftLingerTurns = $state(2)
  let draftExpiresAt = $state('')
  let hydratedId = $state<string | null>(null)
  let saving = $state(false)
  let contentEditorOpen = $state(false)
  let showDeleteConfirm = $state(false)
  let mediaDeleteTarget = $state<string | null>(null)

  $effect(() => {
    if (record.id === hydratedId) return
    hydratedId = record.id
    draftGist = record.gist ?? ''
    draftImportance = record.importance ?? 5
    draftLane = record.lane ?? 'ltm'
    // Trigger Synonyms retired 2026-08-29 (they always behaved identically to terms):
    // stored synonyms fold into the terms box here and clear on the next save.
    const hydratedTerms = [
      ...(Array.isArray(record.trigger_terms) ? record.trigger_terms : []),
      ...(Array.isArray(record.trigger_synonyms) ? record.trigger_synonyms : [])
    ]
    draftTriggerTerms = Array.from(new Set(hydratedTerms)).join(', ')
    if (record.linger_override === 'episode') {
      draftLingerMode = 'episode'
      draftLingerTurns = 2
    } else if (typeof record.linger_override === 'number') {
      draftLingerMode = 'turns'
      draftLingerTurns = record.linger_override
    } else {
      draftLingerMode = 'default'
      draftLingerTurns = 2
    }
    draftExpiresAt = record.expires_at ? String(record.expires_at).slice(0, 10) : ''
  })

  // Per-lane form (2026-08-28, Josh's model): each field appears where it matters —
  // Gist for LTM, triggers + linger for STM, expiry for Awareness. A field with a
  // stored value stays visible on any lane so nothing becomes uneditable.
  const showGist = $derived(draftLane === 'ltm' || draftGist.trim().length > 0)
  const showTriggers = $derived(draftLane === 'stm' || draftTriggerTerms.trim().length > 0)
  const showLinger = $derived(draftLane === 'stm' || draftLingerMode !== 'default')
  const showExpires = $derived(draftLane === 'awareness' || draftExpiresAt.trim().length > 0)
  const stmMissingTriggers = $derived(draftLane === 'stm' && !parseTermList(draftTriggerTerms))

  const media = $derived(Array.isArray(record.media) ? record.media : [])

  function mediaUrl(mediaId: string): string {
    const query = new URLSearchParams({ agentId, memoryId: record.id, mediaId })
    return `/api/memory/manage/media?${query}`
  }

  async function handleMediaReplacement(mediaId: string, event: Event) {
    const input = event.target as HTMLInputElement
    const file = input.files?.[0]
    input.value = ''
    if (!file) return
    saving = true
    try {
      const form = new FormData()
      form.set('file', file)
      const response = await fetch(mediaUrl(mediaId), { method: 'POST', body: form })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `Replace failed (HTTP ${response.status}).`)
      toast.success('Memory image replaced.')
      hydratedId = null
      await onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Memory image replacement failed.')
    } finally {
      saving = false
    }
  }

  async function handleMediaDelete(mediaId: string) {
    saving = true
    try {
      const response = await fetch(mediaUrl(mediaId), { method: 'DELETE' })
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `Delete failed (HTTP ${response.status}).`)
      toast.success('Memory image deleted.')
      mediaDeleteTarget = null
      hydratedId = null
      await onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Memory image deletion failed.')
    } finally {
      saving = false
    }
  }

  async function handleStandingToggle(checked: boolean) {
    await patchRecord(
      { media_mode: checked ? 'always' : 'on_recall' },
      checked ? 'This Awareness image will be shown every message.' : 'This image will arrive only when recalled.'
    )
  }

  function parseTermList(value: string): string[] | null {
    const terms = value
      .split(',')
      .map((term) => term.trim())
      .filter((term) => term.length > 0)
    return terms.length > 0 ? terms : null
  }

  async function patchRecord(updates: Record<string, any>, successMessage: string) {
    saving = true
    try {
      const response = await fetch('/api/memory/manage/record', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId, memoryId: record.id, updates })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || `Update failed (HTTP ${response.status}).`)
      }
      toast.success(successMessage)
      hydratedId = null
      await onChanged()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Memory update failed.')
    } finally {
      saving = false
    }
  }

  async function handleSaveFields() {
    if (draftLane === 'stm' && !parseTermList(draftTriggerTerms)) {
      toast.error('A Trigger Memory (STM) needs at least one trigger term, or it can never fire.')
      return
    }
    await patchRecord(
      {
        gist: draftGist.trim() ? draftGist.trim() : null,
        importance: draftImportance,
        lane: draftLane,
        trigger_terms: parseTermList(draftTriggerTerms),
        // Synonyms retired 2026-08-29: hydration folded them into terms; clear the field.
        trigger_synonyms: null,
        linger_override:
          draftLingerMode === 'episode'
            ? 'episode'
            : draftLingerMode === 'turns'
              ? Math.min(Math.max(Math.floor(draftLingerTurns) || 0, 0), 30)
              : null,
        expires_at: draftExpiresAt ? new Date(draftExpiresAt).toISOString() : null
      },
      'Memory updated.'
    )
  }

  async function handleSaveContent(content: string) {
    contentEditorOpen = false
    if (!content.trim()) {
      toast.error('Memory content cannot be empty. Delete the memory instead.')
      return
    }
    await patchRecord({ content: content.trim() }, 'Memory content updated (re-embedded).')
  }

  async function handleDelete() {
    saving = true
    try {
      const response = await fetch(
        `/api/memory/manage/record?agentId=${encodeURIComponent(agentId)}&memoryId=${encodeURIComponent(record.id)}`,
        { method: 'DELETE' }
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || `Delete failed (HTTP ${response.status}).`)
      }
      toast.success('Memory deleted.')
      showDeleteConfirm = false
      await onDeleted()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Memory delete failed.')
    } finally {
      saving = false
    }
  }

  function formatDate(value: unknown): string {
    if (!value) return '—'
    const parsed = new Date(String(value))
    return Number.isFinite(parsed.getTime()) ? parsed.toLocaleString() : '—'
  }
</script>

<div class="batshit-settings-card batshit-settings-card-default memory-detail-card">
  <div class="memory-detail-header">
    <div class="memory-detail-title-line">
      <span class="memory-detail-title">Memory Details</span>
      <Badge variant="outline" class="batshit-settings-spine-badge">{record.lane}</Badge>
      {#if record.is_superseded === 'y'}
        <Badge variant="outline" class="batshit-settings-spine-badge">superseded</Badge>
      {/if}
    </div>
    <span class="batshit-settings-form-meta memory-detail-id">{record.id}</span>
  </div>

  <div class="memory-detail-content-block">
    <div class="memory-detail-content-heading">
      <Label.Root class="batshit-settings-form-label">Content</Label.Root>
      <Button variant="outline" size="sm" onclick={() => (contentEditorOpen = true)} disabled={saving}>
        <Edit3 class="h-4 w-4" />
        Edit
      </Button>
    </div>
    <p class="memory-detail-content-text">{record.content}</p>
  </div>

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <Label.Root class="batshit-settings-form-label">Lane</Label.Root>
      </div>
      <div class="batshit-settings-form-control">
        <Select.Root type="single" value={draftLane}
          onValueChange={(value) => {
            const lane = Array.isArray(value) ? value[0] : value
            if (lane) draftLane = lane
          }}>
          <Select.Trigger class="w-full justify-between">
            {draftLane === 'awareness'
              ? 'Awareness (always in the prompt)'
              : draftLane === 'stm'
                ? 'STM (Trigger Memory)'
                : 'LTM (searchable long-term)'}
          </Select.Trigger>
          <Select.Content>
            <Select.Item value="awareness">Awareness (always in the prompt)</Select.Item>
            <Select.Item value="stm">STM (Trigger Memory)</Select.Item>
            <Select.Item value="ltm">LTM (searchable long-term)</Select.Item>
          </Select.Content>
        </Select.Root>
      </div>
    </div>

    <div class="batshit-settings-form-row">
      <div class="batshit-settings-form-copy">
        <Label.Root class="batshit-settings-form-label">Importance</Label.Root>
      </div>
      <div class="batshit-settings-form-control">
        <Input type="number" min="1" max="10" step="1" value={draftImportance}
          oninput={(event) => (draftImportance = parseInt((event.target as HTMLInputElement).value, 10) || 5)} />
      </div>
    </div>

    {#if showGist}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label">Gist</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Input value={draftGist} placeholder="One-line summary shown in search results"
            oninput={(event) => (draftGist = (event.target as HTMLInputElement).value)} />
        </div>
      </div>
    {/if}

    {#if showTriggers}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label">Trigger Terms</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Input value={draftTriggerTerms} placeholder="Comma-separated (required for STM)"
            oninput={(event) => (draftTriggerTerms = (event.target as HTMLInputElement).value)} />
          {#if stmMissingTriggers}
            <p class="batshit-settings-form-meta is-warning">
              A Trigger Memory with no trigger terms can never fire. Add at least one term.
            </p>
          {/if}
        </div>
      </div>
    {/if}

    {#if showLinger}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label">Linger</Label.Root>
            <SettingsInfoMenu ariaLabel="About Linger" contentClass="w-80">
              <p>
                How long this memory stays in context after its trigger was last mentioned:
                the agent's default, a custom number of messages, or the rest of the current
                episode.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <div class="memory-linger-line">
            <Select.Root type="single" value={draftLingerMode}
              onValueChange={(value) => {
                const mode = Array.isArray(value) ? value[0] : value
                if (mode === 'default' || mode === 'turns' || mode === 'episode') draftLingerMode = mode
              }}>
              <Select.Trigger class="memory-linger-select justify-between">
                {draftLingerMode === 'default'
                  ? 'Agent Default'
                  : draftLingerMode === 'turns'
                    ? 'Custom # of Messages'
                    : 'Rest of the Episode'}
              </Select.Trigger>
              <Select.Content>
                <Select.Item value="default">Agent Default</Select.Item>
                <Select.Item value="turns">Custom # of Messages</Select.Item>
                <Select.Item value="episode">Rest of the Episode</Select.Item>
              </Select.Content>
            </Select.Root>
            {#if draftLingerMode === 'turns'}
              <Input type="number" min="0" max="30" step="1" value={draftLingerTurns}
                oninput={(event) => (draftLingerTurns = parseInt((event.target as HTMLInputElement).value, 10) || 0)} />
            {/if}
          </div>
        </div>
      </div>
    {/if}

    {#if showExpires}
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label">Expires (optional)</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Input type="date" value={draftExpiresAt}
            oninput={(event) => (draftExpiresAt = (event.target as HTMLInputElement).value)} />
        </div>
      </div>
    {/if}

    <div class="batshit-settings-action-row">
      <Button size="sm" onclick={handleSaveFields} disabled={saving}>
        {saving ? 'Saving...' : 'Save Changes'}
      </Button>
    </div>
  </div>

  <div class="memory-detail-meta-block">
    <p class="batshit-settings-form-meta">Saved {formatDate(record.saved_at)}{record.updated_at ? ` · Updated ${formatDate(record.updated_at)}` : ''}</p>
    {#if record.event_at}
      <p class="batshit-settings-form-meta">Happened {formatDate(record.event_at)}</p>
    {/if}
    {#if record.last_recalled_at}
      <p class="batshit-settings-form-meta">Last recalled {formatDate(record.last_recalled_at)} ({record.recall_count ?? 0}×)</p>
    {/if}
    {#if Array.isArray(record.links) && record.links.length > 0}
      <p class="batshit-settings-form-meta">Links: {record.links.join(', ')}</p>
    {/if}
  </div>

  {#if media.length > 0}
    <div class="memory-detail-media">
      <Label.Root class="batshit-settings-form-label">Media</Label.Root>
      <div class="memory-detail-media-grid">
        {#each media as image (image.id)}
          <div class="memory-detail-media-card">
            <img src={mediaUrl(image.id)} alt={image.display_name ?? image.filename} />
            <div class="memory-detail-media-copy">
              <span class="memory-detail-media-name">{image.display_name ?? image.filename}</span>
              <span class="batshit-settings-form-meta">
                {image.width}×{image.height} · about {image.token_estimate ?? Math.ceil(image.width / 28) * Math.ceil(image.height / 28)} image tokens per model call
              </span>
            </div>
            {#if record.lane === 'awareness'}
              <div class="memory-detail-standing-row">
                <div>
                  <span class="batshit-settings-form-label">Show this image every message</span>
                  <span class="batshit-settings-form-meta">
                    {detail.standingMediaCount ?? 0} of 4 standing images currently used
                  </span>
                </div>
                <Switch.Root
                  checked={record.media_mode === 'always'}
                  disabled={saving}
                  onCheckedChange={(value) => void handleStandingToggle(value === true)}
                />
              </div>
            {/if}
            <div class="memory-detail-media-actions">
              <label class="memory-detail-media-replace">
                <ImageUp class="h-4 w-4" />
                Replace
                <input
                  type="file"
                  accept="image/jpeg,image/png,image/gif,image/webp"
                  disabled={saving}
                  onchange={(event) => void handleMediaReplacement(image.id, event)}
                />
              </label>
              <Button variant="outline" size="sm" onclick={() => (mediaDeleteTarget = image.id)} disabled={saving}>
                <Trash2 class="h-4 w-4" />
                Delete
              </Button>
            </div>
          </div>
        {/each}
      </div>
    </div>
  {/if}

  {#if Array.isArray(record.provenance) && record.provenance.length > 0}
    <div class="memory-detail-provenance">
      <Label.Root class="batshit-settings-form-label">Where It Came From</Label.Root>
      {#each record.provenance as entry, idx (idx)}
        <p class="batshit-settings-form-meta">
          {entry.source} · chat <span class="memory-detail-code">{entry.session_id}</span>
          {#if entry.source_deleted}(original chat deleted){/if}
          {#if entry.quote}— "{entry.quote}"{/if}
          {#if entry.note}— {entry.note}{/if}
        </p>
      {/each}
    </div>
  {/if}

  {#if detail.chain.predecessors.length > 0 || detail.chain.successors.length > 0}
    <div class="memory-detail-chain">
      <Label.Root class="batshit-settings-form-label">Supersession Chain</Label.Root>
      {#each detail.chain.predecessors as entry (entry.id)}
        <p class="batshit-settings-form-meta">← replaced <span class="memory-detail-code">{entry.id}</span>: {entry.gist}</p>
      {/each}
      {#each detail.chain.successors as entry (entry.id)}
        <p class="batshit-settings-form-meta">→ replaced by <span class="memory-detail-code">{entry.id}</span>: {entry.gist}</p>
      {/each}
    </div>
  {/if}

  <div class="memory-detail-delete">
    <Button variant="outline" size="sm" class="memory-detail-delete-button" onclick={() => (showDeleteConfirm = true)} disabled={saving}>
      <Trash2 class="h-4 w-4" />
      Delete Memory
    </Button>
  </div>
</div>

<SettingsTextEditor
  bind:open={contentEditorOpen}
  title="Edit Memory Content"
  description="Changing the content re-embeds this memory so search keeps working."
  value={record.content ?? ''}
  width="large"
  onSave={handleSaveContent}
/>

<AlertDialog bind:open={showDeleteConfirm}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete This Memory?</AlertDialogTitle>
      <AlertDialogDescription>
        This permanently deletes the memory record. It cannot be undone. If a newer
        memory replaced it, consider leaving it superseded instead — supersession keeps
        the history visible.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel onclick={() => (showDeleteConfirm = false)}>Cancel</AlertDialogCancel>
      <AlertDialogAction onclick={handleDelete} class="memory-detail-delete-action" disabled={saving}>
        Delete Memory
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

<AlertDialog open={mediaDeleteTarget !== null} onOpenChange={(open) => { if (!open) mediaDeleteTarget = null }}>
  <AlertDialogContent>
    <AlertDialogHeader>
      <AlertDialogTitle>Delete This Memory Image?</AlertDialogTitle>
      <AlertDialogDescription>
        This permanently removes the memory-owned copy. The memory itself and the original
        Clip, if it still exists, are not changed.
      </AlertDialogDescription>
    </AlertDialogHeader>
    <AlertDialogFooter>
      <AlertDialogCancel onclick={() => (mediaDeleteTarget = null)}>Cancel</AlertDialogCancel>
      <AlertDialogAction
        onclick={() => mediaDeleteTarget && void handleMediaDelete(mediaDeleteTarget)}
        class="memory-detail-delete-action"
        disabled={saving}
      >
        Delete Image
      </AlertDialogAction>
    </AlertDialogFooter>
  </AlertDialogContent>
</AlertDialog>

<style>
  .memory-detail-card {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
  }

  .memory-detail-header {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .memory-detail-title-line {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .memory-detail-title {
    font-size: 0.9375rem;
    font-weight: 500;
  }

  .memory-detail-id,
  .memory-detail-code {
    font-family: var(--font-mono, 'Geist Mono', monospace);
    font-size: 0.6875rem;
    overflow-wrap: anywhere;
  }

  /* Ids in prose get the site-wide inline-code chip treatment. */
  .memory-detail-code {
    border: 1px solid var(--bs-inline-code-line);
    border-radius: 0.3125rem;
    background: var(--bs-inline-code-bg);
    padding: 0.02rem 0.28rem;
    color: var(--bs-inline-code-text);
  }

  .memory-detail-content-block {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .memory-detail-content-heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .memory-detail-content-text {
    margin: 0;
    font-size: 0.875rem;
    font-weight: 300;
    line-height: 1.5;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .memory-detail-meta-block,
  .memory-detail-provenance,
  .memory-detail-chain,
  .memory-detail-media {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .memory-detail-media-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.5rem;
  }

  .memory-detail-media-card {
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
    border: 1px solid var(--bs-settings-inner-line);
    border-radius: 0.625rem;
    background: var(--bs-settings-inset-bg);
    padding: 0.625rem;
  }

  .memory-detail-media-card img {
    width: 100%;
    max-height: 16rem;
    border-radius: 0.4375rem;
    object-fit: contain;
    background: var(--bs-settings-stage-bg);
  }

  .memory-detail-media-copy,
  .memory-detail-standing-row > div {
    display: flex;
    min-width: 0;
    flex-direction: column;
    gap: 0.125rem;
  }

  .memory-detail-media-name {
    overflow: hidden;
    font-size: 0.8125rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .memory-detail-standing-row,
  .memory-detail-media-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .memory-detail-media-actions {
    justify-content: flex-end;
  }

  .memory-detail-media-replace {
    display: inline-flex;
    height: 2rem;
    cursor: pointer;
    align-items: center;
    gap: 0.375rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    padding: 0 0.75rem;
    font-size: 0.75rem;
    font-weight: 500;
  }

  .memory-detail-media-replace input {
    display: none;
  }

  .memory-linger-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.5rem;
    min-width: 0;
  }

  /* Same bounded-control treatment as the window selects in Agent Settings. */
  .memory-linger-line > :global(.memory-linger-select) {
    flex: 0 1 auto;
    width: 12rem;
    max-width: 100%;
    min-width: 9.5rem;
  }

  .memory-linger-line > :global(input) {
    flex: 0 1 auto;
    width: 6rem;
    max-width: 100%;
  }

  .memory-detail-delete {
    display: flex;
    justify-content: flex-end;
    border-top: 1px solid var(--bs-settings-inner-line, oklch(0.23 0 0));
    padding-top: 0.75rem;
  }

  :global(.memory-detail-delete-button) {
    color: var(--destructive);
  }

  :global(.memory-detail-delete-action) {
    background: var(--destructive);
    color: var(--destructive-foreground);
  }
</style>
