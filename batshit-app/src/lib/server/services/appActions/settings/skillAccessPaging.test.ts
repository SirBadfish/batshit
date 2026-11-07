import { describe, expect, it } from 'vitest'
import { createSkillAccessPages } from './skillAccessPaging'
import type { SkillAccessRead } from './skillAccessReport'
import type { SettingsSubjectManifest } from './subjects'

const subject = { kind: 'primary' as const, id: 'a' }
const manifest = { ownerUserId: 'owner', digest: 'a'.repeat(64), entries: [{ subject, type: 'api', status: 'available', label: 'A' }], excluded: [] } as unknown as SettingsSubjectManifest
function read(aliasCount: number): SkillAccessRead {
  const aliases = Array.from({ length: aliasCount }, (_, index) => ({ commandId: `alias_${index}`, active: true, invocable: true, enabled: true, source: 'list' as const }))
  return { handle: { kind: 'skill-access-report' } as SkillAccessRead['handle'], choices: [{ skillId: 'one_skill', label: 'One Skill', available: true, aliases: aliases.map(alias => alias.commandId) }],
    rows: [{ skillId: 'one_skill', subject, effective: true, aliases }] }
}
describe('bounded immutable skill-access projection pages', () => {
  it('keeps compact summary/choices even for a complete many-alias skill', () => {
    for (const detail of ['summary', 'choices'] as const) {
      const first = createSkillAccessPages(read(256), manifest, detail).page()
      expect(Buffer.byteLength(JSON.stringify(first))).toBeLessThan(8192)
      expect(first.continuation).toMatchObject({ totalRows: 1, returned: 1, remaining: 0, nextCursor: null })
      expect(first.rows[0]).toMatchObject(detail === 'summary' ? { skillId: 'one_skill', subjects: { enabled: 1, disabled: 0, unavailable: 0 } } : { skillId: 'one_skill', aliasCount: 256 })
    }
  })
  it('pages every alias with explicit counts rather than silently truncating one oversized value row', () => {
    const pages = createSkillAccessPages(read(256), manifest, 'values')
    const first = pages.page()
    const all: any[] = [...first.rows]
    let cursor = first.continuation.nextCursor
    while (cursor) { const next = pages.page(cursor); all.push(...next.rows); cursor = next.continuation.nextCursor }
    expect(all).toHaveLength(256)
    expect(new Set(all.flatMap(row => row.aliases.map((alias: any) => alias.commandId))).size).toBe(256)
    expect(all[255].aliasPage).toEqual({ index: 255, returned: 1, total: 256 })
    expect(() => { (first.rows[0] as any).effective = false }).toThrow()
    expect(pages.page()).toEqual(first)
    expect(() => pages.page(`sr1:${'b'.repeat(64)}:64`)).toThrow('held report')
  })
})
