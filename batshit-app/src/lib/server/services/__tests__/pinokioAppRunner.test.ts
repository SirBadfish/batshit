import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import {
  PinokioAppRunError,
  collectComfyImages,
  fillComfyWorkflow,
  parseGradioEventStream,
  unwrapGradioUpdate,
  readFileArgument,
  runPinokioAppArtifact,
  type PinokioRunnerDeps,
  type PinokioRunFile
} from '../pinokioAppRunner'
import type { PinokioAppEndpoint } from '../pinokioAppEndpoint'
import { readPinokioArtifactBinding } from '$lib/artifacts/pinokioArtifact'

/**
 * SA-072 P2: the server runner behind `brain_type: "pinokio_app"`. The ComfyUI answers are the
 * real ones captured from the Pinokio-managed ComfyUI 0.37.0 (fixtures/pinokio/comfyui/*.json).
 */

const FIXTURES = path.resolve(__dirname, '../../tests/fixtures/pinokio/comfyui')
const fixture = (name: string) => JSON.parse(fs.readFileSync(path.join(FIXTURES, name), 'utf8'))
const ACCEPTED = fixture('prompt-accepted.json')
const REFUSED = fixture('prompt-validation-error.json')
const HISTORY = fixture('history-success.json')
const PROMPT_ID = ACCEPTED.prompt_id as string
const WORKFLOW = HISTORY[PROMPT_ID].prompt[2]
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3])
const BASE = 'http://127.0.0.1:8188'

const ONLINE: PinokioAppEndpoint = { ok: true, appId: 'comfy.git', title: 'Comfyui', baseUrl: BASE }

function comfyArtifact(recipeOverrides: Record<string, unknown> = {}) {
  const metadata = {
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
      randomSeed: { node: '3', input: 'seed' },
      ...recipeOverrides
    }
  }
  return { metadata, binding: readPinokioArtifactBinding({ metadata })! }
}

function json(value: unknown, status = 200) {
  return new Response(JSON.stringify(value), { status, headers: { 'content-type': 'application/json' } })
}

function makeDeps(route: (url: string, init?: RequestInit) => Response | Promise<Response>, endpoint = ONLINE) {
  const calls: Array<{ url: string; init?: RequestInit }> = []
  const deps: PinokioRunnerDeps = {
    fetch: vi.fn(async (input: any, init?: RequestInit) => {
      const url = String(input)
      calls.push({ url, init })
      return await route(url, init)
    }) as unknown as typeof fetch,
    resolveEndpoint: vi.fn(async () => endpoint),
    sleep: vi.fn(async () => {}),
    now: (() => {
      let t = 0
      return () => (t += 10)
    })(),
    randomSeed: () => 777,
    batshitUploadOrigins: () => ['http://localhost:5600'],
    readClip: vi.fn(async (userId: string, clipId: string) =>
      userId === 'josh' && clipId === 'clip_1790381736423_2c5dee0b_0'
        ? { dataUrl: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, filename: 'ocr-receipt.png' }
        : null
    )
  }
  return { deps, calls }
}

function collector() {
  const files: Array<PinokioRunFile & { index: number }> = []
  const chunks: string[] = []
  return {
    files,
    chunks,
    emit: {
      chunk: async (text: string) => {
        chunks.push(text)
      },
      file: async (file: PinokioRunFile, index: number) => {
        files.push({ ...file, index })
      }
    }
  }
}

describe('ComfyUI through Pinokio', () => {
  it('fills the workflow, submits it, waits for history, and returns the saved image', async () => {
    const { metadata, binding } = comfyArtifact()
    let historyPolls = 0
    const { deps, calls } = makeDeps((url) => {
      if (url === `${BASE}/prompt`) return json(ACCEPTED)
      if (url === `${BASE}/history/${PROMPT_ID}`) return json(++historyPolls < 3 ? {} : HISTORY)
      if (url.startsWith(`${BASE}/view?`)) return new Response(PNG, { headers: { 'content-type': 'image/png' } })
      return new Response('unexpected', { status: 500 })
    })
    const out = collector()
    const result = await runPinokioAppArtifact(
      { artifactId: 'art_1', binding, metadata, values: { prompt: 'a bat', steps: '6' } },
      out.emit,
      deps
    )

    const submitted = JSON.parse(String(calls[0].init?.body))
    expect(submitted.client_id).toBe('batshit-art_1')
    expect(submitted.prompt['6'].inputs.text).toBe('a bat')
    expect(submitted.prompt['3'].inputs.steps).toBe(6)
    expect(submitted.prompt['3'].inputs.seed).toBe(777)
    // The saved recipe is never changed by a run.
    expect((metadata.pinokio_runtime.workflow as any)['6'].inputs.text).toBe('a small purple bat reading a book, soft light')

    expect(historyPolls).toBe(3)
    expect(calls.at(-1)?.url).toBe(`${BASE}/view?filename=batshit_p2_probe_00001_.png&subfolder=&type=output`)
    expect(out.files).toHaveLength(1)
    expect(out.files[0]).toMatchObject({ mediaType: 'image/png', index: 0, metadata: { appId: 'comfy.git', kind: 'comfyui' } })
    expect(out.files[0].base64).toBe(`data:image/png;base64,${Buffer.from(PNG).toString('base64')}`)
    expect(result.text).toBe('Generated 1 image with Comfyui (ComfyUI via Pinokio).')
    expect(result.metadata).toMatchObject({ transport: 'pinokio-app', appId: 'comfy.git', kind: 'comfyui', promptId: PROMPT_ID, seed: 777 })
  })

  it('keeps a seed a field set', () => {
    const { metadata } = comfyArtifact({ inputs: { prompt: { node: '6', input: 'text' }, steps: { node: '3', input: 'seed' } } })
    const filled = fillComfyWorkflow(metadata.pinokio_runtime as any, { steps: 5 }, () => 1)
    expect(filled.workflow['3'].inputs.seed).toBe(5)
    expect(filled.seed).toBeNull()
  })

  it('refuses a non-number for a number input', () => {
    const { metadata } = comfyArtifact()
    expect(() => fillComfyWorkflow(metadata.pinokio_runtime as any, { steps: 'lots' }, () => 1)).toThrow(/must be a number/)
  })

  it('turns ComfyUI\'s validation refusal into one readable sentence', async () => {
    const { metadata, binding } = comfyArtifact()
    const { deps } = makeDeps(() => json(REFUSED, 400))
    await expect(
      runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: {} }, collector().emit, deps)
    ).rejects.toThrow(
      "Comfyui refused the workflow (400): Prompt outputs failed validation; node 4 (CheckpointLoaderSimple): ckpt_name: 'missing.safetensors' not in ['flux1-schnell-fp8.safetensors']"
    )
  })

  it('reports an execution error from history', async () => {
    const { metadata, binding } = comfyArtifact()
    const failed = {
      [PROMPT_ID]: {
        outputs: {},
        status: {
          status_str: 'error',
          completed: false,
          messages: [['execution_error', { node_id: '8', node_type: 'VAEDecode', exception_message: 'out of memory' }]]
        }
      }
    }
    const { deps } = makeDeps((url) => (url.endsWith('/prompt') ? json(ACCEPTED) : json(failed)))
    await expect(
      runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: {} }, collector().emit, deps)
    ).rejects.toThrow('Comfyui failed the workflow: VAEDecode (node 8): out of memory.')
  })

  it('fails loudly when the workflow saved no image', async () => {
    const { metadata, binding } = comfyArtifact()
    const empty = { [PROMPT_ID]: { outputs: {}, status: { status_str: 'success', completed: true } } }
    const { deps } = makeDeps((url) => (url.endsWith('/prompt') ? json(ACCEPTED) : json(empty)))
    const error = await runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: {} }, collector().emit, deps).catch(
      (err) => err
    )
    expect(error).toBeInstanceOf(PinokioAppRunError)
    expect(error.code).toBe('no_output')
  })

  it('prefers saved images and falls back to previews', () => {
    expect(
      collectComfyImages({
        '10': { images: [{ filename: 'p.png', subfolder: '', type: 'temp' }] },
        '9': { images: [{ filename: 's.png', subfolder: '', type: 'output' }] }
      }).map((image) => image.filename)
    ).toEqual(['s.png'])
    expect(collectComfyImages({ '10': { images: [{ filename: 'p.png', type: 'temp' }] } }).map((image) => image.filename)).toEqual([
      'p.png'
    ])
  })
})

describe('an app that is not running', () => {
  it('fails typed, names sys.pinokio.run for an agent, and calls nothing', async () => {
    const { metadata, binding } = comfyArtifact()
    const { deps, calls } = makeDeps(() => json({}), {
      ok: false,
      code: 'app_offline',
      status: 503,
      appId: 'comfy.git',
      title: 'Comfyui',
      state: 'offline',
      message: 'Comfyui is not running in Pinokio.'
    })
    const error = await runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: {} }, collector().emit, deps).catch(
      (err) => err
    )
    expect(error).toBeInstanceOf(PinokioAppRunError)
    expect(error.code).toBe('app_offline')
    expect(error.message).toBe(
      'Comfyui is not running in Pinokio. Start it now with fabric:sys.pinokio.run (input: { "appId": "comfy.git" }): Batshit shows the user an Approve card for the start, so do not ask in chat first. Then run this artifact again.'
    )
    expect(error.details).toMatchObject({ appId: 'comfy.git', title: 'Comfyui', state: 'offline' })
    expect(calls).toHaveLength(0)
  })

  it('refuses a recipe that cannot run before asking Pinokio anything', async () => {
    const { metadata, binding } = comfyArtifact({ workflow: { nodes: [] } })
    const { deps } = makeDeps(() => json({}))
    await expect(
      runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: {} }, collector().emit, deps)
    ).rejects.toThrow(/cannot run yet/)
    expect(deps.resolveEndpoint).not.toHaveBeenCalled()
  })
})

describe('Gradio through Pinokio', () => {
  const GBASE = 'http://127.0.0.1:7860'
  const gradioEndpoint: PinokioAppEndpoint = { ok: true, appId: 'ocr.git', title: 'LightOnOCR', baseUrl: GBASE }
  const metadata = {
    source_type: 'gradio',
    runtime_manager: 'pinokio',
    pinokio_app_id: 'ocr.git',
    fabric_fields: [
      { fabricId: 'image', type: 'text', label: 'Image URL' },
      { fabricId: 'note', type: 'text', label: 'Note' }
    ],
    pinokio_runtime: { api_name: '/predict', inputs: [{ field: 'image', file: true }, { field: 'note' }, { value: 1024 }] }
  }
  const binding = readPinokioArtifactBinding({ metadata })!

  it('uploads the file, calls the endpoint, and returns text and image outputs', async () => {
    const { deps, calls } = makeDeps((url, init) => {
      if (url === `${GBASE}/config`) return json({ version: '5.9.1', api_prefix: '/gradio_api', components: [] })
      if (url === `${GBASE}/gradio_api/upload`) return json(['/tmp/gradio/abc/input.png'])
      if (url === `${GBASE}/gradio_api/call/predict`) return json({ event_id: 'ev1' })
      if (url === `${GBASE}/gradio_api/call/predict/ev1`) {
        return new Response(
          'event: generating\ndata: null\n\nevent: complete\ndata: ["Hello OCR", {"path": "/tmp/out.png", "url": "http://127.0.0.1:7860/gradio_api/file=/tmp/out.png", "mime_type": "image/png"}]\n\n'
        )
      }
      if (url === `${GBASE}/gradio_api/file=/tmp/out.png`) return new Response(PNG, { headers: { 'content-type': 'image/png' } })
      return new Response('nope', { status: 404 })
    }, gradioEndpoint)
    const out = collector()
    const result = await runPinokioAppArtifact(
      { artifactId: 'a', binding, metadata, values: { image: `data:image/png;base64,${Buffer.from(PNG).toString('base64')}`, note: 'hi' } },
      out.emit,
      deps
    )
    const call = calls.find((entry) => entry.url.endsWith('/call/predict'))
    expect(JSON.parse(String(call?.init?.body))).toEqual({
      data: [
        { path: '/tmp/gradio/abc/input.png', orig_name: 'input.png', mime_type: 'image/png', meta: { _type: 'gradio.FileData' } },
        'hi',
        1024
      ]
    })
    expect(result.text).toBe('Hello OCR')
    expect(out.files).toHaveLength(1)
    expect(result.metadata).toMatchObject({ kind: 'gradio', apiName: '/predict', fieldsApplied: ['image', 'note'] })
  })

  // The shape LightOnOCR-2-1B's /process_input really returns (SA-072 P2 live proof, 2026-09-25):
  // Markdown, the same text raw, a status line, a preview of the input page, a slider update.
  const OCR_COMPLETE =
    'event: complete\ndata: ["# Moonlight Bakery", "# Moonlight Bakery", "Processing image", ' +
    '{"path": "/tmp/preview.webp", "url": "http://127.0.0.1:7860/gradio_api/file=/tmp/preview.webp", "mime_type": "image/webp"}, ' +
    '{"__type__": "update", "maximum": 1, "visible": false}]\n\n'

  function ocrDeps() {
    return makeDeps((url) => {
      if (url === `${GBASE}/config`) return json({ version: '6.28.0', api_prefix: '/gradio_api', components: [] })
      if (url === `${GBASE}/gradio_api/upload`) return json(['/tmp/gradio/abc/input.png'])
      if (url === `${GBASE}/gradio_api/call/predict`) return json({ event_id: 'ev1' })
      if (url === `${GBASE}/gradio_api/call/predict/ev1`) return new Response(OCR_COMPLETE)
      if (url === `${GBASE}/gradio_api/file=/tmp/preview.webp`) return new Response(PNG, { headers: { 'content-type': 'image/webp' } })
      return new Response('nope', { status: 404 })
    }, gradioEndpoint)
  }

  it('keeps only the returned values the recipe names in outputs', async () => {
    const { deps, calls } = ocrDeps()
    const out = collector()
    const withOutputs = { ...metadata, pinokio_runtime: { ...metadata.pinokio_runtime, outputs: [1] } }
    const result = await runPinokioAppArtifact(
      { artifactId: 'a', binding: readPinokioArtifactBinding({ metadata: withOutputs })!, metadata: withOutputs, values: { image: 'data:image/png;base64,AAAA' } },
      out.emit,
      deps
    )
    expect(result.text).toBe('# Moonlight Bakery')
    expect(out.files).toHaveLength(0)
    expect(calls.some((entry) => entry.url.includes('preview.webp'))).toBe(false)
  })

  it('gives an empty field the default the app declares, not null', async () => {
    const run = async (infoStatus: number) => {
      const { deps, calls } = makeDeps((url) => {
        if (url === `${GBASE}/config`) return json({ version: '6.28.0', api_prefix: '/gradio_api', components: [] })
        if (url === `${GBASE}/gradio_api/info`) {
          return infoStatus === 200
            ? json({ named_endpoints: { '/predict': { parameters: [{ parameter_has_default: false }, { parameter_has_default: true, parameter_default: 'LightOnOCR-2-1B (Best OCR)' }, {}] } } })
            : new Response('nope', { status: infoStatus })
        }
        if (url === `${GBASE}/gradio_api/upload`) return json(['/tmp/gradio/abc/input.png'])
        if (url === `${GBASE}/gradio_api/call/predict`) return json({ event_id: 'ev1' })
        if (url === `${GBASE}/gradio_api/call/predict/ev1`) return new Response(OCR_COMPLETE)
        return new Response('nope', { status: 404 })
      }, gradioEndpoint)
      await runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: { image: 'data:image/png;base64,AAAA' } }, collector().emit, deps)
      return JSON.parse(String(calls.find((entry) => entry.url.endsWith('/call/predict'))?.init?.body)).data
    }
    expect((await run(200))[1]).toBe('LightOnOCR-2-1B (Best OCR)')
    expect((await run(404))[1]).toBeNull()
  })

  it('never returns a Gradio component update as text', async () => {
    const { deps } = ocrDeps()
    const out = collector()
    const result = await runPinokioAppArtifact(
      { artifactId: 'a', binding, metadata, values: { image: 'data:image/png;base64,AAAA' } },
      out.emit,
      deps
    )
    expect(result.text).toBe('# Moonlight Bakery\n\n# Moonlight Bakery\n\nProcessing image')
    expect(result.text).not.toContain('__type__')
    expect(out.files).toHaveLength(1)
    expect(unwrapGradioUpdate({ __type__: 'update', value: 'kept' })).toBe('kept')
    expect(unwrapGradioUpdate({ __type__: 'update', visible: false })).toBeUndefined()
    expect(unwrapGradioUpdate('plain')).toBe('plain')
  })

  it('reads Gradio 4 roots when the config has no api prefix, and reports an error event', async () => {
    const { deps } = makeDeps((url) => {
      if (url === `${GBASE}/config`) return json({ version: '4.44.0', components: [] })
      if (url === `${GBASE}/upload`) return json(['/tmp/x.png'])
      if (url === `${GBASE}/call/predict`) return json({ event_id: 'e' })
      if (url === `${GBASE}/call/predict/e`) return new Response('event: error\ndata: "CUDA missing"\n\n')
      return new Response('nope', { status: 404 })
    }, gradioEndpoint)
    await expect(
      runPinokioAppArtifact(
        { artifactId: 'a', binding, metadata, values: { image: 'data:image/png;base64,AAAA' } },
        collector().emit,
        deps
      )
    ).rejects.toThrow('LightOnOCR failed /predict: CUDA missing. Its log may say why: fabric:sys.pinokio.logs.')
  })

  it('parses the event stream to its last complete event', () => {
    expect(parseGradioEventStream('event: heartbeat\ndata: null\n\nevent: complete\ndata: [1, "a"]\n')).toEqual({
      event: 'complete',
      data: [1, 'a']
    })
    expect(parseGradioEventStream('event: error\ndata: null\n')).toEqual({ event: 'error', data: null })
    expect(parseGradioEventStream('')).toEqual({ event: null, data: null })
  })
})

describe('file arguments cannot reach another local service', () => {
  const deps = makeDeps((url) => new Response(PNG, { headers: { 'content-type': 'image/png', 'x-url': url } })).deps

  it.each([
    'http://127.0.0.1:6379/',
    'http://localhost:5620/api/settings',
    'http://192.168.1.10/admin',
    'http://10.0.0.2/x',
    'http://169.254.169.254/latest/meta-data',
    'http://[::1]:8080/',
    'http://printer.local/'
  ])('refuses %s', async (url) => {
    await expect(readFileArgument(deps, url, '"image"')).rejects.toThrow(/points at this computer or the private network/)
  })

  it('reads a Batshit upload, a public URL, and a data: URL', async () => {
    await expect(readFileArgument(deps, 'http://localhost:5600/uploads/clip.png', '"image"')).resolves.toMatchObject({ mediaType: 'image/png', name: 'clip.png' })
    await expect(readFileArgument(deps, 'https://example.com/a.png', '"image"')).resolves.toMatchObject({ mediaType: 'image/png' })
    await expect(readFileArgument(deps, 'data:text/plain,hi', '"image"')).resolves.toMatchObject({ mediaType: 'text/plain' })
    await expect(readFileArgument(deps, 'http://localhost:5600/api/secret', '"image"')).rejects.toThrow(/private network/)
    await expect(readFileArgument(deps, 'ftp://example.com/a', '"image"')).rejects.toThrow(/http\(s\) or data/)
  })

  it('reads an attached picture by its Clip id, for the run\'s own user only', async () => {
    const clipId = 'clip_1790381736423_2c5dee0b_0'
    await expect(readFileArgument(deps, clipId, '"image"', 'josh')).resolves.toMatchObject({ mediaType: 'image/png', name: 'ocr-receipt.png' })
    expect(deps.readClip).toHaveBeenCalledWith('josh', clipId)
    await expect(readFileArgument(deps, clipId, '"image"', 'someone-else')).rejects.toThrow(
      `"image": Clip "${clipId}" was not found, or it has no stored file.`
    )
    await expect(readFileArgument(deps, clipId, '"image"')).rejects.toThrow('was not found')
    await expect(readFileArgument(deps, 'clip_../../etc', '"image"', 'josh')).rejects.toThrow('is not a URL')
  })

  it('says a refused download is the link, not the upload (an agent read "could not be read (400)" as "links do not work")', async () => {
    const refusing = makeDeps(() => new Response('Wikimedia Error', { status: 400 })).deps
    await expect(readFileArgument(refusing, 'https://upload.wikimedia.org/x/640px-a.jpg', '"image"')).rejects.toThrow(
      '"image": upload.wikimedia.org answered 400 when Batshit downloaded the link, so the link is wrong or that site refuses downloads. Check it, or pass a Batshit Clip URL or a data: URL.'
    )
    const failing = makeDeps(() => {
      throw new TypeError('fetch failed', { cause: new Error('unexpected redirect') })
    }).deps
    await expect(readFileArgument(failing, 'https://example.com/a.png', '"image"')).rejects.toThrow(
      '"image": Batshit could not download example.com (unexpected redirect; redirects are not followed).'
    )
  })
})

describe('a custom API app', () => {
  const metadata = {
    source_type: 'custom',
    runtime_manager: 'pinokio',
    pinokio_app_id: 'tool.git',
    pinokio_runtime: { method: 'POST', path: '/api/run' }
  }
  const binding = readPinokioArtifactBinding({ metadata })!

  it('posts the field values and reads the text answer', async () => {
    const { deps, calls } = makeDeps(() => json({ output: 'done', extra: 1 }), { ok: true, appId: 'tool.git', title: 'Tool', baseUrl: 'http://127.0.0.1:9000' })
    const result = await runPinokioAppArtifact({ artifactId: 'a', binding, metadata, values: { q: 'x' } }, collector().emit, deps)
    expect(calls[0].url).toBe('http://127.0.0.1:9000/api/run')
    expect(JSON.parse(String(calls[0].init?.body))).toEqual({ q: 'x' })
    expect(result.text).toBe('done')
  })
})
