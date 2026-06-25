import { error, type RequestHandler } from '@sveltejs/kit'
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const FONT_FILES = new Set(['Geist-Variable.woff2', 'GeistMono-Variable.woff2'])

function fontCandidates(file: string) {
  return [
    resolve(process.cwd(), 'build/client/fonts/geist', file),
    resolve(process.cwd(), '.svelte-kit/output/client/fonts/geist', file),
    resolve(process.cwd(), 'static/fonts/geist', file)
  ]
}

async function readFont(file: string) {
  for (const candidate of fontCandidates(file)) {
    try {
      return await readFile(candidate)
    } catch {
      // Try the next known runtime layout.
    }
  }
  return null
}

export const GET: RequestHandler = async ({ params }) => {
  const file = params.file
  if (!file || !FONT_FILES.has(file)) {
    throw error(404, 'Artifact font asset not found')
  }

  const data = await readFont(file)
  if (!data) {
    throw error(404, 'Artifact font asset not found')
  }

  return new Response(new Uint8Array(data), {
    headers: {
      'Access-Control-Allow-Origin': '*',
      'Cache-Control': 'public, max-age=31536000, immutable',
      'Content-Length': String(data.byteLength),
      'Content-Type': 'font/woff2'
    }
  })
}
