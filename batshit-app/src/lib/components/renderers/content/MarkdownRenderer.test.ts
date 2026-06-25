import { fireEvent, render, screen } from '@testing-library/svelte'
import { marked } from 'marked'
import { describe, expect, it, vi } from 'vitest'

import MarkdownRenderer from './MarkdownRenderer.svelte'

describe('MarkdownRenderer file mentions', () => {
  it('renders sent @file mentions as compact project quick-view links', async () => {
    const listener = vi.fn()
    window.addEventListener('batshit:project-quick-view', listener)

    render(MarkdownRenderer, {
      props: {
        content: '@docs/user-docs/reference/env-vars.md just testing',
        renderFileMentions: true
      }
    })

    const link = screen.getByRole('link', { name: 'env-vars.md' })
    expect(link).toHaveAttribute(
      'href',
      '#batshit-project-file=docs%2Fuser-docs%2Freference%2Fenv-vars.md'
    )
    expect(link).toHaveAttribute('title', 'docs/user-docs/reference/env-vars.md')

    await fireEvent.click(link)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]?.detail).toEqual({
      path: 'docs/user-docs/reference/env-vars.md'
    })

    window.removeEventListener('batshit:project-quick-view', listener)
  })

  it('opens raw local markdown links through project quick view', async () => {
    const listener = vi.fn()
    window.addEventListener('batshit:project-quick-view', listener)

    render(MarkdownRenderer, {
      props: {
        content:
          '[index.md](/Users/example/batshit/docs/user-docs/index.md)'
      }
    })

    const link = screen.getByRole('link', { name: 'index.md' })
    expect(link).toHaveAttribute(
      'href',
      '/Users/example/batshit/docs/user-docs/index.md'
    )

    await fireEvent.click(link)

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]?.detail).toEqual({
      path: '/Users/example/batshit/docs/user-docs/index.md'
    })

    window.removeEventListener('batshit:project-quick-view', listener)
  })

  it('opens raw local markdown links with line numbers through project quick view', async () => {
    const listener = vi.fn()
    window.addEventListener('batshit:project-quick-view', listener)

    render(MarkdownRenderer, {
      props: {
        content:
          '[index.md](/Users/example/batshit/docs/user-docs/index.md:45)'
      }
    })

    await fireEvent.click(screen.getByRole('link', { name: 'index.md' }))

    expect(listener).toHaveBeenCalledTimes(1)
    expect(listener.mock.calls[0]?.[0]?.detail).toEqual({
      path: '/Users/example/batshit/docs/user-docs/index.md',
      lineNumber: 45
    })

    window.removeEventListener('batshit:project-quick-view', listener)
  })

  it('renders fenced code through the shared code renderer without zip chrome', async () => {
    const { container } = render(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```'
      }
    })

    const header = screen.getByRole('button', { name: /Code.*Ts.*1 lines/i })
    expect(header).toHaveAttribute('aria-expanded', 'true')
    expect(container.querySelector('.batshit-zip-wrapper')).toBeNull()
    expect(container.textContent).toContain('const')
    expect(container.textContent).toContain('answer')

    await fireEvent.click(header)

    expect(header).toHaveAttribute('aria-expanded', 'false')
  })

  it('does not mutate the global marked parser singleton', () => {
    render(MarkdownRenderer, {
      props: {
        content: '```ts\nconst local = true\n```'
      }
    })

    const globalHtml = marked.parse('```ts\nconst global = true\n```') as string
    expect(globalHtml).toContain('<pre>')
    expect(globalHtml).not.toContain('CODE_BLOCK')
  })

  it('keeps code block DOM mounted when streamed content length changes', async () => {
    const { rerender } = render(MarkdownRenderer, {
      props: {
        content: '```ts\nconst answer = 42\n```'
      }
    })

    const firstHeader = screen.getByRole('button', { name: /Code.*Ts.*1 lines/i })

    await rerender({
      content: '```ts\nconst answer = 4242\n```'
    })

    expect(screen.getByRole('button', { name: /Code.*Ts.*1 lines/i })).toBe(firstHeader)
  })
})
