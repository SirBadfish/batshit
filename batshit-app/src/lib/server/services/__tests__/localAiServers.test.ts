import { describe, expect, it } from 'vitest'

import { resolveLocalAiRuntimeBaseUrl } from '../localAiServers'

describe('localAiServers', () => {
  it('rewrites loopback local AI base URLs for server-side Docker callers', () => {
    expect(
      resolveLocalAiRuntimeBaseUrl('http://localhost:11434', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe('http://host.docker.internal:11434/')
  })

  it('leaves loopback local AI base URLs visible outside Docker', () => {
    expect(resolveLocalAiRuntimeBaseUrl('http://localhost:11434', {})).toBe(
      'http://localhost:11434'
    )
  })

  it('leaves explicit sidecar or remote local AI URLs unchanged', () => {
    expect(
      resolveLocalAiRuntimeBaseUrl('http://ollama:11434', {
        BATSHIT_CONTAINERIZED: '1'
      })
    ).toBe('http://ollama:11434')
  })
})
