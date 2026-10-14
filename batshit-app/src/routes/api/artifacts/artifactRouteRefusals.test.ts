import { beforeEach, describe, expect, it, vi } from 'vitest'
import { isHttpError } from '@sveltejs/kit'

// BL-89 follow-up: the artifact REST routes rethrew ArtifactsService's refusals (plain Errors that
// carry `status`), which SvelteKit turned into 500 "Internal Error". Settings' raw HTML editor then
// showed `{"message":"Internal Error"}` instead of why the save was refused. Every route that
// rethrew must answer the refusal with its own status and sentence.

const service = vi.hoisted(() => ({
  create: vi.fn(),
  update: vi.fn(),
  delete: vi.fn(),
  getAccessible: vi.fn(),
  getOwned: vi.fn(),
  addVersion: vi.fn(),
  rollbackToVersion: vi.fn(),
  deleteVersion: vi.fn()
}))

vi.mock('$lib/server/artifacts/artifactsService', () => ({
  ArtifactsService: vi.fn(function ArtifactsService() {
    return service
  })
}))

vi.mock('$lib/server/services/artifactRuntimeAuth', () => ({
  isOpaqueArtifactRuntimeRequest: vi.fn(() => false),
  requireArtifactRuntimeClaims: vi.fn(async () => null),
  resolveArtifactRuntimeClaims: vi.fn(async () => null)
}))

import { POST as createArtifact } from './+server'
import { GET as getArtifact, PUT as updateArtifact, DELETE as deleteArtifact } from './[id]/+server'
import {
  GET as getVersions,
  POST as addVersion,
  PUT as restoreVersion,
  DELETE as deleteVersion
} from './versions/+server'

const SENTENCE =
  'Artifact save blocked: "Enforce Batshit Artifact Structure" is enabled.\n- Give every field a name a screen reader can read.'
const ISSUES = [{ code: 'FIELD_NAME_REQUIRED', message: 'Give every field a name a screen reader can read.' }]

function structureRefusal() {
  return Object.assign(new Error(SENTENCE), {
    status: 400,
    code: 'ARTIFACT_STRUCTURE_ENFORCED',
    details: { issues: ISSUES }
  })
}

function notFound() {
  return Object.assign(new Error('Artifact not found'), { status: 404 })
}

function event(url: string, method: string, body?: unknown, params: Record<string, string> = {}) {
  return {
    url: new URL(url),
    params,
    request: new Request(url, {
      method,
      headers: { 'Content-Type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body)
    }),
    locals: { user: { id: 'user-1' } }
  } as any
}

async function expectRefusal(response: Response, status: number, sentence: string) {
  expect(response.status).toBe(status)
  const body = await response.json()
  expect(body.success).toBe(false)
  expect(body.error).toBe(sentence)
  return body
}

describe('artifact REST routes answer a save refusal with its status and sentence', () => {
  beforeEach(() => {
    for (const method of Object.values(service)) method.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('create (POST /api/artifacts)', async () => {
    service.create.mockRejectedValue(structureRefusal())
    const body = await expectRefusal(
      await createArtifact(event('http://localhost/api/artifacts', 'POST', { name: 'Tip' })),
      400,
      SENTENCE
    )
    expect(body.code).toBe('ARTIFACT_STRUCTURE_ENFORCED')
    expect(body.details).toEqual({ issues: ISSUES })
  })

  it('update (PUT /api/artifacts/[id]): the Settings raw HTML editor save', async () => {
    service.update.mockRejectedValue(structureRefusal())
    await expectRefusal(
      await updateArtifact(event('http://localhost/api/artifacts/a1', 'PUT', { content: '<input>' }, { id: 'a1' })),
      400,
      SENTENCE
    )
  })

  it('add version, restore, and delete version (/api/artifacts/versions)', async () => {
    service.addVersion.mockRejectedValue(structureRefusal())
    await expectRefusal(
      await addVersion(event('http://localhost/api/artifacts/versions', 'POST', { artifactId: 'a1', content: '<input>' })),
      400,
      SENTENCE
    )

    service.rollbackToVersion.mockRejectedValue(structureRefusal())
    await expectRefusal(
      await restoreVersion(event('http://localhost/api/artifacts/versions', 'PUT', { artifactId: 'a1', targetVersion: 2 })),
      400,
      SENTENCE
    )

    service.deleteVersion.mockRejectedValue(
      Object.assign(new Error('Cannot delete current version'), { status: 400 })
    )
    await expectRefusal(
      await deleteVersion(event('http://localhost/api/artifacts/versions?artifactId=a1&version=3', 'DELETE')),
      400,
      'Cannot delete current version'
    )
  })

  it('reads and deletes keep a not-found or forbidden status instead of turning it into 500', async () => {
    service.getAccessible.mockRejectedValue(notFound())
    await expectRefusal(await getArtifact(event('http://localhost/api/artifacts/a1', 'GET', undefined, { id: 'a1' })), 404, 'Artifact not found')

    service.delete.mockRejectedValue(Object.assign(new Error('Access denied'), { status: 403 }))
    await expectRefusal(await deleteArtifact(event('http://localhost/api/artifacts/a1', 'DELETE', undefined, { id: 'a1' })), 403, 'Access denied')

    service.getOwned.mockRejectedValue(notFound())
    await expectRefusal(await getVersions(event('http://localhost/api/artifacts/versions?artifactId=a1', 'GET')), 404, 'Artifact not found')
  })

  it('still passes a SvelteKit error through and still answers 500 for an unexpected failure', async () => {
    service.getOwned.mockResolvedValue({ versions: [{ version: 1 }] })
    const missingVersion = await getVersions(
      event('http://localhost/api/artifacts/versions?artifactId=a1&version=9', 'GET')
    ).catch((thrown: unknown) => thrown)
    expect(isHttpError(missingVersion, 404)).toBe(true)

    service.update.mockRejectedValue(new Error('redis unavailable'))
    const unexpected = await updateArtifact(
      event('http://localhost/api/artifacts/a1', 'PUT', { name: 'x' }, { id: 'a1' })
    ).catch((thrown: unknown) => thrown)
    expect(isHttpError(unexpected, 500)).toBe(true)
  })
})

describe('PUT /api/artifacts/[id] passes the edit base version to the service (BL-546)', () => {
  beforeEach(() => {
    for (const method of Object.values(service)) method.mockReset()
    vi.spyOn(console, 'error').mockImplementation(() => {})
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })

  it('hands baseVersion to the service as expectedVersion and keeps it out of the saved fields', async () => {
    service.update.mockResolvedValue({ id: 'a1', version: 4 })
    const response = await updateArtifact(
      event('http://localhost/api/artifacts/a1', 'PUT', { content: '<div>edit</div>', baseVersion: 3 }, { id: 'a1' })
    )
    expect(response.status).toBe(200)
    expect(service.update).toHaveBeenCalledWith('a1', 'user-1', { content: '<div>edit</div>' }, { expectedVersion: 3 })
  })

  it('sends no expected version when the save names none (a zone change)', async () => {
    service.update.mockResolvedValue({ id: 'a1', version: 3 })
    await updateArtifact(event('http://localhost/api/artifacts/a1', 'PUT', { zone: 'panel' }, { id: 'a1' }))
    expect(service.update).toHaveBeenCalledWith('a1', 'user-1', { zone: 'panel' }, {})
  })

  it('answers the version refusal as 409 with its code and both versions', async () => {
    service.update.mockRejectedValue(
      Object.assign(new Error('This artifact changed after this edit started.'), {
        status: 409,
        code: 'ARTIFACT_VERSION_CONFLICT',
        details: { storedVersion: 5, baseVersion: 3 }
      })
    )
    const body = await expectRefusal(
      await updateArtifact(
        event('http://localhost/api/artifacts/a1', 'PUT', { content: '<div>edit</div>', baseVersion: 3 }, { id: 'a1' })
      ),
      409,
      'This artifact changed after this edit started.'
    )
    expect(body.code).toBe('ARTIFACT_VERSION_CONFLICT')
    expect(body.details).toEqual({ storedVersion: 5, baseVersion: 3 })
  })

  it('refuses a base version that is not a whole number, and a body that is not an object', async () => {
    const badVersion = await updateArtifact(
      event('http://localhost/api/artifacts/a1', 'PUT', { content: '<div>edit</div>', baseVersion: '3' }, { id: 'a1' })
    )
    expect(badVersion.status).toBe(400)
    const notObject = await updateArtifact(event('http://localhost/api/artifacts/a1', 'PUT', ['x'], { id: 'a1' }))
    expect(notObject.status).toBe(400)
    expect(service.update).not.toHaveBeenCalled()
  })
})
