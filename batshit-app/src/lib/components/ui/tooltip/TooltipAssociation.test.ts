import { fireEvent, render, screen, waitFor } from '@testing-library/svelte'
import { beforeAll, describe, expect, it } from 'vitest'
import TooltipAssociation from './TooltipAssociation.fixture.svelte'

// Exercise the real shared wrappers and installed Bits UI. Only the browser
// measurement API missing from jsdom is stubbed; no Tooltip primitive is mocked.
beforeAll(() => {
  ;(window as any).ResizeObserver ??= class ResizeObserver {
    observe() {}
    unobserve() {}
    disconnect() {}
  }
})

async function open(label: string, text: string) {
  const trigger = screen.getByRole('button', { name: label })
  await fireEvent.focus(trigger)
  const body = await screen.findByText(text)
  const content = body.closest('[data-slot="tooltip-content"]') as HTMLElement
  expect(content).not.toBeNull()
  return { trigger, content }
}

function expectAssociation(trigger: HTMLElement, content: HTMLElement) {
  expect(content.id).not.toBe('')
  expect(content).toHaveAttribute('role', 'tooltip')
  expect(trigger).toHaveAttribute('aria-describedby', content.id)
  expect(document.getElementById(trigger.getAttribute('aria-describedby')!)).toBe(content)
}

describe('shared Tooltip content association (BL-1133)', () => {
  it('forwards associated identity, semantics and ref through a custom content snippet', async () => {
    render(TooltipAssociation)
    const { trigger, content } = await open('Custom content tooltip', 'Custom content tooltip body')
    await waitFor(() => expectAssociation(trigger, content))
    expect(content).toHaveClass('bs-tooltip-content', 'custom-content')
    expect(screen.getByTestId('custom-content-ref')).toHaveTextContent(content.id)
  })

  it('associates default content and forwards its rendered ref', async () => {
    render(TooltipAssociation)
    const { trigger, content } = await open('Default tooltip', 'Default tooltip content')
    await waitFor(() => expectAssociation(trigger, content))
    expect(screen.getByTestId('default-content-ref')).toHaveTextContent(content.id)
  })

  it('preserves an explicit content ID on the actual tooltip node', async () => {
    render(TooltipAssociation)
    const { trigger, content } = await open('Explicit tooltip', 'Explicit tooltip content')
    expect(content.id).toBe('explicit-tooltip-content')
    await waitFor(() => expectAssociation(trigger, content))
  })

  it('keeps independent roots associated with their own content', async () => {
    render(TooltipAssociation)
    const first = await open('Default tooltip', 'Default tooltip content')
    await waitFor(() => expectAssociation(first.trigger, first.content))
    const firstId = first.content.id
    await fireEvent.blur(first.trigger)
    const second = await open('Explicit tooltip', 'Explicit tooltip content')
    await waitFor(() => expectAssociation(second.trigger, second.content))
    expect(second.content.id).not.toBe(firstId)
    await waitFor(() => expect(first.trigger).not.toHaveAttribute('aria-describedby'))
  })

  it('associates a child-snippet trigger and clears/rebuilds the link on Escape and reopen', async () => {
    render(TooltipAssociation)
    const first = await open('Snippet tooltip', 'Snippet tooltip content')
    await waitFor(() => expectAssociation(first.trigger, first.content))
    const firstId = first.content.id
    await fireEvent.keyDown(first.content, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByText('Snippet tooltip content')).not.toBeInTheDocument())
    expect(first.trigger).not.toHaveAttribute('aria-describedby')
    await fireEvent.blur(first.trigger)
    const reopened = await open('Snippet tooltip', 'Snippet tooltip content')
    await waitFor(() => expectAssociation(reopened.trigger, reopened.content))
    expect(reopened.content.id).toBe(firstId)
  })

  it('clears the ordinary forwarded ref when content is removed', async () => {
    render(TooltipAssociation)
    const { trigger, content } = await open('Default tooltip', 'Default tooltip content')
    await waitFor(() => expectAssociation(trigger, content))
    const id = content.id
    await fireEvent.blur(trigger)
    await waitFor(() => {
      expect(document.getElementById(id)).toBeNull()
      expect(trigger).not.toHaveAttribute('aria-describedby')
      expect(screen.getByTestId('default-content-ref').textContent).toBe('')
    })
  })

  it('preserves force-mounted identity, caller visibility and ref through close/reopen, then cleans up on unmount', async () => {
    render(TooltipAssociation)
    const trigger = screen.getByRole('button', { name: 'Force-mounted tooltip' })
    const content = screen.getByText('Force-mounted tooltip content').closest('[data-slot="tooltip-content"]') as HTMLElement
    const id = content.id
    expect(id).not.toBe('')
    await waitFor(() => expect(screen.getByTestId('forced-content-ref')).toHaveTextContent(id))
    expect(trigger).not.toHaveAttribute('aria-describedby')
    expect(content.style.visibility).toBe('hidden')
    expect(content.style.getPropertyValue('--fixture-marker')).toBe('retained')
    await fireEvent.focus(trigger)
    await waitFor(() => expectAssociation(trigger, content))
    expect(content.style.visibility).toBe('visible')
    await fireEvent.keyDown(content, { key: 'Escape' })
    await waitFor(() => {
      expect(trigger).not.toHaveAttribute('aria-describedby')
      expect(content.style.visibility).toBe('hidden')
    })
    expect(document.getElementById(id)).toBe(content)
    expect(screen.getByTestId('forced-content-ref')).toHaveTextContent(id)
    await fireEvent.blur(trigger)
    await fireEvent.focus(trigger)
    await waitFor(() => expectAssociation(trigger, content))
    expect(document.getElementById(id)).toBe(content)
    expect(content.style.visibility).toBe('visible')
    expect(content.style.getPropertyValue('--fixture-marker')).toBe('retained')
    await fireEvent.click(screen.getByRole('button', { name: 'Unmount force-mounted root' }))
    await waitFor(() => {
      expect(document.getElementById(id)).toBeNull()
      expect(screen.getByTestId('forced-content-ref').textContent).toBe('')
    })
  })
})
