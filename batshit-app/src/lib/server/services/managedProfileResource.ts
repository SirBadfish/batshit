import { realpathSync } from 'node:fs'
import path from 'node:path'
import { assertManagedProfileId } from './managedAgentHome'

/** The existing physical-profile identity, with no process record or profile provisioning. */
export function managedProfileResource(profileId: string, root: string): string {
  // Resolve the nearest existing ancestor so aliases also agree before first-use folders exist.
  let ancestor = path.resolve(root)
  const tail: string[] = []
  for (;;) {
    try { ancestor = realpathSync.native(ancestor); break }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error
      tail.unshift(path.basename(ancestor))
      ancestor = path.dirname(ancestor)
    }
  }
  return JSON.stringify(['profile', path.join(ancestor, ...tail, assertManagedProfileId(profileId))])
}
