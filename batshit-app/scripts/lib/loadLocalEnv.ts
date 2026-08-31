import fs from 'node:fs'
import path from 'node:path'
import { parse as parseDotenv } from 'dotenv'

export function loadLocalEnvFiles(options?: { cwd?: string; label?: string }) {
  const cwd = options?.cwd ?? process.cwd()
  const label = options?.label ?? 'env'
  const envFiles = ['.env.local', '.env']
  let loadedAny = false

  for (const filename of envFiles) {
    const fullPath = path.resolve(cwd, filename)
    if (!fs.existsSync(fullPath)) continue

    try {
      const vars = parseDotenv(fs.readFileSync(fullPath, 'utf8'))
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
