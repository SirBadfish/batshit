import { describe, it, expect, vi } from 'vitest'

// Ensure we use the real RedisService, even if other suites mocked the module earlier
vi.mock('$lib/server/redis', async () => {
  const actual = await vi.importActual<typeof import('$lib/server/redis')>('$lib/server/redis')
  return actual
})

import { useRedisTestServer } from '$lib/test-utils/redis-memory'
import { ArtifactsService, isRedisJsonMissingPathError } from '$lib/server/artifacts/artifactsService'
import { RedisService } from '$lib/server/redis'
import { DEFAULT_ARTIFACT_SCAFFOLD_CONTENT } from '$lib/artifacts/structureEnforcement'
import {
  finishArtifactRunLog,
  getArtifactRunLog,
  listArtifactRunLogs,
  markArtifactRunPrepared,
  startArtifactRunLog
} from '$lib/server/artifacts/artifactRunLogs'

const COMPLIANT_ARTIFACT_CONTENT = `<!DOCTYPE html>
<html>
<body>
  <div id="app"></div>
  <script>
    const root = window.batshit.builder.createRoot();
    const prompt = window.batshit.builder.form.text({
      label: 'Prompt',
      fabricId: 'prompt',
      onChange: () => {}
    });
    const actions = window.batshit.builder.action.standardControls({
      storageKey: 'lastResult',
      title: 'Test Result'
    });
    window.batshit.builder.mount(document.getElementById('app'), prompt);
    window.batshit.builder.mount(document.getElementById('app'), actions.shell);
  </script>
</body>
</html>`

// Real-Redis suite (G-0228): this file intentionally restores the REAL $lib/server/redis
// module via vi.importActual, so it runs only under `npm run test:redis`
// (VITEST_USE_REAL_REDIS=true) and reports as skipped in the default mocked lane.
const REAL_REDIS_LANE = process.env.VITEST_USE_REAL_REDIS === 'true'

describe.runIf(REAL_REDIS_LANE)('ArtifactsService legacy cleanup', () => {
  useRedisTestServer()
  const service = new ArtifactsService()

  it('blocks creating raw HTML artifacts while structure enforcement is on', async () => {
    const userId = 'user_structure_blocked'

    await expect(
      service.create(userId, {
        name: 'Raw HTML Artifact',
        content: '<div>raw html only</div>',
        mode: 'edit'
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_STRUCTURE_ENFORCED'
    })
  })

  it('refuses a field an agent could never set because the run call keeps its name', async () => {
    const userId = 'user_reserved_fields'
    const error = await service
      .create(userId, {
        name: 'Model picker',
        content: COMPLIANT_ARTIFACT_CONTENT,
        metadata: { enforce_batshit_artifact_structure: false, fabric_fields: [{ fabricId: 'prompt', type: 'text' }, { fabricId: 'model', type: 'select' }] },
        mode: 'edit'
      })
      .catch((err) => err)
    expect(error).toMatchObject({ status: 400, code: 'ARTIFACT_FABRIC_FIELD_RESERVED' })
    expect(error.message).toContain('fabricId "model" is reserved')
    expect(error.message).toContain('"model_name"')

    const ok = await service.create(userId, {
      name: 'Model picker',
      content: COMPLIANT_ARTIFACT_CONTENT,
      metadata: { enforce_batshit_artifact_structure: false, fabric_fields: [{ fabricId: 'prompt', type: 'text' }, { fabricId: 'model_name', type: 'select' }] },
      mode: 'edit'
    })
    await expect(
      service.update(ok.id, userId, { metadata: { fabric_fields: [{ fabricId: 'context', type: 'text' }] } } as any)
    ).rejects.toMatchObject({ code: 'ARTIFACT_FABRIC_FIELD_RESERVED' })
  })

  it('saves a Pinokio app artifact only with an app id, its real kind, no address, and a recipe to publish (SA-072 P2)', async () => {
    const userId = 'user_pinokio_artifact'
    const metadata = {
      source_type: 'comfyui',
      runtime_manager: 'pinokio',
      pinokio_app_id: 'comfy.git',
      fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
    }

    await expect(
      service.create(userId, {
        name: 'No app id',
        content: COMPLIANT_ARTIFACT_CONTENT,
        brain_type: 'pinokio_app',
        metadata: { ...metadata, pinokio_app_id: 'http://localhost:8188' },
        mode: 'edit'
      })
    ).rejects.toMatchObject({ status: 400, code: 'ARTIFACT_PINOKIO_INVALID' })

    const draft = await service.create(userId, {
      name: 'Flux via Pinokio',
      content: COMPLIANT_ARTIFACT_CONTENT,
      brain_type: 'pinokio_app',
      metadata,
      mode: 'edit'
    })
    expect(draft.brain_type).toBe('pinokio_app')
    expect(draft.webhook_url).toBeNull()
    // A Pinokio app has a Batshit runtime, so agents may use it (unlike a plain ComfyUI panel).
    expect(draft.agent_use_enabled).toBe(true)

    await expect(service.update(draft.id, userId, { mode: 'published', zone: 'panel' } as any)).rejects.toMatchObject({
      code: 'ARTIFACT_PINOKIO_INVALID'
    })

    const published = await service.update(draft.id, userId, {
      mode: 'published',
      zone: 'panel',
      metadata: {
        pinokio_runtime: {
          workflow: { '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat' } } },
          inputs: { prompt: { node: '6', input: 'text' } }
        }
      }
    } as any)
    expect(published.mode).toBe('published')
    expect(published.metadata).toMatchObject({ runtime_manager: 'pinokio', pinokio_app_id: 'comfy.git', source_type: 'comfyui' })

    // Leaving Pinokio: the marker is cleared explicitly and the artifact saves as its new kind.
    const leftPinokio = await service.update(draft.id, userId, {
      brain_type: 'built_in',
      metadata: { runtime_manager: null, source_type: 'built_in' }
    } as any)
    expect(leftPinokio.brain_type).toBe('built_in')
  })

  it('allows scaffold draft creation before the user disables enforcement or adds real structure', async () => {
    const userId = 'user_structure_scaffold'

    const created = await service.create(userId, {
      name: 'Scaffold Artifact',
      content: DEFAULT_ARTIFACT_SCAFFOLD_CONTENT,
      mode: 'edit'
    })

    expect(created.content).toBe(DEFAULT_ARTIFACT_SCAFFOLD_CONTENT)
    expect(created.metadata?.enforce_batshit_artifact_structure).toBe(true)
  })

  it('allows raw HTML artifacts when structure enforcement is explicitly disabled', async () => {
    const userId = 'user_structure_disabled'

    const created = await service.create(userId, {
      name: 'Manual Artifact',
      content: '<div>raw html only</div>',
      mode: 'edit',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    expect(created.metadata?.enforce_batshit_artifact_structure).toBe(false)
    expect(created.content).toContain('raw html only')
  })

  it('blocks artifact saves with invalid inline JavaScript even when structure enforcement is disabled', async () => {
    const userId = 'user_html_preflight_block'

    await expect(
      service.create(userId, {
        name: 'Broken Script Artifact',
        content: '<!doctype html><script>const label = \\`Broken\\`;</script>',
        mode: 'edit',
        metadata: {
          enforce_batshit_artifact_structure: false
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_HTML_PREFLIGHT_FAILED'
    })
  })

  it('reports inline JavaScript syntax errors through validateStructure preflight', async () => {
    const result = await service.validateStructure('user_html_preflight_validate', {
      content: [
        '<!doctype html>',
        '<html>',
        '<body>',
        '<script>',
        'const label = \\`Broken\\`;',
        '</script>',
        '</body>',
        '</html>'
      ].join('\n'),
      metadata: {
        enforce_batshit_artifact_structure: false
      },
      mode: 'edit'
    })

    expect(result.valid).toBe(false)
    expect(result.canSave).toBe(false)
    expect(result.message).toContain('artifact HTML preflight failed')
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'INLINE_SCRIPT_SYNTAX_ERROR',
          message: expect.stringContaining('Inline script #1 has invalid JavaScript at artifact line 5')
        })
      ])
    )
    expect(result.htmlPreflight.checkedScripts).toBe(1)
  })

  it('blocks unsupported window.batshit.ai runtime API calls during preflight', async () => {
    const result = await service.validateStructure('user_html_preflight_unsupported_api', {
      content: [
        '<!doctype html>',
        '<html>',
        '<body>',
        '<script>',
        'const b = window.batshit;',
        "b.ai.generateImage({ prompt: 'A sunset' });",
        '</script>',
        '</body>',
        '</html>'
      ].join('\n'),
      metadata: {
        enforce_batshit_artifact_structure: false
      },
      mode: 'edit'
    })

    expect(result.valid).toBe(false)
    expect(result.canSave).toBe(false)
    expect(result.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_RUNTIME_API',
          message: expect.stringContaining('There is no window.batshit.ai namespace')
        })
      ])
    )
    expect(result.htmlPreflight.issues).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'UNSUPPORTED_RUNTIME_API',
          line: 6
        })
      ])
    )
  })

  it('blocks direct window.batshit.ai runtime API calls during create', async () => {
    const userId = 'user_html_preflight_direct_unsupported_api'

    await expect(
      service.create(userId, {
        name: 'Unsupported Runtime API Artifact',
        content: '<script>window.batshit.ai.generateImage({ prompt: "A sunset" });</script>',
        mode: 'edit',
        metadata: {
          enforce_batshit_artifact_structure: false
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_HTML_PREFLIGHT_FAILED'
    })
  })

  it('advises when template literal interpolation is escaped inside inline scripts', async () => {
    const result = await service.validateStructure('user_html_preflight_advisory', {
      content: '<script>const value = `${prefix}/\\${slug}`;</script>',
      metadata: {
        enforce_batshit_artifact_structure: false
      },
      mode: 'edit'
    })

    expect(result.valid).toBe(true)
    expect(result.advisories).toEqual(
      expect.arrayContaining([
        expect.stringContaining('Escaped template interpolation')
      ])
    )
    expect(result.htmlPreflight.advisories).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          code: 'ESCAPED_TEMPLATE_LITERAL_INTERPOLATION',
          scriptIndex: 1
        })
      ])
    )
  })

  it('accepts catalog artifact icon refs and rejects invented icon ids', async () => {
    const userId = 'user_icon_ref_validation'

    const created = await service.create(userId, {
      name: 'Image Artifact',
      content: '<div>raw html only</div>',
      icon_ref: { kind: 'lucide', id: 'image' },
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    expect(created.icon_ref).toEqual({ kind: 'lucide', id: 'image' })

    await expect(
      service.create(userId, {
        name: 'Invented Icon Artifact',
        content: '<div>raw html only</div>',
        icon_ref: { kind: 'lucide', id: 'smile' },
        metadata: {
          enforce_batshit_artifact_structure: false
        }
      })
    ).rejects.toMatchObject({
      status: 400
    })
  })

  it('rejects unknown model preset ids when model_config is explicitly saved', async () => {
    const userId = 'user_model_preset_validation'

    await expect(
      service.create(userId, {
        name: 'Guessed Preset Artifact',
        content: '<div>raw html only</div>',
        metadata: {
          enforce_batshit_artifact_structure: false
        },
        model_config: {
          mode: 'basic',
          primary: {
            source: 'preset',
            presetId: 'guessed-preset',
            modelId: null
          }
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_MODEL_PRESET_NOT_FOUND'
    })

    const created = await service.create(userId, {
      name: 'Manual Model Artifact',
      content: '<div>raw html only</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      },
      model_config: {
        mode: 'basic',
        primary: {
          source: 'manual',
          modelId: 'gemini-current-image-model'
        }
      }
    })

    expect(created.model_config?.primary.source).toBe('manual')

    await expect(
      service.update(created.id, userId, {
        model_config: {
          mode: 'basic',
          primary: {
            source: 'preset',
            presetId: 'still-not-real',
            modelId: null
          }
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_MODEL_PRESET_NOT_FOUND'
    })
  })

  it('returns lean list records unless detail fields are explicitly requested', async () => {
    const userId = 'user_lean_artifact_list'
    const created = await service.create(userId, {
      name: 'Lean Listed Artifact',
      content: '<div>initial html</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })
    await service.update(created.id, userId, {
      content: '<div>updated html</div>'
    })

    const lean = await service.listByUser(userId)
    expect(lean).toHaveLength(1)
    expect((lean[0] as any).content).toBeUndefined()
    expect((lean[0] as any).versions).toBeUndefined()

    const withDetail = await service.listByUser(userId, {
      includeContent: true,
      includeVersions: true,
      includeVersionContents: true
    })
    expect(withDetail[0]?.content).toBe('<div>updated html</div>')
    expect(withDetail[0]?.versions?.map((version) => version.content)).toEqual([
      '<div>initial html</div>',
      '<div>updated html</div>'
    ])

    const withoutVersionBodies = await service.listByUser(userId, {
      includeContent: true,
      includeVersions: true
    })
    expect(withoutVersionBodies[0]?.content).toBe('<div>updated html</div>')
    expect((withoutVersionBodies[0]?.versions?.[0] as any)?.content).toBeUndefined()
    expect(withoutVersionBodies[0]?.versions?.[0]?.version).toBe(1)
  })

  // SA-101: both real ReJSON message formats, captured from live servers.
  //   Redis Stack 7.4.5 -> ERR Path '.widget_position' does not exist
  //   Redis 8.10.1      -> ERR Path does not exist
  // If a future ReJSON rewording breaks the classifier, this fails loudly here
  // instead of silently hiding artifacts from the user's list.
  describe('isRedisJsonMissingPathError', () => {
    it.each([
      ["ERR Path '.widget_position' does not exist", 'Redis Stack 7.4.x legacy-path form'],
      ['ERR Path \'$.nope\' does not exist', 'Redis Stack 7.4.x JSONPath form'],
      ['ERR Path "widget_position" does not exist', 'double-quoted variant'],
      ['ERR Path does not exist', 'Redis 8.x unquoted form']
    ])('classifies %s as a missing path (%s)', (message) => {
      expect(isRedisJsonMissingPathError(new Error(message))).toBe(true)
    })

    it.each([
      ['WRONGTYPE Operation against a key holding the wrong kind of value'],
      ['ERR unknown command \'JSON.GET\''],
      ['NOSCRIPT No matching script. Please use EVAL.'],
      ['LOADING Redis is loading the dataset in memory'],
      ['Connection timeout']
    ])('does not classify %s as a missing path', (message) => {
      expect(isRedisJsonMissingPathError(new Error(message))).toBe(false)
    })

    it('requires an Error instance', () => {
      expect(isRedisJsonMissingPathError('ERR Path does not exist')).toBe(false)
      expect(isRedisJsonMissingPathError(null)).toBe(false)
      expect(isRedisJsonMissingPathError(undefined)).toBe(false)
    })
  })

  it('lists artifacts when legacy projection fields are absent', async () => {
    const userId = 'user_missing_legacy_projection'
    const created = await service.create(userId, {
      name: 'Missing Legacy Projection Artifact',
      content: '<div>test</div>',
      zone: 'trigger',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    const redis = new RedisService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = await (redis as any).getClient()
    const stored = await client.json.get(`artifact:${created.id}`) as Record<string, unknown>
    delete stored.widget_position
    delete stored.zone_compatibility
    await client.json.set(`artifact:${created.id}`, '$', stored)

    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      const listed = await service.listByUser(userId)

      expect(listed).toHaveLength(1)
      expect(listed[0]?.id).toBe(created.id)
      expect(listed[0]?.zone).toBe('trigger')
      expect((listed[0] as any).content).toBeUndefined()
      expect(warnSpy).not.toHaveBeenCalled()
    } finally {
      warnSpy.mockRestore()
    }
  })

  // The list projection used to read every value through a one-element-array unwrap, so a
  // list holding exactly one entry came back as a bare value: an artifact turned on for
  // exactly one agent listed `agent_allowlist: 'agent_only'`, the Fabric registry (which
  // needs an array) built no tools for it, and both Settings panels showed that agent off.
  // A legacy multi-path JSON.GET and the whole-record fallback both return values as stored.
  it('lists one-element arrays as arrays on the projection and on the whole-record fallback', async () => {
    const userId = 'user_one_element_arrays'
    const created = await service.create(userId, {
      name: 'One Element Arrays Artifact',
      content: '<div>test</div>',
      tags: ['only_tag'],
      agent_use_enabled: true,
      agent_access_scope: 'selected',
      agent_allowlist: ['agent_only'],
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })
    expect(created.versions).toHaveLength(1)

    const redis = new RedisService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = await (redis as any).getClient()
    // The reply shape the reader relies on: legacy `.path` multi-path values arrive unwrapped.
    const raw = await client.json.get(`artifact:${created.id}`, { path: ['.id', '.agent_allowlist', '.tags'] })
    expect(raw).toEqual({ '.id': created.id, '.agent_allowlist': ['agent_only'], '.tags': ['only_tag'] })

    const expectArrays = (listed: Awaited<ReturnType<typeof service.listByUser>>) => {
      expect(listed).toHaveLength(1)
      expect(listed[0]?.agent_allowlist).toEqual(['agent_only'])
      expect(listed[0]?.tags).toEqual(['only_tag'])
      expect(listed[0]?.versions?.map((version) => version.version)).toEqual([1])
    }

    expectArrays(await service.listByUser(userId, { includeVersions: true }))

    // A missing projected path sends the list through the whole-record read instead.
    const stored = await client.json.get(`artifact:${created.id}`) as Record<string, unknown>
    delete stored.widget_position
    await client.json.set(`artifact:${created.id}`, '$', stored)
    expectArrays(await service.listByUser(userId, { includeVersions: true }))
  })

  it('ignores protected and unknown top-level fields during artifact updates', async () => {
    const userId = 'user_update_whitelist'
    const created = await service.create(userId, {
      name: 'Whitelist Artifact',
      content: '<div>safe</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    const updated = await service.update(created.id, userId, {
      name: 'Renamed Artifact',
      id: 'artifact_hijacked',
      user_id: 'other_user',
      created_at: '2000-01-01T00:00:00.000Z',
      updated_at: '2000-01-01T00:00:00.000Z',
      version: 99,
      versions: [],
      sessionId: 'sess_update_whitelist',
      versionDescription: 'metadata only',
      unexpectedTopLevel: 'junk'
    } as any)

    expect(updated.id).toBe(created.id)
    expect(updated.user_id).toBe(userId)
    expect(updated.created_at).toBe(created.created_at)
    expect(updated.version).toBe(1)
    expect((updated as any).sessionId).toBeUndefined()
    expect((updated as any).versionDescription).toBeUndefined()
    expect((updated as any).unexpectedTopLevel).toBeUndefined()

    const redis = new RedisService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = await (redis as any).getClient()
    const stored = await client.json.get(`artifact:${created.id}`)
    expect((stored as any).id).toBe(created.id)
    expect((stored as any).user_id).toBe(userId)
    expect((stored as any).unexpectedTopLevel).toBeUndefined()
  })

  it('caps stored artifact version history to the latest entries', async () => {
    const userId = 'user_version_cap'
    const created = await service.create(userId, {
      name: 'Version Capped Artifact',
      content: '<div>v1</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    let latest = created
    for (let index = 2; index <= 31; index += 1) {
      latest = await service.update(created.id, userId, {
        content: `<div>v${index}</div>`,
        versionDescription: `v${index}`
      })
    }

    expect(latest.version).toBe(31)
    expect(latest.versions).toHaveLength(25)
    expect(latest.versions[0]?.version).toBe(7)
    expect(latest.versions.at(-1)?.version).toBe(31)
    expect(latest.versions.at(-1)?.content).toBe('<div>v31</div>')
  })

  it('clears legacy widget_position when listing artifacts', async () => {
    const userId = 'user_clean'
    const created = await service.create(userId, {
      name: 'Legacy Widget Artifact',
      content: '<div>test</div>',
      zone: 'header',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    // Manually inject legacy widget_position to simulate pre-7.5 data
    const redis = new RedisService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = await (redis as any).getClient()
    await client.json.set(`artifact:${created.id}`, '$.widget_position', 'header-icon')

    const listed = await service.listByUser(userId, { includeContent: true })
    expect(listed).toHaveLength(1)
    const artifact = listed[0]

    expect(artifact.widget_position).toBeNull()
    expect(artifact.zone).toBe('header')
  })

  it('clears agent allowlist on explicit null updates', async () => {
    const userId = 'user_allowlist_clear'
    const created = await service.create(userId, {
      name: 'Allowlist Clear Artifact',
      content: '<div>test</div>',
      metadata: {
        enforce_batshit_artifact_structure: false,
        agent_allowlist: ['agent_old']
      }
    })

    expect(created.agent_allowlist).toEqual(['agent_old'])

    const updated = await service.update(created.id, userId, {
      agent_allowlist: null
    })

    expect(updated.agent_allowlist).toEqual([])
  })

  it('deletes artifact run logs when deleting an artifact', async () => {
    const userId = 'user_run_log_delete'
    const created = await service.create(userId, {
      name: 'Logged Artifact',
      content: '<div>test</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })
    const other = await service.create(userId, {
      name: 'Other Logged Artifact',
      content: '<div>test</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    await startArtifactRunLog({
      runId: 'run_deleted_1',
      userId,
      artifactId: created.id,
      artifactName: created.name,
      artifactVersion: created.version,
      sessionId: 'sess_delete_logs',
      messageId: 'msg_delete_logs_1',
      mode: 'text',
      brainType: 'built_in',
      promptChars: 12
    })
    await startArtifactRunLog({
      runId: 'run_deleted_2',
      userId,
      artifactId: created.id,
      artifactName: created.name,
      artifactVersion: created.version,
      sessionId: 'sess_delete_logs',
      messageId: 'msg_delete_logs_2',
      mode: 'text',
      brainType: 'built_in',
      promptChars: 12
    })
    await startArtifactRunLog({
      runId: 'run_kept_1',
      userId,
      artifactId: other.id,
      artifactName: other.name,
      artifactVersion: other.version,
      sessionId: 'sess_delete_logs',
      messageId: 'msg_keep_logs_1',
      mode: 'text',
      brainType: 'built_in',
      promptChars: 12
    })

    const redis = new RedisService()
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const client = await (redis as any).getClient()
    await client.json.set(`artifact_runtime_storage:${userId}:${created.id}`, '$', {
      lastResult: 'delete me'
    })

    await service.delete(created.id, userId)

    await expect(service.getOwned(created.id, userId)).rejects.toMatchObject({ status: 404 })
    expect(await listArtifactRunLogs({ userId, artifactId: created.id })).toEqual([])
    expect(await getArtifactRunLog({ userId, artifactId: created.id, runId: 'run_deleted_1' })).toBeNull()
    expect(await getArtifactRunLog({ userId, artifactId: created.id, runId: 'run_deleted_2' })).toBeNull()
    expect(await getArtifactRunLog({ userId, artifactId: other.id, runId: 'run_kept_1' })).not.toBeNull()

    const recentEntries = await client.lRange(`artifact_runs:${userId}:recent`, 0, -1)
    expect(recentEntries).toEqual([`${other.id}:run_kept_1`])
    expect(await client.exists(`artifact_runtime_storage:${userId}:${created.id}`)).toBe(0)
  })

  it('summarizes artifact run logs with chat linkage, scrubbed prompt preview, model selection, and error detail', async () => {
    const userId = 'user_run_log_summary'
    const created = await service.create(userId, {
      name: 'Summary Logged Artifact',
      content: '<div>test</div>',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })
    const prompt =
      'Generate an image. Authorization: Bearer abc.def.ghi. data:image/png;base64,' +
      'A'.repeat(320) +
      ' keep this request useful.'
    const err = new Error('Provider exploded with token=super-secret')
    err.stack = 'Error: Provider exploded\n    at run (/Users/example/batshit/private/file.ts:10:2)'

    await startArtifactRunLog({
      runId: 'run_summary_1',
      userId,
      artifactId: created.id,
      artifactName: created.name,
      artifactVersion: created.version,
      sessionId: 'sess_summary_logs',
      messageId: 'msg_summary_logs_1',
      mode: 'generate',
      brainType: 'built_in',
      requestedModel: 'gpt-image-1',
      prompt,
      promptChars: prompt.length
    })
    await markArtifactRunPrepared({
      userId,
      artifactId: created.id,
      runId: 'run_summary_1',
      role: 'visual',
      configuredSource: 'manual',
      resolvedModel: 'gpt-image-1',
      requestModel: 'gpt-image-1',
      chosenTransport: 'image'
    })
    await finishArtifactRunLog({
      userId,
      artifactId: created.id,
      runId: 'run_summary_1',
      status: 'error',
      errorMessage: err.message,
      error: err,
      source: 'stream'
    })

    const [summary] = await listArtifactRunLogs({ userId, artifactId: created.id })
    expect(summary.sessionId).toBe('sess_summary_logs')
    expect(summary.messageId).toBe('msg_summary_logs_1')
    expect(summary.requestModel).toBe('gpt-image-1')
    expect(summary.promptChars).toBe(prompt.length)
    expect(summary.promptPreview).toContain('[omitted]')
    expect(summary.promptPreview).toContain('[data-url omitted]')
    expect(summary.promptPreview).not.toContain('abc.def.ghi')
    expect(summary.promptPreview).not.toContain('AAAA')
    expect(summary.lastError).toContain('token=[omitted]')

    const fullLog = await getArtifactRunLog({ userId, artifactId: created.id, runId: 'run_summary_1' })
    expect(fullLog?.errors[0]?.stackPreview?.[1]).toContain('[local-path]')
    expect(fullLog?.errors[0]?.stackPreview?.join('\n')).not.toContain('/Users/example')
  })

  it('preserves explicit top-level allowlist during metadata-only updates', async () => {
    const userId = 'user_allowlist_preserve'
    const created = await service.create(userId, {
      name: 'Allowlist Preserve Artifact',
      content: '<div>test</div>',
      agent_allowlist: ['agent_a'],
      metadata: {
        enforce_batshit_artifact_structure: false,
        agent_allowlist: ['agent_stale']
      }
    })

    expect(created.agent_allowlist).toEqual(['agent_a'])

    const updated = await service.update(created.id, userId, {
      metadata: {
        another_flag: true
      }
    })

    expect(updated.agent_allowlist).toEqual(['agent_a'])
  })

  it('BL-829: a model update cannot change stored access or Fabric visibility', async () => {
    const { findControls, useControl } = await import('$lib/server/services/fabricRegistry')
    const userId = 'user_artifact_access_guard'
    const allowedAgentId = 'agent_allowed'
    const otherAgentId = 'agent_other'
    const created = await service.create(userId, {
      name: 'Access Guard Probe',
      content: '<div>Original</div>',
      mode: 'edit',
      zone: 'panel',
      agent_use_enabled: true,
      agent_access_scope: 'selected',
      agent_allowlist: [allowedAgentId],
      metadata: { enforce_batshit_artifact_structure: false }
    })
    const query = `artifact.${created.id}.`
    const visibleTo = async (agentId: string) => {
      const found = await findControls({
        userId,
        agentId,
        query,
        sourceType: 'artifact',
        includeDraft: true,
        limit: 200
      })
      return found.results.some((entry) => entry.controlId.startsWith(query))
    }

    expect(await visibleTo(allowedAgentId)).toBe(true)
    expect(await visibleTo(otherAgentId)).toBe(false)

    const result = await useControl({
      userId,
      agentId: allowedAgentId,
      actorType: 'in-process',
      controlId: 'sys.artifact.update',
      input: {
        artifactId: created.id,
        content: '<div>Unauthorized replacement</div>',
        agent_access_scope: 'all'
      }
    })

    expect(result.success).toBe(false)
    if (!result.success) {
      expect(result.error.details).toMatchObject({
        status: 403,
        code: 'ARTIFACT_ACCESS_USER_ONLY'
      })
    }
    const stored = await service.getOwned(created.id, userId)
    expect(stored).toMatchObject({
      agent_use_enabled: true,
      agent_access_scope: 'selected',
      agent_allowlist: [allowedAgentId],
      content: created.content,
      version: created.version
    })
    expect(await visibleTo(allowedAgentId)).toBe(true)
    expect(await visibleTo(otherAgentId)).toBe(false)
  })

  it('keeps explicit all-agents scope even when the allowlist is empty', async () => {
    const userId = 'user_access_scope_all'
    const created = await service.create(userId, {
      name: 'All Agents Artifact',
      content: '<div>test</div>',
      agent_use_enabled: true,
      agent_access_scope: 'all',
      agent_allowlist: [],
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    expect(created.agent_access_scope).toBe('all')
    expect(created.agent_allowlist).toEqual([])
  })

  it('blocks publishing agent-usable artifacts without fabric_fields or run_only', async () => {
    const userId = 'user_runtime_contract'
    const created = await service.create(userId, {
      name: 'Contract Artifact',
      content: '<div>test</div>',
      mode: 'edit',
      zone: 'panel',
      agent_use_enabled: true,
      agent_allowlist: ['agent_a'],
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    await expect(
      service.update(created.id, userId, {
        mode: 'published'
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_RUNTIME_SCHEMA_REQUIRED'
    })
  })

  it('allows publishing run-only artifacts without fabric_fields', async () => {
    const userId = 'user_runtime_contract_run_only'
    const created = await service.create(userId, {
      name: 'Run Only Artifact',
      content: '<div>test</div>',
      mode: 'edit',
      zone: 'panel',
      agent_use_enabled: true,
      agent_allowlist: ['agent_a'],
      metadata: {
        enforce_batshit_artifact_structure: false,
        run_only: true
      }
    })

    const published = await service.update(created.id, userId, {
      mode: 'published'
    })

    expect(published.mode).toBe('published')
  })

  it('keeps HuggingFace embeds user-only even when agent use is omitted', async () => {
    const userId = 'user_hf_embed_agent_use_default'

    const created = await service.create(userId, {
      name: 'HF Space Embed',
      content: '<gradio-app space="demo/space"></gradio-app>',
      mode: 'published',
      zone: 'panel',
      brain_type: 'none',
      ai_enabled: false,
      metadata: {
        source_type: 'huggingface',
        enforce_batshit_artifact_structure: false
      }
    })

    expect(created.agent_use_enabled).toBe(false)
    expect(created.agent_access_scope).toBe('selected')
    expect(created.agent_allowlist).toEqual([])
  })

  it('rejects explicit agent use on user-only Gradio embeds', async () => {
    const userId = 'user_gradio_embed_agent_use_blocked'

    await expect(
      service.create(userId, {
        name: 'Gradio Embed',
        content: '<gradio-app src="https://example.com"></gradio-app>',
        mode: 'published',
        zone: 'panel',
        brain_type: 'none',
        ai_enabled: false,
        agent_use_enabled: true,
        metadata: {
          source_type: 'gradio',
          enforce_batshit_artifact_structure: false
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_AGENT_USE_UNSUPPORTED'
    })
  })

  it('keeps ComfyUI panel artifacts user-only even when agent use is omitted', async () => {
    const userId = 'user_comfyui_panel_agent_use_default'

    const created = await service.create(userId, {
      name: 'ComfyUI Panel Artifact',
      content: COMPLIANT_ARTIFACT_CONTENT,
      mode: 'published',
      zone: 'panel',
      brain_type: 'none',
      ai_enabled: false,
      metadata: {
        source_type: 'comfyui',
        fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
      }
    })

    expect(created.agent_use_enabled).toBe(false)
    expect(created.agent_access_scope).toBe('selected')
    expect(created.agent_allowlist).toEqual([])
  })

  it('rejects explicit agent use on ComfyUI panel artifacts without a backend runtime', async () => {
    const userId = 'user_comfyui_panel_agent_use_blocked'

    await expect(
      service.create(userId, {
        name: 'ComfyUI Panel Artifact',
        content: COMPLIANT_ARTIFACT_CONTENT,
        mode: 'published',
        zone: 'panel',
        brain_type: 'none',
        ai_enabled: false,
        agent_use_enabled: true,
        metadata: {
          source_type: 'comfyui',
          fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
        }
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_AGENT_USE_UNSUPPORTED'
    })
  })

  it('revalidates published artifacts on content-only updates', async () => {
    const userId = 'user_runtime_contract_revalidate'
    const created = await service.create(userId, {
      name: 'Compliant Published Artifact',
      content: COMPLIANT_ARTIFACT_CONTENT,
      mode: 'published',
      zone: 'panel',
      agent_use_enabled: true,
      agent_allowlist: ['agent_a'],
      metadata: {
        fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
      }
    })

    await expect(
      service.update(created.id, userId, {
        content: '<div>raw html regression</div>'
      })
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_STRUCTURE_ENFORCED'
    })
  })

  it('reuses structure enforcement for addVersion writes', async () => {
    const userId = 'user_structure_add_version'
    const created = await service.create(userId, {
      name: 'Versioned Artifact',
      content: COMPLIANT_ARTIFACT_CONTENT,
      mode: 'edit',
      metadata: {
        fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }]
      }
    })

    await expect(
      service.addVersion(created.id, userId, '<div>raw html regression</div>', 'Break structure')
    ).rejects.toMatchObject({
      status: 400,
      code: 'ARTIFACT_STRUCTURE_ENFORCED'
    })
  })

  it('applies managed patch hunks to artifact content and versions through the service', async () => {
    const userId = 'user_patch_success'
    const created = await service.create(userId, {
      name: 'Patchable Artifact',
      content: '<!DOCTYPE html>\n<html>\n<body>\n  <button>Old</button>\n</body>\n</html>\n',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    const patched = await service.applyPatch(
      created.id,
      userId,
      `*** Begin Patch
*** Update File: artifact.html
@@
-  <button>Old</button>
+  <button>New</button>
*** End Patch`,
      {
        versionDescription: 'Patched button label'
      }
    )

    expect(patched.content).toContain('<button>New</button>')
    expect(patched.version).toBe(2)
    expect(patched.versions).toHaveLength(2)
    expect(patched.versions[1]?.description).toBe('Patched button label')
  })

  it('accepts copied indented source lines as apply_patch context for artifact edits', async () => {
    const userId = 'user_patch_copied_context'
    const created = await service.create(userId, {
      name: 'Copied Context Patch Artifact',
      content: [
        '<script>',
        "  const btn = document.createElement('button');",
        "  btn.className = 'generate-btn';",
        "  btn.textContent = 'Generate';",
        "  btn.id = 'gen-btn';",
        '</script>',
        ''
      ].join('\n'),
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    const patched = await service.applyPatch(
      created.id,
      userId,
      `*** Begin Patch
*** Update File: artifact.html
@@
  const btn = document.createElement('button');
  btn.className = 'generate-btn';
-  btn.textContent = 'Generate';
+  btn.textContent = 'Generate image';
  btn.id = 'gen-btn';
*** End Patch`,
      {
        versionDescription: 'Patched copied context'
      }
    )

    expect(patched.content).toContain("  btn.textContent = 'Generate image';")
    expect(patched.version).toBe(2)
  })

  it('accepts shell-wrapped apply_patch payloads for artifact content edits', async () => {
    const userId = 'user_patch_wrapped'
    const created = await service.create(userId, {
      name: 'Wrapped Patch Artifact',
      content: '<div>Hello</div>\n',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    const patched = await service.applyPatch(
      created.id,
      userId,
      `apply_patch <<'PATCH'
*** Begin Patch
*** Update File: artifact.html
@@
-<div>Hello</div>
+<div>Hi</div>
*** End Patch
PATCH`
    )

    expect(patched.content).toBe('<div>Hi</div>\n')
    expect(patched.version).toBe(2)
  })

  it('rejects artifact patches that target anything other than artifact.html', async () => {
    const userId = 'user_patch_wrong_target'
    const created = await service.create(userId, {
      name: 'Wrong Target Artifact',
      content: '<div>Hello</div>\n',
      metadata: {
        enforce_batshit_artifact_structure: false
      }
    })

    await expect(
      service.applyPatch(
        created.id,
        userId,
        `*** Begin Patch
*** Update File: index.html
@@
-<div>Hello</div>
+<div>Hi</div>
*** End Patch`
      )
    ).rejects.toMatchObject({
      status: 400,
      code: 'INVALID_ARTIFACT_PATCH'
    })
  })

  describe('writes to one artifact never drop each other (BL-546, BL-547)', () => {
    const THREE_LINE_CONTENT = '<div id="top">Top</div>\n<p>middle</p>\n<div id="bottom">Bottom</div>\n'
    const patchLine = (from: string, to: string) => `*** Begin Patch
*** Update File: artifact.html
@@
-${from}
+${to}
*** End Patch`

    async function createProbe(userId: string) {
      return await service.create(userId, {
        name: 'Parallel Writes',
        content: THREE_LINE_CONTENT,
        metadata: { enforce_batshit_artifact_structure: false }
      })
    }

    it('lands both of two apply_patch calls made at the same moment on different lines (BL-547)', async () => {
      const userId = 'user_parallel_patches'
      const created = await createProbe(userId)

      const results = await Promise.all([
        service.applyPatch(created.id, userId, patchLine('<div id="top">Top</div>', '<div id="top">Top changed</div>')),
        service.applyPatch(
          created.id,
          userId,
          patchLine('<div id="bottom">Bottom</div>', '<div id="bottom">Bottom changed</div>')
        )
      ])

      const stored = await service.getOwned(created.id, userId)
      expect(stored.content).toBe(
        '<div id="top">Top changed</div>\n<p>middle</p>\n<div id="bottom">Bottom changed</div>\n'
      )
      expect(stored.version).toBe(3)
      expect(stored.versions.map((entry) => entry.version)).toEqual([1, 2, 3])
      expect(results.map((result) => result.version).sort()).toEqual([2, 3])
    })

    it('lands both of two updates made at the same moment on different fields (BL-547)', async () => {
      const userId = 'user_parallel_updates'
      const created = await createProbe(userId)

      await Promise.all([
        service.update(created.id, userId, { name: 'Renamed at once' }),
        service.update(created.id, userId, { blueprint: 'Notes written at once' })
      ])

      const stored = await service.getOwned(created.id, userId)
      expect(stored.name).toBe('Renamed at once')
      expect(stored.blueprint).toBe('Notes written at once')
    })

    it('refuses a content write made on an older version and saves nothing (BL-546)', async () => {
      const userId = 'user_stale_content_write'
      const created = await createProbe(userId)
      // An agent patches the artifact after the Settings panel loaded version 1.
      const agentPatched = await service.applyPatch(
        created.id,
        userId,
        patchLine('<p>middle</p>', '<p>agent work</p>')
      )
      expect(agentPatched.version).toBe(2)

      const refusal = await service
        .update(created.id, userId, { content: THREE_LINE_CONTENT.replace('Top', 'User edit') }, { expectedVersion: 1 })
        .catch((error) => error)
      expect(refusal).toMatchObject({
        status: 409,
        code: 'ARTIFACT_VERSION_CONFLICT',
        details: { storedVersion: 2, baseVersion: 1 }
      })

      const stored = await service.getOwned(created.id, userId)
      expect(stored.content).toContain('<p>agent work</p>')
      expect(stored.content).not.toContain('User edit')
      expect(stored.version).toBe(2)

      // The same write made on the stored version saves as the next version.
      const saved = await service.update(
        created.id,
        userId,
        { content: stored.content.replace('Top', 'User edit') },
        { expectedVersion: 2 }
      )
      expect(saved.version).toBe(3)
      expect(saved.content).toContain('<p>agent work</p>')
      expect(saved.content).toContain('User edit')
    })

    it('refuses a write when another writer changed the artifact between its read and its write (BL-547)', async () => {
      const userId = 'user_outside_writer'
      const created = await createProbe(userId)
      const isolated = new ArtifactsService()
      const realClient = await (isolated as any).client()
      let injected = false
      // A writer outside this process (no in-process lock can see it) lands right after the
      // update's read: it changes the description and stamps its own updated_at.
      // Empty proxy targets: the real client's `json` is a read-only, non-configurable property,
      // so a proxy over the client itself may not hand back a different object for it.
      const bind = (target: any, value: unknown) => (typeof value === 'function' ? value.bind(target) : value)
      const realJson = realClient.json
      const jsonProxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'get') {
            return async (key: string, options?: unknown) => {
              const value = await realJson.get(key, options)
              if (!injected && key === `artifact:${created.id}` && options === undefined) {
                injected = true
                await realJson.set(key, '$.description', 'written by another process')
                await realJson.set(key, '$.updated_at', '2099-01-01T00:00:00.000Z')
              }
              return value
            }
          }
          return bind(realJson, Reflect.get(realJson, prop))
        }
      })
      const clientProxy = new Proxy({}, {
        get(_target, prop) {
          if (prop === 'json') return jsonProxy
          return bind(realClient, Reflect.get(realClient, prop))
        }
      })
      const spy = vi.spyOn(isolated as any, 'client').mockResolvedValue(clientProxy)

      try {
        const refusal = await isolated
          .update(created.id, userId, { name: 'Lost rename' })
          .catch((error) => error)
        expect(injected).toBe(true)
        expect(refusal).toMatchObject({ status: 409, code: 'ARTIFACT_WRITE_CONFLICT' })
      } finally {
        spy.mockRestore()
      }

      const stored = await service.getOwned(created.id, userId)
      expect(stored.description).toBe('written by another process')
      expect(stored.name).toBe('Parallel Writes')
    })
  })

  // BL-818: `sys.artifact.update` with `content` replaces the whole page, so it carries the
  // version the agent read (`expectedVersion`) and the service refuses it when a newer save
  // landed. These run the real control handler against real Redis.
  describe("an agent's whole-page write names the version it read (BL-818)", () => {
    const page = (label: string) => `<div id="page">${label}</div>\n`
    const AGENT_ID = 'agent_bl818'

    async function createProbe(userId: string) {
      return await service.create(userId, {
        name: 'Version Guard',
        content: page('original'),
        metadata: { enforce_batshit_artifact_structure: false }
      })
    }

    // The agent is told the artifact changed and how to learn the version, never the number: a
    // stored number would let it resend its old page unchanged.
    function expectStaleWordsForAgent(words: string) {
      expect(words).toContain('Not saved')
      expect(words).toContain('changed after you read it')
      expect(words).toContain('sys.artifact.get')
      expect(words).toContain('expectedVersion')
      expect(words).not.toMatch(/\d/)
    }

    async function useArtifactControl(userId: string, controlId: string, input: Record<string, unknown>) {
      const { useControl } = await import('$lib/server/services/fabricRegistry')
      return await useControl({ userId, agentId: AGENT_ID, actorType: 'in-process', controlId, input })
    }

    it('refuses the agent write that would take back a newer user save, and keeps the user save', async () => {
      const userId = 'user_bl818_story'
      const created = await createProbe(userId)

      const draft = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        content: page('agent draft'),
        expectedVersion: created.version
      })
      expect(draft.success).toBe(true)
      if (!draft.success) return
      const versionAgentHolds = (draft.result as any).artifact.version
      expect(versionAgentHolds).toBe(2)

      // The user saves in Settings, on the version they loaded.
      const userSave = await service.update(
        created.id,
        userId,
        { content: page('user edit') },
        { expectedVersion: versionAgentHolds }
      )
      expect(userSave.version).toBe(3)

      const stale = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        content: page('agent rewrite'),
        expectedVersion: versionAgentHolds
      })
      expect(stale.success).toBe(false)
      if (stale.success) return
      expect(stale.error.details).toMatchObject({ status: 409, code: 'ARTIFACT_VERSION_CONFLICT' })
      expectStaleWordsForAgent(stale.error.message)

      const kept = await service.getOwned(created.id, userId)
      expect(kept.content).toBe(page('user edit'))
      expect(kept.version).toBe(3)
      expect(kept.versions.map((entry) => entry.version)).toEqual([1, 2, 3])

      // The agent loads it again, redoes its edit on that version, and the write lands.
      const reread = await useArtifactControl(userId, 'sys.artifact.get', { artifactId: created.id })
      expect(reread.success).toBe(true)
      if (!reread.success) return
      expect((reread.result as any).artifact.version).toBe(3)
      expect((reread.result as any).artifact.content).toBe(page('user edit'))

      const redo = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        content: page('user edit, then agent'),
        expectedVersion: (reread.result as any).artifact.version
      })
      expect(redo.success).toBe(true)
      const final = await service.getOwned(created.id, userId)
      expect(final.content).toBe(page('user edit, then agent'))
      expect(final.version).toBe(4)
    })

    it('refuses a content update that names no version and saves nothing', async () => {
      const userId = 'user_bl818_required'
      const created = await createProbe(userId)

      const refused = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        content: page('agent rewrite')
      })
      expect(refused.success).toBe(false)
      if (refused.success) return
      expect(refused.error.code).toBe('CONTROL_INPUT_INVALID')
      expect(refused.error.details).toMatchObject({ status: 400, code: 'ARTIFACT_EXPECTED_VERSION_REQUIRED' })
      expect(refused.error.message).not.toMatch(/\d/)

      const stored = await service.getOwned(created.id, userId)
      expect(stored.content).toBe(page('original'))
      expect(stored.version).toBe(1)
      expect(stored.updated_at).toBe(created.updated_at)
    })

    it('add_version holds to the same rule: a version is required, a stale one is refused, and the user save stays', async () => {
      const userId = 'user_bl818_add_version'
      const created = await createProbe(userId)

      // Nothing sent for the version: refused before any read or write.
      const unversioned = await useArtifactControl(userId, 'sys.artifact.add_version', {
        artifactId: created.id,
        content: page('agent snapshot')
      })
      expect(unversioned.success).toBe(false)
      if (unversioned.success) return
      expect(unversioned.error.code).toBe('CONTROL_INPUT_INVALID')
      expect(unversioned.error.details).toMatchObject({ status: 400, code: 'ARTIFACT_EXPECTED_VERSION_REQUIRED' })
      expect(unversioned.error.message).toContain('sys.artifact.add_version')
      const untouched = await service.getOwned(created.id, userId)
      expect(untouched.content).toBe(page('original'))
      expect(untouched.version).toBe(1)
      expect(untouched.updated_at).toBe(created.updated_at)

      // The user saves on the version they loaded; the agent still holds version 1.
      await service.update(created.id, userId, { content: page('user edit') }, { expectedVersion: 1 })
      const stale = await useArtifactControl(userId, 'sys.artifact.add_version', {
        artifactId: created.id,
        content: page('agent snapshot'),
        expectedVersion: 1
      })
      expect(stale.success).toBe(false)
      if (stale.success) return
      expect(stale.error.details).toMatchObject({ status: 409, code: 'ARTIFACT_VERSION_CONFLICT' })
      expectStaleWordsForAgent(stale.error.message)
      const kept = await service.getOwned(created.id, userId)
      expect(kept.content).toBe(page('user edit'))
      expect(kept.version).toBe(2)
      expect(kept.versions.map((entry) => entry.version)).toEqual([1, 2])

      // On the version it read, the snapshot lands as the next version.
      const saved = await useArtifactControl(userId, 'sys.artifact.add_version', {
        artifactId: created.id,
        content: page('agent snapshot'),
        expectedVersion: 2
      })
      expect(saved.success).toBe(true)
      if (!saved.success) return
      expect((saved.result as any).artifact.version).toBe(3)
      expect((await service.getOwned(created.id, userId)).content).toBe(page('agent snapshot'))
    })

    it('lands exactly one of two add_version calls that name the same version', async () => {
      const userId = 'user_bl818_add_version_parallel'
      const created = await createProbe(userId)

      const results = await Promise.all([
        useArtifactControl(userId, 'sys.artifact.add_version', {
          artifactId: created.id,
          content: page('first snapshot'),
          expectedVersion: 1
        }),
        useArtifactControl(userId, 'sys.artifact.add_version', {
          artifactId: created.id,
          content: page('second snapshot'),
          expectedVersion: 1
        })
      ])

      expect(results.filter((result) => result.success)).toHaveLength(1)
      const loser = results.find((result) => !result.success)
      expect(loser).toBeTruthy()
      if (!loser || loser.success) return
      expect(loser.error.details).toMatchObject({ status: 409, code: 'ARTIFACT_VERSION_CONFLICT' })
      expectStaleWordsForAgent(loser.error.message)

      const stored = await service.getOwned(created.id, userId)
      const winnerIndex = results.findIndex((result) => result.success)
      expect(stored.content).toBe(page(winnerIndex === 0 ? 'first snapshot' : 'second snapshot'))
      expect(stored.version).toBe(2)
      expect(stored.versions.map((entry) => entry.version)).toEqual([1, 2])
    })

    it('lets an update without content go through with no version, and stores no version field', async () => {
      const userId = 'user_bl818_metadata_only'
      const created = await createProbe(userId)

      const noted = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        metadata: { note: 'agent note' }
      })
      expect(noted.success).toBe(true)

      const stored = await service.getOwned(created.id, userId)
      expect(stored.metadata).toMatchObject({ note: 'agent note' })
      expect(stored.version).toBe(1)

      // A version sent with a full update is a check, never a saved field.
      const saved = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        content: page('agent rewrite'),
        expectedVersion: 1
      })
      expect(saved.success).toBe(true)
      if (!saved.success) return
      expect((saved.result as any).artifactUpdate.updatedFields).toEqual(['content'])
      const afterSave = await service.getOwned(created.id, userId)
      expect(JSON.stringify(afterSave)).not.toContain('expectedVersion')
    })

    it('holds an update without content to a version it names too', async () => {
      const userId = 'user_bl818_metadata_stale'
      const created = await createProbe(userId)
      await service.update(created.id, userId, { content: page('user edit') }, { expectedVersion: 1 })

      const refused = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        blueprint: 'agent plan',
        expectedVersion: 1
      })
      expect(refused.success).toBe(false)
      if (refused.success) return
      expect(refused.error.details).toMatchObject({ status: 409, code: 'ARTIFACT_VERSION_CONFLICT' })
      expect((await service.getOwned(created.id, userId)).blueprint ?? null).toBeNull()
    })

    it('lands exactly one of two agent updates that name the same version', async () => {
      const userId = 'user_bl818_parallel'
      const created = await createProbe(userId)

      const results = await Promise.all([
        useArtifactControl(userId, 'sys.artifact.update', {
          artifactId: created.id,
          content: page('first agent'),
          expectedVersion: 1
        }),
        useArtifactControl(userId, 'sys.artifact.update', {
          artifactId: created.id,
          content: page('second agent'),
          expectedVersion: 1
        })
      ])

      const winners = results.filter((result) => result.success)
      const losers = results.filter((result) => !result.success)
      expect(winners).toHaveLength(1)
      expect(losers).toHaveLength(1)
      const loser = losers[0]
      if (loser.success) return
      expect(loser.error.details).toMatchObject({ status: 409, code: 'ARTIFACT_VERSION_CONFLICT' })
      expectStaleWordsForAgent(loser.error.message)

      const stored = await service.getOwned(created.id, userId)
      const winnerIndex = results.findIndex((result) => result.success)
      expect(stored.content).toBe(page(winnerIndex === 0 ? 'first agent' : 'second agent'))
      expect(stored.version).toBe(2)
      expect(stored.versions.map((entry) => entry.version)).toEqual([1, 2])
    })

    it('answers the access refusal first, even when the version is stale', async () => {
      const userId = 'user_bl818_access_first'
      const created = await createProbe(userId)
      await service.update(created.id, userId, { content: page('user edit') }, { expectedVersion: 1 })

      const refused = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId: created.id,
        content: page('agent rewrite'),
        expectedVersion: 1,
        agent_access_scope: 'all'
      })
      expect(refused.success).toBe(false)
      if (refused.success) return
      expect(refused.error.details).toMatchObject({ status: 403, code: 'ARTIFACT_ACCESS_USER_ONLY' })

      const stored = await service.getOwned(created.id, userId)
      expect(stored.content).toBe(page('user edit'))
      expect(stored.version).toBe(2)
    })

    it('keeps a newer user save when a patch made on older text still matches, and refuses one that no longer matches', async () => {
      const userId = 'user_bl818_patch_reads_stored_text'
      const created = await service.create(userId, {
        name: 'Patch Guard',
        content: '<div id="top">Top</div>\n<p>middle</p>\n<div id="bottom">Bottom</div>\n',
        metadata: { enforce_batshit_artifact_structure: false }
      })
      // The user saves after the agent read version 1.
      await service.update(
        created.id,
        userId,
        { content: '<div id="top">Top</div>\n<p>middle</p>\n<div id="bottom">User bottom</div>\n' },
        { expectedVersion: 1 }
      )
      const patch = (from: string, to: string) => `*** Begin Patch
*** Update File: artifact.html
@@
-${from}
+${to}
*** End Patch`

      // A patch on lines the user did not touch lands on the stored text, so the user save stays.
      const applied = await useArtifactControl(userId, 'sys.artifact.apply_patch', {
        artifactId: created.id,
        patch: patch('<p>middle</p>', '<p>agent middle</p>')
      })
      expect(applied.success).toBe(true)
      const merged = await service.getOwned(created.id, userId)
      expect(merged.content).toBe(
        '<div id="top">Top</div>\n<p>agent middle</p>\n<div id="bottom">User bottom</div>\n'
      )
      expect(merged.version).toBe(3)

      // A patch that names the line the user changed no longer matches: refused, nothing saved.
      const refused = await useArtifactControl(userId, 'sys.artifact.apply_patch', {
        artifactId: created.id,
        patch: patch('<div id="bottom">Bottom</div>', '<div id="bottom">Agent bottom</div>')
      })
      expect(refused.success).toBe(false)
      const kept = await service.getOwned(created.id, userId)
      expect(kept.content).toBe(merged.content)
      expect(kept.version).toBe(3)
    })

    it('shows the version in the results an agent builds its next update on', async () => {
      const userId = 'user_bl818_summaries'
      const created = await useArtifactControl(userId, 'sys.artifact.create', {
        name: 'Summary Probe',
        content: page('body'),
        metadata: { enforce_batshit_artifact_structure: false }
      })
      expect(created.success).toBe(true)
      if (!created.success) return
      const artifactId = (created.result as any).artifact.id as string
      expect((created.result as any).artifact.version).toBe(1)

      const patched = await useArtifactControl(userId, 'sys.artifact.apply_patch', {
        artifactId,
        patch: `*** Begin Patch
*** Update File: artifact.html
@@
-<div id="page">body</div>
+<div id="page">patched</div>
*** End Patch`
      })
      expect(patched.success && (patched.result as any).artifact.version).toBe(2)

      const updated = await useArtifactControl(userId, 'sys.artifact.update', {
        artifactId,
        content: page('rewritten'),
        expectedVersion: 2
      })
      expect(updated.success && (updated.result as any).artifact.version).toBe(3)

      const published = await useArtifactControl(userId, 'sys.artifact.publish', { artifactId, publish: false })
      expect(published.success && (published.result as any).artifact.version).toBe(3)

      const snapshot = await useArtifactControl(userId, 'sys.artifact.add_version', {
        artifactId,
        content: page('snapshot'),
        expectedVersion: 3
      })
      expect(snapshot.success && (snapshot.result as any).artifact.version).toBe(4)

      const read = await useArtifactControl(userId, 'sys.artifact.get', { artifactId })
      expect(read.success && (read.result as any).artifact.version).toBe(4)
    })
  })

  describe('the per-agent list survives other writers (BL-815, BL-544)', () => {
    async function createSelected(userId: string, extra: Record<string, unknown> = {}) {
      return await service.create(userId, {
        name: 'Access Probe',
        content: '<div>ssacc access probe</div>',
        agent_use_enabled: true,
        agent_access_scope: 'selected',
        agent_allowlist: ['agent_nova', 'agent_orla'],
        metadata: { enforce_batshit_artifact_structure: false },
        ...extra
      } as any)
    }

    it('turning Agent Use off keeps the list, and turning it on again brings the same agents back (BL-815)', async () => {
      const userId = 'user_ssacc_agent_use_toggle'
      const created = await createSelected(userId)

      const off = await service.update(created.id, userId, { agent_use_enabled: false })
      expect(off.agent_use_enabled).toBe(false)
      expect(off.agent_allowlist).toEqual(['agent_nova', 'agent_orla'])
      expect((await service.getOwned(created.id, userId)).agent_allowlist).toEqual(['agent_nova', 'agent_orla'])

      const on = await service.update(created.id, userId, { agent_use_enabled: true })
      expect(on.agent_use_enabled).toBe(true)
      expect(on.agent_access_scope).toBe('selected')
      expect(on.agent_allowlist).toEqual(['agent_nova', 'agent_orla'])
    })

    it('an artifact made with Agent Use off keeps the list it was given; an explicit null still clears it (BL-815)', async () => {
      const userId = 'user_ssacc_agent_use_create_off'
      const created = await createSelected(userId, { agent_use_enabled: false })
      expect(created.agent_use_enabled).toBe(false)
      expect(created.agent_allowlist).toEqual(['agent_nova', 'agent_orla'])

      const cleared = await service.update(created.id, userId, { agent_allowlist: null })
      expect(cleared.agent_allowlist).toEqual([])
    })

    it('setAgentAccess adds or removes ONE id from the list as stored now, and changes nothing else (BL-544)', async () => {
      const userId = 'user_ssacc_set_access'
      const created = await createSelected(userId, { agent_allowlist: ['agent_nova'] })
      // Another writer (the Access panel for another agent) adds Orla after this caller loaded
      // the artifact; this caller's copy still says only Nova.
      await service.setAgentAccess(created.id, userId, 'agent_orla', true)

      const added = await service.setAgentAccess(created.id, userId, 'agent_pax', true)
      expect(added.agent_allowlist).toEqual(['agent_nova', 'agent_orla', 'agent_pax'])
      const removed = await service.setAgentAccess(created.id, userId, 'agent_nova', false)
      expect(removed.agent_allowlist).toEqual(['agent_orla', 'agent_pax'])

      const stored = await service.getOwned(created.id, userId)
      expect(stored.agent_allowlist).toEqual(['agent_orla', 'agent_pax'])
      expect(stored.agent_access_scope).toBe('selected')
      expect(stored.agent_use_enabled).toBe(true)
      expect(stored.version).toBe(created.version)
      expect(stored.content).toBe(created.content)

      // Adding an agent that is already there, or removing one that is not, writes nothing.
      const again = await service.setAgentAccess(created.id, userId, 'agent_orla', true)
      const absent = await service.setAgentAccess(created.id, userId, 'agent_zed', false)
      expect(again.updated_at).toBe(stored.updated_at)
      expect(absent.updated_at).toBe(stored.updated_at)
      expect((await service.getOwned(created.id, userId)).updated_at).toBe(stored.updated_at)
    })

    it('setAgentAccess leaves Agent Use off and the all-agents scope as they are (BL-544)', async () => {
      const userId = 'user_ssacc_set_access_flags'
      const off = await createSelected(userId, { agent_use_enabled: false, agent_allowlist: [] })
      const offAdded = await service.setAgentAccess(off.id, userId, 'agent_nova', true)
      expect(offAdded.agent_use_enabled).toBe(false)
      expect(offAdded.agent_allowlist).toEqual(['agent_nova'])

      const all = await createSelected(userId, { agent_access_scope: 'all', agent_allowlist: [] })
      const allAdded = await service.setAgentAccess(all.id, userId, 'agent_nova', true)
      expect(allAdded.agent_access_scope).toBe('all')
      expect(allAdded.agent_allowlist).toEqual(['agent_nova'])
    })

    it('two setAgentAccess calls made at the same moment both land (BL-544)', async () => {
      const userId = 'user_ssacc_set_access_parallel'
      const created = await createSelected(userId, { agent_allowlist: [] })

      await Promise.all([
        service.setAgentAccess(created.id, userId, 'agent_nova', true),
        service.setAgentAccess(created.id, userId, 'agent_orla', true)
      ])

      const stored = await service.getOwned(created.id, userId)
      expect([...(stored.agent_allowlist ?? [])].sort()).toEqual(['agent_nova', 'agent_orla'])
    })

    it('removing the last agent of a record with no saved scope keeps it for selected agents, not all (BL-544)', async () => {
      const userId = 'user_ssacc_set_access_legacy'
      const created = await createSelected(userId, { agent_allowlist: ['agent_nova'] })
      const client = await (service as any).client()
      const legacy = { ...(await client.json.get(`artifact:${created.id}`)) }
      delete legacy.agent_access_scope
      await client.json.set(`artifact:${created.id}`, '$', legacy)

      const removed = await service.setAgentAccess(created.id, userId, 'agent_nova', false)
      expect(removed.agent_allowlist).toEqual([])
      expect(removed.agent_access_scope).toBe('selected')
    })

    it('setAgentAccess refuses an artifact of another user and one that does not exist', async () => {
      const created = await createSelected('user_ssacc_owner')
      await expect(service.setAgentAccess(created.id, 'user_ssacc_other', 'agent_nova', true)).rejects.toMatchObject({
        status: 403
      })
      await expect(service.setAgentAccess('artifact_ssacc_missing', 'user_ssacc_owner', 'agent_nova', true)).rejects.toMatchObject({
        status: 404
      })
    })
  })

  describe('a save that names no access scope keeps the saved scope as it is (BL-886)', () => {
    const LIST = ['agent_nova', 'agent_orla']
    const PROBE_AGENTS = ['agent_nova', 'agent_orla', 'agent_stranger']
    // legacy: no scope, no list, Agent Use never saved. legacyList: no scope, a list of two.
    type Kind = 'legacy' | 'all' | 'selected' | 'legacyList'

    async function rawClient() {
      return await (service as any).client()
    }

    async function makeRecord(userId: string, kind: Kind): Promise<string> {
      const created = await service.create(userId, {
        name: 'Scope Probe',
        content: '<div>bl886 scope probe</div>',
        mode: 'edit',
        zone: 'panel',
        agent_use_enabled: true,
        ...(kind === 'all' ? { agent_access_scope: 'all', agent_allowlist: [] } : {}),
        ...(kind === 'selected' ? { agent_access_scope: 'selected', agent_allowlist: LIST } : {}),
        ...(kind === 'legacyList' ? { agent_allowlist: LIST } : {}),
        metadata: { enforce_batshit_artifact_structure: false }
      } as any)
      if (kind === 'legacy' || kind === 'legacyList') {
        const client = await rawClient()
        const record = { ...(await client.json.get(`artifact:${created.id}`)) }
        delete record.agent_access_scope
        delete record.agent_use_enabled
        if (kind === 'legacy') delete record.agent_allowlist
        await client.json.set(`artifact:${created.id}`, '$', record)
      }
      return created.id
    }

    /**
     * The scope the Fabric registry reads from the STORED record, through its public path
     * (`findControls` for three probe agents), not a copy of its rule. A record with Agent Use off is
     * never registered for anyone, so it is read as a copy of itself with Agent Use not saved: the
     * scope rule counts only an explicit `true`, so that copy reads exactly what the record would
     * read with Agent Use on. Answers `all`, `selected:none`, or `selected:<the agents that see it>`.
     */
    async function fabricReading(userId: string, id: string): Promise<string> {
      const { findControls } = await import('$lib/server/services/fabricRegistry')
      const client = await rawClient()
      const stored = await client.json.get(`artifact:${id}`)
      const probeId = `${id}_reading`
      const probe = { ...stored, id: probeId, slug: `${stored.slug}-reading` }
      if (probe.agent_use_enabled !== true) delete probe.agent_use_enabled
      await client.json.set(`artifact:${probeId}`, '$', probe)
      await client.sAdd(`user:${userId}:artifacts`, probeId)
      try {
        const query = `artifact.${probeId}.`
        const seeing: string[] = []
        for (const agentId of PROBE_AGENTS) {
          const found = await findControls({
            userId,
            agentId,
            query,
            sourceType: 'artifact',
            includeDraft: true,
            limit: 200
          })
          if (found.results.some((entry) => entry.controlId.startsWith(query))) seeing.push(agentId)
        }
        if (seeing.includes('agent_stranger')) return 'all'
        return seeing.length === 0 ? 'selected:none' : `selected:${seeing.join(',')}`
      } finally {
        await client.sRem(`user:${userId}:artifacts`, probeId)
        await client.del(`artifact:${probeId}`)
      }
    }

    type Order = 'save first' | 'Agent Use off first'

    /**
     * The saves a record meets: an unrelated save (the name), Agent Use off, another unrelated save,
     * Agent Use on. Each order below starts with a different one, because the first save is the one
     * that meets a record that never saved a scope. The stored record after each step is judged
     * against the record as it was. Every mismatch of every step is collected and asserted at the
     * end, so one run names all of them.
     */
    async function walkTheSaves(kind: Kind, order: Order, reading: { start: string; afterOn: string }) {
      const userId = `user_bl886_walk_${kind}_${order.replace(/ /g, '_')}`
      const id = await makeRecord(userId, kind)
      const client = await rawClient()
      const before = await client.json.get(`artifact:${id}`)
      expect(await fabricReading(userId, id)).toBe(reading.start)

      type Step = [label: string, updates: Record<string, unknown>, turnsAgentUseOn: boolean]
      const save = (name: string): Step => [`a save of the name (${name})`, { name }, false]
      const off: Step = ['Agent Use off', { agent_use_enabled: false }, false]
      const on: Step = ['Agent Use on again', { agent_use_enabled: true }, true]
      const steps: Step[] =
        order === 'save first' ? [save('one'), off, save('two'), on] : [off, save('one'), on, save('two')]

      const problems: string[] = []
      let agentUseTurnedOn = false
      for (const [label, updates, turnsOn] of steps) {
        agentUseTurnedOn ||= turnsOn
        const returned = await service.update(id, userId, updates as any)
        const stored = await client.json.get(`artifact:${id}`)
        // The scope: exactly as it was. An absent scope stays absent, in the stored record and in the answer.
        const hadScope = 'agent_access_scope' in before
        if ('agent_access_scope' in stored !== hadScope) {
          problems.push(`${label}: the stored scope key is ${hadScope ? 'gone' : `now saved as ${JSON.stringify(stored.agent_access_scope)}`}`)
        } else if (stored.agent_access_scope !== before.agent_access_scope) {
          problems.push(`${label}: the stored scope moved from ${before.agent_access_scope} to ${stored.agent_access_scope}`)
        }
        if ('agent_access_scope' in returned !== hadScope) {
          problems.push(`${label}: the answered record ${hadScope ? 'lost' : 'gained'} the scope key`)
        }
        // The list: the same agents. This comparison reads an absent, `null`, and empty list alike (`?? []`),
        // so it hides that `update()` rewrites a list that was never saved to `null` (Agent Use on) or `[]`
        // (Agent Use off, BL-815): older than this fix and unchanged by it. The next test writes that shape down.
        const list = JSON.stringify(stored.agent_allowlist ?? [])
        if (list !== JSON.stringify(before.agent_allowlist ?? [])) {
          problems.push(`${label}: the stored list is now ${list}`)
        }
        const expectedReading = agentUseTurnedOn ? reading.afterOn : reading.start
        const read = await fabricReading(userId, id)
        if (read !== expectedReading) problems.push(`${label}: Fabric reads ${read}, not ${expectedReading}`)
      }
      expect(problems).toEqual([])
    }

    const ORDERS: Order[] = ['save first', 'Agent Use off first']

    // Turning Agent Use on writes an explicit `true`, and Fabric's own rule counts that as selected
    // when no scope is saved (fabric-registry.md 7.2). The scope stays unsaved: that is the rule of
    // this fix. Only what Fabric reads moves, and only from the step that turns Agent Use on.
    it.each(ORDERS)('a legacy record (no scope, no list, Agent Use never saved) keeps no scope through every save: %s', async (order) => {
      await walkTheSaves('legacy', order, { start: 'all', afterOn: 'selected:none' })
    })

    it.each(ORDERS)('a legacy record with a list and no scope keeps no scope, and its list, through every save: %s', async (order) => {
      await walkTheSaves('legacyList', order, {
        start: 'selected:agent_nova,agent_orla',
        afterOn: 'selected:agent_nova,agent_orla'
      })
    })

    it('a save of a legacy record with no list writes the list back as [] when Agent Use goes off (BL-815, not part of this fix)', async () => {
      const userId = 'user_bl886_list_shape'
      const id = await makeRecord(userId, 'legacy')
      const client = await rawClient()
      expect('agent_allowlist' in (await client.json.get(`artifact:${id}`))).toBe(false)

      await service.update(id, userId, { agent_use_enabled: false } as any)
      expect((await client.json.get(`artifact:${id}`)).agent_allowlist).toEqual([])
    })

    it.each(ORDERS)('a record saved for all agents keeps the scope all through every save: %s', async (order) => {
      await walkTheSaves('all', order, { start: 'all', afterOn: 'all' })
    })

    it.each(ORDERS)('a record saved for selected agents keeps the scope selected and its two agents through every save: %s', async (order) => {
      await walkTheSaves('selected', order, {
        start: 'selected:agent_nova,agent_orla',
        afterOn: 'selected:agent_nova,agent_orla'
      })
    })

    it('an explicit scope edit still stores the scope, with its list', async () => {
      const userId = 'user_bl886_explicit'
      const id = await makeRecord(userId, 'legacy')
      const client = await rawClient()

      const selected = await service.update(id, userId, { agent_access_scope: 'selected' } as any)
      expect(selected.agent_access_scope).toBe('selected')
      expect((await client.json.get(`artifact:${id}`)).agent_access_scope).toBe('selected')

      const all = await service.update(id, userId, { agent_access_scope: 'all' } as any)
      expect(all.agent_access_scope).toBe('all')
      expect((await client.json.get(`artifact:${id}`)).agent_access_scope).toBe('all')

      const tidy = await service.update(id, userId, { agent_access_scope: ' Selected ' } as any)
      expect(tidy.agent_access_scope).toBe('selected')

      const selectedId = await makeRecord(userId, 'selected')
      const opened = await service.update(selectedId, userId, { agent_access_scope: 'all' } as any)
      expect(opened.agent_access_scope).toBe('all')
      expect(opened.agent_allowlist).toEqual(LIST)
    })

    // `null` and any string that is not all or selected (after trim and lower-case) name no scope:
    // the save is not refused, and it is read exactly like a save that leaves the scope out.
    it('a scope value that is not all or selected names no scope: the saved scope stays exactly as it is, and a record with none stays without one', async () => {
      const userId = 'user_bl886_invalid'
      const client = await rawClient()
      const problems: string[] = []

      for (const kind of ['legacy', 'legacyList', 'all', 'selected'] as const) {
        for (const [valueLabel, value] of [['null', null], ['everyone', 'everyone'], ['blank', '   ']] as const) {
          for (const withAgentUseOff of [false, true]) {
            const label = `${kind} + ${valueLabel}${withAgentUseOff ? ' + Agent Use off' : ''}`
            const id = await makeRecord(userId, kind)
            const before = await client.json.get(`artifact:${id}`)
            const returned = await service.update(id, userId, {
              agent_access_scope: value,
              ...(withAgentUseOff ? { agent_use_enabled: false } : {})
            } as any)
            const stored = await client.json.get(`artifact:${id}`)
            const hadScope = 'agent_access_scope' in before
            if ('agent_access_scope' in stored !== hadScope) {
              problems.push(`${label}: the stored scope key is ${hadScope ? 'gone' : `now saved as ${JSON.stringify(stored.agent_access_scope)}`}`)
            } else if (stored.agent_access_scope !== before.agent_access_scope) {
              problems.push(`${label}: the stored scope moved from ${before.agent_access_scope} to ${stored.agent_access_scope}`)
            }
            if ('agent_access_scope' in returned !== hadScope) {
              problems.push(`${label}: the answered record ${hadScope ? 'lost' : 'gained'} the scope key`)
            }
            if (JSON.stringify(stored.agent_allowlist ?? []) !== JSON.stringify(before.agent_allowlist ?? [])) {
              problems.push(`${label}: the stored list is now ${JSON.stringify(stored.agent_allowlist)}`)
            }
          }
        }
      }
      expect(problems).toEqual([])
    })

    it('setAgentAccess still pins the scope a record never saved (the Fabric rule), and leaves a saved one', async () => {
      const userId = 'user_bl886_set_access'
      const client = await rawClient()

      // No scope, no list, Agent Use not saved: every agent reads it now, so the scope pinned is all.
      const legacyId = await makeRecord(userId, 'legacy')
      const legacy = await service.setAgentAccess(legacyId, userId, 'agent_nova', true)
      expect(legacy.agent_access_scope).toBe('all')
      expect(legacy.agent_allowlist).toEqual(['agent_nova'])
      expect((await client.json.get(`artifact:${legacyId}`)).agent_access_scope).toBe('all')

      // No scope, no list, Agent Use saved on: Fabric reads that as selected, so that is what is pinned.
      const onId = await makeRecord(userId, 'legacy')
      const onRecord = { ...(await client.json.get(`artifact:${onId}`)), agent_use_enabled: true }
      await client.json.set(`artifact:${onId}`, '$', onRecord)
      const on = await service.setAgentAccess(onId, userId, 'agent_nova', true)
      expect(on.agent_access_scope).toBe('selected')

      // A saved scope stays, all or selected.
      const allId = await makeRecord(userId, 'all')
      expect((await service.setAgentAccess(allId, userId, 'agent_nova', true)).agent_access_scope).toBe('all')
      const selectedId = await makeRecord(userId, 'selected')
      const removed = await service.setAgentAccess(selectedId, userId, 'agent_nova', false)
      expect(removed.agent_access_scope).toBe('selected')
      expect(removed.agent_allowlist).toEqual(['agent_orla'])
    })
  })

  describe('field names a screen reader can read (BL-89)', () => {
    const FIELDS = { fabric_fields: [{ fabricId: 'prompt', type: 'text', label: 'Prompt' }] }
    const withUnnamedBill = COMPLIANT_ARTIFACT_CONTENT.replace(
      '<div id="app"></div>',
      '<div id="app"></div>\n  <label>Bill Amount ($)</label><input type="number" id="bill-amount">'
    )
    const withNamedBill = COMPLIANT_ARTIFACT_CONTENT.replace(
      '<div id="app"></div>',
      '<div id="app"></div>\n  <label for="bill-amount">Bill Amount ($)</label><input type="number" id="bill-amount">'
    )
    const withAddedNote = withUnnamedBill.replace('</body>', '<textarea id="note"></textarea>\n</body>')

    // An artifact saved before this check existed: its stored content already holds the field.
    async function seedOlderArtifact(userId: string): Promise<string> {
      const created = await service.create(userId, {
        name: 'Older Artifact',
        content: withNamedBill,
        mode: 'edit',
        metadata: FIELDS
      })
      const client = await (new RedisService() as any).getClient()
      await client.json.set(`artifact:${created.id}`, '$.content', withUnnamedBill)
      await client.json.set(`artifact:${created.id}`, '$.versions[0].content', withUnnamedBill)
      return created.id
    }

    it('refuses a new artifact whose field has no name, and names the field', async () => {
      await expect(
        service.create('user_field_names_new', {
          name: 'Unnamed Field',
          content: withUnnamedBill,
          mode: 'edit',
          metadata: FIELDS
        })
      ).rejects.toMatchObject({
        status: 400,
        code: 'ARTIFACT_FIELD_NAME_REQUIRED',
        message: expect.stringContaining('<input type="number" id="bill-amount">')
      })
    })

    it('says only how to name the fields: no advice to switch enforcement off (BL-89 review)', async () => {
      const error = await service
        .create('user_field_names_sentence', { name: 'Unnamed Field', content: withUnnamedBill, mode: 'edit', metadata: FIELDS })
        .then(() => null, (reason) => reason)
      expect(error).toMatchObject({ status: 400, code: 'ARTIFACT_FIELD_NAME_REQUIRED' })
      expect(error.message).toContain('<input type="number" id="bill-amount">')
      expect(error.message).not.toMatch(/toggle|Enforce Batshit Artifact Structure/)
      expect(error.details.issues).toEqual([expect.objectContaining({ code: 'FIELD_NAME_REQUIRED' })])
    })

    it('keeps the structure refusal, field names listed, when the page also breaks the structure', async () => {
      const noBuilderKit = '<!doctype html><html><body><label>Bill</label><input type="number" id="bill-amount"></body></html>'
      const error = await service
        .create('user_field_names_structure', { name: 'Raw Page', content: noBuilderKit, mode: 'edit', metadata: FIELDS })
        .then(() => null, (reason) => reason)
      expect(error).toMatchObject({ status: 400, code: 'ARTIFACT_STRUCTURE_ENFORCED' })
      expect(error.details.issues.map((issue: { code: string }) => issue.code)).toEqual(
        expect.arrayContaining(['BUILDER_KIT_REQUIRED', 'FIELD_NAME_REQUIRED'])
      )
    })

    it('saves the same field when the user turned structure enforcement off', async () => {
      const created = await service.create('user_field_names_off', {
        name: 'Manual Artifact',
        content: withUnnamedBill,
        mode: 'edit',
        metadata: { ...FIELDS, enforce_batshit_artifact_structure: false }
      })
      expect(created.content).toContain('id="bill-amount"')
    })

    it('keeps saving an older artifact that already had the field: a settings save, an edit elsewhere, a restore', async () => {
      const userId = 'user_field_names_older'
      const id = await seedOlderArtifact(userId)

      await expect(service.update(id, userId, { zone: 'header' })).resolves.toMatchObject({ zone: 'header' })
      const edited = await service.update(id, userId, {
        content: withUnnamedBill.replace('</body>', '<p>Totals update as you type.</p>\n</body>')
      })
      expect(edited.version).toBe(2)
      await service.update(id, userId, { content: withNamedBill })
      await expect(service.rollbackToVersion(id, userId, 1)).resolves.toMatchObject({ content: withUnnamedBill })
    })

    it('refuses an update that adds a field with no name, and lists only the new field', async () => {
      const userId = 'user_field_names_added'
      const id = await seedOlderArtifact(userId)

      const error = await service.update(id, userId, { content: withAddedNote }).then(
        () => null,
        (reason) => reason
      )
      expect(error).toMatchObject({ status: 400, code: 'ARTIFACT_FIELD_NAME_REQUIRED' })
      expect(error.message).toContain('<textarea id="note">')
      expect(error.message).not.toContain('bill-amount')
    })

    it('saves an edit to an old unnamed field: a class change is not a new field (BL-89 review)', async () => {
      const userId = 'user_field_names_edit_old'
      const id = await seedOlderArtifact(userId)
      const restyled = withUnnamedBill.replace('<input type="number" id="bill-amount">', '<input class="wide" type="number" id="bill-amount" min="0">')

      const dryRun = await service.validateStructure(userId, { artifactId: id, content: restyled })
      expect(dryRun.canSave).toBe(true)
      expect(dryRun.issues).toEqual([])
      await expect(service.update(id, userId, { content: restyled })).resolves.toMatchObject({ version: 2 })
    })

    it('reports an added field as an issue and a kept one as an advisory in validateStructure', async () => {
      const userId = 'user_field_names_validate'
      const id = await seedOlderArtifact(userId)

      const result = await service.validateStructure(userId, { artifactId: id, content: withAddedNote })
      expect(result.valid).toBe(false)
      expect(result.issues).toEqual([
        expect.objectContaining({ code: 'FIELD_NAME_REQUIRED', message: expect.stringContaining('<textarea id="note">') })
      ])
      expect(result.issues[0].message).not.toContain('bill-amount')
      expect(result.advisories.join('\n')).toContain('<input type="number" id="bill-amount">')

      const fresh = await service.validateStructure(userId, { content: withUnnamedBill, metadata: FIELDS })
      expect(fresh.valid).toBe(false)
      expect(fresh.message).toContain('Give every field a name')
      expect(fresh.message).not.toMatch(/toggle/)
      // Review of BL-89: with no artifact to compare, the dry run says so.
      expect(fresh.advisories.join('\n')).toContain(
        'No artifactId was given, so fields a saved page already had cannot be told apart from new ones'
      )
      // With the id, it compares exactly as the save does: the kept field is only an advisory.
      expect(result.advisories.join('\n')).not.toContain('No artifactId was given')
    })
  })
})
