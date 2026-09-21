import { describe, expect, it } from 'vitest'

import { buildCompactEditPreview, buildSnapshotEditPreview, extractManagedPatchFromSources } from '../editDiff'

describe('editDiff', () => {
	it('extracts managed apply_patch bodies from command text', () => {
		const patch = extractManagedPatchFromSources([
			"apply_patch <<'PATCH'\n*** Begin Patch\n*** Update File: docs/notes.md\n@@\n-old\n+new\n*** End Patch\nPATCH"
		])

		expect(patch).toContain('*** Begin Patch')
		expect(patch).toContain('*** Update File: docs/notes.md')
		expect(patch).toContain('*** End Patch')
	})

	it('builds compact replacement patches from old/new text', () => {
		const preview = buildCompactEditPreview({
			filePath: 'src/demo.ts',
			oldText: 'const value = 1',
			newText: 'const value = 2'
		})

		expect(preview).toContain('*** Begin Patch')
		expect(preview).toContain('*** Update File: src/demo.ts')
		expect(preview).toContain('- const value = 1')
		expect(preview).toContain('+ const value = 2')
	})

	it('builds a compact hunk diff for large snapshot diffs', () => {
		const before = Array.from({ length: 5000 }, (_, index) => `line ${index + 1}`).join('\n')
		const after = `${before}\nfinal line`

		const preview = buildCompactEditPreview({
			filePath: 'src/big.ts',
			before,
			after
		})

		expect(preview).toContain('--- Before')
		expect(preview).toContain('+++ After')
		expect(preview).toContain('... 4,997 unchanged lines omitted ...')
		expect(preview).toContain('+ 5001 | final line')
		expect(preview).not.toContain('Diff omitted to keep the tool result compact')
	})

	it('can suppress fallback summaries when callers only want reconstructable diff text', () => {
		const preview = buildCompactEditPreview({
			filePath: 'src/app.ts',
			allowSummary: false
		})

		expect(preview).toBeUndefined()
	})
})

// Copies of an edit's target read just before and just after the command (`nativeBashExecute`).
describe('buildSnapshotEditPreview', () => {
	const before = '# Notes\n\nFirst line.\nSecond line.\n'
	const after = '# Notes\n\nLast line.\nSecond line.\n'

	it('turns copies that differ into the changed lines', () => {
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before, after })).toBe(
			'--- Before\n+++ After\n    1 | # Notes\n    2 | \n-   3 | First line.\n+   3 | Last line.\n    4 | Second line.\n    5 | '
		)
	})

	// An empty diff was stored for these, which sent the AI view to the raw sidecar (the whole
	// native result, both copies included) and the Edit card to its JSON dump.
	it('says that identical copies mean the command changed nothing', () => {
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before, after: before })).toBe(
			'No changes: the command left notes.md exactly as it was.'
		)
		expect(buildSnapshotEditPreview({ before, after: before })).toBe(
			'No changes: the command left file exactly as it was.'
		)
	})

	it('says when only line endings changed, which a line diff cannot show', () => {
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before: 'a\r\nb\r\n', after: 'a\nb\n' })).toBe(
			'Updated notes.md: only its line endings changed.'
		)
	})

	it('never tells a failed run it changed nothing, and still shows a real change', () => {
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before, after: before, allowSummary: false })).toBeUndefined()
		expect(
			buildSnapshotEditPreview({ filePath: 'notes.md', before: 'a\r\n', after: 'a\n', allowSummary: false })
		).toBeUndefined()
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before, after, allowSummary: false })).toContain(
			'+   3 | Last line.'
		)
	})

	it('needs both copies', () => {
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before })).toBeUndefined()
		expect(buildSnapshotEditPreview({ filePath: 'notes.md', before: null, after })).toBeUndefined()
	})
})
