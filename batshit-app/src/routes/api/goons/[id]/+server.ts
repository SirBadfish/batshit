import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import type { GoonRecord } from '$lib/types/goons'
import {
  normalizeUploadUrlsForStorageInPayload,
  resolveUploadUrlsForBrowserInPayload
} from '$lib/server/services/batshitServerUrls'
import {
  collectGoonRecipeUploadReferencesForClient,
  collectGoonUploadReferencesForClient,
  deleteGoonRecipeRecordsForClient,
  deleteGoonUploadAsset,
  deleteUnreferencedGoonUploadReferences,
  hasGoonUploadReference
} from '$lib/server/services/goonAssetCleanupService'
import { validateGoonFacialArtworkState } from '$lib/server/services/facialArtwork.server'
import { validateGoonEyeAppearanceState } from '$lib/server/services/eyeAppearance.server'
import { validateGoonOralAppearanceState } from '$lib/server/services/oralAppearance.server'
import { collectFacialArtworkUploads } from '$lib/goons/facialArtwork'
import { parseSocketEyeContactSettings } from '$lib/goons/socketEyeContact'
import {
  GoonMutationError,
  assertGenericGoonPatchAllowed,
  patchOwnedGoonForClient
} from '$lib/server/services/goonMutationRepository.server'

export const GET: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.id) {
    return json({ error: 'Goon id is required' }, { status: 400 })
  }
  const goonId = params.id

  try {
    const goon = await redis.execute(async (client) => {
      const data = await client.json.get(`goon:${goonId}`)
      return data as GoonRecord | null
    })

    if (!goon) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    if (goon.user_id !== locals.user.id) {
      return json({ error: 'Unauthorized' }, { status: 403 })
    }

    return json(resolveUploadUrlsForBrowserInPayload(goon))
  } catch (error) {
    console.error('Error fetching goon:', error)
    return json({ error: 'Failed to fetch goon' }, { status: 500 })
  }
}

export const PUT: RequestHandler = async ({ params, request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.id) {
    return json({ error: 'Goon id is required' }, { status: 400 })
  }
  const goonId = params.id

  try {
    const updates = await request.json()
    if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
      return json({ error: 'Goon updates must be a JSON object' }, { status: 400 })
    }

    const goon = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${goonId}`)) as GoonRecord | null
      if (!existing) return null
      if (existing.user_id !== locals.user!.id) return null
      assertGenericGoonPatchAllowed(existing, updates)

      const updated: GoonRecord = {
        ...existing,
        ...updates,
        id: existing.id,
        user_id: existing.user_id,
        created_at: existing.created_at,
        updated_at: new Date().toISOString()
      }
      if (
        Object.prototype.hasOwnProperty.call(updates, 'defaults') &&
        updates.defaults &&
        typeof updates.defaults === 'object' &&
        !Array.isArray(updates.defaults) &&
        Object.prototype.hasOwnProperty.call(updates.defaults, 'socketEyeContact')
      ) {
        updated.defaults = {
          ...updated.defaults,
          socketEyeContact: parseSocketEyeContactSettings(
            (updates.defaults as Record<string, unknown>).socketEyeContact
          )
        }
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'facialArtwork')) {
        updated.facialArtwork = await validateGoonFacialArtworkState(
          client as any,
          updated,
          updates.facialArtwork
        )
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'eyeAppearance')) {
        updated.eyeAppearance = await validateGoonEyeAppearanceState(
          client as any,
          updated,
          updates.eyeAppearance
        )
      }
      if (Object.prototype.hasOwnProperty.call(updates, 'oralAppearance')) {
        updated.oralAppearance = await validateGoonOralAppearanceState(
          client as any,
          updated,
          updates.oralAppearance
        )
      }
      const storageUpdated = normalizeUploadUrlsForStorageInPayload(updated)
      const storagePatch = Object.fromEntries(
        Object.keys(updates).map((field) => [
          field,
          (storageUpdated as unknown as Record<string, unknown>)[field]
        ])
      )

      return patchOwnedGoonForClient({
        client,
        userId: locals.user!.id,
        goonId,
        updates: storagePatch,
        updatedAt: storageUpdated.updated_at
      })
    })

    if (!goon) {
      return json({ error: 'Goon not found' }, { status: 404 })
    }

    return json({ goon: resolveUploadUrlsForBrowserInPayload(goon) })
  } catch (error) {
    console.error('Error updating goon:', error)
    if (error instanceof GoonMutationError) {
      return json({ error: error.message, code: error.code }, { status: error.status })
    }
    if (
      error instanceof Error &&
      (error.message.startsWith('[facial-artwork/v4]') ||
        error.message.startsWith('[eye-appearance/v3]') ||
        error.message.startsWith('[socket-eye-contact-settings/v2]') ||
        error.message.startsWith('[oral-appearance/v1]'))
    ) {
      return json({ error: error.message }, { status: 400 })
    }
    return json({ error: 'Failed to update goon' }, { status: 500 })
  }
}

export const DELETE: RequestHandler = async ({ params, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }
  if (!params.id) {
    return json({ error: 'Goon id is required' }, { status: 400 })
  }
  const goonId = params.id

  try {
    const clearedAgentIds = await redis.execute(async (client) => {
      const existing = (await client.json.get(`goon:${goonId}`)) as GoonRecord | null
      if (!existing) {
        throw new Error('Goon not found')
      }

      if (existing.user_id !== locals.user!.id) {
        throw new Error('Unauthorized')
      }

      const clearedAgentIds: string[] = []
      const agentIds = await client.sMembers(`user:${locals.user!.id}:agents`)
      for (const agentId of agentIds) {
        const agent = (await client.json.get(`agent:${agentId}`)) as Record<string, any> | null
        if (agent?.goon_id !== goonId) continue
        await client.json.set(`agent:${agentId}`, '$.goon_id', null as any)
        clearedAgentIds.push(agentId)
      }

	      const removedRecipeReferences = await collectGoonRecipeUploadReferencesForClient(
	        client as any,
	        locals.user!.id,
	        goonId
	      )
	      await deleteGoonRecipeRecordsForClient(client as any, locals.user!.id, goonId)
	      await client.del(`goon:${goonId}`)
	      await client.sRem(`user:${locals.user!.id}:goons`, goonId)

	      const references = await collectGoonUploadReferencesForClient(client as any, locals.user!.id)
	      await deleteUnreferencedGoonUploadReferences(removedRecipeReferences, references)

	      const filename = existing.files?.vrm?.filename
	      if (filename && !hasGoonUploadReference(references, 'goons', filename)) {
	        await deleteGoonUploadAsset('goons', filename)
	      }
	      const backupFilename = existing.files?.vrmBackup?.filename
	      if (backupFilename && !hasGoonUploadReference(references, 'goons', backupFilename)) {
	        await deleteGoonUploadAsset('goons', backupFilename)
	      }
	      const pendingFilename = existing.files?.vrmPending?.filename
	      if (pendingFilename && !hasGoonUploadReference(references, 'goons', pendingFilename)) {
	        await deleteGoonUploadAsset('goons', pendingFilename)
	      }

	      const customPackageFilename = existing.customAvatar?.package?.filename
	      if (
	        customPackageFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_packages', customPackageFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_packages', customPackageFilename)
	      }
	      const customModelFilename = existing.customAvatar?.model?.filename
	      if (
	        customModelFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_models', customModelFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_models', customModelFilename)
	      }
	      const customManifestFilename = existing.customAvatar?.manifest?.filename
	      if (
	        customManifestFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_manifests', customManifestFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_manifests', customManifestFilename)
	      }
	      const customBackupPackageFilename = existing.customAvatar?.backup?.package?.filename
	      if (
	        customBackupPackageFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_packages', customBackupPackageFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_packages', customBackupPackageFilename)
	      }
	      const customBackupModelFilename = existing.customAvatar?.backup?.model?.filename
	      if (
	        customBackupModelFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_models', customBackupModelFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_models', customBackupModelFilename)
	      }
	      const customBackupManifestFilename = existing.customAvatar?.backup?.manifest?.filename
	      if (
	        customBackupManifestFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_manifests', customBackupManifestFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_manifests', customBackupManifestFilename)
	      }
	      const customPendingPackageFilename = existing.customAvatar?.pending?.package?.filename
	      if (
	        customPendingPackageFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_packages', customPendingPackageFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_packages', customPendingPackageFilename)
	      }
	      const customPendingModelFilename = existing.customAvatar?.pending?.model?.filename
	      if (
	        customPendingModelFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_models', customPendingModelFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_models', customPendingModelFilename)
	      }
	      const customPendingManifestFilename = existing.customAvatar?.pending?.manifest?.filename
	      if (
	        customPendingManifestFilename &&
	        !hasGoonUploadReference(references, 'goon_custom_manifests', customPendingManifestFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_custom_manifests', customPendingManifestFilename)
	      }

	      const guidedPackageFilename = existing.guidedAvatar?.package?.filename
	      if (
	        guidedPackageFilename &&
	        !hasGoonUploadReference(references, 'goon_guided_packages', guidedPackageFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_guided_packages', guidedPackageFilename)
	      }
	      const guidedManifestFilename = existing.guidedAvatar?.manifest?.filename
	      if (
	        guidedManifestFilename &&
	        !hasGoonUploadReference(references, 'goon_guided_manifests', guidedManifestFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_guided_manifests', guidedManifestFilename)
	      }
	      const guidedBackupPackageFilename = existing.guidedAvatar?.backup?.package?.filename
	      if (
	        guidedBackupPackageFilename &&
	        !hasGoonUploadReference(references, 'goon_guided_packages', guidedBackupPackageFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_guided_packages', guidedBackupPackageFilename)
	      }
	      const guidedBackupVrmFilename = existing.guidedAvatar?.backup?.vrm?.filename
	      if (guidedBackupVrmFilename && !hasGoonUploadReference(references, 'goons', guidedBackupVrmFilename)) {
	        await deleteGoonUploadAsset('goons', guidedBackupVrmFilename)
	      }
	      const guidedBackupManifestFilename = existing.guidedAvatar?.backup?.manifest?.filename
	      if (
	        guidedBackupManifestFilename &&
	        !hasGoonUploadReference(references, 'goon_guided_manifests', guidedBackupManifestFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_guided_manifests', guidedBackupManifestFilename)
	      }
	      const guidedPendingPackageFilename = existing.guidedAvatar?.pending?.package?.filename
	      if (
	        guidedPendingPackageFilename &&
	        !hasGoonUploadReference(references, 'goon_guided_packages', guidedPendingPackageFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_guided_packages', guidedPendingPackageFilename)
	      }
	      const guidedPendingVrmFilename = existing.guidedAvatar?.pending?.vrm?.filename
	      if (guidedPendingVrmFilename && !hasGoonUploadReference(references, 'goons', guidedPendingVrmFilename)) {
	        await deleteGoonUploadAsset('goons', guidedPendingVrmFilename)
	      }
	      const guidedPendingManifestFilename = existing.guidedAvatar?.pending?.manifest?.filename
	      if (
	        guidedPendingManifestFilename &&
	        !hasGoonUploadReference(references, 'goon_guided_manifests', guidedPendingManifestFilename)
	      ) {
	        await deleteGoonUploadAsset('goon_guided_manifests', guidedPendingManifestFilename)
	      }
	      for (const overlay of existing.guidedAvatar?.dufOverlays ?? []) {
	        const overlayFilename = overlay.file?.filename
	        if (overlayFilename && !hasGoonUploadReference(references, 'goons', overlayFilename)) {
	          await deleteGoonUploadAsset('goons', overlayFilename)
	        }
	      }

	      for (const artwork of collectFacialArtworkUploads(existing.facialArtwork)) {
	        if (!hasGoonUploadReference(references, 'goon_facial_artwork', artwork.filename)) {
	          await deleteGoonUploadAsset('goon_facial_artwork', artwork.filename)
	        }
	      }

	      const animationFiles = Array.isArray(existing.files?.animations)
	        ? existing.files?.animations ?? []
	        : []
	      for (const animationFile of animationFiles) {
	        if (
	          animationFile?.filename &&
	          !hasGoonUploadReference(references, 'goon_animations', animationFile.filename)
	        ) {
	          await deleteGoonUploadAsset('goon_animations', animationFile.filename)
	        }
	      }
      return clearedAgentIds
    })

    return json({ success: true, clearedAgentIds })
  } catch (error: any) {
    const message = error instanceof Error ? error.message : 'Failed to delete goon'
    const status = message === 'Unauthorized' ? 403 : message === 'Goon not found' ? 404 : 500
    return json({ error: message }, { status })
  }
}
