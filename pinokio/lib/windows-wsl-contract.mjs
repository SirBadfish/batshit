import { win32 } from 'node:path';

export const WSL_PROTOCOL = 1;
export const WSL_DISTRO_NAME = 'Batshit-Pinokio';
export const WSL_USER = 'batshit';
export const WSL_HOME = '/home/batshit';
export const WSL_CODE = `${WSL_HOME}/batshit-code`;
export const WSL_NODE_PREFIX = `${WSL_HOME}/.local/batshit-node`;
export const WSL_NODE = `${WSL_NODE_PREFIX}/current/bin/node`;
export const WSL_NODE_VERSION = 'v24.19.0';
export const WSL_BOOTSTRAP_VERSION = 1;
export const WSL_RUNTIME_OS = 'ubuntu-24.04';
export const WSL_ASSETS = Object.freeze([
  { name: 'ubuntu-base', file: 'ubuntu-base-24.04.3-base-amd64.tar.gz', url: 'https://cdimage.ubuntu.com/ubuntu-base/releases/24.04.3/release/ubuntu-base-24.04.3-base-amd64.tar.gz', sha256: '6bc2cde3930ad088b3bb46fa45279e96d25bc3810f209850ecbe4722711874f9' },
  { name: 'node', file: 'node-v24.19.0-linux-x64.tar.xz', url: 'https://nodejs.org/dist/v24.19.0/node-v24.19.0-linux-x64.tar.xz', sha256: '14b342e71204f811bde6153be8e04b62aef63c236fef92b55f9c83154b409647' }
]);

export const WSL_ENV = Object.freeze({
  HOME: WSL_HOME, USER: WSL_USER, LANG: 'C.UTF-8',
  PATH: `${WSL_NODE_PREFIX}/current/bin:/usr/bin:/bin`,
  BATSHIT_PINOKIO_HOST: 'windows-wsl',
  BATSHIT_PINOKIO_LAUNCH_PROFILE: 'windows-wsl',
  BATSHIT_PINOKIO_ENGINE_STOP_POLICY: 'all-owned'
});

export function validateWindowsRelease({ release, commit, declaredRelease, protocol }) {
  if (!/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release) || !/^[a-f0-9]{40}$/.test(commit)) {
    throw new Error('The Windows launcher must name a released tag and its exact commit.');
  }
  if (declaredRelease.trim() !== release || protocol?.version !== WSL_PROTOCOL || protocol.platform !== 'windows-wsl2' || protocol.dataLayout !== 1) {
    throw new Error('This Batshit release does not include the Windows WSL installer. Wait for a Windows-capable release.');
  }
  return { release, commit };
}

export function windowsPathToGuest(path) {
  if (typeof path !== 'string' || !/^[a-z]:\\/i.test(path) || path.includes('\0') || /[\r\n]/.test(path) || path.slice(2).includes(':')) {
    throw new Error('A local Windows drive path is required; network paths and alternate streams are unsupported.');
  }
  const normalized = win32.normalize(path);
  return `/mnt/${normalized[0].toLowerCase()}${normalized.slice(2).replaceAll('\\', '/')}`;
}

export function assertDefaultPreserved(before, after, importedId) {
  // With no prior default, accept only no default or Windows selecting this owned import.
  // An existing default must remain identical; we never issue a default-setting command.
  if (before ? after !== before : after && after !== importedId) {
    throw new Error('WSL changed an unrelated default distribution; stopped without changing it again.');
  }
}

function validateOwnerShape(owner, expectedBasePath) {
  if (owner?.version !== 1 || owner.distro !== WSL_DISTRO_NAME || owner.basePath !== expectedBasePath ||
      !/^[a-f0-9]{32}$/.test(owner.nonce ?? '') || !['planned', 'created', 'ready', 'installed', 'reset', 'updating'].includes(owner.phase)) {
    throw new Error('Batshit\'s Windows storage record is invalid; no data was changed.');
  }
  recordedCodeTuples(owner);
}

export function codeReleaseTuple(release, commit) {
  if (release === undefined && commit === undefined) return null;
  if (typeof release !== 'string' || !/^v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(release) || typeof commit !== 'string' || !/^[a-f0-9]{40}$/.test(commit)) throw new Error('The recorded code release tuple is invalid; no guest code was adopted.');
  return { release, commit };
}

export function recordedCodeTuples(owner) {
  const old = codeReleaseTuple(owner.release, owner.commit);
  let pending = null;
  if (owner.pendingCode !== undefined) {
    if (!owner.pendingCode || Object.keys(owner.pendingCode).sort().join(',') !== 'commit,release') throw new Error('The pending code release record is invalid.');
    pending = codeReleaseTuple(owner.pendingCode.release, owner.pendingCode.commit);
  }
  return { old, pending };
}

export function reconcileCodeSelection(owner, selected) {
  const { old, pending } = recordedCodeTuples(owner);
  if (selected === null) {
    if (old) throw new Error('Established guest code is missing; its recorded release was retained.');
    return owner;
  }
  const tuple = codeReleaseTuple(selected?.release, selected?.commit);
  if (!tuple || ![old, pending].some(value => value && value.release === tuple.release && value.commit === tuple.commit)) throw new Error('Guest code is neither the recorded old nor pending release; no metadata was replaced.');
  return { ...owner, ...tuple };
}

const GUID = /^\{[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}\}$/i;

function matchingRegistration(registry, expectedBasePath) {
  const matches = registry.distributions.filter((d) => d.name === WSL_DISTRO_NAME);
  if (matches.length !== 1 || matches[0].version !== 2 || matches[0].basePath !== expectedBasePath || !GUID.test(matches[0].id ?? '')) {
    throw new Error('Batshit\'s owned WSL registration no longer matches its storage record; no data was changed.');
  }
  return matches[0];
}

export function validateWslOwner(owner, registry, expectedBasePath) {
  validateOwnerShape(owner, expectedBasePath);
  if (owner.phase === 'planned') {
    if (owner.registrationId === null && !registry.distributions.some(d => d.name === WSL_DISTRO_NAME)) return null;
    throw new Error('Import ownership is uncertain; no existing distribution was adopted.');
  }
  if (typeof owner.registrationId !== 'string' || !GUID.test(owner.registrationId)) throw new Error('The owned WSL registration GUID is missing or invalid; no guest was entered.');
  const registered = matchingRegistration(registry, expectedBasePath);
  if (registered.id !== owner.registrationId) throw new Error('The owned WSL registration GUID changed; no guest was entered.');
  return registered;
}

// Only the immediate successful import caller may establish a new GUID. Generic record
// readers never treat planned+existing as adoption, including after an interrupted import.
export function validateFreshWslImport(owner, before, after, expectedBasePath) {
  if (owner.phase !== 'planned') throw new Error('A fresh import must begin from planned ownership.');
  validateWslOwner(owner, before, expectedBasePath);
  const registered = matchingRegistration(after, expectedBasePath);
  assertDefaultPreserved(before.defaultDistribution, after.defaultDistribution, registered.id);
  return registered;
}

export function assertWslRuntimeCompatible(owner) {
  assertWslRuntimeFamily(owner);
  if (owner.runtime.node !== WSL_NODE_VERSION || owner.runtime.nodeSha256 !== WSL_ASSETS[1].sha256) throw new Error('The retained Node runtime needs this release’s owned Update; no application was started and data was retained.');
}

export function assertWslRuntimeFamily(owner) {
  if (owner.runtime?.bootstrap !== WSL_BOOTSTRAP_VERSION || owner.runtime?.os !== WSL_RUNTIME_OS || !/^v24\.[0-9]+\.[0-9]+$/.test(owner.runtime?.node ?? '') || !/^[a-f0-9]{64}$/.test(owner.runtime?.nodeSha256 ?? '')) {
    throw new Error('The retained Linux OS/runtime contract differs. Its data was retained; this installer does not migrate an unsupported OS/ABI/layout.');
  }
}

export function guestCommandArgs(owner, command, { user = WSL_USER, cwd = WSL_HOME } = {}) {
  return ['--distribution', owner.distro, '--user', user, '--cd', cwd, '--exec', ...command];
}

export function guestNodeArgs(owner, script, args) {
  return guestCommandArgs(owner, ['/usr/bin/env', '-i', ...Object.entries(WSL_ENV).map(([k, v]) => `${k}=${v}`), WSL_NODE, script, ...args]);
}

export const WSL_CODE_RESET_PATHS = Object.freeze([
  'pinokio/runtime', 'batshit-app/node_modules', 'batshit-app/build', 'batshit-app/.svelte-kit', 'batshit-server/server/node_modules'
]);
export const WSL_CODE_RESET_FILES = Object.freeze(['batshit-app/scripts/anchored-project-reader']);
