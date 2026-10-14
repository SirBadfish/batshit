// @vitest-environment node
import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { createServer, request as httpRequest } from 'node:http'
import { connect, type Socket } from 'node:net'
import { getRequest, setResponse } from '@sveltejs/kit/node'
import { readAppActionBody } from './body'
import { APP_ACTION_MAX_BYTES } from '../../../appActions/protocol'
import { AppActionRefusal } from '../../../appActions/catalog'

describe('App Actions actual Request stream bounds', () => {
  it('accepts an exact byte bound including multibyte UTF-8 split between chunks', async () => {
    const input = new TextEncoder().encode(JSON.stringify({ name: 'é' }))
    const split = input.indexOf(0xc3) + 1
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(input.slice(0, split)); controller.enqueue(input.slice(split)); controller.close()
    } })
    assert.deepEqual(await readAppActionBody(new Request('http://localhost/actions', { method: 'POST', body: stream, duplex: 'half' } as RequestInit)), { name: 'é' })
    const exact = ' '.repeat(APP_ACTION_MAX_BYTES - 2) + '{}'
    assert.deepEqual(await readAppActionBody(new Request('http://localhost/actions', { method: 'POST', body: exact })), {})
  })
  it('cancels a stream crossing the byte bound despite a lying content length', async () => {
    let cancelled = false
    const stream = new ReadableStream<Uint8Array>({ start(controller) {
      controller.enqueue(new Uint8Array(APP_ACTION_MAX_BYTES)); controller.enqueue(Uint8Array.of(1))
    }, cancel() { cancelled = true } })
    const request = new Request('http://localhost/actions', { method: 'POST', body: stream,
      headers: { 'content-length': '1' }, duplex: 'half' } as RequestInit)
    await assert.rejects(readAppActionBody(request), /payload_too_large/)
    assert.equal(cancelled, true)
  })
  it('rejects invalid JSON, missing bodies and malformed UTF-8 rather than repairing it', async () => {
    await assert.rejects(readAppActionBody(new Request('http://localhost/actions', { method: 'POST' })), /invalid_request/)
    await assert.rejects(readAppActionBody(new Request('http://localhost/actions', { method: 'POST', body: '{' })), /invalid_request/)
    const input = Uint8Array.of(0x22, 0xc3, 0x22)
    await assert.rejects(readAppActionBody(new Request('http://localhost/actions', { method: 'POST', body: input })), /invalid_request/)
  })
})

/** Real Kit request/response adapters; this endpoint qualifies body parsing, not authentication. */
async function withNativeTransport(operation: (fixture: {
  port: number; url: string; refusals: string[]; accepted: unknown[]
}) => Promise<void>) {
  const sockets = new Set<Socket>()
  const refusals: string[] = [], accepted: unknown[] = [], errors: unknown[] = []
  const server = createServer(async (incoming, outgoing) => {
    try {
      const request = await getRequest({ request: incoming, base: 'http://127.0.0.1' })
      const value = await readAppActionBody(request)
      accepted.push(value)
      await setResponse(outgoing, Response.json({ value }))
    } catch (error) {
      if (error instanceof AppActionRefusal && error.reason === 'payload_too_large') {
        refusals.push(error.reason)
        await setResponse(outgoing, Response.json({ status: 'blocked', reason: error.reason }, { status: 413 }))
      } else {
        errors.push(error)
        outgoing.destroy(error instanceof Error ? error : new Error('Unexpected parser failure'))
      }
    }
  })
  server.on('connection', socket => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
  })
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
  try {
    const address = server.address()
    assert.ok(address && typeof address !== 'string')
    await operation({ port: address.port, url: `http://127.0.0.1:${address.port}/actions`, refusals, accepted })
    assert.deepEqual(errors, [])
  } finally {
    // Node may report server close before an individual native handle emits socket close.
    const socketsClosed = Promise.all([...sockets].map(socket =>
      new Promise<void>(resolve => socket.once('close', () => resolve()))))
    let cleanupDeadline: ReturnType<typeof setTimeout> | undefined
    try {
      server.closeAllConnections()
      await Promise.race([
        Promise.all([socketsClosed,
          new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))]),
        new Promise<never>((_resolve, reject) => {
          cleanupDeadline = setTimeout(() => reject(new Error('Owned native socket cleanup deadline exceeded')), 2000)
        })
      ])
      assert.equal(server.listening, false)
      assert.equal(sockets.size, 0)
    } finally { if (cleanupDeadline !== undefined) clearTimeout(cleanupDeadline) }
  }
}

function finiteRequest(url: string, body: string, delayedEof = false): Promise<{ status: number; body: unknown }> {
  return new Promise((resolve, reject) => {
    let eofTimer: ReturnType<typeof setTimeout> | undefined
    const request = httpRequest(url, { method: 'POST', agent: false, headers: {
      'content-type': 'application/json',
      ...(delayedEof ? { 'transfer-encoding': 'chunked' } : { 'content-length': Buffer.byteLength(body) })
    } }, response => {
      let result = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { result += chunk })
      response.once('error', reject)
      response.once('end', () => {
        try { resolve({ status: response.statusCode!, body: JSON.parse(result) }) }
        catch (error) { reject(error) }
      })
    })
    request.once('error', reject)
    request.once('close', () => { if (eofTimer !== undefined) clearTimeout(eofTimer) })
    request.setTimeout(2000, () => request.destroy(new Error('Owned finite-request deadline exceeded')))
    if (delayedEof) {
      request.write(body)
      eofTimer = setTimeout(() => request.end(), 25)
    } else request.end(body)
  })
}

/** Leave chunked input unfinished; a fixture deadline is a failure, not parser-cleanup evidence. */
function unfinishedRequest(port: number, continued: boolean): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port })
    const deadline = setTimeout(() => {
      reject(new Error('Oversized connection survived the owned fixture deadline'))
      socket.destroy()
    }, 2000)
    socket.once('error', () => { /* Native refusal may reset this deliberately unfinished connection. */ })
    socket.once('close', () => { clearTimeout(deadline); resolve() })
    socket.resume()
    socket.once('connect', () => {
      const body = 'x'.repeat(17000)
      socket.write('POST /actions HTTP/1.1\r\nHost: 127.0.0.1\r\nContent-Type: application/json\r\n'
        + 'Transfer-Encoding: chunked\r\nConnection: keep-alive\r\n\r\n'
        + body.length.toString(16) + '\r\n' + body + '\r\n'
        + (continued ? '1\r\nx\r\n' : ''))
    })
  })
}

describe('App Actions body refusal over actual Kit/native HTTP', () => {
  it('delivers finite oversized 413 and still accepts the exact byte bound', async () => {
    await withNativeTransport(async ({ url, refusals, accepted }) => {
      assert.deepEqual(await finiteRequest(url, JSON.stringify({ extra: 'x'.repeat(17000) })), {
        status: 413, body: { status: 'blocked', reason: 'payload_too_large' }
      })
      assert.deepEqual(refusals, ['payload_too_large']); assert.deepEqual(accepted, [])
      assert.deepEqual(await finiteRequest(url, ' '.repeat(APP_ACTION_MAX_BYTES - 2) + '{}'), {
        status: 200, body: { value: {} }
      })
      assert.deepEqual(accepted, [{}])
    })
  })
  it('delivers 413 when an overflowing chunk is followed by bounded real EOF', async () => {
    await withNativeTransport(async ({ url, refusals, accepted }) => {
      assert.deepEqual(await finiteRequest(url, JSON.stringify({ extra: 'x'.repeat(17000) }), true), {
        status: 413, body: { status: 'blocked', reason: 'payload_too_large' }
      })
      assert.deepEqual(refusals, ['payload_too_large']); assert.deepEqual(accepted, [])
    })
  })
  it('closes continuing overflow without draining it or accepting effects', async () => {
    await withNativeTransport(async ({ port, refusals, accepted }) => {
      await unfinishedRequest(port, true)
      assert.deepEqual(refusals, ['payload_too_large']); assert.deepEqual(accepted, [])
    })
  })
  it('closes a stalled overflow within the completion deadline', async () => {
    await withNativeTransport(async ({ port, refusals, accepted }) => {
      await unfinishedRequest(port, false)
      assert.deepEqual(refusals, ['payload_too_large']); assert.deepEqual(accepted, [])
    })
  })
})
