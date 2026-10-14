import { refuse } from '../catalog'
import { appActionsHaveDrafts, type ActionContext } from '../owners'
import { materializeSuppliedFiles, parseImportArgs, type ImportArgs, type ImportOutcome, type SuppliedFile, type SuppliedFileActionId } from './contracts'

export type SuppliedFileOwner<I extends SuppliedFileActionId> = {
  available(args: ImportArgs[I]): string
  execute(args: ImportArgs[I], files: File[], context: ActionContext): Promise<ImportOutcome>
}
const owners = new Map<SuppliedFileActionId, SuppliedFileOwner<SuppliedFileActionId>>()

/** Only mounted page owners register. This grants no server/file-reference authority. */
export function registerSuppliedFileOwner<I extends SuppliedFileActionId>(id: I, owner: SuppliedFileOwner<I>) {
  if (owners.has(id)) throw new Error(`Supplied-file owner already mounted: ${id}`)
  const entry = owner as SuppliedFileOwner<SuppliedFileActionId>
  owners.set(id, entry)
  return () => { if (owners.get(id) === entry) owners.delete(id) }
}
export function suppliedFileActionAvailability(id: SuppliedFileActionId, args: unknown): string {
  const parsed = parseImportArgs(id, args)
  return owners.get(id)?.available(parsed) ?? 'unsupported_document'
}
/** Called by the exact-document developer bus with bytes out of band, never by Fabric. */
export async function executeSuppliedFileAction(
  id: SuppliedFileActionId, args: unknown, supplied: readonly SuppliedFile[], context: ActionContext
): Promise<ImportOutcome> {
  context.check()
  const parsed = parseImportArgs(id, args)
  const owner = owners.get(id)
  if (!owner) refuse('unsupported_document')
  const availability = owner.available(parsed)
  if (availability !== 'available') refuse(availability)
  if (appActionsHaveDrafts()) refuse('unsaved_changes')
  const files = materializeSuppliedFiles(id, supplied)
  context.check()
  return owner.execute(parsed, files, context)
}
