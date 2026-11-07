// @vitest-environment node
/**
 * SA-139 (Faye S9): P1's effort table agrees with Claude Code's own recorded `initialize` model list
 * (P2's fixture of the pinned version), so a pin bump with new fixtures flags a stale table.
 */
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { expect, it } from 'vitest'
import { readModelCatalog } from '../claudePlanRun'
import { CLAUDE_PLAN_EFFORTS, CLAUDE_PLAN_EFFORT_LIMITS, CLAUDE_PLAN_MODEL_CHOICES, claudePlanEffortsFor } from '$lib/utils/claudePlanConnection'

const events = readFileSync(path.resolve(__dirname, 'fixtures/claude-plan/recorded/words.stdout.jsonl'), 'utf8')
  .split('\n').filter(Boolean).map(line => JSON.parse(line))
const initialize = events.find(event => event.type === 'control_response' && Array.isArray(event.response?.response?.models))
const catalog = readModelCatalog(initialize?.response)

it('offers each model exactly the effort levels Claude Code lists for it (by value, else by the model an alias starts)', () => {
  expect(catalog.length).toBeGreaterThan(5)
  let matched = 0
  for (const { value } of CLAUDE_PLAN_MODEL_CHOICES) {
    const base = value.replace(/\[1m\]$/, '')
    const entry = catalog.find(model => model.value === base) ?? catalog.find(model => model.resolvedModel === base)
    // Not on the list (`best`, `opusplan`): left to Claude Code and the run's own check, so no narrower list may be kept for it.
    if (!entry) { expect(CLAUDE_PLAN_EFFORT_LIMITS[value], value).toBeUndefined(); continue }
    matched += 1
    const listed = entry.supportsEffort ? CLAUDE_PLAN_EFFORTS.filter(level => entry.supportedEffortLevels?.includes(level)) : []
    expect([...claudePlanEffortsFor(value)], value).toEqual(listed)
  }
  expect(matched).toBeGreaterThanOrEqual(10)
  for (const model of Object.keys(CLAUDE_PLAN_EFFORT_LIMITS)) {
    expect(catalog.some(entry => entry.value === model || entry.resolvedModel === model), model).toBe(true)
  }
})
