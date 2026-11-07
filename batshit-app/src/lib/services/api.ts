export { BATSHIT_SERVER_URL, httpClient } from './apiClient'
export type { HttpClient } from './apiClient'
export {
  UploadApiService,
  uploadApiService
} from './uploadApi'
export type {
  ZipData
} from './uploadApi'

import { uploadApiService } from './uploadApi'

export const api = {
  getZip: async (zipId: string, fetcher?: typeof fetch) => {
    return uploadApiService.getZip(zipId, fetcher)
  },

  getZips: async (zipIds: string[], fetcher?: typeof fetch) => {
    return uploadApiService.getZips(zipIds, fetcher)
  }
}
