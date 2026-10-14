// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { generateKeyPair, exportJWK, SignJWT } from 'jose'
import { createHash } from 'node:crypto'
import { get, request } from 'node:http'
import { mkdtempSync, realpathSync, rmSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ChatgptPlanVault } from '../chatgptPlanVault'
import { ChatgptPlanOAuth, planDiagnostic } from '../chatgptPlanOAuth'

const cleanup: (() => void)[] = []
afterEach(() => { for (const release of cleanup.splice(0).reverse()) release(); vi.restoreAllMocks() })
async function callback(url: string) {
  return new Promise<{ status: number; text: string }>((resolve, reject) => {
    get(url, response => {
      let text = ''; response.on('data', bytes => { text += bytes }); response.on('end', () => resolve({ status: response.statusCode!, text }))
    }).on('error', reject)
  })
}
async function settled(oauth: ChatgptPlanOAuth) {
  for (let i = 0; i < 100; i++) {
    const status = oauth.status('user-fixture')
    if (status.state !== 'waiting') return status
    await new Promise(resolve => setTimeout(resolve, 10))
  }
  throw new Error('fixture callback did not settle')
}
async function fixture() {
  const folder = realpathSync(mkdtempSync(path.join(os.tmpdir(), 'sa130-oauth-')))
  cleanup.push(() => rmSync(folder, { recursive: true, force: true }))
  const vault = new ChatgptPlanVault(folder, 'sa130-synthetic-instance-encryption-key')
  cleanup.push(() => vault.close())
  const { publicKey, privateKey } = await generateKeyPair('RS256', { extractable: true })
  const jwk = { ...await exportJWK(publicKey), kid: 'fixture-key', alg: 'RS256', use: 'sig' }
  let authorization: URL
  let sessionValid = true
  let wrongNonce = false
  let upstreamError = false
  let payloadPatch: Record<string, unknown> = {}
  let revocationFails = false
  const bodies: URLSearchParams[] = []
  const http = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input)
    if (url.endsWith('openid-configuration')) return Response.json({ issuer: 'https://auth.openai.com', jwks_uri: 'https://auth.openai.com/.well-known/jwks.json', revocation_endpoint: 'https://auth.openai.com/api/accounts/oauth/revoke' })
    if (url.endsWith('jwks.json')) return Response.json({ keys: [jwk] })
    if (url.endsWith('oauth/revoke')) return new Response('', { status: revocationFails ? 400 : 200 })
    expect(url).toBe('https://auth.openai.com/api/accounts/oauth/token')
    const body = new URLSearchParams(String(init?.body)); bodies.push(body)
    expect(body.get('client_id')).toBe('oaiapp_Fixture')
    expect(body.get('resource')).toBe('https://api.openai.com/v1')
    expect(body.get('client_secret')).toBeNull()
    if (upstreamError) return Response.json({ error: 'invalid_grant', error_description: 'RAW_SECRET_SENTINEL' }, { status: 400 })
    if (body.get('grant_type') === 'authorization_code') {
      expect(body.get('redirect_uri')).toBe(authorization.searchParams.get('redirect_uri'))
      expect(createHash('sha256').update(body.get('code_verifier')!).digest('base64url')).toBe(authorization.searchParams.get('code_challenge'))
    }
    const idToken = await new SignJWT({ nonce: wrongNonce ? 'wrong-nonce' : authorization.searchParams.get('nonce'), email: 'fixture@example.invalid' })
      .setProtectedHeader({ alg: 'RS256', kid: 'fixture-key' }).setIssuer('https://auth.openai.com').setSubject('Subject-A')
      .setAudience('oaiapp_Fixture').setIssuedAt().setExpirationTime('1h').sign(privateKey)
    return Response.json({ access_token: 'ACCESS_SECRET_SENTINEL', refresh_token: 'REFRESH_SECRET_SENTINEL', id_token: idToken, scope: 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct', token_type: 'Bearer', expires_in: 3600, ...payloadPatch })
  }) as typeof fetch
  const oauth = new ChatgptPlanOAuth(vault, async (token, user) => sessionValid && token === 'local-session-fixture' && user === 'user-fixture', http)
  cleanup.push(() => oauth.close())
  const start = async (accountId?: string) => { authorization = new URL(await oauth.start('user-fixture', 'local-session-fixture', accountId)); return authorization }
  const callbackUrl = (changes: Record<string, string> = {}) => {
    const url = new URL(authorization.searchParams.get('redirect_uri')!)
    for (const [key, value] of Object.entries({ state: authorization.searchParams.get('state')!, code: 'code-fixture', client_id: 'oaiapp_Fixture', ...changes })) url.searchParams.set(key, value)
    return url.href
  }
  return { vault, oauth, start, callbackUrl, bodies, http, logout: () => { sessionValid = false }, wrongNonce: () => { wrongNonce = true }, upstreamError: () => { upstreamError = true }, payload: (value: Record<string, unknown>) => { payloadPatch = value }, failRevocation: () => { revocationFails = true } }
}

describe('ChatGPT OAuth on a real loopback listener with synthetic OpenAI identity', () => {
  it('uses PKCE and validates actual signed OIDC; wrong state does not consume the attempt', async () => {
    const f = await fixture(), authorize = await f.start()
    expect(authorize.origin + authorize.pathname).toBe('https://auth.openai.com/api/accounts/authorize')
    expect(authorize.searchParams.get('client_id')).toBe('dynamic_agent_client')
    expect(authorize.searchParams.get('agent_name_hint')).toBe('Batshit')
    expect(authorize.searchParams.get('id_token_hint')).toBeNull()
    expect((await callback(f.callbackUrl({ state: 'unsolicited' }))).status).toBe(400)
    const redirect = new URL(authorize.searchParams.get('redirect_uri')!)
    const raw = async (requestPath: string, host = redirect.host) => new Promise<number>((resolve, reject) => {
      const req = request({ hostname: redirect.hostname, port: redirect.port, path: requestPath, headers: { Host: host } }, response => { response.resume(); response.on('end', () => resolve(response.statusCode!)) })
      req.on('error', reject); req.end()
    })
    expect(await raw('//[')).toBe(400)
    expect(await raw('/wrong-path')).toBe(400)
    expect(await raw(new URL(f.callbackUrl()).pathname + new URL(f.callbackUrl()).search, 'localhost:' + redirect.port)).toBe(400)
    expect(f.oauth.status('user-fixture').state).toBe('waiting')
    const response = await callback(f.callbackUrl())
    expect(response.text).not.toContain('code-fixture')
    await settled(f.oauth)
    // Surface fixture failures that the production error sanitizer correctly
    // hides, rather than mistaking a broken fixture for an OAuth rejection.
    await Promise.all(vi.mocked(f.http).mock.results.filter(result => result.type === 'return').map(result => result.value))
    expect((await settled(f.oauth)).state).toBe('complete')
    const row = f.vault.list('user-fixture')[0]
    expect(row).toMatchObject({ issuer: 'https://auth.openai.com', subject: 'Subject-A', clientId: 'oaiapp_Fixture', state: 'ready' })
    expect(f.vault.tokens('user-fixture', row.id, f.vault.binding(row)).accessToken).toBe('ACCESS_SECRET_SENTINEL')
    const refresh = f.vault.beginRefresh('user-fixture', row.id, f.vault.binding(row))
    const replacement = await f.oauth.refresh(refresh.registration, refresh.tokens, AbortSignal.timeout(5000))
    expect(f.vault.finishRefresh(refresh.registration, replacement)).toBe(true)
    expect(await f.oauth.revoke(row, replacement.refreshToken)).toBe(true)
  })
  it('rejects a returning changed client before token exchange and keeps the old account', async () => {
    const f = await fixture(); await f.start(); await callback(f.callbackUrl()); await settled(f.oauth)
    const row = f.vault.list('user-fixture')[0]
    await expect(f.start(row.id)).rejects.toMatchObject({ code: 'disconnect_required' })
    const disconnected = f.vault.disconnect('user-fixture', row.id)
    f.vault.finishRevocation(disconnected.registration, true)
    const originalBinding = f.vault.binding(disconnected.registration)
    const returning = await f.start(row.id)
    expect(returning.searchParams.get('client_id')).toBe('oaiapp_Fixture')
    expect(returning.searchParams.has('agent_name_hint')).toBe(false)
    await callback(f.callbackUrl({ client_id: 'oaiapp_Other' }))
    expect((await settled(f.oauth)).code).toBe('client_mismatch')
    expect(f.bodies).toHaveLength(1)
    expect(f.vault.binding(f.vault.get('user-fixture', row.id))).toBe(originalBinding)
  })
  it('logout and bad OIDC nonce cannot activate credentials', async () => {
    const loggedOut = await fixture(); await loggedOut.start(); loggedOut.logout()
    await callback(loggedOut.callbackUrl())
    expect((await settled(loggedOut.oauth)).code).toBe('session_expired')
    expect(loggedOut.bodies).toHaveLength(0)
    const wrong = await fixture(); await wrong.start(); wrong.wrongNonce(); await callback(wrong.callbackUrl())
    expect((await settled(wrong.oauth)).code).toBe('identity_invalid')
    expect(wrong.vault.list('user-fixture')).toEqual([])
  })
  it('sanitizes raw OAuth errors and never returns token fields in status', async () => {
    const f = await fixture(); await f.start(); f.upstreamError(); await callback(f.callbackUrl())
    const status = await settled(f.oauth)
    expect(status.code).toBe('invalid_grant')
    expect(JSON.stringify(status)).not.toContain('SECRET_SENTINEL')
    expect(JSON.stringify(planDiagnostic(new Error('RAW_SECRET_SENTINEL', { cause: { access_token: 'ACCESS_SECRET_SENTINEL' } })))).not.toContain('SECRET_SENTINEL')
  })
  it('cleans malformed activation tokens before parsing and reports unconfirmed revocation', async () => {
    const f = await fixture(); await f.start(); f.payload({ expires_in: -1 }); f.failRevocation()
    await callback(f.callbackUrl())
    expect(await settled(f.oauth)).toMatchObject({ state: 'error', cleanup: 'unconfirmed' })
    expect(vi.mocked(f.http).mock.calls.filter(call => String(call[0]).endsWith('oauth/revoke'))).toHaveLength(1)
    expect(f.vault.list('user-fixture')).toEqual([])
  })
  it('revokes a rotated renewable credential rejected for scope loss', async () => {
    const f = await fixture(); await f.start(); await callback(f.callbackUrl()); await settled(f.oauth)
    const row = f.vault.list('user-fixture')[0]
    const refresh = f.vault.beginRefresh('user-fixture', row.id, f.vault.binding(row))
    f.payload({ refresh_token: 'ROTATED_FIXTURE', scope: 'openid profile email' })
    await expect(f.oauth.refresh(refresh.registration, refresh.tokens, AbortSignal.timeout(5000))).rejects.toMatchObject({ cleanupConfirmed: true })
    const revoke = vi.mocked(f.http).mock.calls.filter(call => String(call[0]).endsWith('oauth/revoke'))
    expect(new URLSearchParams(String(revoke[0][1]?.body)).get('token')).toBe('ROTATED_FIXTURE')
  })
})

it('refuses a new sign-in after the OAuth owner closes (BL-1061)', async () => {
  const f = await fixture(); f.oauth.close()
  await expect(f.start()).rejects.toMatchObject({ code: 'request_stopped' })
  expect(f.http).not.toHaveBeenCalled(); expect(f.vault.list('user-fixture')).toHaveLength(0)
})

it('refuses a start whose initial session validation settles after close (BL-1061)', async () => {
  const f = await fixture()
  let validate!: (valid: boolean) => void
  const validation = new Promise<boolean>(resolve => { validate = resolve })
  const oauth = new ChatgptPlanOAuth(f.vault, async () => validation, f.http)
  cleanup.push(() => oauth.close())
  const begin = vi.spyOn(f.vault, 'beginAuthorization')
  const start = oauth.start('user-fixture', 'local-session-fixture')
  oauth.close(); validate(true)
  await expect(start).rejects.toMatchObject({ code: 'request_stopped' })
  expect(begin).not.toHaveBeenCalled(); expect(f.http).not.toHaveBeenCalled()
})
