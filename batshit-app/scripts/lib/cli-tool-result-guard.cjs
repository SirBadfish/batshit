const { AsyncLocalStorage } = require('node:async_hooks')
const { formatMemoryResultCut } = require('./cli-tool-memory-cut.cjs')
const commandCaptureContext = new AsyncLocalStorage()

/** Guard the final MCP text after helper formatting and recalled-image delivery. */
const TOOL_MODEL_TEXT_THRESHOLD_CHARS = 99_997 // ceil(chars / 4) >= 25,000
const TOOL_MODEL_RAW_MAX_CHARS = 8_000_000
// BL-677: the server's guarded text is at most this long (toolModelTextSizeGuard.ts).
const TOOL_MODEL_TEXT_MAX_CHARS = 96_000

function boundedTextEnd(text) {
  let end = Math.min(text.length, TOOL_MODEL_RAW_MAX_CHARS)
  if (end < text.length && end > 0) {
    const before = text.charCodeAt(end - 1)
    const after = text.charCodeAt(end)
    if (before >= 0xd800 && before <= 0xdbff && after >= 0xdc00 && after <= 0xdfff) end -= 1
  }
  return end
}

// One context per MCP call: concurrent tool calls must never exchange command output.
function withCommandModelCapture(callback) {
  return commandCaptureContext.run({
    capture: null, memoryNoRetain: false, toolTextBudget: undefined, toolPageKind: undefined
  }, callback)
}

/** Read only Batshit's fixed local endpoint response headers, never MCP result data. */
function observeTrustedToolResponseHeaders(response, endpointPath) {
  const context = commandCaptureContext.getStore()
  if (!context || typeof endpointPath !== 'string' || !endpointPath.startsWith('/api/')) return
  const memory = response.headers.get('x-batshit-memory-no-retain')
  if (memory === '1' && endpointPath === '/api/controls/use') context.memoryNoRetain = true

  const pageKind = response.headers.get('x-batshit-tool-page-kind')
  if (pageKind !== null) {
    const expectedPath = pageKind === 'fetch-zip' ? '/api/controls/use'
      : pageKind === 'skill-read' ? '/api/skills/runtime' : null
    if (expectedPath !== endpointPath) throw new Error('The managed tool page-kind response was invalid.')
    if (context.toolPageKind && context.toolPageKind !== pageKind) {
      throw new Error('The managed tool page kind changed during one tool call.')
    }
    context.toolPageKind = pageKind
  }

  const max = response.headers.get('x-batshit-tool-text-max-bytes')
  const source = response.headers.get('x-batshit-tool-text-budget-source')
  if (max === null && source === null) return
  if (!/^(0|[1-9][0-9]*)$/.test(max ?? '') ||
      (source !== 'codex-profile' && source !== 'codex-fallback')) {
    throw new Error('The managed tool text budget response was invalid.')
  }
  const maxUtf8Bytes = Number(max)
  if (!Number.isSafeInteger(maxUtf8Bytes) || maxUtf8Bytes > 300_000) {
    throw new Error('The managed tool text budget response was invalid.')
  }
  if (context.toolTextBudget &&
      (context.toolTextBudget.maxUtf8Bytes !== maxUtf8Bytes || context.toolTextBudget.source !== source)) {
    throw new Error('The managed tool text budget changed during one tool call.')
  }
  context.toolTextBudget = { maxUtf8Bytes, source }
}

function readCurrentToolTextBudget() {
  return commandCaptureContext.getStore()?.toolTextBudget
}

function readCurrentToolPageKind() {
  return commandCaptureContext.getStore()?.toolPageKind
}

function unwrapCommandModelCaptureResponse(response, body) {
  if (response.headers.get('x-batshit-command-model-capture') !== '1') return body
  const context = commandCaptureContext.getStore()
  const capture = body?.modelCapture
  if (!context || context.capture || !capture || typeof capture.text !== 'string' ||
      capture.text.length > TOOL_MODEL_RAW_MAX_CHARS ||
      !Number.isSafeInteger(capture.originalTextChars) || capture.originalTextChars < capture.text.length ||
      capture.originalTextChars < TOOL_MODEL_TEXT_THRESHOLD_CHARS || !Object.hasOwn(body, 'result')) {
    throw new Error('The original command output could not be read safely. Run the tool again for a smaller part.')
  }
  context.capture = { text: capture.text, originalTextChars: capture.originalTextChars }
  return body.result
}

async function guardCallToolContent(result, options) {
  const content = Array.isArray(result?.content) ? result.content : []
  const capture = commandCaptureContext.getStore()?.capture
  const text = capture?.text ?? content.filter((part) => part?.type === 'text' && typeof part.text === 'string')
    .map((part) => part.text).join('\n')
  const originalTextChars = capture?.originalTextChars ?? text.length
  if (commandCaptureContext.getStore()?.memoryNoRetain) {
    // The fixed controls/use endpoint vouched for a sys.memory.* result. Cut the final
    // escaped MCP text after recall-media delivery, without posting it for a raw zip.
    const cutText = formatMemoryResultCut(text, originalTextChars, readCurrentToolTextBudget())
    if (cutText === text) return result
    let inserted = false
    return {
      ...result,
      content: content.flatMap((part) => {
        if (part?.type !== 'text' || typeof part.text !== 'string') return [part]
        if (inserted) return []
        inserted = true
        return [{ ...part, text: cutText }]
      })
    }
  }
  if (originalTextChars < TOOL_MODEL_TEXT_THRESHOLD_CHARS && options.runtime !== 'codex' && options.requireBudgetCheck !== true) return result
  const boundedText = text.slice(0, boundedTextEnd(text))

  const response = await options.fetchFn(`${options.baseUrl}/api/native-tools/guard-result`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-batshit-agent-token': options.runCredential },
    body: JSON.stringify({
      text: boundedText,
      originalTextChars,
      toolName: typeof options.toolName === 'string' ? options.toolName.slice(0, 256) : undefined
    }),
    signal: AbortSignal.timeout(60_000)
  })
  const body = await response.json().catch(() => null)
  if (!response.ok || body?.success !== true || typeof body.text !== 'string' || body.text.length > TOOL_MODEL_TEXT_MAX_CHARS) {
    // Never pass the original oversized result on failure, nor invent a raw id.
    throw new Error('The oversized tool result could not be kept. Run the tool again for a smaller part.')
  }
  let inserted = false
  return {
    ...result,
    content: content.flatMap((part) => {
      if (part?.type !== 'text' || typeof part.text !== 'string') return [part]
      if (inserted) return []
      inserted = true
      return [{ ...part, text: body.text }]
    })
  }
}

module.exports = {
  guardCallToolContent, withCommandModelCapture, unwrapCommandModelCaptureResponse,
  observeTrustedToolResponseHeaders, readCurrentToolTextBudget, readCurrentToolPageKind
}
