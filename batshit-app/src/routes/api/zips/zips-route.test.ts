import { describe, expect, it } from 'vitest'
import { api } from '$lib/services/api'
import { uploadApiService } from '$lib/services/uploadApi'
import * as zipsRoute from './+server'

/**
 * BL-1997 (BL-1825): a tab never creates or overwrites a zip. Every zip is written by the server
 * that produced it. The old `POST /api/zips` took the id, content and metadata from the request
 * body and wrote `zip:{id}` with `JSON.SET` over whatever was there, so a tab could replace a
 * server-written tool result (and, with SA-137, forge a `fileReadSource` descriptor). With no
 * POST export, SvelteKit answers 405.
 */

describe('/api/zips', () => {
  it('has no browser create under any verb: only the owned read and delete', () => {
    expect((zipsRoute as Record<string, unknown>).POST).toBeUndefined()
    expect(Object.keys(zipsRoute).sort()).toEqual(['DELETE', 'GET'])
  })

  it('has no client wrapper that posts a zip', () => {
    expect((api as Record<string, unknown>).createZip).toBeUndefined()
    expect((uploadApiService as unknown as Record<string, unknown>).createZip).toBeUndefined()
  })
})
