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

    const header = screen.getByRole('button', { name: /Code.*Ts.*\b1 line\b/i })
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

    const firstHeader = screen.getByRole('button', { name: /Code.*Ts.*\b1 line\b/i })

    await rerender({
      content: '```ts\nconst answer = 4242\n```'
    })

    expect(screen.getByRole('button', { name: /Code.*Ts.*\b1 line\b/i })).toBe(firstHeader)
  })
})

describe('MarkdownRenderer raw tags (BL-812)', () => {
  it('shows a tag that is not HTML, written in prose, as its words', () => {
    for (const [content, shown] of [
      ['The server writes <error> before the text.', 'The server writes <error> before the text.'],
      ['Close it with </error> after.', 'Close it with </error> after.'],
      ['Name the <batshit-memory> tag here.', 'Name the <batshit-memory> tag here.'],
      ['It returns Promise<void> now.', 'It returns Promise<void> now.'],
      ['Use <error class="x">b</error> or <Terminal>.', 'Use <error class="x">b</error> or <Terminal>.']
    ]) {
      const { container, unmount } = render(MarkdownRenderer, { props: { content } })
      expect(container.textContent?.trim()).toBe(shown)
      unmount()
    }
  })

  it('shows a non-HTML tag in a block of raw HTML too', () => {
    const { container } = render(MarkdownRenderer, { props: { content: '<error>\nit broke\n</error>' } })
    expect(container.textContent).toContain('<error>')
    expect(container.textContent).toContain('</error>')
    expect(container.querySelector('error')).toBeNull()
  })

  it('still hides the reasoning tags a thinking model leaves in its text, and keeps their words', () => {
    for (const [content, shown] of [
      ['<think>plan it</think> The answer is 4.', 'plan it The answer is 4.'],
      ['plan it</think> The answer is 4.', 'plan it The answer is 4.'],
      ['<thinking>hmm</thinking> Done. <reasoning>why</reasoning>', 'hmm Done. why']
    ]) {
      const { container, unmount } = render(MarkdownRenderer, { props: { content } })
      expect(container.textContent?.trim()).toBe(shown)
      unmount()
    }
  })

  it('drops inline SVG in prose as before, and shows type names that are plain words', () => {
    const { container, unmount } = render(MarkdownRenderer, { props: { content: 'An icon <svg viewBox="0 0 1 1"><circle r="1"/></svg> here.' } })
    expect(container.textContent?.trim()).toBe('An icon  here.')
    expect(container.querySelector('svg, circle')).toBeNull()
    unmount()
    const words = render(MarkdownRenderer, { props: { content: 'Use List<Set>, Array<Path>, or Map<Text>.' } })
    expect(words.container.textContent?.trim()).toBe('Use List<Set>, Array<Path>, or Map<Text>.')
  })

  it('keeps allowed HTML as HTML and still drops unsafe HTML', () => {
    const { container } = render(MarkdownRenderer, {
      props: {
        content:
          'Keep <strong>bold</strong>. An <img src=x onerror="alert(1)"> and <script>alert(2)</script> and <foo onclick="alert(3)">x</foo>.'
      }
    })
    expect(container.querySelector('strong')?.textContent).toBe('bold')
    expect(container.querySelector('img')).toBeNull()
    expect(container.querySelector('script')).toBeNull()
    expect(container.querySelector('foo')).toBeNull()
    expect(container.querySelector('[onerror], [onclick]')).toBeNull()
    // The made-up tag is words, attributes included; the real ones are not.
    expect(container.textContent).toContain('<foo onclick="alert(3)">x</foo>')
    expect(container.textContent).not.toContain('<strong>')
    expect(container.textContent).not.toContain('alert(2)')
  })
})
