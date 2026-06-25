import { describe, it, expect } from 'vitest'
import {
  buildFileMentionQuickViewHref,
  decorateFileMentionsForMarkdown,
  extractFileMentions,
  filterMentionOptions,
  getActiveMention,
  mapMentionsToFileReferences,
  parseProjectQuickViewHref,
  parseProjectQuickViewHrefTarget,
  validateMentions
} from '../fileMentions'
import type { FlatFileEntry } from '$lib/stores/projects.svelte'

const sampleFiles: FlatFileEntry[] = [
  { name: 'src', path: 'src', type: 'directory', mtime: '2025-12-01T00:00:00Z' },
  { name: 'app.ts', path: 'src/app.ts', type: 'file', size: 120, mtime: '2025-12-01T00:00:00Z' },
  { name: 'logo.png', path: 'assets/logo.png', type: 'file', size: 2048, mtime: '2025-12-02T00:00:00Z' },
  { name: '.env', path: '.env', type: 'file', size: 50, mtime: '2025-12-03T00:00:00Z' }
]

describe('file mention utilities', () => {
  it('extracts @ mentions at start or after whitespace', () => {
    const result = extractFileMentions('Check @src/app.ts and @docs/readme.md')
    expect(result).toHaveLength(2)
    expect(result[0]?.path).toBe('src/app.ts')
    expect(result[1]?.path).toBe('docs/readme.md')
  })

  it('does not treat email-like strings as mentions', () => {
    const result = extractFileMentions('Email me at hello@test.com please')
    expect(result).toHaveLength(0)
  })

  it('finds active mention near caret', () => {
    const text = 'Review @src/app.ts for me'
    const caret = text.indexOf(' for')
    const active = getActiveMention(text, caret)
    expect(active?.query).toBe('src/app.ts')
  })

  it('validates mention statuses', () => {
    const text = '@src/app.ts @assets/logo.png @missing.txt @.env'
    const result = validateMentions(text, sampleFiles, ['.env'])
    expect(result.map((m) => m.status)).toEqual(['valid', 'image', 'missing', 'excluded'])
  })

  it('skips project file map work when text has no mentions', () => {
    const files = [
      {
        name: 'hidden.ts',
        get path() {
          throw new Error('path should not be read without mentions')
        },
        type: 'file'
      } as FlatFileEntry
    ]

    expect(validateMentions('plain text without file refs', files)).toEqual([])
  })

  it('reuses the normalized project file map for the same file index array', () => {
    let pathReads = 0
    const files = [
      {
        name: 'a.ts',
        get path() {
          pathReads += 1
          return 'src/a.ts'
        },
        type: 'file'
      },
      {
        name: 'b.ts',
        get path() {
          pathReads += 1
          return 'src/b.ts'
        },
        type: 'file'
      }
    ] as FlatFileEntry[]

    expect(validateMentions('@src/a.ts', files)[0]?.status).toBe('valid')
    expect(validateMentions('@src/b.ts', files)[0]?.status).toBe('valid')
    expect(pathReads).toBe(2)
  })

  it('filters mention options by query', () => {
    const options = filterMentionOptions('app', sampleFiles)
    expect(options[0]?.path).toBe('src/app.ts')
  })

  it('includes directories in mention options for folder references', () => {
    const options = filterMentionOptions('src', sampleFiles)
    expect(options.some((option) => option.path === 'src' && option.type === 'directory')).toBe(true)
  })

  it('maps folder mentions as directory file references', () => {
    const mentions = validateMentions('@src', sampleFiles, [])
    const refs = mapMentionsToFileReferences(mentions)
    expect(refs[0]?.type).toBe('directory')
  })

  it('decorates sent file mentions as project quick-view links with compact labels', () => {
    const decorated = decorateFileMentionsForMarkdown(
      'Review @docs/user-docs/reference/env-vars.md and @src/app.ts'
    )

    expect(decorated).toContain(
      '[env-vars.md](#batshit-project-file=docs%2Fuser-docs%2Freference%2Fenv-vars.md "docs/user-docs/reference/env-vars.md")'
    )
    expect(decorated).toContain(
      '[app.ts](#batshit-project-file=src%2Fapp.ts "src/app.ts")'
    )
  })

  it('does not decorate emails or normal code spans as file mention links', () => {
    const decorated = decorateFileMentionsForMarkdown(
      'Email hello@test.com, keep `const ref = "@src/app.ts"`, and keep:\n```ts\nconst ref = "@src/app.ts"\n```'
    )

    expect(decorated).not.toContain('#batshit-project-file=')
    expect(decorated).toContain('hello@test.com')
    expect(decorated).toContain('`const ref = "@src/app.ts"`')
  })

  it('decorates legacy backticked sent mentions as project quick-view links', () => {
    const decorated = decorateFileMentionsForMarkdown(
      'Review `@docs/user-docs/reference/env-vars.md` please'
    )

    expect(decorated).toContain(
      '[env-vars.md](#batshit-project-file=docs%2Fuser-docs%2Freference%2Fenv-vars.md "docs/user-docs/reference/env-vars.md")'
    )
  })

  it('normalizes quick-view href paths', () => {
    expect(buildFileMentionQuickViewHref('src\\app.ts')).toBe('#batshit-project-file=src%2Fapp.ts')
  })

  it('parses raw local markdown hrefs for project quick view', () => {
    expect(parseProjectQuickViewHref('/Users/example/batshit/docs/user-docs/index.md')).toBe(
      '/Users/example/batshit/docs/user-docs/index.md'
    )
    expect(parseProjectQuickViewHref('file:///Users/example/batshit/docs/roadmap.md')).toBe(
      '/Users/example/batshit/docs/roadmap.md'
    )
    expect(parseProjectQuickViewHref('docs/user-docs/tools/zips.md')).toBe(
      'docs/user-docs/tools/zips.md'
    )
    expect(parseProjectQuickViewHref('/settings')).toBeNull()
    expect(parseProjectQuickViewHref('https://example.com/readme.md')).toBeNull()
  })

  it('parses local markdown href line suffixes without treating them as file names', () => {
    expect(parseProjectQuickViewHref('/Users/example/batshit/docs/user-docs/index.md:45')).toBe(
      '/Users/example/batshit/docs/user-docs/index.md'
    )
    expect(parseProjectQuickViewHrefTarget('/Users/example/batshit/docs/user-docs/index.md:45:2')).toEqual({
      path: '/Users/example/batshit/docs/user-docs/index.md',
      lineNumber: 45,
      columnNumber: 2
    })
    expect(parseProjectQuickViewHrefTarget('docs/user-docs/tools/zips.md:12')).toEqual({
      path: 'docs/user-docs/tools/zips.md',
      lineNumber: 12
    })
  })
})
