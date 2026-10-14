'use strict';

/**
 * Preload for the streamable MCP helper, so it listens on this computer only.
 *
 * The helper is supergateway wrapping `src/mcp/index.js` (Mac app port 5601, native lane 5611).
 * It serves Batshit's own MCP tools (zip fetch, Dynamic MCP find/use, artifact and Fabric
 * find/use) with no login of its own: the stdio server signs its calls to the app with the
 * instance token. supergateway has no option for the address it listens on and calls
 * `app.listen(port)`, which listens on every network interface, so anyone on the same network
 * could list and run those tools (found 2026-09-22 on the rebuilt Mac app). Both launchers start
 * it as `node -r <this file> node_modules/supergateway/dist/index.js …`; this file makes every TCP
 * listen in that process bind 127.0.0.1, whatever host (or none) the caller gave. A Unix socket
 * or an inherited handle is left alone. Clients reach it as `localhost`, like the app and
 * batshit-server, which also listen on 127.0.0.1 only.
 *
 * It is the one Batshit file both launchers load into that process, so it also loads
 * `oneRequestChildren.cjs`, which tells supergateway's per-request children that they serve one
 * request each, so they exit once it is answered (BL-206).
 */
const net = require('node:net');

require('./oneRequestChildren.cjs');

const LOOPBACK_HOST = '127.0.0.1';
const listen = net.Server.prototype.listen;

function isPort(value) {
  return typeof value === 'number' || (typeof value === 'string' && /^\d+$/.test(value));
}

function isTcpOptions(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    value.path === undefined &&
    value.fd === undefined &&
    value.handle === undefined &&
    value._handle === undefined
  );
}

net.Server.prototype.listen = function listenOnLoopbackOnly(...args) {
  const [first] = args;
  if (first === undefined || first === null || typeof first === 'function') {
    // listen(), listen(null), or listen(callback): a random port, on this computer only.
    return listen.call(this, 0, LOOPBACK_HOST, ...args.filter((arg) => arg !== undefined && arg !== null));
  }
  if (isPort(first)) {
    // listen(port[, host][, backlog][, callback]): any host given is replaced.
    const rest = args.slice(1);
    if (typeof rest[0] === 'string') rest.shift();
    return listen.call(this, first, LOOPBACK_HOST, ...rest);
  }
  if (isTcpOptions(first)) {
    return listen.call(this, { ...first, host: LOOPBACK_HOST }, ...args.slice(1));
  }
  return listen.apply(this, args);
};
