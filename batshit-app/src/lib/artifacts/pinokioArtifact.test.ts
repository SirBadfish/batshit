import { describe, expect, it } from 'vitest'

import {
  PINOKIO_APP_BRAIN_TYPE,
  pinokioArtifactAppIdProblem,
  pinokioArtifactProblems,
  pinokioFileFieldIds,
  readPinokioArtifactBinding
} from './pinokioArtifact'
import { pinokioAppIdProblem } from '$lib/server/services/pinokioService'
import { getArtifactSourceBadge } from './artifactSourceBadge'
import { applyArtifactPowerSourceToMetadata, resolveArtifactPowerSource } from './artifactPowerSource'
import { resolveArtifactAgentUseEligibility } from './agentUseEligibility'

const WORKFLOW = {
  '3': { class_type: 'KSampler', inputs: { seed: 42, steps: 4, model: ['4', 0] } },
  '4': { class_type: 'CheckpointLoaderSimple', inputs: { ckpt_name: 'flux1-schnell-fp8.safetensors' } },
  '6': { class_type: 'CLIPTextEncode', inputs: { text: 'a cat', clip: ['4', 1] } },
  '9': { class_type: 'SaveImage', inputs: { filename_prefix: 'x', images: ['8', 0] } }
}

function comfyMetadata(overrides: Record<string, unknown> = {}) {
  return {
    source_type: 'comfyui',
    runtime_manager: 'pinokio',
    pinokio_app_id: 'comfy.git',
    fabric_fields: [
      { fabricId: 'prompt', type: 'textarea', label: 'Prompt' },
      { fabricId: 'steps', type: 'number', label: 'Steps' }
    ],
    pinokio_runtime: {
      workflow: WORKFLOW,
      inputs: { prompt: { node: '6', input: 'text' }, steps: { node: '3', input: 'steps' } },
      randomSeed: { node: '3', input: 'seed' }
    },
    ...overrides
  }
}

const published = (metadata: Record<string, unknown>, brainType: unknown = PINOKIO_APP_BRAIN_TYPE) =>
  pinokioArtifactProblems({ brainType, metadata, mode: 'published' })

describe('Pinokio app artifact save rules (SA-072 P2, DL-09)', () => {
  it('passes every artifact that is not a Pinokio app, untouched', () => {
    expect(published({ source_type: 'comfyui' }, 'none')).toEqual([])
    expect(published({ source_type: 'built_in' }, 'built_in')).toEqual([])
    expect(published({ runtime_manager: null }, 'built_in')).toEqual([])
  })

  it('accepts a complete ComfyUI app artifact', () => {
    expect(published(comfyMetadata())).toEqual([])
  })

  it('requires the brain type and the marker together', () => {
    expect(published(comfyMetadata(), 'none')[0]).toContain('needs brain_type "pinokio_app"')
    expect(published({ source_type: 'comfyui' })[0]).toContain('needs metadata.runtime_manager "pinokio"')
    expect(published({ runtime_manager: 'docker' })[0]).toContain('must be "pinokio" or absent')
    // Another manager's marker on an artifact that is not a Pinokio app is not this rule's business.
    expect(published({ runtime_manager: 'docker' }, 'built_in')).toEqual([])
  })

  it('keeps the real kind and refuses a stored address', () => {
    expect(published(comfyMetadata({ source_type: 'pinokio' })).join(' ')).toContain('real kind')
    expect(published(comfyMetadata({ pinokio_ref: 'pinokio://192.168.1.10:42000/api/comfy.git' })).join(' ')).toContain(
      'Remove metadata.pinokio_ref'
    )
  })

  it('lets a draft leave the recipe out, but not a published artifact', () => {
    const { pinokio_runtime: _recipe, ...draft } = comfyMetadata()
    expect(pinokioArtifactProblems({ brainType: PINOKIO_APP_BRAIN_TYPE, metadata: draft, mode: 'edit' })).toEqual([])
    expect(published(draft)[0]).toContain('needs metadata.pinokio_runtime')
  })

  it('refuses a UI graph, a binding to a link, and a binding to an unknown field or input', () => {
    expect(published(comfyMetadata({ pinokio_runtime: { workflow: { nodes: [], links: [] }, inputs: {} } }))[0]).toContain(
      'UI workflow graph'
    )
    const recipe = (inputs: Record<string, unknown>) => comfyMetadata({ pinokio_runtime: { workflow: WORKFLOW, inputs } })
    expect(published(recipe({ prompt: { node: '6', input: 'clip' } }))[0]).toContain('is a link to another node')
    expect(published(recipe({ prompt: { node: '7', input: 'text' } }))[0]).toContain('not in the workflow')
    expect(published(recipe({ prompt: { node: '6', input: 'txt' } }))[0]).toContain('does not have')
    expect(published(recipe({ width: { node: '6', input: 'text' } }))[0]).toContain('not a fabricId')
  })

  it('checks Gradio and custom recipes', () => {
    const gradio = (runtime: unknown) =>
      published({
        source_type: 'gradio',
        runtime_manager: 'pinokio',
        pinokio_app_id: 'LightOnOCR-2-1B-Pinokio.git',
        fabric_fields: [{ fabricId: 'image', type: 'text', label: 'Image URL' }],
        pinokio_runtime: runtime
      })
    expect(gradio({ api_name: '/predict', inputs: [{ field: 'image', file: true }, { value: 1024 }] })).toEqual([])
    expect(gradio({ api_name: 'predict', inputs: [] })[0]).toContain('api_name')
    expect(gradio({ api_name: '/predict', inputs: [{ field: 'nope' }] })[0]).toContain('not a fabricId')
    expect(gradio({ api_name: '/predict', inputs: [{ other: 1 }] })[0]).toContain('{ "field"')
    expect(gradio({ api_name: '/predict', inputs: [], outputs: [1, 0] })).toEqual([])
    expect(
      pinokioFileFieldIds({
        brain_type: 'pinokio_app',
        metadata: {
          source_type: 'gradio',
          runtime_manager: 'pinokio',
          pinokio_app_id: 'ocr.git',
          pinokio_runtime: { api_name: '/p', inputs: [{ field: 'image', file: true }, { field: 'model' }, { value: 1 }] }
        }
      })
    ).toEqual(new Set(['image']))
    expect(pinokioFileFieldIds({ brain_type: 'built_in', metadata: {} })).toEqual(new Set())
    for (const outputs of [[], [1, 1], [-1], ['1'], 'all']) {
      expect(gradio({ api_name: '/predict', inputs: [], outputs })[0]).toContain('pinokio_runtime.outputs')
    }

    const custom = (runtime: unknown) =>
      published({ source_type: 'custom', runtime_manager: 'pinokio', pinokio_app_id: 'my-app', pinokio_runtime: runtime })
    expect(custom({ method: 'POST', path: '/api/generate' })).toEqual([])
    expect(custom({ method: 'GET', path: 'http://evil/x' })).toHaveLength(2)
    expect(custom({ method: 'POST', path: '/a/../b' })[0]).toContain('path')
  })

  it('names the app by the same folder-id rule the service applies before pterm runs', () => {
    const ids = ['comfy.git', 'LightOnOCR-2-1B-Pinokio.git', 'my app', '', ' ', 'http://x/y', 'pinokio://h/api/x', 'id@host', 'a/b', '../x', '.hidden', 'a\\b', 'x'.repeat(201), 'bad$name']
    for (const id of ids) {
      expect(pinokioArtifactAppIdProblem(id) === null, JSON.stringify(id)).toBe(pinokioAppIdProblem(id) === null)
    }
  })

  it('reads the binding only from a complete marker', () => {
    expect(readPinokioArtifactBinding({ metadata: comfyMetadata() })).toMatchObject({ appId: 'comfy.git', kind: 'comfyui' })
    expect(readPinokioArtifactBinding({ metadata: { ...comfyMetadata(), source_type: 'built_in' } })).toBeNull()
    expect(readPinokioArtifactBinding({ metadata: { source_type: 'comfyui', pinokio_app_id: 'comfy.git' } })).toBeNull()
  })
})

describe('Pinokio App power source, badge, and agent use (SA-072 P2)', () => {
  const artifact = { brain_type: PINOKIO_APP_BRAIN_TYPE, metadata: comfyMetadata() }

  it('reads as "ComfyUI via Pinokio", never a bare "Pinokio"', () => {
    expect(getArtifactSourceBadge(artifact).label).toBe('ComfyUI via Pinokio')
    expect(getArtifactSourceBadge({ ...artifact, metadata: { ...artifact.metadata, source_type: 'gradio' } }).label).toBe(
      'Gradio via Pinokio'
    )
    expect(getArtifactSourceBadge({ ...artifact, metadata: { ...artifact.metadata, source_type: 'custom' } }).label).toBe(
      'Custom API via Pinokio'
    )
    expect(getArtifactSourceBadge({ brain_type: 'none', metadata: { source_type: 'comfyui' } }).label).toBe('ComfyUI')
  })

  it('maps to the Pinokio App power source and back without losing the kind', () => {
    expect(resolveArtifactPowerSource(artifact)).toBe('pinokio_app')
    expect(resolveArtifactPowerSource({ brain_type: 'none', metadata: { source_type: 'comfyui' } })).toBe('comfyui')

    const toPinokio = applyArtifactPowerSourceToMetadata({ source_type: 'gradio', fabric_fields: [] }, 'pinokio_app')
    expect(toPinokio).toMatchObject({ source_type: 'gradio', runtime_manager: 'pinokio' })
    expect(applyArtifactPowerSourceToMetadata({ source_type: 'built_in' }, 'pinokio_app').source_type).toBe('comfyui')

    // Leaving Pinokio clears the marker explicitly, because a save merges over the stored metadata.
    expect(applyArtifactPowerSourceToMetadata(comfyMetadata(), 'built_in')).toMatchObject({
      source_type: 'built_in',
      runtime_manager: null
    })
    expect(applyArtifactPowerSourceToMetadata({ source_type: 'comfyui' }, 'built_in')).not.toHaveProperty('runtime_manager')
  })

  it('is agent-runnable, unlike a plain ComfyUI or Gradio panel', () => {
    expect(resolveArtifactAgentUseEligibility(artifact).eligible).toBe(true)
    expect(resolveArtifactAgentUseEligibility({ brain_type: 'none', metadata: { source_type: 'comfyui' } }).eligible).toBe(false)
  })
})
