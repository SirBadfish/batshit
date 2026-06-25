import { json } from '@sveltejs/kit'
import type { RequestHandler } from './$types'
import { redis } from '$lib/server/redis'
import { canAccessZipData, requireOwnedSession, requireUser } from '$lib/server/services/routeSecurity'
import { enrichCoolToolPromptTokens } from '$lib/server/services/coolToolPromptTokens'
import { logger } from '$lib/utils/logger'

interface ZipListItem {
  id: string
  type: string
  name?: string
  tokens: number
  description?: string
  createdAt: number
  source: string
  sessionId?: string
  messageId?: string
  isUnzipped?: boolean
  unzippedItem?: Record<string, any> | null
  isCoolTool?: boolean
  metadata?: Record<string, any>
}

async function scanZipKeys(): Promise<string[]> {
  return redis.execute(async (client) => {
    const scanner = (client as any).scanIterator
    if (typeof scanner === 'function') {
      const keys: string[] = []
      for await (const key of scanner.call(client, { MATCH: 'zip:*', COUNT: 500 })) {
        keys.push(String(key))
      }
      return keys
    }

    let cursor = '0'
    const keys: string[] = []
    do {
      const result = await (client as any).scan(cursor, { MATCH: 'zip:*', COUNT: 500 })
      cursor = String(result.cursor ?? result[0] ?? '0')
      const batch = result.keys ?? result[1] ?? []
      keys.push(...batch.map(String))
    } while (cursor !== '0')
    return keys
  })
}

async function getZipKeysForRequest(sessionId: string | null): Promise<string[]> {
  if (sessionId) {
    const zipIds = await redis.getSessionZips(sessionId)
    return zipIds.map((zipId) => `zip:${zipId}`)
  }

  return scanZipKeys()
}

async function getZipDataByKey(key: string): Promise<any | null> {
  try {
    return await redis.execute(async (client) => client.json.get(key))
  } catch (error) {
    console.error(`[ZipListAPI] Error fetching ${key}:`, error)
    return null
  }
}

// GET /api/zips/list - List all zips with metadata
export const GET: RequestHandler = async ({ url, locals }) => {
  const user = requireUser(locals)
  if (!user.ok) return user.response
  
  try {
    const sessionId = url.searchParams.get('sessionId')
    const type = url.searchParams.get('type')
    const source = url.searchParams.get('source')
    const search = url.searchParams.get('search')?.toLowerCase()
    if (sessionId) {
      const sessionCheck = await requireOwnedSession(sessionId, user.value.id)
      if (!sessionCheck.ok) return sessionCheck.response
    }

    const zipKeys = await getZipKeysForRequest(sessionId)
    logger.debug('[ZipListAPI] Zip keys selected for request:', {
      sessionScoped: Boolean(sessionId),
      count: zipKeys.length
    })
    
    // Get unzipped items for this session if provided
    const unzippedIds = sessionId ? await redis.execute(async (client) => {
      const unzippedKey = `unzipped:${sessionId}`
      const ids = await client.sMembers(unzippedKey) as string[]
      logger.debug(`[ZipListAPI] Unzipped IDs for session ${sessionId}:`, ids)
      return new Set<string>(ids) // Convert array to Set
    }) : new Set<string>()

    const unzippedItems = new Map<string, Record<string, any>>()
    if (sessionId && unzippedIds.size > 0) {
      for (const zipId of unzippedIds) {
        const item = await redis.get(`unzipped_item:${sessionId}:${zipId}`)
        if (item && typeof item === 'object') {
          unzippedItems.set(zipId, item as Record<string, any>)
        }
      }
    }
    
    const allZips = await Promise.all(zipKeys.map(getZipDataByKey))
    const validZips = []
    for (const zipData of allZips) {
      if (zipData && (await canAccessZipData(zipData, user.value.id))) {
        validZips.push(zipData)
      }
    }
    
    logger.debug(`[ZipListAPI] Found ${zipKeys.length} zip keys, ${validZips.length} accessible zips`)
    
    const enrichedZips = await Promise.all(
      validZips.map((zip) => enrichCoolToolPromptTokens(zip as any, (zipId) => redis.getZip(zipId)))
    )

    // Transform and filter zips
    let zipList: ZipListItem[] = enrichedZips.map(zip => {
      try {
        const zipData = zip as any
        if (!zipData) return null

        return {
          id: zipData.id,
          type: zipData.type,
          name: zipData.name || zipData.metadata?.name,
          tokens:
            zipData.metadata?.promptTokens ||
            zipData.metadata?.aiTokens ||
            zipData.tokens ||
            Math.ceil((zipData.content?.length || 0) / 4),
          description: zipData.description || generateDescription(zipData),
          createdAt: zipData.createdAt || zipData.created_at || Date.now(),
          source: zipData.source || 'manual',
          sessionId: zipData.metadata?.sessionId,
          messageId: zipData.metadata?.messageId,
          isUnzipped: sessionId && unzippedIds ? unzippedIds.has(zipData.id) : false,
          unzippedItem: unzippedItems.get(zipData.id) ?? null,
          isCoolTool: zipData.type === 'cool_tool' || zipData.source === 'cool_tool',
          metadata: zipData.metadata && typeof zipData.metadata === 'object'
            ? zipData.metadata
            : {}
        }
      } catch (err) {
        console.error(`[ZipListAPI] Error transforming zip:`, err)
        return null
      }
    }).filter(Boolean) as ZipListItem[]
    
    // Apply filters
    if (sessionId) {
      const beforeFilter = zipList.length
      zipList = zipList.filter(z => z.sessionId === sessionId)
      logger.debug(`[ZipListAPI] Session filter: ${beforeFilter} -> ${zipList.length} zips for session ${sessionId}`)
    }
    
    if (type) {
      zipList = zipList.filter(z => z.type === type)
    }
    
    if (source) {
      zipList = zipList.filter(z => z.source === source)
    }
    
    if (search) {
      zipList = zipList.filter(z => 
        z.description?.toLowerCase().includes(search) ||
        z.type.toLowerCase().includes(search) ||
        z.id.toLowerCase().includes(search)
      )
    }
    
    // Sort by creation date (newest first)
    zipList.sort((a, b) => b.createdAt - a.createdAt)
    
    return json({
      zips: zipList,
      total: zipList.length,
      totalTokens: zipList.reduce((sum, z) => sum + z.tokens, 0),
      coolToolsMetadata: {}
    })
  } catch (error) {
    console.error('Error listing zips:', error)
    return json({ error: 'Failed to list zips' }, { status: 500 })
  }
}

function generateDescription(zip: any): string {
  const lines = zip.content?.split('\n').length || 0
  
  switch(zip.type) {
    case 'terminal':
      return `Terminal output - ${lines} lines`
    case 'diff':
      return `Diff - ${lines} lines`
    case 'error':
      return `Error output - ${lines} lines`
    case 'cool_tool':
      return `Tool execution - ${lines} lines`
    case 'tool_raw':
      return `Raw tool payload - ${lines} lines`
    default:
      return `${zip.type} content - ${lines} lines`
  }
}
