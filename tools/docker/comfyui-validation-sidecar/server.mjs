import { createServer } from 'node:http'
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'

const host = process.env.BATSHIT_COMFYUI_VALIDATION_HOST || '0.0.0.0'
const port = Number(process.env.BATSHIT_COMFYUI_VALIDATION_PORT || 8188)
const dataDir = process.env.BATSHIT_COMFYUI_VALIDATION_DATA_DIR || '/data'
const uploadsDir = path.join(dataDir, 'uploads')
const outputsDir = path.join(dataDir, 'outputs')
const historyFile = path.join(dataDir, 'history.json')

async function ensureDirs() {
  await mkdir(uploadsDir, { recursive: true })
  await mkdir(outputsDir, { recursive: true })
}

async function readHistory() {
  try {
    return JSON.parse(await readFile(historyFile, 'utf8'))
  } catch {
    return {}
  }
}

async function writeHistory(history) {
  await writeFile(historyFile, JSON.stringify(history, null, 2))
}

function sendJson(response, status, payload) {
  const body = Buffer.from(JSON.stringify(payload))
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': String(body.length)
  })
  response.end(body)
}

function sendText(response, status, body, headers = {}) {
  const payload = Buffer.from(body)
  response.writeHead(status, {
    'content-type': 'text/plain; charset=utf-8',
    'content-length': String(payload.length),
    ...headers
  })
  response.end(payload)
}

function readRequestBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = []
    request.on('data', (chunk) => chunks.push(chunk))
    request.on('end', () => resolve(Buffer.concat(chunks)))
    request.on('error', reject)
  })
}

function safeName(value, fallback) {
  const cleaned = String(value || '')
    .replace(/[/\\]/g, '-')
    .replace(/[^a-zA-Z0-9._-]/g, '_')
    .slice(0, 140)
  return cleaned || fallback
}

function extractMultipartFilename(contentType, body) {
  if (!contentType.toLowerCase().startsWith('multipart/form-data')) return null
  const preview = body.toString('latin1', 0, Math.min(body.length, 4096))
  const match = preview.match(/filename="([^"]+)"/i)
  return match ? safeName(match[1], null) : null
}

async function listFiles(dir) {
  try {
    return await readdir(dir)
  } catch {
    return []
  }
}

async function handleUpload(request, response, url) {
  const body = await readRequestBody(request)
  const contentType = request.headers['content-type'] || 'application/octet-stream'
  const requestedName = url.searchParams.get('filename') || url.searchParams.get('name')
  const multipartName = extractMultipartFilename(contentType, body)
  const filename = safeName(requestedName || multipartName || `upload-${Date.now()}.bin`, `upload-${Date.now()}.bin`)
  await writeFile(path.join(uploadsDir, filename), body)
  sendJson(response, 200, {
    name: filename,
    subfolder: '',
    type: 'input',
    persisted: true,
    bytes: body.length
  })
}

async function handlePrompt(request, response) {
  let payload
  try {
    payload = JSON.parse((await readRequestBody(request)).toString('utf8'))
  } catch {
    sendJson(response, 400, { error: 'invalid_json' })
    return
  }

  const promptId = randomUUID()
  const outputName = `${promptId}.txt`
  const outputText = [
    'Batshit ComfyUI validation output',
    `prompt_id=${promptId}`,
    JSON.stringify(payload.prompt ?? {}, null, 2)
  ].join('\n')
  await writeFile(path.join(outputsDir, outputName), outputText)

  const history = await readHistory()
  history[promptId] = {
    prompt: payload.prompt ?? {},
    status: {
      status_str: 'success',
      completed: true
    },
    outputs: {
      'batshit-smoke-output': {
        images: [
          {
            filename: outputName,
            subfolder: '',
            type: 'output'
          }
        ]
      }
    },
    meta: {
      created_at: new Date().toISOString(),
      client_id: payload.client_id ?? null
    }
  }
  await writeHistory(history)

  sendJson(response, 200, {
    prompt_id: promptId,
    number: Object.keys(history).length,
    node_errors: {}
  })
}

async function handleHistory(response, promptId) {
  const history = await readHistory()
  if (!promptId) {
    sendJson(response, 200, history)
    return
  }
  sendJson(response, 200, history[promptId] ? { [promptId]: history[promptId] } : {})
}

async function handleView(response, url) {
  const filename = safeName(url.searchParams.get('filename'), '')
  const type = url.searchParams.get('type') === 'input' ? 'input' : 'output'
  if (!filename) {
    sendJson(response, 400, { error: 'filename_required' })
    return
  }

  const dir = type === 'input' ? uploadsDir : outputsDir
  try {
    const body = await readFile(path.join(dir, filename))
    response.writeHead(200, {
      'content-type': filename.endsWith('.txt') ? 'text/plain; charset=utf-8' : 'application/octet-stream',
      'content-length': String(body.length)
    })
    response.end(body)
  } catch {
    sendJson(response, 404, { error: 'not_found' })
  }
}

async function handleRequest(request, response) {
  await ensureDirs()
  const url = new URL(request.url || '/', `http://${request.headers.host || 'localhost'}`)
  const pathname = url.pathname.replace(/\/+$/, '') || '/'

  if (request.method === 'GET' && (pathname === '/' || pathname === '/health')) {
    sendJson(response, 200, { ok: true, service: 'batshit-comfyui-validation' })
    return
  }

  if (request.method === 'GET' && pathname === '/system_stats') {
    sendJson(response, 200, {
      system: {
        os: 'linux',
        python_version: 'smoke',
        embedded_python: false
      },
      devices: [],
      uploads: await listFiles(uploadsDir),
      outputs: await listFiles(outputsDir)
    })
    return
  }

  if (request.method === 'GET' && pathname === '/object_info') {
    sendJson(response, 200, {
      CheckpointLoaderSimple: {
        input: { required: { ckpt_name: [['batshit-smoke.ckpt'], {}] } },
        output: ['MODEL', 'CLIP', 'VAE'],
        output_name: ['MODEL', 'CLIP', 'VAE'],
        name: 'CheckpointLoaderSimple',
        display_name: 'Load Checkpoint'
      },
      EmptyLatentImage: {
        input: { required: { width: ['INT', { default: 512 }], height: ['INT', { default: 512 }] } },
        output: ['LATENT'],
        name: 'EmptyLatentImage'
      },
      SaveImage: {
        input: { required: { images: ['IMAGE', {}], filename_prefix: ['STRING', { default: 'Batshit' }] } },
        output: [],
        name: 'SaveImage'
      }
    })
    return
  }

  if (request.method === 'POST' && pathname === '/upload/image') {
    await handleUpload(request, response, url)
    return
  }

  if (request.method === 'POST' && pathname === '/prompt') {
    await handlePrompt(request, response)
    return
  }

  if (request.method === 'GET' && (pathname === '/history' || pathname.startsWith('/history/'))) {
    const promptId = pathname === '/history' ? '' : pathname.replace(/^\/history\//, '')
    await handleHistory(response, promptId)
    return
  }

  if (request.method === 'GET' && pathname === '/view') {
    await handleView(response, url)
    return
  }

  if (request.method === 'GET' && (pathname === '/queue' || pathname === '/userdata' || pathname === '/api/userdata')) {
    sendJson(response, 200, pathname === '/queue' ? { queue_running: [], queue_pending: [] } : [])
    return
  }

  if (request.method === 'POST' && pathname === '/interrupt') {
    sendJson(response, 200, { ok: true })
    return
  }

  sendText(response, 404, 'Not found')
}

await ensureDirs()
createServer((request, response) => {
  handleRequest(request, response).catch((error) => {
    console.error('[comfyui-validation] request failed', error)
    sendJson(response, 500, { error: 'internal_error', message: error instanceof Error ? error.message : String(error) })
  })
}).listen(port, host, () => {
  console.log(`[comfyui-validation] listening on ${host}:${port}`)
})
