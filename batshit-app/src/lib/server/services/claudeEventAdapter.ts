import path from 'node:path'
import type { NativeModeRequest } from './vercelBrain'
import { extractAndStripToolZipControl } from './toolZipControlNotice'
import { mapBashCommandToMode4Tool } from './bashCommandMapper'
import { hasSubagentToolSegment } from '$lib/utils/toolNameNormalization'
import {
  unwrapStructuredToolValue,
  unwrapSubagentToolResult
} from '$lib/utils/toolPayloadUnwrap'

export type ClaudeStreamChunk =
  | { type: 'text-delta'; text: string }
  | { type: 'tool-call'; toolCallId: string; toolName: string; args?: Record<string, any> }
  | { type: 'tool-result'; toolCallId: string; toolName: string; args?: Record<string, any>; result?: any; metadata?: Record<string, any> }
  | {
      type: 'finish'
      totalUsage?: ClaudeUsageSummary
      usage?: ClaudeUsageSummary
    }
  | { type: 'thinking'; itemId: string; content: string; final?: boolean }

type ClaudeUsageSummary = {
  inputTokens?: number
  outputTokens?: number
  totalTokens?: number
  cachedInputTokens?: number
  cacheCreationInputTokens?: number
}

interface ClaudeEventAdapterOptions {
  request: NativeModeRequest
  transport: 'cli'
  onFinish?: (payload: {
    text: string
    steps: any[]
    totalUsage?: ClaudeUsageSummary
    reasoning?: string[]
  }) => Promise<void> | void
}

interface ClaudeToolState {
  id: string
  originalName: string
  toolName: string
  args?: Record<string, any>
  startTimestamp: number
  emitted: boolean
}

function mapBashCommandToTool(command: string): { toolName: string; args: Record<string, any> } {
  const mapped = mapBashCommandToMode4Tool(command)
  return {
    toolName: mapped.toolName,
    args: mapped.args
  }
}

function normalizeToolName(name: string, args?: Record<string, any>) {
  const lowerName = name.toLowerCase()

  if (lowerName === 'web_search' || lowerName === 'websearch') {
    return {
      toolName: 'claude_web_search',
      args: args ?? {}
    }
  }

  if (name.startsWith('mcp__')) {
    const parts = name.split('__').filter(Boolean)
    const server = parts[1] || 'unknown'
    const tool = parts.slice(2).join('__') || 'tool'
    return {
      toolName: `mcp.${server}.${tool}`,
      args: args ?? {}
    }
  }

  if (name.startsWith('mcp.')) {
    return { toolName: name, args: args ?? {} }
  }

  if (name === 'Read') {
    const filePath = args?.file_path ?? args?.filePath ?? args?.path
    return {
      toolName: 'batshit_server_read_file',
      args: {
        ...args,
        ...(filePath ? { filePath, path: filePath } : {})
      }
    }
  }

  if (name === 'Write') {
    const filePath = args?.file_path ?? args?.filePath ?? args?.path
    return {
      toolName: 'batshit_server_overwrite_file',
      args: {
        ...args,
        ...(filePath ? { filePath, path: filePath } : {})
      }
    }
  }

  if (name === 'Edit') {
    const filePath = args?.file_path ?? args?.filePath ?? args?.path
    return {
      toolName: 'batshit_server_edit_file',
      args: {
        ...args,
        ...(filePath ? { filePath, path: filePath } : {}),
        ...(args?.old_string ? { oldString: args.old_string } : {}),
        ...(args?.new_string ? { newString: args.new_string } : {})
      }
    }
  }

  if (name === 'Bash') {
    const command = typeof args?.command === 'string' ? args.command : ''
    const mapped = mapBashCommandToTool(command)
    return {
      toolName: mapped.toolName,
      args: {
        ...(args ?? {}),
        ...mapped.args
      }
    }
  }

  if (name === 'Grep') {
    return {
      toolName: 'batshit_server_search_files',
      args: {
        ...(args ?? {}),
        ...(typeof args?.pattern === 'string' ? { query: args.pattern } : {}),
        ...(typeof args?.path === 'string' ? { filePath: args.path } : {})
      }
    }
  }

  return { toolName: name, args: args ?? {} }
}

function formatStructuredPatch(patches: any): string {
  if (!Array.isArray(patches)) return ''
  const lines: string[] = []
  for (const patch of patches) {
    if (Array.isArray(patch?.lines)) {
      for (const line of patch.lines) {
        if (typeof line === 'string') lines.push(line)
      }
    }
  }
  return lines.join('\n')
}

function findSubagentResultMetadata(
  raw: any,
  depth = 0,
  seen = new WeakSet<object>()
): Record<string, any> | null {
  if (raw == null || depth > 8) return null

  if (typeof raw === 'string') {
    try {
      return findSubagentResultMetadata(JSON.parse(raw), depth + 1, seen)
    } catch {
      return null
    }
  }

  if (Array.isArray(raw)) {
    for (const item of raw) {
      const found = findSubagentResultMetadata(item, depth + 1, seen)
      if (found) return found
    }
    return null
  }

  if (typeof raw !== 'object') return null

  const obj = raw as Record<string, any>
  if (seen.has(obj)) return null
  seen.add(obj)

  if (
    typeof obj.subagentType === 'string' ||
    typeof obj.subagent_type === 'string' ||
    typeof obj.toolSource === 'string' ||
    typeof obj.tool_source === 'string'
  ) {
    return obj
  }

  for (const key of [
    'output',
    'result',
    'toolResult',
    'tool_result',
    'data',
    'structuredContent',
    'structured_content',
    'content',
    'text',
    'value'
  ]) {
    const found = findSubagentResultMetadata(obj[key], depth + 1, seen)
    if (found) return found
  }

  return null
}

function stripClaudeToolErrorTags(value: string): string {
  return value.replace(/<\/?tool_use_error>/gi, '').trim()
}

function parseClaudeLinksString(value: string): Array<Record<string, any>> {
  const match = value.match(/Links:\s*(\[[\s\S]*?\])(?:\n|$)/i)
  if (!match?.[1]) return []
  try {
    const parsed = JSON.parse(match[1])
    return Array.isArray(parsed) ? parsed : []
  } catch {
    return []
  }
}

function collectClaudeWebSearchResults(
  value: any,
  results: Array<Record<string, any>>,
  summaries: string[],
  depth = 0
) {
  if (depth > 8 || value === null || value === undefined) return

  if (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    ((value as any)?.type === 'web_search_result' ||
      (value as any)?.url ||
      (value as any)?.title ||
      (value as any)?.link ||
      (value as any)?.href)
  ) {
    results.push({
      ...value,
      title: (value as any)?.title ?? (value as any)?.url ?? (value as any)?.name ?? 'Search result',
      url: (value as any)?.url ?? (value as any)?.link ?? (value as any)?.href,
      snippet:
        (value as any)?.snippet ??
        (value as any)?.summary ??
        (value as any)?.description ??
        (typeof (value as any)?.content === 'string' ? (value as any).content : undefined) ??
        (value as any)?.text
    })
    return
  }

  const unwrapped = unwrapStructuredToolValue(value)

  if (typeof unwrapped === 'string') {
    const trimmed = stripClaudeToolErrorTags(unwrapped)
    if (!trimmed) return

    const parsedLinks = parseClaudeLinksString(trimmed)
    if (parsedLinks.length > 0) {
      collectClaudeWebSearchResults(parsedLinks, results, summaries, depth + 1)
      const summary = trimmed.replace(/Links:\s*\[[\s\S]*?\](?:\n|$)?/i, '').trim()
      if (summary) summaries.push(summary)
      return
    }

    summaries.push(trimmed)
    return
  }

  if (Array.isArray(unwrapped)) {
    for (const entry of unwrapped) {
      collectClaudeWebSearchResults(entry, results, summaries, depth + 1)
    }
    return
  }

  if (!unwrapped || typeof unwrapped !== 'object') return

  const nestedContent =
    Array.isArray((unwrapped as any).content) ? (unwrapped as any).content : null
  if (nestedContent) {
    collectClaudeWebSearchResults(nestedContent, results, summaries, depth + 1)
  }

  const nestedResults =
    Array.isArray((unwrapped as any).results) ? (unwrapped as any).results : null
  if (nestedResults) {
    collectClaudeWebSearchResults(nestedResults, results, summaries, depth + 1)
  }

  const nestedSources =
    Array.isArray((unwrapped as any).sources) ? (unwrapped as any).sources : null
  if (nestedSources) {
    collectClaudeWebSearchResults(nestedSources, results, summaries, depth + 1)
  }

  const nestedItems =
    Array.isArray((unwrapped as any).items) ? (unwrapped as any).items : null
  if (nestedItems) {
    collectClaudeWebSearchResults(nestedItems, results, summaries, depth + 1)
  }

  if (
    (unwrapped as any)?.type === 'web_search_result' ||
    (unwrapped as any)?.url ||
    (unwrapped as any)?.title ||
    (unwrapped as any)?.link ||
    (unwrapped as any)?.href
  ) {
    results.push({
      ...unwrapped,
      title: (unwrapped as any)?.title ?? (unwrapped as any)?.url ?? (unwrapped as any)?.name ?? 'Search result',
      url: (unwrapped as any)?.url ?? (unwrapped as any)?.link ?? (unwrapped as any)?.href,
      snippet:
        (unwrapped as any)?.snippet ??
        (unwrapped as any)?.summary ??
        (unwrapped as any)?.description ??
        (typeof (unwrapped as any)?.content === 'string' ? (unwrapped as any).content : undefined) ??
        (unwrapped as any)?.text
    })
  }
}

function normalizeClaudeWebSearchResults(rawResults: any): {
  results: Array<Record<string, any>>
  summaries: string[]
} {
  const results: Array<Record<string, any>> = []
  const summaries: string[] = []
  collectClaudeWebSearchResults(rawResults, results, summaries)

  const dedupedResults = results.filter((entry, index) => {
    const key = `${entry.title ?? ''}::${entry.url ?? ''}`
    return results.findIndex((candidate) => `${candidate.title ?? ''}::${candidate.url ?? ''}` === key) === index
  })

  return {
    results: dedupedResults,
    summaries: Array.from(new Set(summaries.filter((entry) => entry.trim().length > 0)))
  }
}

function buildClaudeWebSearchResult(rawValue: any) {
  const unwrapped = unwrapStructuredToolValue(rawValue)
  const rawResults =
    Array.isArray((unwrapped as any)?.results)
      ? (unwrapped as any).results
      : Array.isArray((unwrapped as any)?.sources)
        ? (unwrapped as any).sources
        : Array.isArray((unwrapped as any)?.content)
          ? (unwrapped as any).content
          : Array.isArray(unwrapped)
            ? unwrapped
            : unwrapped
  const normalized = normalizeClaudeWebSearchResults(rawResults)
  const summary = normalized.summaries[0]
  return {
    ...((unwrapped && typeof unwrapped === 'object' && !Array.isArray(unwrapped)) ? unwrapped : {}),
    ...(summary ? { summary } : {}),
    results: normalized.results,
    totalMatches:
      Math.max(
        (unwrapped as any)?.totalMatches ??
          (unwrapped as any)?.total_matches ??
          (unwrapped as any)?.count ??
          0,
        normalized.results.length
      )
  }
}

function normalizeToolErrorMessage(rawToolResult: any, fallbackContent?: any): string {
  const candidates = [rawToolResult, fallbackContent]
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && candidate.trim().length > 0) {
      return stripClaudeToolErrorTags(candidate)
    }
  }

  const text = coerceText(fallbackContent ?? rawToolResult)
  return stripClaudeToolErrorTags(text || 'Tool error')
}

function buildToolResult(toolName: string, toolUseResult: any, fallbackContent?: any) {
  const isSubagentCall = hasSubagentToolSegment(toolName)
  if (isSubagentCall) {
    return unwrapSubagentToolResult(toolUseResult ?? fallbackContent)
  }

  if (!toolUseResult && fallbackContent) {
    return fallbackContent
  }

  if (!toolUseResult) return fallbackContent

  if (toolName === 'claude_web_search') {
    return buildClaudeWebSearchResult(toolUseResult ?? fallbackContent)
  }

  if (toolName === 'batshit_server_read_file') {
    const file = toolUseResult.file || toolUseResult
    const filePath = file?.filePath || toolUseResult.filePath
    return {
      filePath,
      content: file?.content ?? fallbackContent ?? '',
      lineCount: file?.numLines ?? file?.totalLines
    }
  }

  if (toolName === 'batshit_server_overwrite_file') {
    return {
      filePath: toolUseResult.filePath,
      content: toolUseResult.content ?? fallbackContent ?? '',
      structuredPatch: toolUseResult.structuredPatch ?? null
    }
  }

  if (toolName === 'batshit_server_edit_file') {
    const diff = formatStructuredPatch(toolUseResult.structuredPatch)
    return {
      filePath: toolUseResult.filePath,
      diff: diff || undefined,
      structuredPatch: toolUseResult.structuredPatch ?? null,
      originalFile: toolUseResult.originalFile,
      oldString: toolUseResult.oldString,
      newString: toolUseResult.newString,
      content: fallbackContent
    }
  }

  if (toolName === 'batshit_server_execute_command') {
    return {
      stdout: toolUseResult.stdout ?? fallbackContent ?? '',
      stderr: toolUseResult.stderr ?? '',
      interrupted: toolUseResult.interrupted,
      isImage: toolUseResult.isImage
    }
  }

  if (toolName === 'batshit_server_list_files') {
    const stdout = toolUseResult.stdout ?? fallbackContent ?? ''
    return {
      output: stdout,
      stdout,
      stderr: toolUseResult.stderr ?? '',
      interrupted: toolUseResult.interrupted,
      isImage: toolUseResult.isImage
    }
  }

  if (toolName === 'batshit_server_search_files') {
    const baseDir =
      typeof toolUseResult?.filePath === 'string'
        ? toolUseResult.filePath
        : typeof toolUseResult?.path === 'string'
          ? toolUseResult.path
          : typeof toolUseResult?.input?.filePath === 'string'
            ? toolUseResult.input.filePath
            : typeof toolUseResult?.input?.path === 'string'
              ? toolUseResult.input.path
              : null
    const filenames = Array.isArray(toolUseResult?.filenames)
      ? toolUseResult.filenames.filter((entry: unknown): entry is string => typeof entry === 'string')
      : []

    if (filenames.length > 0) {
      return {
        query:
          typeof toolUseResult?.query === 'string'
            ? toolUseResult.query
            : typeof toolUseResult?.pattern === 'string'
              ? toolUseResult.pattern
              : typeof toolUseResult?.input?.pattern === 'string'
                ? toolUseResult.input.pattern
                : undefined,
        totalMatches:
          typeof toolUseResult?.numFiles === 'number' ? toolUseResult.numFiles : filenames.length,
        totalMatchingFiles:
          typeof toolUseResult?.numFiles === 'number' ? toolUseResult.numFiles : filenames.length,
        results: filenames.map((filename: string) => ({
          path:
            path.isAbsolute(filename) || !baseDir
              ? filename
              : path.join(baseDir, filename),
          matchCount: 1,
          matches: []
        }))
      }
    }
  }

  return toolUseResult
}

function coerceText(val: any): string {
  if (typeof val === 'string') return val
  if (Array.isArray(val)) {
    return val
      .map((item) => {
        if (typeof item === 'string') return item
        if (item && typeof item === 'object' && typeof item.text === 'string') return item.text
        return ''
      })
      .join('')
  }
  if (val && typeof val === 'object') {
    if (typeof val.text === 'string') return val.text
    if (typeof val.content === 'string') return val.content
  }
  return String(val ?? '')
}

export class ClaudeEventAdapter {
  private readonly request: NativeModeRequest
  private readonly transport: 'cli'
  private readonly onFinish?: ClaudeEventAdapterOptions['onFinish']
  private readonly toolStates = new Map<string, ClaudeToolState>()
  private readonly intermediateSteps: any[] = []
  private readonly rawEvents: any[] = []
  private readonly toolInputBuffers = new Map<string, string>()
  private readonly toolIndexMap = new Map<number, string>()
  private readonly thinkingIndexMap = new Map<number, string>()
  private readonly thinkingSegments = new Map<string, string>()
  private readonly thinkingOrder: string[] = []
  private finalText = ''
  private latestAssistantText = ''
  private sawTextDelta = false
  private usageSummary:
    | ClaudeUsageSummary
    | undefined
  private completed = false

  constructor(options: ClaudeEventAdapterOptions) {
    this.request = options.request
    this.transport = options.transport
    this.onFinish = options.onFinish
  }

  async *stream(events: AsyncGenerator<any>): AsyncGenerator<ClaudeStreamChunk> {
    try {
      for await (const event of events) {
        this.rawEvents.push(event)
        if (!event || typeof event !== 'object') continue

        if (event.type === 'stream_event') {
          yield* this.handleStreamEvent(event)
          continue
        }

        if (event.type === 'assistant' && event.message) {
          yield* this.handleAssistantMessage(event.message)
          continue
        }

        if (event.type === 'user' && event.message) {
          yield* this.handleUserMessage(event.message, event.tool_use_result)
          continue
        }

        if (event.type === 'result') {
          yield this.handleResultEvent(event)
          continue
        }
      }
    } finally {
      await this.finalize()
    }
  }

  private *handleStreamEvent(event: any): Generator<ClaudeStreamChunk> {
    const inner = event.event
    if (!inner || typeof inner !== 'object') return

    if (inner.type === 'content_block_start') {
      const block = inner.content_block
      if (block?.type === 'thinking') {
        const blockId =
          typeof block.id === 'string' && block.id.length > 0
            ? block.id
            : `thinking_${inner.index ?? Date.now()}`
        if (typeof inner.index === 'number') {
          this.thinkingIndexMap.set(inner.index, blockId)
        }
        const seed =
          typeof block.thinking === 'string'
            ? block.thinking
            : typeof block.text === 'string'
              ? block.text
              : typeof block.content === 'string'
                ? block.content
                : ''
        const chunk = this.updateThinking(blockId, seed, { replace: true, final: false })
        if (chunk) yield chunk
      }
      if (block?.type === 'tool_use' || block?.type === 'server_tool_use') {
        const toolId = block.id
        const toolName = block.name
        if (typeof toolId === 'string' && typeof toolName === 'string') {
          this.toolIndexMap.set(inner.index, toolId)
          const state: ClaudeToolState = {
            id: toolId,
            originalName: toolName,
            toolName,
            args: block.input ?? {},
            startTimestamp: Date.now(),
            emitted: false
          }
          this.toolStates.set(toolId, state)
          if (block.input && Object.keys(block.input).length > 0) {
            const chunk = this.updateToolState(state, block.input)
            if (chunk) yield chunk
          }
        }
      }
      if (block?.type === 'web_search_tool_result' || block?.type === 'web_search_tool_result_error') {
        const pendingToolId =
          typeof block.tool_use_id === 'string'
            ? block.tool_use_id
            : Array.from(this.toolStates.values()).find((state) => state.toolName === 'claude_web_search')?.id
        if (!pendingToolId) return
        const state = this.toolStates.get(pendingToolId)
        if (state && !state.emitted) {
          yield this.emitToolCall(state)
        }
        const chunk = this.emitResolvedToolResult(
          pendingToolId,
          block.content,
          block.content,
          block?.type === 'web_search_tool_result_error'
        )
        if (chunk) yield chunk
      }
      return
    }

    if (inner.type === 'content_block_delta') {
      const delta = inner.delta
      if (delta?.type === 'text_delta' && typeof delta.text === 'string') {
        this.sawTextDelta = true
        this.finalText += delta.text
        yield { type: 'text-delta', text: delta.text }
        return
      }

      if (delta?.type === 'thinking_delta') {
        const blockId =
          typeof inner.index === 'number'
            ? this.thinkingIndexMap.get(inner.index) ?? `thinking_${inner.index}`
            : `thinking_${Date.now()}`
        const text =
          typeof delta.text === 'string'
            ? delta.text
            : typeof delta.thinking === 'string'
              ? delta.thinking
              : typeof delta.content === 'string'
                ? delta.content
                : ''
        const chunk = this.updateThinking(blockId, text, { replace: false, final: false })
        if (chunk) yield chunk
        return
      }

      if (delta?.type === 'input_json_delta') {
        const toolId = this.toolIndexMap.get(inner.index)
        if (!toolId) return
        const current = this.toolInputBuffers.get(toolId) ?? ''
        const next = `${current}${delta.partial_json ?? ''}`
        this.toolInputBuffers.set(toolId, next)
        const parsed = this.tryParseJson(next)
        if (parsed && typeof parsed === 'object') {
          const state = this.toolStates.get(toolId)
          if (state) {
            const chunk = this.updateToolState(state, parsed)
            if (chunk) yield chunk
          }
        }
      }
    }

    if (inner.type === 'content_block_stop') {
      if (typeof inner.index !== 'number') return
      const blockId = this.thinkingIndexMap.get(inner.index)
      if (!blockId) return
      const content = this.thinkingSegments.get(blockId) ?? ''
      if (content.trim().length > 0) {
        yield { type: 'thinking', itemId: blockId, content, final: true }
      }
      this.thinkingIndexMap.delete(inner.index)
    }
  }

  private *handleAssistantMessage(message: any): Generator<ClaudeStreamChunk> {
    const content = Array.isArray(message.content) ? message.content : []

    const textBlocks = content.filter((block: any) => block?.type === 'text')
    if (textBlocks.length > 0) {
      const combined = textBlocks.map((block: any) => coerceText(block.text)).join('')
      if (combined && combined.length > this.latestAssistantText.length) {
        this.latestAssistantText = combined
      }
      if (!this.sawTextDelta && combined) {
        this.finalText = combined
        yield { type: 'text-delta', text: combined }
      }
    }

    for (const block of content) {
      if (block?.type !== 'tool_use' && block?.type !== 'server_tool_use') continue
      const toolId = block.id
      const name = block.name
      if (typeof toolId !== 'string' || typeof name !== 'string') continue
      let state = this.toolStates.get(toolId)
      if (!state) {
        state = {
          id: toolId,
          originalName: name,
          toolName: name,
          args: block.input ?? {},
          startTimestamp: Date.now(),
          emitted: false
        }
        this.toolStates.set(toolId, state)
      }
      const chunk = this.updateToolState(state, block.input ?? {})
      if (chunk) {
        yield chunk
      }
    }

    for (const block of content) {
      if (block?.type !== 'web_search_tool_result' && block?.type !== 'web_search_tool_result_error') continue
      const pendingToolId =
        typeof block.tool_use_id === 'string'
          ? block.tool_use_id
          : Array.from(this.toolStates.values()).find((state) => state.toolName === 'claude_web_search')?.id
      if (!pendingToolId || !this.toolStates.has(pendingToolId)) continue
      const state = this.toolStates.get(pendingToolId)
      if (state && !state.emitted) {
        yield this.emitToolCall(state)
      }
      const chunk = this.emitResolvedToolResult(
        pendingToolId,
        block.content,
        block.content,
        block?.type === 'web_search_tool_result_error'
      )
      if (chunk) {
        yield chunk
      }
    }

    for (const block of content) {
      if (block?.type !== 'thinking') continue
      const blockId =
        typeof block.id === 'string' && block.id.length > 0
          ? block.id
          : `thinking_${Date.now()}`
      const text =
        typeof block.thinking === 'string'
          ? block.thinking
          : typeof block.text === 'string'
            ? block.text
            : typeof block.content === 'string'
              ? block.content
              : ''
      const chunk = this.updateThinking(blockId, text, { replace: true, final: true })
      if (chunk) {
        yield chunk
      }
    }
  }

  private *handleUserMessage(message: any, toolUseResult: any): Generator<ClaudeStreamChunk> {
    const content = Array.isArray(message.content) ? message.content : []
    for (const block of content) {
      if (block?.type !== 'tool_result') continue
      const toolId = block.tool_use_id
      if (typeof toolId !== 'string') continue
      const state = this.toolStates.get(toolId)
      if (state && !state.emitted) {
        yield this.emitToolCall(state)
      }

      const chunk = this.emitResolvedToolResult(
        toolId,
        toolUseResult,
        block.content,
        Boolean(block?.is_error)
      )
      if (chunk) {
        yield chunk
      }
    }
  }

  private emitResolvedToolResult(
    toolId: string,
    rawToolResult: any,
    fallbackContent?: any,
    isError = false
  ): ClaudeStreamChunk | null {
    const state = this.toolStates.get(toolId)
    const toolName = state?.toolName ?? state?.originalName ?? 'tool'
    let result = buildToolResult(toolName, rawToolResult, fallbackContent)
    const zipControl = extractAndStripToolZipControl(result)
    if (zipControl.zipId) {
      result = zipControl.value
      this.request.registerReservedToolZipId?.({
        toolCallId: toolId,
        toolName,
        zipId: zipControl.zipId
      })
    }
    const metadata = this.detectToolMetadata(toolName, state?.args, result)
    const errorMessage = isError ? normalizeToolErrorMessage(rawToolResult, fallbackContent) : undefined
    const executionTime = state ? Date.now() - state.startTimestamp : undefined

    this.intermediateSteps.push({
      type: isError ? 'tool_error' : 'tool',
      toolName,
      originalToolName: state?.originalName ?? toolName,
      toolInput: state?.args ?? {},
      toolArgs: state?.args ?? {},
      toolResult: result,
      toolOutput: result,
      toolCallId: toolId,
      timestamp: Date.now(),
      ...(errorMessage ? { error: errorMessage } : {}),
      ...(executionTime ? { executionTime } : {}),
      ...metadata
    })

    this.toolStates.delete(toolId)
    this.toolInputBuffers.delete(toolId)

    return {
      type: 'tool-result',
      toolCallId: toolId,
      toolName,
      args: state?.args,
      result,
      metadata: {
        ...metadata,
        ...(executionTime ? { executionTime } : {}),
        ...(errorMessage ? { error: errorMessage } : {})
      }
    }
  }

  private handleResultEvent(event: any): ClaudeStreamChunk {
    if (event?.is_error || event?.subtype === 'error') {
      const message = typeof event?.result === 'string' ? event.result : 'Claude Code CLI run failed.'
      throw new Error(message)
    }

    const usage = event?.usage ?? {}
    const freshInputTokens =
      typeof usage?.input_tokens === 'number' ? usage.input_tokens : undefined
    const outputTokens =
      typeof usage?.output_tokens === 'number' ? usage.output_tokens : undefined
    const cachedInputTokens =
      typeof usage?.cache_read_input_tokens === 'number'
        ? usage.cache_read_input_tokens
        : undefined
    const cacheCreationInputTokens = (() => {
      if (typeof usage?.cache_creation_input_tokens === 'number') {
        return usage.cache_creation_input_tokens
      }
      const cacheCreation = usage?.cache_creation
      if (!cacheCreation || typeof cacheCreation !== 'object') return undefined
      const values = Object.values(cacheCreation).filter(
        (value): value is number => typeof value === 'number',
      )
      if (values.length === 0) return undefined
      return values.reduce((sum, value) => sum + value, 0)
    })()

    const totalInputTokens =
      (freshInputTokens ?? 0) +
      (cachedInputTokens ?? 0) +
      (cacheCreationInputTokens ?? 0)

    const summary: ClaudeUsageSummary = {
      inputTokens: totalInputTokens,
      ...(typeof outputTokens === 'number' ? { outputTokens } : {}),
      ...(typeof outputTokens === 'number'
        ? { totalTokens: totalInputTokens + outputTokens }
        : { totalTokens: totalInputTokens > 0 ? totalInputTokens : undefined }),
      ...(typeof cachedInputTokens === 'number' ? { cachedInputTokens } : {}),
      ...(typeof cacheCreationInputTokens === 'number'
        ? { cacheCreationInputTokens }
        : {}),
    }
    this.usageSummary = summary

    if (!this.finalText && typeof event?.result === 'string') {
      this.finalText = event.result
    }

    return {
      type: 'finish',
      totalUsage: summary,
      usage: summary
    }
  }

  private updateToolState(state: ClaudeToolState, args: Record<string, any>): ClaudeStreamChunk | null {
    const normalized = normalizeToolName(state.originalName, args)
    state.toolName = normalized.toolName
    state.args = normalized.args
    if (!state.emitted) {
      return this.emitToolCall(state)
    }
    return null
  }

  private emitToolCall(state: ClaudeToolState): ClaudeStreamChunk {
    state.emitted = true
    return {
      type: 'tool-call',
      toolCallId: state.id,
      toolName: state.toolName,
      args: state.args
    }
  }

  private updateThinking(
    id: string,
    content: string,
    options: { replace: boolean; final: boolean }
  ): ClaudeStreamChunk | null {
    if (!content) return null
    const next = options.replace ? content : `${this.thinkingSegments.get(id) ?? ''}${content}`
    this.thinkingSegments.set(id, next)
    if (!this.thinkingOrder.includes(id)) {
      this.thinkingOrder.push(id)
    }
    return {
      type: 'thinking',
      itemId: id,
      content: next,
      final: options.final
    }
  }

  private tryParseJson(value: string) {
    if (!value) return null
    try {
      return JSON.parse(value)
    } catch {
      return null
    }
  }

  private detectToolMetadata(toolName: string, args?: any, result?: any) {
    const lower = toolName.toLowerCase()
    if (lower.includes('subagent_')) {
      const match = lower.match(/subagent_([a-z0-9_-]+)/)
      const slug = match?.[1]
      const unslugged = slug ? slug.replace(/[_-]+/g, ' ').trim() : undefined
      const displayName = unslugged
        ? unslugged
            .split(' ')
            .map((word) =>
              word === 'batshit'
                ? 'batshit'
                : word.length
                ? word[0].toUpperCase() + word.slice(1)
                : word
            )
            .join(' ')
        : undefined
      const resultObj =
        result && typeof result === 'object' && !Array.isArray(result)
          ? (result as Record<string, any>)
          : {}
      const resultMetadataObj = findSubagentResultMetadata(result) ?? resultObj
      const argObj =
        args && typeof args === 'object' && !Array.isArray(args)
          ? (args as Record<string, any>)
          : {}
      const subagentType =
        typeof resultMetadataObj.subagentType === 'string'
          ? resultMetadataObj.subagentType
          : typeof resultMetadataObj.subagent_type === 'string'
            ? resultMetadataObj.subagent_type
            : typeof argObj.subagentType === 'string'
              ? argObj.subagentType
              : undefined
      const explicitToolSource =
        typeof resultMetadataObj.toolSource === 'string'
          ? resultMetadataObj.toolSource
          : typeof resultMetadataObj.tool_source === 'string'
            ? resultMetadataObj.tool_source
            : undefined
      const toolSource =
        explicitToolSource ||
        (subagentType === 'api'
          ? 'managed-api-subagent'
          : subagentType === 'cli'
            ? 'managed-cli-subagent'
            : 'workflow-webhook')
      const subagentId =
        typeof resultMetadataObj.subagentId === 'string' && resultMetadataObj.subagentId.trim()
          ? resultMetadataObj.subagentId.trim()
          : typeof resultMetadataObj.subagent_id === 'string' && resultMetadataObj.subagent_id.trim()
            ? resultMetadataObj.subagent_id.trim()
          : slug
      const subagentName =
        typeof resultMetadataObj.subagentName === 'string' && resultMetadataObj.subagentName.trim()
          ? resultMetadataObj.subagentName.trim()
          : typeof resultMetadataObj.subagent_name === 'string' && resultMetadataObj.subagent_name.trim()
            ? resultMetadataObj.subagent_name.trim()
          : displayName
      return {
        toolProvider: 'subagent',
        toolSource,
        isSubagent: true,
        ...(subagentType ? { subagentType } : {}),
        ...(subagentId ? { subagentId } : {}),
        ...(subagentName ? { subagentName } : {})
      }
    }

    if (toolName.startsWith('mcp.')) {
      const [, server] = toolName.split('.')
      return {
        toolProvider: 'mcp',
        toolSource: 'mcp-gateway',
        mcpServerName: server
      }
    }

    if (toolName.startsWith('batshit_server_')) {
      return {
        toolProvider: 'batshit-server',
        toolSource: 'mode3-workflow'
      }
    }

    if (toolName.startsWith('claude_')) {
      return {
        toolProvider: 'claude',
        toolSource: 'claude'
      }
    }

    return {
      toolProvider: 'claude',
      toolSource: 'claude'
    }
  }

  private async finalize() {
    if (this.completed) return
    this.completed = true
    const resolvedText =
      this.latestAssistantText.length > this.finalText.length
        ? this.latestAssistantText
        : this.finalText
    await this.onFinish?.({
      text: resolvedText,
      steps: this.intermediateSteps,
      totalUsage: this.usageSummary,
      reasoning: this.getOrderedThinkingSegments()
    })
  }

  private getOrderedThinkingSegments() {
    if (this.thinkingOrder.length === 0) return []
    const parts: string[] = []
    for (const id of this.thinkingOrder) {
      const text = this.thinkingSegments.get(id)
      if (text && text.trim()) {
        parts.push(text)
      }
    }
    return parts
  }

  getToolMetadataResolver() {
    return (toolName: string) => this.detectToolMetadata(toolName)
  }

  getRawEvents() {
    return this.rawEvents
  }

  getIntermediateSteps() {
    return this.intermediateSteps
  }

  getTransport() {
    return this.transport
  }
}
