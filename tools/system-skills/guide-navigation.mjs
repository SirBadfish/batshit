import path from 'node:path'

export const GUIDE_NAVIGATION_FILE = 'reference-paths.md'

export function renderGuideNavigationMap(include) {
  const rows = include
    .map(({ source, reference }) => `| \`${source}\` | \`references/${reference}\` |`)
    .sort()

  return [
    '# Batshit Guide reference paths',
    '',
    'Generated from `tools/system-skills/userdocs-skill-references.manifest.json`. Read this map when a UserDocs page links to another page: find the current flat reference in the right column, resolve the link relative to its original path in the left column, then find that target path in the left column and read its flat reference. Keep any `#section` anchor for locating the section inside the target page.',
    '',
    '| Original UserDocs path | Skill read path |',
    '| --- | --- |',
    ...rows,
    ''
  ].join('\n')
}

export function validateGuideNavigationMap(currentMap, include) {
  return currentMap === renderGuideNavigationMap(include)
    ? []
    : ['generated Guide navigation map is missing or out of date']
}

export function validateGuideReferenceIndex(skillMarkdown, include) {
  const index = skillMarkdown.match(/^## Reference Index\s*\n([\s\S]*?)(?=^## |$(?![\s\S]))/m)?.[1]
  if (!index) return ['Batshit Guide SKILL.md has no Reference Index section']

  const named = new Set([...index.matchAll(/`([\w-]+\.md)`/g)].map((match) => match[1]))
  const expected = new Set(include.map(({ reference }) => reference))
  const problems = []
  for (const reference of expected) {
    if (!named.has(reference)) problems.push(`Guide Reference Index is missing ${reference}`)
  }
  for (const reference of named) {
    if (reference !== GUIDE_NAVIGATION_FILE && !expected.has(reference)) {
      problems.push(`Guide Reference Index names unlisted reference ${reference}`)
    }
  }
  return problems
}

export async function validateGuideMarkdownLinks(include, readSource) {
  const mapped = new Set(include.map(({ source }) => source))
  const problems = []

  for (const { source } of include) {
    const markdown = await readSource(source)
    for (const match of markdown.matchAll(/\]\(([^)]+)\)/g)) {
      const href = match[1].trim().split(/\s+"/)[0]
      const page = href.split(/[?#]/, 1)[0]
      if (!page.endsWith('.md') || /^(?:[a-z][a-z\d+.-]*:|\/)/i.test(page)) continue
      const target = path.posix.normalize(path.posix.join(path.posix.dirname(source), page))
      if (!mapped.has(target)) {
        problems.push(`${source} links to unmapped UserDocs page ${target}`)
      }
    }
  }
  return problems
}
