import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import ZipbatshitWrapperFixture from './ZipbatshitWrapper.fixture.svelte'
import { describeNotRefreshedReason } from '$lib/utils/liveFileReads'

describe('ZipbatshitWrapper controls', () => {
  it('lets a buffer-expanded item be held before it compresses: Hold for 10 messages, or Hold', async () => {
    const onToggleUnzip = vi.fn()
    const onZipNow = vi.fn()

    render(ZipbatshitWrapperFixture, {
      props: {
        expandedReason: 'buffer',
        onToggleUnzip,
        onZipNow
      }
    })

    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))

    await fireEvent.click(screen.getByRole('button', { name: 'Hold for 10 messages' }))
    expect(onToggleUnzip).toHaveBeenCalledWith(false, 'Read File', 'Read File output', 857)

    await fireEvent.click(screen.getByRole('button', { name: 'Hold' }))
    expect(onToggleUnzip).toHaveBeenCalledWith(true, 'Read File', 'Read File output', 857)

    await fireEvent.click(screen.getByRole('button', { name: 'Zip now' }))
    expect(onZipNow).toHaveBeenCalledWith('zip-test', 'Read File', 'Read File output', 857)
  })

  it('separates zip-now from release for an item the user holds (SA-129 D1: Hold and Release)', async () => {
    const onZipNow = vi.fn()
    const onReturnAutomatic = vi.fn()

    render(ZipbatshitWrapperFixture, {
      props: {
        isUnzipped: true,
        expandedReason: 'user',
        onZipNow,
        onReturnAutomatic
      }
    })

    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))

    await fireEvent.click(screen.getByRole('button', { name: 'Zip now' }))
    expect(onZipNow).toHaveBeenCalledWith('zip-test', 'Read File', 'Read File output', 857)

    await fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')

    expect(screen.queryByRole('button', { name: 'Hold for 10 messages' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument()
  })

  it('lets a manually zipped item be released back to the automatic rules', async () => {
    const onReturnAutomatic = vi.fn()

    render(ZipbatshitWrapperFixture, {
      props: {
        isZipped: true,
        manualZip: true,
        onReturnAutomatic
      }
    })

    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))

    await fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')
  })

  it('shows user temporary unzip as hand plus countdown', () => {
    render(ZipbatshitWrapperFixture, {
      props: {
        isUnzipped: true,
        expandedReason: 'user',
        remainingMessages: 7
      }
    })

    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', 'Held by you (7 messages left)')
    expect(screen.getByLabelText('Held by you')).toBeInTheDocument()
    expect(controls).toHaveTextContent('7')
  })

  it('shows agent permanent unzip as agent plus infinity', () => {
    render(ZipbatshitWrapperFixture, {
      props: {
        isUnzipped: true,
        expandedReason: 'agent',
        isPermanent: true,
        agentControlled: true
      }
    })

    expect(screen.getByLabelText('Zip controls')).toHaveAttribute('title', 'Held by the agent')
    expect(screen.getByLabelText('Held by an agent')).toBeInTheDocument()
  })

  // SA-129 P2 (DL-02, D1): one vocabulary on both sides.
  it("names the agent that holds it, and offers the user Hold and Release over it (the user wins)", async () => {
    const onToggleUnzip = vi.fn()
    const onReturnAutomatic = vi.fn()
    render(ZipbatshitWrapperFixture, {
      props: {
        isUnzipped: true,
        expandedReason: 'agent',
        isPermanent: true,
        agentControlled: true,
        holdLabel: 'Held by Opie',
        onToggleUnzip,
        onReturnAutomatic
      }
    })
    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', 'Held by Opie')
    await fireEvent.mouseEnter(controls)
    await fireEvent.click(screen.getByRole('button', { name: 'Hold' }))
    expect(onToggleUnzip).toHaveBeenCalledWith(true, 'Read File', 'Read File output', 857)
    await fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')
  })

  it("never offers Hold on the user's own hold (only Zip now and Release)", async () => {
    render(ZipbatshitWrapperFixture, {
      props: { isUnzipped: true, expandedReason: 'user', isPermanent: true, holdLabel: 'Held by you', onZipNow: vi.fn(), onReturnAutomatic: vi.fn() }
    })
    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))
    expect(screen.queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument()
  })

  it('says why a dead copy is compressed, and that an agent hold waits for the next whole read (BL-333)', () => {
    const { unmount } = render(ZipbatshitWrapperFixture, { props: { isZipped: true, deadCopyReason: 'superseded' } })
    expect(screen.getByLabelText('Zip controls')).toHaveAttribute('title', 'Compressed: superseded by a later read')
    unmount()
    render(ZipbatshitWrapperFixture, { props: { isZipped: true, deadCopyReason: 'stale', holdLabel: 'Held by Opie' } })
    expect(screen.getByLabelText('Zip controls')).toHaveAttribute(
      'title',
      'Compressed: stale, edited since. Held by Opie; the hold moves to the next whole read'
    )
  })

  it("offers Release for an agent's hold on a dead copy the prompt compresses anyway, as the Zip Manager does (BL-358)", async () => {
    const onReturnAutomatic = vi.fn()
    const { unmount } = render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, deadCopyReason: 'stale', holdLabel: 'Held by Opie', heldDeadCopy: true, onReturnAutomatic }
    })
    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))
    await fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')
    unmount()

    // A plain dead copy that nobody holds has nothing to release.
    render(ZipbatshitWrapperFixture, { props: { isZipped: true, deadCopyReason: 'superseded', onReturnAutomatic } })
    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))
    expect(screen.queryByRole('button', { name: 'Release' })).not.toBeInTheDocument()
  })

  it('shows the too-large reason, refuses new Holds, and releases a pre-existing Hold', async () => {
    const onToggleUnzip = vi.fn()
    const onReturnAutomatic = vi.fn()
    render(ZipbatshitWrapperFixture, {
      props: {
        isZipped: true,
        heldDeadCopy: true,
        holdLabel: 'Held by you',
        sizeGuard: 'too_large',
        tokens: 30_000,
        onToggleUnzip,
        onReturnAutomatic
      }
    })

    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', 'Too large for the prompt (about 30,000 tokens). The agent reads it in parts.')
    await fireEvent.mouseEnter(controls)
    expect(screen.queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold for 10 messages' })).not.toBeInTheDocument()
    await fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onToggleUnzip).not.toHaveBeenCalled()
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')
  })

  it('shows a Judge Juice unzip as its own actor with a countdown, never as a user lock (SA-120 P5)', () => {
    render(ZipbatshitWrapperFixture, {
      props: {
        isUnzipped: true,
        expandedReason: 'inferred',
        inferredControlled: true,
        remainingMessages: 2
      }
    })

    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', 'Held by the judge (2 messages left)')
    expect(screen.getByLabelText('Held by the judge')).toBeInTheDocument()
    expect(screen.queryByLabelText('Held by you')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Held by an agent')).not.toBeInTheDocument()
    expect(controls).toHaveTextContent('2')
  })

  it('says who zipped it when Judge Juice closed a finished result (SA-120 P5)', () => {
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, manualZip: true, inferredControlled: true }
    })
    expect(screen.getByLabelText('Zip controls')).toHaveAttribute(
      'title',
      'Compressed by the judge: the agent seemed done with it'
    )
  })
})

describe('a file snapshot the newest reply showed (SA-137 P4)', () => {
  it('adds the snapshot line to the tooltip and the aria label, and keeps the stored token label', () => {
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, tokens: 40, liveSnapshot: { delivery: 'issued', promptTokens: 17_000 } }
    })
    const controls = screen.getByLabelText('Zip controls')
    const line = 'Measured from the file as it was when the newest reply started (17,000 tokens); compressed, so its text was not sent'
    expect(controls).toHaveAttribute('title', `Compressed. ${line}`)
    expect(controls.querySelector('.status-icon')).toHaveAttribute('aria-label', `Compressed. ${line}`)
    expect(controls).toHaveTextContent('40 tokens')
    expect(controls).not.toHaveTextContent('17,000')
  })

  it('says a prepared snapshot was not confirmed as sent', () => {
    render(ZipbatshitWrapperFixture, {
      props: { isUnzipped: true, expandedReason: 'buffer', liveSnapshot: { delivery: 'prepared', promptTokens: 50 } }
    })
    expect(screen.getByLabelText('Zip controls').getAttribute('title')).toMatch(
      /File snapshot prepared for the newest reply \(50 tokens\); sending it was not confirmed$/
    )
  })

  it('names the snapshot size in the too-large line, the size the guard judged', () => {
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, sizeGuard: 'too_large', tokens: 40, liveSnapshot: { delivery: 'issued', promptTokens: 30_000 } }
    })
    expect(screen.getByLabelText('Zip controls').getAttribute('title')).toMatch(
      /^Too large for the prompt \(about 30,000 tokens\)\. The agent reads it in parts\. Measured from the file/
    )
  })

  it('changes nothing without a snapshot', () => {
    const { unmount } = render(ZipbatshitWrapperFixture, { props: { isZipped: true, tokens: 40 } })
    expect(screen.getByLabelText('Zip controls')).toHaveAttribute('title', 'Compressed')
    unmount()
    render(ZipbatshitWrapperFixture, { props: { isZipped: true, tokens: 40, liveSnapshot: null } })
    expect(screen.getByLabelText('Zip controls')).toHaveAttribute('title', 'Compressed')
  })
})

describe('a copy the newest reply did not refresh (SA-137 Round 2)', () => {
  const LINE = `Not shown to the agent in the newest reply: not refreshed (${describeNotRefreshedReason('not-readable')}). Batshit tries again at the next reply.`
  const notRefreshed = { delivery: 'not-refreshed' as const, reason: 'not-readable' }

  it('draws compressed with the line, in the tooltip and the aria label', () => {
    render(ZipbatshitWrapperFixture, { props: { isZipped: true, tokens: 40, liveSnapshot: notRefreshed } })
    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', `Compressed. ${LINE}`)
    expect(controls.querySelector('.status-icon')).toHaveAttribute('aria-label', `Compressed. ${LINE}`)
    expect(controls).toHaveTextContent('40 tokens')
  })

  it('keeps the hold label and still offers Release (a held copy the reply zipped)', async () => {
    const onReturnAutomatic = vi.fn()
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, isUnzipped: true, heldDeadCopy: true, holdLabel: 'Held by you', liveSnapshot: notRefreshed, onReturnAutomatic }
    })
    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', `Compressed. Held by you. ${LINE}`)
    await fireEvent.mouseEnter(controls)
    await fireEvent.click(screen.getByRole('button', { name: 'Release' }))
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')
  })

  // S2: under the user's own Hold the badge offers Release, never a new Hold (that would silently
  // replace a permanent Hold with "Hold for 10 messages").
  it('under the user\'s own Hold it offers Release and no new Hold: no Hold for 10, no Hold', async () => {
    const onToggleUnzip = vi.fn()
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, isUnzipped: true, heldDeadCopy: true, userHeld: true, holdLabel: 'Held by you', liveSnapshot: notRefreshed, onToggleUnzip, onReturnAutomatic: vi.fn() }
    })
    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))
    expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold for 10 messages' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Hold' })).not.toBeInTheDocument()
    expect(onToggleUnzip).not.toHaveBeenCalled()
  })

  it('under an agent\'s Hold (the user may replace it) it still offers both Holds and Release', async () => {
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, isUnzipped: true, heldDeadCopy: true, userHeld: false, holdLabel: 'Held by Opie', liveSnapshot: notRefreshed, onReturnAutomatic: vi.fn() }
    })
    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))
    expect(screen.getByRole('button', { name: 'Hold for 10 messages' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hold' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Release' })).toBeInTheDocument()
  })

  it('a plain compressed copy nobody holds still offers both Holds', async () => {
    render(ZipbatshitWrapperFixture, { props: { isZipped: true, liveSnapshot: notRefreshed } })
    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))
    expect(screen.getByRole('button', { name: 'Hold for 10 messages' })).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Hold' })).toBeInTheDocument()
  })

  it('a too-large copy names its stored size (the snapshot has none)', () => {
    render(ZipbatshitWrapperFixture, { props: { isZipped: true, sizeGuard: 'too_large', tokens: 30_000, liveSnapshot: notRefreshed } })
    expect(screen.getByLabelText('Zip controls').getAttribute('title')).toBe(`Too large for the prompt (about 30,000 tokens). The agent reads it in parts. ${LINE}`)
  })
})

describe('the chat hands every badge its held-dead-copy flag (BL-358)', () => {
  it('computes it from the stored hold and the dead-copy compress, and passes it to every wrapper', () => {
    const source = readFileSync('src/lib/components/chat/MessageContent.svelte', 'utf8')
    expect(source).toContain('\n      heldDeadCopy: isUnzipped && compressed,\n')
    const wrappers = source.split('<ZipbatshitWrapper').length - 1
    expect(wrappers).toBeGreaterThan(0)
    expect(source.split('heldDeadCopy={Boolean(zipState.heldDeadCopy)}').length - 1).toBe(wrappers)
    // Round 2: and whether the stored hold is the user's, so no badge offers a Hold over it.
    expect(source).toContain('\n      userHeld: isUserHold(unzippedItem),\n')
    expect(source.split('userHeld={Boolean(zipState.userHeld)}').length - 1).toBe(wrappers)
    expect(source.split('sizeGuard={zipState.sizeGuard}').length - 1).toBe(wrappers)
    // SA-137 P4: and the file snapshot the newest reply showed.
    expect(source.split('liveSnapshot={zipState.liveSnapshot ?? null}').length - 1).toBe(wrappers)
  })

  it('the tool cards of a Tool activity group pass it too (the live page caught this third site)', () => {
    const source = readFileSync('src/lib/components/chat/ToolActivitySegment.svelte', 'utf8')
    expect(source).toContain('\n  let heldDeadCopy = $derived(Boolean(zipState.heldDeadCopy))\n')
    expect(source).toContain('\n  {deadCopyReason}\n  {heldDeadCopy}\n')
    expect(source).toContain('\n  {heldDeadCopy}\n  {userHeld}\n  {sizeGuard}\n  {liveSnapshot}\n')
    expect(source).toContain('\n  let userHeld = $derived(Boolean(zipState.userHeld))\n')
    expect(source).toContain('\n  let liveSnapshot = $derived(zipState.liveSnapshot ?? null)\n')
  })

  it('every component that draws a zip badge is one of the three pinned here', () => {
    // A new badge site must pass `heldDeadCopy` too; this list is the reminder.
    const sites = ['MessageContent.svelte', 'ToolActivitySegment.svelte', 'ZipsManagerDropdown.svelte']
    const found = execSync("grep -rl '<ZipbatshitWrapper' src/lib/components --include='*.svelte'", { encoding: 'utf8' })
      .split('\n')
      .filter((line) => line && !line.endsWith('.fixture.svelte'))
      .map((line) => line.split('/').pop())
      .sort()
    expect(found).toEqual([...sites].sort())
  })
})
