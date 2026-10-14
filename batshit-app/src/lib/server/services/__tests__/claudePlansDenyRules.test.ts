import { afterEach, describe, expect, it, vi } from 'vitest'

/**
 * BL-270 — the deny rules that keep a managed Claude run out of the user's own plans folder,
 * for `~/.claude` and a `CLAUDE_CONFIG_DIR`. `--disallowedTools` is one comma- or
 * space-separated list, so a space or comma in a path must not split a rule.
 */
vi.mock('node:os', async (importOriginal) => {
  const real = await importOriginal<typeof import('node:os')>()
  const homedir = () => '/Users/zccli-home'
  return { ...real, homedir, default: { ...real, homedir } }
})
vi.mock('$env/dynamic/private', () => ({ env: {} }))
vi.mock('$lib/server/redis', () => ({ redis: {} }))

const ORIGINAL = {
  HOME: process.env.HOME,
  CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR,
  BATSHIT_CLAUDE_RUN_AS_HOME: process.env.BATSHIT_CLAUDE_RUN_AS_HOME
}

afterEach(() => {
  for (const [key, value] of Object.entries(ORIGINAL)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
})

describe('BL-270: the plans-folder deny rules', () => {
  it("names the user's own ~/.claude/plans as an absolute Edit rule", async () => {
    process.env.HOME = '/Users/zccli-home'
    delete process.env.CLAUDE_CONFIG_DIR
    delete process.env.BATSHIT_CLAUDE_RUN_AS_HOME
    const { buildUsersClaudePlansDenyRules } = await import('../claudeProfileManager')
    expect(buildUsersClaudePlansDenyRules()).toEqual(['Edit(//Users/zccli-home/.claude/plans/**)'])
  })

  it('adds a CLAUDE_CONFIG_DIR, and a space or comma never splits the rule', async () => {
    process.env.HOME = '/Users/zccli-home'
    process.env.CLAUDE_CONFIG_DIR = '/Users/zccli-home/Claude Config, Work'
    delete process.env.BATSHIT_CLAUDE_RUN_AS_HOME
    const { buildUsersClaudePlansDenyRules } = await import('../claudeProfileManager')
    const rules = buildUsersClaudePlansDenyRules()
    expect(rules).toEqual([
      'Edit(//Users/zccli-home/.claude/plans/**)',
      'Edit(//Users/zccli-home/Claude?Config??Work/plans/**)'
    ])
    for (const rule of rules) expect(rule).not.toMatch(/[ ,]/)
  })

  // Review of BL-270: Docker runs Claude Code as its own user, whose HOME the child gets
  // (BATSHIT_CLAUDE_RUN_AS_HOME, compose.yaml), so its plans land in that home.
  it("also names the Docker Claude user's own plans folder", async () => {
    process.env.HOME = '/root'
    delete process.env.CLAUDE_CONFIG_DIR
    process.env.BATSHIT_CLAUDE_RUN_AS_HOME = '/home/batshit-cli'
    const { buildUsersClaudePlansDenyRules } = await import('../claudeProfileManager')
    expect(buildUsersClaudePlansDenyRules()).toEqual([
      'Edit(//root/.claude/plans/**)',
      'Edit(//home/batshit-cli/.claude/plans/**)'
    ])
  })
})
