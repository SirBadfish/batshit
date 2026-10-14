/**
 * BL-318 — how long the managed controls helper (`mode4-controls-mcp.cjs`) waits for Batshit to
 * answer a control, and so how long a managed CLI must let one helper call run.
 *
 * The helper used to cut every `/api/controls/use` call at 60 s. An artifact run has its own
 * run limit on the server (`resolveArtifactRunTimeoutMs` in `fabricRegistry.ts`: 2 minutes,
 * and 10 for a Pinokio app, which runs a model on this computer), so a slower run was cut on
 * the Codex and Claude lanes while it went on, and its result was lost. The server owns the
 * limit; the helper waits past the longest one, so the server's own answer (the result, or its
 * time-limit error) always arrives. Every other control keeps 60 s.
 *
 * The CLI cuts a tool call too (Codex: `tool_timeout_sec`, 60 s unless set), so both profile
 * managers give the helper server a tool timeout longer than `CLI_HELPER_LONGEST_WAIT_MS`
 * (`CLI_HELPER_TOOL_TIMEOUT_MS` in `mode4InternalTools.ts`). `cliHelperWaits.test.ts` pins
 * these numbers against the artifact run limits and the profiles.
 */

const CONTROL_USE_WAIT_MS = 60_000
/** The longest run limit any artifact has (a Pinokio app, `resolveArtifactRunTimeoutMs`). */
const LONGEST_ARTIFACT_RUN_LIMIT_MS = 10 * 60_000
/** Room for the server's own time-limit answer to arrive after the run limit. */
const WAIT_MARGIN_MS = 30_000
const ARTIFACT_RUN_WAIT_MS = LONGEST_ARTIFACT_RUN_LIMIT_MS + WAIT_MARGIN_MS

/**
 * The longest a helper call may wait for Batshit: an artifact run. The helper's other waits are
 * shorter (a Bash command at most its 120 s limit plus 5 s, Agent Browser 90 s).
 */
const CLI_HELPER_LONGEST_WAIT_MS = ARTIFACT_RUN_WAIT_MS

/**
 * The helper's HTTP client limits (`cli-helper-http.cjs`): past the longest wait, so the
 * helper's own wait always ends a call first, never undici's 300 s defaults.
 */
const CLI_HELPER_HTTP_TIMEOUT_MS = CLI_HELPER_LONGEST_WAIT_MS + WAIT_MARGIN_MS

/**
 * An artifact run: the `use.artifact.<slug>` alias or one of an artifact's own
 * `artifact.<id>.…` controls (all of them, the quick ones too, since the helper cannot tell
 * them apart without asking; the server answers the quick ones at once anyway).
 */
function isArtifactRunControl(controlId) {
  return typeof controlId === 'string' && /^(?:use\.)?artifact\./.test(controlId.trim())
}

function resolveControlUseWaitMs(controlId) {
  return isArtifactRunControl(controlId) ? ARTIFACT_RUN_WAIT_MS : CONTROL_USE_WAIT_MS
}

module.exports = {
  CONTROL_USE_WAIT_MS,
  CLI_HELPER_LONGEST_WAIT_MS,
  CLI_HELPER_HTTP_TIMEOUT_MS,
  resolveControlUseWaitMs
}
