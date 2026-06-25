import { describe, expect, it } from 'vitest'

import { resolveCliHelperBatshitBaseUrl } from '../cliHelperBaseUrl'

describe('resolveCliHelperBatshitBaseUrl', () => {
  it('targets the app container loopback in Docker', () => {
    expect(
      resolveCliHelperBatshitBaseUrl({
        BATSHIT_CONTAINERIZED: '1',
        PORT: '3000',
        PUBLIC_BASE_URL: 'http://localhost:5613'
      })
    ).toBe('http://127.0.0.1:3000')
  })

  it('allows explicit internal helper overrides', () => {
    expect(
      resolveCliHelperBatshitBaseUrl({
        BATSHIT_CONTAINERIZED: '1',
        BATSHIT_CLI_HELPER_BASE_URL: 'http://app:3000/'
      })
    ).toBe('http://app:3000')
  })

  it('uses native public URLs outside Docker', () => {
    expect(
      resolveCliHelperBatshitBaseUrl({
        PUBLIC_BASE_URL: 'http://localhost:5620/'
      })
    ).toBe('http://localhost:5620')
  })
})
