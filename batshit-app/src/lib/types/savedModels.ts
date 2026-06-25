// Type definitions for saved AI models

export interface PricingTier {
  from: number;
  to: number;
  costPerMillion: number;
}

export type ModelCompatibilityLabel = 'both' | 'n8n_only' | 'batshit_only'

export type ModelTransport = 'vercel-gateway' | 'direct' | 'openrouter'

export type ModelPurpose = 'chat' | 'visual' | 'audio' | 'utility'

export type ImageTransport = 'auto' | 'url'

export type ModelVoiceSessionRuntime = 'livekit'

export type ModelVoiceSessionMode = 'speech-to-speech'

export type ModelVoiceSessionSupportStatus = 'supported' | 'planned' | 'watchlist'

export type ModelVoiceSessionTranscriptTiming =
  | 'realtime'
  | 'delayed'
  | 'provider-dependent'
  | 'unsupported'

export type ModelVoiceSessionToolSupport = 'batshit-bridge' | 'provider-native' | 'limited' | 'none'

export interface ModelVoiceSessionConfig {
  runtime: ModelVoiceSessionRuntime
  mode: ModelVoiceSessionMode
  providerId: string
  providerLabel?: string
  adapterId?: string
  defaultModelId?: string
  defaultVoiceId?: string
  includes?: {
    stt?: boolean
    llm?: boolean
    tts?: boolean
  }
  requiresLiveKit?: boolean
  locksVoiceModeSettings?: boolean
  supportStatus?: ModelVoiceSessionSupportStatus
  nodeSupport?: boolean
  pythonSupport?: boolean
  transcriptTiming?: ModelVoiceSessionTranscriptTiming
  toolSupport?: ModelVoiceSessionToolSupport
  notes?: string[]
}

export interface ModelConnectionInfo {
  id?: string
  type: ModelTransport
  service?: string
  useDeveloperPrefix?: boolean
}

export interface ModelCompatibility {
  provider: string
  n8n: boolean
  batshit: boolean
  label: ModelCompatibilityLabel
  note?: string
}

export interface ModelCapabilities {
  streaming?: boolean
  tools?: boolean
  vision?: boolean
  jsonMode?: boolean
  reasoning?: boolean
  cacheControl?: boolean
  longContext?: boolean
  code?: boolean
  fast?: boolean
  audio?: boolean
  image?: boolean
}

export interface ModelEnrichmentSnapshot {
  source: 'artificial-analysis' | 'provider-manager' | 'vercel-catalog'
  fetchedAt: string
  modelName?: string
  modelId?: string
  maxOutputTokens?: number
  maxOutputTokensEstimated?: boolean
  maxOutputTokensEstimateReason?: 'missing' | 'unsafe'
  contextWindow?: number
  pricing?: {
    input?: number
    output?: number
    cachedInput?: number
  }
  capabilities?: ModelCapabilities
  identifier?: string
  provider?: string
  connectionId?: string
}

export interface SavedModel {
  id: string; // Unique ID for the saved model entry
  modelId: string; // The actual model ID like "claude-3-sonnet-20240229"
  modelName: string; // Display name/nickname like "Claude 3 Sonnet"
  provider: string; // Provider like "anthropic", "openai", etc.
  purpose?: ModelPurpose; // chat | visual | audio | utility
  contextWindow: number; // Context window size in tokens
  iconPath?: string; // Optional custom icon path for the model
  
  // Pricing can be either simple (single number) or tiered
  pricing: {
    input: number | PricingTier[];
    output: number | PricingTier[];
    cachedInput?: number; // Optional, not all models support caching
  };
  
  // Model settings - all the parameters that can be configured
  settings?: {
    temperature?: number;
    maxTokens?: number;
    topP?: number;
    topK?: number;
    frequencyPenalty?: number;
    presencePenalty?: number;
    repetitionPenalty?: number;
    seed?: number;
    reasoningEffort?: string;
    stop?: string[];
    responseFormat?: string;
    logitBias?: Record<string, number>;
    toolChoice?: string;
    stream?: boolean;
    user?: string;
    // Provider-specific settings
    [key: string]: any;
  };

  capabilities?: ModelCapabilities;
  voiceSession?: ModelVoiceSessionConfig;
  compatibility?: ModelCompatibility;
  enrichment?: ModelEnrichmentSnapshot;
  isVercelImport?: boolean;
  vercelSourceId?: string;
  vercelDisplayName?: string;
  connection?: ModelConnectionInfo;
  imageTransport?: ImageTransport;
  
  createdAt: string;
  updatedAt: string;
}

// Helper type guards
export function isTieredPricing(pricing: number | PricingTier[]): pricing is PricingTier[] {
  return Array.isArray(pricing);
}

// Helper function to format context window with commas
export function formatContextWindow(tokens: number): string {
  return tokens.toLocaleString();
}

// Helper function to parse context window input (removes commas)
export function parseContextWindow(input: string): number {
  return parseInt(input.replace(/,/g, ''), 10);
}
