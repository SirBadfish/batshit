<script lang="ts">
  import { onMount } from 'svelte'
  import { Clock, Loader2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import * as Dialog from '$lib/components/ui/dialog'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { onUserChannelEvent } from '$lib/services/userChannel'
  import { describeAge, describeCadence, describeNextRun } from '$lib/utils/scheduleControl'
  import { hasMissedRun, type ScheduleSummary } from '$lib/types/schedule'

  /**
   * SA-115 P2 (DL-115-07) — *Missed while Batshit was off*.
   *
   * **This dialog is the only place a missed run can start.** The ticker collapses every
   * slot Batshit slept through into one entry and fires nothing, so a weekly schedule
   * missed three times shows one row saying "missed 3" and runs at most once, when a
   * person says so. That is Josh's rule: run it when Batshit is reopened, but only once,
   * and for a long absence probably not at all.
   *
   * Which is why there is **no auto-skip and no pre-selection**. The age is shown — "2
   * hours ago", "23 days ago" — and the user decides. A hidden cut-off would make that
   * decision invisibly, which is exactly the surprise this avoids.
   *
   * **Skip, never Cancel** (Josh's wording lock): Skip skips this one run and the schedule
   * stays on. "Cancel" would read as turning the schedule off, which it is not.
   *
   * It opens from two places, because a missed run must not depend on the tab being open
   * at the moment it was noticed: the live `schedule_missed` event, and a read on mount so
   * a Mac app opened the next morning shows it on the first tab.
   */

  let items = $state<ScheduleSummary[]>([])
  let open = $state(false)
  let busyId = $state<string | null>(null)

  const agentNames = $state<Record<string, string>>({})

  function agentLabel(schedule: ScheduleSummary): string {
    return agentNames[schedule.agentId] ?? schedule.agentId
  }

  /** Read every schedule and keep the ones still carrying an unanswered missed run. */
  async function refresh() {
    try {
      const response = await fetch('/api/schedules')
      const payload = await response.json()
      if (!response.ok || !payload?.success) return
      for (const agent of payload.agents ?? []) {
        if (agent?.id) agentNames[agent.id] = agent.name ?? agent.id
      }
      items = (payload.schedules ?? []).filter((schedule: ScheduleSummary) =>
        hasMissedRun(schedule)
      )
      // Closing when the list empties is what makes Run now / Skip feel finished, and it
      // means a schedule answered in another tab does not leave a stale question here.
      open = items.length > 0
    } catch {
      // A failed read is not worth a toast: nothing was missed by not asking, and the next
      // event or page load asks again.
    }
  }

  onMount(() => {
    void refresh()
    return onUserChannelEvent((event) => {
      if (event.type === 'schedule_missed') void refresh()
    })
  })

  async function act(schedule: ScheduleSummary, action: 'run-now' | 'skip-missed') {
    busyId = schedule.id
    try {
      const response = await fetch(`/api/schedules/${schedule.id}/${action}`, { method: 'POST' })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'That did not work.')
      }
      if (action === 'run-now') {
        toast.success(`"${schedule.name}" ran: ${payload.outcome ?? 'done'}`)
      }
      items = items.filter((entry) => entry.id !== schedule.id)
      if (items.length === 0) open = false
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'That did not work.')
    } finally {
      busyId = null
    }
  }
</script>

<Dialog.Root bind:open>
  <Dialog.Content class="sm:max-w-2xl" data-testid="missed-schedules-dialog">
    <Dialog.Header>
      <Dialog.Title>Missed while Batshit was off</Dialog.Title>
      <Dialog.Description>
        These runs were due while Batshit was closed. Nothing ran. Run one now, or skip it and
        leave the schedule on for its next time.
      </Dialog.Description>
    </Dialog.Header>

    <div class="batshit-settings-group">
      {#each items as schedule (schedule.id)}
        {#if schedule.missedRun}
          <div class="batshit-settings-display-card p-4">
            <div class="flex flex-col gap-3 md:flex-row md:items-start md:justify-between">
              <div class="min-w-0 space-y-2">
                <div class="flex flex-wrap items-center gap-2">
                  <Clock class="size-4 shrink-0" aria-hidden="true" />
                  <span class="batshit-settings-child-label truncate">{schedule.name}</span>
                  <Badge variant="outline">{agentLabel(schedule)}</Badge>
                  <Badge variant="outline">{describeCadence(schedule.cadence)}</Badge>
                  {#if schedule.missedRun.count > 1}
                    <Badge variant="secondary">missed {schedule.missedRun.count}</Badge>
                  {/if}
                </div>
                <p class="batshit-settings-form-meta">
                  Was due {describeNextRun(schedule.missedRun.dueAt, schedule.timeZone)} ·
                  {describeAge(schedule.missedRun.dueAt)}
                </p>
                <p class="batshit-settings-form-help">
                  Next run {describeNextRun(schedule.nextRunAt, schedule.timeZone)}
                </p>
              </div>
              <div class="flex shrink-0 items-center gap-2">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onclick={() => act(schedule, 'skip-missed')}
                  disabled={busyId === schedule.id}
                  title="Skip this one run. The schedule stays on."
                >
                  Skip
                </Button>
                <Button
                  type="button"
                  size="sm"
                  onclick={() => act(schedule, 'run-now')}
                  disabled={busyId === schedule.id}
                  title="Run it once, now"
                >
                  {#if busyId === schedule.id}
                    <Loader2 class="size-4 animate-spin" aria-hidden="true" />
                  {/if}
                  Run now
                </Button>
              </div>
            </div>
          </div>
        {/if}
      {/each}
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={() => (open = false)}>
        Decide later
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
