import http from 'node:http'
import type { AddressInfo } from 'node:net'

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { env } from '$env/dynamic/private'
import type { VoiceEngineRecord } from '$lib/types/voice'
import {
  closeRegisteredRuntimeResources,
  resetRuntimeShutdownTasksForTests
} from '../runtimeShutdown'
import {
  registerHostVoiceRuntimeShutdown,
  stopHostVoiceRuntimesAtShutdown
} from '../voiceHostOperatorRuntime'

// "Stop with Batshit" in Docker: when the container shuts down, the app sends every engine's
// choice to the host operator, which started the engines and is the only thing that can stop
// them. A real HTTP server plays the operator.
const privateEnv = env as Record<string, string | undefined>

function engine(id: string, startup?: Record<string, boolean>, withRecipe = true): VoiceEngineRecord {
  return {
    id,
    name: id,
    enabled: true,
    baseUrl: `http://127.0.0.1:${id === 'kokoro' ? 8010 : 8077}`,
    ...(withRecipe
      ? { localRuntime: { installRoot: `/tmp/${id}`, launch: { command: `/tmp/${id}/serve` }, startup } }
      : {})
  } as VoiceEngineRecord
}

describe('stopping host voice engines when the Docker app shuts down', () => {
  let server: http.Server
  let requests: Array<{ url: string | undefined; auth: string | undefined; body: any }>
  let answer: (res: http.ServerResponse) => void
  const log = { info: vi.fn(), warn: vi.fn() }

  beforeEach(async () => {
    requests = []
    log.info.mockReset()
    log.warn.mockReset()
    answer = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: true, stopped: [], keptRunning: [], notStopped: [] }))
    }
    server = http.createServer((req, res) => {
      let raw = ''
      req.on('data', (chunk) => (raw += chunk))
      req.on('end', () => {
        requests.push({ url: req.url, auth: req.headers.authorization, body: raw ? JSON.parse(raw) : null })
        answer(res)
      })
    })
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
    privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_URL = `http://127.0.0.1:${(server.address() as AddressInfo).port}`
    privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN = 'operator-test-token'
  })

  afterEach(async () => {
    delete privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_URL
    delete privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_TOKEN
    resetRuntimeShutdownTasksForTests()
    server.closeAllConnections()
    await new Promise<void>((resolve) => server.close(() => resolve()))
  })

  it('sends every engine’s choice, absent meaning stop, and logs what it could not stop', async () => {
    answer = (res) => {
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end(
        JSON.stringify({
          ok: true,
          stopped: [{ pid: 101, engineIds: ['kokoro'] }],
          keptRunning: [],
          notStopped: [{ pid: 202, engineIds: ['whisper-cpp'], reason: 'it did not stop after SIGKILL' }]
        })
      )
    }

    const result = await stopHostVoiceRuntimesAtShutdown(
      async () => [
        engine('kokoro'),
        engine('whisper-cpp', { stopOnShutdown: false }),
        // Connect Existing: Batshit never started it, so it is not the operator's to stop.
        engine('connected-tts', undefined, false)
      ],
      { log }
    )

    expect(requests).toHaveLength(1)
    expect(requests[0]).toMatchObject({ url: '/v1/voice-engines/stop', auth: 'Bearer operator-test-token' })
    expect(requests[0].body).toEqual({
      engines: [
        { engineId: 'kokoro', endpoint: 'http://127.0.0.1:8010', stopOnShutdown: true },
        { engineId: 'whisper-cpp', endpoint: 'http://127.0.0.1:8077', stopOnShutdown: false }
      ]
    })
    expect(result?.stopped).toEqual([{ pid: 101, engineIds: ['kokoro'] }])
    expect(log.info).toHaveBeenCalledWith(expect.stringContaining('Stopped host voice engine kokoro (pid 101)'))
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not stop host voice engine whisper-cpp (pid 202): it did not stop after SIGKILL')
    )
  })

  it('a hung operator never holds shutdown up, and says what it could not do', async () => {
    answer = () => {
      // Never answers.
    }
    const started = Date.now()
    const result = await stopHostVoiceRuntimesAtShutdown(async () => [engine('kokoro')], {
      log,
      timeoutMs: 300
    })

    expect(result).toBeNull()
    expect(Date.now() - started).toBeLessThan(2_000)
    expect(log.warn).toHaveBeenCalledWith(
      expect.stringContaining('Could not stop host voice engines through the Docker helper')
    )
  })

  it('an operator too old to stop anything is reported, not ignored', async () => {
    answer = (res) => {
      res.writeHead(404, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ ok: false, error: 'Not found.' }))
    }
    expect(await stopHostVoiceRuntimesAtShutdown(async () => [engine('kokoro')], { log })).toBeNull()
    expect(log.warn).toHaveBeenCalledWith(expect.stringContaining('Not found.'))
  })

  it('with no operator configured there is nothing to stop', async () => {
    delete privateEnv.BATSHIT_RUNTIME_ADDON_OPERATOR_URL
    const listEngines = vi.fn(async () => [engine('kokoro')])

    expect(await stopHostVoiceRuntimesAtShutdown(listEngines, { log })).toBeNull()
    expect(listEngines).not.toHaveBeenCalled()
    expect(requests).toHaveLength(0)
    expect(log.warn).not.toHaveBeenCalled()
  })

  it('runs as one of the app’s shutdown tasks (SIGTERM, docker stop)', async () => {
    registerHostVoiceRuntimeShutdown(async () => [engine('kokoro')])

    await closeRegisteredRuntimeResources('SIGTERM')

    expect(requests.map((request) => request.url)).toEqual(['/v1/voice-engines/stop'])
  })
})
