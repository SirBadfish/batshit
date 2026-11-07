import { describe, expect, it } from 'vitest'

import { resolveDockerComposeWorkingDirectory } from '../cliExecutableResolution'

describe('resolveDockerComposeWorkingDirectory', () => {
  it('uses the explicit Docker project folder before the workspace mount', () => {
    expect(
      resolveDockerComposeWorkingDirectory({
        BATSHIT_DOCKER_PROJECT_DIR: 'C:\\dev\\batshit',
        BATSHIT_WORKSPACE_MOUNT: 'D:\\workspace'
      })
    ).toBe('C:\\dev\\batshit')
  })

  it('falls back to the workspace mount and unwraps quoted env values', () => {
    expect(
      resolveDockerComposeWorkingDirectory({
        BATSHIT_WORKSPACE_MOUNT: '"C:\\dev\\batshit"'
      })
    ).toBe('C:\\dev\\batshit')
  })
})
