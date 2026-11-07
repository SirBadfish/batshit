/** Pure file/scope helpers; no global publication, exclusion or persistent state. */
export type ProfileExcludedEntry = { gatewayId: string; serverId: string; preimageDigests: string[] }
export const isProfileText = (value: unknown, max = 512): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= max && !/[\x00-\x1f\x7f]/.test(value) && value.isWellFormed()
export class ProfilePublicationRefusal extends Error {
  constructor(readonly code: string, message: string) { super(message); this.name = 'ProfilePublicationRefusal' }
}
