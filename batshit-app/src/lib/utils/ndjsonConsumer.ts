/**
 * NDJSON Stream Consumer
 *
 * Shared utility for consuming NDJSON (newline-delimited JSON) streams.
 * Used by both artifact iframes and chat rendering.
 *
 * This is the SINGLE SOURCE OF TRUTH for NDJSON event handling.
 * Any changes to event types or handling should be made here.
 *
 * @version 1.0.0
 * @since SA-011
 */

export interface NdjsonHooks {
  onStart?: (evt: StreamEvent) => void;
  onChunk?: (text: string, evt: StreamEvent) => void;
  onThinking?: (text: string, evt: StreamEvent) => void;
  onFile?: (base64: string, mediaType: string, evt: StreamEvent) => void;
  onAudio?: (audioData: string, mediaType: string, evt: StreamEvent) => void;
  onObjectPartial?: (object: any, evt: StreamEvent) => void;  // SA-011 Phase 4
  onObjectFinal?: (object: any, evt: StreamEvent) => void;    // SA-011 Phase 4
  onToolCall?: (call: any, evt: StreamEvent) => void;
  onToolResult?: (result: any, evt: StreamEvent) => void;
  onEnd?: (evt: StreamEvent) => void;
  onError?: (error: string, evt: StreamEvent) => void;
  onEvent?: (evt: StreamEvent) => void;
}

export interface StreamEvent {
  type: string;
  content?: string;
  base64?: string;
  mediaType?: string;
  audioData?: string;
  object?: any;        // SA-011 Phase 4: Structured object data
  index?: number;
  metadata?: any;
  error?: string;
  [key: string]: any;
}

export interface NdjsonResult {
  text: string;
  events: StreamEvent[];
  metadata: any;
  files: Array<{ base64: string; mediaType: string; index: number }>;
  audio: Array<{ audioData: string; mediaType: string; index: number }>;
  object: any;  // SA-011 Phase 4: Final structured object (if mode was 'object')
}

/**
 * Consume an NDJSON stream from a Response object.
 *
 * This function handles all standard Batshit stream event types:
 * - start: Stream initialization
 * - chunk: Text content delta
 * - thinking: Reasoning/thinking content
 * - file: Generated files (images from multimodal models)
 * - audio: Generated audio (TTS)
 * - object_partial: Streaming structured object updates (SA-011 Phase 4)
 * - object_final: Final structured object (SA-011 Phase 4)
 * - tool-call / tool-result: Tool execution events
 * - end: Stream completion with final content
 * - error: Error events
 *
 * @param response - Fetch Response object with NDJSON body
 * @param hooks - Optional callbacks for each event type
 * @returns Promise with aggregated result
 */
export async function consumeNdjsonStream(
  response: Response,
  hooks: NdjsonHooks = {}
): Promise<NdjsonResult> {
  if (!response.body) {
    throw new Error('No response body to stream');
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let text = '';
  let metadata: any;
  let object: any = null;  // SA-011 Phase 4: Final structured object
  const events: StreamEvent[] = [];
  const files: Array<{ base64: string; mediaType: string; index: number }> = [];
  const audio: Array<{ audioData: string; mediaType: string; index: number }> = [];

  while (true) {
    const { value, done } = await reader.read();

    if (value) {
      buffer += decoder.decode(value, { stream: !done });
    }

    // Split on newlines and process complete lines
    const lines = buffer.split('\n');
    buffer = lines.pop() || ''; // Keep incomplete line in buffer

    for (const line of lines) {
      if (!line.trim()) continue;

      let evt: StreamEvent;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        console.warn('[ndjsonConsumer] Failed to parse NDJSON line:', err);
        continue;
      }

      events.push(evt);
      hooks.onEvent?.(evt);

      // Handle each event type
      switch (evt.type) {
        case 'start':
          hooks.onStart?.(evt);
          break;

        case 'chunk':
          text += evt.content || '';
          hooks.onChunk?.(evt.content || '', evt);
          break;

        case 'thinking':
          hooks.onThinking?.(evt.content || '', evt);
          break;

        case 'file':
          // SA-010: Generated files (images from multimodal models)
          if (evt.base64 && evt.mediaType) {
            files.push({
              base64: evt.base64,
              mediaType: evt.mediaType,
              index: evt.index || files.length
            });
            hooks.onFile?.(evt.base64, evt.mediaType, evt);
          }
          break;

        case 'audio':
          // SA-011: Generated audio (TTS)
          if (evt.audioData && evt.mediaType) {
            audio.push({
              audioData: evt.audioData,
              mediaType: evt.mediaType,
              index: evt.index || audio.length
            });
            hooks.onAudio?.(evt.audioData, evt.mediaType, evt);
          }
          break;

        case 'object_partial':
          // SA-011 Phase 4: Streaming structured object partial update
          if (evt.object !== undefined) {
            object = evt.object;  // Update with latest partial
            hooks.onObjectPartial?.(evt.object, evt);
          }
          break;

        case 'object_final':
          // SA-011 Phase 4: Final complete structured object
          if (evt.object !== undefined) {
            object = evt.object;
            hooks.onObjectFinal?.(evt.object, evt);
          }
          break;

        case 'tool-call':
          hooks.onToolCall?.(evt, evt);
          break;

        case 'tool-result':
          hooks.onToolResult?.(evt, evt);
          break;

        case 'end':
          metadata = evt.metadata;
          if (evt.content) text = evt.content; // Final content override
          hooks.onEnd?.(evt);
          break;

        case 'error':
          hooks.onError?.(evt.error || 'Unknown error', evt);
          break;
      }
    }

    if (done) break;
  }

  return { text, events, metadata, files, audio, object };
}

/**
 * Generate browser-compatible inline script for NDJSON consumption.
 * This is used when injecting into artifact iframes where we can't import modules.
 *
 * @returns JavaScript code as a string (no script tags)
 */
export function generateNdjsonConsumerScript(): string {
  return `
// NDJSON Consumer v1.0.0 (SA-011)
// Single source of truth for stream event handling
async function consumeNdjson(response, hooks = {}) {
  if (!response.body) throw new Error('No response body to stream');

  const reader = response.body.getReader();
  const decoder = new TextDecoder();

  let buffer = '';
  let text = '';
  let metadata;
  let object = null;
  const events = [];
  const files = [];
  const audio = [];

  while (true) {
    const { value, done } = await reader.read();
    if (value) buffer += decoder.decode(value, { stream: !done });

    const lines = buffer.split('\\n');
    buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      let evt;
      try {
        evt = JSON.parse(line);
      } catch (err) {
        console.warn('[ndjsonConsumer] Failed to parse NDJSON line:', err);
        continue;
      }

      events.push(evt);
      hooks.onEvent && hooks.onEvent(evt);

      switch (evt.type) {
        case 'start':
          hooks.onStart && hooks.onStart(evt);
          break;
        case 'chunk':
          text += evt.content || '';
          hooks.onChunk && hooks.onChunk(evt.content || '', evt);
          break;
        case 'thinking':
          hooks.onThinking && hooks.onThinking(evt.content || '', evt);
          break;
        case 'file':
          if (evt.base64 && evt.mediaType) {
            files.push({ base64: evt.base64, mediaType: evt.mediaType, index: evt.index || files.length });
            hooks.onFile && hooks.onFile(evt.base64, evt.mediaType, evt);
          }
          break;
        case 'audio':
          if (evt.audioData && evt.mediaType) {
            audio.push({ audioData: evt.audioData, mediaType: evt.mediaType, index: evt.index || audio.length });
            hooks.onAudio && hooks.onAudio(evt.audioData, evt.mediaType, evt);
          }
          break;
        case 'object_partial':
          if (evt.object !== undefined) {
            object = evt.object;
            hooks.onObjectPartial && hooks.onObjectPartial(evt.object, evt);
          }
          break;
        case 'object_final':
          if (evt.object !== undefined) {
            object = evt.object;
            hooks.onObjectFinal && hooks.onObjectFinal(evt.object, evt);
          }
          break;
        case 'tool-call':
          hooks.onToolCall && hooks.onToolCall(evt, evt);
          break;
        case 'tool-result':
          hooks.onToolResult && hooks.onToolResult(evt, evt);
          break;
        case 'end':
          metadata = evt.metadata;
          if (evt.content) text = evt.content;
          hooks.onEnd && hooks.onEnd(evt);
          break;
        case 'error':
          hooks.onError && hooks.onError(evt.error || 'Unknown error', evt);
          break;
      }
    }

    if (done) break;
  }

  return { text, events, metadata, files, audio, object };
}
`;
}
