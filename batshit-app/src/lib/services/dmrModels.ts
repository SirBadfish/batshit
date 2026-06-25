export interface DmrModel {
  name: string
  size?: number
  digest?: string
  createdAt?: string
}

class DmrModelsService {
  private defaultBaseUrl = 'http://localhost:12434'
  private defaultOpenAiPath = '/engines/llama.cpp/v1'

  private resolveBaseUrl(baseUrl?: string) {
    const trimmed = baseUrl?.trim()
    if (!trimmed) return this.defaultBaseUrl
    return trimmed.replace(/\/+$/, '')
  }

  private resolveOpenAiPath(openaiPath?: string) {
    const trimmed = openaiPath?.trim()
    if (!trimmed) return this.defaultOpenAiPath
    if (!trimmed.startsWith('/')) return `/${trimmed.replace(/\/+$/, '')}`
    return trimmed.replace(/\/+$/, '')
  }

  private isDigest(value?: string | null) {
    return typeof value === 'string' && value.startsWith('sha256:')
  }

  private extractRepoTag(source: any): string | null {
    if (!source || typeof source !== 'object') return null
    const repo =
      source.repo ||
      source.repository ||
      source.name ||
      source.model ||
      source.reference ||
      source.repo_name ||
      ''
    const tag =
      source.tag ||
      source.version ||
      source.tag_name ||
      source.tagName ||
      ''

    if (repo && tag) return `${repo}:${tag}`
    if (repo) return repo
    return null
  }

  private normalizeModelName(raw: any): string {
    if (!raw) return 'unknown'
    if (typeof raw === 'string') return raw

    const candidates: Array<string | null | undefined> = []

    if (raw.model && typeof raw.model === 'object') {
      candidates.push(this.extractRepoTag(raw.model))
      candidates.push(raw.model.reference, raw.model.id, raw.model.name)
    } else if (typeof raw.model === 'string') {
      candidates.push(raw.model)
    }

    candidates.push(
      this.extractRepoTag(raw),
      raw.image,
      raw.image_name,
      raw.repo_tag,
      raw.reference,
      raw.name
    )

    const cleaned = candidates
      .filter((value): value is string => typeof value === 'string' && value.trim().length > 0)
      .map((value) => value.trim())

    const nonDigest = cleaned.find((value) => !this.isDigest(value))
    if (nonDigest) return nonDigest

    const fallback =
      cleaned[0] ||
      raw.id ||
      raw.digest ||
      raw.sha ||
      raw.sha256 ||
      'unknown'
    return typeof fallback === 'string' ? fallback : 'unknown'
  }

  private async getOpenAiModels(baseUrl: string, openaiPath: string): Promise<string[]> {
    try {
      const response = await fetch(`${baseUrl}${openaiPath}/models`)
      if (!response.ok) {
        return []
      }
      const payload = await response.json().catch(() => null)
      const list = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
          ? payload.models
          : Array.isArray(payload)
            ? payload
            : []

      return list
        .map((entry: any) => {
          if (!entry) return null
          if (typeof entry === 'string') return entry
          return entry.id || entry.name || entry.model || null
        })
        .filter((value: any): value is string => Boolean(value))
    } catch (error) {
      return []
    }
  }

  async getInstalledModels(baseUrl?: string, openaiPath?: string): Promise<DmrModel[]> {
    const resolvedBaseUrl = this.resolveBaseUrl(baseUrl)
    const resolvedOpenAiPath = this.resolveOpenAiPath(openaiPath)
    const response = await fetch(`${resolvedBaseUrl}/models`)
    if (!response.ok) {
      throw new Error(`Failed to fetch Docker Model Runner models: ${response.statusText}`)
    }

    const data = await response.json().catch(() => null)
    const list = Array.isArray(data?.models)
      ? data.models
      : Array.isArray(data?.data)
        ? data.data
        : Array.isArray(data)
          ? data
          : []

    const normalized: DmrModel[] = list.map((entry: any) => ({
      name: this.normalizeModelName(entry),
      size: entry?.size ?? entry?.size_bytes ?? entry?.sizeBytes ?? entry?.bytes,
      digest: entry?.digest ?? entry?.sha ?? entry?.sha256,
      createdAt: entry?.created_at ?? entry?.createdAt
    }))

    const hasFriendlyName = normalized.some(
      (entry: DmrModel) => entry.name && !this.isDigest(entry.name) && entry.name !== 'unknown'
    )
    if (!hasFriendlyName) {
      const openAiModels = await this.getOpenAiModels(resolvedBaseUrl, resolvedOpenAiPath)
      if (openAiModels.length) {
        return openAiModels.map((name) => ({ name }))
      }
    }

    return normalized
  }

  async createModel(modelName: string, baseUrl?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/models/create`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: modelName })
      })

      return response.ok
    } catch (error) {
      console.error('Failed to create Docker Model Runner model:', error)
      return false
    }
  }

  async deleteModel(modelName: string, baseUrl?: string): Promise<boolean> {
    const sanitized = modelName
      .split('/')
      .map((part) => encodeURIComponent(part))
      .join('/')

    try {
      const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/models/${sanitized}`, {
        method: 'DELETE'
      })

      return response.ok
    } catch (error) {
      console.error('Failed to delete Docker Model Runner model:', error)
      return false
    }
  }

  async isRunnerAvailable(baseUrl?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/models`)
      return response.ok
    } catch {
      return false
    }
  }
}

export const dmrModels = new DmrModelsService()
