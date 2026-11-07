const path = require('node:path')
const os = require('node:os')
const { realpathSync, statSync } = require('node:fs')

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

const DOCKER_PLAN_VOLUME = '/var/lib/batshit-plan'

/** Pure deployment configuration, never request/proxy-selected authority. */
function chatgptPlanDeployment(environment = process.env, platform = process.platform) {
  let origin
  try { origin = new URL(environment.ORIGIN || '') } catch { return null }
  if (origin.protocol !== 'http:' || !origin.port || origin.pathname !== '/' || origin.username || origin.password || origin.search || origin.hash) return null
  const containerized = environment.BATSHIT_CONTAINERIZED === '1' || environment.BATSHIT_RUNTIME_ENV === 'docker'
  if (platform === 'darwin' && environment.BATSHIT_RUNTIME_OWNER === 'mac-app' && !containerized) {
    const root = environment.BATSHIT_MAC_DATA_DIR
    if (!root || !path.isAbsolute(root) || origin.hostname !== '127.0.0.1' || origin.port !== environment.BATSHIT_FRONTEND_PORT) return null
    return { mode: 'mac-app', root: path.resolve(root), custodyRoot: path.join(path.resolve(root), 'config', 'chatgpt-plan'), origin: origin.origin, callbackMode: 'listener', callbackOrigin: null }
  }
  if (environment.BATSHIT_RUNTIME_OWNER === 'pinokio' && !containerized) {
    const nativeMac = platform === 'darwin' && (!environment.BATSHIT_PINOKIO_LAUNCH_PROFILE || environment.BATSHIT_PINOKIO_LAUNCH_PROFILE === 'native')
    const windowsWsl = platform === 'linux' && environment.BATSHIT_PINOKIO_HOST === 'windows-wsl' && environment.BATSHIT_PINOKIO_LAUNCH_PROFILE === 'windows-wsl'
    const root = environment.BATSHIT_RUNTIME_DATA_DIR
    if ((!nativeMac && !windowsWsl) || !root || !path.isAbsolute(root) || origin.hostname !== '127.0.0.1' || origin.port !== '5650' || environment.PORT !== '5650') return null
    return { mode: windowsWsl ? 'pinokio-windows-wsl' : 'pinokio-mac', root: path.resolve(root), custodyRoot: path.join(path.resolve(root), 'chatgpt-plan'), origin: origin.origin, callbackMode: 'app-port', callbackOrigin: origin.origin }
  }
  if (platform === 'linux' && containerized && environment.BATSHIT_CHATGPT_PLAN_DEPLOYMENT === 'local-docker' &&
      environment.BATSHIT_CHATGPT_PLAN_BIND_HOST === '127.0.0.1' && ['localhost', '127.0.0.1'].includes(origin.hostname) &&
      origin.port === environment.BATSHIT_CHATGPT_PLAN_PUBLISHED_PORT) {
    return { mode: 'docker-local', root: DOCKER_PLAN_VOLUME, custodyRoot: path.join(DOCKER_PLAN_VOLUME, 'custody'), origin: origin.origin, callbackMode: 'app-port', callbackOrigin: `http://127.0.0.1:${origin.port}` }
  }
  return null
}

/** Guard storage even when enrollment is unavailable or its origin is misconfigured. */
function credentialCustodyRoots(environment = process.env) {
  const roots = macCustodyRoots(environment)
  if (environment.BATSHIT_CONTAINERIZED === '1' || environment.BATSHIT_RUNTIME_ENV === 'docker') roots.push(DOCKER_PLAN_VOLUME)
  else if (environment.BATSHIT_RUNTIME_OWNER === 'pinokio') {
    const runtime = environment.BATSHIT_RUNTIME_DATA_DIR
    if (!runtime || !path.isAbsolute(runtime)) throw new Error('Pinokio runtime custody requires an absolute data folder.')
    roots.push(path.join(runtime, 'chatgpt-plan'), path.join(runtime, '..', 'batshit.env'))
  }
  return [...new Set(roots.flatMap(root => [path.resolve(root), resolveExistingPath(root)]))]
}

/** @param {string} file */
function credentialMetadata(file) {
  try { return statSync(file) } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') return null
    throw new Error('Batshit credential storage metadata could not be checked.')
  }
}

/** Only known custody files; never walk a user folder. @param {string[]} roots */
function knownCredentialFiles(roots) {
  const databases = ['owner.sqlite', 'credentials.sqlite'].flatMap(name => ['', '-journal', '-wal', '-shm'].map(suffix => name + suffix))
  return roots.flatMap(root => credentialMetadata(root)?.isFile() ? [root] :
    [root, path.join(root, 'runtime.env'), path.join(root, 'api-key-encryption.key'),
      ...['', 'chatgpt-plan', 'custody'].flatMap(folder => [...databases, 'vault.key'].map(name => path.join(root, folder, name)))])
}

/** A directory can hide an arbitrary hardlink descendant. Refuse mount admission
 * while a known credential has any alias instead of scanning arbitrary trees.
 * @param {NodeJS.ProcessEnv} environment
 */
function assertCredentialMountsSafe(environment = process.env) {
  for (const file of knownCredentialFiles(credentialCustodyRoots(environment))) {
    const metadata = credentialMetadata(file)
    if (metadata?.isFile() && metadata.nlink !== 1) throw new Error('Batshit credential storage has a hardlink alias; refusing sandbox mounts.')
  }
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
  const roots = credentialCustodyRoots(environment)
  if (!roots.length) return
  for (const candidate of [path.resolve(value), resolveExistingPath(value)]) {
    if (roots.some(root => pathContains(root, candidate) || pathContains(candidate, root))) {
      throw new Error('Batshit credential storage is protected from file reads and sandbox mounts.')
    }
  }
  // A hardlink has a different realpath. Compare only the known credential/key
  // files, not arbitrary user directory trees, and preserve ordinary hardlinks.
  const candidate = credentialMetadata(value)
  if (!candidate?.isFile() || candidate.nlink === 1) return
  for (const file of knownCredentialFiles(roots)) {
      const protectedFile = credentialMetadata(file)
      if (protectedFile?.isFile() && candidate.dev === protectedFile.dev && candidate.ino === protectedFile.ino) {
        throw new Error('Batshit credential storage is protected from file reads and sandbox mounts.')
      }
  }
}

module.exports = { macCustodyRoots, credentialCustodyRoots, assertCredentialMountsSafe, chatgptPlanDeployment, resolveExistingPath, pathContains, assertMacCustodyPathAllowed }
