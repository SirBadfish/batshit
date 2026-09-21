import { fireEvent, render, screen } from '@testing-library/svelte'
import { describe, expect, it, vi } from 'vitest'

import ZipbatshitWrapperFixture from './ZipbatshitWrapper.fixture.svelte'

describe('ZipbatshitWrapper controls', () => {
  it('lets buffer-expanded zip items be manually unzipped before they compress', async () => {
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

    await fireEvent.click(screen.getByRole('button', { name: 'Unzip for 10 messages' }))
    expect(onToggleUnzip).toHaveBeenCalledWith(false, 'Read File', 'Read File output', 857)

    await fireEvent.click(screen.getByRole('button', { name: 'Unzip indefinitely' }))
    expect(onToggleUnzip).toHaveBeenCalledWith(true, 'Read File', 'Read File output', 857)

    await fireEvent.click(screen.getByRole('button', { name: 'Zip now' }))
    expect(onZipNow).toHaveBeenCalledWith('zip-test', 'Read File', 'Read File output', 857)
  })

  it('separates zip-now from return-to-automatic for manually unzipped items', async () => {
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

    await fireEvent.click(screen.getByRole('button', { name: 'Return to automatic' }))
    expect(onReturnAutomatic).toHaveBeenCalledWith('zip-test')

    expect(screen.queryByRole('button', { name: 'Unzip for 10 messages' })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Unzip indefinitely' })).not.toBeInTheDocument()
  })

  it('lets manually zipped items return to automatic behavior', async () => {
    const onReturnAutomatic = vi.fn()

    render(ZipbatshitWrapperFixture, {
      props: {
        isZipped: true,
        manualZip: true,
        onReturnAutomatic
      }
    })

    await fireEvent.mouseEnter(screen.getByLabelText('Zip controls'))

    await fireEvent.click(screen.getByRole('button', { name: 'Return to automatic' }))
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
    expect(controls).toHaveAttribute('title', 'You kept this unzipped for 7 messages')
    expect(screen.getByLabelText('User zip control')).toBeInTheDocument()
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

    expect(screen.getByLabelText('Zip controls')).toHaveAttribute(
      'title',
      'Agent kept this unzipped always'
    )
    expect(screen.getByLabelText('Agent zip control')).toBeInTheDocument()
  })

  it('shows a Jev Juice unzip as its own actor with a countdown, never as a user lock (SA-120 P5)', () => {
    render(ZipbatshitWrapperFixture, {
      props: {
        isUnzipped: true,
        expandedReason: 'inferred',
        inferredControlled: true,
        remainingMessages: 2
      }
    })

    const controls = screen.getByLabelText('Zip controls')
    expect(controls).toHaveAttribute('title', 'Jev unzipped this for 2 messages')
    expect(screen.getByLabelText('Unzipped by Jev')).toBeInTheDocument()
    expect(screen.queryByLabelText('User zip control')).not.toBeInTheDocument()
    expect(screen.queryByLabelText('Agent zip control')).not.toBeInTheDocument()
    expect(controls).toHaveTextContent('2')
  })

  it('says who zipped it when Jev Juice closed a finished result (SA-120 P5)', () => {
    render(ZipbatshitWrapperFixture, {
      props: { isZipped: true, manualZip: true, inferredControlled: true }
    })
    expect(screen.getByLabelText('Zip controls')).toHaveAttribute(
      'title',
      'Zipped by Jev: the agent seemed done with it'
    )
  })
})
