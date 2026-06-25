export interface BatshitIconDefinition {
  id: string
  label: string
  keywords: string[]
  description: string
}

export const BATSHIT_ICON_ENTRIES = [
  {
    id: 'agents',
    label: 'Agents',
    keywords: ['agents', 'agent', 'assistant', 'primary'],
    description: 'Batshit agent identity'
  },
  {
    id: 'subagents',
    label: 'Subagents',
    keywords: ['subagents', 'subagent', 'assistant', 'delegate'],
    description: 'Batshit subagent identity'
  },
  {
    id: 'groups',
    label: 'Groups',
    keywords: ['groups', 'group', 'team', 'agents'],
    description: 'Batshit group identity'
  },
  {
    id: 'core-basic',
    label: 'Core / Basic',
    keywords: ['core', 'basic', 'defaults', 'foundation'],
    description: 'Core settings identity'
  },
  {
    id: 'instructions',
    label: 'Instructions',
    keywords: ['instructions', 'system', 'prompt', 'guide'],
    description: 'Instruction settings identity'
  },
  {
    id: 'access',
    label: 'Access',
    keywords: ['access', 'permissions', 'allowlist', 'security'],
    description: 'Access settings identity'
  },
  {
    id: 'models',
    label: 'Models',
    keywords: ['models', 'model', 'ai', 'provider'],
    description: 'Model settings identity'
  },
  {
    id: 'model-catalog',
    label: 'Model Catalog',
    keywords: ['models', 'catalog', 'registry', 'provider'],
    description: 'Model catalog identity'
  },
  {
    id: 'parameters',
    label: 'Parameters',
    keywords: ['parameters', 'settings', 'sliders', 'tuning'],
    description: 'Model parameter identity'
  },
  {
    id: 'projects',
    label: 'Projects',
    keywords: ['projects', 'workspace', 'folder', 'files'],
    description: 'Project settings identity'
  },
  {
    id: 'rules',
    label: 'Rules',
    keywords: ['rules', 'policy', 'guardrails', 'project'],
    description: 'Project rule identity'
  },
  {
    id: 'zip',
    label: 'Zip',
    keywords: ['zip', 'zipped', 'compressed', 'token', 'archive'],
    description: 'Batshit zipped state'
  },
  {
    id: 'unzip',
    label: 'Unzip',
    keywords: ['unzip', 'unzipped', 'expanded', 'decompressed'],
    description: 'Batshit unzipped state'
  },
  {
    id: 'cli-tools',
    label: 'CLI Tools',
    keywords: ['cli', 'terminal', 'tools', 'command'],
    description: 'CLI tool identity'
  },
  {
    id: 'artifacts',
    label: 'Artifacts',
    keywords: ['artifacts', 'artifact', 'gadget', 'widget', 'module'],
    description: 'Batshit artifact identity'
  },
  {
    id: 'zones',
    label: 'Zones',
    keywords: ['zones', 'zone', 'publish', 'layout'],
    description: 'Artifact publishing zones identity'
  },
  {
    id: 'zone-none',
    label: 'None / Unpublished',
    keywords: ['zone', 'none', 'unpublished', 'hidden'],
    description: 'Unpublished artifact zone state'
  },
  {
    id: 'zone-headerbar',
    label: 'Headerbar Zone',
    keywords: ['zone', 'headerbar', 'header', 'top'],
    description: 'Headerbar artifact zone'
  },
  {
    id: 'zone-trigger-menu',
    label: 'Trigger Menu Zone',
    keywords: ['zone', 'trigger', 'menu', 'button'],
    description: 'Trigger menu artifact zone'
  },
  {
    id: 'zone-top-panel',
    label: 'Top Panel Zone',
    keywords: ['zone', 'top', 'panel', 'inline'],
    description: 'Top Panel artifact zone'
  },
  {
    id: 'zone-side-panel',
    label: 'Side Panel Zone',
    keywords: ['zone', 'side', 'panel', 'rail'],
    description: 'Side Panel artifact zone'
  },
  {
    id: 'skills',
    label: 'Skills',
    keywords: ['skills', 'skill', 'capability', 'commands'],
    description: 'Batshit skill identity'
  },
  {
    id: 'artifact-creator-skill',
    label: 'Artifact Creator Skill',
    keywords: ['skill', 'artifact', 'creator', 'gadget'],
    description: 'Artifact Creator Skill identity'
  },
  {
    id: 'cli-tool-creator-skill',
    label: 'CLI Tool Creator Skill',
    keywords: ['skill', 'cli', 'tool', 'creator'],
    description: 'CLI Tool Creator Skill identity'
  },
  {
    id: 'voice-engine-installer-skill',
    label: 'TTS/STT Engine Installer Skill',
    keywords: ['skill', 'voice', 'speech', 'tts', 'stt', 'engine', 'installer'],
    description: 'TTS/STT Engine Installer Skill identity'
  },
  {
    id: 'skill-creator-skill',
    label: 'Skill Creator Skill',
    keywords: ['skill', 'creator', 'author', 'commands'],
    description: 'Skill Creator Skill identity'
  },
  {
    id: 'prompts',
    label: 'Prompts',
    keywords: ['prompts', 'prompt', 'slash', 'commands'],
    description: 'Prompt identity'
  },
  {
    id: 'fabric',
    label: 'Fabric',
    keywords: ['fabric', 'registry', 'capabilities', 'control'],
    description: 'Fabric registry identity'
  },
  {
    id: 'goons',
    label: 'Goons',
    keywords: ['goons', 'goon', 'avatar', '3d'],
    description: '3D Goon identity'
  },
  {
    id: 'closet',
    label: 'Closet',
    keywords: ['closet', 'wardrobe', 'outfits', 'goon'],
    description: 'Goon Closet identity'
  },
  {
    id: 'kitchen',
    label: 'Kitchen',
    keywords: ['kitchen', 'goon', 'prep', 'model'],
    description: 'Goon Kitchen identity'
  },
  {
    id: 'scenes',
    label: 'Scenes',
    keywords: ['scenes', 'scene', 'stage', 'environment'],
    description: 'Goon scene identity'
  },
  {
    id: 'motions',
    label: 'Motions',
    keywords: ['motions', 'motion', 'animation', 'movement'],
    description: 'Goon motion identity'
  },
  {
    id: 'moods',
    label: 'Moods',
    keywords: ['moods', 'mood', 'emotion', 'state'],
    description: 'Goon mood identity'
  },
  {
    id: 'emotes',
    label: 'Emotes',
    keywords: ['emotes', 'emote', 'expression', 'cue'],
    description: 'Goon emote identity'
  },
  {
    id: 'voice-studio',
    label: 'Voice Studio / Clones',
    keywords: ['voice', 'studio', 'clones', 'clone'],
    description: 'Voice Studio identity'
  },
  {
    id: 'voice-engine-manager',
    label: 'TTS/STT Engine Manager',
    keywords: ['voice', 'speech', 'tts', 'stt', 'engine', 'manager', 'runtime'],
    description: 'TTS/STT Engine Manager identity'
  },
  {
    id: 'icons',
    label: 'Icons',
    keywords: ['icons', 'icon', 'library', 'picker'],
    description: 'Icon system identity'
  },
  {
    id: 'tunnel',
    label: 'Tunnel',
    keywords: ['tunnel', 'network', 'cloudflared', 'remote'],
    description: 'Tunnel settings identity'
  },
  {
    id: 'local-ai',
    label: 'Local AI',
    keywords: ['local', 'ai', 'runtime', 'models'],
    description: 'Local AI identity'
  }
] as const satisfies readonly BatshitIconDefinition[]

const BATSHIT_ICON_ID_SET: ReadonlySet<string> = new Set(BATSHIT_ICON_ENTRIES.map((entry) => entry.id))

export type BatshitIconId = (typeof BATSHIT_ICON_ENTRIES)[number]['id']

export function isBatshitIconId(id: string): id is BatshitIconId {
  return BATSHIT_ICON_ID_SET.has(id)
}
