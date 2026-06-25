import { json, type RequestHandler } from '@sveltejs/kit'
import { redis } from '$lib/server/redis'
import {
  getInternalBatshitServerAuthHeaders,
  getInternalBatshitServerUrl,
  rewriteInternalBatshitServerUrlsInPayload
} from '$lib/server/services/batshitServerUrls'
import { normalizeGoonsSettings, resolveAutoEnabledCues, resolveKitchenCues } from '$lib/goons/resolve'
import { resolveStarterGoonAsset, type StarterGoonAsset } from '$lib/goons/starterAssets'
import type {
  GoonCustomManifestSummary,
  GoonGuidedManifestSummary,
  GoonGuidedOutfitPiece,
  GoonGuidedOutfitPreset,
  GoonKind,
  GoonRecord,
  GoonSourceProfile
} from '$lib/types/goons'

const STARTER_GOON_DOWNLOAD_MAX_BYTES = 100 * 1024 * 1024

async function readUploadError(response: Response) {
  const text = await response.text().catch(() => '')
  if (!text) return 'Goon upload failed'

  try {
    const payload = JSON.parse(text) as { error?: string; details?: string }
    if (typeof payload.error === 'string' && typeof payload.details === 'string') {
      return `${payload.error}: ${payload.details}`
    }
    if (typeof payload.error === 'string') {
      return payload.error
    }
  } catch {
    // Fall through to HTML/plain-text cleanup.
  }

  return text.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() || 'Goon upload failed'
}

function generateGoonId() {
  return `goon_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`
}

function normalizeGoonKind(value: unknown): GoonKind {
  return value === 'custom' ? 'custom' : 'vrm'
}

function normalizeGoonSourceProfile(value: unknown): GoonSourceProfile | null {
  if (value === 'guided-custom-vrm') return 'guided-custom-vrm'
  if (value === 'expert-custom-glb') return 'expert-custom-glb'
  if (value === 'standard-vrm') return 'standard-vrm'
  return null
}

function resolveRequestedSourceProfile(kind: GoonKind, value: unknown): GoonSourceProfile {
  const normalized = normalizeGoonSourceProfile(value)
  if (normalized) return normalized
  return kind === 'custom' ? 'expert-custom-glb' : 'standard-vrm'
}

async function downloadStarterGoonAsset(asset: StarterGoonAsset) {
  let response: Response
  try {
    response = await fetch(asset.downloadUrl)
  } catch (error) {
    console.warn('[Goons API] Starter Goon download failed:', error)
    return {
      ok: false as const,
      status: 502,
      error: 'Starter Goon download failed.'
    }
  }

  if (!response.ok) {
    return {
      ok: false as const,
      status: 502,
      error: `Starter Goon download failed (${response.status}).`
    }
  }

  const contentLength = Number(response.headers.get('content-length') ?? 0)
  if (Number.isFinite(contentLength) && contentLength > STARTER_GOON_DOWNLOAD_MAX_BYTES) {
    return {
      ok: false as const,
      status: 502,
      error: 'Starter Goon download is larger than Batshit allows.'
    }
  }

  const blob = await response.blob()
  if (blob.size > STARTER_GOON_DOWNLOAD_MAX_BYTES) {
    return {
      ok: false as const,
      status: 502,
      error: 'Starter Goon download is larger than Batshit allows.'
    }
  }

  return {
    ok: true as const,
    file: new File([blob], asset.filename, {
      type: blob.type || 'model/vrm'
    })
  }
}

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const goons = await redis.execute(async (client) => {
      const ids = await client.sMembers(`user:${locals.user!.id}:goons`)
      if (ids.length === 0) return []

      const results: GoonRecord[] = []
      for (const id of ids) {
        const goon = (await client.json.get(`goon:${id}`)) as unknown
        if (goon && typeof goon === 'object' && (goon as any).user_id === locals.user!.id) {
          results.push(goon as GoonRecord)
        }
      }

      results.sort((a, b) => {
        const aTime = new Date(a.updated_at || a.created_at).getTime()
        const bTime = new Date(b.updated_at || b.created_at).getTime()
        return bTime - aTime
      })

      return results
    })

    return json({ goons })
  } catch (error) {
    console.error('Error loading goons:', error)
    return json({ error: 'Failed to load goons' }, { status: 500 })
  }
}

export const POST: RequestHandler = async ({ request, locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const contentType = request.headers.get('content-type') || ''
    let name: string | null = null
    let description: string | null = null
    let url: string | null = null
    let file: File | null = null
    let starterAssetId: string | null = null
    let requestedKind: GoonKind = 'vrm'
    let requestedSourceProfile: GoonSourceProfile = 'standard-vrm'

    if (contentType.includes('application/json')) {
      const body = await request.json()
      requestedKind = normalizeGoonKind(body?.kind)
      requestedSourceProfile = resolveRequestedSourceProfile(requestedKind, body?.sourceProfile)
      name = typeof body?.name === 'string' ? body.name : null
      description = typeof body?.description === 'string' ? body.description : null
      url = typeof body?.url === 'string' ? body.url : null
      starterAssetId = typeof body?.starterAssetId === 'string' ? body.starterAssetId : null
    } else {
      const form = await request.formData()
      requestedKind = normalizeGoonKind(form.get('kind'))
      requestedSourceProfile = resolveRequestedSourceProfile(
        requestedKind,
        form.get('sourceProfile')
      )
      const fileValue = form.get('file')
      file = fileValue instanceof File ? fileValue : null
      name = typeof form.get('name') === 'string' ? String(form.get('name')) : null
      description =
        typeof form.get('description') === 'string' ? String(form.get('description')) : null
      url = typeof form.get('url') === 'string' ? String(form.get('url')) : null
      starterAssetId =
        typeof form.get('starterAssetId') === 'string'
          ? String(form.get('starterAssetId'))
          : null
    }

    const sourceProfile = requestedSourceProfile
    const kind: GoonKind = sourceProfile === 'expert-custom-glb' ? 'custom' : 'vrm'
    const starterAsset = resolveStarterGoonAsset(starterAssetId)

    if (starterAssetId && !starterAsset) {
      return json({ error: 'Unknown starter Goon asset.' }, { status: 400 })
    }

    if (starterAsset && sourceProfile !== 'standard-vrm') {
      return json({ error: 'Starter Goons use the Standard/VRoid import path.' }, { status: 400 })
    }

    if (starterAsset && (file || url)) {
      return json(
        { error: 'Starter Goon import cannot be combined with a file or URL.' },
        { status: 400 }
      )
    }

    if (!file && !url && !starterAsset) {
      const error =
        sourceProfile === 'expert-custom-glb'
          ? 'Advanced/GLB Goon upload requires a package file.'
          : sourceProfile === 'guided-custom-vrm'
            ? 'Advanced/Blender Goon upload requires a package file.'
            : 'Goon upload requires a VRM file or URL.'
      return json(
        { error },
        { status: 400 }
      )
    }

    if (
      sourceProfile === 'standard-vrm' &&
      !file &&
      !starterAsset &&
      url &&
      !url.toLowerCase().includes('.vrm')
    ) {
      return json({ error: 'Goon URL must point to a .vrm file.' }, { status: 400 })
    }

    if (sourceProfile !== 'standard-vrm' && url) {
      return json(
        {
          error:
            sourceProfile === 'guided-custom-vrm'
              ? 'Advanced/Blender Goon packages do not support URL import yet.'
              : 'Advanced/GLB Goons do not support URL import yet.'
        },
        { status: 400 }
      )
    }

    let fileInfo: {
      filename: string
      url: string
      size?: number
      mimetype?: string
      uploadedAt?: string
    } | null = null
    let customPackageInfo: {
      package?: {
        filename: string
        url: string
        originalName?: string
        size?: number
        mimetype?: string
        uploadedAt?: string
      }
      model?: {
        filename: string
        url: string
        originalName?: string
        size?: number
        mimetype?: string
        uploadedAt?: string
      }
      manifest?: {
        filename: string
        url: string
        originalName?: string
        size?: number
        mimetype?: string
        uploadedAt?: string
      }
    } | null = null
    let customManifestSummary: GoonCustomManifestSummary | null = null
    let guidedPackageInfo: {
      package?: {
        filename: string
        url: string
        originalName?: string
        size?: number
        mimetype?: string
        uploadedAt?: string
      }
      vrm?: {
        filename: string
        url: string
        originalName?: string
        size?: number
        mimetype?: string
        uploadedAt?: string
      }
      manifest?: {
        filename: string
        url: string
        originalName?: string
        size?: number
        mimetype?: string
        uploadedAt?: string
      }
    } | null = null
    let guidedManifestSummary: GoonGuidedManifestSummary | null = null
    let guidedOutfitPieces: GoonGuidedOutfitPiece[] = []
    let guidedOutfitPresets: GoonGuidedOutfitPreset[] = []

    if (starterAsset) {
      const downloadResult = await downloadStarterGoonAsset(starterAsset)
      if (!downloadResult.ok) {
        return json({ error: downloadResult.error }, { status: downloadResult.status })
      }
      file = downloadResult.file
      name = name?.trim() ? name : starterAsset.name
      description = description?.trim() ? description : starterAsset.description
    }

    if (file) {
      const uploadForm = new FormData()
      uploadForm.append('file', file, file.name)

      const uploadPath =
        sourceProfile === 'expert-custom-glb'
          ? '/api/upload/goon-custom-package'
          : sourceProfile === 'guided-custom-vrm'
            ? '/api/upload/goon-guided-package'
            : '/api/upload/goon'
      const uploadResponse = await fetch(`${getInternalBatshitServerUrl()}${uploadPath}`, {
        method: 'POST',
        headers: getInternalBatshitServerAuthHeaders(),
        body: uploadForm
      })

      if (!uploadResponse.ok) {
        const error = await readUploadError(uploadResponse)
        return json({ error }, { status: uploadResponse.status || 500 })
      }

      const uploadPayload = rewriteInternalBatshitServerUrlsInPayload(
        await uploadResponse.json()
      )
      if (sourceProfile === 'expert-custom-glb') {
        customPackageInfo = uploadPayload?.files || null
        customManifestSummary = uploadPayload?.manifestData ?? null
      } else if (sourceProfile === 'guided-custom-vrm') {
        guidedPackageInfo = uploadPayload?.files || null
        guidedManifestSummary = uploadPayload?.manifestData?.summary ?? null
        guidedOutfitPieces = Array.isArray(uploadPayload?.manifestData?.outfitPieces)
          ? uploadPayload.manifestData.outfitPieces
          : []
        guidedOutfitPresets = Array.isArray(uploadPayload?.manifestData?.outfitPresets)
          ? uploadPayload.manifestData.outfitPresets
          : []
        url = guidedPackageInfo?.vrm?.url || url
      } else {
        fileInfo = uploadPayload?.file || null
        url = fileInfo?.url || url
      }
    }

    if (kind === 'vrm' && !url) {
      return json({ error: 'Goon upload failed to return a URL.' }, { status: 500 })
    }

    if (
      sourceProfile === 'expert-custom-glb' &&
      (!customPackageInfo?.package?.url || !customPackageInfo?.model?.url || !customPackageInfo?.manifest?.url)
    ) {
      return json(
        { error: 'Advanced/GLB Goon package upload failed to return unpacked files.' },
        { status: 500 }
      )
    }

    if (
      sourceProfile === 'guided-custom-vrm' &&
      (!guidedPackageInfo?.package?.url || !guidedPackageInfo?.vrm?.url || !guidedPackageInfo?.manifest?.url)
    ) {
      return json(
        { error: 'Advanced/Blender Goon package upload failed to return unpacked files.' },
        { status: 500 }
      )
    }

    const now = new Date().toISOString()
    const goonId = generateGoonId()
    const userSettings = await redis.getUserSettings(locals.user.id)
    const normalizedGoonsSettings = normalizeGoonsSettings(userSettings?.goons_settings ?? null)
    const kitchen = resolveKitchenCues(normalizedGoonsSettings)
    const enabledCues = resolveAutoEnabledCues(kitchen.cueMap)
    const defaultPack = normalizedGoonsSettings.kitchen?.defaultPack
    const defaultPackEnabled =
      defaultPack?.enabledCueNames?.filter((cueName) => Boolean(kitchen.cueMap[cueName])) ?? []
    const initialEnabledCues = defaultPackEnabled.length > 0 ? defaultPackEnabled : enabledCues
    const initialDisabledCues = Object.keys(kitchen.cueMap).filter(
      (cueName) => !initialEnabledCues.includes(cueName)
    )
    const initialBaseLoop =
      defaultPack?.defaults?.baseLoop && initialEnabledCues.includes(defaultPack.defaults.baseLoop)
        ? defaultPack.defaults.baseLoop
        : initialEnabledCues.find((cueName) => kitchen.cueMap[cueName]?.kind === 'mood') ?? 'base_stand'

    const goon: GoonRecord = {
      id: goonId,
      user_id: locals.user.id,
      kind,
      sourceProfile,
      name:
        (name && name.trim()) ||
        (sourceProfile === 'expert-custom-glb'
          ? customManifestSummary?.name
          : sourceProfile === 'guided-custom-vrm'
            ? guidedManifestSummary?.name
            : null) ||
        file?.name ||
        'New Goon',
      description:
        description ||
        (sourceProfile === 'expert-custom-glb'
          ? customManifestSummary?.description
          : sourceProfile === 'guided-custom-vrm'
            ? guidedManifestSummary?.description
            : '') ||
        '',
      files: {
        animations: []
      },
      compatibility: {
        tier: 'pending',
        issues: [
          sourceProfile === 'expert-custom-glb'
            ? 'Awaiting Custom avatar analysis'
            : sourceProfile === 'guided-custom-vrm'
              ? 'Awaiting Advanced/Blender Goon analysis'
              : 'Awaiting VRM analysis'
        ]
      },
      cues: {
        enabled: initialEnabledCues,
        disabled: initialDisabledCues,
        overrides: {},
        emojiOverrides: {}
      },
      defaults: {
        baseLoop: initialBaseLoop,
        quality: defaultPack?.defaults?.quality ?? 'auto',
        lipSync: defaultPack?.defaults?.lipSync ?? true,
        sceneId: defaultPack?.defaults?.sceneId
      },
      created_at: now,
      updated_at: now
    }

    if (kind === 'vrm') {
      goon.files.vrm = {
        url: url!,
        filename:
          fileInfo?.filename || guidedPackageInfo?.vrm?.filename || (file ? file.name : 'goon.vrm'),
        size: fileInfo?.size ?? guidedPackageInfo?.vrm?.size ?? file?.size,
        mimeType:
          fileInfo?.mimetype ?? guidedPackageInfo?.vrm?.mimetype ?? file?.type ?? 'model/vrm',
        uploadedAt: fileInfo?.uploadedAt ?? guidedPackageInfo?.vrm?.uploadedAt ?? now
      }
    }

    if (sourceProfile === 'guided-custom-vrm') {
      goon.guidedAvatar = {
        package: {
          url: guidedPackageInfo!.package!.url,
          filename: guidedPackageInfo!.package!.filename,
          originalName: guidedPackageInfo!.package!.originalName,
          size: guidedPackageInfo!.package!.size,
          mimeType: guidedPackageInfo!.package!.mimetype,
          uploadedAt: guidedPackageInfo!.package!.uploadedAt ?? now
        },
        manifest: {
          url: guidedPackageInfo!.manifest!.url,
          filename: guidedPackageInfo!.manifest!.filename,
          originalName: guidedPackageInfo!.manifest!.originalName,
          size: guidedPackageInfo!.manifest!.size,
          mimeType: guidedPackageInfo!.manifest!.mimetype,
          uploadedAt: guidedPackageInfo!.manifest!.uploadedAt ?? now
        },
        manifestSummary: guidedManifestSummary ?? undefined,
        outfitPieces: guidedOutfitPieces,
        outfitPresets: guidedOutfitPresets,
        pieceStates: Object.fromEntries(
          guidedOutfitPieces.map((piece) => [piece.id, piece.defaultOn ?? true])
        ),
        activePresetId: null
      }
    } else if (sourceProfile === 'expert-custom-glb') {
      goon.customAvatar = {
        package: {
          url: customPackageInfo!.package!.url,
          filename: customPackageInfo!.package!.filename,
          originalName: customPackageInfo!.package!.originalName,
          size: customPackageInfo!.package!.size,
          mimeType: customPackageInfo!.package!.mimetype,
          uploadedAt: customPackageInfo!.package!.uploadedAt ?? now
        },
        model: {
          url: customPackageInfo!.model!.url,
          filename: customPackageInfo!.model!.filename,
          originalName: customPackageInfo!.model!.originalName,
          size: customPackageInfo!.model!.size,
          mimeType: customPackageInfo!.model!.mimetype,
          uploadedAt: customPackageInfo!.model!.uploadedAt ?? now
        },
        manifest: {
          url: customPackageInfo!.manifest!.url,
          filename: customPackageInfo!.manifest!.filename,
          originalName: customPackageInfo!.manifest!.originalName,
          size: customPackageInfo!.manifest!.size,
          mimeType: customPackageInfo!.manifest!.mimetype,
          uploadedAt: customPackageInfo!.manifest!.uploadedAt ?? now
        },
        manifestSummary: customManifestSummary ?? undefined
      }
    }

    await redis.execute(async (client) => {
      await client.json.set(`goon:${goonId}`, '$', goon as any)
      await client.sAdd(`user:${locals.user!.id}:goons`, goonId)
    })

    return json(goon)
  } catch (error) {
    console.error('Error creating goon:', error)
    return json(
      { error: error instanceof Error ? error.message : 'Failed to create goon' },
      { status: 500 }
    )
  }
}
