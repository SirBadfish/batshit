/** Shared V2 language-model reader. A partial page set is never enrichment data. */
export const ARTIFICIAL_ANALYSIS_MODELS_URL = 'https://artificialanalysis.ai/api/v2/language/models/free'

export async function fetchArtificialAnalysisCatalog<T extends { slug?: string; name?: string }>({
  apiKey,
  apiUrl = ARTIFICIAL_ANALYSIS_MODELS_URL,
  signal
}: { apiKey: string; apiUrl?: string; signal?: AbortSignal }): Promise<T[]> {
  const models: T[] = []
  const slugs = new Set<string>()
  const deadline = AbortSignal.timeout(60_000)
  const requestSignal = signal ? AbortSignal.any([signal, deadline]) : deadline
  let totalPages: number | undefined
  let pageSize: number | undefined
  for (let page = 1; page <= 100; page += 1) {
    const url = new URL(apiUrl)
    url.searchParams.set('page', String(page))
    const response = await fetch(url.toString(), {
      headers: { 'x-api-key': apiKey, Accept: 'application/json' },
      signal: requestSignal,
      redirect: 'error'
    })
    if (!response.ok) throw new Error(`Artificial Analysis API request failed (${response.status})`)
    const payload = await response.json()
    const pagination = payload?.pagination
    if (!Array.isArray(payload?.data) || !payload.data.length ||
        !pagination || pagination.page !== page ||
        !Number.isSafeInteger(pagination.page_size) || pagination.page_size < 1 ||
        payload.data.length > pagination.page_size ||
        (pagination.has_more === true && payload.data.length !== pagination.page_size) ||
        (pageSize !== undefined && pageSize !== pagination.page_size) ||
        !Number.isSafeInteger(pagination.total_pages) || pagination.total_pages < page || pagination.total_pages > 100 ||
        typeof pagination.has_more !== 'boolean' ||
        pagination.has_more !== (page < pagination.total_pages) ||
        (totalPages !== undefined && totalPages !== pagination.total_pages)) {
      throw new Error('Artificial Analysis API returned an incomplete or invalid model page')
    }
    totalPages = pagination.total_pages
    pageSize = pagination.page_size
    for (const model of payload.data) {
      if (!model || typeof model.slug !== 'string' || !model.slug.trim() ||
          typeof model.name !== 'string' || !model.name.trim() || slugs.has(model.slug)) {
        throw new Error('Artificial Analysis API returned an invalid or repeated model')
      }
      slugs.add(model.slug)
      models.push(model as T)
    }
    if (!pagination.has_more) return models
  }
  throw new Error('Artificial Analysis API pagination exceeded its limit')
}
