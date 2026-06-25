import { redisStreamService } from '$lib/server/redisStreamService';
import { createPermanentZip } from '$lib/server/zipService';
import type { ZipReference } from '$lib/server/zipService';
import { getTypeZipSettings } from '$lib/utils/toolRenderMap';

type ZipType = 'error';

interface ZipPattern {
  open: RegExp;
  close: string;
  type: ZipType;
}

interface StreamProcessingResult {
  shouldStream: boolean;
  content: string;
}

// Only zip explicit XML blocks we still care about; leave fenced code alone.
// Tools/terminal/diff are not zipped here; Mode 3/4 handle tools via cool_tool markers.
const zipPatterns: ZipPattern[] = [
  { open: /<error>/i, close: '</error>', type: 'error' },
];

function createBufferKey(sessionId: string, messageId: string) {
  return `${sessionId}:${messageId}`;
}

export class ZipDetectionService {
  private readonly streamingBuffers = new Map<string, { type: ZipType; startIndex: number; metadata?: any }>();
  private readonly messageZipReferences = new Map<string, ZipReference[]>();
  private readonly messageContexts = new Map<string, { agent?: any; globalSettings?: any; messagesFromEnd?: number }>();

  setContext(
    sessionId: string,
    messageId: string,
    context: { agent?: any; globalSettings?: any; messagesFromEnd?: number }
  ) {
    const key = createBufferKey(sessionId, messageId);
    this.messageContexts.set(key, context);
  }

  private getContext(sessionId: string, messageId: string) {
    const key = createBufferKey(sessionId, messageId);
    return this.messageContexts.get(key);
  }

  private clearContext(sessionId: string, messageId: string) {
    const key = createBufferKey(sessionId, messageId);
    this.messageContexts.delete(key);
  }

  deleteSessionBuffers(sessionId: string) {
    const prefix = `${sessionId}:`;
    for (const key of this.streamingBuffers.keys()) {
      if (key.startsWith(prefix)) {
        this.streamingBuffers.delete(key);
      }
    }
    for (const key of this.messageContexts.keys()) {
      if (key.startsWith(prefix)) {
        this.messageContexts.delete(key);
      }
    }
  }

  clearMessageReferences(messageKey: string) {
    this.messageZipReferences.delete(messageKey);
  }

  getMessageReferences(sessionId: string, messageId: string): ZipReference[] {
    return [...(this.messageZipReferences.get(`${sessionId}:${messageId}`) || [])];
  }

  async finalizeOpenBlocks(sessionId: string, messageId: string): Promise<ZipReference[]> {
    const references: ZipReference[] = [];
    const bufferKey = createBufferKey(sessionId, messageId);
    this.streamingBuffers.delete(bufferKey);
    this.clearContext(sessionId, messageId);

    const messageKey = `${sessionId}:${messageId}`;
    const tracked = this.messageZipReferences.get(messageKey) || [];

    for (const ref of tracked) {
      references.push(ref);
    }

    // Finalize any blocks still tracked in Redis (defensive: Mode 2 sometimes ends without closing tags)
    const activeBlocks = await redisStreamService.getActiveZipBlocks(sessionId, messageId)
    for (const block of activeBlocks) {
      const result = await createPermanentZip(
        sessionId,
        messageId,
        block.type,
        block.index,
        {
          language: (block as any).language,
          path: (block as any).path
        }
      )
      if (result) {
        references.push({
          zipId: result.zipId,
          placeholder: `{{ZIP_PLACEHOLDER_${block.type}_${block.index}}}`,
          reference: result.reference
        })
      }
    }

    this.messageZipReferences.delete(messageKey);

    return references;
  }

  async processChunk(
    sessionId: string,
    messageId: string,
    content: string
  ): Promise<StreamProcessingResult> {
    const bufferKey = createBufferKey(sessionId, messageId);
    const currentBuffer = this.streamingBuffers.get(bufferKey);
    const context = this.getContext(sessionId, messageId);

    if (currentBuffer) {
      const pattern = zipPatterns.find((p) => p.type === currentBuffer.type);
      if (pattern) {
        const closeIdx = content.indexOf(pattern.close);
        if (closeIdx !== -1) {
          const beforeClose = content.substring(0, closeIdx);
          const afterClose = content.substring(closeIdx + pattern.close.length);

          const tempKey = redisStreamService.createTempStorageKey(
            sessionId,
            messageId,
            currentBuffer.type,
            currentBuffer.startIndex
          );
          if (beforeClose) {
            await redisStreamService.appendChunk(tempKey, beforeClose);
          }

          const settings = getTypeZipSettings(
            currentBuffer.type,
            context?.agent,
            context?.globalSettings
          );
          const result = await createPermanentZip(
            sessionId,
            messageId,
            currentBuffer.type,
            currentBuffer.startIndex,
            {
              ...currentBuffer.metadata,
              bufferSize: settings.bufferSize,
              threshold: settings.zipThreshold,
              messagesFromEnd: context?.messagesFromEnd ?? 0
            }
          );

          if (result) {
            this.addZipReference(sessionId, messageId, currentBuffer.type, currentBuffer.startIndex, result.zipId, result.reference);
            this.streamingBuffers.delete(bufferKey);
            return {
              shouldStream: true,
              // Stream the final reference immediately so the client never sees placeholders
              content: result.reference + afterClose
            };
          }

          this.streamingBuffers.delete(bufferKey);
          return { shouldStream: true, content: beforeClose + afterClose };
        } else {
          const tempKey = redisStreamService.createTempStorageKey(
            sessionId,
            messageId,
            currentBuffer.type,
            currentBuffer.startIndex
          );
          await redisStreamService.appendChunk(tempKey, content);
          return { shouldStream: false, content: '' };
        }
      }
    }

    for (const pattern of zipPatterns) {
      if (pattern.open instanceof RegExp) {
        const match = pattern.open.exec(content);
        if (match) {
          const openIndex = match.index;
          const fullMatch = match[0];

          const beforeTag = content.substring(0, openIndex);
          const afterTag = content.substring(openIndex + fullMatch.length);

          const blockIndex = await redisStreamService.trackConcurrentBlock(sessionId, messageId, pattern.type);

          const metadata: any = {};

          const settings = getTypeZipSettings(
            pattern.type,
            context?.agent,
            context?.globalSettings
          );
          metadata.bufferSize = settings.bufferSize;
          metadata.threshold = settings.zipThreshold;
          metadata.messagesFromEnd = context?.messagesFromEnd ?? 0;

          this.streamingBuffers.set(bufferKey, {
            type: pattern.type,
            startIndex: blockIndex,
            metadata
          });

          if (afterTag) {
            const tempKey = redisStreamService.createTempStorageKey(sessionId, messageId, pattern.type, blockIndex);
            const closeIdx = afterTag.indexOf(pattern.close);
            if (closeIdx !== -1) {
              const blockContent = afterTag.substring(0, closeIdx);
              const afterBlock = afterTag.substring(closeIdx + pattern.close.length);

              await redisStreamService.appendChunk(tempKey, blockContent);

              const result = await createPermanentZip(
                sessionId,
                messageId,
                pattern.type,
                blockIndex,
                metadata
              );

              if (result) {
                this.addZipReference(sessionId, messageId, pattern.type, blockIndex, result.zipId, result.reference);
                this.streamingBuffers.delete(bufferKey);
                return {
                  shouldStream: true,
                  // Stream the final reference immediately so the client never sees placeholders
                  content: beforeTag + result.reference + afterBlock
                };
              }

              this.streamingBuffers.delete(bufferKey);
              return {
                shouldStream: true,
                content: beforeTag + blockContent + afterBlock
              };
            } else {
              await redisStreamService.appendChunk(tempKey, afterTag);

              if (beforeTag) {
                return { shouldStream: true, content: beforeTag };
              }

              return { shouldStream: false, content: '' };
            }
          }

          if (beforeTag) {
            return { shouldStream: true, content: beforeTag };
          }
        }
      }
    }

    return { shouldStream: true, content };
  }

  async processFullContent(
    sessionId: string,
    messageId: string,
    content: string,
    options?: { agent?: any; globalSettings?: any; messagesFromEnd?: number }
  ): Promise<{ content: string; references: ZipReference[] }> {
    if (options) {
      this.setContext(sessionId, messageId, options)
    }
    let previous: string | null = null;
    let current = content;
    let iterations = 0;

    while (current !== previous && iterations < 50) {
      previous = current;
      const result = await this.processChunk(sessionId, messageId, current);
      current = result.content;

      if (!result.shouldStream) {
        break;
      }

      iterations += 1;
    }

    const references = await this.finalizeOpenBlocks(sessionId, messageId);
    this.deleteSessionBuffers(sessionId);

    return {
      content: current,
      references
    };
  }

  private addZipReference(
    sessionId: string,
    messageId: string,
    type: ZipType,
    index: number,
    zipId: string,
    reference: string
  ) {
    const messageKey = `${sessionId}:${messageId}`;
    if (!this.messageZipReferences.has(messageKey)) {
      this.messageZipReferences.set(messageKey, []);
    }

    this.messageZipReferences.get(messageKey)!.push({
      zipId,
      placeholder: `{{ZIP_PLACEHOLDER_${type}_${index}}}`,
      reference
    });
  }
}
