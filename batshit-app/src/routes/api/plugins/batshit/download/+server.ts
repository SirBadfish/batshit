import { json, type RequestHandler } from '@sveltejs/kit'
import { zipSync } from 'fflate/node'
import { getBundledBatshitPluginRoot } from '$lib/server/services/systemPluginPackage'
import { capturePluginPackageFiles } from '$lib/server/services/agentPluginImport'

export const GET: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) return json({ error: 'Unauthorized' }, { status: 401 })
  try {
    const files = await capturePluginPackageFiles(getBundledBatshitPluginRoot())
    const archive = zipSync(Object.fromEntries([...files].map(([name, bytes]) => [`batshit/${name}`, bytes])), { level: 6 })
    return new Response(new Uint8Array(archive).buffer, { headers: {
      'Content-Type': 'application/zip', 'Content-Disposition': 'attachment; filename="batshit-plugin.zip"', 'Cache-Control': 'private, no-store'
    } })
  } catch (error) {
    console.error('[plugins] Bundled download unavailable:', error)
    return json({ error: 'The Batshit plugin download is unavailable.' }, { status: 503 })
  }
}
