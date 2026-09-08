<script lang="ts">
  import { Input } from '$lib/components/ui/input'
  import * as Label from '$lib/components/ui/label'
  import * as Select from '$lib/components/ui/select'
  import * as Switch from '$lib/components/ui/switch'
  import SettingsInfoMenu from '$lib/components/settings/SettingsInfoMenu.svelte'
  import {
    DEFAULT_WAKE_TIMEOUT_MINUTES,
    MAX_WAKE_TIMEOUT_MINUTES,
    MIN_WAKE_TIMEOUT_MINUTES,
    validateWakeTimeoutMinutes,
    type DmSenderScope,
    type WakeTarget
  } from '$lib/utils/dmControl'

  /**
   * SA-113 (DL-113-01, DL-113-15) — the Agent DMs card.
   *
   * Two independent spine toggles, on purpose. **Agent DMs** is the feature and defaults
   * OFF, because DMs create sessions and spend tokens outside the user's view. **May Be
   * Woken** is separate and defaults ON, because it is inert until a sender or a wake-up
   * webhook exists — and a webhook can wake an agent that never sends or receives a DM.
   */
  interface SenderCandidate {
    id: string
    name: string
    dmsEnabled: boolean
  }

  interface Props {
    dmsEnabled: boolean
    dmSenderScope: DmSenderScope
    dmSenderAgentIds: string[]
    /** Every OTHER primary agent on this instance, for the "only these" list. */
    senderCandidates: SenderCandidate[]
    wakeEnabled: boolean
    wakeTimeoutMinutes: number | null
    wakeTarget: WakeTarget
    disabled?: boolean
    onDmsEnabledChange: (enabled: boolean) => void
    onDmSenderScopeChange: (scope: DmSenderScope) => void
    onDmSenderAgentIdsChange: (agentIds: string[]) => void
    onWakeEnabledChange: (enabled: boolean) => void
    onWakeTimeoutMinutesChange: (minutes: number | null) => void
    onWakeTargetChange: (target: WakeTarget) => void
  }

  let {
    dmsEnabled,
    dmSenderScope,
    dmSenderAgentIds,
    senderCandidates,
    wakeEnabled,
    wakeTimeoutMinutes,
    wakeTarget,
    disabled = false,
    onDmsEnabledChange,
    onDmSenderScopeChange,
    onDmSenderAgentIdsChange,
    onWakeEnabledChange,
    onWakeTimeoutMinutesChange,
    onWakeTargetChange
  }: Props = $props()

  const senderScopeLabel = $derived(
    dmSenderScope === 'selected' ? 'Only chosen agents' : 'Any agent'
  )

  function toggleSender(agentId: string) {
    const next = dmSenderAgentIds.includes(agentId)
      ? dmSenderAgentIds.filter((id) => id !== agentId)
      : [...dmSenderAgentIds, agentId]
    onDmSenderAgentIdsChange(next)
  }

  // LS-037 shape: blank means the code default, a nonblank invalid value fails loudly
  // rather than being quietly clamped, so a typo cannot silently shorten a woken turn.
  //
  // The field holds its own draft text only while it is invalid: an invalid value must
  // stay on screen for the user to fix, but it is never sent. Once it validates, the
  // stored value is the single source of truth again, so switching agents shows the new
  // agent's setting instead of the last one typed.
  let timeoutDraft = $state<string | null>(null)
  let timeoutError = $state<string | null>(null)

  const timeoutText = $derived(
    timeoutDraft ??
      (wakeTimeoutMinutes === null || wakeTimeoutMinutes === undefined
        ? ''
        : String(wakeTimeoutMinutes))
  )

  function handleTimeoutInput(raw: string) {
    const validation = validateWakeTimeoutMinutes(raw)
    if (!validation.ok) {
      timeoutDraft = raw
      timeoutError = validation.error
      return
    }
    timeoutDraft = null
    timeoutError = null
    onWakeTimeoutMinutesChange(validation.minutes)
  }

  const workingStyleLabel = $derived(
    wakeTarget === 'current-session' ? 'One at a time' : 'Parallel'
  )
</script>

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">Agent DMs</span>
    <SettingsInfoMenu ariaLabel="About Agent DMs" contentClass="w-80">
      <p>
        Lets this agent send and receive messages with your other agents: a note, a piece of work
        with a report back, or the answer to one.
      </p>
      <p>
        Off by default. An agent with DMs off has no inbox, no DM tools, and no DM instructions in
        its prompt, so turning this on for nobody costs nothing.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={dmsEnabled}
    disabled={disabled}
    onCheckedChange={(checked) => onDmsEnabledChange(checked === true)}
    data-testid="agent-dms-enabled-toggle"
  />
</div>

{#if dmsEnabled}
  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Who May DM This Agent</Label.Root>
        <SettingsInfoMenu ariaLabel="About who may DM this agent" contentClass="w-80">
          <p>
            <strong>Any agent</strong>: every agent with DMs turned on can write to this one.
          </p>
          <p>
            <strong>Only chosen agents</strong>: just the ones you pick below. Picking nobody means
            nobody — this agent can still send DMs, but will not receive any.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <Select.Root
        type="single"
        value={dmSenderScope}
        disabled={disabled}
        onValueChange={(value) =>
          onDmSenderScopeChange(
            ((Array.isArray(value) ? value[0] : value) ?? 'all') as DmSenderScope
          )}
      >
        <Select.Trigger data-testid="agent-dm-senders-select">
          {senderScopeLabel}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="all">Any agent</Select.Item>
          <Select.Item value="selected">Only chosen agents</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  {#if dmSenderScope === 'selected'}
    {#if senderCandidates.length === 0}
      <p class="batshit-settings-form-help" data-testid="agent-dm-senders-empty">
        No other agents have Agent DMs turned on yet, so nobody can write to this one.
      </p>
    {:else}
      {#each senderCandidates as candidate (candidate.id)}
        <div class="batshit-settings-toggle-row is-child">
          <div class="batshit-settings-form-label-line">
            <span class="batshit-settings-child-label">{candidate.name}</span>
            {#if !candidate.dmsEnabled}
              <span class="batshit-settings-pill">DMs off</span>
            {/if}
          </div>
          <Switch.Root
            checked={dmSenderAgentIds.includes(candidate.id)}
            disabled={disabled}
            onCheckedChange={() => toggleSender(candidate.id)}
            data-testid={`agent-dm-sender-${candidate.id}`}
          />
        </div>
      {/each}
    {/if}
  {/if}
{/if}

<div class="batshit-settings-toggle-row is-spine-toggle">
  <div class="batshit-settings-form-label-line">
    <span class="batshit-settings-parent-label">May Be Woken</span>
    <SettingsInfoMenu ariaLabel="About May Be Woken" contentClass="w-80">
      <p>
        Lets Batshit start a chat for this agent when nobody is typing: another agent sent it a
        message and asked for the work to start now, or a wake-up webhook fired.
      </p>
      <p>
        Nothing can wake this agent until you have set up a sender or a webhook, so leaving this
        on changes nothing on its own. Turn it off and every wake-up waits in the agent's inbox
        instead, with the reason recorded.
      </p>
    </SettingsInfoMenu>
  </div>
  <Switch.Root
    checked={wakeEnabled}
    disabled={disabled}
    onCheckedChange={(checked) => onWakeEnabledChange(checked === true)}
    data-testid="agent-wake-enabled-toggle"
  />
</div>

{#if wakeEnabled}
  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Working Style</Label.Root>
        <SettingsInfoMenu ariaLabel="About Working Style" contentClass="w-80">
          <p>
            <strong>Parallel</strong>: this agent can be woken into a new chat while it is already
            working somewhere else.
          </p>
          <p>
            <strong>One at a time</strong>: this agent finishes what it is doing, and wake-ups land
            in its current chat. Two copies of it never run at once. If it is mid-task, the message
            waits in its inbox and shows up on the next turn.
          </p>
        </SettingsInfoMenu>
      </div>
    </div>
    <div class="batshit-settings-form-control">
      <Select.Root
        type="single"
        value={wakeTarget}
        disabled={disabled}
        onValueChange={(value) =>
          onWakeTargetChange(
            ((Array.isArray(value) ? value[0] : value) ?? 'new-session') as WakeTarget
          )}
      >
        <Select.Trigger data-testid="agent-wake-target-select">
          {workingStyleLabel}
        </Select.Trigger>
        <Select.Content>
          <Select.Item value="new-session">Parallel</Select.Item>
          <Select.Item value="current-session">One at a time</Select.Item>
        </Select.Content>
      </Select.Root>
    </div>
  </div>

  <div class="batshit-settings-form-row is-child">
    <div class="batshit-settings-form-copy">
      <div class="batshit-settings-form-label-line">
        <Label.Root class="batshit-settings-child-label">Wake-up Time Limit</Label.Root>
        <SettingsInfoMenu ariaLabel="About the Wake-up Time Limit" contentClass="w-80">
          <p>
            How long a woken turn may run before Batshit stops it, in minutes
            ({MIN_WAKE_TIMEOUT_MINUTES}-{MAX_WAKE_TIMEOUT_MINUTES}). Leave it blank to use the
            {DEFAULT_WAKE_TIMEOUT_MINUTES}-minute default.
          </p>
          <p>
            Different agents do different sized jobs, so this one is a dial. It only applies to
            chats Batshit started; a chat you started has no time limit.
          </p>
        </SettingsInfoMenu>
      </div>
      {#if timeoutError}
        <p class="batshit-settings-form-help is-danger" data-testid="agent-wake-timeout-error">
          {timeoutError}
        </p>
      {/if}
    </div>
    <div class="batshit-settings-form-control">
      <Input
        type="number"
        min={MIN_WAKE_TIMEOUT_MINUTES}
        max={MAX_WAKE_TIMEOUT_MINUTES}
        step="1"
        placeholder={String(DEFAULT_WAKE_TIMEOUT_MINUTES)}
        value={timeoutText}
        disabled={disabled}
        data-testid="agent-wake-timeout-input"
        oninput={(event) => handleTimeoutInput((event.target as HTMLInputElement).value)}
      />
    </div>
  </div>
{/if}
