import assert from 'node:assert/strict'
import { promises as fs } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'
import {
  renderGuideNavigationMap,
  validateGuideMarkdownLinks,
  validateGuideNavigationMap,
  validateGuideReferenceIndex
} from './guide-navigation.mjs'

const include = [
  { source: 'chat/overview.md', reference: 'chat-overview.md' },
  { source: 'groups/overview.md', reference: 'groups-overview.md' }
]

test('Guide index and generated map reject a missing route or stale mapping', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-guide-nav-'))
  try {
    const skillPath = path.join(root, 'SKILL.md')
    const mapPath = path.join(root, 'reference-paths.md')
    await fs.writeFile(skillPath, '## Reference Index\n- `chat-overview.md`\n- `groups-overview.md`\n\n## Next\n')
    await fs.writeFile(mapPath, renderGuideNavigationMap(include))
    assert.deepEqual(validateGuideReferenceIndex(await fs.readFile(skillPath, 'utf8'), include), [])
    assert.deepEqual(validateGuideNavigationMap(await fs.readFile(mapPath, 'utf8'), include), [])

    await fs.writeFile(skillPath, '## Reference Index\n- `chat-overview.md`\n\n## Next\n')
    assert.match(validateGuideReferenceIndex(await fs.readFile(skillPath, 'utf8'), include).join('\n'), /missing groups-overview\.md/)

    await fs.writeFile(mapPath, renderGuideNavigationMap(include).replace('references/groups-overview.md', 'references/wrong.md'))
    assert.match(validateGuideNavigationMap(await fs.readFile(mapPath, 'utf8'), include).join('\n'), /out of date/)

    await fs.rm(mapPath)
    assert.match(validateGuideNavigationMap(null, include).join('\n'), /missing or out of date/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})

test('relative UserDocs links resolve through original paths to included flat references', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'batshit-guide-links-'))
  try {
    await fs.mkdir(path.join(root, 'chat'))
    await fs.mkdir(path.join(root, 'groups'))
    await fs.writeFile(path.join(root, 'chat/overview.md'), 'Read [Groups](../groups/overview.md#speakers).\n')
    await fs.writeFile(path.join(root, 'groups/overview.md'), '# Groups\n')
    const readSource = (source) => fs.readFile(path.join(root, source), 'utf8')
    assert.deepEqual(await validateGuideMarkdownLinks(include, readSource), [])

    await fs.writeFile(path.join(root, 'chat/overview.md'), 'Read [Missing](../groups/retired.md).\n')
    assert.match((await validateGuideMarkdownLinks(include, readSource)).join('\n'), /groups\/retired\.md/)
  } finally {
    await fs.rm(root, { recursive: true, force: true })
  }
})
