import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

const source = readFileSync('src/routes/api/messages/send-routed/+server.ts', 'utf8')
const brain = readFileSync('src/lib/server/services/vercelBrain.ts', 'utf8')

/**
 * BL-450: the SDK answers a failed tool call (a schema-refused call, a missing tool, a thrown
 * `execute`) with a `tool-error` part, never a `tool-result`. With no case for it the call's card
 * never closed, the page held every later word back, and nothing was saved for the call. The
 * conversion is `toolErrorAsFailedToolResult` (`toolErrorPart.ts`, tested against the installed
 * SDK's real parts); these pins hold the WIRING: the stream loop sends a tool-error through the
 * tool-result path, the finish-step fallback counts it, and the steer boundary counts it.
 */
describe('send-routed answers a failed tool call through the failed tool-result path', () => {
  it('imports the shared conversion', () => {
    expect(source).toContain(
      "\nimport { toolErrorAsFailedToolResult } from '$lib/server/services/toolErrorPart'\n"
    )
  })

  it('shares the tool-result case and converts the part before anything reads it', () => {
    expect(source).toContain("\n        case 'tool-error':\n        case 'tool-result': {\n")
    expect(source).toContain(
      "\n          const toolResult =\n" +
        "            chunk.type === 'tool-error'\n" +
        '              ? toolErrorAsFailedToolResult(chunk as any)\n' +
        '              : (chunk as any)\n'
    )
    // A failed plan update opened no card and has no plan to show.
    expect(source).toContain(
      "\n          if (isPlanUpdateTool(toolResult.toolName)) {\n            if (chunk.type === 'tool-error') break\n"
    )
  })

  it('counts a tool-error in the finish-step fallback', () => {
    expect(source).toContain(
      "\n        } else if (item?.type === 'tool-error') {\n          toolResults.push(toolErrorAsFailedToolResult(item))\n"
    )
  })

  it('counts a tool-error at the steer boundary', () => {
    // BL-611 imports toolErrorAsFailedToolResult on the same line.
    expect(brain).toMatch(
      /\nimport \{[^}]*\bstepContentReachedToolBoundary\b[^}]*\} from '\.\/toolErrorPart'\n/
    )
    expect(brain).toContain(
      '\n      const previousHadToolResult = stepContentReachedToolBoundary(previous?.content)\n'
    )
  })
})
