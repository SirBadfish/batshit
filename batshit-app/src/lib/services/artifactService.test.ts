import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { ApiCallError } from './redisCore'
import { ArtifactService } from './artifactService'

// BL-89 follow-up: Settings' raw HTML editor and the artifact sidebar read a failed save as raw
// text, so a refusal reached the user as `{"message":"Internal Error"}` (or as raw JSON once the
// routes answer properly). Saves now go through this service, whose failures carry the server's
// own sentence (ApiCallError).

const SENTENCE =
  'Artifact save blocked: "Enforce Batshit Artifact Structure" is enabled.\n- Give every field a name a screen reader can read.'

function answerWith(body: unknown, status: number) {
  const fetchMock = vi.fn(async () => new Response(JSON.stringify(body), { status }))
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

async function failure(run: () => Promise<unknown>): Promise<ApiCallError> {
  return run().then(
    () => {
      throw new Error('expected the call to fail')
    },
    (error: ApiCallError) => error
  )
}

describe('artifact saves say why they were refused', () => {
  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('update rejects with the refusal sentence, and keeps the code on the error', async () => {
    const fetchMock = answerWith({ success: false, error: SENTENCE, code: 'ARTIFACT_STRUCTURE_ENFORCED' }, 400)

    const error = await failure(() => new ArtifactService().updateArtifact('a1', { content: '<input>' } as any))

    expect(error).toBeInstanceOf(ApiCallError)
    expect(error.message).toBe(SENTENCE)
    expect(error.status).toBe(400)
    expect((error.payload as { code?: string }).code).toBe('ARTIFACT_STRUCTURE_ENFORCED')
    expect(fetchMock).toHaveBeenCalledWith('/api/artifacts/a1', expect.objectContaining({ method: 'PUT' }))
  })

  it('restoring a version sends the restore and rejects with the refusal sentence', async () => {
    const fetchMock = answerWith({ success: false, error: SENTENCE }, 400)

    const error = await failure(() => new ArtifactService().restoreVersion('a1', 2))

    expect(error.message).toBe(SENTENCE)
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit]
    expect(url).toBe('/api/artifacts/versions')
    expect(init.method).toBe('PUT')
    expect(JSON.parse(String(init.body))).toEqual({ artifactId: 'a1', targetVersion: 2 })
  })

  it('restoring a version returns the route answer', async () => {
    answerWith({ success: true, newVersion: 4, message: 'Restored to version 2 as new version 4' }, 200)
    await expect(new ArtifactService().restoreVersion('a1', 2)).resolves.toMatchObject({ success: true, newVersion: 4 })
  })

  it('Settings and the artifact sidebar save through this service, never through a raw fetch', () => {
    for (const file of [
      'src/lib/components/settings/panels/ArtifactSettingsPanel.svelte',
      'src/lib/components/artifacts/ArtifactsSidebar.svelte'
    ]) {
      const source = readFileSync(resolve(process.cwd(), file), 'utf8')
      expect(source, file).not.toMatch(/fetch\(\s*`\/api\/artifacts\/\$\{[^}]+\}`\s*,\s*\{\s*method:\s*'PUT'/)
      expect(source, file).not.toMatch(/fetch\(\s*'\/api\/artifacts\/versions'\s*,\s*\{\s*method:\s*'PUT'/)
    }
  })
})
