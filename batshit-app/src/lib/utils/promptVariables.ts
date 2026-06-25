/**
 * Replaces variables in system prompts with their actual values
 * Supports variables like:
 * - {{ $buffer_terminal }} - Buffer size for terminal content
 * - {{ $buffer_code }} - Buffer size for code content
 * - {{ $current_date }} - Current date
 * - {{ $current_time }} - Current time
 * - {{ $current_datetime }} - Current date and time
 * - {{ $current_timezone }} - Current runtime timezone
 * - {{ $threshold_terminal }} - Token threshold for terminal
 * - {{ $threshold_code }} - Token threshold for code
 * - {{ $buffer_subagent }} - Buffer size for subagent conversations
 * - {{ $threshold_subagent }} - Token threshold for subagent conversations
 * - {{ $model_name }} - Current model name
 * - {{ $model_provider }} - Current model provider
 */
export function replacePromptVariables(
  prompt: string,
  agent?: any,
  additionalVars?: Record<string, any>
): string {
  if (!prompt) return prompt;

  const now = new Date();
  const runtimeTimeZone =
    Intl.DateTimeFormat().resolvedOptions().timeZone || 'local runtime timezone'
  const dateTimeOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };
  
  const dateOptions: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: 'long',
    day: 'numeric'
  };
  
  const timeOptions: Intl.DateTimeFormatOptions = {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true
  };

  // Build variable map
  const variables: Record<string, any> = {
    // Date/time variables
    current_date: now.toLocaleString('en-US', dateOptions),
    current_time: now.toLocaleString('en-US', timeOptions),
    current_datetime: now.toLocaleString('en-US', dateTimeOptions),
    current_timezone: runtimeTimeZone,
    
    // Agent settings
    buffer_size: agent?.buffer_size ?? 1,
    buffer_terminal: agent?.buffer_size_terminal ?? agent?.buffer_size ?? 1,
    buffer_diff: agent?.buffer_size_diff ?? agent?.buffer_size ?? 2,
    buffer_error: agent?.buffer_size_error ?? agent?.buffer_size ?? 2,
    buffer_subagent: agent?.buffer_size_subagent ?? agent?.buffer_size ?? 2,

    // Threshold settings
    threshold_terminal: agent?.zip_threshold_terminal ?? 0,
    threshold_diff: agent?.zip_threshold_diff ?? 0,
    threshold_error: agent?.zip_threshold_error ?? 0,
    threshold_subagent: agent?.zip_threshold_subagent ?? 0,
    
    // Model information
    model_name: agent?.primary_model_name || 'Not set',
    model_provider: agent?.primary_model_provider || 'Not set',
    model_temperature: agent?.primary_model_temperature?.toString() || 'Default',
    
    // Agent information
    agent_name: agent?.displayName || agent?.display_name || 'Unnamed',
    agent_id: agent?.id || 'Unknown',
    
    // Merge additional variables
    ...additionalVars
  };

  // Replace variables in the prompt
  let processedPrompt = prompt;
  
  // Replace all {{ $variable }} patterns
  processedPrompt = processedPrompt.replace(
    /\{\{\s*\$(\w+)\s*\}\}/g,
    (match, varName) => {
      if (varName in variables) {
        return String(variables[varName]);
      }
      // Return original if variable not found
      return match;
    }
  );
  
  return processedPrompt;
}
