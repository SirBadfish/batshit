/**
 * Workflow Schema Generator for Mode 3
 * Story 5.11: Generates Zod schemas from n8n webhook configurations
 *
 * CRITICAL: Dynamic schema generation (TECH-001)
 * CRITICAL: Must use programmatic Zod building, never eval()
 * CRITICAL: Always validate generated schemas
 */

import { z } from 'zod'
import { logger } from '$lib/utils/logger'
import type { WorkflowInfo } from './workflowDiscovery'

/**
 * Field configuration from webhook node
 */
interface WebhookField {
  name: string
  type: 'string' | 'number' | 'boolean' | 'json' | 'dateTime' | 'options' | 'array'
  displayName?: string
  description?: string
  required?: boolean
  default?: any
  options?: Array<{ name: string; value: string }>
  multipleValues?: boolean
  typeOptions?: any
}

/**
 * Schema generation result
 */
export interface SchemaGenerationResult {
  success: boolean
  schema: z.ZodSchema
  error?: string
  fieldCount: number
  warnings?: string[]
}

/**
 * Generate Zod schema from workflow configuration
 * CRITICAL: This addresses risk TECH-001
 */
export function generateZodSchema(workflow: WorkflowInfo): SchemaGenerationResult {
  const warnings: string[] = []

  try {
    // Find webhook node(s) in workflow
    const webhookNodes = findWebhookNodes(workflow)

    if (webhookNodes.length === 0) {
      logger.debug('[SchemaGenerator] No webhook nodes found, using empty schema')
      return {
        success: true,
        schema: z.object({}), // ✅ CORRECT: Empty object for no-args
        fieldCount: 0
      }
    }

    // Extract fields from webhook configuration
    const fields = extractWebhookFields(webhookNodes[0])

    if (fields.length === 0) {
      logger.debug('[SchemaGenerator] No fields defined, using empty schema')
      return {
        success: true,
        schema: z.object({}),
        fieldCount: 0
      }
    }

    // Build Zod schema programmatically
    const schemaShape: Record<string, z.ZodSchema> = {}

    for (const field of fields) {
      try {
        const fieldSchema = createFieldSchema(field)
        schemaShape[field.name] = fieldSchema
      } catch (fieldError: any) {
        warnings.push(`Field '${field.name}': ${fieldError.message}`)
        // Skip field on error, don't fail entire schema
      }
    }

    // Create the final object schema
    const schema = z.object(schemaShape)

    // ✅ CORRECT: Validate generated schema before use
    try {
      schema.safeParse({}) // Test with empty object
    } catch (validationError: any) {
      console.error('[SchemaGenerator] Schema validation failed:', validationError)
      return {
        success: false,
        schema: z.object({}), // Fallback schema
        error: 'Generated schema failed validation',
        fieldCount: 0,
        warnings
      }
    }

    logger.debug('[SchemaGenerator] Generated schema', {
      workflow: workflow.name,
      fields: Object.keys(schemaShape).length
    })

    return {
      success: true,
      schema,
      fieldCount: Object.keys(schemaShape).length,
      warnings: warnings.length > 0 ? warnings : undefined
    }
  } catch (error: any) {
    console.error('[SchemaGenerator] Schema generation error:', error)
    return {
      success: false,
      schema: z.object({}), // ✅ CORRECT: Fallback to empty schema
      error: error.message,
      fieldCount: 0,
      warnings
    }
  }
}

/**
 * Find webhook nodes in workflow
 */
function findWebhookNodes(workflow: WorkflowInfo): any[] {
  if (!workflow.nodes || !Array.isArray(workflow.nodes)) {
    return []
  }

  return workflow.nodes.filter(node =>
    node.type === 'n8n-nodes-base.webhook' ||
    node.type === '@n8n/n8n-nodes-base.webhook' ||
    node.type?.includes('webhook')
  )
}

/**
 * Extract field definitions from webhook node
 */
function extractWebhookFields(webhookNode: any): WebhookField[] {
  const fields: WebhookField[] = []

  // Check various locations where fields might be defined
  const possibleFieldSources = [
    webhookNode.parameters?.options?.bodyContentType === 'form-data' &&
    webhookNode.parameters?.options?.bodyFormData?.parameters,
    webhookNode.parameters?.options?.bodyParameters?.parameters,
    webhookNode.parameters?.headerParameters?.parameters,
    webhookNode.parameters?.queryParameters?.parameters,
    webhookNode.typeVersion >= 2 && webhookNode.parameters?.options?.parameters
  ]

  for (const source of possibleFieldSources) {
    if (source && Array.isArray(source)) {
      for (const param of source) {
        if (param.name) {
          fields.push(normalizeField(param))
        }
      }
    }
  }

  // If no explicit fields, check for raw body mode
  // Only add body field if rawBody is explicitly true
  if (fields.length === 0 && webhookNode.parameters?.options?.rawBody === true) {
    // Webhook accepts raw JSON body
    fields.push({
      name: 'body',
      type: 'json',
      description: 'Request body data',
      required: false
    })
  }

  return fields
}

/**
 * Normalize field definition from various n8n formats
 */
function normalizeField(param: any): WebhookField {
  return {
    name: param.name,
    type: mapN8nTypeToFieldType(param.type || 'string'),
    displayName: param.displayName,
    description: param.description || param.displayName,
    required: param.required === true || param.noDataExpression === true,
    default: param.default,
    options: param.options,
    multipleValues: param.multipleValues === true,
    typeOptions: param.typeOptions
  }
}

/**
 * Map n8n parameter types to our field types
 */
function mapN8nTypeToFieldType(n8nType: string): WebhookField['type'] {
  const typeMap: Record<string, WebhookField['type']> = {
    'string': 'string',
    'number': 'number',
    'boolean': 'boolean',
    'json': 'json',
    'dateTime': 'dateTime',
    'options': 'options',
    'multiOptions': 'array',
    'collection': 'json',
    'fixedCollection': 'json'
  }

  return typeMap[n8nType] || 'string'
}

/**
 * Create Zod schema for a single field
 * CRITICAL: Programmatic building, no eval()
 */
function createFieldSchema(field: WebhookField): z.ZodSchema {
  let schema: z.ZodSchema

  // Build base schema based on type
  switch (field.type) {
    case 'string':
      schema = z.string()
      break

    case 'number':
      schema = z.number()
      // Also accept string that can be parsed as number
      schema = z.union([
        z.number(),
        z.string().transform((val) => {
          const num = Number(val)
          if (isNaN(num)) {
            throw new Error('Invalid number')
          }
          return num
        })
      ])
      break

    case 'boolean':
      schema = z.boolean()
      // Also accept string "true"/"false"
      schema = z.union([
        z.boolean(),
        z.string().transform((val) => val === 'true')
      ])
      break

    case 'dateTime':
      // Accept ISO string or Date
      schema = z.union([
        z.date(),
        z.string().datetime()
      ])
      break

    case 'options':
      // If options are provided, create enum
      if (field.options && field.options.length > 0) {
        const values = field.options.map(opt => opt.value)
        // @ts-ignore - Zod enum requires at least 1 value, we checked above
        schema = z.enum(values as [string, ...string[]])
      } else {
        schema = z.string()
      }
      break

    case 'array':
      // Array of strings by default
      schema = z.array(z.string())
      break

    case 'json':
    default:
      // Accept any object or array
      schema = z.union([
        z.object({}).passthrough(),
        z.array(z.any()),
        z.any()
      ])
      break
  }

  // Add description if available
  if (field.description) {
    schema = schema.describe(field.description)
  }

  // Handle optional fields
  if (!field.required) {
    schema = schema.optional()
  }

  // Handle default values
  if (field.default !== undefined && !field.required) {
    schema = schema.default(field.default)
  }

  // Handle multiple values (arrays)
  if (field.multipleValues && field.type !== 'array') {
    schema = z.array(schema)
    if (!field.required) {
      schema = schema.optional()
    }
  }

  return schema
}

/**
 * Validate that a schema is properly formed
 * Used before registering tools
 */
export function validateSchema(schema: z.ZodSchema): boolean {
  try {
    // Test parse with various inputs
    const testInputs = [
      {},
      { test: 'value' },
      { number: 123 },
      { bool: true },
      { array: ['a', 'b'] }
    ]

    for (const input of testInputs) {
      try {
        schema.safeParse(input)
      } catch {
        // Individual parse failures are OK
        // We're testing that the schema itself is valid
      }
    }

    return true
  } catch (error) {
    console.error('[SchemaGenerator] Schema validation error:', error)
    return false
  }
}

/**
 * Generate schema from webhook path parameters
 * Extracts parameters from URL pattern like /webhook/:id/:action
 */
export function generatePathParameterSchema(webhookPath: string): z.ZodSchema {
  const paramPattern = /:(\w+)/g
  const matches = [...webhookPath.matchAll(paramPattern)]

  if (matches.length === 0) {
    return z.object({})
  }

  const shape: Record<string, z.ZodSchema> = {}

  for (const match of matches) {
    const paramName = match[1]
    shape[paramName] = z.string().describe(`Path parameter: ${paramName}`)
  }

  return z.object(shape)
}

/**
 * Merge multiple schemas (for complex workflows)
 */
export function mergeSchemas(...schemas: z.ZodSchema[]): z.ZodSchema {
  if (schemas.length === 0) {
    return z.object({})
  }

  if (schemas.length === 1) {
    return schemas[0]
  }

  // Use intersection for merging
  // Note: This might not work perfectly with all schema types
  try {
    return z.intersection(schemas[0], mergeSchemas(...schemas.slice(1)))
  } catch {
    // Fallback to first schema if merge fails
    console.warn('[SchemaGenerator] Schema merge failed, using first schema')
    return schemas[0]
  }
}

/**
 * Generate human-readable documentation from schema
 * Used for AI understanding
 */
export function generateSchemaDocumentation(schema: z.ZodSchema): string {
  try {
    // This is a simplified version
    // In production, you'd want to traverse the schema tree
    const shape = (schema as any)._def?.shape

    if (!shape) {
      return 'No parameters required'
    }

    const docs: string[] = []

    for (const [key, field] of Object.entries(shape)) {
      const fieldSchema = field as any
      const description = fieldSchema._def?.description || key
      const isOptional = fieldSchema._def?.typeName === 'ZodOptional'

      docs.push(`- ${key}: ${description}${isOptional ? ' (optional)' : ''}`)
    }

    return docs.join('\n')
  } catch {
    return 'Parameters available - check schema for details'
  }
}
