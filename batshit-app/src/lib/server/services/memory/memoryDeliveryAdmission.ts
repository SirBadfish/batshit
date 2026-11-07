import { AsyncLocalStorage } from 'node:async_hooks'
import type { MemoryOwnerProof } from './memoryOwnership'
import type { SettingsLifecycleSnapshot } from '../appActions/settings/lifecycle'

/** Only the typed original recall owner populates this in-process call context. */
export interface MemoryDeliveryAdmission {
  agentId: string
  userId: string
  sessionId: string
  agentOwner: MemoryOwnerProof
  sessionOwner: MemoryOwnerProof
  memoryId: string
  includeExpired: boolean
  lifecycle: SettingsLifecycleSnapshot
}
const admittedDelivery = new AsyncLocalStorage<MemoryDeliveryAdmission>()
export const currentMemoryDeliveryAdmission = () => admittedDelivery.getStore()
export const withMemoryDeliveryAdmission = <T>(admission: MemoryDeliveryAdmission, load: () => Promise<T>) => admittedDelivery.run(admission, load)
