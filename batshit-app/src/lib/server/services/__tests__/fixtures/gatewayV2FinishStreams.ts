/**
 * BL-1782: the streams of one turn that calls a tool, as the providers sent them on 2026-10-18.
 *
 * Transcribed from builder G's triage captures (`_local/opie-batch-20261018/gateway/`,
 * `capture-gateway-dynamic.json` and `capture-direct-dynamic.json`, made by `repro.mjs` with
 * `ai` 7.0.119 and `@ai-sdk/gateway` 4.0.97 against the live services; no key is in them). Each
 * event is the JSON of one `data:` line of the HTTP body, in order, unchanged except: message,
 * tool-call and generation ids are replaced, and the Gateway's routing record
 * (`providerMetadata.gateway.routing`, its provider attempts, session fingerprint and costs) is
 * reduced to the generation id. The Gateway's body also ended with a bare `DONE` line, which an
 * event-stream reader ignores; it is left out.
 *
 * What matters is the Gateway's `finish` part: `@ai-sdk/gateway` 4.0.97 asks for language-model
 * specification v4, but the part has the older shape, `finishReason` a plain string and `usage`
 * flat numbers (v4: `finishReason: { unified, raw }`, `usage.inputTokens: { total, ... }`).
 */

/** One stream event per `data:` line, as a provider's event stream sends it. */
export function eventStreamResponse(
  events: ReadonlyArray<Record<string, unknown>>,
  options: { eventLines?: boolean } = {}
): Response {
  const body = events
    .map((event) => `${options.eventLines ? `event: ${String(event.type)}\n` : ''}data: ${JSON.stringify(event)}\n\n`)
    .join('')
  return new Response(body, { status: 200, headers: { 'content-type': 'text/event-stream' } })
}

/** The AI Gateway's answer (its `/language-model` stream) to a turn that calls the `test-researcher` tool. */
export const GATEWAY_V2_FINISH_TOOL_CALL_EVENTS = [
  {"type":"stream-start","warnings":[]},
  {"type":"raw","rawValue":{"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_fixture_1782_1","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":552,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":24,"service_tier":"standard","inference_geo":"global","speed":"standard"},"diagnostics":null}}},
  {"type":"response-metadata","id":"msg_fixture_1782_1","modelId":"claude-haiku-5-5"},
  {"type":"raw","rawValue":{"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_fixture_1782_1","name":"test-researcher","input":{},"caller":{"type":"direct"}}}},
  {"type":"tool-input-start","id":"toolu_fixture_1782_1","toolName":"test-researcher","providerMetadata":{"gateway":{"generationId":"gen_fixture_1782_1"}}},
  {"type":"raw","rawValue":{"type":"ping"}},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}}},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"chatI"}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"{\"chatI"},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"nput\": "}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"nput\": "},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"What i"}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"\"What i"},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"s 2 plu"}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"s 2 plu"},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"s 2? An"}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"s 2? An"},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"swer wi"}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"swer wi"},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"th one "}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"th one "},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"number."}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"number."},
  {"type":"raw","rawValue":{"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"}"}}},
  {"type":"tool-input-delta","id":"toolu_fixture_1782_1","delta":"\"}"},
  {"type":"raw","rawValue":{"type":"content_block_stop","index":0}},
  {"type":"tool-input-end","id":"toolu_fixture_1782_1"},
  {"type":"tool-call","toolCallId":"toolu_fixture_1782_1","toolName":"test-researcher","input":"{\"chatInput\": \"What is 2 plus 2? Answer with one number.\"}"},
  {"type":"raw","rawValue":{"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"container":null},"usage":{"input_tokens":552,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":68,"output_tokens_details":{"thinking_tokens":0}}}},
  {"type":"raw","rawValue":{"type":"message_stop"}},
  {"type":"finish","finishReason":"tool-calls","usage":{"inputTokens":552,"outputTokens":68,"totalTokens":620,"cachedInputTokens":0},"providerMetadata":{"anthropic":{"usage":{"input_tokens":552,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":68,"service_tier":"standard","inference_geo":"global","speed":"standard","output_tokens_details":{"thinking_tokens":0}},"cacheCreationInputTokens":0,"stopSequence":null,"iterations":null,"container":null,"contextManagement":null},"gateway":{"generationId":"gen_fixture_1782_1"}}}
] as const satisfies ReadonlyArray<Record<string, unknown>>

/** Anthropic's own answer (`/v1/messages` stream) to the same turn, sent direct. */
export const ANTHROPIC_DIRECT_TOOL_CALL_EVENTS = [
  {"type":"message_start","message":{"model":"claude-haiku-5-5","id":"msg_fixture_1782_2","type":"message","role":"assistant","content":[],"container":null,"stop_reason":null,"stop_sequence":null,"stop_details":null,"usage":{"input_tokens":552,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"cache_creation":{"ephemeral_5m_input_tokens":0,"ephemeral_1h_input_tokens":0},"output_tokens":24,"service_tier":"standard","inference_geo":"global","speed":"standard"},"diagnostics":null}},
  {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_fixture_1782_2","name":"test-researcher","input":{},"caller":{"type":"direct"}}},
  {"type":"ping"},
  {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":""}},
  {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\"chatInput\": \"What is 2 plus "}},
  {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"2? Answer with one number"}},
  {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"."}},
  {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"\"}"}},
  {"type":"content_block_stop","index":0},
  {"type":"message_delta","delta":{"stop_reason":"tool_use","stop_sequence":null,"stop_details":null,"container":null},"usage":{"input_tokens":552,"cache_creation_input_tokens":0,"cache_read_input_tokens":0,"output_tokens":68,"output_tokens_details":{"thinking_tokens":0}}},
  {"type":"message_stop"}
] as const satisfies ReadonlyArray<Record<string, unknown>>

/**
 * A Gateway answer with words and no tool call, in the same older shape. NOT captured: built from
 * the captured tool-call answer's parts (`stream-start`, `response-metadata`, the text parts the
 * specification has kept since v2, and its `finish` with `finishReason: 'stop'`), for the reply
 * that must stream and save as before.
 */
export const GATEWAY_V2_FINISH_TEXT_EVENTS = [
  { type: 'stream-start', warnings: [] },
  { type: 'response-metadata', id: 'msg_fixture_1782_3', modelId: 'claude-haiku-5-5' },
  { type: 'text-start', id: 'txt_fixture_1782_1' },
  { type: 'text-delta', id: 'txt_fixture_1782_1', delta: 'Two plus two is 4.' },
  { type: 'text-end', id: 'txt_fixture_1782_1' },
  {
    type: 'finish',
    finishReason: 'stop',
    usage: { inputTokens: 552, outputTokens: 9, totalTokens: 561, cachedInputTokens: 0 },
    providerMetadata: { gateway: { generationId: 'gen_fixture_1782_2' } }
  }
] as const satisfies ReadonlyArray<Record<string, unknown>>
