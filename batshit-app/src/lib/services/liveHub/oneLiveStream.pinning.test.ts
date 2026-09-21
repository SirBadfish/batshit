import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * ONE live stream per browser (2026-09-18). A browser shares six HTTP/1.1 connections per server
 * across all its tabs, and every `EventSource` a page opens holds one of them for as long as the
 * page lives: two per chat tab froze a browser at three tabs. So the only `EventSource` in the
 * browser code is the live hub's (`browserHub.ts`, run by the SharedWorker), and everything that
 * wants live updates subscribes through `subscribeLive`. A new stream anywhere else fails here.
 */

const ROOT = 'src'

/** Source with its comments stripped: the claim is about what the code DOES. */
const codeOnly = (source: string) =>
  source
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')

const SERVER_ONLY = [path.join('src', 'lib', 'server'), path.join('src', 'routes', 'api')]

function browserSources(dir: string, found: string[] = []) {
  for (const name of readdirSync(dir)) {
    const full = path.join(dir, name)
    if (SERVER_ONLY.some((prefix) => full.startsWith(prefix))) continue
    if (statSync(full).isDirectory()) {
      browserSources(full, found)
      continue
    }
    if (!/\.(ts|js|svelte)$/.test(name) || /\.test\.ts$/.test(name) || /\.server\.ts$/.test(name)) continue
    found.push(full)
  }
  return found
}

describe('the browser holds one live stream', () => {
  it('opens an EventSource in exactly one place: the live hub', () => {
    const openers = browserSources(ROOT).filter((file) =>
      /new\s+EventSource\s*\(/.test(codeOnly(readFileSync(file, 'utf8')))
    )
    expect(openers).toEqual([path.join('src', 'lib', 'services', 'liveHub', 'browserHub.ts')])
  })

  it('replaces a chat stream that is not connected instead of leaving it subscribed', () => {
    const page = readFileSync(path.join('src', 'routes', '+page.svelte'), 'utf8')
    expect(page).toContain(
      '\n\t    existingService?.disconnect()\n\t    const service = new SSEService(sessionId)\n\t    sseServices.set(sessionId, service)'
    )
  })
})
