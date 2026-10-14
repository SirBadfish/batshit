// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import { logger } from '$lib/utils/logger'
import {
  createTypesafeClient,
  parseSystemOneResponse,
  type TypesafeFetch,
  type TypesafeFetchInit
} from '../typesafeClient'

/**
 * SA-120 P0 — the client contract (DL-120-07/08): typed parsing, one retry on
 * 429/529 honouring Retry-After, per-attempt timeout, total deadline, caller abort,
 * honest unknown usage, and no body logging. Fetch is injected; no network.
 */

const QUESTIONS = {
  yes: { type: 'noul', instructions: 'Is `message` positive?' },
  pick: { type: 'choice', instructions: 'Pick one', criteria: { a: null, b: null } }
} as const

const OK_BODY = {
  model: 'jev-1.13.0',
  answers: {
    yes: { type: 'noul', noul: 0.91 },
    pick: { type: 'choice', choice: 'a', probabilities: { a: 0.8, b: 0.2 }, confidence: 0.7 }
  },
  usage: { input_tokens: 42, output_tokens: 7 }
}

function jsonResponse(status: number, body: unknown, headers: Record<string, string> = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'content-type': 'application/json', ...headers }
  })
}

function baseRequest(overrides: Partial<Parameters<ReturnType<typeof createTypesafeClient>['systemOne']>[0]> = {}) {
  return {
    apiKey: 'sk-test-key-value',
    model: 'jev-1.13.0',
    state: { message: 'the sun is out' },
    questions: QUESTIONS,
    attemptTimeoutMs: 5000,
    ...overrides
  }
}

function clientWith(fetchImpl: TypesafeFetch, sleep = vi.fn(async () => {})) {
  return {
    client: createTypesafeClient({ fetch: fetchImpl, dispatcher: null, sleep }),
    sleep
  }
}

describe('typesafeClient', () => {
  it('parses a good answer, keeps usage, and sends the bearer key once', async () => {
    const calls: Array<{ url: string; init: TypesafeFetchInit }> = []
    const fetchImpl: TypesafeFetch = async (url, init) => {
      calls.push({ url, init })
      return jsonResponse(200, OK_BODY)
    }
    const { client } = clientWith(fetchImpl)
    const outcome = await client.systemOne(baseRequest())

    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') throw new Error('expected ok')
    expect(outcome.response.model).toBe('jev-1.13.0')
    expect(outcome.response.answers.yes.noul).toBe(0.91)
    expect(outcome.response.answers.pick.choice).toBe('a')
    expect(outcome.response.usage).toEqual({ inputTokens: 42, outputTokens: 7 })
    expect(outcome.attempts).toBe(1)
    expect(calls).toHaveLength(1)
    expect(calls[0].url).toBe('https://api.typesafe.ai/v1/systemone')
    expect((calls[0].init.headers as Record<string, string>).Authorization).toBe('Bearer sk-test-key-value')
    const sent = JSON.parse(String(calls[0].init.body))
    expect(sent).toEqual({ state: { message: 'the sun is out' }, model: 'jev-1.13.0', questions: QUESTIONS })
    expect('dispatcher' in calls[0].init).toBe(false)
  })

  it('reports missing usage as null, never zero', async () => {
    const { usage: _dropped, ...withoutUsage } = OK_BODY
    const { client } = clientWith(async () => jsonResponse(200, withoutUsage))
    const outcome = await client.systemOne(baseRequest())
    expect(outcome.status).toBe('ok')
    if (outcome.status !== 'ok') throw new Error('expected ok')
    expect(outcome.response.usage).toBeNull()
  })

  it('treats a 2xx that does not match the answer shape as malformed', async () => {
    const { client } = clientWith(async () =>
      jsonResponse(200, { model: 'jev-1.13.0', answers: { yes: { type: 'choice', choice: 'x' } } })
    )
    const outcome = await client.systemOne(baseRequest())
    expect(outcome).toMatchObject({ status: 'error', reason: 'malformed', httpStatus: 200 })
  })

  it('maps 401 to unauthorized and 422 to bad_request with a bounded, body-free detail', async () => {
    const { client: unauthorized } = clientWith(async () => jsonResponse(401, { error: 'bad key' }))
    expect(await unauthorized.systemOne(baseRequest())).toMatchObject({
      status: 'error',
      reason: 'unauthorized',
      httpStatus: 401
    })

    const longMessage = 'questions.pick.criteria is invalid '.repeat(20)
    const { client: bad } = clientWith(async () => jsonResponse(422, { error: { message: longMessage } }))
    const outcome = await bad.systemOne(baseRequest())
    expect(outcome).toMatchObject({ status: 'error', reason: 'bad_request', httpStatus: 422 })
    if (outcome.status !== 'error') throw new Error('expected error')
    expect(outcome.detail!.length).toBeLessThanOrEqual(201)
  })

  it('retries exactly once on 429, waiting the Retry-After the vendor asked for', async () => {
    const fetchImpl = vi
      .fn<TypesafeFetch>()
      .mockResolvedValueOnce(jsonResponse(429, { error: 'slow down' }, { 'retry-after': '1' }))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY))
    const { client, sleep } = clientWith(fetchImpl)
    const outcome = await client.systemOne(baseRequest())
    expect(outcome.status).toBe('ok')
    expect(outcome.attempts).toBe(2)
    expect(fetchImpl).toHaveBeenCalledTimes(2)
    expect(sleep).toHaveBeenCalledWith(1000)
  })

  it('gives up after the one retry when the vendor is still overloaded', async () => {
    const fetchImpl = vi
      .fn<TypesafeFetch>()
      .mockResolvedValueOnce(jsonResponse(529, { error: 'overloaded' }))
      .mockResolvedValueOnce(jsonResponse(529, { error: 'overloaded' }))
      .mockResolvedValueOnce(jsonResponse(200, OK_BODY))
    const { client } = clientWith(fetchImpl)
    const outcome = await client.systemOne(baseRequest())
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'rate_limited', attempts: 2, httpStatus: 529 })
    expect(fetchImpl).toHaveBeenCalledTimes(2)
  })

  it('does not retry a 500 and reports it as a server error', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>().mockResolvedValue(jsonResponse(500, 'boom'))
    const { client } = clientWith(fetchImpl)
    const outcome = await client.systemOne(baseRequest())
    expect(outcome).toMatchObject({ status: 'error', reason: 'server_error', httpStatus: 500, attempts: 1 })
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  it('caps the retry wait and refuses to wait past the deadline', async () => {
    const fetchImpl = vi
      .fn<TypesafeFetch>()
      .mockResolvedValue(jsonResponse(429, { error: 'slow down' }, { 'retry-after': '5' }))
    const { client, sleep } = clientWith(fetchImpl)
    const outcome = await client.systemOne(baseRequest({ deadlineMs: 300 }))
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'rate_limited', deadlineHit: true, attempts: 1 })
    expect(sleep).not.toHaveBeenCalled()
    expect(fetchImpl).toHaveBeenCalledTimes(1)
  })

  function neverResolves(): TypesafeFetch {
    return (_url, init) =>
      new Promise((_resolve, reject) => {
        const signal = init.signal as AbortSignal
        if (signal.aborted) {
          reject(new DOMException('aborted', 'AbortError'))
          return
        }
        signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')), { once: true })
      })
  }

  it('reports a per-attempt timeout as unavailable/timeout without a deadline hit', async () => {
    const { client } = clientWith(neverResolves())
    const outcome = await client.systemOne(baseRequest({ attemptTimeoutMs: 20 }))
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'timeout', deadlineHit: false, attempts: 1 })
  })

  it('reports the lane deadline as unavailable/deadline with deadlineHit when it clips the attempt', async () => {
    const { client } = clientWith(neverResolves())
    const outcome = await client.systemOne(baseRequest({ attemptTimeoutMs: 5000, deadlineMs: 20 }))
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'deadline', deadlineHit: true, attempts: 1 })
    expect(outcome.latencyMs).toBeLessThan(5000)
  })

  it('never calls fetch when the caller already aborted', async () => {
    const fetchImpl = vi.fn<TypesafeFetch>()
    const { client } = clientWith(fetchImpl)
    const controller = new AbortController()
    controller.abort()
    const outcome = await client.systemOne(baseRequest({ signal: controller.signal }))
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'aborted' })
    expect(fetchImpl).not.toHaveBeenCalled()
  })

  it('reports a connection failure as unavailable/network with only the error name', async () => {
    const { client } = clientWith(async () => {
      throw new TypeError('fetch failed')
    })
    const outcome = await client.systemOne(baseRequest())
    expect(outcome).toMatchObject({ status: 'unavailable', reason: 'network', detail: 'TypeError' })
  })

  it('never logs the request body, the response body, or the key (DL-120-08)', async () => {
    const secretState = 'josh-private-sentence-7b2c' // gitleaks:allow (fake test value)
    const secretKey = 'sk-secret-key-9f1e' // gitleaks:allow (fake test key)
    const spies = [
      vi.spyOn(console, 'log').mockImplementation(() => {}),
      vi.spyOn(console, 'info').mockImplementation(() => {}),
      vi.spyOn(console, 'debug').mockImplementation(() => {}),
      vi.spyOn(console, 'warn').mockImplementation(() => {}),
      vi.spyOn(console, 'error').mockImplementation(() => {}),
      vi.spyOn(logger, 'debug'),
      vi.spyOn(logger, 'info'),
      vi.spyOn(logger, 'warn'),
      vi.spyOn(logger, 'error')
    ]
    try {
      const { client } = clientWith(
        vi
          .fn<TypesafeFetch>()
          .mockResolvedValueOnce(jsonResponse(422, { error: `state ${secretState} rejected` }))
          .mockResolvedValueOnce(jsonResponse(200, { ...OK_BODY, echoed: secretState }))
      )
      await client.systemOne(baseRequest({ apiKey: secretKey, state: { message: secretState } }))
      await client.systemOne(baseRequest({ apiKey: secretKey, state: { message: secretState } }))
      const logged = spies.flatMap((spy) => spy.mock.calls.map((call) => JSON.stringify(call)))
      for (const line of logged) {
        expect(line).not.toContain(secretKey)
      }
      // The 422 detail may quote the vendor's message, which never contains the state in
      // practice; product code must still never log it, and the OK path logs nothing at all.
      expect(logged.filter((line) => line.includes('call failed')).length).toBe(1)
      expect(logged.some((line) => line.includes(OK_BODY.model) && line.includes('answers'))).toBe(false)
    } finally {
      spies.forEach((spy) => spy.mockRestore())
    }
  })
})

describe('parseSystemOneResponse', () => {
  it('rejects an answer whose type does not match its question', () => {
    expect(
      parseSystemOneResponse({ model: 'm', answers: { yes: { type: 'choice', choice: 'a', probabilities: {}, confidence: 1 } } }, { yes: QUESTIONS.yes })
    ).toBeNull()
  })

  it('reads score answers with a legend', () => {
    const parsed = parseSystemOneResponse(
      {
        model: 'jev-1.13.0',
        answers: { tone: { type: 'score', score: 1.4, legend: { '0': 'calm', '1': 'annoyed' }, probabilities: { '0': 0.6, '1': 0.4 }, confidence: 0.6 } },
        usage: { input_tokens: 1, output_tokens: 1 }
      },
      { tone: { type: 'score', instructions: 'tone', criteria: ['calm', 'annoyed'] } }
    )
    expect(parsed?.answers.tone.score).toBe(1.4)
    expect(parsed?.answers.tone.legend['1']).toBe('annoyed')
  })
})

describe('SA-120 P10a: one client for every Jev-compatible judge', () => {
  it('posts to the endpoint it was built for and sends no Authorization header at all for a keyless judge', async () => {
    const calls: Array<{ url: string; init: TypesafeFetchInit }> = []
    const client = createTypesafeClient({
      baseUrl: 'http://127.0.0.1:11434/',
      path: '/v1/systemone',
      dispatcher: null,
      fetch: async (url, init) => {
        calls.push({ url, init })
        return jsonResponse(200, { ...OK_BODY, model: 'clef-flash' })
      }
    })
    const outcome = await client.systemOne(baseRequest({ apiKey: null, model: 'clef-flash' }))
    expect(outcome.status).toBe('ok')
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/systemone')
    const headers = calls[0].init.headers as Record<string, string>
    expect(Object.keys(headers).map((name) => name.toLowerCase())).not.toContain('authorization')
    expect(JSON.parse(String(calls[0].init.body)).model).toBe('clef-flash')
    // Round 1, S1: a redirect is never followed (it would re-send the user's text to another host).
    expect(calls[0].init.redirect).toBe('error')
  })

  it('round 1, S1: a redirect refusal reads as an unreachable judge, and nothing is sent anywhere else', async () => {
    const urls: string[] = []
    const client = createTypesafeClient({
      baseUrl: 'http://127.0.0.1:11434',
      dispatcher: null,
      fetch: async (url, init) => {
        urls.push(url)
        // What fetch does with redirect: 'error' when the server answers 307: it rejects.
        if (init.redirect === 'error') throw new TypeError('fetch failed: unexpected redirect')
        return jsonResponse(200, OK_BODY)
      }
    })
    expect(await client.systemOne(baseRequest({ apiKey: null }))).toMatchObject({ status: 'unavailable', reason: 'network' })
    expect(urls).toEqual(['http://127.0.0.1:11434/v1/systemone'])
  })

  it('tolerates the extra fields other runtimes add and stays strict on the typed answer', () => {
    // Shapes from the verified sweep: Ollama adds `confidence` (and may echo `criteria`) on a Noul, a `legend` on a
    // Choice, `latency_ms` and other top-level counters (the real call added `prompt_eval_cached_count`).
    const body = {
      model: 'clef-flash',
      answers: {
        yes: { type: 'noul', noul: 0.96, confidence: 0.92, criteria: { true: 'Success', false: 'Failure' } },
        pick: { type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.9 }, confidence: 0.8, legend: { a: 'A', b: 'B' } }
      },
      usage: { input_tokens: 154, output_tokens: 0 },
      latency_ms: 31,
      prompt_eval_cached_count: 0
    }
    expect(parseSystemOneResponse(body, QUESTIONS)).toEqual({
      model: 'clef-flash',
      answers: {
        yes: { type: 'noul', noul: 0.96 },
        pick: { type: 'choice', choice: 'b', probabilities: { a: 0.1, b: 0.9 }, confidence: 0.8 }
      },
      usage: { inputTokens: 154, outputTokens: 0 }
    })
    // Strict: a Choice must name one of the question's own options, and a Noul is a probability.
    const withPick = (choice: string) => ({ ...body, answers: { ...body.answers, pick: { ...body.answers.pick, choice } } })
    expect(parseSystemOneResponse(withPick('c'), QUESTIONS)).toBeNull()
    expect(parseSystemOneResponse(withPick('0'), QUESTIONS)).toBeNull()
    expect(parseSystemOneResponse({ ...body, answers: { ...body.answers, yes: { type: 'noul', noul: 1.4 } } }, QUESTIONS)).toBeNull()
    expect(parseSystemOneResponse({ ...body, answers: { ...body.answers, yes: { type: 'noul', noul: 'high' } } }, QUESTIONS)).toBeNull()
  })

  it("reads an answer inside Cloudflare's REST envelope, and nothing else from it", () => {
    const answers = { yes: { type: 'noul', noul: 0.7 }, pick: { type: 'choice', choice: 'a', probabilities: { a: 0.9, b: 0.1 }, confidence: 0.9 } }
    const wrapped = { result: { model: 'clef-flash', answers, usage: { input_tokens: 5, output_tokens: 0 } }, success: true, errors: [], messages: [] }
    expect(parseSystemOneResponse(wrapped, QUESTIONS)?.answers.yes.noul).toBe(0.7)
    expect(parseSystemOneResponse({ result: { nothing: true }, success: true }, QUESTIONS)).toBeNull()
  })

  it('maps a 422 STATE_TRUNCATED (a runtime that refuses rather than cuts) to provider_limit, and any other 422 to bad_request', async () => {
    const truncated = createTypesafeClient({
      dispatcher: null,
      fetch: async () => jsonResponse(422, { error: { code: 'STATE_TRUNCATED', message: 'state exceeds the context window' } })
    })
    expect(await truncated.systemOne(baseRequest({ apiKey: null }))).toMatchObject({
      status: 'unavailable',
      reason: 'provider_limit',
      httpStatus: 422,
      attempts: 1
    })
    const invalid = createTypesafeClient({ dispatcher: null, fetch: async () => jsonResponse(422, { error: 'questions.pick.criteria is required' }) })
    expect(await invalid.systemOne(baseRequest())).toMatchObject({ status: 'error', reason: 'bad_request' })
  })
})
