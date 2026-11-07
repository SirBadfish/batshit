import { describe, expect, it } from 'vitest'
import { formatCliLoginHelp, formatCliLoginNote } from './cliLoginHelp'

describe('CLI sign-in help (the Claude Plan card)', () => {
  it('names the Docker folder only when it is known', () => {
    expect(formatCliLoginHelp('docker', '/srv/batshit')).toBe('Open Terminal, go to the Batshit Docker folder shown below, then run this login command once.')
    expect(formatCliLoginHelp('docker', '  ')).toBe('Open Terminal, go to your Batshit Docker install folder, then run this login command once.')
    expect(formatCliLoginHelp('native')).toBe('Open Terminal and run this once.')
  })
  it('adds the Windows paste note for the Claude plan sign-in only', () => {
    expect(formatCliLoginNote({ id: 'claude-plan:local' })).toMatch(/Claude Code on Windows may hide pasted auth-code input/)
    // SA-139 R5: the Claude Code CLI connection was removed with its Subagent type.
    expect(formatCliLoginNote({ id: 'claude-cli' })).toBeNull()
    expect(formatCliLoginNote({ id: 'codex-cli' })).toBeNull()
    expect(formatCliLoginNote(null)).toBeNull()
  })
})
