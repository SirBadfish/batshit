function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
}

export function applyUnavailableWebSearchMetadata(value: unknown): unknown {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return value
  }

  const result = { ...(value as Record<string, any>) }
  const queries = Array.isArray(result.queries)
    ? result.queries.filter(isNonEmptyString)
    : Array.isArray(result.action?.queries)
      ? result.action.queries.filter(isNonEmptyString)
      : []
  const query = isNonEmptyString(result.query)
    ? result.query
    : isNonEmptyString(result.action?.query)
      ? result.action.query
      : queries[0]
  const actionType = isNonEmptyString(result.action?.type)
    ? result.action.type
    : isNonEmptyString(result.type)
      ? result.type
      : undefined
  const results = Array.isArray(result.results) ? result.results : []
  const fallbackUrl = isNonEmptyString(result.url)
    ? result.url
    : isNonEmptyString(result.link)
      ? result.link
      : undefined
  const shouldMarkUnavailable =
    results.length === 0 &&
    !fallbackUrl &&
    result.resultsUnavailable !== true &&
    queries.length > 0 &&
    (actionType === 'search' || actionType === 'web_search_call')

  if (queries.length > 0 && !Array.isArray(result.queries)) {
    result.queries = queries
  }

  if (query && !isNonEmptyString(result.query)) {
    result.query = query
  }

  if (shouldMarkUnavailable) {
    result.resultsUnavailable = true
    if (
      typeof result.totalMatches !== 'number' &&
      typeof result.total_matches !== 'number' &&
      typeof result.count !== 'number'
    ) {
      result.totalMatches = 0
    }
  }

  return result
}
