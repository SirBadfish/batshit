import { describe, expect, it, vi } from 'vitest'

vi.mock('../redis', () => ({
  redis: {
    execute: vi.fn()
  }
}))

vi.mock('../redisStreamService', () => ({
  redisStreamService: {
    completeZipBlock: vi.fn(),
    cleanupSessionTempStorage: vi.fn(),
    getActiveZipBlocks: vi.fn()
  }
}))

import { generateZipDescription } from '../zipService'

describe('zipService generateZipDescription', () => {
  it('builds compact target-first descriptions for cool_tool zips', () => {
    const description = generateZipDescription('{"type":"tool"}', 'cool_tool', {
      operationKind: 'read_file',
      projectPath: '/Users/example/batshit',
      zipDescriptionTarget: '/Users/example/batshit/docs/user-docs/index.md',
      zipDescriptionSize: '43 lines'
    })

    expect(description).toBe('read_file: docs/user-docs/index.md - 43 lines')
  })

  it('sanitizes, redacts, and truncates command-style description targets', () => {
    const description = generateZipDescription('{"type":"tool"}', 'cool_tool', {
      operationKind: 'bash',
      zipDescriptionTarget:
        'npm run check -- --token=sample-token-value SECRET_KEY=very-secret-value && echo {done}\n' +
        '&& printf "this command is deliberately long so the zip marker stays compact"',
      zipDescriptionStatus: 'exit 0',
      zipDescriptionSize: '214 lines'
    })

    expect(description).toContain('bash:')
    expect(description).toContain('exit 0')
    expect(description).toContain('214 lines')
    expect(description).toContain('--token=[redacted]')
    expect(description).toContain('SECRET_KEY=[redacted]')
    expect(description).not.toContain('sample-token-value')
    expect(description).not.toContain('very-secret-value')
    expect(description).not.toContain('\n')
    expect(description).not.toContain('{')
    expect(description).not.toContain('}')
    expect(description.length).toBeLessThanOrEqual(150)
  })
})
