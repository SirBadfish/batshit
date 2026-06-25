import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import { apiError, apiFailure } from '$lib/server/services/apiResponses'

const API_ROOT = path.resolve(process.cwd(), 'src/routes/api')
const EXCLUDED_AUTH_THROW_ROUTES = new Set(['sse/+server.ts'])

function listServerRoutes(dir: string): string[] {
  const entries = fs.readdirSync(dir, { withFileTypes: true })
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name)
    if (entry.isDirectory()) return listServerRoutes(fullPath)
    return entry.name === '+server.ts' ? [fullPath] : []
  })
}

function routePath(filePath: string): string {
  return path.relative(API_ROOT, filePath).split(path.sep).join('/')
}

describe('API response envelope helpers', () => {
  it('emits the standard JSON error envelopes', async () => {
    await expect(apiError('Unauthorized', 401).json()).resolves.toEqual({
      error: 'Unauthorized'
    })
    await expect(apiFailure('Unauthorized', 401).json()).resolves.toEqual({
      success: false,
      error: 'Unauthorized'
    })
  })

  it('keeps route auth failures away from legacy envelope variants', () => {
    const offenders: string[] = []

    for (const file of listServerRoutes(API_ROOT)) {
      const relative = routePath(file)
      if (EXCLUDED_AUTH_THROW_ROUTES.has(relative)) continue

      const source = fs.readFileSync(file, 'utf8')
      const checks: Array<[RegExp, string]> = [
        [/(['"])Unauthorized\.\1/, 'dotted Unauthorized string'],
        [/(['"])Authentication required\1/, 'Authentication required auth string'],
        [/new Response\(\s*(['"])Unauthorized\1/, 'plain-text Unauthorized response'],
        [/throw\s+error\(\s*401\s*,\s*(['"])(?:Unauthorized|Authentication required)\1/, 'thrown 401 auth error'],
        [
          /return\s+json\(\s*\{\s*error:\s*(['"])Unauthorized\1,\s*success:\s*false/,
          'flipped success:false auth envelope'
        ],
        [
          /return\s+json\(\s*\{\s*success:\s*false,\s*error:\s*(['"])Unauthorized\1/,
          'inline success:false auth envelope'
        ]
      ]

      for (const [pattern, label] of checks) {
        if (pattern.test(source)) offenders.push(`${relative}: ${label}`)
      }
    }

    expect(offenders).toEqual([])
  })
})
