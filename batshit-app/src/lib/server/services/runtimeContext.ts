import { env } from '$env/dynamic/private'

export type RuntimeMode = 'mac-app' | 'docker' | 'native'

export type RuntimeContextEnv = Partial<Record<string, string | undefined>>

export type RuntimeContext = {
  mode: RuntimeMode
  label: string
  macApp: boolean
  containerized: boolean
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

export function resolveRuntimeContext(runtimeEnv: RuntimeContextEnv = env): RuntimeContext {
  const runtimeOwner = normalizedValue(runtimeEnv.BATSHIT_RUNTIME_OWNER)
  const runtimeEnvName = normalizedValue(runtimeEnv.BATSHIT_RUNTIME_ENV)
  const macApp = runtimeOwner === 'mac-app'
  const containerized =
    !macApp && (runtimeEnv.BATSHIT_CONTAINERIZED === '1' || runtimeEnvName === 'docker')
  const mode: RuntimeMode = macApp ? 'mac-app' : containerized ? 'docker' : 'native'
  const label =
    mode === 'mac-app' ? 'Mac app' : mode === 'docker' ? 'Docker' : 'Source checkout'

  return {
    mode,
    label,
    macApp,
    containerized,
    runtimeOwner,
    runtimeEnv: runtimeEnvName,
    adminCards: {
      macAppRequiredRuntime: macApp,
      appleContainerSandbox: macApp,
      dockerSandbox: true
    }
  }
}
