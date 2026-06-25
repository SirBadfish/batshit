import { env } from '$env/dynamic/private'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'

import { redis } from '$lib/server/redis'
import { saveHostVoiceReferenceAudioViaOperator } from '$lib/server/services/voiceHostOperatorRuntime'
import type { VoiceProfileRecord } from '$lib/types/voice'

export function getManagedVoiceProfileStorageRoot(): string {
  return path.join(os.homedir(), '.batshit', 'voice-profiles')
}

function isContainerizedRuntime(): boolean {
  return (
    env.BATSHIT_CONTAINERIZED === '1' ||
    process.env.BATSHIT_CONTAINERIZED === '1' ||
    env.BATSHIT_RUNTIME_ENV === 'docker' ||
    process.env.BATSHIT_RUNTIME_ENV === 'docker'
  )
}

function buildManagedVoiceProfileDir(profileId: string): string {
  return path.join(getManagedVoiceProfileStorageRoot(), profileId)
}

function resolveManagedVoiceProfileAudioExtension(options: {
  filename?: string | null
  contentType?: string | null
}): string {
  const fromFilename = path.extname(options.filename ?? '').trim().toLowerCase()
  if (/^\.[a-z0-9]{1,10}$/.test(fromFilename)) {
    return fromFilename
  }

  const normalizedType = options.contentType?.trim().toLowerCase() ?? ''
  const byContentType: Record<string, string> = {
    'audio/wav': '.wav',
    'audio/wave': '.wav',
    'audio/x-wav': '.wav',
    'audio/mpeg': '.mp3',
    'audio/mp3': '.mp3',
    'audio/flac': '.flac',
    'audio/x-flac': '.flac',
    'audio/ogg': '.ogg',
    'audio/webm': '.webm',
    'audio/mp4': '.m4a',
    'audio/x-m4a': '.m4a',
    'audio/aac': '.aac'
  }

  return byContentType[normalizedType] ?? '.wav'
}

async function saveManagedVoiceProfileReferenceAudio(options: {
  profileId: string
  audio: Uint8Array
  filename?: string | null
  contentType?: string | null
}): Promise<{ audioPath: string; dirPath: string }> {
  const dirPath = buildManagedVoiceProfileDir(options.profileId)
  const extension = resolveManagedVoiceProfileAudioExtension(options)
  const audioPath = path.join(dirPath, `reference${extension}`)

  await fs.mkdir(dirPath, { recursive: true })
  await fs.writeFile(audioPath, Buffer.from(options.audio))

  return { audioPath, dirPath }
}

export async function saveReferenceAudioForByoClone(options: {
  profileId: string
  audio: Uint8Array
  filename?: string | null
  contentType?: string | null
}): Promise<{ audioPath: string; dirPath?: string }> {
  if (!isContainerizedRuntime()) {
    return saveManagedVoiceProfileReferenceAudio(options)
  }

  const result = await saveHostVoiceReferenceAudioViaOperator({
    profileId: options.profileId,
    audioBase64: Buffer.from(options.audio).toString('base64'),
    filename: options.filename,
    contentType: options.contentType
  }).catch((error) => {
    const detail =
      error instanceof Error && error.message.trim()
        ? error.message.trim()
        : 'The host operator could not store the reference sample.'
    throw new Error(
      `Docker voice cloning for host-local BYO engines requires the authenticated Batshit host operator so the speech engine can read the reference audio file. ${detail}`
    )
  })

  return {
    audioPath: result.audioPath,
    dirPath: result.dirPath
  }
}

function getManagedVoiceProfileAudioPath(profile: VoiceProfileRecord | null | undefined): string | null {
  const settings =
    profile?.settings && typeof profile.settings === 'object' && !Array.isArray(profile.settings)
      ? (profile.settings as Record<string, unknown>)
      : null
  const candidate =
    settings && typeof settings.batshitManagedReferenceAudioPath === 'string'
      ? settings.batshitManagedReferenceAudioPath.trim()
      : ''
  if (!candidate) return null

  const root = path.resolve(getManagedVoiceProfileStorageRoot())
  const resolved = path.resolve(candidate)
  if (resolved === root || !resolved.startsWith(`${root}${path.sep}`)) {
    return null
  }

  return resolved
}

export async function deleteManagedVoiceProfileArtifacts(
  profile: VoiceProfileRecord | null | undefined
): Promise<void> {
  const audioPath = getManagedVoiceProfileAudioPath(profile)
  if (!audioPath) return

  await fs.rm(path.dirname(audioPath), { recursive: true, force: true })
}

export async function createVoiceProfile(profile: VoiceProfileRecord): Promise<VoiceProfileRecord> {
  return redis.createVoiceProfile(profile)
}

export async function listVoiceProfiles(userId: string): Promise<VoiceProfileRecord[]> {
  return redis.getVoiceProfiles(userId)
}

export async function deleteVoiceProfile(userId: string, profileId: string): Promise<void> {
  const profile = await redis.getVoiceProfile(profileId)
  if (profile?.user_id && profile.user_id !== userId) {
    throw new Error('Voice profile not found')
  }

  await deleteManagedVoiceProfileArtifacts(profile)
  return redis.deleteVoiceProfile(profileId, userId)
}

export async function deleteVoiceProfilesForProvider(
  userId: string,
  providerId: string
): Promise<{ deletedProfileIds: string[] }> {
  const profiles = await listVoiceProfiles(userId)
  const deletedProfileIds: string[] = []

  for (const profile of profiles) {
    if (profile.provider !== providerId) continue

    await deleteManagedVoiceProfileArtifacts(profile)
    await redis.deleteVoiceProfile(profile.id, userId)
    deletedProfileIds.push(profile.id)
  }

  return { deletedProfileIds }
}
