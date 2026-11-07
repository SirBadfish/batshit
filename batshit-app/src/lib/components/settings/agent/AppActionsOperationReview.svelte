<script lang="ts">
  import { onMount } from 'svelte'
  import { ShieldCheck } from '@lucide/svelte'
  import { Button } from '$lib/components/ui/button'
  import SettingsAccordionCard from '$lib/components/settings/SettingsAccordionCard.svelte'
  import MessageApprovalPanel from '$lib/components/chat/MessageApprovalPanel.svelte'
  import { settingsSubjectKey } from '$lib/appActions/settings/reportContract'
  import { formatAppActionsOutcomeReason } from '$lib/appActions/settings/outcomeReason'
  import { MODEL_PRESET_COPY_ID } from '$lib/appActions/settings/modelSelectionPreferences'
  import { MCP_CONFIGURATION_ID } from '$lib/appActions/settings/mcpConfiguration'
  import {
    APP_ACTIONS_MANAGEMENT_ROUTES, isAppActionsOperationResponse,
    type AppActionsOperationReview, type AppActionsOperationStatus
  } from '$lib/appActions/settings/managementContract'

  let { operationId }: { operationId: string } = $props()
  let operation = $state<AppActionsOperationReview | null>(null)
  let loading = $state(false)
  let submitting = $state(false)
  let error = $state('')
  let unconfirmed = $state(false)
  let alive = false
  let readSequence = 0
  const statusLabels: Record<AppActionsOperationStatus, string> = {
    awaiting_approval: 'Waiting for your decision', ready: 'Approved, waiting to run', running: 'Running',
    completed: 'Finished', denied: 'Denied', cancelled: 'Cancelled', expired: 'Expired', blocked: 'Blocked', unknown_outcome: 'Outcome unconfirmed'
  }
  const approvals = $derived(operation ? [{ approvalId: operation.operationId, status: 'pending',
    control: { controlTitle: 'App Actions Change', riskLevel: 'confirm', lane: 'portable',
      input: { operationId: operation.operationId, intentDigest: operation.intentDigest } } }] : [])
  const canDecide = $derived(Boolean(operation?.canDecide && operation.status === 'awaiting_approval' && !unconfirmed && !loading && !submitting && !error))
  function date(value: string | null) {
    if (!value) return 'None'
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(value))
  }
  function value(input: string | number | boolean | null) {
    return input === null ? 'Not set' : typeof input === 'boolean' ? input ? 'On' : 'Off' : String(input)
  }
  async function load() {
    if (submitting || !operationId) return
    const sequence = ++readSequence
    loading = true
    error = ''
    try {
      const response = await fetch(APP_ACTIONS_MANAGEMENT_ROUTES.operation(operationId), { cache: 'no-store' })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !isAppActionsOperationResponse(payload) || payload.operation.operationId !== operationId) {
        throw new Error(payload?.error || (response.status === 401 ? 'Sign in to Batshit to review this request.' : 'This operation could not be read.'))
      }
      if (!alive || sequence !== readSequence) return
      operation = payload.operation
      if (operation.status !== 'awaiting_approval') unconfirmed = false
    } catch (failure) {
      if (alive && sequence === readSequence) error = failure instanceof Error ? failure.message : 'This operation could not be read.'
    } finally {
      if (alive && sequence === readSequence) loading = false
    }
  }
  async function decide(id: string, approved: boolean) {
    if (!operation || id !== operation.operationId || !canDecide) return
    const captured = { operationId: operation.operationId, decision: approved ? 'approve' as const : 'deny' as const, intentDigest: operation.intentDigest }
    submitting = true
    error = ''
    readSequence += 1
    try {
      const response = await fetch(APP_ACTIONS_MANAGEMENT_ROUTES.decision(captured.operationId), {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision: captured.decision, intentDigest: captured.intentDigest })
      })
      const payload = await response.json().catch(() => null)
      if (!response.ok || !isAppActionsOperationResponse(payload) || payload.operation.operationId !== captured.operationId || payload.operation.intentDigest !== captured.intentDigest) {
        unconfirmed = true
        throw new Error(payload?.error || 'The decision response could not be confirmed. Check the operation outcome; no decision will be sent again automatically.')
      }
      if (alive) operation = payload.operation
    } catch (failure) {
      if (!alive) return
      unconfirmed = true
      error = failure instanceof Error ? failure.message : 'The decision outcome is unconfirmed. Check the operation outcome.'
    } finally { submitting = false }
  }
  onMount(() => { alive = true; void load(); return () => { alive = false; readSequence += 1 } })
</script>

<SettingsAccordionCard name="portable-app-action-review" title="Review App Actions Request" icon={ShieldCheck} collapsible={false} contentClass="space-y-4">
  {#if !operation}
    <p class="batshit-settings-form-meta" role={error ? 'alert' : 'status'}>{error || 'Loading the operation…'}</p>
    <Button type="button" size="sm" variant="outline" disabled={loading} onclick={load}>Check Operation</Button>
  {:else}
    <p class="batshit-settings-parent-label">{operation.actor.label}</p>
    <p class="batshit-settings-form-meta" role="status">{statusLabels[operation.status]}</p>
    <p class="batshit-settings-caption">This decision applies only to the changes below. It does not grant continuing permission.</p>
    {#if operation.preview.semanticId !== 'agent.instructions'}
    {#each operation.preview.targets as target (settingsSubjectKey(target.subject))}
      <div class="batshit-settings-form-stack">
        <div class="batshit-settings-form-label-line">
          <span class="batshit-settings-parent-label">{target.label}</span>
          <span class="batshit-settings-code-caption">{settingsSubjectKey(target.subject)}</span>
        </div>
        {#each target.changes as change (change.field)}
          <div class="batshit-settings-form-row is-child">
            <div class="batshit-settings-form-copy"><span class="batshit-settings-child-label">{change.label}</span></div>
            <div class="batshit-settings-form-control"><span>{value(change.before)} → {value(change.after)}</span></div>
          </div>
        {/each}
      </div>
    {/each}
    {#if operation.preview.excluded.length}
      <div class="batshit-settings-form-stack"><span class="batshit-settings-parent-label">Excluded Agents</span>
        {#each operation.preview.excluded as subject (settingsSubjectKey(subject))}<span class="batshit-settings-code-caption">{settingsSubjectKey(subject)}</span>{/each}
      </div>
    {/if}
    {/if}
    <div class="batshit-settings-form-stack"><span class="batshit-settings-parent-label">Effects</span>
      {#each operation.preview.effects as effect}<p class="batshit-settings-caption">{effect}</p>{/each}
    </div>
    <dl class="batshit-settings-form-stack">
      <div><dt class="batshit-settings-child-label">Review Expires</dt><dd class="batshit-settings-caption">{date(operation.reviewExpiresAt)}</dd></div>
      <div><dt class="batshit-settings-child-label">Time Limit</dt><dd class="batshit-settings-caption">{operation.executionBudgetMs / 1000} seconds</dd></div>
      {#if operation.hardDeadlineAt}<div><dt class="batshit-settings-child-label">Request Deadline</dt><dd class="batshit-settings-caption">{date(operation.hardDeadlineAt)}</dd></div>{/if}
      {#if operation.executionDeadlineAt}<div><dt class="batshit-settings-child-label">Finish By</dt><dd class="batshit-settings-caption">{date(operation.executionDeadlineAt)}</dd></div>{/if}
    </dl>
    {#if operation.reason}<p class="batshit-settings-form-meta">{operation.reason}</p>{/if}
    {#if error}<p class="batshit-settings-form-meta is-error" role="alert">{error}</p>{/if}
    {#if unconfirmed}<p class="batshit-settings-form-meta is-warning">The decision response is unconfirmed. Check the outcome before doing anything else.</p>{/if}
    {#if canDecide || submitting || operation.preview.semanticId === 'agent.instructions' || operation.preview.semanticId === 'agent.model.selection' || operation.preview.semanticId === MCP_CONFIGURATION_ID || operation.preview.semanticId === MODEL_PRESET_COPY_ID}
      <MessageApprovalPanel approvals={canDecide || submitting ? approvals : []} settingsReview={operation} approvalSubmitting={submitting} approvalError={null}
        describeApproval={() => `${operation?.actor.label} requests these App Actions changes.`}
        formatApprovalInput={input => JSON.stringify(input, null, 2)} getApprovalRemainingSeconds={() => null}
        onApprovalAction={decide} />
    {/if}
    {#each operation.outcomes as outcome (settingsSubjectKey(outcome.subject))}
      <div class="batshit-settings-form-stack">
        <span class="batshit-settings-code-caption">{settingsSubjectKey(outcome.subject)}</span>
        <p class="batshit-settings-caption">{outcome.status}{outcome.reason ? `: ${formatAppActionsOutcomeReason(outcome.reason)}` : ''}</p>
        <p class="batshit-settings-form-meta">Save: {({ saved: 'Saved', not_requested: 'Not requested', unknown: 'Unconfirmed' })[outcome.saved]}.
          Saved value checked: {({ verified: 'Yes', unavailable: 'Unavailable', changed: 'Changed', not_requested: 'Not requested' })[outcome.readback]}.
          On-screen update: {outcome.visible === 'unknown' ? 'Unconfirmed' : 'Unchanged'}.</p>
      </div>
    {/each}
    {#each operation.resourceOutcomes ?? [] as outcome (outcome.resource.gatewayId)}
      <div class="batshit-settings-form-stack">
        <span class="batshit-settings-code-caption">MCP gateway: {outcome.resource.gatewayId}</span>
        <p class="batshit-settings-caption">{outcome.status}. Gateway save: {outcome.saved}.</p>
        {#each Object.entries(outcome.stages) as [stage, state]}
          <p class="batshit-settings-form-meta">{stage}: {state}</p>
        {/each}
      </div>
    {/each}
    <Button type="button" size="sm" variant="outline" disabled={loading || submitting} onclick={load}>Check Operation Outcome</Button>
  {/if}
</SettingsAccordionCard>
