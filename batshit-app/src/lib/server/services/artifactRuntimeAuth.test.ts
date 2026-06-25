import { describe, expect, it } from 'vitest'

import {
  artifactRuntimeCorsHeaders,
  isArtifactRuntimeCorsPath
} from './artifactRuntimeAuth'

describe('artifact runtime CORS policy', () => {
  it('includes nested ComfyUI proxy paths for sandboxed artifact requests', () => {
    expect(isArtifactRuntimeCorsPath('/api/artifacts/comfyui/prompt')).toBe(true)
    expect(isArtifactRuntimeCorsPath('/api/artifacts/comfyui/history/abc123')).toBe(true)
    expect(isArtifactRuntimeCorsPath('/api/artifacts/comfyui')).toBe(true)
  })

  it('includes artifact run event logging for sandboxed artifact requests', () => {
    expect(isArtifactRuntimeCorsPath('/api/artifacts/run-event')).toBe(true)
  })

  it('allows runtime token headers for opaque artifact iframe preflights', () => {
    const headers = new Headers(artifactRuntimeCorsHeaders())

    expect(headers.get('Access-Control-Allow-Origin')).toBe('null')
    expect(headers.get('Access-Control-Allow-Methods')).toContain('OPTIONS')
    expect(headers.get('Access-Control-Allow-Headers')).toContain('authorization')
    expect(headers.get('Access-Control-Allow-Headers')).toContain('content-type')
  })
})
