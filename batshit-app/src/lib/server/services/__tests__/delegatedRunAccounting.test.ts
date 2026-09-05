import { describe, expect, it } from 'vitest'

import { buildDelegatedExecutionSummary } from '../delegatedRunAccounting'

describe('buildDelegatedExecutionSummary', () => {
  it('normalizes direct API Subagent results and preserves unknown values honestly', () => {
    const summary = buildDelegatedExecutionSummary([
      {
        toolCallId: 'call-api',
        toolName: 'api_helper',
        toolOutput: {
          kind: 'subagent',
          subagentName: 'API Helper',
          subagentType: 'api',
          modelId: 'gpt-5.4',
          provider: 'openai',
          usage: { promptTokens: 120, completionTokens: 30, totalTokens: 150 },
          durationMs: 1234,
          status: 'completed',
          thread: 'fresh',
        },
      },
      {
        toolCallId: 'call-n8n',
        toolName: 'workflow_helper',
        toolOutput: {
          kind: 'subagent',
          subagentName: 'Workflow Helper',
          subagentType: 'n8n-workflow',
          modelId: null,
          provider: null,
          usage: null,
          durationMs: 44_200,
          status: 'completed',
          thread: 'resumed',
        },
      },
    ])

    expect(summary).toMatchObject({
      runs: [
        {
          kind: 'subagent',
          name: 'API Helper',
          type: 'api',
          model: 'gpt-5.4',
          provider: 'openai',
          usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
          durationMs: 1234,
          status: 'completed',
          thread: 'fresh',
        },
        {
          name: 'Workflow Helper',
          type: 'n8n-workflow',
          usage: null,
          durationMs: 44_200,
          thread: 'resumed',
        },
      ],
      totals: {
        runs: 2,
        completed: 2,
        failed: 0,
        timedOut: 0,
        usageKnownRuns: 1,
        usageUnknownRuns: 1,
        usage: { inputTokens: 120, outputTokens: 30, totalTokens: 150 },
      },
    })
  })

  it('unwraps CLI text envelopes, records timeouts, and deduplicates one tool call', () => {
    const payload = {
      kind: 'subagent',
      subagentName: 'CLI Helper',
      subagentType: 'cli',
      modelId: 'gpt-5.6-sol',
      provider: 'openai-codex',
      usage: null,
      durationMs: 10_005,
      status: 'timed_out',
      thread: 'resumed-empty',
    }
    const step = {
      toolCallId: 'call-cli',
      toolOutput: {
        content: [{ type: 'text', text: JSON.stringify(payload) }],
      },
    }

    const summary = buildDelegatedExecutionSummary([step, step])

    expect(summary?.runs).toEqual([
      expect.objectContaining({
        name: 'CLI Helper',
        type: 'cli',
        status: 'timed_out',
        usage: null,
        thread: 'resumed-empty',
      }),
    ])
    expect(summary?.totals).toMatchObject({
      runs: 1,
      completed: 0,
      failed: 0,
      timedOut: 1,
      usageKnownRuns: 0,
      usageUnknownRuns: 1,
      usage: null,
    })
  })

  it('SA-111 P4: one worker batch becomes one delegated run per worker', () => {
    // A `spawn_workers` call is ONE tool result carrying up to three runs. Counting the
    // batch as a single run would under-report worker spend in the Token Panel and hide
    // two of the three rows in the Execution Viewer.
    const summary = buildDelegatedExecutionSummary([
      {
        toolCallId: 'call-workers',
        toolName: 'native_spawn_workers',
        toolOutput: {
          kind: 'workers',
          success: true,
          requested: 3,
          completed: 2,
          workers: [
            {
              index: 0,
              name: 'docs scout',
              role: 'docs scout',
              base: null,
              status: 'completed',
              output: 'found it',
              usage: { promptTokens: 100, completionTokens: 20, totalTokens: 120 },
              modelId: 'gpt-5.4',
              provider: 'openai',
              durationMs: 900,
            },
            {
              index: 1,
              name: 'Researcher (worker)',
              role: null,
              base: 'researcher',
              status: 'completed',
              output: 'also found it',
              usage: { promptTokens: 50, completionTokens: 10, totalTokens: 60 },
              modelId: 'gpt-5.4',
              provider: 'openai',
              durationMs: 700,
            },
            {
              index: 2,
              name: 'Worker 3',
              role: null,
              base: null,
              status: 'timed_out',
              output: 'did not return in time',
              usage: null,
              modelId: 'gpt-5.4',
              provider: 'openai',
              durationMs: 180_000,
            },
          ],
        },
      },
    ])

    expect(summary?.runs).toHaveLength(3)
    expect(summary?.runs.every((run) => run.kind === 'worker')).toBe(true)
    // A worker has no stored thread at all — honest absence, not an invented 'fresh'.
    expect(summary?.runs.every((run) => run.thread === null)).toBe(true)
    expect(summary?.runs[1].type).toBe('worker of researcher')
    expect(summary?.totals).toMatchObject({
      runs: 3,
      completed: 2,
      failed: 0,
      timedOut: 1,
      usageKnownRuns: 2,
      usageUnknownRuns: 1,
    })
    // Unknown usage is not counted as zero (SA-102 rule); the two known runs sum.
    expect(summary?.totals.usage).toMatchObject({ totalTokens: 180 })
  })

  it('SA-111 P4: a refused worker batch contributes no delegated runs', () => {
    // A cap refusal or an unknown `base` never reached a model, so it must not appear as
    // spend or as a row the user could mistake for work that ran.
    expect(
      buildDelegatedExecutionSummary([
        {
          toolCallId: 'call-workers-refused',
          toolName: 'native_spawn_workers',
          toolOutput: {
            kind: 'workers',
            success: false,
            error: 'worker_turn_limit',
            message: 'This response has already started 9 of its 9 allowed worker runs.',
            workers: [],
          },
        },
      ]),
    ).toBeNull()
  })

  it('ignores ordinary tool results that are not managed delegation outcomes', () => {
    expect(
      buildDelegatedExecutionSummary([
        {
          toolCallId: 'read-1',
          toolOutput: { success: true, content: 'file text' },
        },
      ]),
    ).toBeNull()
  })
})
