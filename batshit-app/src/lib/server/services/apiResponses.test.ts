import { error, redirect } from '@sveltejs/kit'
import { describe, expect, it } from 'vitest'

import { serviceRefusalResponse } from './apiResponses'

// BL-89 follow-up: a service refusal is a plain Error carrying its own status. Rethrown from a
// route it is not a SvelteKit HttpError, so SvelteKit answered 500 "Internal Error" and the
// sentence was lost. serviceRefusalResponse turns it into the answer the route meant.

function refusal(message: string, status: number, extra: Record<string, unknown> = {}) {
  return Object.assign(new Error(message), { status, ...extra })
}

function caught(run: () => never): unknown {
  try {
    run()
  } catch (thrown) {
    return thrown
  }
  throw new Error('expected a throw')
}

describe('serviceRefusalResponse', () => {
  it('answers a refusal with its own status, sentence, code, and details', async () => {
    const response = serviceRefusalResponse(
      refusal('Artifact save blocked: "Enforce Batshit Artifact Structure" is enabled.', 400, {
        code: 'ARTIFACT_STRUCTURE_ENFORCED',
        details: { issues: [{ code: 'FIELD_NAME_REQUIRED', message: 'Give every field a name.' }] }
      })
    )

    expect(response?.status).toBe(400)
    expect(await response?.json()).toEqual({
      success: false,
      error: 'Artifact save blocked: "Enforce Batshit Artifact Structure" is enabled.',
      code: 'ARTIFACT_STRUCTURE_ENFORCED',
      details: { issues: [{ code: 'FIELD_NAME_REQUIRED', message: 'Give every field a name.' }] }
    })
  })

  it('keeps each refusal status: not found, forbidden, conflict', async () => {
    for (const status of [403, 404, 409]) {
      const response = serviceRefusalResponse(refusal('No.', status))
      expect(response?.status).toBe(status)
      expect(await response?.json()).toEqual({ success: false, error: 'No.' })
    }
  })

  it('leaves SvelteKit errors and redirects to the route, which rethrows them unchanged', () => {
    expect(serviceRefusalResponse(caught(() => error(404, 'Version not found')))).toBeNull()
    expect(serviceRefusalResponse(caught(() => redirect(303, '/login')))).toBeNull()
  })

  it('does not answer for a server failure or an error with no usable status or sentence', () => {
    expect(serviceRefusalResponse(refusal('Redis is down', 500))).toBeNull()
    expect(serviceRefusalResponse(refusal('Odd', 399))).toBeNull()
    expect(serviceRefusalResponse(refusal('Odd', 400.5))).toBeNull()
    expect(serviceRefusalResponse(Object.assign(new Error('No status'), { status: '400' }))).toBeNull()
    expect(serviceRefusalResponse(refusal('   ', 400))).toBeNull()
    expect(serviceRefusalResponse(new Error('plain'))).toBeNull()
    expect(serviceRefusalResponse('text')).toBeNull()
    expect(serviceRefusalResponse(null)).toBeNull()
  })
})
