import { describe, expect, it } from 'vitest'

import {
  normalizeAllowedTools,
  splitFrontmatter
} from '../skillFrontmatter'

describe('skillFrontmatter', () => {
  it('splits frontmatter and preserves the markdown body', () => {
    const parsed = splitFrontmatter(`---
name: agent-browser
has_scripts: true
metadata:
  author: Batshit
---
# Agent Browser

Use this skill.
`)

    expect(parsed.frontmatter).toMatchObject({
      name: 'agent-browser',
      has_scripts: true,
      metadata: { author: 'Batshit' }
    })
    expect(parsed.body).toBe('# Agent Browser\n\nUse this skill.\n')
  })

  it('preserves quoted allowed-tools tokens exactly once normalized', () => {
    expect(
      normalizeAllowedTools('"Bash(npx agent-browser:*)" Bash(agent-browser:*) "Bash(npx agent-browser:*)"')
    ).toEqual(['"Bash(npx agent-browser:*)"', 'Bash(agent-browser:*)'])
  })

  it('keeps spaces inside Bash(...) allowed-tools entries', () => {
    expect(
      normalizeAllowedTools('Bash(npx agent-browser:*), Bash(agent-browser:*)')
    ).toEqual(['Bash(npx agent-browser:*)', 'Bash(agent-browser:*)'])
  })
})

// BL-469: `description: >` and `description: |` are YAML block scalars. The text is on the
// indented lines below the key, and a colon inside those lines is text, not a new key.
describe('skillFrontmatter block scalars (BL-469)', () => {
  it('reads a folded description whose lines hold colons, and makes no keys from them', () => {
    const parsed = splitFrontmatter(`---
name: typesafe-system-one
description: >
  TypeSafe AI's System One models (flagship: Jev): a non-generative model
  that answers typed questions (Choice, Score, Noul yes/no) about any text.
  Use it whenever someone wants a router: or a verifier.
license: MIT
---
# TypeSafe
`)

    expect(parsed.frontmatter).toEqual({
      name: 'typesafe-system-one',
      description:
        "TypeSafe AI's System One models (flagship: Jev): a non-generative model that answers typed questions (Choice, Score, Noul yes/no) about any text. Use it whenever someone wants a router: or a verifier.\n",
      license: 'MIT'
    })
    expect(parsed.body).toBe('# TypeSafe\n')
  })

  it('keeps the line breaks of a literal description', () => {
    const parsed = splitFrontmatter(`---
description: |
  Line one: keep
  Line two

  After a blank line
compatibility: Requires git
---
`)

    expect(parsed.frontmatter).toEqual({
      description: 'Line one: keep\nLine two\n\nAfter a blank line\n',
      compatibility: 'Requires git'
    })
  })

  it('applies the strip, clip and keep endings', () => {
    const parsed = splitFrontmatter(`---
strip_folded: >-
  one
  two

clip_literal: |
  one

keep_literal: |+
  one


strip_literal: |-
  one
  two
done: true
---
`)

    expect(parsed.frontmatter).toEqual({
      strip_folded: 'one two',
      clip_literal: 'one\n',
      keep_literal: 'one\n\n\n',
      strip_literal: 'one\ntwo',
      done: true
    })
  })

  it('folds paragraphs and keeps more-indented lines as they are', () => {
    const parsed = splitFrontmatter(`---
description: >
  first line
  same paragraph

  second paragraph
    indented example
  back to text
---
`)

    expect(parsed.frontmatter.description).toBe(
      'first line same paragraph\nsecond paragraph\n  indented example\nback to text\n'
    )
  })

  it('honors an indentation indicator, either order of the indicators, and a header comment', () => {
    const parsed = splitFrontmatter(`---
literal_indent: |2
    two spaces kept
  normal line
folded_strip_indent: >-2
  one
  two
indent_then_strip: |2-
  kept
commented: > # a note about the text
  folded
  text
---
`)

    expect(parsed.frontmatter).toEqual({
      literal_indent: '  two spaces kept\nnormal line\n',
      folded_strip_indent: 'one two',
      indent_then_strip: 'kept',
      commented: 'folded text\n'
    })
  })

  it('reads lines that start with # inside a block as text', () => {
    const parsed = splitFrontmatter(`---
description: |
  # not a comment
  text
# a real comment
name: probe
---
`)

    expect(parsed.frontmatter).toEqual({
      description: '# not a comment\ntext\n',
      name: 'probe'
    })
  })

  it('ends a block at a comment indented less than its text', () => {
    const parsed = splitFrontmatter(`---
description: |+
    deep text
  # a comment after the text

name: probe
---
`)

    expect(parsed.frontmatter).toEqual({ description: 'deep text\n', name: 'probe' })
  })

  it('gives an empty string for a block with no lines', () => {
    const parsed = splitFrontmatter(`---
description: >
name: probe
---
`)

    expect(parsed.frontmatter).toEqual({ description: '', name: 'probe' })
  })

  it('reads Windows line endings', () => {
    const parsed = splitFrontmatter(
      '---\r\nname: probe\r\ndescription: >\r\n  first: part\r\n  second part\r\nlicense: MIT\r\n---\r\n# Probe\r\n'
    )

    expect(parsed.frontmatter).toEqual({
      name: 'probe',
      description: 'first: part second part\n',
      license: 'MIT'
    })
  })

  it('reads a frontmatter whose lines are all indented, with a block first', () => {
    const parsed = splitFrontmatter(`---
  description: >
    text here
  license: MIT
  literal: |2
      two spaces kept
---
`)

    expect(parsed.frontmatter).toEqual({
      description: 'text here\n',
      license: 'MIT',
      literal: '  two spaces kept\n'
    })
  })

  it('ends a nested map at a sibling key in a frontmatter whose lines are all indented', () => {
    const parsed = splitFrontmatter(`---
  metadata:
    author: Batshit
  name: probe
  empty:
  license: MIT
---
`)

    expect(parsed.frontmatter).toEqual({
      metadata: { author: 'Batshit' },
      name: 'probe',
      empty: {},
      license: 'MIT'
    })
  })

  it('keeps the trailing empty lines of a keep block that ends the frontmatter', () => {
    const parsed = splitFrontmatter('---\nname: probe\nnotes: |+\n  one\n\n\n---\n# Probe\n')

    expect(parsed.frontmatter).toEqual({ name: 'probe', notes: 'one\n\n\n' })
    expect(parsed.body).toBe('# Probe\n')
  })

  // Not YAML: YAML rejects this input. The reader keeps the line as text so it never becomes a key.
  it('keeps a less indented block line inside the block instead of making a key of it', () => {
    const parsed = splitFrontmatter(`---
description: >
    deep first line
  shallower: line with a colon
license: MIT
---
`)

    expect(parsed.frontmatter).toEqual({
      description: 'deep first line shallower: line with a colon\n',
      license: 'MIT'
    })
  })

  it('leaves plain values that only start with > or | as plain values', () => {
    const parsed = splitFrontmatter(`---
compatibility: >=1.0
pipe: |x
quoted: "> not a block"
---
`)

    expect(parsed.frontmatter).toEqual({
      compatibility: '>=1.0',
      pipe: '|x',
      quoted: '> not a block'
    })
  })

  it('still reads a nested map after a block description', () => {
    const parsed = splitFrontmatter(`---
description: >
  A folded description: with a colon.
metadata:
  author: Batshit
  version: 2
allowed-tools: Bash(git:*) Read
---
`)

    expect(parsed.frontmatter).toEqual({
      description: 'A folded description: with a colon.\n',
      metadata: { author: 'Batshit', version: '2' },
      'allowed-tools': 'Bash(git:*) Read'
    })
  })
})

// BL-1240: a caller with its own value rules still gets the shared line and block reading.
describe('splitFrontmatter with a caller value reader (BL-1240)', () => {
  const markdown = `---
hint: [file-path]
flag: true
description: >
  Folded text: with a colon.
metadata:
  author: Batshit
---
`

  it('uses the caller reader for top-level values only', () => {
    const seen: string[] = []
    const parsed = splitFrontmatter(markdown, (value) => {
      seen.push(value)
      return `read:${value.trim()}`
    })

    expect(seen).toEqual(['[file-path]', 'true'])
    expect(parsed.frontmatter).toEqual({
      hint: 'read:[file-path]',
      flag: 'read:true',
      description: 'Folded text: with a colon.\n',
      metadata: { author: 'Batshit' }
    })
  })

  it('keeps the default value rules without a reader', () => {
    expect(splitFrontmatter(markdown).frontmatter).toMatchObject({ hint: ['file-path'], flag: true })
  })
})

describe('continued frontmatter values and nested blocks (BL-1239)', () => {
  it('folds plain continuation lines without inventing keys from colons', () => {
    expect(splitFrontmatter(`---
name: probe
description: Some long text that
  continues here: with a colon
    and more indentation
license: MIT
---
# Body
`).frontmatter).toEqual({
      name: 'probe',
      description: 'Some long text that continues here: with a colon and more indentation',
      license: 'MIT'
    })
  })

  it.each(['"', "'"])('folds %s quoted continuations and keeps # and colons as text', (quote) => {
    const parsed = splitFrontmatter(`---
description: ${quote}Some long text
  # still quoted: text
  ends here${quote}
license: MIT
---
`)
    expect(parsed.frontmatter).toEqual({
      description: 'Some long text # still quoted: text ends here',
      license: 'MIT'
    })
  })

  it.each(['', '"', "'"])('keeps paragraph breaks in %s continued text', (quote) => {
    expect(splitFrontmatter(`---
description: ${quote}First paragraph
  continued

  Second paragraph


  Third paragraph${quote}

license: MIT
---
`).frontmatter).toEqual({
      description: 'First paragraph continued\nSecond paragraph\n\nThird paragraph',
      license: 'MIT'
    })
  })

  it('ends plain text at a comment and a closed quote before deeper lines', () => {
    expect(splitFrontmatter(`---
description: first
  continuation
  # end of the scalar
license: MIT
quoted: "already complete"
  sibling: preserved
---
`).frontmatter).toEqual({
      description: 'first continuation',
      license: 'MIT',
      quoted: 'already complete',
      sibling: 'preserved'
    })
  })

  it('uses the completed text with the caller reader and preserves existing value types', () => {
    const seen: string[] = []
    const parsed = splitFrontmatter(`---
description: "long
  description"
argument-hint: [file-path]
metadata:
  author: Batshit
---
`, (value) => {
      seen.push(value)
      return value
    })
    expect(seen).toEqual(['"long description"', '[file-path]'])
    expect(parsed.frontmatter.metadata).toEqual({ author: 'Batshit' })
    expect(splitFrontmatter('---\nflag: true\nlist: [Read, Bash]\nobject: {"a":"b"}\n---\n').frontmatter)
      .toEqual({ flag: true, list: ['Read', 'Bash'], object: { a: 'b' } })
  })

  it('folds against each key indentation in CRLF and uniformly indented frontmatter', () => {
    const parsed = splitFrontmatter('---\r\n  description: "first\r\n    second"\r\n  metadata:\r\n    summary: first\r\n      second\r\n    author: Batshit\r\n  license: MIT\r\n---\r\n# Body\r\n')
    expect(parsed.frontmatter).toEqual({
      description: 'first second',
      metadata: { summary: 'first second', author: 'Batshit' },
      license: 'MIT'
    })
    expect(parsed.body).toBe('# Body\r\n')
  })

  it('reuses literal and folded block reading in a one-level nested map', () => {
    expect(splitFrontmatter(`---
metadata:
  notes: |-
    first: text
    # literal text

    second paragraph
  summary: >-2 # fold these lines
    first
    second: text
  author: Batshit
description: outside
---
`).frontmatter).toEqual({
      metadata: {
        notes: 'first: text\n# literal text\n\nsecond paragraph',
        summary: 'first second: text',
        author: 'Batshit'
      },
      description: 'outside'
    })
  })

  it('reads quoted continuations in nested metadata without changing its string shape', () => {
    expect(splitFrontmatter(`---
metadata:
  notes: 'first
    second: text'
  enabled: true
  tools: [Read, Bash]
  empty:
name: probe
---
`).frontmatter).toEqual({
      metadata: { notes: 'first second: text', enabled: 'true', tools: 'Read,Bash', empty: '' },
      name: 'probe'
    })
  })

  it('preserves nested clip/keep endings and explicit content indentation', () => {
    expect(splitFrontmatter(`---
metadata:
  clipped: |
    one
  kept: |+
    one


  indented: |2-
      two spaces kept
    normal
  author: Batshit
---
`).frontmatter).toEqual({
      metadata: {
        clipped: 'one\n', kept: 'one\n\n\n', indented: '  two spaces kept\nnormal', author: 'Batshit'
      }
    })
  })

  it.each([
    ['"', 'with \\"escaped\\" text'],
    ["'", "don''t stop"]
  ])('keeps folding past escaped %s quotes on a continuation line', (quote, middle) => {
    expect(splitFrontmatter(`---
description: ${quote}first
  ${middle}
  final: segment${quote}
license: MIT
---
`).frontmatter).toEqual({
      description: `first ${middle} final: segment`,
      license: 'MIT'
    })
  })
})
