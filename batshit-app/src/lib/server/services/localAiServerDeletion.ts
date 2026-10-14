import type { LocalAiServerId } from '$lib/types/localAi'
import { deleteLocalAiServerRecord } from './localAiServers'
import { withKoboldSettingsDeletion } from './localAiModelManagement'

/** Compose saved-record deletion with the same active/pending restart guard as model actions. */
export async function deleteLocalAiServer(userId: string, id: LocalAiServerId): Promise<void> {
  const remove = () => deleteLocalAiServerRecord(userId, id)
  if (id === 'koboldcpp') await withKoboldSettingsDeletion(userId, remove)
  else await remove()
}
