import { env } from '$env/dynamic/private'

export type RuntimeMode = 'mac-app' | 'docker' | 'native'
export type LocalVoiceEngineStopPolicy = 'per-engine' | 'all-owned'

// The Pinokio launcher (pinokio/ in the repo) runs Batshit natively, like a source checkout, but
// it owns the secrets and the data folder, so its install is named and managed separately.
export const PINOKIO_RUNTIME_OWNER = 'pinokio'

export type RuntimeContextEnv = Partial<Record<string, string | undefined>>

export type RuntimeContext = {
  mode: RuntimeMode
  label: string
  macApp: boolean
  containerized: boolean
  pinokio: boolean
  localVoiceEngineStopPolicy: LocalVoiceEngineStopPolicy
  runtimeOwner: string | null
  runtimeEnv: string | null
  adminCards: {
    macAppRequiredRuntime: boolean
    appleContainerSandbox: boolean
    dockerSandbox: boolean
  }
}

function normalizedValue(value: string | undefined): string | null {
  const trimmed = value?.trim()
  return trimmed ? trimmed : null
}

export function resolveRuntimeContext(
  runtimeEnv: RuntimeContextEnv = env,
  platform: NodeJS.Platform = process.platform
): RuntimeContext {
  const runtimeOwner = normalizedValue(runtimeEnv.BATSHIT_RUNTIME_OWNER)
  const runtimeEnvName = normalizedValue(runtimeEnv.BATSHIT_RUNTIME_ENV)
  const macApp = runtimeOwner === 'mac-app'
  const containerized =
    !macApp && (runtimeEnv.BATSHIT_CONTAINERIZED === '1' || runtimeEnvName === 'docker')
  const mode: RuntimeMode = macApp ? 'mac-app' : containerized ? 'docker' : 'native'
  const pinokio = mode === 'native' && runtimeOwner === PINOKIO_RUNTIME_OWNER
  // Runtime capability, not a saved preference. The persistence-only launch profile and HOST
  // bind address deliberately do not participate; only the fixed launcher opt-in on Linux does.
  const windowsWsl = pinokio && platform === 'linux' &&
    runtimeEnv.BATSHIT_PINOKIO_HOST === 'windows-wsl' &&
    runtimeEnv.BATSHIT_PINOKIO_ENGINE_STOP_POLICY === 'all-owned'
  const label =
    mode === 'mac-app' ? 'Mac app' : mode === 'docker' ? 'Docker' : windowsWsl ? 'Pinokio (Windows, WSL2)' : pinokio ? 'Pinokio' : 'Source checkout'

  return {
    mode,
    label,
    macApp,
    containerized,
    pinokio,
    localVoiceEngineStopPolicy: windowsWsl ? 'all-owned' : 'per-engine',
    runtimeOwner,
    runtimeEnv: runtimeEnvName,
    adminCards: {
      macAppRequiredRuntime: macApp,
      appleContainerSandbox: macApp,
      dockerSandbox: true
    }
  }
}
