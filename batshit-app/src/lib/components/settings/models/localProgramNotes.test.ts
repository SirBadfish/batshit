import { describe, expect, it } from 'vitest'
import type { CatalogModel } from '$lib/types/modelCatalog'
import {
  describeLocalContextNote,
  describeServedModelNote,
  findServingModel,
  localModelName
} from './localProgramNotes'

const LLAMA = 'koboldcpp/Llama-3.2-3B-Instruct-Q4_K_M'
/** The notes group digits the way the page's locale does, as SA-102 P4's note always has. */
const n = (value: number) => value.toLocaleString()

function row(overrides: Partial<CatalogModel> = {}): CatalogModel {
  return {
    id: `koboldcpp/${LLAMA}`,
    canonicalId: `koboldcpp/${LLAMA}`,
    provider: 'koboldcpp',
    name: LLAMA,
    displayName: LLAMA,
    source: 'local',
    transport: 'local',
    connectionId: 'direct:koboldcpp',
    availableConnections: ['direct:koboldcpp'],
    servesEveryRequest: true,
    localContext: {
      source: 'loaded',
      loadedContextWindow: 32768,
      maxContextWindow: null,
      remainingTtlSeconds: null
    },
    ...overrides
  }
}

describe('BL-104 findServingModel', () => {
  it('finds the row a program answers every request with', () => {
    const served = row()
    const catalog = [row({ id: 'anthropic/claude', servesEveryRequest: undefined, connectionId: 'vercel-gateway' }), served]
    expect(findServingModel(catalog, 'koboldcpp')).toBe(served)
  })

  it('ignores a marked row of another program', () => {
    expect(findServingModel([row()], 'lmstudio')).toBeNull()
  })

  it('finds nothing when the program serves no single model', () => {
    expect(findServingModel([row({ servesEveryRequest: undefined })], 'koboldcpp')).toBeNull()
    expect(findServingModel([row()], null)).toBeNull()
  })
})

describe('BL-104 localModelName', () => {
  it('drops the program\'s own namespace, the way its card names the model', () => {
    expect(localModelName('koboldcpp', LLAMA)).toBe('Llama-3.2-3B-Instruct-Q4_K_M')
    expect(localModelName('koboldcpp', 'Llama-3.2-3B-Instruct-Q4_K_M')).toBe('Llama-3.2-3B-Instruct-Q4_K_M')
    // Only the program's own prefix; another owner stays part of the name.
    expect(localModelName('koboldcpp', 'meta/Llama-3.2')).toBe('meta/Llama-3.2')
  })
})

describe('BL-104 describeServedModelNote', () => {
  const base = { programId: 'koboldcpp', programLabel: 'KoboldCpp', serving: row() }

  it('names the model that really answers a preset saved for another one', () => {
    const note = describeServedModelNote({ ...base, presetModelId: 'koboldcpp/Qwen3.5-9B-Q4_K_M' })
    expect(note).toEqual({
      tone: 'is-warning',
      text:
        'KoboldCpp is serving Llama-3.2-3B-Instruct-Q4_K_M, not the model above. ' +
        'Replies from this preset come from Llama-3.2-3B-Instruct-Q4_K_M.'
    })
  })

  it('says nothing when the preset names the served model, with or without the prefix', () => {
    expect(describeServedModelNote({ ...base, presetModelId: LLAMA })).toBeNull()
    expect(describeServedModelNote({ ...base, presetModelId: ' Llama-3.2-3B-Instruct-Q4_K_M ' })).toBeNull()
  })

  it('compares names exactly, as KoboldCpp spells them', () => {
    expect(describeServedModelNote({ ...base, presetModelId: 'koboldcpp/llama-3.2-3b-instruct-q4_k_m' })).not.toBeNull()
  })

  it('says nothing without a model, a program, or a served model', () => {
    expect(describeServedModelNote({ ...base, presetModelId: '' })).toBeNull()
    expect(describeServedModelNote({ ...base, presetModelId: 'x', programLabel: null })).toBeNull()
    expect(describeServedModelNote({ ...base, presetModelId: 'x', programId: null })).toBeNull()
    expect(describeServedModelNote({ ...base, presetModelId: 'x', serving: null })).toBeNull()
  })
})

describe('SA-102 P4 / BL-104 describeLocalContextNote', () => {
  const loaded = row().localContext ?? null

  it('keeps the loaded size note for a preset that names the running model', () => {
    expect(
      describeLocalContextNote({ programLabel: 'KoboldCpp', reading: loaded, presetContextWindow: 32768, runningModelName: null })
    ).toEqual({ tone: '', text: `KoboldCpp is running this model at ${n(32768)} tokens.`, ttl: null })
  })

  it('warns when the preset plans against another size', () => {
    expect(
      describeLocalContextNote({ programLabel: 'KoboldCpp', reading: loaded, presetContextWindow: 262144, runningModelName: null })?.text
    ).toBe(`KoboldCpp is running this model at ${n(32768)} tokens, not the ${n(262144)} above. Batshit plans against ${n(32768)}.`)
  })

  it('keeps a smaller positive preset as the planning cap while naming the actual allocation', () => {
    expect(describeLocalContextNote({ programId: 'koboldcpp', programLabel: 'KoboldCpp', reading: loaded,
      presetContextWindow: 8192, runningModelName: 'Llama-3.2-3B-Instruct-Q4_K_M' })).toEqual({
      tone: 'is-warning',
      text: `KoboldCpp is running Llama-3.2-3B-Instruct-Q4_K_M at ${n(32768)} tokens, not the ${n(8192)} above. ` +
        `Batshit plans against ${n(8192)}. To increase this loaded ceiling, restart KoboldCpp with a larger Context Size (--contextsize). Changing this preset does not enlarge it.`,
      ttl: null
    })
  })

  it('always gives Kobold loaded-ceiling restart guidance and ignores invalid preset caps', () => {
    for (const presetContextWindow of [32768, null, 0, -1, Number.NaN, Number.POSITIVE_INFINITY]) {
      const note = describeLocalContextNote({ programId: 'koboldcpp', programLabel: 'KoboldCpp', reading: loaded,
        presetContextWindow, runningModelName: null })
      expect(note?.tone).toBe('')
      expect(note?.text).toContain(`KoboldCpp is running this model at ${n(32768)} tokens.`)
      expect(note?.text).toContain('restart KoboldCpp with a larger Context Size (--contextsize)')
      expect(note?.text).toContain('Changing this preset does not enlarge it.')
    }
  })

  it('shows Ollama requested allocation instead of stale residency, with a separate smaller planning cap', () => {
    for (const reading of [loaded, null]) {
      expect(describeLocalContextNote({ programId: 'ollama', programLabel: 'Ollama', reading,
        requestedContextWindow: 8192, presetContextWindow: 4096, runningModelName: null })).toEqual({
        tone: '', ttl: null,
        text: `Ollama will be asked to use ${n(8192)} tokens for this request. Batshit plans against the smaller preset limit of ${n(4096)} tokens.`
      })
    }
    expect(describeLocalContextNote({ programId: 'ollama', programLabel: 'Ollama', reading: loaded,
      requestedContextWindow: 8192, presetContextWindow: 64000, runningModelName: null })?.text)
      .toBe(`Ollama will be asked to use ${n(8192)} tokens for this request.`)
  })

  it('names the served model when the preset was saved for another one', () => {
    expect(
      describeLocalContextNote({
        programLabel: 'KoboldCpp',
        reading: loaded,
        presetContextWindow: 262144,
        runningModelName: 'Llama-3.2-3B-Instruct-Q4_K_M'
      })
    ).toEqual({
      tone: 'is-warning',
      text:
        `KoboldCpp is running Llama-3.2-3B-Instruct-Q4_K_M at ${n(32768)} tokens, not the ${n(262144)} above. ` +
        `Batshit plans against ${n(32768)}.`,
      ttl: null
    })
  })

  it('keeps LM Studio\'s unload countdown and its not-loaded state', () => {
    expect(
      describeLocalContextNote({
        programLabel: 'LM Studio',
        reading: { source: 'loaded', loadedContextWindow: 208384, maxContextWindow: 262144, remainingTtlSeconds: 1800 },
        presetContextWindow: 262144,
        runningModelName: null
      })
    ).toEqual({
      tone: 'is-warning',
      text: `LM Studio is running this model at ${n(208384)} tokens, not the ${n(262144)} above. Batshit plans against ${n(208384)}.`,
      ttl: 'LM Studio unloads it in about 30 minutes, after which this becomes unknown again.'
    })
    expect(
      describeLocalContextNote({
        programLabel: 'LM Studio',
        reading: { source: 'unknown-until-loaded', loadedContextWindow: null, maxContextWindow: 262144, remainingTtlSeconds: null },
        presetContextWindow: 262144,
        runningModelName: null
      })?.text
    ).toBe('LM Studio can tell Batshit the real size, but only while the model is loaded. Load it and refresh the model catalog to see the number.')
  })

  it('says nothing without a program or a reading', () => {
    expect(describeLocalContextNote({ programLabel: null, reading: loaded, presetContextWindow: 1, runningModelName: null })).toBeNull()
    expect(describeLocalContextNote({ programLabel: 'KoboldCpp', reading: null, presetContextWindow: 1, runningModelName: null })).toBeNull()
  })
})
