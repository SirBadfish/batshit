import fs from 'node:fs'
import path from 'node:path'

function parseEnvFile(contents: string) {
  const vars: Record<string, string> = {}

  for (const rawLine of contents.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue

    const normalized = line.startsWith('export ') ? line.slice('export '.length).trim() : line
    const equalsIndex = normalized.indexOf('=')
    if (equalsIndex <= 0) continue

    const key = normalized.slice(0, equalsIndex).trim()
    if (!key) continue

    let value = normalized.slice(equalsIndex + 1).trim()
    const quoted =
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    if (quoted) {
      value = value.slice(1, -1)
    }

    vars[key] = value
  }

  return vars
}

export function loadLocalEnvFiles(options?: { cwd?: string; label?: string }) {
  const cwd = options?.cwd ?? process.cwd()
  const label = options?.label ?? 'env'
  const envFiles = ['.env.local', '.env']
  let loadedAny = false

  for (const filename of envFiles) {
    const fullPath = path.resolve(cwd, filename)
    if (!fs.existsSync(fullPath)) continue

    try {
      const vars = parseEnvFile(fs.readFileSync(fullPath, 'utf8'))
      for (const [key, value] of Object.entries(vars)) {
        if (process.env[key] === undefined) {
          process.env[key] = value
        }
      }
      loadedAny = true
    } catch (error) {
      console.warn(`[${label}] Failed to load ${filename}:`, error)
    }
  }

  if (loadedAny) {
    console.log(`[${label}] Loaded local env file(s) for sync run`)
  }
}
