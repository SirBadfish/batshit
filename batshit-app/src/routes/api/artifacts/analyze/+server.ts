/**
 * Artifact URL Analyzer API
 * SA-007 Phase 4: Intelligent analysis before import
 *
 * POST /api/artifacts/analyze
 * Analyzes a URL and returns structured metadata about how to best
 * import or recreate the content as an Batshit artifact.
 */

import { json, error, type RequestHandler } from '@sveltejs/kit'
import { apiError } from '$lib/server/services/apiResponses'
import { resolveNativeToolUser } from '$lib/server/services/nativeToolAuth'
import { apiKeyService } from '$lib/services/apiKey.server'

interface AnalysisResult {
  sourceType: 'hf_space' | 'github' | 'gradio' | 'hf_other' | 'unknown'
  url: string
  analyzed: boolean
  analyzedAt: string

  // HuggingFace/Gradio specific
  sdkType?: string | null
  spaceName?: string | null
  spaceAuthor?: string | null
  spaceDescription?: string | null
  gradioEndpoints?: Array<{ name: string; inputs: string[]; outputs: string[] }>

  // GitHub specific
  repoName?: string | null
  repoOwner?: string | null
  repoDescription?: string | null
  hasDockerfile?: boolean
  hasPythonDeps?: boolean
  hasNodeDeps?: boolean
  readmeSummary?: string | null

  // UI elements detected
  detectedInputs?: string[]
  detectedOutputs?: string[]

  // Recommendations
  recommendedApproach?: 'api' | 'docker' | 'local' | 'recreate' | 'manual' | null
  recommendationReason?: string | null
  requiresToken?: boolean
  tokenType?: 'hf' | 'github' | null
  estimatedDependencies?: string[]

  // Error info
  error?: string
}

/**
 * Analyze a HuggingFace Space URL
 */
async function analyzeHuggingFaceUrl(
  url: string,
  hfToken: string | undefined,
  analysis: AnalysisResult
): Promise<AnalysisResult> {
  const parsedUrl = new URL(url)
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean)

  if (pathParts[0] === 'spaces' && pathParts.length >= 3) {
    analysis.sourceType = 'hf_space'
    analysis.spaceAuthor = pathParts[1]
    analysis.spaceName = pathParts[2]

    const headers: Record<string, string> = {}
    if (hfToken) {
      headers['Authorization'] = `Bearer ${hfToken}`
    }

    try {
      const apiUrl = `https://huggingface.co/api/spaces/${analysis.spaceAuthor}/${analysis.spaceName}`
      const resp = await fetch(apiUrl, { headers })

      if (resp.ok) {
        const data = await resp.json()
        analysis.spaceDescription = data.cardData?.short_description || data.description || null
        analysis.sdkType = data.sdk || null

        if (analysis.sdkType === 'gradio') {
          analysis.recommendedApproach = 'api'
          analysis.recommendationReason =
            'Gradio SDK detected - can use @gradio/client JavaScript API without installation'
          analysis.requiresToken = data.private || false
          analysis.tokenType = analysis.requiresToken ? 'hf' : null

          // Try to fetch Gradio API info
          const gradioApiUrl = `https://${analysis.spaceAuthor}-${analysis.spaceName}.hf.space/info`
          try {
            const gradioResp = await fetch(gradioApiUrl, { headers })
            if (gradioResp.ok) {
              const gradioInfo = await gradioResp.json()
              if (gradioInfo.api) {
                analysis.gradioEndpoints = Object.entries(gradioInfo.api).map(
                  ([name, info]: [string, any]) => ({
                    name,
                    inputs: info.parameters?.map((p: any) => p.label || p.parameter_name) || [],
                    outputs: info.returns?.map((r: any) => r.label || r.type) || []
                  })
                )
              }
            }
          } catch {
            // Gradio info endpoint might not be available
          }
        } else if (analysis.sdkType === 'streamlit') {
          analysis.recommendedApproach = 'docker'
          analysis.recommendationReason = 'Streamlit SDK requires running the app - Docker recommended'
          analysis.estimatedDependencies = ['python', 'streamlit']
        } else if (analysis.sdkType === 'docker') {
          analysis.recommendedApproach = 'docker'
          analysis.recommendationReason = 'Docker-based Space - use Docker to run locally'
        } else {
          analysis.recommendedApproach = 'recreate'
          analysis.recommendationReason = `Unknown SDK type (${analysis.sdkType}) - consider recreating functionality`
        }
      } else if (resp.status === 401 || resp.status === 403) {
        analysis.requiresToken = true
        analysis.tokenType = 'hf'
        analysis.recommendedApproach = 'api'
        analysis.recommendationReason = 'Private Space - requires HF_TOKEN to access'
      }
    } catch (e: any) {
      console.error(`[analyzeHuggingFaceUrl] API fetch error: ${e.message}`)
    }
  } else {
    analysis.sourceType = 'hf_other'
    analysis.recommendedApproach = 'manual'
    analysis.recommendationReason =
      'This appears to be a HuggingFace model/dataset page, not a Space. Consider finding an associated Space or building a custom interface.'
  }

  return analysis
}

/**
 * Analyze a GitHub repository URL
 */
async function analyzeGitHubUrl(
  url: string,
  githubToken: string | undefined,
  analysis: AnalysisResult
): Promise<AnalysisResult> {
  const parsedUrl = new URL(url)
  const pathParts = parsedUrl.pathname.split('/').filter(Boolean)

  if (pathParts.length >= 2) {
    analysis.sourceType = 'github'
    analysis.repoOwner = pathParts[0]
    analysis.repoName = pathParts[1]

    const headers: Record<string, string> = {
      Accept: 'application/vnd.github.v3+json'
    }
    if (githubToken) {
      headers['Authorization'] = `Bearer ${githubToken}`
    }

    try {
      // Fetch repo info
      const repoUrl = `https://api.github.com/repos/${analysis.repoOwner}/${analysis.repoName}`
      const repoResp = await fetch(repoUrl, { headers })

      if (repoResp.ok) {
        const repoData = await repoResp.json()
        analysis.repoDescription = repoData.description || null

        // Check for key files
        const contentsUrl = `https://api.github.com/repos/${analysis.repoOwner}/${analysis.repoName}/contents`
        const contentsResp = await fetch(contentsUrl, { headers })

        if (contentsResp.ok) {
          const contents = await contentsResp.json()
          const fileNames = contents.map((f: any) => f.name.toLowerCase())

          analysis.hasDockerfile = fileNames.includes('dockerfile')
          analysis.hasPythonDeps = fileNames.includes('requirements.txt') || fileNames.includes('pyproject.toml')
          analysis.hasNodeDeps = fileNames.includes('package.json')

          // Determine recommendation based on files
          if (analysis.hasDockerfile) {
            analysis.recommendedApproach = 'docker'
            analysis.recommendationReason = 'Dockerfile found - Docker installation recommended'
            analysis.estimatedDependencies = ['docker']
          } else if (analysis.hasPythonDeps) {
            analysis.recommendedApproach = 'local'
            analysis.recommendationReason = 'Python project - clone and set up virtual environment'
            analysis.estimatedDependencies = ['python', 'pip']
          } else if (analysis.hasNodeDeps) {
            analysis.recommendedApproach = 'local'
            analysis.recommendationReason = 'Node.js project - clone and npm install'
            analysis.estimatedDependencies = ['node', 'npm']
          } else {
            analysis.recommendedApproach = 'recreate'
            analysis.recommendationReason = 'No standard build system detected - consider recreating functionality'
          }

          // Try to get README summary
          const readmeFile = contents.find(
            (f: any) => f.name.toLowerCase() === 'readme.md' || f.name.toLowerCase() === 'readme'
          )
          if (readmeFile) {
            try {
              const readmeResp = await fetch(readmeFile.download_url)
              if (readmeResp.ok) {
                const readmeText = await readmeResp.text()
                analysis.readmeSummary = readmeText.substring(0, 800)
              }
            } catch {
              // README fetch failed, not critical
            }
          }
        }
      } else if (repoResp.status === 401 || repoResp.status === 403 || repoResp.status === 404) {
        analysis.requiresToken = true
        analysis.tokenType = 'github'
        analysis.recommendedApproach = 'manual'
        analysis.recommendationReason = 'Private or inaccessible repo - requires GITHUB_TOKEN'
      }
    } catch (e: any) {
      console.error(`[analyzeGitHubUrl] API fetch error: ${e.message}`)
    }
  }

  return analysis
}

/**
 * Analyze a standalone Gradio URL
 */
async function analyzeGradioUrl(url: string, analysis: AnalysisResult): Promise<AnalysisResult> {
  analysis.sourceType = 'gradio'

  try {
    // Try to fetch /info endpoint
    const infoUrl = url.replace(/\/$/, '') + '/info'
    const resp = await fetch(infoUrl)

    if (resp.ok) {
      const info = await resp.json()
      if (info.api) {
        analysis.gradioEndpoints = Object.entries(info.api).map(([name, data]: [string, any]) => ({
          name,
          inputs: data.parameters?.map((p: any) => p.label || p.parameter_name) || [],
          outputs: data.returns?.map((r: any) => r.label || r.type) || []
        }))
      }
      analysis.recommendedApproach = 'api'
      analysis.recommendationReason = 'Gradio app detected - can use @gradio/client JavaScript API'
    } else {
      analysis.recommendedApproach = 'recreate'
      analysis.recommendationReason = 'Could not detect Gradio API - consider recreating functionality'
    }
  } catch {
    analysis.recommendedApproach = 'recreate'
    analysis.recommendationReason = 'Could not analyze Gradio app - consider recreating functionality'
  }

  return analysis
}

/**
 * Analyze an unknown URL
 */
async function analyzeUnknownUrl(url: string, analysis: AnalysisResult): Promise<AnalysisResult> {
  // Try to detect if it's a Gradio app
  try {
    const infoUrl = url.replace(/\/$/, '') + '/info'
    const resp = await fetch(infoUrl, { signal: AbortSignal.timeout(5000) })

    if (resp.ok) {
      const info = await resp.json()
      if (info.api) {
        // It's a Gradio app!
        analysis.sourceType = 'gradio'
        analysis.gradioEndpoints = Object.entries(info.api).map(([name, data]: [string, any]) => ({
          name,
          inputs: data.parameters?.map((p: any) => p.label || p.parameter_name) || [],
          outputs: data.returns?.map((r: any) => r.label || r.type) || []
        }))
        analysis.recommendedApproach = 'api'
        analysis.recommendationReason = 'Gradio app detected - can use @gradio/client JavaScript API'
        return analysis
      }
    }
  } catch {
    // Not a Gradio app, continue
  }

  analysis.recommendedApproach = 'manual'
  analysis.recommendationReason =
    'Unknown source type - manually inspect the page and consider recreating the functionality'
  return analysis
}

export const POST: RequestHandler = async ({ request, locals }) => {
  const body = (await request.json().catch(() => ({}))) as {
    url?: string
    hfToken?: string
    githubToken?: string
    userId?: string | null
  }

  const auth = await resolveNativeToolUser({
    request,
    localsUserId: locals.user?.id ?? null,
    claimedUserId: body.userId ?? null
  })

  if (!auth?.userId) {
    return apiError('Unauthorized', 401)
  }

  const { url, hfToken, githubToken } = body

  if (!url) {
    throw error(400, 'URL is required')
  }

  // Validate URL
  let parsedUrl: URL
  try {
    parsedUrl = new URL(url)
  } catch {
    throw error(400, 'Invalid URL')
  }

  const analysis: AnalysisResult = {
    sourceType: 'unknown',
    url,
    analyzed: true,
    analyzedAt: new Date().toISOString(),
    gradioEndpoints: [],
    detectedInputs: [],
    detectedOutputs: [],
    estimatedDependencies: [],
    requiresToken: false
  }

  const hostname = parsedUrl.hostname.toLowerCase()
  const normalizedHfToken =
    typeof hfToken === 'string' && hfToken.trim().length > 0 ? hfToken.trim() : null
  const normalizedGithubToken =
    typeof githubToken === 'string' && githubToken.trim().length > 0 ? githubToken.trim() : null

  const resolvedHfToken =
    normalizedHfToken ??
    (await apiKeyService
      .retrieve('huggingface', auth.userId)
      .then((value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null))
      .catch(() => null))
  const resolvedGithubToken =
    normalizedGithubToken ??
    (await apiKeyService
      .retrieve('github', auth.userId)
      .then((value) => (typeof value === 'string' && value.trim().length > 0 ? value.trim() : null))
      .catch(() => null))

  try {
    if (hostname === 'huggingface.co' || hostname === 'www.huggingface.co') {
      return json(await analyzeHuggingFaceUrl(url, resolvedHfToken ?? undefined, analysis))
    } else if (hostname === 'github.com' || hostname === 'www.github.com') {
      return json(await analyzeGitHubUrl(url, resolvedGithubToken ?? undefined, analysis))
    } else if (hostname.includes('hf.space') || hostname.includes('gradio')) {
      return json(await analyzeGradioUrl(url, analysis))
    } else {
      return json(await analyzeUnknownUrl(url, analysis))
    }
  } catch (e: any) {
    console.error(`[analyze] Error analyzing ${url}:`, e)
    analysis.error = e.message
    analysis.recommendedApproach = 'manual'
    analysis.recommendationReason = `Could not analyze URL: ${e.message}`
    return json(analysis)
  }
}
