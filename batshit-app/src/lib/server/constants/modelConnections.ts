export const CONNECTION_CREDENTIAL_MAP: Record<string, string[]> = {
  'vercel-gateway': [],
  'openrouter': ['openRouterApi'],
  'direct:anthropic': ['anthropicApi'],
  'direct:openai': ['openAiApi'],
  'direct:google': ['googlePalmApi'],
  'direct:mistral': ['mistralCloudApi'],
  'direct:groq': ['groqApi'],
  'direct:xai': [],
  'direct:deepseek': ['deepSeekApi'],
  'direct:moonshot': [],
  'direct:minimax': [],
  'direct:mimo': [],
  'direct:qwencloud': [],
  'direct:qwen_token_plan': [],
  'direct:alibaba': [],
  'direct:stepfun': [],
  'direct:zai': [],
  'direct:zai_coding': [],
  'direct:fal': [],
  'direct:luma': [],
  'direct:replicate': [],
  'direct:elevenlabs': [],
  'direct:deepgram': [],
  'direct:assemblyai': [],
  'direct:cohere': [],
  'direct:deepinfra': [],
  'direct:togetherai': [],
  'direct:fireworks': [],
  'direct:baseten': [],
  'direct:cerebras': [],
  'direct:ollama': [],
  'direct:dmr': [],
  'direct:lmstudio': [],
  'direct:llama-cpp': [],
  'direct:vllm': [],
  'direct:huggingface': ['huggingFaceApi'],
  'azure-openai': ['azureOpenAiApi'],
  'aws-bedrock': ['aws'],
  'google-vertex': ['googleVertexAiOAuth2Api'],
  'codex-cli': [],
  'claude-cli': []
}

export const N8N_ONLY_CONNECTION_IDS = new Set([
  'direct:huggingface',
  'azure-openai',
  'aws-bedrock',
  'google-vertex'
])

export function gatherCredentialTypes(connectionIds: string[]): string[] {
  const collected = new Set<string>()
  for (const id of connectionIds) {
    const list = CONNECTION_CREDENTIAL_MAP[id]
    if (!list?.length) continue
    for (const credential of list) {
      if (credential) collected.add(credential)
    }
  }
  return Array.from(collected)
}
