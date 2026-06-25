export { BATSHIT_SERVER_URL, httpClient } from './apiClient'
export type { HttpClient } from './apiClient'
export { MessageApiService } from './messageApi'
export type { SendMessagePayload } from './messageApi'
export {
  UploadApiService,
  uploadApiService
} from './uploadApi'
export type {
  ZipData
} from './uploadApi'

import { MessageApiService } from './messageApi'
import { uploadApiService } from './uploadApi'

export class ApiService {
  private messageApi: MessageApiService

  constructor(webhookUrl: string) {
    this.messageApi = new MessageApiService(webhookUrl)
  }

  async sendMessage(
    content: string,
    sessionId: string,
    userId: string,
    messages: any[],
    agentId?: string,
    maxTokens?: number,
    agent?: any,
    metadataOverrides?: Record<string, any>,
    signal?: AbortSignal
  ) {
    return this.messageApi.sendMessage(
      content,
      sessionId,
      userId,
      messages,
      agentId,
      maxTokens,
      agent,
      metadataOverrides,
      signal
    )
  }

  async createZip(zipData: any) {
    return uploadApiService.createZip(zipData)
  }

  async getZip(zipId: string) {
    return uploadApiService.getZip(zipId)
  }

  async getZips(zipIds: string[]) {
    return uploadApiService.getZips(zipIds)
  }
}

export const api = {
  createZip: async (zipData: any, fetcher?: typeof fetch) => {
    return uploadApiService.createZip(zipData, fetcher)
  },

  getZip: async (zipId: string, fetcher?: typeof fetch) => {
    return uploadApiService.getZip(zipId, fetcher)
  },

  getZips: async (zipIds: string[], fetcher?: typeof fetch) => {
    return uploadApiService.getZips(zipIds, fetcher)
  }
}
