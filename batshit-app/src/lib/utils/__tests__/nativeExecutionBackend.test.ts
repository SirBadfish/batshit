import { describe, expect, it } from 'vitest'

import { normalizeNativeExecutionBackend } from '../nativeExecutionBackend'

describe('nativeExecutionBackend', () => {
  it('normalizes supported execution backend aliases', () => {
    expect(normalizeNativeExecutionBackend('local')).toBe('local')
    expect(normalizeNativeExecutionBackend('docker')).toBe('docker_sandbox')
    expect(normalizeNativeExecutionBackend('docker-sandbox')).toBe('docker_sandbox')
    expect(normalizeNativeExecutionBackend('sandbox')).toBe('docker_sandbox')
    expect(normalizeNativeExecutionBackend('apple')).toBe('apple_container')
    expect(normalizeNativeExecutionBackend('apple-container')).toBe('apple_container')
    expect(normalizeNativeExecutionBackend('apple container')).toBe('apple_container')
  })

  it('rejects empty, non-string, and unknown backend values', () => {
    expect(normalizeNativeExecutionBackend('')).toBeNull()
    expect(normalizeNativeExecutionBackend('unknown')).toBeNull()
    expect(normalizeNativeExecutionBackend(null)).toBeNull()
  })
})
