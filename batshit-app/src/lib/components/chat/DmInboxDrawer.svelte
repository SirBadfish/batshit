<script lang="ts">
  import * as Sheet from '$lib/components/ui/sheet'
  import { Button } from '$lib/components/ui/button'
  import { CircleStop, RefreshCcw, Trash2 } from '@lucide/svelte'
  import { dmSenderLabel } from '$lib/utils/dmSender'
  import { dmSenderIcon } from '$lib/utils/dmSenderIcons'
  import * as sessionStore from '$lib/stores/session.svelte'
  import { onUserChannelEvent } from '$lib/services/userChannel'
  import { hydrateDmInboxCounts } from '$lib/stores/dmInbox.svelte'
  import type {
    DmDeliveryRecord,
    DmKind,
    DmPriority,
    DmRecord,
    DmStatus,
    DmSender
  } from '$lib/types/dm'

  /**
   * SA-113 P4 (DL-113-10a) — the inbox drawer.
   *
   * Josh's ask, in his own words: "maybe just a log of DMs for people that really want to
   * see them." Most users will never open this; the ones who do want the whole traffic in
   * one place, including the parts an agent cannot show them — what a wake actually did and
   * why it degraded, which chat handled an assignment, and whether a webhook's callback
   * landed.
   *
   * It doubles as Josh's "visible list of running things with a stop button": a row whose
   * woken turn is still running shows a live mark and Stop, through the same
   * `/api/messages/interrupt` route the chat's own Stop uses.
   *
   * Shell copied from `ExecutionViewerSheet` (right-side sheet, header, scrolling body),
   * badges from the shared `batshit-settings-status-badge` family.
   */

  type DmRow = {
    id: string
    kind: DmKind
    priority: DmPriority
    status: DmStatus
    from: DmSender
    to: string
    subject: string
    createdAt: string
    expiresAt: string
    completedAt: string | null
    /**
     * The stored shape, not a copy of it. This was a hand-written duplicate until SA-114 P4
     * added `steer` to the record and left the drawer's copy behind — the one place in
     * Batshit that could not render a delivery mode it was being handed.
     */
    delivery: DmDeliveryRecord
    senderSessionId: string | null
    claimedSessionId: string | null
    relatedDmId: string | null
    resultDmId: string | null
    callbackStatus: string | null
    hasResult: boolean
    runningSessionId: string | null
  }

  type AgentRow = {
    id: string
    name: string
    dms_enabled: boolean
    state: 'idle' | 'running' | 'waiting_approval'
    running_session_id: string | null
  }

  let {
    open = $bindable(false),
    currentAgentId = null
  } = $props<{ open?: boolean; currentAgentId?: string | null }>()

  type TabKey = 'inbox' | 'sent' | 'done'

  let loading = $state(false)
  let error = $state<string | null>(null)
  let rows = $state<DmRow[]>([])
  let agents = $state<AgentRow[]>([])
  let tab = $state<TabKey>('inbox')
  /** `''` means every agent. Defaults to the chat's own agent, per DL-113-10a. */
  let agentFilter = $state<string>('')
  let expandedId = $state<string | null>(null)
  let detail = $state<DmRecord | null>(null)
  let detailLoading = $state(false)
  let busyId = $state<string | null>(null)

  const agentNameById = $derived.by(() => {
    const map = new Map<string, string>()
    for (const agent of agents) map.set(agent.id, agent.name)
    return map
  })

  function senderLabel(from: DmSender): string {
    // PR #106 review F-13: keyed by kind, so a schedule is a schedule and a fourth kind is a
    // compile error rather than a silent "(webhook)".
    return dmSenderLabel(from)
  }

  function agentName(id: string): string {
    return agentNameById.get(id) ?? id
  }

  const visibleRows = $derived.by(() => {
    const wanted = agentFilter.trim()
    return rows.filter((row) => {
      if (tab === 'inbox') {
        if (row.status !== 'new' && row.status !== 'working') return false
        return wanted ? row.to === wanted : true
      }
      if (tab === 'sent') {
        if (row.from.kind !== 'agent') return false
        return wanted ? row.from.agentId === wanted : true
      }
      // Done: everything terminal, addressed to or sent by the filtered agent.
      if (row.status === 'new' || row.status === 'working') return false
      if (!wanted) return true
      return row.to === wanted || (row.from.kind === 'agent' && row.from.agentId === wanted)
    })
  })

  async function load() {
    loading = true
    error = null
    try {
      const response = await fetch('/api/dms')
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || `Request failed with ${response.status}`)
      }
      rows = Array.isArray(payload.dms) ? payload.dms : []
      agents = Array.isArray(payload.agents) ? payload.agents : []
      // The drawer just paid for the whole list; the badge should agree with what the user
      // is looking at rather than wait for the next live event.
      hydrateDmInboxCounts(rows, agents.map((agent) => agent.id))
    } catch (loadError) {
      error = loadError instanceof Error ? loadError.message : 'Could not load Agent DMs.'
      rows = []
    } finally {
      loading = false
    }
  }

  async function toggleRow(row: DmRow) {
    if (expandedId === row.id) {
      expandedId = null
      detail = null
      return
    }
    expandedId = row.id
    detail = null
    detailLoading = true
    try {
      const response = await fetch(`/api/dms/${encodeURIComponent(row.id)}`)
      const payload = await response.json()
      if (response.ok && payload?.success) detail = payload.dm as DmRecord
    } catch {
      detail = null
    } finally {
      detailLoading = false
    }
  }

  async function act(row: DmRow, action: 'done' | 'reopen') {
    busyId = row.id
    try {
      const response = await fetch(`/api/dms/${encodeURIComponent(row.id)}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action })
      })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        error = payload?.error || 'That did not work.'
        return
      }
      await load()
      if (expandedId === row.id) detail = payload.dm as DmRecord
    } finally {
      busyId = null
    }
  }

  async function remove(row: DmRow) {
    busyId = row.id
    try {
      const response = await fetch(`/api/dms/${encodeURIComponent(row.id)}`, { method: 'DELETE' })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        error = payload?.error || 'That DM could not be deleted.'
        return
      }
      if (expandedId === row.id) {
        expandedId = null
        detail = null
      }
      await load()
    } finally {
      busyId = null
    }
  }

  /** The same route the chat's Stop uses, so a woken turn ends the one documented way. */
  async function stopRun(row: DmRow) {
    if (!row.runningSessionId) return
    busyId = row.id
    try {
      await fetch('/api/messages/interrupt', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sessionId: row.runningSessionId })
      })
      await load()
    } finally {
      busyId = null
    }
  }

  function openSession(sessionId: string | null | undefined) {
    if (!sessionId) return
    sessionStore.setCurrentSessionId(sessionId)
    open = false
  }

  function formatWhen(value: string | null | undefined): string {
    if (!value) return '—'
    const date = new Date(value)
    if (Number.isNaN(date.getTime())) return '—'
    return date.toLocaleString(undefined, {
      month: 'short',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit'
    })
  }

  function expiresIn(value: string): string {
    const at = Date.parse(value)
    if (!Number.isFinite(at)) return ''
    const days = Math.ceil((at - Date.now()) / 86_400_000)
    if (days <= 0) return 'expired'
    return days === 1 ? 'expires in 1 day' : `expires in ${days} days`
  }

  /**
   * F-SEC-1b: a third presence state. `waiting_approval` is not "busy" — it is the agent
   * stopped on something only the user can clear, which is the one state worth walking over
   * to. Same three words `sys.dm.agents` reports, so the drawer and the agents agree.
   */
  const PRESENCE_CLASS: Record<AgentRow['state'], string> = {
    idle: 'is-idle',
    running: 'is-running',
    waiting_approval: 'is-waiting'
  }
  const PRESENCE_TITLE: Record<AgentRow['state'], string> = {
    idle: 'Idle',
    running: 'Mid-task right now',
    waiting_approval: 'Waiting on you before it can go on'
  }
  const PRESENCE_LABEL: Record<AgentRow['state'], string> = {
    idle: 'idle',
    running: 'working',
    waiting_approval: 'needs you'
  }

  const STATUS_TONE: Record<DmStatus, string> = {
    new: 'is-info',
    working: 'is-accent',
    done: 'is-success',
    blocked: 'is-danger',
    expired: 'is-warning'
  }

  // The drawer is the one surface that should always be showing the truth, so it reloads
  // on the same event the header badge listens to rather than on a timer.
  $effect(() => {
    if (!open) return
    agentFilter = typeof currentAgentId === 'string' ? currentAgentId : ''
    void load()
    const stop = onUserChannelEvent((event) => {
      if (event.type === 'dm_inbox_changed' || event.type === 'session_run_status') void load()
    })
    return stop
  })
</script>

<Sheet.Root bind:open>
  <Sheet.Content side="right" class="dm-drawer-sheet">
    <Sheet.Header class="dm-drawer-header">
      <Sheet.Title class="dm-drawer-title">Agent DMs</Sheet.Title>
      <Sheet.Description class="dm-drawer-subtitle">
        Every note, assignment, and result your agents sent each other, plus what each
        wake-up actually did.
      </Sheet.Description>
    </Sheet.Header>

    <div class="dm-drawer-controls">
      <div class="dm-drawer-tabs" role="tablist" aria-label="Agent DM views">
        {#each [['inbox', 'Inbox'], ['sent', 'Sent'], ['done', 'Done']] as [key, label] (key)}
          <button
            type="button"
            role="tab"
            class="dm-drawer-tab"
            aria-selected={tab === key}
            onclick={() => (tab = key as TabKey)}
          >
            {label}
          </button>
        {/each}
      </div>

      <div class="dm-drawer-filter">
        <label class="dm-drawer-filter-label" for="dm-drawer-agent">Agent</label>
        <select id="dm-drawer-agent" class="dm-drawer-select" bind:value={agentFilter}>
          <option value="">All agents</option>
          {#each agents as agent (agent.id)}
            <option value={agent.id}>{agent.name}</option>
          {/each}
        </select>
        {#if agentFilter}
          {@const selected = agents.find((agent) => agent.id === agentFilter)}
          {#if selected}
            <span
              class={`dm-drawer-presence ${PRESENCE_CLASS[selected.state]}`}
              title={PRESENCE_TITLE[selected.state]}
            ></span>
            <span class="dm-drawer-presence-label">
              {PRESENCE_LABEL[selected.state]}
            </span>
          {/if}
        {/if}
        <Button
          variant="ghost"
          size="icon"
          aria-label="Refresh Agent DMs"
          title="Refresh"
          disabled={loading}
          onclick={() => load()}
        >
          <RefreshCcw class={`dm-drawer-refresh-icon ${loading ? 'is-spinning' : ''}`} />
        </Button>
      </div>
    </div>

    <div class="dm-drawer-body">
      {#if error}
        <p class="batshit-settings-form-meta is-error">{error}</p>
      {/if}

      {#if loading && rows.length === 0}
        <p class="dm-drawer-empty">Loading Agent DMs…</p>
      {:else if visibleRows.length === 0}
        <p class="dm-drawer-empty">
          {#if tab === 'inbox'}
            Nothing waiting. Open items appear here the moment one agent writes to another.
          {:else if tab === 'sent'}
            This agent has not sent a DM yet.
          {:else}
            Nothing closed yet.
          {/if}
        </p>
      {:else}
        <ul class="dm-drawer-list">
          {#each visibleRows as row (row.id)}
            {@const SenderIcon = dmSenderIcon(row.from)}
            <li class="dm-drawer-row">
              <button
                type="button"
                class="dm-drawer-row-head"
                aria-expanded={expandedId === row.id}
                aria-label={`${row.kind} from ${senderLabel(row.from)} to ${agentName(row.to)}: ${row.subject}`}
                onclick={() => toggleRow(row)}
              >
                <span class="dm-drawer-row-line">
                  <SenderIcon class="dm-drawer-row-icon" />
                  <span class="dm-drawer-row-subject">{row.subject}</span>
                  {#if row.runningSessionId}
                    <span class="dm-drawer-live">running</span>
                  {/if}
                </span>
                <span class="dm-drawer-row-meta">
                  <span class="batshit-settings-status-badge">{row.kind}</span>
                  {#if row.priority === 'urgent'}
                    <span class="batshit-settings-status-badge is-danger">urgent</span>
                  {/if}
                  <span class={`batshit-settings-status-badge ${STATUS_TONE[row.status]}`}>
                    {row.status}
                  </span>
                  <span class="dm-drawer-row-people">
                    {senderLabel(row.from)} → {agentName(row.to)}
                  </span>
                  <span class="dm-drawer-row-time">{formatWhen(row.createdAt)}</span>
                </span>
              </button>

              <div class="dm-drawer-row-delivery">
                {#if row.delivery.needsUser}
                  <span
                    class="batshit-settings-status-badge is-warning"
                    title={row.delivery.needsUser.reason}
                  >
                    Needs you
                  </span>
                {/if}
                {#if row.delivery.actual === 'wake' && row.delivery.requested !== 'wait'}
                  <span class="batshit-settings-status-badge is-success">woke a chat</span>
                {:else if row.delivery.actual === 'steer'}
                  <span class="batshit-settings-status-badge is-success">landed mid-reply</span>
                {:else if row.delivery.requested !== 'wait'}
                  <span class="batshit-settings-status-badge is-warning">
                    {row.delivery.requested === 'steer' ? 'could not steer' : 'waited'}:
                    {row.delivery.reason ?? 'no reason recorded'}
                  </span>
                {:else}
                  <span class="batshit-settings-status-badge">waiting in inbox</span>
                {/if}
                {#if row.status === 'new' || row.status === 'working'}
                  <span class="dm-drawer-row-time">{expiresIn(row.expiresAt)}</span>
                {/if}
                {#if row.delivery.sessionId}
                  <button
                    type="button"
                    class="dm-drawer-link"
                    onclick={() => openSession(row.delivery.sessionId)}
                  >
                    {row.delivery.actual === 'steer'
                      ? 'Open the chat it landed in'
                      : 'Open the chat it started'}
                  </button>
                {/if}
                {#if row.senderSessionId}
                  <button
                    type="button"
                    class="dm-drawer-link"
                    onclick={() => openSession(row.senderSessionId)}
                  >
                    Open the sender's chat
                  </button>
                {/if}
              </div>

              {#if expandedId === row.id}
                <div class="dm-drawer-detail">
                  {#if detailLoading}
                    <p class="dm-drawer-empty">Loading…</p>
                  {:else if detail}
                    <p class="dm-drawer-body-text">{detail.body}</p>
                    {#if detail.requestedOutcome}
                      <p class="dm-drawer-field">
                        <span>Requested outcome</span>{detail.requestedOutcome}
                      </p>
                    {/if}
                    {#if detail.scope}
                      <p class="dm-drawer-field"><span>Scope</span>{detail.scope}</p>
                    {/if}
                    {#if detail.reportBackTo}
                      <p class="dm-drawer-field">
                        <span>Report back to</span>{agentName(detail.reportBackTo)}
                      </p>
                    {/if}
                    {#if detail.result}
                      <p class="dm-drawer-field"><span>Result</span>{detail.result}</p>
                    {/if}
                    {#if detail.callbackStatus}
                      <p class="dm-drawer-field">
                        <span>Callback</span>{detail.callbackStatus}
                      </p>
                    {/if}
                    <p class="dm-drawer-field">
                      <span>DM id</span><code>{detail.id}</code>
                    </p>
                  {:else}
                    <p class="dm-drawer-empty">That DM could not be loaded.</p>
                  {/if}

                  <div class="dm-drawer-actions">
                    {#if row.runningSessionId}
                      <Button
                        variant="outline"
                        size="sm"
                        disabled={busyId === row.id}
                        onclick={() => stopRun(row)}
                      >
                        <CircleStop class="dm-drawer-action-icon" />
                        Stop
                      </Button>
                    {/if}
                    {#if row.status === 'new' || row.status === 'working'}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === row.id}
                        title="Closes this for you only. The sender is not told, and the agent can no longer close it itself."
                        onclick={() => act(row, 'done')}
                      >
                        Mark done
                      </Button>
                    {:else}
                      <Button
                        variant="secondary"
                        size="sm"
                        disabled={busyId === row.id}
                        title="Puts this back in the agent's inbox as new. Closing it again sends a fresh result."
                        onclick={() => act(row, 'reopen')}
                      >
                        Reopen
                      </Button>
                    {/if}
                    <Button
                      variant="ghost"
                      size="sm"
                      class="dm-drawer-delete"
                      disabled={busyId === row.id}
                      onclick={() => remove(row)}
                    >
                      <Trash2 class="dm-drawer-action-icon" />
                      Delete
                    </Button>
                  </div>
                </div>
              {/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  </Sheet.Content>
</Sheet.Root>

<style>
  :global(.dm-drawer-sheet) {
    display: flex;
    width: 100%;
    max-width: min(42rem, 100vw);
    flex-direction: column;
  }

  :global(.dm-drawer-header) {
    border-bottom: 1px solid var(--border);
    padding: 16px 24px;
  }

  :global(.dm-drawer-title) {
    font-size: 1.25rem;
    line-height: 1.35;
  }

  :global(.dm-drawer-subtitle) {
    color: var(--muted-foreground);
    font-size: 0.8125rem;
    line-height: 1.45;
  }

  .dm-drawer-controls {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    border-bottom: 1px solid var(--border);
    padding: 12px 24px;
  }

  .dm-drawer-tabs {
    display: flex;
    gap: 4px;
  }

  .dm-drawer-tab {
    border: 1px solid transparent;
    border-radius: 8px;
    background: transparent;
    padding: 5px 12px;
    color: var(--muted-foreground);
    font-size: 0.8125rem;
    font-weight: 500;
  }

  .dm-drawer-tab[aria-selected='true'] {
    border-color: var(--border);
    background: color-mix(in oklab, var(--primary) 18%, transparent);
    color: var(--foreground);
  }

  .dm-drawer-filter {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  .dm-drawer-filter-label {
    color: var(--muted-foreground);
    font-size: 0.75rem;
    font-weight: 500;
  }

  .dm-drawer-select {
    max-width: 12rem;
    border: 1px dashed var(--border);
    border-radius: 8px;
    background: color-mix(in oklab, var(--muted) 55%, transparent);
    padding: 4px 8px;
    color: var(--foreground);
    font-size: 0.8125rem;
  }

  .dm-drawer-presence {
    width: 7px;
    height: 7px;
    border-radius: 999px;
  }

  .dm-drawer-presence.is-idle {
    background: var(--bs-settings-line, var(--border));
  }

  .dm-drawer-presence.is-running {
    background: var(--bs-app-success-text, oklch(0.72 0.115 185));
  }

  /* F-SEC-1b — same warning colour as the header envelope's "needs you" badge. */
  .dm-drawer-presence.is-waiting {
    background: var(--bs-settings-warning, oklch(0.666 0.179 58.318));
  }

  .dm-drawer-presence-label {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }

  :global(.dm-drawer-refresh-icon) {
    width: 14px;
    height: 14px;
  }

  :global(.dm-drawer-refresh-icon.is-spinning) {
    animation: dm-drawer-spin 700ms linear infinite;
  }

  .dm-drawer-body {
    flex: 1 1 0;
    overflow-y: auto;
    padding: 16px 24px 24px;
  }

  .dm-drawer-empty {
    margin: 0;
    color: var(--muted-foreground);
    font-size: 0.8125rem;
    line-height: 1.5;
  }

  .dm-drawer-list {
    display: flex;
    flex-direction: column;
    margin: 0;
    padding: 0;
    gap: 10px;
    list-style: none;
  }

  .dm-drawer-row {
    border: 1px solid var(--border);
    border-radius: 8px;
    background: color-mix(in oklab, var(--muted) 40%, transparent);
    padding: 10px 12px;
  }

  .dm-drawer-row-head {
    display: flex;
    width: 100%;
    flex-direction: column;
    gap: 6px;
    border: 0;
    background: transparent;
    padding: 0;
    text-align: left;
  }

  .dm-drawer-row-line {
    display: flex;
    align-items: center;
    gap: 8px;
    min-width: 0;
  }

  :global(.dm-drawer-row-icon) {
    width: 14px;
    height: 14px;
    flex: 0 0 auto;
    color: var(--muted-foreground);
  }

  .dm-drawer-row-subject {
    overflow: hidden;
    color: var(--foreground);
    font-size: 0.875rem;
    font-weight: 500;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  .dm-drawer-live {
    border: 1px solid var(--bs-app-success-line, var(--border));
    border-radius: 999px;
    background: var(--bs-app-success-bg, transparent);
    padding: 0 6px;
    color: var(--bs-app-success-text, var(--foreground));
    font-size: 0.6875rem;
    line-height: 1.15rem;
  }

  .dm-drawer-row-meta,
  .dm-drawer-row-delivery {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 6px;
  }

  .dm-drawer-row-delivery {
    margin-top: 8px;
  }

  .dm-drawer-row-people,
  .dm-drawer-row-time {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }

  .dm-drawer-link {
    border: 0;
    background: transparent;
    padding: 0;
    color: var(--muted-foreground);
    font-size: 0.6875rem;
    text-decoration: underline;
  }

  .dm-drawer-link:hover {
    color: var(--foreground);
  }

  .dm-drawer-detail {
    margin-top: 10px;
    border-top: 1px solid var(--border);
    padding-top: 10px;
  }

  .dm-drawer-body-text {
    margin: 0 0 8px;
    color: var(--foreground);
    font-size: 0.8125rem;
    line-height: 1.5;
    white-space: pre-wrap;
  }

  .dm-drawer-field {
    display: flex;
    gap: 6px;
    margin: 0 0 4px;
    color: var(--foreground);
    font-size: 0.75rem;
    line-height: 1.45;
  }

  .dm-drawer-field span {
    flex: 0 0 auto;
    color: var(--muted-foreground);
    font-weight: 500;
  }

  .dm-drawer-actions {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin-top: 10px;
  }

  :global(.dm-drawer-action-icon) {
    width: 14px;
    height: 14px;
  }

  :global(.dm-drawer-delete) {
    color: var(--bs-settings-danger, var(--destructive));
  }

  @keyframes dm-drawer-spin {
    to {
      transform: rotate(360deg);
    }
  }
</style>
