'use strict'

/**
 * `--require` preload that replaces `require('redis')` for a spawned CLI helper bridge.
 *
 * Used by `cliHelperStdioLifecycle.test.ts` (F-P7-10). The point is NOT to avoid a Redis
 * dependency for convenience — it is to reproduce the exact condition that made the bridges
 * immortal, deterministically and in the default test lane:
 *
 *   a connected client keeps an open libuv handle, so stdin EOF alone never drains the
 *   event loop and the process outlives its parent.
 *
 * So the fake client opens a REAL listening socket on connect. A stub that merely flipped a
 * boolean would let the helper exit for the wrong reason and the regression test would prove
 * nothing.
 *
 * It answers only what the bridges touch at startup (`on`, `connect`). Tool-call methods
 * return empty rather than throwing, because a bridge that reached them in this harness is a
 * test bug worth seeing as an empty result, not a crash that looks like a clean exit.
 */

const Module = require('node:module')
const net = require('node:net')

const originalLoad = Module._load

Module._load = function patchedLoad(request, parent, isMain) {
  if (request !== 'redis') {
    return originalLoad.apply(this, arguments)
  }

  const createClient = () => {
    /** @type {import('node:net').Server | null} */
    let keepAlive = null

    const client = {
      isOpen: false,
      on() {
        return client
      },
      off() {
        return client
      },
      duplicate() {
        return createClient()
      },
      async connect() {
        await new Promise((resolve) => {
          keepAlive = net.createServer()
          keepAlive.listen(0, '127.0.0.1', resolve)
        })
        client.isOpen = true
        return client
      },
      async quit() {
        client.isOpen = false
        if (keepAlive) {
          await new Promise((resolve) => keepAlive.close(resolve))
          keepAlive = null
        }
      },
      async disconnect() {
        return client.quit()
      },
      async get() {
        return null
      },
      async set() {
        return 'OK'
      },
      async del() {
        return 0
      },
      async publish() {
        return 0
      },
      async subscribe() {},
      async unsubscribe() {},
      async sMembers() {
        return []
      },
      json: {
        async get() {
          return null
        },
        async set() {
          return 'OK'
        }
      }
    }

    return client
  }

  return { createClient }
}
