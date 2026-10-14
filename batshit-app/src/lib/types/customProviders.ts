export type CustomProviderHeaders = Record<string, string>

export interface CustomProviderSummary {
  id: string
  label: string
  baseUrl: string
  headers?: CustomProviderHeaders
  maskedKey: string
  /**
   * Whether the saved API key can be read (yes or no only; never the key). A
   * backup that leaves secrets out restores a provider with no key, and such a
   * provider is not registered at run time, so its connection is not Ready.
   */
  apiKeyUsable: boolean
  createdAt: string
  updatedAt: string
}

/** What a custom provider without a usable saved API key shows (connection and panel). */
export const CUSTOM_PROVIDER_KEY_NOT_USABLE =
  'The saved API key of this custom provider is missing or cannot be read. ' +
  'Enter its API key again under Settings → API Keys → Custom OpenAI-Compatible.'

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
