'use strict';

/**
 * Part of the streamable MCP helper's preload (loaded by `loopbackListen.cjs`, which both launchers
 * preload into supergateway: the Mac supervisor's `mcpProxy` and the native source launcher). BL-206.
 *
 * supergateway's stateless mode, the one both launchers use, starts a `src/mcp/index.js` child for
 * every POST to `/mcp` and never closes its stdin or stops it: each request left a Node process
 * running until the helper stopped. Only this process knows its children serve one request each, so
 * it says so in the environment they inherit, and `src/mcp/index.js` then exits once it has answered
 * (`stdioLifecycle.js`). In supergateway's stateful mode (`--stateful`) a child serves a whole session
 * and supergateway stops it itself, so nothing is marked.
 */
const { ONE_REQUEST_ENV } = require('./stdioLifecycle.js');

if (!process.argv.includes('--stateful')) {
  process.env[ONE_REQUEST_ENV] = '1';
}
