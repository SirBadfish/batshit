/**
 * SA-105 P3 — MCP content shaping for the managed CLI helper bridge.
 *
 * Extracted from `mode4-controls-mcp.cjs` so the content shape can be tested
 * directly: the bridge itself parses argv and starts a stdio server at import
 * time, so it cannot be required from a unit test.
 *
 * Everything here is pure and free of I/O. The bridge owns the HTTP calls; this
 * module owns only the shape of what goes back to the CLI.
 */

const CODEX_RUNTIME = 'codex'
const CLAUDE_RUNTIME = 'claude'

/** Control id whose results can carry recalled memory images. */
const MEMORY_RECALL_CONTROL_ID = 'sys.memory.recall'

/**
 * Normalize the `--runtime=` flag both profile managers now pass (AMD-105-09).
 *
 * An unrecognised or missing value returns `null`, and the bridge then delivers
 * NO image content at all. That default is deliberate: guessing a runtime is how
 * you end up handing a model a megabyte of base64 it cannot read, which is the
 * exact defect SA-105 exists to remove.
 */
function normalizeCliRuntime(value) {
  const normalized = typeof value === 'string' ? value.trim().toLowerCase() : ''
  if (normalized === CODEX_RUNTIME) return CODEX_RUNTIME
  if (normalized === CLAUDE_RUNTIME) return CLAUDE_RUNTIME
  return null
}

/**
 * Cheap structural pre-filter: is this payload a memory recall that returned at
 * least one image?
 *
 * This is NOT the delivery decision — `/api/memory/recall-media` re-validates
 * and owns every lane, note and byte. It exists only so the bridge does not post
 * every single tool result over HTTP just in case. Keyed on payload shape rather
 * than tool name, so it works through both `batshit_tool_use` (which sets
 * `target`) and `mcp_fabric_use` (which sets `controlId`).
 */
function isRecallPayloadWithMedia(payload) {
  if (!payload || typeof payload !== 'object') return false
  const target =
    typeof payload.target === 'string'
      ? payload.target
      : typeof payload.controlId === 'string'
        ? payload.controlId
        : ''
  if (target !== MEMORY_RECALL_CONTROL_ID) return false
  const recalled = payload.result && payload.result.recalled
  if (!Array.isArray(recalled)) return false
  return recalled.some((row) => row && Array.isArray(row.media) && row.media.length > 0)
}

/**
 * Build the MCP `CallToolResult` content array.
 *
 * Two hard rules, both upstream facts rather than preferences (DL-105-09):
 *  - `structuredContent` is NEVER set. Codex drops `content[]` entirely when a
 *    result carries `structuredContent` (openai/codex#10334), so setting it
 *    would silently delete both the JSON text and the images.
 *  - Image blocks are emitted only when the caller passes images, and the Claude
 *    runtime never gets any. Claude Code stores MCP `ImageContent` as text at
 *    10-20x the token cost (anthropic/claude-code#31208, closed not-planned),
 *    so emitting them there would cost tokens for nothing.
 */
function buildCallToolContent(payload, images) {
  const content = [{ type: 'text', text: JSON.stringify(payload, null, 2) }]

  if (Array.isArray(images)) {
    for (const image of images) {
      if (!image || typeof image !== 'object') continue
      const data = typeof image.data === 'string' ? image.data : ''
      const mimeType = typeof image.mediaType === 'string' ? image.mediaType : ''
      if (!data || !mimeType) continue
      content.push({ type: 'image', data, mimeType })
    }
  }

  return { content }
}

/**
 * Attach an honest, model-visible failure note.
 *
 * Batshit does not degrade quietly: if the delivery hop failed, the agent is
 * told in the same payload that images it may be expecting are not attached,
 * rather than being handed a plan with no explanation.
 */
function attachMediaDeliveryError(payload, message) {
  const note = typeof message === 'string' && message.trim().length > 0
    ? message.trim()
    : 'Unknown error.'
  if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
    return {
      ...payload,
      batshitMediaDeliveryError: `Recalled memory images could not be delivered this turn: ${note}`
    }
  }
  return payload
}

module.exports = {
  CODEX_RUNTIME,
  CLAUDE_RUNTIME,
  MEMORY_RECALL_CONTROL_ID,
  normalizeCliRuntime,
  isRecallPayloadWithMedia,
  buildCallToolContent,
  attachMediaDeliveryError
}
