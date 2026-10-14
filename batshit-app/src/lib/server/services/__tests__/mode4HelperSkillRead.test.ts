import { spawn } from 'node:child_process'
import http from 'node:http'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

/**
 * Find 1 (bug batch 2026-09-22): the managed CLI helper's `native_skill` reads a skill file
 * through `/api/skills/runtime`. A long file comes back cut, so the helper must offer the
 * `offset` input and forward it, and a cut read must reach the Codex or Claude agent with its
 * sizes and next call intact.
 *
 * Black-box, like `mode4HelperMessageId.test.ts`: the helper runs as its own process against a
 * throwaway HTTP server standing in for Batshit, so what is checked is the real wire.
 */

const HELPER = path.join(process.cwd(), 'scripts', 'mode4-controls-mcp.cjs')

let server: http.Server
let baseUrl: string
const received: Array<{ url: string; body: any }> = []
const responseBodies = new Map<string, unknown>()

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let raw = ''
    req.on('data', (chunk) => {
      raw += chunk
    })
    req.on('end', () => {
      let body: any = null
      try {
        body = raw ? JSON.parse(raw) : null
      } catch {
        body = { raw }
      }
      received.push({ url: req.url ?? '', body })
      if (req.url === '/api/native-tools/guard-result') {
        // Codex makes a final guard call after helper formatting, even for short text.
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ success: true, text: body.text }))
        return
      }
      res.writeHead(200, { 'Content-Type': 'application/json',
        ...(req.url === '/api/skills/runtime' ? {
          'x-batshit-tool-text-max-bytes': '8000',
          'x-batshit-tool-text-budget-source': 'codex-fallback',
          'x-batshit-tool-page-kind': 'skill-read'
        } : {}) })
      res.end(JSON.stringify(responseBodies.get(req.url ?? '') ?? { success: true }))
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  baseUrl = `http://127.0.0.1:${port}`
})

afterAll(async () => {
  await new Promise<void>((resolve) => server.close(() => resolve()))
})

/** Sends one JSON-RPC request (after `initialize`) and resolves with its response. */
async function askHelper(method: string, params: Record<string, unknown>): Promise<any> {
  received.length = 0
  const child = spawn(
    process.execPath,
    [HELPER, '--agent=agent-1', '--user=user-1', `--url=${baseUrl}`, '--runtime=codex'],
    {
      env: { ...process.env, BATSHIT_AGENT_TOKEN: 'arc_testcredential.bsac_testsecret' },
      stdio: ['pipe', 'pipe', 'pipe']
    }
  )

  const done = new Promise<any>((resolve, reject) => {
    let buffer = ''
    const timer = setTimeout(() => {
      child.kill()
      reject(new Error('mode4 helper did not answer in time'))
    }, 15000)
    child.stdout.on('data', (chunk) => {
      buffer += chunk.toString()
      for (const line of buffer.split('\n')) {
        if (!line.trim()) continue
        let message: any = null
        try {
          message = JSON.parse(line)
        } catch {
          continue
        }
        if (message?.id === 2) {
          clearTimeout(timer)
          child.kill()
          resolve(message)
          return
        }
      }
    })
    child.on('error', reject)
  })

  child.stdin.write(
    JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: { protocolVersion: '2024-11-05', capabilities: {}, clientInfo: { name: 't', version: '1' } }
    }) + '\n'
  )
  child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: 2, method, params }) + '\n')
  return await done
}

describe('the CLI helper reads a long skill file in parts (find 1)', () => {
  it('offers offset on native_skill', async () => {
    const response = await askHelper('tools/list', {})
    const tool = (response?.result?.tools ?? []).find((entry: any) => entry.name === 'native_skill')
    expect(tool).toBeTruthy()
    expect(tool.inputSchema.properties.offset?.type).toBe('number')
  }, 30000)

  it('forwards offset, and hands the agent the sizes and the next call', async () => {
    const readMore =
      'Showing characters 12,001 to 24,000 of 38,635. To read on, call native_skill again with skillId "artifact_creator", action "read", path "references/big.md", and offset 24000.'
    responseBodies.set('/api/skills/runtime', {
      success: true,
      action: 'read',
      skillId: 'artifact_creator',
      path: 'references/big.md',
      content: 'part two',
      contentTruncated: true,
      originalChars: 38635,
      returnedChars: 12000,
      offset: 12000,
      nextOffset: 24000,
      readMore
    })

    const response = await askHelper('tools/call', {
      name: 'native_skill',
      arguments: { skillId: 'artifact_creator', action: 'read', path: 'references/big.md', offset: 12000 }
    })

    const call = received.find((entry) => entry.url === '/api/skills/runtime')
    expect(call?.body).toEqual({
      skillId: 'artifact_creator',
      action: 'read',
      path: 'references/big.md',
      offset: 12000
    })
    const text = (response?.result?.content ?? []).map((part: any) => part.text ?? '').join('\n')
    expect(text).toContain(JSON.stringify(readMore).slice(1, -1))
  }, 30000)
})
