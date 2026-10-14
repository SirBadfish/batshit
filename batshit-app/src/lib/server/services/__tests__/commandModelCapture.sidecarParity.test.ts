import { describe, expect, it } from 'vitest'
import { resolve } from 'node:path'
import { createRequire } from 'node:module'
import { createCommandModelCapture, MAX_COMMAND_MODEL_CAPTURE_CHARS } from '../commandModelCapture'

// The Docker image cannot import app TypeScript. Keep its plain-JS twin byte-for-byte equivalent
// at the model boundary, including interleaved pipes and split UTF-8 sequences.
const sidecar = createRequire(import.meta.url)(resolve(process.cwd(), '../tools/docker/agent-browser-sidecar/model-capture.mjs'))

type Step = { stream: 'stdout' | 'stderr'; chunk: Buffer | string }

function collect(
  create: typeof createCommandModelCapture,
  steps: Step[],
  status: { exitCode?: number | null; signal?: string | null; timedOut?: boolean; stopped?: boolean; outputIncomplete?: boolean }
) {
  const collector = create()
  for (const step of steps) {
    if (step.stream === 'stdout') collector.appendStdout(step.chunk)
    else collector.appendStderr(step.chunk)
  }
  return collector.finish(status)
}

describe('Docker Agent Browser model-capture parity', () => {
  it('matches the app collector for mixed pipes, split UTF-8, and Stop status', () => {
    const cases: Array<{ steps: Step[]; status: Parameters<typeof collect>[2] }> = [
      { steps: [], status: { exitCode: 0 } },
      {
        steps: [
          { stream: 'stderr', chunk: 'warning\n' },
          { stream: 'stdout', chunk: Buffer.from([0x61, 0xf0, 0x9f]) },
          { stream: 'stderr', chunk: Buffer.from([0xe2, 0x82]) },
          { stream: 'stdout', chunk: Buffer.from([0x99, 0x82, 0x62]) },
          { stream: 'stderr', chunk: Buffer.from([0xac]) }
        ],
        status: { exitCode: null, signal: 'SIGTERM', stopped: true }
      },
      {
        steps: [{ stream: 'stdout', chunk: 'observed before a forced pipe close' }],
        status: { exitCode: null, signal: 'SIGKILL', timedOut: true, outputIncomplete: true }
      },
      {
        steps: [
          { stream: 'stderr', chunk: 'e'.repeat(100_000) },
          { stream: 'stdout', chunk: 'o'.repeat(120_000) },
          { stream: 'stderr', chunk: 'later' }
        ],
        status: { exitCode: 124, timedOut: true }
      },
      // BL-679: the end of stderr leads, the rest follows stdout; a pair at the 8,000 boundary.
      {
        steps: [
          { stream: 'stderr', chunk: '😀'.repeat(2_000) },
          { stream: 'stdout', chunk: 'between\n' },
          { stream: 'stderr', chunk: `${'😀'.repeat(2_000)}z` },
          { stream: 'stderr', chunk: Buffer.from([0xf0, 0x9f]) },
          { stream: 'stderr', chunk: Buffer.from([0x98, 0x80]) }
        ],
        status: { exitCode: 1 }
      },
      {
        steps: [{ stream: 'stderr', chunk: 'x'.repeat(8_000) }, { stream: 'stdout', chunk: 'y' }],
        status: { exitCode: 0 }
      }
    ]
    expect(sidecar.MAX_COMMAND_MODEL_CAPTURE_CHARS).toBe(MAX_COMMAND_MODEL_CAPTURE_CHARS)
    for (const fixture of cases) {
      expect(collect(sidecar.createCommandModelCapture, fixture.steps, fixture.status))
        .toEqual(collect(createCommandModelCapture, fixture.steps, fixture.status))
    }
  })

  it('matches at the 8M boundary when later stdout displaces an earlier stderr prefix', () => {
    const steps: Step[] = [
      { stream: 'stderr', chunk: 'e'.repeat(100_000) },
      { stream: 'stdout', chunk: 'a'.repeat(MAX_COMMAND_MODEL_CAPTURE_CHARS - 50) },
      { stream: 'stderr', chunk: 'tail after a gap' },
      { stream: 'stdout', chunk: 'b'.repeat(200_000) }
    ]
    const status = { exitCode: 0 }
    const app = collect(createCommandModelCapture, steps, status)
    const docker = collect(sidecar.createCommandModelCapture, steps, status)
    expect(docker).toEqual(app)
    expect(docker.text.length).toBeLessThanOrEqual(MAX_COMMAND_MODEL_CAPTURE_CHARS)
    expect(docker.originalTextChars).toBeGreaterThan(MAX_COMMAND_MODEL_CAPTURE_CHARS)
    expect(docker.text).toContain('tail after a gap\nstdout:\n')
  })
})
