import { describe, expect, it } from 'vitest'
import {
  DEFAULT_LIVE_FILE_READS_ENABLED,
  liveFileReadsChosenOn,
  LIVE_FILE_READS_LABEL,
  LIVE_READ_STATE_MAX_LINES,
  buildLiveReadStateLines,
  describeLiveReadThisTurn,
  describeNotRefreshedReason,
  refreshedFileReadsUnavailableReason,
  resolveLiveFileReadsEnabled,
  validateLiveFileReadsGlobalField,
  type LiveReadThisTurn
} from './liveFileReads'

describe('liveFileReadsChosenOn (the Settings warning asks this, D13)', () => {
  it('is true only for a chosen ON: the agent\'s own true, else the global true; the factory value is no choice', () => {
    expect(liveFileReadsChosenOn({ live_file_reads: true }, null)).toBe(true)
    expect(liveFileReadsChosenOn({}, { live_file_reads: true })).toBe(true)
    expect(liveFileReadsChosenOn({ live_file_reads: null }, { live_file_reads: true })).toBe(true)
    expect(liveFileReadsChosenOn({ live_file_reads: false }, { live_file_reads: true })).toBe(false)
    expect(liveFileReadsChosenOn({}, {})).toBe(false)
    expect(liveFileReadsChosenOn(null, null)).toBe(false)
    expect(liveFileReadsChosenOn({}, { live_file_reads: false })).toBe(false)
    // The resolver still answers ON for the unchosen case.
    expect(resolveLiveFileReadsEnabled({}, {})).toBe(true)
  })
})

/** SA-137 (D11): agent override, else the global Tool Grid value, else the factory value (ON, D13); null inherits, false stays false. */
describe('resolveLiveFileReadsEnabled', () => {
  it('reads the agent, then the global value, then the factory value (ON, D13 2026-11-04)', () => {
    expect(resolveLiveFileReadsEnabled({ live_file_reads: true }, { live_file_reads: false })).toBe(true)
    expect(resolveLiveFileReadsEnabled({ live_file_reads: false }, { live_file_reads: true })).toBe(false)
    expect(resolveLiveFileReadsEnabled({ live_file_reads: null }, { live_file_reads: true })).toBe(true)
    expect(resolveLiveFileReadsEnabled({}, { live_file_reads: true })).toBe(true)
    expect(DEFAULT_LIVE_FILE_READS_ENABLED).toBe(true)
    expect(resolveLiveFileReadsEnabled({}, {})).toBe(true)
    expect(resolveLiveFileReadsEnabled(null, null)).toBe(true)
    expect(resolveLiveFileReadsEnabled({}, { live_file_reads: false })).toBe(false)
    // A mistyped value at either level reads as "not set", so the factory value applies.
    expect(resolveLiveFileReadsEnabled({ live_file_reads: 'yes' }, { live_file_reads: 1 })).toBe(true)
  })
})

/** SA-137 P4a: `global_zip_settings` is saved whole, so a mistyped value is refused at the route. */
describe('validateLiveFileReadsGlobalField', () => {
  it('accepts an absent field, true, false and null', () => {
    expect(validateLiveFileReadsGlobalField(undefined)).toBeNull()
    expect(validateLiveFileReadsGlobalField(null)).toBeNull()
    expect(validateLiveFileReadsGlobalField({})).toBeNull()
    expect(validateLiveFileReadsGlobalField({ zip_ai_view_mode: 'inline' })).toBeNull()
    for (const value of [true, false, null]) expect(validateLiveFileReadsGlobalField({ live_file_reads: value })).toBeNull()
  })

  it('refuses any other value, naming the setting', () => {
    expect(LIVE_FILE_READS_LABEL).toBe('Refreshed File Reads')
    for (const value of ['true', 'false', 1, 0, {}, [], undefined]) {
      expect(validateLiveFileReadsGlobalField({ live_file_reads: value })).toBe('"Refreshed File Reads" must be true or false.')
    }
  })
})

/** SA-137 Round 2 (R2-2, R2-5/R2-6): one availability rule, with the Sandbox backends that mount the host workspace. */
describe('refreshedFileReadsUnavailableReason', () => {
  const mac = { platform: 'darwin', containerized: false }
  const linux = { platform: 'linux', containerized: false }
  const base = { primaryType: 'api', zipViewMode: 'appended' as const, backend: 'local', host: mac }

  it('is available for an API agent on a Mac or Linux host with the appended view and the local backend', () => {
    expect(refreshedFileReadsUnavailableReason(base)).toBeNull()
    expect(refreshedFileReadsUnavailableReason({ ...base, host: linux })).toBeNull()
  })

  it('is available on a Mac for Apple Container and Docker Sandbox, never on Linux', () => {
    for (const backend of ['apple_container', 'docker_sandbox']) {
      expect(refreshedFileReadsUnavailableReason({ ...base, backend }), backend).toBeNull()
      expect(refreshedFileReadsUnavailableReason({ ...base, backend, host: linux }), backend).toBe('Refreshed File Reads is not available with this Sandbox Level yet.')
    }
  })

  it('names the first thing that rules it out, in the setting\'s own name', () => {
    // SA-139 R4: a leftover `cli` Primary is a removed type, never a live lane.
    expect(refreshedFileReadsUnavailableReason({ ...base, primaryType: 'cli' })).toBe("This agent's type was removed from Batshit, so Refreshed File Reads cannot run for it.")
    expect(refreshedFileReadsUnavailableReason({ ...base, host: null })).toBe('Checking whether Refreshed File Reads can run here.')
    expect(refreshedFileReadsUnavailableReason({ ...base, host: { platform: 'darwin', containerized: true } })).toBe('Refreshed File Reads is not available in the app container yet.')
    expect(refreshedFileReadsUnavailableReason({ ...base, host: { platform: 'win32', containerized: false } })).toBe('Refreshed File Reads needs a Mac or Linux host.')
    expect(refreshedFileReadsUnavailableReason({ ...base, backend: 'remote' })).toBe('Refreshed File Reads is not available with this Sandbox Level yet.')
    expect(refreshedFileReadsUnavailableReason({ ...base, zipViewMode: 'inline' })).toContain('needs the appended Zip view')
  })
})

/** Round 2: the words a Zipped this turn line of the Zip Index uses for a copy that stayed zipped. */
describe('describeNotRefreshedReason', () => {
  it('gives each reason its own plain words, and an unknown or unrefreshable one the generic words', () => {
    const words: Record<string, string> = {
      'not-readable': 'the file is missing or cannot be read',
      'not-regular-or-too-large': 'it is no longer a regular file within the size limit',
      'not-bounded-text': 'it is no longer text within the size limit',
      'changed-during-read': 'it changed while Batshit read it',
      deadline: 'reading it took too long',
      'reader-busy': 'the file reader was busy',
      'reader-unavailable': 'the file reader was not available',
      'root-unavailable': 'the project folder is not available',
      'root-changed': 'it was read in another project folder, or that folder changed',
      'protected-root': 'its project folder is closed to sandboxes',
      'reader-gone': 'the agent that read it is gone, cannot read files now, or does not share it with you',
      'sharing-changed': 'its sharing or the agent that read it changed during this turn',
      'other-actor': 'it was read in another chat',
      'read-error': 'reading it failed',
      'unsupported-platform': 'it was read where Batshit cannot refresh it',
      'backend-not-local': 'it was read where Batshit cannot refresh it',
      'source-backend-not-local': 'it was read where Batshit cannot refresh it',
      'not-in-replay': "it was not in this approval's file snapshot",
      'too-many-copies': 'too many open file reads this turn',
      'refresh-memory': 'too much file text this turn',
      'replay-capacity': 'too much file text to keep for an approval',
      'emulation-failed': 'its range no longer matches the file',
      'read-while-off': 'it was read while Refreshed File Reads was off',
      'replay-missing': "this approval's file snapshot was not kept",
      'replay-expired': "this approval's file snapshot expired",
      'replay-unverifiable': "this approval's file snapshot is from before Batshit restarted",
      stopped: 'the reply was stopped',
      'not-refreshable': 'Batshit cannot refresh this kind of read'
    }
    for (const [reason, expected] of Object.entries(words)) expect(describeNotRefreshedReason(reason), reason).toBe(expected)
    expect(describeNotRefreshedReason('something-new')).toBe('Batshit cannot refresh this kind of read')
  })

  it('never carries the old name of the setting', () => {
    for (const reason of ['read-while-off', 'replay-missing', 'replay-expired', 'replay-unverifiable', 'stopped', 'refresh-memory', 'not-in-replay', 'sharing-changed']) {
      expect(describeNotRefreshedReason(reason), reason).not.toMatch(/live file reads/i)
    }
  })
})

/** Round 2: the per-copy line after the file name. */
describe('describeLiveReadThisTurn', () => {
  it('says a copy was not refreshed, with the reason', () => {
    expect(describeLiveReadThisTurn({ kind: 'not-refreshed', reason: 'not-readable' })).toBe('zipped this turn; not refreshed (the file is missing or cannot be read).')
  })

  it('says a refreshed copy grew past the size guard, in tokens, and never mentions fetching', () => {
    const line = describeLiveReadThisTurn({ kind: 'grew', tokens: 17_029.4 })
    expect(line).toBe('zipped this turn; it grew to about 17,029 tokens. Read the current lines you need.')
    expect(line).not.toMatch(/fetch/i)
    expect(describeLiveReadThisTurn({ kind: 'grew', tokens: -5 })).toContain('about 0 tokens')
  })
})

describe('buildLiveReadStateLines', () => {
  const copy = (index: number, extra: Partial<LiveReadThisTurn> = {}): LiveReadThisTurn => ({
    zipId: `zip-${index}`,
    file: `src/f${index}.js`,
    liveRead: { kind: 'not-refreshed', reason: 'not-readable' },
    ...extra
  })

  it('writes one line per copy: the file, then what happened', () => {
    expect(buildLiveReadStateLines([copy(1), copy(2, { liveRead: { kind: 'grew', tokens: 30_000 } })])).toEqual([
      '- src/f1.js: zipped this turn; not refreshed (the file is missing or cannot be read).',
      '- src/f2.js: zipped this turn; it grew to about 30,000 tokens. Read the current lines you need.'
    ])
  })

  it('names another member as the reader', () => {
    expect(buildLiveReadStateLines([copy(1, { readerName: 'Ada' })])).toEqual([
      '- src/f1.js (read by Ada): zipped this turn; not refreshed (the file is missing or cannot be read).'
    ])
    expect(buildLiveReadStateLines([copy(1, { readerName: null })])[0]).toBe('- src/f1.js: zipped this turn; not refreshed (the file is missing or cannot be read).')
  })

  it('leaves out the copies a hold line already says', () => {
    expect(buildLiveReadStateLines([copy(1), copy(2)], new Set(['zip-1']))).toEqual([
      '- src/f2.js: zipped this turn; not refreshed (the file is missing or cannot be read).'
    ])
  })

  it('caps the lines at 20 and counts the rest in one line', () => {
    expect(LIVE_READ_STATE_MAX_LINES).toBe(20)
    const twenty = buildLiveReadStateLines(Array.from({ length: 20 }, (_, index) => copy(index)))
    expect(twenty).toHaveLength(20)
    const lines = buildLiveReadStateLines(Array.from({ length: 21 }, (_, index) => copy(index)))
    expect(lines).toHaveLength(21)
    expect(lines[19]).toBe('- src/f19.js: zipped this turn; not refreshed (the file is missing or cannot be read).')
    expect(lines[20]).toBe('- 1 more Read File copy zipped this turn by Refreshed File Reads.')
    expect(buildLiveReadStateLines(Array.from({ length: 25 }, (_, index) => copy(index)))[20]).toBe('- 5 more Read File copies zipped this turn by Refreshed File Reads.')
  })

  it('names the Zip id after the label when two listed copies share one label (review S5), and only then', () => {
    const lines = buildLiveReadStateLines([copy(1, { file: 'src/same.js' }), copy(2, { file: 'src/same.js' }), copy(3)])
    expect(lines).toEqual([
      '- src/same.js | zip-1: zipped this turn; not refreshed (the file is missing or cannot be read).',
      '- src/same.js | zip-2: zipped this turn; not refreshed (the file is missing or cannot be read).',
      '- src/f3.js: zipped this turn; not refreshed (the file is missing or cannot be read).'
    ])
    // The same file read by different members is two labels, not a repeat.
    expect(buildLiveReadStateLines([copy(1, { file: 'src/same.js' }), copy(2, { file: 'src/same.js', readerName: 'Ada' })]).every((line) => !line.includes('| zip-'))).toBe(true)
    // The same file and the same member repeats.
    expect(buildLiveReadStateLines([copy(1, { file: 'src/same.js', readerName: 'Ada' }), copy(2, { file: 'src/same.js', readerName: 'Ada' })])[1])
      .toBe('- src/same.js (read by Ada) | zip-2: zipped this turn; not refreshed (the file is missing or cannot be read).')
    // A copy left out for a hold line does not make the other one a repeat.
    expect(buildLiveReadStateLines([copy(1, { file: 'src/same.js' }), copy(2, { file: 'src/same.js' })], new Set(['zip-1'])))
      .toEqual(['- src/same.js: zipped this turn; not refreshed (the file is missing or cannot be read).'])
  })

  it('counts the cap after the held copies are left out', () => {
    const all = Array.from({ length: 22 }, (_, index) => copy(index))
    const lines = buildLiveReadStateLines(all, new Set(['zip-0', 'zip-1']))
    expect(lines).toHaveLength(20)
    expect(lines.some((line) => line.includes('more Read File'))).toBe(false)
  })
})
