import { describe, expect, it } from 'vitest'

import { buildCompactEditPreview, extractManagedPatchFromSources } from '../editDiff'

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
