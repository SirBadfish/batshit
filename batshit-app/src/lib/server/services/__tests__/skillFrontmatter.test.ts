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
