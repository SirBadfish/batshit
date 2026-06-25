import fs from 'fs/promises'
import { homedir } from 'os'
import path from 'path'
import { env } from '$env/dynamic/private'

export const DOCKER_MCP_PROFILE_ENV_KEY = 'DOCKER_MCP_PROFILE'
export const LEGACY_DOCKER_MCP_PROFILE_ENV_KEY = 'DOCKER_MCP_GATEWAY_PROFILE'
const MANAGED_PROFILE_HEADER = '# Docker MCP Gateway profile selected in Batshit Settings'

const ROOT_ENV_PATH = path.resolve(process.cwd(), '..', '.env')
const ROOT_ENV_BACKUP_PATH = `${ROOT_ENV_PATH}.bak`
const MAC_RUNTIME_ENV_PATH = path.join(
  homedir(),
  'Library',
  'Application Support',
  'Batshit',
  'config',
  'runtime.env'
)
const PROFILE_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/

export function normalizeDockerMcpProfile(value: unknown): string {
  const raw = typeof value === 'string' ? value.trim() : ''
  const normalized = raw || 'default'

  if (!PROFILE_ID_PATTERN.test(normalized)) {
    throw new Error('Invalid Docker MCP profile: use a profile ID with letters, numbers, dots, underscores, or hyphens.')
  }

  return normalized
}

export function getActiveDockerMcpProfile(): string {
  return normalizeDockerMcpProfile(env.DOCKER_MCP_PROFILE || env.DOCKER_MCP_GATEWAY_PROFILE || 'default')
}

const activeProfileEnvPath = () => {
  if (env.BATSHIT_CONTAINERIZED === '1') {
    throw new Error('Docker MCP profile is managed by .env.docker. Update .env.docker and restart containers.')
  }

  if (env.BATSHIT_RUNTIME_OWNER === 'mac-app') {
    const envPath = env.BATSHIT_MAC_RUNTIME_ENV_PATH?.trim() || MAC_RUNTIME_ENV_PATH
    return {
      path: envPath,
      backupPath: `${envPath}.bak`
    }
  }

  return {
    path: ROOT_ENV_PATH,
    backupPath: ROOT_ENV_BACKUP_PATH
  }
}

export async function writeDockerMcpProfileEnv(profile: string) {
  const normalizedProfile = normalizeDockerMcpProfile(profile)
  const target = activeProfileEnvPath()

  let existing = ''
  try {
    existing = await fs.readFile(target.path, 'utf8')
  } catch {
    existing = ''
  }

  const managedKeys = new Set([DOCKER_MCP_PROFILE_ENV_KEY, LEGACY_DOCKER_MCP_PROFILE_ENV_KEY])
  const preserved: string[] = []
  for (const line of existing.split(/\r?\n/)) {
    if (line.trim() === MANAGED_PROFILE_HEADER) continue

    if (!line.trim() || line.trim().startsWith('#')) {
      preserved.push(line)
      continue
    }

    const [key] = line.split('=', 1)
    if (managedKeys.has(key.trim())) continue
    preserved.push(line)
  }

  const managedBlock = `${DOCKER_MCP_PROFILE_ENV_KEY}=${normalizedProfile}`
  const newContent = [MANAGED_PROFILE_HEADER, managedBlock, '', ...preserved].join('\n').trim() + '\n'

  if (existing.trim().length > 0) {
    await fs.writeFile(target.backupPath, existing, 'utf8')
  }

  await fs.mkdir(path.dirname(target.path), { recursive: true })
  await fs.writeFile(target.path, newContent, 'utf8')

  return {
    profile: normalizedProfile,
    path: target.path,
    backupPath: target.backupPath
  }
}
