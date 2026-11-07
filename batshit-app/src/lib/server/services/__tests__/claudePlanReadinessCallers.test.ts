// @vitest-environment node
/**
 * SA-139 P4 (P1 readiness review, reviewer A N8): every production caller of the one admission owner
 * passes the fresh readiness reader, and the shared 30-second display read stays in the three display
 * routes. Admission's `readiness` parameter is a plain function type, so a run site handed the display
 * read would compile and admit from an answer up to 30 seconds old; this source pin catches it.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'

const SRC = path.resolve(__dirname, '../../../..')

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap(name => {
    const file = path.join(dir, name)
    if (statSync(file).isDirectory()) return name === '__tests__' || name === 'test-utils' ? [] : sources(file)
    return /\.(ts|svelte)$/.test(name) && !/\.test\.ts$/.test(name) ? [file] : []
  })
}

const files = sources(SRC).map(file => ({ file: path.relative(SRC, file), text: readFileSync(file, 'utf8') }))

it('every production admission call reads readiness fresh', () => {
  const calls = files.flatMap(({ file, text }) => [...text.matchAll(/admitClaudePlanSelection\(\{([\s\S]*?)\n\s*\}\)/g)].map(match => ({ file, body: match[1] })))
  expect(calls.map(call => call.file).sort()).toEqual(['lib/server/services/summaryGeneration.ts', 'lib/server/services/vercelBrain.ts'])
  for (const call of calls) {
    expect(call.body, call.file).toMatch(/readiness: \(\) => readClaudePlanReadiness\(\)/)
    expect(call.body, call.file).not.toMatch(/DisplayStatus|readClaudePlanStatus/)
  }
})

it('the shared display read is used only by the display routes', () => {
  const users = files.filter(({ text }) => /readClaudePlanDisplayStatus\(/.test(text)).map(({ file }) => file).sort()
  expect(users).toEqual([
    'lib/server/services/claudePlanReadiness.ts',
    'routes/api/models/+server.ts',
    'routes/api/settings/claude-plan/+server.ts',
    'routes/api/user/saved-models/+server.ts'
  ])
})
