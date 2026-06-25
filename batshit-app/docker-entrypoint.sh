#!/bin/sh
set -eu

persist_claude_state() {
  runtime_root="${BATSHIT_AGENT_RUNTIME_ROOT:-/root/.batshit}"
  claude_home="${BATSHIT_CLAUDE_RUN_AS_HOME:-}"
  claude_uid="${BATSHIT_CLAUDE_RUN_AS_UID:-}"
  claude_gid="${BATSHIT_CLAUDE_RUN_AS_GID:-}"
  claude_state_root="${runtime_root}/claude-home"
  claude_state_dir="${claude_state_root}/.claude"
  claude_state_json="${claude_state_root}/.claude.json"

  mkdir -p "${runtime_root}"
  mkdir -p "${claude_state_dir}"

  link_claude_home /root

  if [ -n "${claude_home}" ] && [ "${claude_home}" != "/root" ]; then
    mkdir -p "${claude_home}"
    link_claude_home "${claude_home}"
  fi

  if [ -n "${claude_uid}" ] && [ -n "${claude_gid}" ]; then
    chown "${claude_uid}:${claude_gid}" "${claude_home:-/root}" 2>/dev/null || true
    chown -R "${claude_uid}:${claude_gid}" "${claude_state_root}"
  fi

  chmod 0700 "${claude_state_root}" "${claude_state_dir}" 2>/dev/null || true
  [ -e "${claude_state_json}" ] && chmod 0600 "${claude_state_json}" 2>/dev/null || true
}

link_claude_home() {
  home_dir="$1"
  claude_state_root="${BATSHIT_AGENT_RUNTIME_ROOT:-/root/.batshit}/claude-home"
  claude_state_dir="${claude_state_root}/.claude"
  claude_state_json="${claude_state_root}/.claude.json"

  if [ -d "${home_dir}/.claude" ] && [ ! -L "${home_dir}/.claude" ]; then
    cp -a "${home_dir}/.claude/." "${claude_state_dir}/" 2>/dev/null || true
    rm -rf "${home_dir}/.claude"
  elif [ -e "${home_dir}/.claude" ] || [ -L "${home_dir}/.claude" ]; then
    rm -f "${home_dir}/.claude"
  fi

  if [ -f "${home_dir}/.claude.json" ] && [ ! -L "${home_dir}/.claude.json" ] && [ ! -e "${claude_state_json}" ]; then
    cp "${home_dir}/.claude.json" "${claude_state_json}" 2>/dev/null || true
  fi

  if [ -e "${home_dir}/.claude.json" ] || [ -L "${home_dir}/.claude.json" ]; then
    rm -f "${home_dir}/.claude.json"
  fi

  ln -s "${claude_state_dir}" "${home_dir}/.claude"
  ln -s "${claude_state_json}" "${home_dir}/.claude.json"
}

repair_managed_cli_paths() {
  node <<'NODE'
const fs = require('node:fs')
const path = require('node:path')

const runtimeRoot = process.env.BATSHIT_AGENT_RUNTIME_ROOT || '/root/.batshit'
const legacyRoot = '/root/.batshit'
const cliRoot = path.join(runtimeRoot, 'installs', 'cli')
const binDir = path.join(cliRoot, 'bin')

function exists(filePath) {
  try {
    fs.accessSync(filePath, fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function remapLegacyPath(value) {
  if (typeof value !== 'string' || value.length === 0) return value
  const relative = path.relative(legacyRoot, value)
  if (relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative))) {
    return path.join(runtimeRoot, relative)
  }
  return value
}

function findCodexExecutable(versionRoot) {
  const vendorRoot = path.join(versionRoot, 'package', 'vendor')
  try {
    for (const entry of fs.readdirSync(vendorRoot, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue
      const candidate = path.join(vendorRoot, entry.name, 'bin', 'codex')
      if (exists(candidate)) return candidate
    }
  } catch {
    return null
  }
  return null
}

function findExecutable(runtime, versionRoot, manifest) {
  const candidates = []
  if (runtime === 'claude') candidates.push(path.join(versionRoot, 'package', 'claude'))
  if (runtime === 'codex') {
    const codexCandidate = findCodexExecutable(versionRoot)
    if (codexCandidate) candidates.push(codexCandidate)
  }
  const remappedManifestPath = remapLegacyPath(manifest?.executablePath)
  if (remappedManifestPath) candidates.push(remappedManifestPath)

  return Array.from(new Set(candidates)).find(exists) || null
}

function removeShim(shimPath) {
  try {
    fs.rmSync(shimPath, { force: true })
  } catch {
    fs.rmSync(shimPath, { recursive: true, force: true })
  }
}

for (const runtime of ['codex', 'claude']) {
  const runtimeRoot = path.join(cliRoot, runtime)
  if (!fs.existsSync(runtimeRoot)) continue

  let shimExecutable = null
  for (const entry of fs.readdirSync(runtimeRoot, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue
    const versionRoot = path.join(runtimeRoot, entry.name)
    const manifestPath = path.join(versionRoot, 'batshit-managed-cli.json')
    if (!fs.existsSync(manifestPath)) continue

    let manifest
    try {
      manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    } catch {
      continue
    }

    const executable = findExecutable(runtime, versionRoot, manifest)
    if (!executable) continue

    manifest.installRoot = remapLegacyPath(manifest.installRoot) || versionRoot
    manifest.executablePath = executable
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    shimExecutable = executable
  }

  if (!shimExecutable) continue
  fs.mkdirSync(binDir, { recursive: true })
  const shimPath = path.join(binDir, runtime)
  removeShim(shimPath)
  fs.symlinkSync(shimExecutable, shimPath)
}
NODE
}


persist_claude_state
repair_managed_cli_paths

exec "$@"
