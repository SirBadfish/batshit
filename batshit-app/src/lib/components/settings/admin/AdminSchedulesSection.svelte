<script lang="ts">
  import { onMount } from 'svelte'
  import { Clock, Loader2, Pencil, Play, Plus, Trash2 } from '@lucide/svelte'
  import { toast } from 'svelte-sonner'
  import * as Card from '$lib/components/ui/card'
  import * as Dialog from '$lib/components/ui/dialog'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import { Badge } from '$lib/components/ui/badge'
  import { Button } from '$lib/components/ui/button'
  import { Input } from '$lib/components/ui/input'
  import { Textarea } from '$lib/components/ui/textarea'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    LATE_FIRE_GRACE_MS,
    MAX_SCHEDULES_PER_AGENT,
    MAX_SCHEDULE_INTERVAL_MINUTES,
    MIN_SCHEDULE_INTERVAL_MINUTES,
    SCHEDULE_NAME_MAX_CHARS,
    WEEKDAY_LABELS,
    describeCadence,
    describeNextRun,
    listSelectableTimeZones
  } from '$lib/utils/scheduleControl'
  import { getLocalTimeZone } from '@internationalized/date'
  import type {
    ScheduleCadence,
    ScheduleDeliveryMode,
    ScheduleKind,
    ScheduleSummary
  } from '$lib/types/schedule'

  /**
   * SA-115 P2 (DL-115-01, DL-115-09, DL-115-14) — the "Schedules" list inside the Agent
   * Wake-ups card.
   *
   * It lives here, beside Wake-up webhooks, because this card is the one place for
   * everything that starts a chat with nobody typing — and because the master switch above
   * turns a schedule's wake into a wait exactly as it does a webhook's.
   *
   * Structure copied from `AdminWakeHooksSection.svelte`, including `refreshOnOpen`: this
   * mounts with the whole Admin panel, but the eligible-agent list depends on `dms_enabled`,
   * which is edited in Agent Settings.
   */

  interface EligibleAgent {
    id: string
    name: string
  }

  interface Props {
    disabled: boolean
    /** Lets the missed-run dialog and this card refresh each other after a Run now/Skip. */
    onSchedulesChanged?: () => void
  }

  let { disabled, onSchedulesChanged }: Props = $props()

  let schedules = $state<ScheduleSummary[]>([])
  let agents = $state<EligibleAgent[]>([])
  let loading = $state(true)
  let loadError = $state<string | null>(null)
  let busyScheduleId = $state<string | null>(null)

  /**
   * SA-118 P4 (DL-118-13) — ONE form, two modes.
   *
   * SA-115's acceptance criteria promised "create, pause, edit, run now, and delete" and
   * the shipped card had four of the five: `PATCH /api/schedules/{id}` and `patchSchedule`
   * have always accepted every field below, and nothing in the UI called them with more
   * than `enabled`. A promised behaviour that did not ship is a fix, not new scope.
   *
   * Edit reuses this form rather than copying it, so the two modes cannot drift into two
   * different ideas of what a schedule is. What edit mode changes is small and deliberate:
   * the title, the submit button, a read-only Agent row, and where Save sends its body.
   */
  let formOpen = $state(false)
  let formMode = $state<'create' | 'edit'>('create')
  /** The schedule being edited, or `null` in create mode. */
  let editingScheduleId = $state<string | null>(null)
  let saving = $state(false)
  let formError = $state<string | null>(null)
  let formName = $state('')
  let formAgentId = $state('')
  let formMessage = $state('')
  let formKind = $state<ScheduleKind>('info')
  let formDeliver = $state<ScheduleDeliveryMode>('wake')
  let formCadenceType = $state<ScheduleCadence['type']>('daily')
  let formEveryMinutes = $state(30)
  let formAt = $state('09:00')
  let formDays = $state<number[]>([2])
  let formTimeZone = $state('UTC')

  const agentById = $derived(new Map(agents.map((agent) => [agent.id, agent])))
  const timeZones = listSelectableTimeZones()
  const lateFireGraceMinutes = Math.round(LATE_FIRE_GRACE_MS / 60_000)

  /** The cadence the create form currently describes, or null while it is unusable. */
  const draftCadence = $derived.by<ScheduleCadence | null>(() => {
    if (formCadenceType === 'interval') {
      return Number.isInteger(formEveryMinutes) ? { type: 'interval', everyMinutes: formEveryMinutes } : null
    }
    if (formCadenceType === 'daily') return { type: 'daily', at: formAt }
    if (formDays.length === 0) return null
    return { type: 'weekly', days: [...formDays].sort((a, b) => a - b), at: formAt }
  })

  const canSubmit = $derived(
    Boolean(formName.trim()) && Boolean(formAgentId) && Boolean(formMessage.trim()) && draftCadence !== null
  )

  function formatDate(value: string | null | undefined): string {
    if (!value) return 'never'
    const parsed = Date.parse(value)
    return Number.isFinite(parsed) ? new Date(parsed).toLocaleString() : 'never'
  }

  function describeDelivery(schedule: ScheduleSummary): string {
    return schedule.deliver === 'wake' ? 'Starts a chat' : 'Waits in the inbox'
  }

  function toggleDay(day: number) {
    formDays = formDays.includes(day) ? formDays.filter((entry) => entry !== day) : [...formDays, day]
  }

  async function load() {
    loading = true
    loadError = null
    try {
      const response = await fetch('/api/schedules')
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not load schedules.')
      }
      schedules = payload.schedules ?? []
      agents = payload.agents ?? []
      if (!formAgentId) formAgentId = agents[0]?.id ?? ''
    } catch (error) {
      loadError = error instanceof Error ? error.message : 'Could not load schedules.'
    } finally {
      loading = false
    }
  }

  $effect(() => {
    void load()
  })

  /**
   * F-P2-2 — the zone default is set ONCE, here, and never from an effect.
   *
   * The browser is the only honest source of the user's zone: the Mac app's server clock is
   * theirs, but a Docker container's is usually UTC. Doing it in an effect that also read
   * `formTimeZone` made the effect re-run on every change, which re-fetched the list on each
   * selection and — worse — flipped a deliberately chosen `UTC` straight back to the local
   * zone, so a Mac user could not pick UTC at all. `onMount` runs once, so a later choice
   * (UTC included) simply stands.
   */
  onMount(() => {
    try {
      formTimeZone = getLocalTimeZone()
    } catch {
      formTimeZone = 'UTC'
    }
  })

  /** Re-read whenever the user opens the card — `dms_enabled` is edited in another tab. */
  function refreshOnOpen(node: HTMLElement) {
    const details = node.closest('details')
    if (!details) return
    const onToggle = () => {
      if (details.open) void load()
    }
    details.addEventListener('toggle', onToggle)
    return { destroy: () => details.removeEventListener('toggle', onToggle) }
  }

  /**
   * The in-progress create form, parked while an edit borrows the fields (DL-118-13).
   *
   * One form means one set of variables, so opening Edit necessarily overwrites whatever
   * the user had half-typed into New Schedule. It also puts the edited schedule's zone,
   * cadence, kind and agent into the create form's memory, which the card has always kept
   * between creates on purpose. F-P2-2 is the recorded lesson there: a zone the user chose
   * deliberately must not be replaced behind their back. So the create fields are snapped
   * on the way into edit mode and put back on the way out.
   */
  type CreateDraft = {
    name: string
    agentId: string
    message: string
    kind: ScheduleKind
    deliver: ScheduleDeliveryMode
    cadenceType: ScheduleCadence['type']
    everyMinutes: number
    at: string
    days: number[]
    timeZone: string
  }
  let parkedCreateDraft: CreateDraft | null = null

  function snapshotForm(): CreateDraft {
    return {
      name: formName,
      agentId: formAgentId,
      message: formMessage,
      kind: formKind,
      deliver: formDeliver,
      cadenceType: formCadenceType,
      everyMinutes: formEveryMinutes,
      at: formAt,
      days: [...formDays],
      timeZone: formTimeZone
    }
  }

  function applyToForm(draft: CreateDraft) {
    formName = draft.name
    formAgentId = draft.agentId
    formMessage = draft.message
    formKind = draft.kind
    formDeliver = draft.deliver
    formCadenceType = draft.cadenceType
    formEveryMinutes = draft.everyMinutes
    formAt = draft.at
    formDays = [...draft.days]
    formTimeZone = draft.timeZone
  }

  function openCreate() {
    if (parkedCreateDraft) {
      applyToForm(parkedCreateDraft)
      parkedCreateDraft = null
    }
    formMode = 'create'
    editingScheduleId = null
    formError = null
    formOpen = true
  }

  /** Fill the form from a row, in the same shapes `draftCadence` builds (DL-118-13). */
  function openEdit(schedule: ScheduleSummary) {
    if (formMode === 'create' && !parkedCreateDraft) parkedCreateDraft = snapshotForm()
    formMode = 'edit'
    editingScheduleId = schedule.id
    formError = null
    formName = schedule.name
    formAgentId = schedule.agentId
    formMessage = schedule.message
    formKind = schedule.kind
    formDeliver = schedule.deliver
    formCadenceType = schedule.cadence.type
    if (schedule.cadence.type === 'interval') {
      formEveryMinutes = schedule.cadence.everyMinutes
    } else {
      formAt = schedule.cadence.at
      // A daily schedule has no days of its own; the ones already in the form stay, so
      // switching How Often to weekly offers a sensible starting set rather than none.
      if (schedule.cadence.type === 'weekly') formDays = [...schedule.cadence.days]
    }
    formTimeZone = schedule.timeZone
    formOpen = true
  }

  function closeForm() {
    formOpen = false
    if (formMode === 'edit' && parkedCreateDraft) {
      applyToForm(parkedCreateDraft)
      parkedCreateDraft = null
    }
    formMode = 'create'
    editingScheduleId = null
    formError = null
  }

  function submitForm() {
    if (formMode === 'edit') return saveEdit()
    return createSchedule()
  }

  /**
   * Save an edit (DL-118-13).
   *
   * The body carries exactly the fields this form owns. **Never `enabled`** — that belongs
   * to the row's pause switch, and sending it here would let a stale form value flip a
   * schedule the user paused in another tab. **Never `agentId`** — the store has no agent
   * patch by design, and the form says so.
   *
   * A refusal keeps the dialog open with the route's own sentence, the way the create path
   * does: the user's typing is still in front of them and is the thing they have to change.
   */
  async function saveEdit() {
    if (!canSubmit || !draftCadence || !editingScheduleId) return
    const scheduleId = editingScheduleId
    saving = true
    formError = null
    try {
      const response = await fetch(`/api/schedules/${scheduleId}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          cadence: draftCadence,
          timeZone: formTimeZone,
          message: formMessage.trim(),
          kind: formKind,
          deliver: formDeliver
        })
      })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(
          [payload?.error, payload?.hint].filter(Boolean).join(' ') || 'Could not update the schedule.'
        )
      }
      // The route answers with the recomputed record, so the row's next run moves here with
      // no reload (LS-046) — that is the whole point of `patchSchedule` recomputing it.
      schedules = schedules.map((entry) => (entry.id === scheduleId ? payload.schedule : entry))
      closeForm()
      toast.success('Schedule updated')
      onSchedulesChanged?.()
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Could not update the schedule.'
    } finally {
      saving = false
    }
  }

  async function createSchedule() {
    if (!canSubmit || !draftCadence) return
    saving = true
    formError = null
    try {
      const response = await fetch('/api/schedules', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: formName.trim(),
          agentId: formAgentId,
          cadence: draftCadence,
          timeZone: formTimeZone,
          message: formMessage.trim(),
          kind: formKind,
          deliver: formDeliver
        })
      })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        // A cap or a validation refusal carries its own reason and its own hint. Both are
        // shown verbatim rather than replaced with friendlier wording that hides the rule.
        throw new Error([payload?.error, payload?.hint].filter(Boolean).join(' ') || 'Could not create the schedule.')
      }
      schedules = [payload.schedule, ...schedules]
      formOpen = false
      parkedCreateDraft = null
      formName = ''
      formMessage = ''
      onSchedulesChanged?.()
    } catch (error) {
      formError = error instanceof Error ? error.message : 'Could not create the schedule.'
    } finally {
      saving = false
    }
  }

  async function patchSchedule(schedule: ScheduleSummary, patch: Record<string, unknown>) {
    busyScheduleId = schedule.id
    try {
      const response = await fetch(`/api/schedules/${schedule.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(patch)
      })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not update the schedule.')
      }
      schedules = schedules.map((entry) => (entry.id === schedule.id ? payload.schedule : entry))
      onSchedulesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not update the schedule.')
    } finally {
      busyScheduleId = null
    }
  }

  async function runNow(schedule: ScheduleSummary) {
    busyScheduleId = schedule.id
    try {
      const response = await fetch(`/api/schedules/${schedule.id}/run-now`, { method: 'POST' })
      const payload = await response.json()
      if (payload?.schedule) {
        schedules = schedules.map((entry) => (entry.id === schedule.id ? payload.schedule : entry))
      }
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'The schedule could not run.')
      }
      toast.success(`"${schedule.name}" ran: ${payload.outcome}`)
      // PR #106 review F-16: the run fired but Batshit could not write it down, so this
      // row's "last run" is about to be wrong. That is a real thing to tell the user —
      // not an error, because the run itself happened.
      if (payload?.recorded === false && typeof payload?.warning === 'string') {
        toast.warning(payload.warning)
      }
      onSchedulesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'The schedule could not run.')
    } finally {
      busyScheduleId = null
    }
  }

  async function deleteSchedule(schedule: ScheduleSummary) {
    if (!confirm(`Delete "${schedule.name}"? It stops running and its history goes with it.`)) {
      return
    }
    busyScheduleId = schedule.id
    try {
      const response = await fetch(`/api/schedules/${schedule.id}`, { method: 'DELETE' })
      const payload = await response.json()
      if (!response.ok || !payload?.success) {
        throw new Error(payload?.error || 'Could not delete the schedule.')
      }
      schedules = schedules.filter((entry) => entry.id !== schedule.id)
      onSchedulesChanged?.()
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Could not delete the schedule.')
    } finally {
      busyScheduleId = null
    }
  }
</script>

<div class="batshit-settings-subsection" use:refreshOnOpen>
  <div class="batshit-settings-action-row">
    <div class="batshit-settings-form-label-line">
      <span class="batshit-settings-parent-label">Schedules</span>
      <SettingsInfoMenu ariaLabel="About Schedules" contentClass="w-80">
        <p>
          A schedule is Batshit's own clock: pick an agent, a time, and a message, and Batshit
          sends it at that time. No n8n needed. Use n8n when the trigger lives outside Batshit,
          like Slack, email, or a finished build.
        </p>
        <p>
          Three shapes: every so many minutes or hours, every day at a time, or on chosen weekdays
          at a time. A time of day is always in the time zone you pick, and it keeps that
          wall-clock time when the clocks change.
        </p>
        <p>
          If Batshit was off when a run was due, it never runs by itself. It waits, and you are
          asked once whether to run it or skip it. A run late by under {lateFireGraceMinutes} minutes
          just runs, and the message says it is late.
        </p>
        <p>
          Up to {MAX_SCHEDULES_PER_AGENT} schedules per agent, no faster than every {MIN_SCHEDULE_INTERVAL_MINUTES}
          minutes. The master switch above turns every schedule's wake into a wait.
        </p>
      </SettingsInfoMenu>
    </div>
    <Button
      type="button"
      variant="outline"
      size="sm"
      onclick={openCreate}
      disabled={disabled || loading || agents.length === 0}
    >
      <Plus class="size-4" aria-hidden="true" />
      New Schedule
    </Button>
  </div>

  {#if loading}
    <p class="batshit-settings-form-meta">
      <Loader2 class="size-4 animate-spin" aria-hidden="true" />
      Loading schedules...
    </p>
  {:else if loadError}
    <p class="batshit-settings-form-meta is-error">{loadError}</p>
  {:else if agents.length === 0}
    <p class="batshit-settings-form-help">
      No agent has Agent DMs turned on yet. A schedule writes a DM to one agent, so turn on Agent
      DMs for that agent in Agent Settings first.
    </p>
  {:else if schedules.length === 0}
    <p class="batshit-settings-form-help">
      No schedules yet. Create one to have an agent wake up at a set time, like every day at 9am.
    </p>
  {:else}
    <div class="batshit-settings-group">
      {#each schedules as schedule (schedule.id)}
        {@const agent = agentById.get(schedule.agentId)}
        <Card.Root class="batshit-settings-display-card">
          <Card.Content class="flex flex-col gap-3 p-4 md:flex-row md:items-start md:justify-between">
            <div class="min-w-0 space-y-2">
              <div class="flex flex-wrap items-center gap-2">
                <Clock class="size-4 shrink-0" aria-hidden="true" />
                <span class="batshit-settings-child-label truncate">{schedule.name}</span>
                <Badge variant="outline">{agent?.name ?? schedule.agentId}</Badge>
                <Badge variant="outline">{describeCadence(schedule.cadence)}</Badge>
                <Badge variant="outline">{describeDelivery(schedule)}</Badge>
                {#if schedule.kind === 'assignment'}
                  <Badge variant="outline">Assignment</Badge>
                {/if}
                {#if !schedule.enabled}
                  <Badge variant="secondary">Paused</Badge>
                {/if}
                {#if typeof schedule.createdBy === 'object'}
                  <Badge variant="secondary">Created by the agent</Badge>
                {/if}
              </div>
              <p class="batshit-settings-form-meta">
                {#if schedule.enabled}
                  Next run {describeNextRun(schedule.nextRunAt, schedule.timeZone)}
                {:else}
                  Paused, so nothing is scheduled
                {/if}
                · {schedule.timeZone}
              </p>
              <p class="batshit-settings-form-help">
                Last run {formatDate(schedule.lastRunAt)}{schedule.lastOutcome
                  ? ` · ${schedule.lastOutcome}`
                  : ''} · {schedule.runCount} run{schedule.runCount === 1 ? '' : 's'}
              </p>
            </div>
            <div class="flex shrink-0 items-center gap-2">
              <Switch.Root
                checked={schedule.enabled}
                onCheckedChange={(checked) => patchSchedule(schedule, { enabled: checked === true })}
                disabled={disabled || busyScheduleId === schedule.id}
                aria-label={schedule.enabled ? 'Pause this schedule' : 'Resume this schedule'}
              />
              <Button
                type="button"
                variant="outline"
                size="sm"
                onclick={() => openEdit(schedule)}
                disabled={disabled || busyScheduleId === schedule.id}
                title="Change this schedule's name, time, message, or what it does"
              >
                <Pencil class="size-4" aria-hidden="true" />
                Edit
              </Button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                onclick={() => runNow(schedule)}
                disabled={disabled || busyScheduleId === schedule.id}
                title="Run this schedule once, now — even if it is paused. Its normal times do not change."
              >
                {#if busyScheduleId === schedule.id}
                  <Loader2 class="size-4 animate-spin" aria-hidden="true" />
                {:else}
                  <Play class="size-4" aria-hidden="true" />
                {/if}
                Run now
              </Button>
              <Button
                type="button"
                variant="destructive"
                size="sm"
                onclick={() => deleteSchedule(schedule)}
                disabled={disabled || busyScheduleId === schedule.id}
                title="Delete this schedule"
              >
                <Trash2 class="size-4" aria-hidden="true" />
                Delete
              </Button>
            </div>
          </Card.Content>
        </Card.Root>
      {/each}
    </div>
  {/if}
</div>

<Dialog.Root
  bind:open={formOpen}
  onOpenChange={(next) => {
    // Closing by the X, Escape, or a click outside is a Cancel: no request, and the parked
    // create draft comes back.
    if (!next) closeForm()
  }}
>
  <Dialog.Content class="sm:max-w-lg">
    <Dialog.Header>
      <Dialog.Title>{formMode === 'edit' ? 'Edit Schedule' : 'New Schedule'}</Dialog.Title>
      <Dialog.Description>
        {#if formMode === 'edit'}
          Changes take effect on the very next run. Pausing is the switch on the row.
        {:else}
          A time and a message for one agent. Batshit sends it at that time.
        {/if}
      </Dialog.Description>
    </Dialog.Header>

    <div class="batshit-settings-form-stack">
      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="schedule-name">Name</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Input
            id="schedule-name"
            bind:value={formName}
            placeholder="Morning check"
            maxlength={SCHEDULE_NAME_MAX_CHARS}
          />
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          {#if formMode === 'edit'}
            <span class="batshit-settings-form-label">Agent</span>
          {:else}
            <Label.Root class="batshit-settings-form-label" for="schedule-agent">Agent</Label.Root>
          {/if}
        </div>
        <div class="batshit-settings-form-control">
          {#if formMode === 'edit'}
            <p class="batshit-settings-form-meta">{agentById.get(formAgentId)?.name ?? formAgentId}</p>
            <p class="batshit-settings-form-help">
              To move a schedule to another agent, create a new one.
            </p>
          {:else}
          <Select.Root type="single" value={formAgentId} onValueChange={(v) => (formAgentId = v ?? '')}>
            <Select.Trigger id="schedule-agent" class="w-full">
              <span class="truncate">{agentById.get(formAgentId)?.name ?? 'Choose an agent'}</span>
            </Select.Trigger>
            <Select.Content>
              {#each agents as agent (agent.id)}
                <Select.Item value={agent.id}>{agent.name}</Select.Item>
              {/each}
            </Select.Content>
          </Select.Root>
          {/if}
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="schedule-cadence">How Often</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={formCadenceType}
            onValueChange={(v) =>
              (formCadenceType = v === 'interval' || v === 'weekly' ? v : 'daily')}
          >
            <Select.Trigger id="schedule-cadence" class="w-full">
              <span class="truncate">
                {formCadenceType === 'interval'
                  ? 'Every so often'
                  : formCadenceType === 'weekly'
                    ? 'On chosen weekdays'
                    : 'Every day'}
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="interval">Every so often</Select.Item>
              <Select.Item value="daily">Every day</Select.Item>
              <Select.Item value="weekly">On chosen weekdays</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      {#if formCadenceType === 'interval'}
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <Label.Root class="batshit-settings-form-label" for="schedule-minutes">Minutes</Label.Root>
          </div>
          <div class="batshit-settings-form-control">
            <Input
              id="schedule-minutes"
              type="number"
              min={MIN_SCHEDULE_INTERVAL_MINUTES}
              max={MAX_SCHEDULE_INTERVAL_MINUTES}
              step={1}
              value={formEveryMinutes}
              oninput={(event) =>
                (formEveryMinutes = Number((event.currentTarget as HTMLInputElement).value))}
            />
          </div>
        </div>
      {:else}
        {#if formCadenceType === 'weekly'}
          <div class="batshit-settings-form-row">
            <div class="batshit-settings-form-copy">
              <span class="batshit-settings-form-label">Days</span>
            </div>
            <div class="batshit-settings-form-control">
              <div class="flex flex-wrap gap-1">
                {#each WEEKDAY_LABELS as label, day (label)}
                  <Button
                    type="button"
                    variant={formDays.includes(day) ? 'default' : 'outline'}
                    size="xs"
                    onclick={() => toggleDay(day)}
                    aria-pressed={formDays.includes(day)}
                  >
                    {label}
                  </Button>
                {/each}
              </div>
            </div>
          </div>
        {/if}
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <Label.Root class="batshit-settings-form-label" for="schedule-at">Time</Label.Root>
          </div>
          <div class="batshit-settings-form-control">
            <Input id="schedule-at" type="time" bind:value={formAt} />
          </div>
        </div>
        <div class="batshit-settings-form-row">
          <div class="batshit-settings-form-copy">
            <div class="batshit-settings-form-label-line">
              <Label.Root class="batshit-settings-form-label" for="schedule-zone">Time Zone</Label.Root>
              <SettingsInfoMenu ariaLabel="About the time zone">
                <p>
                  The time above is read in this zone, and it stays at that wall-clock time when the
                  clocks change: 9am stays 9am.
                </p>
                <p>"Every so often" ignores this. Every 30 minutes is 30 minutes everywhere.</p>
              </SettingsInfoMenu>
            </div>
          </div>
          <div class="batshit-settings-form-control">
            <Select.Root
              type="single"
              value={formTimeZone}
              onValueChange={(v) => (formTimeZone = v ?? 'UTC')}
            >
              <Select.Trigger id="schedule-zone" class="w-full">
                <span class="truncate">{formTimeZone}</span>
              </Select.Trigger>
              <Select.Content class="max-h-72">
                {#each timeZones as zone (zone)}
                  <Select.Item value={zone}>{zone}</Select.Item>
                {/each}
              </Select.Content>
            </Select.Root>
          </div>
        </div>
      {/if}

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="schedule-message">Message</Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Textarea
            id="schedule-message"
            bind:value={formMessage}
            rows={3}
            placeholder="Check my open DMs and tell me what needs me."
          />
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <div class="batshit-settings-form-label-line">
            <Label.Root class="batshit-settings-form-label" for="schedule-kind">Kind</Label.Root>
            <SettingsInfoMenu ariaLabel="About the schedule kind">
              <p>A note is something to read. The agent reads it and gets on with it.</p>
              <p>
                An assignment is work whose outcome you want recorded. The agent claims it, does it,
                and closes it with a result you can read in the DM drawer.
              </p>
            </SettingsInfoMenu>
          </div>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={formKind}
            onValueChange={(v) => (formKind = v === 'assignment' ? 'assignment' : 'info')}
          >
            <Select.Trigger id="schedule-kind" class="w-full">
              <span class="truncate">{formKind === 'assignment' ? 'An assignment' : 'A note'}</span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="info">A note</Select.Item>
              <Select.Item value="assignment">An assignment</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      <div class="batshit-settings-form-row">
        <div class="batshit-settings-form-copy">
          <Label.Root class="batshit-settings-form-label" for="schedule-deliver">
            What It Does
          </Label.Root>
        </div>
        <div class="batshit-settings-form-control">
          <Select.Root
            type="single"
            value={formDeliver}
            onValueChange={(v) => (formDeliver = v === 'wait' ? 'wait' : 'wake')}
          >
            <Select.Trigger id="schedule-deliver" class="w-full">
              <span class="truncate">
                {formDeliver === 'wake' ? 'Start a chat now' : 'Leave it in the inbox'}
              </span>
            </Select.Trigger>
            <Select.Content>
              <Select.Item value="wake">Start a chat now</Select.Item>
              <Select.Item value="wait">Leave it in the inbox</Select.Item>
            </Select.Content>
          </Select.Root>
        </div>
      </div>

      {#if formError}
        <p class="batshit-settings-form-meta is-error">{formError}</p>
      {/if}
    </div>

    <Dialog.Footer>
      <Button type="button" variant="outline" onclick={closeForm}>Cancel</Button>
      <Button type="button" onclick={submitForm} disabled={saving || !canSubmit}>
        {#if saving}
          <Loader2 class="size-4 animate-spin" aria-hidden="true" />
        {/if}
        {formMode === 'edit' ? 'Save changes' : 'Create'}
      </Button>
    </Dialog.Footer>
  </Dialog.Content>
</Dialog.Root>
