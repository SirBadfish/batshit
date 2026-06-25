import type { ZipReference } from '$lib/server/zipService';

export type StreamEventType =
  | 'start'
  | 'chunk'
  | 'thinking'
  | 'plan_update'
  | 'tool_start'
  | 'tool-call'
  | 'tool_approval_request'
  | 'tool-result'
  | 'tool_end'
  | 'finish'
  | 'end'
  | 'complete'
  | 'error'
  | 'zip_activity_change'
  | 'user_message'
  | 'file'           // SA-010: Generated file output (images, etc.)
  | 'audio'          // SA-011: Generated audio output (TTS/speech)
  | 'object_partial' // SA-011: Streaming structured object partial update
  | 'object_final';  // SA-011: Final complete structured object

export interface VoiceMetadata {
  stt?: boolean;
  tts?: boolean;
  voiceMode?: 'text' | 'voice' | 'hybrid';
  realtime?: boolean;
  provider?: string;
  model?: string;
  voiceId?: string;
  profileId?: string;
  common?: Record<string, any>;
  providerOptions?: Record<string, any>;
  style?: Record<string, any>;
}

export interface CanonicalStreamEvent {
  type: StreamEventType;
  sessionId: string;
  messageId?: string;
  content?: string;
  items?: any;
  order?: number;
  toolCallId?: string;
  placeholderId?: string;
  toolName?: string;
  args?: any;
  result?: any;
  metadata?: Record<string, any>;
  usage?: Record<string, any>;
  zipReferences?: ZipReference[];
  intermediateSteps?: any[];
  [key: string]: any;
}

interface StreamEventAdapterOptions {
  sessionId: string;
  forward?: (event: CanonicalStreamEvent) => Promise<void> | void;
  defaultMetadata?: Record<string, any>;
  toolMetadataResolver?: (toolName: string) => Record<string, any> | undefined;
}

interface ToolIdentifiers {
  toolCallId: string;
  placeholderId: string;
  order: number;
}

function generateId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 10)}`;
}

export class StreamEventAdapter {
  private readonly sessionId: string;
  private readonly forward?: (event: CanonicalStreamEvent) => Promise<void> | void;
  private readonly defaultMetadata: Record<string, any>;
  private readonly toolMetadataResolver?: (toolName: string) => Record<string, any> | undefined;

  private messageId: string | undefined;
  private voiceMetadata: VoiceMetadata | undefined;
  private toolPlaceholderIds = new Map<string, string>();
  private toolOrder = new Map<string, number>();
  private toolExecutionCounter = 0;
  private lastUsage: Record<string, any> | undefined;
  private lastZipReferences: ZipReference[] = [];
  private lastIntermediateSteps: any[] | undefined;
  private lastMetadata: Record<string, any> | undefined;
  private finalContent = '';

  constructor(options: StreamEventAdapterOptions) {
    this.sessionId = options.sessionId;
    this.forward = options.forward;
    this.defaultMetadata = options.defaultMetadata ?? {};
    this.toolMetadataResolver = options.toolMetadataResolver;
  }

  setVoiceMetadata(metadata: VoiceMetadata | undefined) {
    this.voiceMetadata = metadata;
  }

  setMessageId(messageId: string) {
    this.messageId = messageId;
  }

  getMessageId(): string | undefined {
    return this.messageId;
  }

  getUsage(): Record<string, any> | undefined {
    return this.lastUsage;
  }

  getZipReferences(): ZipReference[] {
    return this.lastZipReferences;
  }

  getIntermediateSteps(): any[] | undefined {
    return this.lastIntermediateSteps;
  }

  getFinalContent(): string {
    return this.finalContent;
  }

  getMetadata(): Record<string, any> | undefined {
    return this.lastMetadata;
  }

  resetToolTracking() {
    this.toolPlaceholderIds = new Map();
    this.toolOrder = new Map();
    this.toolExecutionCounter = 0;
  }

  async emitStart(payload: { messageId: string; metadata?: Record<string, any> }):
    Promise<CanonicalStreamEvent> {
    this.resetToolTracking();
    this.messageId = payload.messageId;

    const event = this.buildEvent('start', {
      messageId: payload.messageId,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitChunk(payload: { content: string } & Record<string, any>):
    Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('chunk', {
      content: payload.content
    });

    await this.forwardEvent(event);
    return event;
  }
  async emitThinking(payload: {
    content: string;
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('thinking', {
      content: payload.content,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitPlanUpdate(payload: {
    content: string;
    items?: any[];
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('plan_update', {
      content: payload.content,
      items: payload.items,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitToolStart(payload: {
    toolCallId?: string;
    placeholderId?: string;
    order?: number;
    toolName?: string;
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const identifiers = this.ensureToolIdentifiers(payload);
    const event = this.buildEvent('tool_start', {
      toolCallId: identifiers.toolCallId,
      placeholderId: identifiers.placeholderId,
      order: identifiers.order,
      toolName: payload.toolName,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitToolCall(payload: {
    toolCallId?: string;
    placeholderId?: string;
    order?: number;
    toolName?: string;
    args?: any;
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const identifiers = this.ensureToolIdentifiers(payload);
    const metadata = this.resolveToolMetadata(payload.toolName, payload.metadata);

    const event = this.buildEvent('tool-call', {
      toolCallId: identifiers.toolCallId,
      placeholderId: identifiers.placeholderId,
      order: identifiers.order,
      toolName: payload.toolName,
      args: payload.args,
      metadata
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitToolApprovalRequest(payload: {
    approvalId: string;
    toolCallId?: string;
    toolName?: string;
    input?: any;
    toolCall?: any;
    requestedAt?: string;
    expiresAt?: string;
    source?: string;
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const identifiers = this.ensureToolIdentifiers(payload);
    const metadata = this.resolveToolMetadata(payload.toolName, payload.metadata);

    const event = this.buildEvent('tool_approval_request', {
      approvalId: payload.approvalId,
      toolCallId: identifiers.toolCallId,
      toolName: payload.toolName,
      input: payload.input,
      toolCall: payload.toolCall,
      requestedAt: payload.requestedAt,
      expiresAt: payload.expiresAt,
      source: payload.source,
      metadata
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitToolResult(payload: {
    toolCallId?: string;
    placeholderId?: string;
    order?: number;
    toolName?: string;
    args?: any;
    result?: any;
    metadata?: Record<string, any>;
    zipReferences?: ZipReference[];
  }): Promise<CanonicalStreamEvent> {
    const identifiers = this.ensureToolIdentifiers(payload);
    const metadata = this.resolveToolMetadata(payload.toolName, payload.metadata);

    const event = this.buildEvent('tool-result', {
      toolCallId: identifiers.toolCallId,
      placeholderId: identifiers.placeholderId,
      order: identifiers.order,
      toolName: payload.toolName,
      args: payload.args,
      result: payload.result,
      metadata,
      zipReferences: payload.zipReferences
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitToolEnd(payload: {
    toolCallId?: string;
    placeholderId?: string;
    order?: number;
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const identifiers = this.ensureToolIdentifiers(payload);
    const event = this.buildEvent('tool_end', {
      toolCallId: identifiers.toolCallId,
      placeholderId: identifiers.placeholderId,
      order: identifiers.order,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitFinish(payload: { usage?: Record<string, any> }):
    Promise<CanonicalStreamEvent> {
    if (payload.usage) {
      this.lastUsage = payload.usage;
    }

    const event = this.buildEvent('finish', {
      usage: payload.usage
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitEnd(payload: {
    content: string;
    intermediateSteps?: any[];
    zipReferences?: ZipReference[];
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    this.finalContent = payload.content;
    this.lastIntermediateSteps = payload.intermediateSteps;
    this.lastZipReferences = payload.zipReferences ?? [];
    this.lastMetadata = this.mergeMetadata(payload.metadata);

    const event = this.buildEvent('end', {
      content: payload.content,
      intermediateSteps: payload.intermediateSteps,
      zipReferences: payload.zipReferences,
      metadata: this.lastMetadata
    });

    await this.forwardEvent(event);
    this.resetToolTracking();
    return event;
  }

  async emitComplete(
    payload: { metadata?: Record<string, any> } = {}
  ): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('complete', {
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  async emitError(payload: { error: string; metadata?: Record<string, any> }):
    Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('error', {
      error: payload.error,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  /**
   * SA-010: Emit a generated file (image, etc.) from multimodal models
   * Used by models like Gemini 2.5 Flash Image that return files via result.files
   */
  async emitFile(payload: {
    base64: string;
    mediaType: string;
    index?: number;
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('file', {
      base64: payload.base64,
      mediaType: payload.mediaType,
      index: payload.index ?? 0,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  /**
   * SA-011: Emit generated audio from TTS/speech models
   * Used by models like OpenAI TTS, ElevenLabs, Fal speech models
   */
  async emitAudio(payload: {
    audioData: string;    // Base64-encoded audio data
    mediaType: string;    // e.g., 'audio/mp3', 'audio/wav'
    index?: number;
    duration?: number;    // Duration in seconds if known
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('audio', {
      audioData: payload.audioData,
      mediaType: payload.mediaType,
      index: payload.index ?? 0,
      duration: payload.duration,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  /**
   * SA-011 Phase 4: Emit a partial structured object during streaming
   * Used by structured output streaming (streamText + Output.object)
   */
  async emitObjectPartial(payload: {
    object: any;          // The partial object (fields may be incomplete)
    index?: number;       // Update index for ordering
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('object_partial', {
      object: payload.object,
      index: payload.index ?? 0,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  /**
   * SA-011 Phase 4: Emit the final complete structured object
   * Sent after all partial updates are complete
   */
  async emitObjectFinal(payload: {
    object: any;          // The complete, validated object
    metadata?: Record<string, any>;
  }): Promise<CanonicalStreamEvent> {
    const event = this.buildEvent('object_final', {
      object: payload.object,
      metadata: this.mergeMetadata(payload.metadata)
    });

    await this.forwardEvent(event);
    return event;
  }

  private async forwardEvent(event: CanonicalStreamEvent): Promise<void> {
    if (!this.forward) {
      return;
    }

    await this.forward(event);
  }

  private buildEvent(type: StreamEventType, payload: Record<string, any>): CanonicalStreamEvent {
    const messageId = payload.messageId ?? this.messageId;
    return {
      ...payload,
      type,
      sessionId: this.sessionId,
      messageId
    };
  }

  private ensureToolIdentifiers(
    payload: { toolCallId?: string; placeholderId?: string; order?: number }
  ): ToolIdentifiers {
    let toolCallId = payload.toolCallId;
    if (!toolCallId) {
      toolCallId = generateId('tool');
    }

    let placeholderId = this.toolPlaceholderIds.get(toolCallId);
    if (!placeholderId) {
      placeholderId = payload.placeholderId ?? `tool_placeholder_${toolCallId}`;
      this.toolPlaceholderIds.set(toolCallId, placeholderId);
    }

    let order = this.toolOrder.get(toolCallId);
    if (typeof payload.order === 'number') {
      order = payload.order;
      this.toolOrder.set(toolCallId, order);
    } else if (order === undefined) {
      order = this.toolExecutionCounter++;
      this.toolOrder.set(toolCallId, order);
    }

    return { toolCallId, placeholderId, order };
  }

  private resolveToolMetadata(
    toolName?: string,
    providedMetadata?: Record<string, any>
  ): Record<string, any> | undefined {
    const resolved = toolName && this.toolMetadataResolver
      ? this.toolMetadataResolver(toolName)
      : undefined;

    if (!resolved && !providedMetadata && !this.voiceMetadata) {
      return undefined;
    }

    return this.mergeMetadata({
      ...(resolved ?? {}),
      ...(providedMetadata ?? {})
    });
  }

  private mergeMetadata(
    metadata: Record<string, any> | undefined
  ): Record<string, any> | undefined {
    const merged = {
      ...this.defaultMetadata,
      ...(metadata ?? {})
    };

    if (this.voiceMetadata) {
      merged.voice = {
        stt: this.voiceMetadata.stt ?? false,
        tts: this.voiceMetadata.tts ?? false,
        voiceMode: this.voiceMetadata.voiceMode ?? (this.voiceMetadata.tts ? 'voice' : 'text'),
        realtime: this.voiceMetadata.realtime ?? false,
        provider: this.voiceMetadata.provider ?? null,
        model: this.voiceMetadata.model ?? null,
        voiceId: this.voiceMetadata.voiceId ?? null,
        profileId: this.voiceMetadata.profileId ?? null,
        common: this.voiceMetadata.common ?? undefined,
        providerOptions: this.voiceMetadata.providerOptions ?? undefined,
        style: this.voiceMetadata.style ?? undefined
      };
      merged.stt = merged.voice.stt;
      merged.tts = merged.voice.tts;
      merged.voiceMode = merged.voice.voiceMode;
      merged.realtime = merged.voice.realtime;
      merged.voiceProvider = merged.voice.provider;
      merged.voiceModel = merged.voice.model;
      merged.voiceId = merged.voice.voiceId;
    }

    return Object.keys(merged).length > 0 ? merged : undefined;
  }
}
