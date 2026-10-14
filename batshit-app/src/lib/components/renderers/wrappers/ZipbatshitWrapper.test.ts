import { execSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import ZipbatshitWrapperFixture from './ZipbatshitWrapper.fixture.svelte'

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

describe('the chat hands every badge its held-dead-copy flag (BL-358)', () => {
  it('computes it from the stored hold and the dead-copy compress, and passes it to every wrapper', () => {
    const source = readFileSync('src/lib/components/chat/MessageContent.svelte', 'utf8')
    expect(source).toContain('\n      heldDeadCopy: isUnzipped && activation.shouldCompress,\n')
    const wrappers = source.split('<ZipbatshitWrapper').length - 1
    expect(wrappers).toBeGreaterThan(0)
    expect(source.split('heldDeadCopy={Boolean(zipState.heldDeadCopy)}').length - 1).toBe(wrappers)
    expect(source.split('sizeGuard={zipState.sizeGuard}').length - 1).toBe(wrappers)
  })

  it('the tool cards of a Tool activity group pass it too (the live page caught this third site)', () => {
    const source = readFileSync('src/lib/components/chat/ToolActivitySegment.svelte', 'utf8')
    expect(source).toContain('\n  let heldDeadCopy = $derived(Boolean(zipState.heldDeadCopy))\n')
    expect(source).toContain('\n  {deadCopyReason}\n  {heldDeadCopy}\n')
    expect(source).toContain('\n  {heldDeadCopy}\n  {sizeGuard}\n')
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
