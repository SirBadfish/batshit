import { describe, expect, it } from 'vitest'
import {
  buildRuntimeUrlAliasMap,
  resolveRuntimeAliasHost,
  resolveRuntimeUrlAlias
} from './runtimeUrlAliases'

describe('runtimeUrlAliases', () => {
  it('maps runtime hosts by backend', () => {
    expect(resolveRuntimeAliasHost('local')).toBe('127.0.0.1')
    expect(resolveRuntimeAliasHost('docker_sandbox')).toBe('host.docker.internal')
    expect(resolveRuntimeAliasHost('apple_container')).toBe('127.0.0.1')
  })

  it('builds stable alias map for docker_sandbox backend', () => {
    const map = buildRuntimeUrlAliasMap('docker_sandbox')
    expect(map.comfyui_api_desktop).toBe('http://host.docker.internal:8000')
    expect(map.comfyui_object_info_standalone).toBe(
      'http://host.docker.internal:8188/object_info'
    )
    expect(map.batshit_server_api).toBe('http://host.docker.internal:5600')
  })

  it('resolves alias keys and rejects unknown aliases', () => {
    expect(resolveRuntimeUrlAlias('comfyui_api_desktop', 'local')).toBe(
      'http://127.0.0.1:8000'
    )
    expect(resolveRuntimeUrlAlias('not_a_real_alias', 'local')).toBeNull()
  })
})
