<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { formatToolDisplayName } from '$lib/utils/toolNameFormatter'
  import {
    describeApprovalExpiry,
    formatControlApprovalRiskWord,
    formatControlApprovalTitle
  } from '$lib/utils/controlApprovalPresentation'
  import { getDmBrief, requestDmBrief } from '$lib/stores/dmBriefs.svelte'
  import { wakeOriginText } from '$lib/utils/jevJuice'
  import {
    APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID, isAppActionsApprovalPreviewForControl
  } from '$lib/appActions/settings/managementContract'
  import { formatAppActionsOutcomeReason } from '$lib/appActions/settings/outcomeReason'
  import { isInstructionsReview, type InstructionsReview, type InstructionTextFact, type InstructionInclusionFact } from '$lib/appActions/settings/instructionReview'
  import type { AppActionsOperationPreview, AppActionsOperationReview } from '$lib/appActions/settings/managementContract'
  import { MODEL_PRESET_COPY_ID, modelSelectionFactText, type ModelSelectionReview, type ModelPresetCopyReview, type PresetParameterFact } from '$lib/appActions/settings/modelSelectionPreferences'
  import { MCP_CONFIGURATION_ID, type McpConfigurationReview } from '$lib/appActions/settings/mcpConfiguration'

  interface Props {
    approvals: any[]
    approvalSubmitting: boolean
    approvalError: string | null
    describeApproval: (approval: any) => string
    formatApprovalInput: (input: any) => string
    getApprovalRemainingSeconds: (approval: any) => number | null
    isRetiredApproval?: (approval: any) => boolean
    onApprovalAction: (approvalId: string, approved: boolean) => void | Promise<void>
    /** SA-120 P7: the DM whose wake started this turn, when a DM, a webhook, or a schedule did. */
    wakeDmId?: string | null
    /** Authenticated portable review uses the same fixed text presentation as native Ask. */
    settingsReview?: AppActionsOperationReview | null
  }

  /**
   * SA-116 (DL-116-06) — the Fabric presentation.
   *
   * A risky Fabric control, artifact control, or user-authored CLI tool carries a server
   * written `control` block. Everything here reads from it: the title, the risk word, the
   * exact input behind a disclosure (F-P2-2: `control.input`, the payload the hash covers;
   * the shortened `inputSummary` only when a lane cannot carry it, labelled as a summary).
   * A Bash approval has no `control` block and renders
   * exactly as it did before. The wording lives in `controlApprovalPresentation.ts` so it
   * can be pinned against a payload captured from a live run.
   */

  let {
    approvals,
    approvalSubmitting,
    approvalError,
    describeApproval,
    formatApprovalInput,
    getApprovalRemainingSeconds,
    isRetiredApproval = () => false,
    onApprovalAction,
    wakeDmId = null,
    settingsReview = null
  }: Props = $props()

  /**
   * SA-120 P7 (Josh's review, 2026-09-17) — the origin line.
   *
   * A chat that a DM, a wake-up webhook, or a schedule started is driven by text the user did
   * not write, and this card is the moment the user decides whether to let it act. So every
   * approval card of such a turn says so at the top, flagged or not: "This turn was started by
   * a wake-up message from webhook "Nightly build", not by you." Without it the card reads
   * like any ordinary "the agent wants a tool" card.
   *
   * The line comes from Batshit's own record of who wrote the DM (the brief), read HERE in the
   * browser; Jev has no part in it. A Jev flag on that message is a SEPARATE notice card
   * above this one (`JevJuiceFlagNotice.svelte`), never a line on this card, because a flag
   * on the approval card made Approve feel like approving the flag. The server's risk gate
   * never sees any of this (DL-120-12): both buttons work exactly as before.
   */
  $effect(() => {
    requestDmBrief(wakeDmId)
  })
  const wakeOrigin = $derived(wakeDmId ? wakeOriginText(getDmBrief(wakeDmId)?.from) : null)
  function previewTime(value: string) {
    return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'long' }).format(new Date(value))
  }
  function subjectKind(kind: string) {
    return ({ primary: 'Primary Agent', subagent: 'Subagent', group: 'Group', worker: 'Worker' } as Record<string, string>)[kind] ?? kind
  }
  function instructionsFor(preview: AppActionsOperationPreview): InstructionsReview | null {
    const value = (preview as AppActionsOperationPreview & { instructions?: unknown }).instructions
    return preview.semanticId === 'agent.instructions' && isInstructionsReview(value, preview.targets) ? value : null
  }
  function textFact(fact: InstructionTextFact, review: InstructionsReview) {
    return fact.state === 'set' ? `Text ${review.texts.findIndex(row => row.id === fact.textId) + 1}`
      : fact.state === 'absent' ? 'No stored prompt' : fact.state === 'null' ? 'Explicit null (no custom prompt)' : 'Delete stored prompt'
  }
  function inclusionFact(fact: InstructionInclusionFact) {
    return fact.state === 'set' ? fact.value ? 'On' : 'Off' : fact.state === 'null' ? 'Explicit null' : 'Not stored'
  }
  function inclusionValue(value: boolean | 'unknown') { return value === 'unknown' ? 'Unknown' : value ? 'On' : 'Off' }
  const portableInstructions = $derived(settingsReview ? instructionsFor(settingsReview.preview) : null)
  const portableCopy = $derived(settingsReview?.preview.semanticId === MODEL_PRESET_COPY_ID ? settingsReview.preview.presetCopy : null)
  function parameterFact(fact: PresetParameterFact) { return fact.state === 'set' ? JSON.stringify(fact.value) : fact.state === 'null' ? 'Explicit null (provider default)' : 'Not set (provider default)' }
  const portableMcp = $derived(settingsReview?.preview.semanticId === MCP_CONFIGURATION_ID ? settingsReview.preview.resource : null)
  const nativeFactLabels: Record<string, string> = { claudeModel: 'Stored Claude Model', claudeLegacyModel: 'Legacy Claude Model' }
  function nativeAfter(review: ModelSelectionReview, name: string) {
    const fact = Object.entries(review.native?.after ?? {}).find(([key]) => key === name)?.[1]
    return fact ? modelSelectionFactText(fact) : 'Unavailable'
  }
  // SA-139 R3: one Primary concept, never an API/CLI type. SA-139 R4 removed the Claude Code CLI
  // lane: `cli-primary` is kept only so a saved review of a leftover Primary still reads. SA-139
  // R5 removed the CLI Subagent type: `cli-subagent` is kept only so a saved review still reads.
  // SA-139 R6 (D16): one Subagent kind, so a live Subagent target is just "Subagent".
  const selectionRoles: Record<string, string> = { 'api-primary': 'Primary Agent', 'api-subagent': 'Subagent', 'cli-primary': 'Primary Agent, removed Claude Code CLI lane', 'cli-subagent': 'Subagent, removed CLI Subagent type' }
</script>

{#snippet modelSelectionTable(review: ModelSelectionReview)}
  <div data-testid="approval-model-selection-review">
    <p class="message-approval-request">{review.intent === 'clear' ? 'Clear Saved Model Selection' : 'Select Saved Model'} ({selectionRoles[review.role]})</p>
    <pre class="message-approval-input">Before: {modelSelectionFactText(review.presetBefore)}
After: {modelSelectionFactText(review.presetAfter)}</pre>
    <p class="message-approval-copy">Legacy model: {modelSelectionFactText(review.legacyModel)}. Preserved.</p>
    {#if review.native}
      {#each Object.entries(review.native.before) as [name, fact]}
        <p class="message-approval-copy">{nativeFactLabels[name]}: {modelSelectionFactText(fact)} → {nativeAfter(review, name)}.</p>
      {/each}
      <p class="message-approval-copy">Clear does not change stored model, Fast, reasoning or permission controls, promote a native block, or stage a profile. No next-run program or model is promised.</p>
    {/if}
    <p class="message-approval-copy">{review.inheritance === 'parent-model-and-connection-at-run'
      ? 'With no own or legacy model, this Subagent uses the parent model and connection supplied at run time.'
      : review.inheritance === 'legacy-model-requires-selection' ? 'The retained legacy model prevents parent inheritance and needs a saved selection before running.'
      : review.intent === 'clear' ? 'No replacement model, connection or runtime is promised.' : 'This configures the selected preset. Actual execution and readiness were not checked.'}</p>
    {#if review.voice}
      <p class="message-approval-tool">Next Connect: LiveKit Speech-to-speech</p>
      <p class="message-approval-copy">Provider: {review.voice.providerId}. Adapter: {review.voice.adapterId}. Support: Supported. Voice-mode settings: {review.voice.locksVoiceModeSettings ? 'Locked by this preset' : 'Not locked by this preset'}.</p>
      <p class="message-approval-copy">Primary Agent configuration only. Speech-to-speech is excluded for Subagents, Workers and Groups. No room start, stop, reconnect or readiness check.</p>
    {/if}
    <p class="message-approval-copy">Global Voice settings, the agent's Voice profile and any active room remain unchanged.</p>
  </div>
{/snippet}

{#snippet presetCopyTable(review: ModelPresetCopyReview)}
  <div data-testid="approval-preset-copy-review">
    <p class="message-approval-request">Create saved model: {review.copyName}</p>
    <p class="message-approval-copy">Original preset: {review.sourcePresetId}. Original unchanged.</p>
    <p class="message-approval-copy">New preset: {review.copyPresetId}</p>
    {#each review.parameters as parameter (parameter.name)}
      <p class="message-approval-tool">{parameter.label}</p>
      <pre class="message-approval-input">Before: {parameterFact(parameter.before)}
After: {parameterFact(parameter.after)}</pre>
    {/each}
    <p class="message-approval-copy">The named copy remains saved if assignment is partial or blocked. Unknown creation stops assignment and will not be repeated automatically.</p>
  </div>
{/snippet}

{#snippet mcpTable(review: McpConfigurationReview)}
  <div data-testid="approval-mcp-review">
    {#if review.variant === 'prerequisite'}
      <p class="message-approval-request">{review.mode === 'remove' ? 'Remove MCP source selection' : 'Configure MCP source and Primary selection'}</p>
      <p class="message-approval-copy">Gateway {review.resource.gatewayId}. {review.sourceAction === 'save' ? 'Save this exact source, then verify it.' : review.sourceAction === 'unchanged' ? 'Keep this exact saved source, then verify it.' : 'Do not contact or configure the source.'}</p>
      {#if review.before || review.after}
        <p class="message-approval-tool">Complete source configuration before and after</p>
        <pre class="message-approval-input">Before: {JSON.stringify(review.before, null, 2)}
After: {JSON.stringify(review.after, null, 2)}</pre>
      {:else}
        <p class="message-approval-copy">This is a structural removal. It does not require the source to exist or be reachable.</p>
      {/if}
      <p class="message-approval-request">{review.target.label} (Primary Agent)</p>
      <p class="message-approval-copy">{review.target.subject.id}</p>
      {#each review.target.changes as change (change.field)}
        <p class="message-approval-tool">{change.label}</p>
        <pre class="message-approval-input">Before: {JSON.stringify(change.before)}
After: {JSON.stringify(change.after)}</pre>
      {/each}
      {#if review.intent.zip && review.target.effectiveZip}
        <p class="message-approval-tool">Exact tool Zip request: {review.intent.zip.toolName}</p>
        <p class="message-approval-copy">Tool Zip row: {review.target.settingsIdentity}</p>
        <pre class="message-approval-input">Requested: {JSON.stringify(review.intent.zip, null, 2)}
Effective before: {JSON.stringify(review.target.effectiveZip.before, null, 2)}
Effective after: {JSON.stringify(review.target.effectiveZip.after, null, 2)}</pre>
      {/if}
      <p class="message-approval-copy">Saved-key names are references. A required key must resolve before any write or connection; this review never reveals its value.</p>
      <p class="message-approval-copy">This decision covers only the complete source, verification and named Primary settings above. Setup consent grants no tool effect. An unavailable or unknown stage stops later work without automatic retry.</p>
    {:else}
    <p class="message-approval-request">MCP configuration: {review.after.name}</p>
    <p class="message-approval-copy">{review.mode === 'create' ? 'Create' : 'Update'} gateway {review.resource.gatewayId}</p>
    <p class="message-approval-tool">Complete configuration before and after</p>
    <pre class="message-approval-input">Before: {JSON.stringify(review.before, null, 2)}
After: {JSON.stringify(review.after, null, 2)}</pre>
    <p class="message-approval-copy">Saved-key names are references. This review does not read their values or establish that they work.</p>
    <p class="message-approval-copy">This saves the gateway record only. Installation, connection, profile setup, verification, discoverability, original-task use and Zip settings remain not started.</p>
    {/if}
  </div>
{/snippet}

{#snippet instructionsTable(review: InstructionsReview, preview: AppActionsOperationPreview)}
  <div data-testid="approval-instructions-review">
    {#each review.targets as target}
      {@const label = preview.targets.find(row => row.subject.kind === target.subject.kind && row.subject.id === target.subject.id)?.label ?? target.subject.id}
      <p class="message-approval-request">{label} ({subjectKind(target.subject.kind)})</p>
      <p class="message-approval-copy">{target.subject.id}</p>
      {#if target.customPrompt}
        <p class="message-approval-tool">Custom System Prompt</p>
        <pre class="message-approval-input">Before: {textFact(target.customPrompt.before, review)}
After: {textFact(target.customPrompt.after, review)}</pre>
      {/if}
      {#if target.includeGlobalPrompt}
        <p class="message-approval-tool">Include Global Custom Prompt</p>
        <pre class="message-approval-input">Before: {inclusionFact(target.includeGlobalPrompt.before)} (effective: {inclusionValue(target.includeGlobalPrompt.effectiveBefore)})
After: {inclusionFact(target.includeGlobalPrompt.after)} (effective: {inclusionValue(target.includeGlobalPrompt.effectiveAfter)})</pre>
      {/if}
    {/each}
    {#each review.texts as row, index}
      <p class="message-approval-tool">Text {index + 1}</p>
      {#if row.text === ''}<p class="message-approval-copy">Empty text</p>{/if}
      <pre class="message-approval-input" data-testid="approval-instructions-text">{row.text}</pre>
    {/each}
    {#if preview.excluded.length}
      <p class="message-approval-tool">Excluded Agents</p>
      {#each preview.excluded as subject}<p class="message-approval-copy">{subjectKind(subject.kind)}: {subject.id}</p>{/each}
    {/if}
    <p class="message-approval-copy">Changes apply on later prompt compilations. Global inclusion uses each target's existing global prompt source, including later edits to that global prompt.</p>
  </div>
{/snippet}

<div class="message-approval-panel">
  {#if approvals.length}
  <div class="message-approval-header">
    <div>
      <p class="message-approval-title">Approval required</p>
      <p class="message-approval-copy">
        Review each tool call before it runs.
      </p>
      {#if wakeOrigin}
        <p class="message-approval-origin" data-testid="approval-wake-origin">{wakeOrigin}</p>
      {/if}
    </div>
    {#if approvalSubmitting}
      <span class="message-approval-copy">Continuing...</span>
    {/if}
  </div>
  {/if}

  {#if settingsReview && portableInstructions}
    {@render instructionsTable(portableInstructions, settingsReview.preview)}
  {/if}
  {#if portableCopy}{@render presetCopyTable(portableCopy)}{/if}
  {#if settingsReview?.preview.semanticId === 'agent.model.selection'}
    {#each settingsReview.preview.targets as target}
      {#if target.modelSelection}<p class="message-approval-request">{target.label}</p>{@render modelSelectionTable(target.modelSelection)}{/if}
    {/each}
  {/if}
  {#if settingsReview?.preview.semanticId === MODEL_PRESET_COPY_ID && settingsReview.presetCopyOutcome}
    <div data-testid="approval-preset-copy-outcome">
      <p class="message-approval-request">Saved model copy: {settingsReview.presetCopyOutcome.name}</p>
      <p class="message-approval-copy">{settingsReview.presetCopyOutcome.presetId}</p>
      <p class="message-approval-copy">Creation: {settingsReview.presetCopyOutcome.creation}. Assignment source: {settingsReview.presetCopyOutcome.source}. Target assignment: {settingsReview.presetCopyOutcome.assignment}.</p>
      {#if settingsReview.presetCopyOutcome.creation === 'saved' && settingsReview.presetCopyOutcome.assignment !== 'finished'}<p class="message-approval-copy">This named copy remains in Models. It has not been rolled back or deleted.</p>{/if}
      {#if settingsReview.presetCopyOutcome.creation === 'unknown'}<p class="message-approval-copy">Creation is unconfirmed. Do not repeat this request.</p>{/if}
    </div>
  {/if}
  {#if portableMcp}{@render mcpTable(portableMcp)}{/if}


  <div class="message-approval-list">
    {#each approvals as approval (approval.approvalId)}
      {@const remainingSeconds = getApprovalRemainingSeconds(approval)}
      {@const control = approval.control ?? null}
      {@const exactInput = control?.input && typeof control.input === 'object' ? control.input : null}
      {@const settingsPreview = isAppActionsApprovalPreviewForControl(control?.settingsPreview, control) ? control.settingsPreview : null}
      {@const settingsPreviewUnavailable = control?.controlId === APP_ACTIONS_NATIVE_CHANGE_CONTROL_ID && !settingsPreview}
      {@const instructions = settingsPreview ? instructionsFor(settingsPreview.preview) : null}
      <div class="message-approval-card">
        <div class="message-approval-card-layout">
          <div class="message-approval-detail">
            <p class="message-approval-request">
              {describeApproval(approval)}
            </p>
            <div class="message-approval-meta">
              <span class="message-approval-tool">
                {control
                  ? formatControlApprovalTitle(control)
                  : formatToolDisplayName(approval.toolName || 'tool')}
              </span>
              {#if control}
                <span
                  class="message-approval-risk"
                  class:is-restricted={control.riskLevel === 'restricted'}
                >
                  {formatControlApprovalRiskWord(control.riskLevel)}
                </span>
              {/if}
            </div>
            {#if approval.status === 'pending'}
              {#if control && control.lane && control.lane !== 'api'}
                <p class="message-approval-waits">Waits for you</p>
              {:else if remainingSeconds !== null && remainingSeconds <= 30}
                <p class="message-approval-deadline">Expiring in {remainingSeconds}s</p>
              {/if}
            {/if}
            {#if settingsPreview}
              <details class="message-approval-disclosure" open data-testid="approval-settings-preview">
                <summary>Settings Changes</summary>
                {#if settingsPreview.preview.semanticId === MODEL_PRESET_COPY_ID && settingsPreview.preview.presetCopy}
                  {@render presetCopyTable(settingsPreview.preview.presetCopy)}
                {/if}
                {#if settingsPreview.preview.semanticId === MCP_CONFIGURATION_ID}
                  {@render mcpTable(settingsPreview.preview.resource)}
                {:else if instructions}
                  {@render instructionsTable(instructions, settingsPreview.preview)}
                {:else}
                {#each settingsPreview.preview.targets as target}
                  <p class="message-approval-request">{target.label} ({subjectKind(target.subject.kind)})</p>
                  <p class="message-approval-copy">{target.subject.id}</p>
                  {#each target.changes as change}
                    <p class="message-approval-tool">{change.label}</p>
                    <pre class="message-approval-input">Before: {JSON.stringify(change.before)}
After: {JSON.stringify(change.after)}</pre>
                  {/each}
                  {#if target.modelSelection}{@render modelSelectionTable(target.modelSelection)}{/if}
                {/each}
                {/if}
                {#if settingsPreview.initialOutcomes?.length}
                  <p class="message-approval-tool">Targets With No Changes</p>
                  {#each settingsPreview.initialOutcomes as outcome}
                    <p class="message-approval-request">{subjectKind(outcome.subject.kind)}: {outcome.subject.id}</p>
                    <p class="message-approval-copy">{outcome.status[0].toUpperCase() + outcome.status.slice(1)}{outcome.reason ? `: ${formatAppActionsOutcomeReason(outcome.reason)}` : ''}</p>
                  {/each}
                {/if}
                {#if !instructions && settingsPreview.preview.excluded.length}
                  <p class="message-approval-tool">Excluded Agents</p>
                  {#each settingsPreview.preview.excluded as subject}
                    <p class="message-approval-copy">{subjectKind(subject.kind)}: {subject.id}</p>
                  {/each}
                {/if}
                {#each settingsPreview.preview.effects as effect}<p class="message-approval-copy">{effect}</p>{/each}
                <p class="message-approval-copy">Review expires: {previewTime(settingsPreview.reviewExpiresAt)}</p>
                <p class="message-approval-copy">Time limit: {settingsPreview.executionBudgetMs / 1000} seconds</p>
                {#if settingsPreview.hardDeadlineAt}
                  <p class="message-approval-copy">Request deadline: {previewTime(settingsPreview.hardDeadlineAt)}</p>
                {/if}
              </details>
            {:else if settingsPreviewUnavailable}
              <p class="message-approval-copy">Settings changes could not be confirmed. Refresh this request or ask for a new one before approving.</p>
            {/if}
            {#if control}
              <details class="message-approval-disclosure">
                <summary>{exactInput ? 'Exact input' : 'Input summary'}</summary>
                <pre class="message-approval-input">
{formatApprovalInput(exactInput ?? control.inputSummary ?? approval.input)}
                </pre>
              </details>
            {:else if approval.input}
              <pre class="message-approval-input">
{formatApprovalInput(approval.input)}
              </pre>
            {/if}
          </div>

          <div class="message-approval-actions">
            {#if approval.status === 'approved'}
              <span class="message-approval-status is-approved">
                Approved
              </span>
            {:else if approval.status === 'denied'}
              <span class="message-approval-status is-denied">
                Denied
              </span>
            {:else if approval.status === 'expired'}
              <span class="message-approval-status is-expired">
                {describeApprovalExpiry(approval)}
              </span>
            {:else if isRetiredApproval(approval)}
              <Button size="sm" variant="outline" disabled={approvalSubmitting}
                onclick={() => void onApprovalAction(approval.approvalId, false)}>
                Clear expired approval
              </Button>
            {:else}
              <Button
                size="sm"
                variant="outline"
                disabled={approvalSubmitting}
                onclick={() => void onApprovalAction(approval.approvalId, false)}
              >
                Deny
              </Button>
              <Button
                size="sm"
                disabled={approvalSubmitting || settingsPreviewUnavailable}
                onclick={() => { if (!settingsPreviewUnavailable) void onApprovalAction(approval.approvalId, true) }}
              >
                Approve
              </Button>
            {/if}
          </div>
        </div>
      </div>
    {/each}
  </div>

  {#if approvalError}
    <p class="message-approval-error">{approvalError}</p>
  {/if}
</div>

<style>
  .message-approval-panel {
    margin-top: 0.75rem;
    border: 1px solid oklch(from var(--border) l c h / 0.7);
    border-radius: var(--radius);
    background: oklch(from var(--muted) l c h / 0.2);
    padding: 0.75rem;
  }

  .message-approval-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
  }

  .message-approval-title {
    font-size: 0.875rem;
    font-weight: 600;
  }

  .message-approval-copy,
  .message-approval-tool {
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  /* SA-120 P7: the origin line of a woken turn. Quiet, but not muted: it is the one fact that
     changes what the click below means. */
  .message-approval-origin {
    margin-top: 0.375rem;
    color: var(--foreground);
    font-size: 0.75rem;
    line-height: 1.45;
  }

  .message-approval-list {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-top: 0.75rem;
  }

  .message-approval-card {
    border: 1px solid oklch(from var(--border) l c h / 0.6);
    border-radius: var(--radius);
    background: oklch(from var(--background) l c h / 0.6);
    padding: 0.75rem;
  }

  .message-approval-card-layout {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .message-approval-detail {
    min-width: 0;
    flex: 1 1 0;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }

  .message-approval-request {
    overflow-wrap: anywhere;
    font-size: 0.875rem;
  }

  .message-approval-deadline {
    color: oklch(0.72 0.12 78);
    font-size: 0.6875rem;
  }

  /* SA-116: an approval that waits for a resume turn has no countdown — its record lives
     24 hours, not three minutes. */
  .message-approval-waits {
    color: var(--muted-foreground);
    font-size: 0.6875rem;
  }

  .message-approval-meta {
    display: flex;
    align-items: center;
    flex-wrap: wrap;
    gap: 0.375rem;
  }

  /* Same badge shape as the status pills below: fixed height, no vertical padding, quiet
     contrast. `confirm` reuses this panel's existing warning amber; `restricted` uses the
     app's destructive token. */
  .message-approval-risk {
    display: inline-flex;
    align-items: center;
    height: 1.125rem;
    border-radius: 9999px;
    border: 1px solid oklch(0.72 0.12 78 / 0.4);
    padding: 0 0.5rem;
    background: oklch(0.72 0.12 78 / 0.12);
    color: oklch(0.72 0.12 78);
    font-size: 0.6875rem;
    font-weight: 500;
    line-height: 1.125rem;
  }

  .message-approval-risk.is-restricted {
    border-color: oklch(from var(--destructive) l c h / 0.45);
    background: oklch(from var(--destructive) l c h / 0.12);
    color: var(--destructive);
  }

  .message-approval-disclosure {
    margin-top: 0.125rem;
  }

  .message-approval-disclosure summary {
    color: var(--muted-foreground);
    cursor: pointer;
    font-size: 0.6875rem;
  }

  .message-approval-input {
    width: 100%;
    max-height: 10rem;
    overflow: auto;
    white-space: pre-wrap;
    word-break: break-all;
    border-radius: var(--radius);
    background: oklch(from var(--muted) l c h / 0.5);
    padding: 0.5rem;
    color: var(--muted-foreground);
    font-size: 0.75rem;
  }

  .message-approval-actions {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: 0.5rem;
  }

  .message-approval-status {
    display: inline-flex;
    align-items: center;
    border-radius: 9999px;
    padding: 0.25rem 0.75rem;
    font-size: 0.75rem;
    font-weight: 600;
  }

  .message-approval-status.is-approved {
    background: var(--success-background);
    color: var(--success-color);
  }

  .message-approval-status.is-denied {
    background: oklch(0.598 0.241 3.61 / 0.1);
    color: var(--destructive);
  }

  .message-approval-status.is-expired {
    background: oklch(0.72 0.12 78 / 0.12);
    color: oklch(0.72 0.12 78);
  }

  .message-approval-error {
    margin-top: 0.5rem;
    color: var(--destructive);
    font-size: 0.75rem;
  }

  @media (min-width: 768px) {
    .message-approval-card-layout {
      flex-direction: row;
      align-items: flex-start;
      justify-content: space-between;
    }

    .message-approval-actions {
      justify-content: flex-end;
    }
  }
</style>
