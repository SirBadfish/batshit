'use strict'

const Module = require('node:module')
const net = require('node:net')
const fs = require('node:fs')
const originalLoad = Module._load

Module._load = function patchedLoad(request, parent, isMain) {
  if (request !== 'redis') return originalLoad.apply(this, arguments)
  const createClient = () => {
    let keepAlive
    const capture = (record) => fs.appendFileSync(process.env.BL502_CAPTURE, `${JSON.stringify(record)}\n`)
    const client = {
      isOpen: false,
      on() { return client },
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
        if (keepAlive) await new Promise((resolve) => keepAlive.close(resolve))
      },
      async publish(channel, payload) { capture({ method: 'publish', channel, payload: JSON.parse(payload) }); return 1 },
      async brPop(key, timeout) {
        capture({ method: 'brPop', key, timeout })
        // BL-496: the wait that nobody answers returns nothing, as Redis does at its timeout.
        if (process.env.BL502_BRPOP_MODE === 'timeout') return null
        if (process.env.BL502_BRPOP_MODE === 'throw') throw new Error('connection lost')
        return { key, element: JSON.stringify({ approved: false, reason: 'test denial' }) }
      }
    }
    return client
  }
  return { createClient }
}
