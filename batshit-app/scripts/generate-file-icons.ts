import { copyFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

const require = createRequire(import.meta.url)
const appRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const materialIconThemeRoot = path.dirname(require.resolve('material-icon-theme/package.json'))
const materialPackage = JSON.parse(
  await readFile(path.join(materialIconThemeRoot, 'package.json'), 'utf8')
) as { version: string; license: string }

const outputDir = path.join(appRoot, 'static', 'file-icons', 'material')
const outputDataPath = path.join(appRoot, 'src', 'lib', 'data', 'file-icons.generated.ts')
const sourceIconDir = path.join(materialIconThemeRoot, 'icons')

type FileIconSpec = {
  id: string
  source: string
  label: string
}

const folderSpecs: FileIconSpec[] = [
  ['folder', 'Folder'],
  ['folder-open', 'Open Folder'],
  ['folder-root', 'Root Folder'],
  ['folder-root-open', 'Open Root Folder'],
  ['folder-src', 'Source Folder'],
  ['folder-src-open', 'Open Source Folder'],
  ['folder-app', 'App Folder'],
  ['folder-app-open', 'Open App Folder'],
  ['folder-components', 'Components Folder'],
  ['folder-components-open', 'Open Components Folder'],
  ['folder-config', 'Config Folder'],
  ['folder-config-open', 'Open Config Folder'],
  ['folder-public', 'Public Folder'],
  ['folder-public-open', 'Open Public Folder'],
  ['folder-images', 'Images Folder'],
  ['folder-images-open', 'Open Images Folder'],
  ['folder-audio', 'Audio Folder'],
  ['folder-audio-open', 'Open Audio Folder'],
  ['folder-video', 'Video Folder'],
  ['folder-video-open', 'Open Video Folder'],
  ['folder-docs', 'Docs Folder'],
  ['folder-docs-open', 'Open Docs Folder'],
  ['folder-test', 'Test Folder'],
  ['folder-test-open', 'Open Test Folder'],
  ['folder-git', 'Git Folder'],
  ['folder-git-open', 'Open Git Folder'],
  ['folder-github', 'GitHub Folder'],
  ['folder-github-open', 'Open GitHub Folder'],
  ['folder-vscode', 'VS Code Folder'],
  ['folder-vscode-open', 'Open VS Code Folder'],
  ['folder-node', 'Node Modules Folder'],
  ['folder-node-open', 'Open Node Modules Folder'],
  ['folder-packages', 'Packages Folder'],
  ['folder-packages-open', 'Open Packages Folder'],
  ['folder-scripts', 'Scripts Folder'],
  ['folder-scripts-open', 'Open Scripts Folder'],
  ['folder-server', 'Server Folder'],
  ['folder-server-open', 'Open Server Folder'],
  ['folder-client', 'Client Folder'],
  ['folder-client-open', 'Open Client Folder'],
  ['folder-api', 'API Folder'],
  ['folder-api-open', 'Open API Folder'],
  ['folder-routes', 'Routes Folder'],
  ['folder-routes-open', 'Open Routes Folder'],
  ['folder-views', 'Views Folder'],
  ['folder-views-open', 'Open Views Folder'],
  ['folder-css', 'CSS Folder'],
  ['folder-css-open', 'Open CSS Folder'],
  ['folder-sass', 'Sass Folder'],
  ['folder-sass-open', 'Open Sass Folder'],
  ['folder-database', 'Database Folder'],
  ['folder-database-open', 'Open Database Folder'],
  ['folder-dist', 'Build Output Folder'],
  ['folder-dist-open', 'Open Build Output Folder'],
  ['folder-tools', 'Tools Folder'],
  ['folder-tools-open', 'Open Tools Folder'],
  ['folder-utils', 'Utilities Folder'],
  ['folder-utils-open', 'Open Utilities Folder'],
  ['folder-lib', 'Library Folder'],
  ['folder-lib-open', 'Open Library Folder'],
  ['folder-private', 'Private Folder'],
  ['folder-private-open', 'Open Private Folder'],
  ['folder-secure', 'Secure Folder'],
  ['folder-secure-open', 'Open Secure Folder'],
  ['folder-admin', 'Admin Folder'],
  ['folder-admin-open', 'Open Admin Folder']
].map(([id, label]) => ({ id, source: id, label }))

const fileSpecs: FileIconSpec[] = [
  ['file', 'Default File'],
  ['document', 'Document'],
  ['typescript', 'TypeScript'],
  ['typescript-def', 'TypeScript Definition'],
  ['javascript', 'JavaScript'],
  ['react', 'React JSX'],
  ['react_ts', 'React TSX'],
  ['svelte', 'Svelte'],
  ['vue', 'Vue'],
  ['html', 'HTML'],
  ['css', 'CSS'],
  ['sass', 'Sass'],
  ['less', 'Less'],
  ['tailwindcss', 'Tailwind CSS'],
  ['python', 'Python'],
  ['jupyter', 'Jupyter Notebook'],
  ['rust', 'Rust'],
  ['go', 'Go'],
  ['go-mod', 'Go Module'],
  ['java', 'Java'],
  ['kotlin', 'Kotlin'],
  ['swift', 'Swift'],
  ['c', 'C'],
  ['cpp', 'C++'],
  ['csharp', 'C#'],
  ['php', 'PHP'],
  ['ruby', 'Ruby'],
  ['lua', 'Lua'],
  ['dart', 'Dart'],
  ['r', 'R'],
  ['json', 'JSON'],
  ['json_schema', 'JSON Schema'],
  ['yaml', 'YAML'],
  ['toml', 'TOML'],
  ['xml', 'XML'],
  ['markdown', 'Markdown'],
  ['mdx', 'MDX'],
  ['log', 'Log'],
  ['readme', 'Readme'],
  ['license', 'License'],
  ['changelog', 'Changelog'],
  ['pdf', 'PDF'],
  ['word', 'Word Document'],
  ['powerpoint', 'PowerPoint'],
  ['table', 'Table Data'],
  ['image', 'Image'],
  ['svg', 'SVG'],
  ['audio', 'Audio'],
  ['video', 'Video'],
  ['zip', 'Archive'],
  ['database', 'Database'],
  ['docker', 'Docker'],
  ['git', 'Git'],
  ['github-actions-workflow', 'GitHub Actions'],
  ['npm', 'npm'],
  ['pnpm', 'pnpm'],
  ['yarn', 'Yarn'],
  ['bun', 'Bun'],
  ['nodejs', 'Node.js'],
  ['deno', 'Deno'],
  ['vite', 'Vite'],
  ['vitest', 'Vitest'],
  ['eslint', 'ESLint'],
  ['prettier', 'Prettier'],
  ['biome', 'Biome'],
  ['storybook', 'Storybook'],
  ['playwright', 'Playwright'],
  ['cypress', 'Cypress'],
  ['jest', 'Jest'],
  ['vercel', 'Vercel'],
  ['netlify', 'Netlify'],
  ['terraform', 'Terraform'],
  ['kubernetes', 'Kubernetes'],
  ['helm', 'Helm'],
  ['nginx', 'nginx'],
  ['graphql', 'GraphQL'],
  ['openapi', 'OpenAPI'],
  ['prisma', 'Prisma'],
  ['drizzle', 'Drizzle'],
  ['supabase', 'Supabase'],
  ['firebase', 'Firebase'],
  ['figma', 'Figma'],
  ['blender', 'Blender'],
  ['mermaid', 'Mermaid'],
  ['excalidraw', 'Excalidraw'],
  ['drawio', 'draw.io'],
  ['settings', 'Settings'],
  ['key', 'Key'],
  ['lock', 'Locked File'],
  ['certificate', 'Certificate'],
  ['console', 'Shell Script'],
  ['powershell', 'PowerShell'],
  ['onnx', 'ONNX'],
  ['pytorch', 'PyTorch']
].map(([id, label]) => ({ id, source: id, label }))

const specs = [...folderSpecs, ...fileSpecs]

function serializeGeneratedFile(specs: FileIconSpec[]) {
  const entries = specs
    .map((spec) => {
      return `  ${JSON.stringify(spec.id)}: { path: ${JSON.stringify(
        `/file-icons/material/${spec.id}.svg`
      )}, label: ${JSON.stringify(spec.label)}, source: ${JSON.stringify(`${spec.source}.svg`)} }`
    })
    .join(',\n')

  return `// Generated by scripts/generate-file-icons.ts. Do not edit manually.
export const FILE_ICON_SOURCE = {
  name: 'Material Icon Theme',
  packageName: 'material-icon-theme',
  version: ${JSON.stringify(materialPackage.version)},
  license: ${JSON.stringify(materialPackage.license)},
  url: 'https://github.com/material-extensions/vscode-material-icon-theme'
} as const

export const FILE_ICON_MAP = {
${entries}
} as const

export type FileIconId = keyof typeof FILE_ICON_MAP
`
}

await rm(outputDir, { recursive: true, force: true })
await mkdir(outputDir, { recursive: true })

for (const spec of specs) {
  await copyFile(path.join(sourceIconDir, `${spec.source}.svg`), path.join(outputDir, `${spec.id}.svg`))
}

await copyFile(
  path.join(materialIconThemeRoot, 'LICENSE'),
  path.join(outputDir, 'LICENSE-MIT-material-icon-theme.txt')
)
await writeFile(outputDataPath, serializeGeneratedFile(specs), 'utf8')

console.log(`Generated ${specs.length} Material Icon Theme file icons.`)
