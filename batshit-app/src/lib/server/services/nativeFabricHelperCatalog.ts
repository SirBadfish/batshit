/**
 * Identity, title, and schema hint for the Fabric controls Batshit serves from code rather
 * than from the control registry.
 *
 * SA-096 P4. `nativeTools.ts` owns their input schemas and execution; the DCM capability
 * index needs only their identity and hint text so the Fabric group can state a truthful
 * count. Splitting the metadata out avoids pulling the whole native-tools module into the
 * index, and keeps one definition of what these controls are called.
 */

export interface NativeFabricHelperControlMeta {
  controlId: string
  title: string
  description: string
  schemaHint: string
  tags: string[]
}

export const NATIVE_FABRIC_HELPER_CONTROL_META: NativeFabricHelperControlMeta[] = [
  {
    controlId: 'sys.zip.fetch',
    title: 'Fetch Zip',
    description: 'Fetch an existing Batshit zip by ID without changing unzip state.',
    schemaHint: 'zipId (required), includeContent?, maxChars?',
    tags: ['zip', 'fetch', 'context', 'tool-result']
  },
  {
    controlId: 'sys.comfyui.workflows',
    title: 'ComfyUI Workflows',
    description:
      'List or fetch ComfyUI saved workflows through Batshit host runtime URL aliases.',
    schemaHint:
      'action=list|get, baseUrl?, workflowName? for get, includeWorkflow?, limit?, timeoutMs?',
    tags: ['comfyui', 'workflow', 'artifact', 'runtime']
  },
  {
    controlId: 'sys.comfyui.object_info',
    title: 'ComfyUI Object Info',
    description: 'Fetch targeted ComfyUI /object_info schema through Batshit host runtime URL aliases.',
    schemaHint: 'baseUrl?, includeSchema?, classTypes?, maxNodes?, timeoutMs?',
    tags: ['comfyui', 'object_info', 'schema', 'artifact', 'runtime']
  }
]
