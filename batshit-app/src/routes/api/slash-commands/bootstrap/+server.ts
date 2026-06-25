// Bootstrap endpoint to create system slash commands
import { json, type RequestHandler } from '@sveltejs/kit'
import { bootstrapSystemSlashCommands } from '$lib/server/services/systemSlashCommands'

// POST /api/slash-commands/bootstrap - Create system slash commands
export const POST: RequestHandler = async ({ locals }) => {
  if (!locals.user?.id) {
    return json({ error: 'Unauthorized' }, { status: 401 })
  }

  try {
    const userId = locals.user.id
    const { hadExisting, slashCommands } = await bootstrapSystemSlashCommands(userId)

    return json({
      success: true,
      created: !hadExisting,
      message:
        hadExisting
          ? 'System slash commands refreshed to latest templates'
          : 'System slash commands created successfully',
      slashCommands
    })
  } catch (error) {
    console.error('Error bootstrapping slash commands:', error)
    return json({ error: 'Failed to create system slash commands' }, { status: 500 })
  }
}
