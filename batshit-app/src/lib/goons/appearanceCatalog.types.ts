export type AppearanceCreator = {
  id: string
  username: string
  profileUrl?: string
  portfolioUrl?: string
}

export type AppearanceCatalogSource = {
  targetId: string
  catalogId: string
  componentId: string
  contentSha256: string
  license: string
  title: string
  filename: string
  sourceUrl: string
  licenseUrl: string
  authorIds: string[]
  changes: string
}

/** Credited geometry already incorporated into the baseline, without an editable target. */
export type AppearanceCatalogBaseSource = Omit<AppearanceCatalogSource, 'targetId'> & {
  sourceId: string
}

export type AppearanceCatalogDial = {
  dialId: string
  origin: 'stock' | 'community' | 'original'
  tags: string[]
  sources: AppearanceCatalogSource[]
}

/** Source-authored discovery and credit data; never a license approval or value policy. */
export type AppearanceCatalog = {
  contract: 'appearance-catalog/v1'
  authors: AppearanceCreator[]
  dials: AppearanceCatalogDial[]
  baseSources?: AppearanceCatalogBaseSource[]
}
