'use strict';

/**
 * How the stdio MCP helper (`src/mcp/index.js`) ends (BL-206).
 *
 * 1. The stdio rule every managed CLI bridge follows (`batshit-app/scripts/lib/mcp-stdio-lifecycle.cjs`,
 *    F-P7-10; batshit-server is its own package, so this is its own copy of that rule): exit when
 *    stdin ends or closes, when stdout breaks, or on SIGTERM/SIGHUP/SIGINT, with cleanup bounded by a
 *    deadline. The MCP SDK's `StdioServerTransport` listens only for stdin's `data` and `error`, so
 *    nothing noticed the parent going away. Before the file-server Fetch Zip retirement, a helper that answered `batshit_server_fetch_zip` held a
 *    Redis socket, which kept it alive: measured on a spare port, such a child outlived its streamable
 *    helper as an orphan of PID 1.
 *
 * 2. One request per process, under the streamable helper. supergateway's stateless mode, which is how
 *    both launchers run it (Mac app 5601, native 5611), starts a child for every POST to `/mcp`, sends it
 *    that request (after an initialize of its own when the request is not one), and then never closes
 *    the child's stdin or stops it: 3 requests left 3 children, alive until the helper stopped. Such a
 *    child (the helper's preload marks it, `BATSHIT_MCP_STDIO_ONE_REQUEST=1`) exits once it has answered
 *    every request it was sent and nothing more has arrived for a grace period. The grace covers
 *    supergateway's own follow-up, which it writes the moment the initialize answer reaches it; it is
 *    long, because a child that exits before supergateway's last write makes that write fail on a closed
 *    pipe inside supergateway.
 *
 * Install it AFTER `await server.connect(transport)`: stdin is paused until the transport attaches its
 * `data` listener, and a paused stream never emits `end`.
 */

const DEFAULT_HARD_EXIT_MS = 2000;
const DEFAULT_ONE_REQUEST_GRACE_MS = 10000;
const ONE_REQUEST_ENV = 'BATSHIT_MCP_STDIO_ONE_REQUEST';
const PARENT_GONE_SIGNALS = ['SIGTERM', 'SIGHUP', 'SIGINT'];

/**
 * @param {object} [options]
 * @param {(reason: string) => unknown} [options.onShutdown] Best-effort cleanup.
 * @param {number} [options.hardExitMs] Teardown deadline.
 * @param {(line: string) => void} [options.log]
 * @returns {{ shutdown: (reason: string, exitCode?: number) => void }}
 */
function installStdioLifecycle(options = {}) {
  const { onShutdown, hardExitMs = DEFAULT_HARD_EXIT_MS, log = () => {} } = options;
  let shuttingDown = false;

  const shutdown = (reason, exitCode = 0) => {
    if (shuttingDown) return;
    shuttingDown = true;
    log(`MCP Server: exiting (${reason})`);
    // Unref'd: the deadline is not itself a reason to stay alive.
    const deadline = setTimeout(() => process.exit(exitCode), hardExitMs);
    deadline.unref();
    Promise.resolve()
      .then(() => (typeof onShutdown === 'function' ? onShutdown(reason) : undefined))
      .catch((error) => log(`MCP Server: cleanup failed after ${reason}: ${error?.message ?? error}`))
      .finally(() => process.exit(exitCode));
  };

  process.stdin.on('end', () => shutdown('stdin-end'));
  process.stdin.on('close', () => shutdown('stdin-close'));
  // EPIPE on stdout: the reader is gone. Without a listener this is an uncaught exception.
  process.stdout.on('error', () => shutdown('stdout-error'));
  for (const signal of PARENT_GONE_SIGNALS) process.on(signal, () => shutdown(signal));

  return { shutdown };
}

function isRequest(message) {
  return message && typeof message === 'object' && typeof message.method === 'string' && message.id !== undefined;
}

function isResponse(message) {
  return (
    message &&
    typeof message === 'object' &&
    message.method === undefined &&
    message.id !== undefined &&
    ('result' in message || 'error' in message)
  );
}

/**
 * Calls `onIdle` once nothing has been asked of this process for `graceMs`: every request it received
 * has been answered, and no message arrived since. Pure bookkeeping, so the timing is testable.
 */
function createOneRequestTracker({ graceMs = DEFAULT_ONE_REQUEST_GRACE_MS, onIdle, setTimer = setTimeout, clearTimer = clearTimeout }) {
  const pending = new Set();
  let timer = null;
  let done = false;

  const disarm = () => {
    if (timer !== null) clearTimer(timer);
    timer = null;
  };
  const armIfIdle = () => {
    disarm();
    if (done || pending.size > 0) return;
    timer = setTimer(() => {
      timer = null;
      done = true;
      onIdle();
    }, graceMs);
  };

  armIfIdle();
  return {
    received(message) {
      if (isRequest(message)) pending.add(JSON.stringify(message.id));
      armIfIdle();
    },
    sent(message) {
      if (isResponse(message)) pending.delete(JSON.stringify(message.id));
      armIfIdle();
    },
    get pending() {
      return pending.size;
    }
  };
}

/** Watch what the transport receives and sends, and call `onIdle` as `createOneRequestTracker` says. */
function endAfterOneRequest(transport, { graceMs, onIdle }) {
  const tracker = createOneRequestTracker({ graceMs, onIdle });
  const received = transport.onmessage;
  transport.onmessage = (message, extra) => {
    tracker.received(message);
    return received?.call(transport, message, extra);
  };
  const send = transport.send.bind(transport);
  transport.send = async (message, options) => {
    const result = await send(message, options);
    tracker.sent(message);
    return result;
  };
  return tracker;
}

function oneRequestGraceMs(env = process.env) {
  const value = Number(env.BATSHIT_MCP_STDIO_ONE_REQUEST_GRACE_MS);
  return Number.isFinite(value) && value > 0 ? value : DEFAULT_ONE_REQUEST_GRACE_MS;
}

module.exports = {
  DEFAULT_HARD_EXIT_MS,
  DEFAULT_ONE_REQUEST_GRACE_MS,
  ONE_REQUEST_ENV,
  createOneRequestTracker,
  endAfterOneRequest,
  installStdioLifecycle,
  oneRequestGraceMs
};
