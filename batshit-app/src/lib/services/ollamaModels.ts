/**
 * Ollama Models Service
 * Handles fetching and managing Ollama models
 */

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modified_at: string;
}

export interface OllamaPullProgress {
  status: string;
  digest?: string;
  total?: number;
  completed?: number;
  percent?: number;
}

class OllamaModelsService {
  private defaultBaseUrl = 'http://localhost:11434';

  private resolveBaseUrl(baseUrl?: string) {
    const trimmed = baseUrl?.trim();
    if (!trimmed) return this.defaultBaseUrl;
    return trimmed.replace(/\/+$/, '');
  }

  /**
   * Fetch installed Ollama models
   */
  async getInstalledModels(baseUrl?: string): Promise<OllamaModel[]> {
    const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/api/tags`);
    if (!response.ok) {
      throw new Error(`Failed to fetch models: ${response.statusText}`);
    }

    const data = await response.json();
    return data.models || [];
  }

  /**
   * Pull a new Ollama model with progress tracking
   */
  async pullModel(
    modelName: string,
    onProgress?: (progress: OllamaPullProgress) => void,
    baseUrl?: string
  ): Promise<boolean> {
    try {
      const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/api/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });

      if (!response.ok) {
        throw new Error(`Failed to pull model: ${response.statusText}`);
      }

      const reader = response.body?.getReader();
      if (!reader) {
        throw new Error('No response body');
      }

      const decoder = new TextDecoder();
      
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        
        const chunk = decoder.decode(value);
        const lines = chunk.split('\n').filter(line => line.trim());
        
        for (const line of lines) {
          try {
            const data = JSON.parse(line);
            if (data.status && onProgress) {
              const progress: OllamaPullProgress = {
                status: data.status,
                digest: data.digest,
                total: data.total,
                completed: data.completed,
                percent: data.total ? Math.round((data.completed / data.total) * 100) : undefined
              };
              onProgress(progress);
            }
          } catch (e) {
            // Skip invalid JSON lines
          }
        }
      }
      
      return true;
    } catch (error) {
      console.error('Failed to pull model:', error);
      return false;
    }
  }

  /**
   * Delete an Ollama model
   */
  async deleteModel(modelName: string, baseUrl?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/api/delete`, {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ name: modelName })
      });

      return response.ok;
    } catch (error) {
      console.error('Failed to delete model:', error);
      return false;
    }
  }

  /**
   * Check if Ollama is running
   */
  async isOllamaRunning(baseUrl?: string): Promise<boolean> {
    try {
      const response = await fetch(`${this.resolveBaseUrl(baseUrl)}/api/version`);
      return response.ok;
    } catch {
      return false;
    }
  }
}

export const ollamaModels = new OllamaModelsService();
