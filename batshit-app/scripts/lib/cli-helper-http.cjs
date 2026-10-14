/**
 * BL-318 review — the HTTP client of the managed controls helper (`mode4-controls-mcp.cjs`).
 *
 * Node's built-in `fetch` is undici with its default Agent, which gives up on a response whose
 * headers take more than 300 s (`headersTimeout`) or whose body goes quiet for 300 s
 * (`bodyTimeout`). `/api/controls/use` answers only when the control's run ends, so a Pinokio
 * app artifact (a 10-minute run limit) was cut at 5:00 whatever the helper's own wait said.
 * This fetch uses its own undici `Agent` whose two limits are the given time, so the helper's
 * own per-call wait (`cli-helper-waits.cjs`) is what ends a call. undici is a production
 * dependency of batshit-app, shipped in `node_modules` beside `scripts/` in the Docker image
 * and the Mac app, where this file resolves it.
 */

const { Agent, fetch: undiciFetch } = require('undici')

/** A fetch whose connection-level limits are `timeoutMs` (headers and quiet body alike). */
function createHelperFetch(timeoutMs) {
  const dispatcher = new Agent({ headersTimeout: timeoutMs, bodyTimeout: timeoutMs })
  return (url, init = {}) => undiciFetch(url, { ...init, dispatcher })
}

module.exports = { createHelperFetch }
