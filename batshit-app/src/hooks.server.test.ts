import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { armBackgroundSchedulers, assertInternalServiceTokenConfigured } from './hooks.server'

vi.mock('$app/environment', () => ({
  building: false,
  dev: false
}))

const startMemoryDreamingScheduler = vi.hoisted(() => vi.fn())
const startScheduleTicker = vi.hoisted(() => vi.fn())

vi.mock('$lib/server/services/memory/memoryDreamingScheduler', () => ({
  startMemoryDreamingScheduler
}))
vi.mock('$lib/server/services/schedules/scheduleTicker', () => ({
  startScheduleTicker
}))

const restoreEnv = (snapshot: Record<string, string | undefined>) => {
  for (const key of Object.keys(env)) {
    delete env[key]
  }
  Object.assign(env, snapshot)
}

describe('production startup service-token guard', () => {
  const originalEnv = { ...env }

  afterEach(() => {
    restoreEnv(originalEnv)
  })

  it('rejects a missing internal service token in production', () => {
    env.NODE_ENV = 'production'
    delete env.BATSHIT_TOKEN
    delete env.MCP_GATEWAY_AUTH_TOKEN

    expect(() => assertInternalServiceTokenConfigured()).toThrow(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters'
    )
  })

  it('rejects short or placeholder internal service tokens in production', () => {
    env.NODE_ENV = 'production'
    env.BATSHIT_TOKEN = 'short'
    delete env.MCP_GATEWAY_AUTH_TOKEN

    expect(() => assertInternalServiceTokenConfigured()).toThrow(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters'
    )

    env.BATSHIT_TOKEN = 'replace-with-a-real-service-token-value'

    expect(() => assertInternalServiceTokenConfigured()).toThrow(
      'BATSHIT_TOKEN must be set to a stable, non-placeholder secret of at least 32 characters'
    )
  })

  it('accepts a stable internal service token in production', () => {
    env.NODE_ENV = 'production'
    env.BATSHIT_TOKEN = 'valid-production-service-token-123456'
    delete env.MCP_GATEWAY_AUTH_TOKEN

    expect(() => assertInternalServiceTokenConfigured()).not.toThrow()
  })

  it('accepts the gateway token fallback when the dedicated token is absent', () => {
    env.NODE_ENV = 'production'
    delete env.BATSHIT_TOKEN
    env.MCP_GATEWAY_AUTH_TOKEN = 'valid-production-gateway-token-123456'

    expect(() => assertInternalServiceTokenConfigured()).not.toThrow()
  })
})

// BL-793: a proof lane started on the shared native DB0 arms its own schedule ticker and memory
// dreaming scheduler on the first request, same as any other lane touching that same data, so a
// due schedule or dreaming pass can fire for real more than once (real agent turns, real model
// calls, real spend) with no word to whoever started the proof lane.
describe('BL-793: BATSHIT_DISABLE_SCHEDULERS turns both background schedulers off', () => {
  const originalEnv = { ...env }

  afterEach(() => {
    restoreEnv(originalEnv)
    startMemoryDreamingScheduler.mockClear()
    startScheduleTicker.mockClear()
  })

  it('starts both schedulers by default, with no "disabled" log line', () => {
    delete env.BATSHIT_DISABLE_SCHEDULERS
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    armBackgroundSchedulers()

    expect(startMemoryDreamingScheduler).toHaveBeenCalledTimes(1)
    expect(startScheduleTicker).toHaveBeenCalledTimes(1)
    expect(
      info.mock.calls.some((call) => String(call[0]).includes('BATSHIT_DISABLE_SCHEDULERS'))
    ).toBe(false)
  })

  it('skips both schedulers and logs one clear line when the switch is set', () => {
    env.BATSHIT_DISABLE_SCHEDULERS = '1'
    const info = vi.spyOn(console, 'info').mockImplementation(() => {})

    armBackgroundSchedulers()

    expect(startMemoryDreamingScheduler).not.toHaveBeenCalled()
    expect(startScheduleTicker).not.toHaveBeenCalled()
    expect(
      info.mock.calls.some(
        (call) =>
          String(call[0]).includes('BATSHIT_DISABLE_SCHEDULERS=1') &&
          String(call[0]).includes('schedule ticker') &&
          String(call[0]).includes('memory dreaming scheduler') &&
          String(call[0]).includes('OFF')
      )
    ).toBe(true)
  })

  it('treats any value other than the literal "1" as still on', () => {
    env.BATSHIT_DISABLE_SCHEDULERS = 'true'

    armBackgroundSchedulers()

    expect(startMemoryDreamingScheduler).toHaveBeenCalledTimes(1)
    expect(startScheduleTicker).toHaveBeenCalledTimes(1)
  })
})

// BL-19: in Docker the host operator started the voice engines, and it stops them when the app
// container stops. That stop used to be registered by the first signed-in page load, so a
// container Docker restarted after a crash or a restart of the computer, which nobody opened,
// stopped nothing. Loading this module is the server starting.
describe('Docker stops its host voice engines from the moment the server starts (BL-19)', () => {
  it('a SIGTERM with no request, page load, or sign-in before it still sends every engine’s choice', async () => {
    const requests: Array<{ url: string | undefined; body: any }> = []
    const operator = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        requests.push({ url: req.url, body: raw ? JSON.parse(raw) : null })
        res.writeHead(200, { 'content-type': 'application/json' })
        res.end(JSON.stringify({ ok: true, stopped: [], keptRunning: [], notStopped: [] }))
      })
    })
    await new Promise<void>((resolve) => operator.listen(0, '127.0.0.1', resolve))
    const originalContainerized = process.env.BATSHIT_CONTAINERIZED
    process.env.BATSHIT_CONTAINERIZED = '1'
    try {
      // A fresh server: its own env, Redis, and shutdown tasks, loaded in Docker.
      vi.resetModules()
      const fresh = await import('$env/dynamic/private')
      const freshEnv = fresh.env as Record<string, string | undefined>
      freshEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = `http://127.0.0.1:${(operator.address() as AddressInfo).port}`
      freshEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = 'operator-test-token'
      const { redis } = await import('$lib/server/redis')
      await redis.sAdd('users:all', 'josh')
      await redis.json.set('voice_engine_registry:josh', '$', {
        version: 1,
        records: [
          {
            id: 'kokoro',
            name: 'Kokoro',
            enabled: true,
            baseUrl: 'http://127.0.0.1:8010',
            localRuntime: {
              installRoot: '/Users/example/.batshit/installs/kokoro',
              launch: { command: '/Users/example/.batshit/installs/kokoro/serve' },
              startup: { stopOnShutdown: false }
            }
          }
        ]
      })
      const shutdown = await import('$lib/server/services/runtimeShutdown')

      await import('./hooks.server')
      await shutdown.closeRegisteredRuntimeResources('SIGTERM')

      expect(requests).toEqual([
        {
          url: '/v1/voice-engines/stop',
          body: { engines: [{ engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: false }] }
        }
      ])
    } finally {
      if (originalContainerized === undefined) delete process.env.BATSHIT_CONTAINERIZED
      else process.env.BATSHIT_CONTAINERIZED = originalContainerized
      operator.closeAllConnections()
      await new Promise<void>((resolve) => operator.close(() => resolve()))
    }
  })
})
