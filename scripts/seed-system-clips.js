#!/usr/bin/env node
const { createClient } = require('redis')
const fs = require('fs')
const path = require('path')

const REDIS_URL = process.env.REDIS_URL || 'redis://localhost:6379'
const SYSTEM_USER = 'system'
const PRUNE_STALE = process.argv.includes('--prune-stale')

// The Batshit Guide clip was retired in SA-092 (it became the /batshit-guide
// system skill); app startup removes any leftover record via
// removeRetiredSystemClips(), and --prune-stale here does the same.
const clips = [
  {
    id: 'goon_guide',
    title: 'Goon Guide',
    description: 'On-demand Goon helper for Standard/VRoid and Advanced/Blender packages.',
    filename: 'goon-guide.md'
  }
]

async function main() {
  const client = createClient({ url: REDIS_URL })
  await client.connect()
  const now = new Date().toISOString()
  const currentIds = new Set(clips.map((clip) => clip.id))

  if (PRUNE_STALE) {
    const existing = await client.sMembers(`user:${SYSTEM_USER}:clips`)
    for (const clipId of existing) {
      if (currentIds.has(clipId)) continue
      await client.del(`clip:${SYSTEM_USER}:${clipId}`)
      await client.del(`clip:system:${clipId}`)
      await client.sRem(`user:${SYSTEM_USER}:clips`, clipId)
      console.log(`Removed stale system clip: ${clipId}`)
    }
  }

  for (const clip of clips) {
    const filePath = path.join(__dirname, '..', 'docs', 'batshit_System_Clips', clip.filename)
    const content = fs.readFileSync(filePath, 'utf-8')
    const base64 = Buffer.from(content, 'utf-8').toString('base64')
    const record = {
      id: clip.id,
      user_id: SYSTEM_USER,
      filename: clip.title,
      description: clip.description,
      fileType: 'text',
      mimeType: 'text/markdown',
      content,
      storageMode: 'local',
      localBase64: base64,
      externalUrl: null,
      displayUrl: null,
      localUrl: null,
      externalTokens: null,
      localTokens: Math.ceil(content.length / 4),
      tags: ['batshit', 'system', 'helper'],
      created_at: now,
      updated_at: now
    }

    await client.json.set(`clip:system:${clip.id}`, '$', record)
    await client.sAdd(`user:${SYSTEM_USER}:clips`, clip.id)
    console.log(`Seeded system clip: ${clip.id}`)
  }

  await client.quit()
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
