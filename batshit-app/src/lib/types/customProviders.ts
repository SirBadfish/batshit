export type CustomProviderHeaders = Record<string, string>

export interface CustomProviderSummary {
  id: string
  label: string
  baseUrl: string
  headers?: CustomProviderHeaders
  maskedKey: string
  createdAt: string
  updatedAt: string
}

export interface CustomProviderRuntime {
  id: string
  label: string
  baseUrl: string
  apiKey: string
  headers?: CustomProviderHeaders
}

export interface CustomProviderUpsertInput {
  id?: string | null
  label: string
  baseUrl: string
  apiKey?: string | null
  headers?: CustomProviderHeaders | null
}
