// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { env } from '$env/dynamic/private'
import { readdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { GET } from './+server'
import { chatgptPlanEligibility, receiveChatgptPlanCallback } from '$lib/server/services/chatgptPlanHost'

const previous = { ...env }, host = globalThis as any
afterEach(() => {
  for (const key of Object.keys(env)) if (!(key in previous)) delete (env as any)[key]
  Object.assign(env, previous)
  vi.restoreAllMocks()
})
describe('local deployment and app callback admission', () => {
  it('admits only the named local deployments and exact configured origins', () => {
    const pinokio = { BATSHIT_RUNTIME_OWNER: 'pinokio', BATSHIT_CONTAINERIZED: '0', PORT: '5650', ORIGIN: 'http://127.0.0.1:5650', BATSHIT_RUNTIME_DATA_DIR: '/home/fixture/.batshit/pinokio/runtime' }
    expect(chatgptPlanEligibility(pinokio, 'darwin')).toMatchObject({ eligible: true, mode: 'pinokio-mac', callbackOrigin: pinokio.ORIGIN })
    expect(chatgptPlanEligibility(pinokio, 'linux').eligible).toBe(false)
    const wsl = { ...pinokio, BATSHIT_PINOKIO_HOST: 'windows-wsl', BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl' }
    expect(chatgptPlanEligibility(wsl, 'linux')).toMatchObject({ eligible: true, mode: 'pinokio-windows-wsl' })
    for (const patch of [{ PORT: '3000' }, { BATSHIT_RUNTIME_DATA_DIR: 'relative' }, { ORIGIN: 'http://localhost:5650' }, { BATSHIT_PINOKIO_HOST: 'other' }]) expect(chatgptPlanEligibility({ ...wsl, ...patch }, 'linux').eligible).toBe(false)
    expect(chatgptPlanEligibility(wsl, 'win32').eligible).toBe(false)
    const docker = { BATSHIT_CONTAINERIZED: '1', BATSHIT_CHATGPT_PLAN_DEPLOYMENT: 'local-docker', BATSHIT_CHATGPT_PLAN_BIND_HOST: '127.0.0.1', BATSHIT_CHATGPT_PLAN_PUBLISHED_PORT: '5613', ORIGIN: 'http://localhost:5613' }
    expect(chatgptPlanEligibility(docker, 'linux')).toMatchObject({ eligible: true, mode: 'docker-local', origin: docker.ORIGIN, callbackOrigin: 'http://127.0.0.1:5613', custodyRoot: '/var/lib/batshit-plan/custody' })
    for (const patch of [{ BATSHIT_CHATGPT_PLAN_DEPLOYMENT: '' }, { BATSHIT_CHATGPT_PLAN_BIND_HOST: '0.0.0.0' }, { BATSHIT_CHATGPT_PLAN_PUBLISHED_PORT: '5620' }, { ORIGIN: 'https://localhost:5613' }, { ORIGIN: 'http://server.lan:5613' }, { ORIGIN: 'http://localhost:5613/path' }]) expect(chatgptPlanEligibility({ ...docker, ...patch }, 'linux').eligible).toBe(false)
  })
  it('refuses unsolicited callbacks without creating a vault or owner, including wrong Host', async () => {
    const root = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-no-callback-owner-')))
    try {
      expect(host.__batshitChatgptPlanRuntime).toBeUndefined()
      Object.assign(env, { BATSHIT_RUNTIME_OWNER: 'pinokio', BATSHIT_CONTAINERIZED: '0', BATSHIT_RUNTIME_DATA_DIR: root, PORT: '5650', ORIGIN: 'http://127.0.0.1:5650' })
      if (process.platform === 'linux') Object.assign(env, { BATSHIT_PINOKIO_HOST: 'windows-wsl', BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl' })
      else delete env.BATSHIT_PINOKIO_LAUNCH_PROFILE
      const sinks = (['info', 'log', 'warn', 'error', 'debug'] as const).map(method => vi.spyOn(console, method).mockImplementation(() => {}))
      for (const hostHeader of ['127.0.0.1:5650', 'localhost:5650', '127.0.0.1:4567']) {
        const request = new Request('http://127.0.0.1:5650/auth/callback?code=UNSOLICITED_CODE_SENTINEL&state=UNSOLICITED_STATE_SENTINEL', { headers: { Host: hostHeader, 'X-Forwarded-Host': '127.0.0.1:5650' } })
        const response = await GET({ request } as any)
        expect(response.status).toBe(400); expect(await response.text()).not.toContain('SENTINEL')
        expect(response.headers.get('cache-control')).toBe('no-store')
      }
      expect(readdirSync(root)).toEqual([]); expect(host.__batshitChatgptPlanRuntime).toBeUndefined()
      expect(sinks.flatMap(sink => sink.mock.calls).flat().map(String).join('\n')).not.toContain('SENTINEL')
      expect(receiveChatgptPlanCallback(new Request('http://127.0.0.1:5650/auth/callback')).status).toBe(400)
    } finally { rmSync(root, { recursive: true, force: true }) }
  })
})
