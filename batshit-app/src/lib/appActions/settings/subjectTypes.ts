/** Primitive subject types shared by metadata and wire parsers, with no inverse imports. */
export type SettingsSubjectRef = Readonly<{ kind: 'primary' | 'subagent' | 'group' | 'worker'; id: string }>
export type StoredSettingsSubjectKind = 'primary' | 'subagent'
