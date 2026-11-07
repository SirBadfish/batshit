import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const script = fileURLToPath(new URL('./copy-system-skills-to-build.mjs', import.meta.url))

for (const ancestor of ['ordinary-checkout', '.codex/worktrees/checkout']) {
  test(`copies public bundle files beneath ${ancestor} and still excludes hidden descendants (BL-2060)`, () => {
    const temp = mkdtempSync(join(tmpdir(), 'batshit-bundle-copy-'))
    try {
      const repo = join(temp, ancestor), app = join(repo, 'batshit-app')
      const runner = join(app, 'build-scripts', 'copy-system-skills-to-build.mjs')
      const plugins = join(app, 'src/lib/server/system-plugins'), skills = join(plugins, 'batshit/skills'), prompts = join(repo, 'docs/batshit_System_Prompts')
      const outputs = [join(app, 'build/server'), join(app, '.svelte-kit/output/server'), join(app, '.vercel/output/functions/api.func')]
      const put = (path, body) => { mkdirSync(dirname(path), { recursive: true }); writeFileSync(path, body) }
      mkdirSync(dirname(runner), { recursive: true }); cpSync(script, runner)
      put(join(skills, 'guide/SKILL.md'), 'public skill body')
      put(join(skills, 'guide/references/help.md'), 'public reference body')
      put(join(skills, 'guide/.secret'), 'must not ship')
      put(join(skills, '.private/secret.md'), 'must not ship')
      put(join(plugins, 'batshit/plugin.json'), '{"name":"batshit"}')
      put(join(plugins, 'batshit/.claude-plugin/plugin.json'), '{"name":"batshit"}')
      put(join(plugins, 'batshit/.claude-plugin/.env'), 'must not ship')
      put(join(plugins, 'batshit/.claude-plugin/secret.json'), 'must not ship')
      symlinkSync(join(skills, 'guide/SKILL.md'), join(skills, 'guide/linked-secret'))
      put(join(prompts, 'core.md'), 'public prompt body')
      put(join(prompts, '.private/secret.md'), 'must not ship')
      for (const output of outputs) put(join(output, 'system-skills/stale.md'), 'obsolete output')

      execFileSync(process.execPath, [runner], { cwd: repo, stdio: 'pipe' })

      for (const output of outputs) {
        assert.equal(readFileSync(join(output, 'system-plugins/batshit/skills/guide/SKILL.md'), 'utf8'), 'public skill body')
        assert.equal(readFileSync(join(output, 'system-plugins/batshit/skills/guide/references/help.md'), 'utf8'), 'public reference body')
        for (const manifest of ['plugin.json', '.claude-plugin/plugin.json']) {
          assert.equal(readFileSync(join(output, 'system-plugins/batshit', manifest), 'utf8'), '{"name":"batshit"}')
        }
        assert.equal(readFileSync(join(output, 'docs/batshit_System_Prompts/core.md'), 'utf8'), 'public prompt body')
        for (const hidden of ['system-plugins/batshit/skills/guide/.secret', 'system-plugins/batshit/skills/.private', 'system-plugins/batshit/skills/guide/linked-secret', 'system-plugins/batshit/.claude-plugin/.env', 'system-plugins/batshit/.claude-plugin/secret.json', 'docs/batshit_System_Prompts/.private', 'system-skills']) {
          assert.equal(existsSync(join(output, hidden)), false, hidden)
        }
      }
    } finally { rmSync(temp, { recursive: true, force: true }) }
  })
}
