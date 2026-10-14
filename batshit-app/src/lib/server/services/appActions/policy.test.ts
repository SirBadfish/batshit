import { describe, it } from 'vitest'
import assert from 'node:assert/strict'
import { processTopologyRefusal, requireDocumentCookiePolicy } from './policy'

const url = new URL('https://current-tunnel.example/api/app/actions/register')
const locals = { user: { id: 'owner' }, session: { token: 'private-cookie', user_id: 'owner' } }
function request(headers: Record<string, string> = {}, method = 'POST') {
  return new Request(url, { method, headers: { 'content-type': 'application/json', origin: url.origin, 'sec-fetch-site': 'same-origin', ...headers } })
}
describe('App Actions document credential/origin and one-process policy', () => {
  it('admits only a matching authenticated cookie session at the current origin', () => {
    assert.deepEqual(requireDocumentCookiePolicy(request(), url, locals), { userId: 'owner', authenticationSession: 'private-cookie' })
    assert.throws(() => requireDocumentCookiePolicy(request(), url, { ...locals, user: null }), /authentication_required/)
    assert.throws(() => requireDocumentCookiePolicy(request(), url, { ...locals, session: { ...locals.session, user_id: 'other' } }), /authentication_required/)
    assert.throws(() => requireDocumentCookiePolicy(request({ origin: 'https://old-tunnel.example' }), url, locals), /untrusted_origin/)
    assert.throws(() => requireDocumentCookiePolicy(request({ 'sec-fetch-site': 'same-site' }), url, locals), /untrusted_origin/)
    assert.throws(() => requireDocumentCookiePolicy(request({ 'content-type': 'text/plain' }), url, locals), /untrusted_origin/)
    const noOrigin = new Request(url, { method: 'POST', headers: { 'content-type': 'application/json' } })
    assert.throws(() => requireDocumentCookiePolicy(noOrigin, url, locals), /untrusted_origin/)
  })
  it('default-denies native, unknown, bearer and portable credentials even beside a good cookie', () => {
    for (const header of ['x-batshit-service-token', 'x-batshit-agent-token', 'x-batshit-portable-token', 'x-batshit-unknown-token', 'authorization']) {
      assert.throws(() => requireDocumentCookiePolicy(request({ [header]: 'credential' }), url, locals), /credential_not_admitted/)
    }
  })
  it('supports existing Mac/Docker/dev topology, and refuses every known replicated/worker marker', () => {
    assert.equal(processTopologyRefusal({}, false), null)
    assert.equal(processTopologyRefusal({ NODE_ENV: 'production', BATSHIT_CONTAINERIZED: '1' }, false), null)
    assert.equal(processTopologyRefusal({ WEB_CONCURRENCY: '1' }, false), null)
    for (const config of [{ VERCEL: '1' }, { NODE_APP_INSTANCE: '0' }, { PM2_HOME: '/tmp/pm2' }, { WEB_CONCURRENCY: '2' }, { NODE_CLUSTER_SCHED_POLICY: 'rr' }]) {
      assert.equal(processTopologyRefusal(config, false), 'unsupported_process_topology')
    }
    assert.equal(processTopologyRefusal({}, true), 'unsupported_process_topology')
  })
})
