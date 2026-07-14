export type PortableSkillFamilyId =
  | 'voice-engines'
  | 'artifacts'
  | 'cli-tools'
  | 'skills'
  | 'goon-scenes'

export type PortableSkillTokenRecord = {
  id: string
  userId: string
  label: string
  families: PortableSkillFamilyId[]
  tokenHash: string
  tokenPrefix: string
  tokenSuffix: string
  createdAt: string
  updatedAt: string
  lastUsedAt: string | null
  revokedAt: string | null
}

export type PortableSkillTokenSummary = Omit<PortableSkillTokenRecord, 'tokenHash'>

export type PortableSkillTokenValidation =
  | {
      valid: true
      userId: string
      token: PortableSkillTokenSummary
      allowedControlIds: string[]
    }
  | {
      valid: false
      reason: 'missing' | 'invalid' | 'revoked'
    }

export type PortableSkillTokenFamilyDefinition = {
  id: PortableSkillFamilyId
  label: string
  description: string
  controlIds: string[]
}

export type PortableSkillEnvTemplateInfo = {
  id: string
  kind: 'shared' | 'skill'
  skillId: string | null
  family: PortableSkillFamilyId | null
  label: string
  path: string
  placeholder: string
  writable: boolean
  exists: boolean
  created: boolean
}
