import { describe, expect, it, vi } from 'vitest'
import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { redis } from '$lib/server/redis'
import { pinokioMachineService } from '$lib/server/services/pinokioMachineService'
import { GET, POST } from './+server'
import { PUT, DELETE } from './[id]/+server'

useRedisTestServer()
const USER = 'pinokio_connection_session'
const ADDRESS = { label: 'Gaming PC', controlHost: '192.168.1.85', controlPort: 42000 }
function event(method: string, body?: unknown, extraHeaders: Record<string, string> = {}, id?: string, signedIn = true) {
  const url = new URL(`http://localhost:5621/api/pinokio/machines${id ? `/${id}` : ''}`)
  return {
    url, params: id ? { id } : {}, locals: { user: signedIn ? { id: USER } : null },
    request: new Request(url, { method, headers: { 'content-type': 'application/json', origin: url.origin, ...extraHeaders }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) })
  } as any
}

describe('Pinokio connection session routes', () => {
  it('requires a signed-in session for every operation', async () => {
    for (const [method, handler] of [['GET', GET], ['POST', POST], ['PUT', PUT], ['DELETE', DELETE]] as const) {
      expect((await handler(event(method, method === 'GET' ? undefined : ADDRESS, {}, 'local', false))).status).toBe(401)
    }
    expect(await redis.json.getRaw(`pinokio_machines:${USER}`, '$')).toBeNull()
  })

  it('refuses non-session credentials, even empty headers beside a valid session, and cross-site origins', async () => {
    for (const header of ['authorization', 'x-batshit-token', 'x-batshit-service-token', 'x-batshit-agent-token', 'x-batshit-portable-token']) {
      for (const value of ['', 'credential']) {
        expect((await GET(event('GET', undefined, { [header]: value }))).status).toBe(403)
        expect((await POST(event('POST', ADDRESS, { [header]: value }))).status).toBe(403)
      }
    }
    for (const origin of ['null', 'https://other.example']) expect((await POST(event('POST', ADDRESS, { origin }))).status).toBe(403)
    expect(await redis.json.getRaw(`pinokio_machines:${USER}`, '$')).toBeNull()
  })

  it('stores only the signed-in owner, answers canonical versions, and removes only that connection', async () => {
    const created = await POST(event('POST', ADDRESS))
    expect(created.status).toBe(200)
    const { machine } = await created.json()
    expect(machine).toMatchObject({ ...ADDRESS, controlProtocol: 'http', version: 1, revision: 1 })
    const saved = await PUT(event('PUT', { expectedVersion: 1, label: 'Renamed' }, {}, machine.id))
    expect(await saved.json()).toMatchObject({ machine: { label: 'Renamed', version: 2, revision: 1 } })
    const stale = await PUT(event('PUT', { expectedVersion: 1, controlPort: 42001 }, {}, machine.id))
    expect(stale.status).toBe(409)
    expect(await stale.json()).toMatchObject({ success: false, code: 'pinokio_machine_changed' })
    expect((await POST(event('POST', { ...ADDRESS, userId: 'other' }))).status).toBe(400)
    expect((await DELETE(event('DELETE', { expectedVersion: 2, deleteApps: true }, {}, machine.id))).status).toBe(400)
    expect((await DELETE(event('DELETE', { expectedVersion: 2 }, {}, machine.id))).status).toBe(200)
    expect(await (await GET(event('GET'))).json()).toMatchObject({ machines: [{ id: 'local' }] })
  })

  it('returns a visible read failure and never an empty successful list on corruption or storage errors', async () => {
    await redis.json.set(`pinokio_machines:${USER}`, '$', { schemaVersion: 1, machines: 'bad' })
    const response = await GET(event('GET'))
    expect(response.status).toBe(500)
    expect(await response.json()).toMatchObject({ success: false, code: 'pinokio_machine_registry_invalid' })
    const spy = vi.spyOn(pinokioMachineService, 'list').mockRejectedValueOnce(new Error('connection refused'))
    try {
      const failed = await GET(event('GET'))
      expect(failed.status).toBe(500)
      expect(await failed.json()).toMatchObject({ code: 'pinokio_machine_storage_failed' })
    } finally { spy.mockRestore() }
  })
})
