import os from 'node:os'
import path from 'node:path'

const MANAGED_INSTALLS_ROOT_ENV_VAR = 'BATSHIT_MANAGED_INSTALLS_ROOT'
const MANAGED_INSTALLS_ROOT_FALLBACK_SEGMENTS_BASE64 = 'WyIuYmF0c2hpdCIsImluc3RhbGxzIl0='
const VOICE_RUNTIME_STATE_ROOT_ENV_VAR = 'BATSHIT_VOICE_RUNTIME_STATE_ROOT'
const VOICE_RUNTIME_STATE_ROOT_FALLBACK_SEGMENTS_BASE64 =
  'WyIuYmF0c2hpdCIsInJ1bnRpbWUiLCJ2b2ljZS1lbmdpbmVzIl0='
const DEFAULT_RUNTIME_LOG_RELATIVE_PATH = path.join('logs', 'local-engine-runtime.log')
const DEFAULT_STATE_FILE_NAME = '.batshit-local-engine-setup.json'
const LAUNCH_RECORD_FILE_NAME = '.batshit-local-runtime-launch.json'

function expandUserHomePath(targetPath: string): string {
  if (targetPath === '~') {
    return os.homedir()
  }

  if (targetPath.startsWith('~/')) {
    return path.join(os.homedir(), targetPath.slice(2))
  }

  return targetPath
}

export function resolveManagedInstallsRoot(): string {
  const configured = process.env[MANAGED_INSTALLS_ROOT_ENV_VAR]
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(expandUserHomePath(configured.trim()))
  }

  // Keep the fallback runtime-only so deploy tracing does not eagerly crawl the whole local installs tree.
  const [hiddenDir, installsDir] = JSON.parse(
    Buffer.from(MANAGED_INSTALLS_ROOT_FALLBACK_SEGMENTS_BASE64, 'base64').toString('utf8')
  ) as [string, string]
  return path.resolve(os.homedir(), hiddenDir, installsDir)
}

function resolveVoiceRuntimeStateRoot(): string {
  const configured = process.env[VOICE_RUNTIME_STATE_ROOT_ENV_VAR]
  if (typeof configured === 'string' && configured.trim().length > 0) {
    return path.resolve(expandUserHomePath(configured.trim()))
  }

  const segments = JSON.parse(
    Buffer.from(VOICE_RUNTIME_STATE_ROOT_FALLBACK_SEGMENTS_BASE64, 'base64').toString('utf8')
  ) as string[]

  return path.resolve(os.homedir(), ...segments)
}

export function resolveLocalVoiceRuntimeStateDir(engineId: string): string {
  return path.join(resolveVoiceRuntimeStateRoot(), engineId)
}

export function resolveLocalVoiceRuntimeLogPath(engineId: string): string {
  return path.join(resolveLocalVoiceRuntimeStateDir(engineId), DEFAULT_RUNTIME_LOG_RELATIVE_PATH)
}

export function resolveLocalVoiceRuntimeStatePath(engineId: string): string {
  return path.join(resolveLocalVoiceRuntimeStateDir(engineId), DEFAULT_STATE_FILE_NAME)
}

export function resolveLocalVoiceRuntimeLaunchRecordPath(engineId: string): string {
  return path.join(resolveLocalVoiceRuntimeStateDir(engineId), LAUNCH_RECORD_FILE_NAME)
}
