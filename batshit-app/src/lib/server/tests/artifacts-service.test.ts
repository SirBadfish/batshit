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
})
