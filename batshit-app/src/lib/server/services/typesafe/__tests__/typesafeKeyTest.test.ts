// @vitest-environment node
import { describe, expect, it, vi } from 'vitest'
import type { TypesafeFetch, TypesafeFetchInit } from '../typesafeClient'

/**
 * SA-120 P10a (DL-120-18) — the fixed sample question, sent to any judge (`testJudgeProvider`). It is the only text a
 * Test sends; the answer names the judge and where it ran; a failure names who serves it.
 */

vi.mock('../typesafeConfig', () => ({
  getTypesafeConfig: vi.fn(async () => ({ enabled: false, modelId: 'jev-1.13.0', attemptTimeoutMs: 5000 }))
}))

import { testJudgeProvider } from '../typesafeKeyTest'

function answering(model: string) {
  const calls: Array<{ url: string; init: TypesafeFetchInit }> = []
  const fetchImpl: TypesafeFetch = async (url, init) => {
    calls.push({ url, init })
    return new Response(JSON.stringify({ model, answers: { good_news: { type: 'noul', noul: 0.96 } }, usage: { input_tokens: 154, output_tokens: 0 } }), {
      status: 200,
      headers: { 'content-type': 'application/json' }
    })
  }
  return { calls, fetchImpl }
}

describe('testJudgeProvider', () => {
  it('asks a local Ollama judge the one fixed question with no key, and says where it answered', async () => {
    const { calls, fetchImpl } = answering('clef-flash')
    const result = await testJudgeProvider(
      { id: 'ollama-mac', kind: 'ollama', label: 'Ollama on this Mac', baseUrl: 'http://127.0.0.1:11434', modelId: 'clef-flash' },
      null,
      { fetch: fetchImpl }
    )
    expect(result).toMatchObject({ ok: true, model: 'clef-flash' })
    if (result.ok) expect(result.message).toMatch(/^Clef Flash \(Ollama\) answered on this computer in \d+ ms\.$/)
    expect(calls[0].url).toBe('http://127.0.0.1:11434/v1/systemone')
    expect(Object.keys(calls[0].init.headers as Record<string, string>).map((name) => name.toLowerCase())).not.toContain('authorization')
    expect(JSON.parse(String(calls[0].init.body))).toEqual({
      state: { message: 'The build passed and every test is green.' },
      model: 'clef-flash',
      questions: {
        good_news: {
          type: 'noul',
          instructions: 'Does `message` report good news?',
          criteria: { true: 'Success, progress, or relief', false: 'Failure, a problem, or nothing happened' }
        }
      }
    })
  })

  it('keeps the TypeSafe wording and names the service in a failure', async () => {
    const { fetchImpl } = answering('jev-1.13.0')
    const typesafe = await testJudgeProvider({ id: 'typesafe', kind: 'typesafe', label: 'TypeSafe', modelId: 'jev-1.13.0' }, 'ts-key', { fetch: fetchImpl })
    if (!typesafe.ok) throw new Error('expected ok')
    expect(typesafe.message).toMatch(/^jev-1\.13\.0 answered in \d+ ms\.$/)

    const down = await testJudgeProvider(
      { id: 'ollama-pc', kind: 'ollama', label: 'PC', baseUrl: 'http://192.168.1.20:11434', modelId: 'nimble' },
      null,
      {
        fetch: async () => {
          throw new TypeError('fetch failed')
        }
      }
    )
    expect(down).toMatchObject({ ok: false, reason: 'network', error: 'Batshit could not reach Ollama. (TypeError)' })
  })
})
