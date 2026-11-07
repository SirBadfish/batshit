import { describe, expect, it } from 'vitest'
import { isExactCliReleaseVersion } from '../cliVersion'

describe('release-specific native invocation admission', () => {
  it.each([
    ['claude', '2.1.296', '2.1.296 (Claude Code)']
  ] as const)('accepts the actual %s release version line and refuses unqualified programs', (runtime, pin, actual) => {
    expect(isExactCliReleaseVersion(runtime, actual, pin)).toBe(true)
    expect(isExactCliReleaseVersion(runtime, pin, pin)).toBe(true)
    for (const value of [null, undefined, '', actual.replace(pin, pin + '-alpha.1'), actual.replace(pin, '9.9.9'),
      actual + '\nother output', 'unrelated ' + pin, actual + ' changed',
      // SA-139 R1: the removed Codex CLI's branded line is not a Claude release.
      'codex-cli ' + pin]) {
      expect(isExactCliReleaseVersion(runtime, value, pin)).toBe(false)
    }
  })
})
