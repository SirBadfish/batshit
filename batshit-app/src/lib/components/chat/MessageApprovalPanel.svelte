<script lang="ts">
  import { Button } from '$lib/components/ui/button'
  import { formatToolDisplayName } from '$lib/utils/toolNameFormatter'
  import {
    formatControlApprovalRiskWord,
    formatControlApprovalTitle
  } from '$lib/utils/controlApprovalPresentation'

  interface Props {
    approvals: any[]
    approvalSubmitting: boolean
    approvalError: string | null
    describeApproval: (approval: any) => string
    formatApprovalInput: (input: any) => string
    getApprovalRemainingSeconds: (approval: any) => number | null
    onApprovalAction: (approvalId: string, approved: boolean) => void | Promise<void>
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
    onApprovalAction
  }: Props = $props()
</script>

<div class="message-approval-panel">
  <div class="message-approval-header">
    <div>
      <p class="message-approval-title">Approval required</p>
      <p class="message-approval-copy">
        Review each tool call before it runs.
      </p>
    </div>
    {#if approvalSubmitting}
      <span class="message-approval-copy">Continuing...</span>
    {/if}
  </div>

  <div class="message-approval-list">
    {#each approvals as approval (approval.approvalId)}
      {@const remainingSeconds = getApprovalRemainingSeconds(approval)}
      {@const control = approval.control ?? null}
      {@const exactInput = control?.input && typeof control.input === 'object' ? control.input : null}
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
                Expired (3m)
              </span>
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
                disabled={approvalSubmitting}
                onclick={() => void onApprovalAction(approval.approvalId, true)}
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
