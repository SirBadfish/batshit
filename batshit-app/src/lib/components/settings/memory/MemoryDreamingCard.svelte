<script lang="ts">
  import { untrack } from 'svelte'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import { MoonStar, RefreshCw } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'

  /**
   * SA-104 P7 — the visible dreaming log + manual "Dream now" trigger (DL-104-02 /
   * DL-104-15; p7 packet doc §1.9). Dreaming is between-conversation maintenance:
   * consolidation, supersession repair, expiry demotion, overnight episode
   * graduation. Every run's actions carry a WHY — this card is the inspectability
   * surface. The log stays readable for a memory-disabled agent; only dreaming NOW
   * requires enablement.
   */

  interface Props {
    agentId: string
    memoryEnabled: boolean
  }

  let { agentId, memoryEnabled }: Props = $props()

  let runs = $state<Array<Record<string, any>>>([])
  let loading = $state(false)
  let dreaming = $state(false)
  let listError = $state<string | null>(null)
  let expandedRunId = $state<string | null>(null)
  let expandedActions = $state<Array<Record<string, any>>>([])
  let expandedLoading = $state(false)

  async function refreshRuns() {
    if (!agentId) return
    loading = true
    listError = null
    try {
      const response = await fetch(
        `/api/memory/manage/dreams?agentId=${encodeURIComponent(agentId)}`
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      runs = payload?.runs ?? []
      if (payload?.dreaming) dreaming = true
    } catch (error) {
      listError = error instanceof Error ? error.message : 'Failed to load the dreaming log.'
      runs = []
    } finally {
      loading = false
    }
  }

  async function dreamNow() {
    if (!agentId || dreaming) return
    dreaming = true
    try {
      const response = await fetch('/api/memory/dream', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ agentId })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok) {
        throw new Error(payload?.error || `Dreaming failed (HTTP ${response.status}).`)
      }
      const counts = payload?.run?.counts
      if (payload?.run?.status === 'completed_with_errors') {
        toast.warning(
          `Dream finished with ${counts?.failures ?? 'some'} failed action(s) — open the run log for details.`
        )
      } else {
        toast.success('Dream complete.')
      }
      expandedRunId = null
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Dreaming failed.')
    } finally {
      dreaming = false
      await refreshRuns()
    }
  }

  async function toggleRun(runId: string) {
    if (expandedRunId === runId) {
      expandedRunId = null
      expandedActions = []
      return
    }
    expandedRunId = runId
    expandedLoading = true
    expandedActions = []
    try {
      const response = await fetch(
        `/api/memory/manage/dreams?agentId=${encodeURIComponent(agentId)}&runId=${encodeURIComponent(runId)}`
      )
      const payload = await response.json().catch(() => null)
      if (!response.ok) throw new Error(payload?.error || `HTTP ${response.status}`)
      expandedActions = payload?.run?.actions ?? []
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to load the run log.')
      expandedRunId = null
    } finally {
      expandedLoading = false
    }
  }

  function formatWhen(value: unknown): string {
    if (!value) return ''
    const parsed = new Date(String(value))
    return Number.isFinite(parsed.getTime())
      ? parsed.toLocaleString('en-US', {
          month: 'short',
          day: 'numeric',
          hour: 'numeric',
          minute: '2-digit'
        })
      : ''
  }

  function countsLine(counts: Record<string, any> | undefined): string {
    if (!counts) return ''
    const parts: string[] = []
    if (counts.episodesClosed) parts.push(`${counts.episodesClosed} episode(s) closed`)
    if (counts.episodesGraduated) parts.push(`${counts.episodesGraduated} graduated`)
    if (counts.regularSessionsGraduated) parts.push(`${counts.regularSessionsGraduated} session tail(s)`)
    if (counts.consolidationMerges) parts.push(`${counts.consolidationMerges} merge(s)`)
    if (counts.consolidationReviews) parts.push(`${counts.consolidationReviews} kept separate`)
    if (counts.supersessionRepairs) parts.push(`${counts.supersessionRepairs} repair(s)`)
    if (counts.expiriesDemoted) parts.push(`${counts.expiriesDemoted} expiry demotion(s)`)
    if (counts.eraConsolidations) parts.push(`${counts.eraConsolidations} era merge(s)`)
    if (counts.reembedded) parts.push(`${counts.reembedded} re-embedded`)
    if (counts.failures) parts.push(`${counts.failures} failed`)
    return parts.length > 0 ? parts.join(' · ') : 'nothing needed maintenance'
  }

  function statusLabel(status: string): string {
    if (status === 'completed_with_errors') return 'errors'
    return status
  }

  // Reload the log when the selected agent changes (guarded against load loops).
  let lastLoadedAgentId = $state<string | null>(null)
  $effect(() => {
    const id = agentId
    if (!id || id === untrack(() => lastLoadedAgentId)) return
    lastLoadedAgentId = id
    expandedRunId = null
    expandedActions = []
    void refreshRuns()
  })
</script>

<SettingsAccordionCard name="memory-dreaming" title="Dreaming" icon={MoonStar}>
  {#snippet info()}
    <SettingsInfoMenu ariaLabel="About Dreaming" contentClass="w-96">
      <p>
        Between conversations the agent's memory dreams: near-duplicate memories merge
        (with full history kept), supersession chains get repaired, expired entries
        demote instead of vanishing, and finished episodes graduate overnight. It runs
        on its own after the agent has been idle past its idle gap; Dream Now runs a
        pass immediately. Every action is logged here with its reason — nothing is
        reorganized invisibly.
      </p>
    </SettingsInfoMenu>
  {/snippet}

  <div class="batshit-settings-form-stack">
    <div class="batshit-settings-action-row">
      <Button size="sm" onclick={dreamNow} disabled={!memoryEnabled || dreaming}>
        {dreaming ? 'Dreaming...' : 'Dream Now'}
      </Button>
      <Button
        variant="ghost"
        size="icon"
        onclick={() => refreshRuns()}
        disabled={loading}
        title="Refresh the dreaming log"
        aria-label="Refresh the dreaming log"
      >
        <RefreshCw class={loading ? 'animate-spin' : ''} />
      </Button>
      {#if !memoryEnabled}
        <span class="batshit-settings-form-meta">
          Memory is off for this agent — its log stays readable, but new dreams need
          memory enabled.
        </span>
      {/if}
    </div>

    {#if listError}
      <p class="memory-dream-note batshit-settings-form-help batshit-settings-warning-text">{listError}</p>
    {:else if runs.length === 0 && !loading}
      <p class="memory-dream-note batshit-settings-form-meta">
        No dreams yet. The first one runs after this agent's next idle gap, or press
        Dream Now.
      </p>
    {:else}
      <div class="memory-dream-list" data-testid="memory-dream-list">
        {#each runs as run (run.id)}
          <div class="memory-dream-run">
            <button
              type="button"
              class="memory-dream-row"
              onclick={() => toggleRun(run.id)}
              data-testid={`memory-dream-run-${run.id}`}
            >
              <span class="memory-dream-row-head">
                <Badge variant="outline" class="batshit-settings-spine-badge">
                  {statusLabel(run.status)}
                </Badge>
                <span class="batshit-settings-form-meta">
                  {formatWhen(run.started_at)} · {run.trigger}
                </span>
              </span>
              <span class="memory-dream-row-counts">{countsLine(run.counts)}</span>
            </button>
            {#if expandedRunId === run.id}
              {#if expandedLoading}
                <p class="batshit-settings-form-meta">Loading actions...</p>
              {:else if expandedActions.length === 0}
                <p class="batshit-settings-form-meta">This run recorded no actions.</p>
              {:else}
                <ul class="memory-dream-actions">
                  {#each expandedActions as action, index (index)}
                    <li class="memory-dream-action">
                      <span class="memory-dream-action-head">
                        <Badge variant="outline" class="batshit-settings-spine-badge">
                          {action.kind?.replaceAll('_', ' ')}
                        </Badge>
                        {#if action.status !== 'done'}
                          <Badge variant="outline" class="batshit-settings-spine-badge">
                            {action.status}
                          </Badge>
                        {/if}
                      </span>
                      <span class="memory-dream-action-why">{action.why}</span>
                      {#if action.error}
                        <span class="batshit-settings-warning-text memory-dream-action-error">
                          {action.error}
                        </span>
                      {/if}
                    </li>
                  {/each}
                </ul>
              {/if}
            {/if}
          </div>
        {/each}
      </div>
    {/if}
  </div>
</SettingsAccordionCard>

<style>
  .memory-dream-note {
    padding: 0.55rem 0.78rem 0.68rem;
  }

  .memory-dream-list {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .memory-dream-run {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }

  .memory-dream-row {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 0.25rem;
    width: 100%;
    padding: 0.5rem 0.625rem;
    border: 1px solid var(--border);
    border-radius: var(--radius);
    background: transparent;
    text-align: left;
    cursor: pointer;
  }

  .memory-dream-row:hover {
    background: var(--accent);
  }

  .memory-dream-row-head {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }

  .memory-dream-row-counts {
    font-size: 0.8125rem;
    color: var(--muted-foreground);
  }

  .memory-dream-actions {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    margin: 0 0 0.25rem;
    padding: 0 0 0 0.625rem;
    list-style: none;
  }

  .memory-dream-action {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    padding: 0.375rem 0.5rem;
    border-left: 2px solid var(--border);
  }

  .memory-dream-action-head {
    display: flex;
    align-items: center;
    gap: 0.375rem;
  }

  .memory-dream-action-why {
    font-size: 0.8125rem;
    color: var(--foreground);
  }

  .memory-dream-action-error {
    font-size: 0.8125rem;
  }
</style>
