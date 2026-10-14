const path = require('node:path')
const os = require('node:os')
const { realpathSync } = require('node:fs')

/** Resolve aliases, including a not-yet-created descendant of a real folder.
 * @param {string} value
 * @returns {string}
 */
function resolveExistingPath(value) {
  const absolute = path.resolve(value)
  // Darwin's native resolver returns the filesystem's canonical spelling on
  // case-insensitive volumes; the JS resolver can preserve a caller's alias.
  try { return realpathSync.native(absolute) } catch (error) {
    if (!(error instanceof Error) || !('code' in error) || error.code !== 'ENOENT') throw error
    const parent = path.dirname(absolute)
    if (parent === absolute) throw error
    return path.join(resolveExistingPath(parent), path.basename(absolute))
  }
}

/** @param {NodeJS.ProcessEnv} environment */
function macCustodyRoots(environment = process.env) {
  if (environment.BATSHIT_RUNTIME_OWNER !== 'mac-app' || environment.BATSHIT_CONTAINERIZED === '1') return []
  const data = environment.BATSHIT_MAC_DATA_DIR || path.join(os.homedir(), 'Library', 'Application Support', 'Batshit')
  if (!path.isAbsolute(data)) throw new Error('Mac data root must be an absolute folder.')
  const root = path.join(path.resolve(data), 'config')
  return [...new Set([root, resolveExistingPath(root)])]
}

/** @param {string} root @param {string} target */
function pathContains(root, target) {
  const relative = path.relative(root, target)
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative))
}

/** Parent reads/mounts expose the custody root too. No content is accessed here.
 * @param {string} value
 * @param {NodeJS.ProcessEnv} environment
 */
function assertMacCustodyPathAllowed(value, environment = process.env) {
  const roots = macCustodyRoots(environment)
  if (!roots.length) return
  for (const candidate of [path.resolve(value), resolveExistingPath(value)]) {
    if (roots.some(root => pathContains(root, candidate) || pathContains(candidate, root))) {
      throw new Error('Batshit credential storage is protected from file reads and sandbox mounts.')
    }
  }
}

module.exports = { macCustodyRoots, resolveExistingPath, pathContains, assertMacCustodyPathAllowed }
