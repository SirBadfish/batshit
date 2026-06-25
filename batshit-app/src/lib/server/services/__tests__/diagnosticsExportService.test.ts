import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { unzipSync } from 'fflate/node'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { env as privateEnv } from '$env/dynamic/private'
import {
  createDiagnosticsBundle,
  createDiagnosticsPreview,
  redactDiagnosticsText,
  redactDiagnosticsValue
} from '../diagnosticsExportService'

vi.mock('$lib/server/redis', () => ({
  redis: {
    ping: vi.fn(async () => 'PONG')
  }
}))

vi.mock('$lib/server/services/systemPromptRegistry', () => ({
  checkCoreSystemPromptDefaults: vi.fn(async () => ({
    ready: true,
    count: 2,
    missing: []
  }))
}))

let logDir: string
let previousLogDir: string | undefined
let previousServerLogDir: string | undefined
let previousBatshitToken: string | undefined
let previousPrivateEnv: Record<string, string | undefined>

const privateEnvKeys = ['BATSHIT_LOG_DIR', 'BATSHIT_SERVER_LOG_DIR', 'BATSHIT_TOKEN']

function setPrivateEnv(key: string, value: string | undefined) {
  const mutableEnv = privateEnv as Record<string, string | undefined>
  if (value === undefined) {
    delete mutableEnv[key]
  } else {
    mutableEnv[key] = value
  }
}

describe('diagnosticsExportService', () => {
  beforeEach(async () => {
    previousLogDir = process.env.BATSHIT_LOG_DIR
    previousServerLogDir = process.env.BATSHIT_SERVER_LOG_DIR
    previousBatshitToken = process.env.BATSHIT_TOKEN
    previousPrivateEnv = Object.fromEntries(
      privateEnvKeys.map((key) => [key, (privateEnv as Record<string, string | undefined>)[key]])
    )
    logDir = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-diagnostics-test-'))
    process.env.BATSHIT_LOG_DIR = logDir
    process.env.BATSHIT_SERVER_LOG_DIR = logDir
    process.env.BATSHIT_TOKEN = 'test-public-placeholder'
    setPrivateEnv('BATSHIT_LOG_DIR', logDir)
    setPrivateEnv('BATSHIT_SERVER_LOG_DIR', logDir)
    setPrivateEnv('BATSHIT_TOKEN', 'test-public-placeholder')
  })

  afterEach(async () => {
    if (previousLogDir === undefined) {
      delete process.env.BATSHIT_LOG_DIR
    } else {
      process.env.BATSHIT_LOG_DIR = previousLogDir
    }
    if (previousServerLogDir === undefined) {
      delete process.env.BATSHIT_SERVER_LOG_DIR
    } else {
      process.env.BATSHIT_SERVER_LOG_DIR = previousServerLogDir
    }
    if (previousBatshitToken === undefined) {
      delete process.env.BATSHIT_TOKEN
    } else {
      process.env.BATSHIT_TOKEN = previousBatshitToken
    }
    for (const key of privateEnvKeys) {
      setPrivateEnv(key, previousPrivateEnv[key])
    }
    await fs.rm(logDir, { recursive: true, force: true })
  })

  it('redacts common secret shapes from text and objects', () => {
    const openAiKey = `sk-proj-${'a'.repeat(32)}`
    const jwt = `eyJ${'a'.repeat(20)}.${'b'.repeat(20)}.${'c'.repeat(12)}`
    const text = redactDiagnosticsText(
      `OPENAI_API_KEY=${openAiKey}\nAuthorization: Bearer ${jwt}\nhttps://user:pass@example.com`
    )

    expect(text).not.toContain(openAiKey)
    expect(text).not.toContain(jwt)
    expect(text).not.toContain('user:pass')
    expect(text).toContain('[REDACTED]')

    const object = redactDiagnosticsValue({
      safe: 'visible',
      apiKey: 'do-not-show',
      nested: {
        cookie: 'also-private'
      }
    }) as Record<string, unknown>

    expect(object.safe).toBe('visible')
    expect(object.apiKey).toBe('[REDACTED]')
    expect((object.nested as Record<string, unknown>).cookie).toBe('[REDACTED]')
  })

  it('builds a preview that shows included and excluded diagnostics without secret values', async () => {
    await fs.writeFile(
      path.join(logDir, 'batshit-app.log'),
      `Startup ok\nBATSHIT_TOKEN=runtime-secret\nProvider key sk-proj-${'b'.repeat(32)}\n`
    )

    const preview = await createDiagnosticsPreview()
    const serialized = JSON.stringify(preview)

    expect(preview.safety.redactionApplied).toBe(true)
    expect(preview.safety.notIncluded).toContain('Chat messages and session history')
    expect(preview.environment.BATSHIT_TOKEN_CONFIGURED).toBe(true)
    expect(preview.contents.logFiles).toHaveLength(1)
    expect(preview.contents.logFiles[0].sample).toContain('[REDACTED]')
    expect(serialized).not.toContain('runtime-secret')
    expect(serialized).not.toContain('batshit-service-token-secret')
    expect(serialized).not.toContain(`sk-proj-${'b'.repeat(32)}`)
  })

  it('exports a diagnostics zip with redacted log tails and no raw chat data entries', async () => {
    const providerKey = `sk-proj-${'c'.repeat(32)}`
    await fs.writeFile(
      path.join(logDir, 'batshit-server.log'),
      `Server warning\nOPENAI_API_KEY=${providerKey}\n`
    )

    const bundle = await createDiagnosticsBundle()
    const entries = unzipSync(bundle.bytes)
    const entryNames = Object.keys(entries)

    expect(entryNames).toContain('manifest.json')
    expect(entryNames).toContain('README.md')
    expect(entryNames).toContain('runtime/context.json')
    expect(entryNames).toContain('runtime/environment.json')
    expect(entryNames).toContain('runtime/health.json')
    expect(entryNames).toContain('logs/index.json')
    expect(entryNames.some((entry) => entry.startsWith('logs/') && entry.endsWith('.log'))).toBe(
      true
    )
    expect(entryNames.some((entry) => entry.startsWith('messages/'))).toBe(false)
    expect(entryNames.some((entry) => entry.startsWith('uploads/'))).toBe(false)

    const allText = entryNames
      .map((entry) => Buffer.from(entries[entry]).toString('utf8'))
      .join('\n')

    expect(allText).not.toContain(providerKey)
    expect(allText).not.toContain('batshit-service-token-secret')
    expect(allText).toContain('[REDACTED]')
  })
})
