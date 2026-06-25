export type RuntimeExecutionBackend = 'local' | 'docker_sandbox' | 'apple_container'

export const RUNTIME_URL_ALIAS_KEYS = [
  'comfyui_api_desktop',
  'comfyui_api_standalone',
  'comfyui_object_info_desktop',
  'comfyui_object_info_standalone',
  'batshit_server_api',
  'batshit_server_upload_single'
] as const

export type RuntimeUrlAliasKey = (typeof RUNTIME_URL_ALIAS_KEYS)[number]
export type RuntimeUrlAliasMap = Record<RuntimeUrlAliasKey, string>

const RUNTIME_ALIAS_HOST_BY_BACKEND: Record<RuntimeExecutionBackend, string> = {
  local: '127.0.0.1',
  docker_sandbox: 'host.docker.internal',
  apple_container: '127.0.0.1'
}

export function resolveRuntimeAliasHost(backend: RuntimeExecutionBackend): string {
  return RUNTIME_ALIAS_HOST_BY_BACKEND[backend]
}

export function buildRuntimeUrlAliasMap(backend: RuntimeExecutionBackend): RuntimeUrlAliasMap {
  const host = resolveRuntimeAliasHost(backend)
  const base = `http://${host}`

  return {
    comfyui_api_desktop: `${base}:8000`,
    comfyui_api_standalone: `${base}:8188`,
    comfyui_object_info_desktop: `${base}:8000/object_info`,
    comfyui_object_info_standalone: `${base}:8188/object_info`,
    batshit_server_api: `${base}:5600`,
    batshit_server_upload_single: `${base}:5600/api/upload/single`
  }
}

export function isRuntimeUrlAliasKey(value: string): value is RuntimeUrlAliasKey {
  return (RUNTIME_URL_ALIAS_KEYS as readonly string[]).includes(value)
}

export function resolveRuntimeUrlAlias(value: string, backend: RuntimeExecutionBackend): string | null {
  const normalized = value.trim()
  if (!normalized) return null
  if (!isRuntimeUrlAliasKey(normalized)) return null
  return buildRuntimeUrlAliasMap(backend)[normalized]
}
