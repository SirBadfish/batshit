import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { env } from '$env/dynamic/private'
import { resolveNativeToolUser } from '../nativeToolAuth'

const SERVICE_TOKEN = 'test-service-token-0123456789abcdef0123456789abcdef'
const USER = 'user-lane'
let previousServiceToken: string | undefined
const request = (headers: Record<string, string> = {}) => new Request('http://localhost/api/controls/use', { method: 'POST', headers })
const serviceHeaders = () => ({ 'x-batshit-service-token': SERVICE_TOKEN, 'x-batshit-user-id': USER })

beforeEach(() => {
  previousServiceToken = (env as Record<string, string | undefined>).BATSHIT_TOKEN
  ;(env as Record<string, string | undefined>).BATSHIT_TOKEN = SERVICE_TOKEN
})
afterEach(() => {
  if (previousServiceToken === undefined) delete (env as Record<string, string | undefined>).BATSHIT_TOKEN
  else (env as Record<string, string | undefined>).BATSHIT_TOKEN = previousServiceToken
})

describe('retired run credential refusal', () => {
  for (const value of ['', 'nonsense', 'arc_known.bsac_secret']) {
    it(`refuses the presented header ${JSON.stringify(value)} without falling through`, async () => {
      for (const headers of [{}, serviceHeaders()]) {
        expect(await resolveNativeToolUser({
          request: request({ ...headers, 'x-batshit-agent-token': value }), localsUserId: USER
        })).toBeNull()
      }
    })
  }
  it('retains the normal service and session lanes when the retired header is absent', async () => {
    expect(await resolveNativeToolUser({ request: request(serviceHeaders()) })).toEqual({ userId: USER, auth: 'service' })
    expect(await resolveNativeToolUser({ request: request(), localsUserId: USER })).toEqual({ userId: USER, auth: 'session' })
    expect(await resolveNativeToolUser({ request: request() })).toBeNull()
  })
  it('does not accept an invalid service token without a session', async () => {
    expect(await resolveNativeToolUser({ request: request({ 'x-batshit-service-token': 'wrong', 'x-batshit-user-id': USER }) })).toBeNull()
  })
  it('normalizes a service caller’s user ID to lower case', async () => {
    expect(await resolveNativeToolUser({
      request: request({ 'x-batshit-service-token': SERVICE_TOKEN, 'x-batshit-user-id': 'USER-Lane' })
    })).toEqual({ userId: 'user-lane', auth: 'service' })
  })
  it('falls back from an invalid service token to an existing signed-in session', async () => {
    expect(await resolveNativeToolUser({
      request: request({ 'x-batshit-service-token': 'wrong', 'x-batshit-user-id': 'another-user' }), localsUserId: USER
    })).toEqual({ userId: USER, auth: 'session' })
  })
})
