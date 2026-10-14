/**
 * A managed Claude run whose model calls Claude Code's own `Agent` helper, as Claude Code's
 * `--output-format stream-json --include-partial-messages --verbose` reports it (BL-501). Every
 * event keeps the vendor's own field names and nesting; the words, ids, paths and numbers are
 * replaced. Where each shape comes from:
 *
 * - The main thread's partial events and its `assistant`/`user`/`result` envelopes:
 *   a managed lane run's saved event log (`_local/bug-batch-2026-09-27/cli/live/`, BL-318).
 * - The helper's forwarded messages: Claude Code 2.1.296's own stream-json writer (read from the
 *   installed CLI's bundled source, 2026-10-11). It forwards each message of the helper's model as
 *   a top-level `assistant` or `user` event with `parent_tool_use_id` set to the main thread's
 *   `Agent` call, plus `agent_id`, `subagent_type`, `task_description`, and, on a `user` event, the
 *   tool's `tool_use_result`. It does not forward the helper's partial `stream_event`s; its
 *   partial-event writer sets `parent_tool_use_id: null` on every one it sends.
 * - The helper's own Bash call and result: a Claude Code 2.1.296 helper transcript record.
 * - The `Agent` call's input and its completed `tool_use_result`: a Claude Code 2.1.258
 *   transcript record (`status`, `agentId`, `agentType`, `content`, `totalToolUseCount`, ...).
 *
 * The main model reads only the `Agent` call's `tool_result`. Everything between the call and that
 * result is the helper's own model at work.
 */

const SESSION = '5f0c3a52-7d1e-4b8a-9c6f-0e2d4a1b3c7d'
export const CLAUDE_AGENT_CALL_ID = 'toolu_01AgentCallExample0000001'
export const CLAUDE_HELPER_BASH_ID = 'toolu_01HelperBashExample000001'
export const CLAUDE_HELPER_AGENT_ID = 'a3f9c2e17b4d60851'

/** What the main model wrote, and all it wrote. */
export const CLAUDE_MAIN_REPLY_TEXT = 'The app listens on port 5620.'

/** The helper's own words, which the main model never read as written here. */
export const CLAUDE_HELPER_OPENING_TEXT = "I'll search the config folder for the port setting."
export const CLAUDE_HELPER_THINKING = 'The port is probably set in the server config.'
export const CLAUDE_HELPER_FINAL_TEXT =
  'Found it. `src/config/server.ts` line 3 sets `PORT = 5620`; nothing else in the config folder ' +
  'reads or overrides it, and the value is not taken from the environment.'

/** What the helper's command printed (its tool result, read only by the helper's model). */
export const CLAUDE_HELPER_BASH_OUTPUT = 'src/config/server.ts:3:export const PORT = 5620'

const AGENT_INPUT = {
  description: 'Find the port setting',
  subagent_type: 'Explore',
  prompt: 'Find where the app sets the port it listens on. Report the file and line.'
}

const usage = (input: number, output: number) => ({
  input_tokens: input,
  cache_creation_input_tokens: 0,
  cache_read_input_tokens: 0,
  output_tokens: output,
  service_tier: 'standard'
})

const helperEnvelope = {
  parent_tool_use_id: CLAUDE_AGENT_CALL_ID,
  agent_id: CLAUDE_HELPER_AGENT_ID,
  session_id: SESSION,
  subagent_type: 'Explore',
  task_description: AGENT_INPUT.description
}

const mainStreamEvent = (event: Record<string, unknown>, uuid: string) => ({
  type: 'stream_event',
  event,
  session_id: SESSION,
  parent_tool_use_id: null,
  uuid
})

/** The whole run, in the order Claude Code writes it. */
export function claudeAgentHelperRunEvents(): Record<string, unknown>[] {
  const agentInputJson = JSON.stringify(AGENT_INPUT)
  return [
    // The main model's first step: the Agent call, and no words before it.
    mainStreamEvent(
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-5-5',
          id: 'msg_01MainStepOneExample0001',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(3, 1)
        }
      },
      'e0000000-0000-4000-8000-000000000001'
    ),
    mainStreamEvent(
      {
        type: 'content_block_start',
        index: 0,
        content_block: {
          type: 'tool_use',
          id: CLAUDE_AGENT_CALL_ID,
          name: 'Agent',
          input: {},
          caller: { type: 'direct' }
        }
      },
      'e0000000-0000-4000-8000-000000000002'
    ),
    mainStreamEvent(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: agentInputJson.slice(0, 40) }
      },
      'e0000000-0000-4000-8000-000000000003'
    ),
    mainStreamEvent(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'input_json_delta', partial_json: agentInputJson.slice(40) }
      },
      'e0000000-0000-4000-8000-000000000004'
    ),
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5-5',
        id: 'msg_01MainStepOneExample0001',
        type: 'message',
        role: 'assistant',
        content: [
          { type: 'tool_use', id: CLAUDE_AGENT_CALL_ID, name: 'Agent', input: AGENT_INPUT, caller: { type: 'direct' } }
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: usage(3, 1)
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: 'e0000000-0000-4000-8000-000000000005'
    },
    mainStreamEvent({ type: 'content_block_stop', index: 0 }, 'e0000000-0000-4000-8000-000000000006'),
    mainStreamEvent(
      {
        type: 'message_delta',
        delta: { stop_reason: 'tool_use', stop_sequence: null },
        usage: usage(3, 88)
      },
      'e0000000-0000-4000-8000-000000000007'
    ),
    mainStreamEvent({ type: 'message_stop' }, 'e0000000-0000-4000-8000-000000000008'),

    // The helper's own model, forwarded message by message.
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-5-5',
        id: 'msg_01HelperStepOneExample01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'thinking', thinking: CLAUDE_HELPER_THINKING, signature: 'c2lnbmF0dXJl' }],
        stop_reason: null,
        stop_sequence: null,
        usage: usage(2, 20)
      },
      ...helperEnvelope,
      uuid: 'e0000000-0000-4000-8000-000000000009'
    },
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-5-5',
        id: 'msg_01HelperStepOneExample01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: CLAUDE_HELPER_OPENING_TEXT }],
        stop_reason: null,
        stop_sequence: null,
        usage: usage(2, 20)
      },
      ...helperEnvelope,
      uuid: 'e0000000-0000-4000-8000-00000000000a'
    },
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-5-5',
        id: 'msg_01HelperStepOneExample01',
        type: 'message',
        role: 'assistant',
        content: [
          {
            type: 'tool_use',
            id: CLAUDE_HELPER_BASH_ID,
            name: 'Bash',
            input: { command: 'grep -rn "PORT" src/config', description: 'Search the config folder for PORT' },
            caller: { type: 'direct' }
          }
        ],
        stop_reason: null,
        stop_sequence: null,
        usage: usage(2, 20)
      },
      ...helperEnvelope,
      uuid: 'e0000000-0000-4000-8000-00000000000b'
    },
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: CLAUDE_HELPER_BASH_ID,
            type: 'tool_result',
            content: CLAUDE_HELPER_BASH_OUTPUT,
            is_error: false
          }
        ]
      },
      ...helperEnvelope,
      uuid: 'e0000000-0000-4000-8000-00000000000c',
      timestamp: '2026-10-11T14:30:02.120Z',
      isSynthetic: false,
      tool_use_result: {
        stdout: CLAUDE_HELPER_BASH_OUTPUT,
        stderr: '',
        interrupted: false,
        isImage: false,
        noOutputExpected: false
      }
    },
    {
      type: 'assistant',
      message: {
        model: 'claude-haiku-5-5',
        id: 'msg_01HelperStepTwoExample01',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: CLAUDE_HELPER_FINAL_TEXT }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: usage(2, 64)
      },
      ...helperEnvelope,
      uuid: 'e0000000-0000-4000-8000-00000000000d'
    },

    // The Agent call's result: the only part of the helper's work the main model reads.
    {
      type: 'user',
      message: {
        role: 'user',
        content: [
          {
            tool_use_id: CLAUDE_AGENT_CALL_ID,
            type: 'tool_result',
            content: [
              { type: 'text', text: CLAUDE_HELPER_FINAL_TEXT },
              {
                type: 'text',
                text: `agentId: ${CLAUDE_HELPER_AGENT_ID} (use SendMessage with to: '${CLAUDE_HELPER_AGENT_ID}' to continue this agent)`
              }
            ]
          }
        ]
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: 'e0000000-0000-4000-8000-00000000000e',
      timestamp: '2026-10-11T14:30:03.410Z',
      tool_use_result: {
        status: 'completed',
        prompt: AGENT_INPUT.prompt,
        agentId: CLAUDE_HELPER_AGENT_ID,
        agentType: 'Explore',
        content: [{ type: 'text', text: CLAUDE_HELPER_FINAL_TEXT }],
        resolvedModel: 'claude-haiku-5-5',
        totalDurationMs: 2950,
        totalTokens: 4108,
        totalToolUseCount: 1,
        usage: usage(2, 64),
        toolStats: {
          readCount: 0,
          searchCount: 1,
          bashCount: 0,
          editFileCount: 0,
          linesAdded: 0,
          linesRemoved: 0,
          otherToolCount: 0
        }
      }
    },

    // The main model's answer.
    mainStreamEvent(
      {
        type: 'message_start',
        message: {
          model: 'claude-sonnet-5-5',
          id: 'msg_01MainStepTwoExample0001',
          type: 'message',
          role: 'assistant',
          content: [],
          stop_reason: null,
          stop_sequence: null,
          usage: usage(5, 1)
        }
      },
      'e0000000-0000-4000-8000-00000000000f'
    ),
    mainStreamEvent(
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      'e0000000-0000-4000-8000-000000000010'
    ),
    mainStreamEvent(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: CLAUDE_MAIN_REPLY_TEXT.slice(0, 12) }
      },
      'e0000000-0000-4000-8000-000000000011'
    ),
    mainStreamEvent(
      {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: CLAUDE_MAIN_REPLY_TEXT.slice(12) }
      },
      'e0000000-0000-4000-8000-000000000012'
    ),
    {
      type: 'assistant',
      message: {
        model: 'claude-sonnet-5-5',
        id: 'msg_01MainStepTwoExample0001',
        type: 'message',
        role: 'assistant',
        content: [{ type: 'text', text: CLAUDE_MAIN_REPLY_TEXT }],
        stop_reason: null,
        stop_sequence: null,
        usage: usage(5, 1)
      },
      parent_tool_use_id: null,
      session_id: SESSION,
      uuid: 'e0000000-0000-4000-8000-000000000013'
    },
    mainStreamEvent({ type: 'content_block_stop', index: 0 }, 'e0000000-0000-4000-8000-000000000014'),
    mainStreamEvent(
      {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn', stop_sequence: null },
        usage: usage(5, 12)
      },
      'e0000000-0000-4000-8000-000000000015'
    ),
    mainStreamEvent({ type: 'message_stop' }, 'e0000000-0000-4000-8000-000000000016'),
    {
      type: 'result',
      subtype: 'success',
      is_error: false,
      duration_ms: 6120,
      duration_api_ms: 5480,
      num_turns: 2,
      result: CLAUDE_MAIN_REPLY_TEXT,
      stop_reason: 'end_turn',
      session_id: SESSION,
      total_cost_usd: 0.0123,
      usage: usage(8, 100),
      modelUsage: {},
      permission_denials: [],
      uuid: 'e0000000-0000-4000-8000-000000000017'
    }
  ]
}
