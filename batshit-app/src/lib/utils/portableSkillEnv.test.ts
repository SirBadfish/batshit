import { describe, expect, it } from 'vitest'
import { buildPortableSkillEnvLines, portableSkillBaseUrl } from './portableSkillEnv'

// BL-341: a Portable Skill's env lines name the Batshit the user is on, never a fixed port.
describe('portableSkillBaseUrl', () => {
  it('keeps each lane its own port', () => {
    expect(portableSkillBaseUrl('http://127.0.0.1:5620')).toBe('http://127.0.0.1:5620')
    expect(portableSkillBaseUrl('http://127.0.0.1:5621')).toBe('http://127.0.0.1:5621')
    expect(portableSkillBaseUrl('http://127.0.0.1:5650/')).toBe('http://127.0.0.1:5650')
  })

  it('writes localhost as 127.0.0.1, and only the host named localhost', () => {
    expect(portableSkillBaseUrl('http://localhost:5621')).toBe('http://127.0.0.1:5621')
    expect(portableSkillBaseUrl('http://localhost')).toBe('http://127.0.0.1')
    expect(portableSkillBaseUrl('http://localhost.example.com:5620')).toBe('http://localhost.example.com:5620')
    expect(portableSkillBaseUrl('http://192.168.1.85:5620')).toBe('http://192.168.1.85:5620')
    expect(portableSkillBaseUrl('https://batshit.example.com')).toBe('https://batshit.example.com')
  })

  it('refuses an empty origin instead of pointing at a default Batshit', () => {
    expect(() => portableSkillBaseUrl('')).toThrow('unknown')
    expect(() => portableSkillBaseUrl('  ')).toThrow('unknown')
  })
})

describe('buildPortableSkillEnvLines', () => {
  it('writes the address line, then the token line, then a newline', () => {
    expect(buildPortableSkillEnvLines('http://localhost:5621', 'bspt_secret')).toBe(
      'BATSHIT_BASE_URL=http://127.0.0.1:5621\nBATSHIT_PORTABLE_TOKEN=bspt_secret\n'
    )
  })
})
