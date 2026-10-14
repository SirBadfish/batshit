#!/bin/bash
set -euo pipefail

# All Node execution is ordinary-user work. Root bootstrap only owns the instance nonce,
# declared Ubuntu packages and the fixed UID1000 account; it never executes this writable Node.
_node_exists() { [[ -e "$1" || -L "$1" ]]; }
_node_refuse() { printf '%s\n' "Batshit: $*" >&2; return 1; }

_node_physical_path() {
  local path="$1"
  [[ "$path" = /* && "$path" != *'//'* && "$path" != *'/../'* && "$path" != */.. && "$path" != *'/./'* && "$path" != */. && "$path" != *$'\n'* && "$path" != *$'\r'* ]] || return 1
  while :; do
    [[ -d "$path" && ! -L "$path" ]] || return 1
    [[ "$path" = / ]] && break
    path="${path%/*}"; [[ -n "$path" ]] || path=/
  done
}

_node_private_dir() {
  _node_physical_path "$1" && [[ "$(stat -c %u "$1")" = "$2" && "$(stat -c %a "$1")" = 700 ]]
}

_node_private_marker() {
  [[ -f "$1" && ! -L "$1" && "$(stat -c %u "$1")" = "$2" && "$(stat -c %a "$1")" = 600 && "$(stat -c %h "$1")" = 1 ]]
}

# One persistent inode serializes this dedicated writer. FD9 and the driver-owned admission
# reader on FD3 remain inherited by writing descendants; nothing unlinks/releases the lock.
_node_acquire_write_lock() {
  local prefix="$1" nonce="$2" uid="$3" lock="$1.lock" identity
  if ! _node_exists "$lock"; then
    (umask 077; set -o noclobber; printf 'batshit-node-lock-v1\nnonce=%s\nuid=%s\n' "$nonce" "$uid" > "$lock") || return 1
  fi
  _node_private_marker "$lock" "$uid" && cmp -s "$lock" <(printf 'batshit-node-lock-v1\nnonce=%s\nuid=%s\n' "$nonce" "$uid") || return 1
  identity="$(stat -c %d:%i "$lock")" || return 1
  exec 9<>"$lock" || return 1
  [[ "$(stat -Lc %d:%i /proc/self/fd/9)" = "$identity" ]] || return 1
  flock -n 9 || { _node_refuse 'A Node writer is still active; the runtime was retained.'; return 1; }
  [[ "$(stat -c %d:%i "$lock")" = "$identity" ]] && _node_private_marker "$lock" "$uid" &&
    cmp -s "$lock" <(printf 'batshit-node-lock-v1\nnonce=%s\nuid=%s\n' "$nonce" "$uid")
}

_node_tuple() { [[ "$1" =~ ^[a-f0-9]{64}$ && "$2" =~ ^v24\.[0-9]+\.[0-9]+$ ]]; }

_node_receipt_text() {
  local kind="$1" nonce="$2" uid="$3" sha="$4" version="$5" old_sha="${6:-}" old_version="${7:-}"
  printf 'batshit-node-%s-v1\nnonce=%s\nuid=%s\nsha=%s\nversion=%s\n' "$kind" "$nonce" "$uid" "$sha" "$version"
  if [[ -n "$old_sha" ]]; then printf 'oldsha=%s\noldversion=%s\n' "$old_sha" "$old_version"; fi
}

_node_marker_matches() {
  local file="$1"; shift
  _node_private_marker "$file" "$3" && cmp -s "$file" <(_node_receipt_text "$@")
}

_node_write_marker() {
  local file="$1"; shift
  if _node_exists "$file"; then _node_marker_matches "$file" "$@"; return; fi
  (umask 077; set -o noclobber; _node_receipt_text "$@" > "$file")
}

# Strict prepared-prefix schema: either one exact tuple or two during a verified replacement.
# The readonly verifier executes ONLY its explicit requested tuple, never the companion tuple.
_node_read_prefix() {
  local file="$1" nonce="$2" uid="$3" line=""
  local -a lines=()
  _node_private_marker "$file" "$uid" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do lines+=("$line"); done < "$file"
  [[ "${#lines[@]}" = 5 || "${#lines[@]}" = 7 ]] || return 1
  [[ "${lines[0]}" = batshit-node-prefix-v1 && "${lines[1]}" = "nonce=$nonce" && "${lines[2]}" = "uid=$uid" && "${lines[3]}" = sha=* && "${lines[4]}" = version=* ]] || return 1
  NODE_PREFIX_SHA="${lines[3]#sha=}"; NODE_PREFIX_VERSION="${lines[4]#version=}"
  NODE_PREFIX_OLD_SHA=''; NODE_PREFIX_OLD_VERSION=''
  _node_tuple "$NODE_PREFIX_SHA" "$NODE_PREFIX_VERSION" || return 1
  if [[ "${#lines[@]}" = 7 ]]; then
    [[ "${lines[5]}" = oldsha=* && "${lines[6]}" = oldversion=* ]] || return 1
    NODE_PREFIX_OLD_SHA="${lines[5]#oldsha=}"; NODE_PREFIX_OLD_VERSION="${lines[6]#oldversion=}"
    _node_tuple "$NODE_PREFIX_OLD_SHA" "$NODE_PREFIX_OLD_VERSION" || return 1
    [[ "$NODE_PREFIX_OLD_SHA" != "$NODE_PREFIX_SHA" ]] || return 1
  fi
  _node_marker_matches "$file" prefix "$nonce" "$uid" "$NODE_PREFIX_SHA" "$NODE_PREFIX_VERSION" "$NODE_PREFIX_OLD_SHA" "$NODE_PREFIX_OLD_VERSION"
}

_node_retire_text() {
  _node_receipt_text retire "$1" "$2" "$3" "$4"
  printf 'device=%s\ninode=%s\n' "$5" "$6"
}

_node_read_retire() {
  local file="$1" nonce="$2" uid="$3" sha="$4" version="$5" line=''
  local -a lines=()
  _node_private_marker "$file" "$uid" || return 1
  while IFS= read -r line || [[ -n "$line" ]]; do lines+=("$line"); done < "$file"
  [[ "${#lines[@]}" = 7 && "${lines[5]}" = device=* && "${lines[6]}" = inode=* ]] || return 1
  NODE_RETIRE_DEVICE="${lines[5]#device=}"; NODE_RETIRE_INODE="${lines[6]#inode=}"
  [[ "$NODE_RETIRE_DEVICE" =~ ^[0-9]+$ && "$NODE_RETIRE_INODE" =~ ^[0-9]+$ ]] || return 1
  cmp -s "$file" <(_node_retire_text "$nonce" "$uid" "$sha" "$version" "$NODE_RETIRE_DEVICE" "$NODE_RETIRE_INODE")
}

_node_retire_identity() {
  _node_private_dir "$1" "$2" && [[ "$(stat -c %d "$1")" = "$NODE_RETIRE_DEVICE" && "$(stat -c %i "$1")" = "$NODE_RETIRE_INODE" ]]
}

_node_check_tool() {
  local dir="$1" tool="$2" target="$3" uid="$4" file="$1/bin/$2"
  if [[ -L "$file" ]]; then
    [[ "$(readlink "$file")" = "$target" && "$(stat -c %u "$file")" = "$uid" ]] || return 1
    file="$dir/lib/node_modules/npm/bin/${tool}-cli.js"
    _node_physical_path "${file%/*}" || return 1
  fi
  [[ -f "$file" && ! -L "$file" && -x "$file" && "$(stat -c %u "$file")" = "$uid" && "$(stat -c %h "$file")" = 1 ]]
}

_node_verify_tree() {
  local dir="$1" nonce="$2" sha="$3" version="$4" uid="$5" npm_version
  _node_private_dir "$dir" "$uid" && _node_marker_matches "$dir/.batshit-node-runtime.owner" runtime "$nonce" "$uid" "$sha" "$version" || return 1
  _node_physical_path "$dir/bin" || return 1
  [[ -f "$dir/bin/node" && ! -L "$dir/bin/node" && -x "$dir/bin/node" && "$(stat -c %u "$dir/bin/node")" = "$uid" && "$(stat -c %h "$dir/bin/node")" = 1 ]] || return 1
  _node_check_tool "$dir" npm ../lib/node_modules/npm/bin/npm-cli.js "$uid" && _node_check_tool "$dir" npx ../lib/node_modules/npm/bin/npx-cli.js "$uid" || return 1
  [[ "$(unset NODE_OPTIONS NODE_PATH; "$dir/bin/node" --version)" = "$version" ]] || return 1
  npm_version="$(unset NODE_OPTIONS NODE_PATH; PATH="$dir/bin:/usr/bin:/bin" "$dir/bin/npm" --version)" || return 1
  [[ "$npm_version" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]
}

_node_selector() {
  local file="$1" first="$2" second="${3:-}" target
  [[ -L "$file" ]] || return 1
  target="$(readlink "$file")" || return 1
  [[ "$target" = "node-$first" || ( -n "$second" && "$target" = "node-$second" ) ]] || return 1
  NODE_SELECTOR_SHA="${target#node-}"
}

# No writes, cleanup, alternate execution, mkdir or repair in this function.
verify_node_runtime() {
  [[ $# = 4 ]] || return 1
  local prefix="$1" nonce="$2" sha="$3" version="$4" uid
  uid="$(id -u)"
  [[ "$nonce" =~ ^[a-f0-9]{32}$ ]] && _node_tuple "$sha" "$version" || return 1
  _node_private_dir "$prefix" "$uid" && _node_read_prefix "$prefix.owner" "$nonce" "$uid" || return 1
  [[ ( "$NODE_PREFIX_SHA" = "$sha" && "$NODE_PREFIX_VERSION" = "$version" ) || ( "$NODE_PREFIX_OLD_SHA" = "$sha" && "$NODE_PREFIX_OLD_VERSION" = "$version" ) ]] || return 1
  _node_selector "$prefix/current" "$sha" || return 1
  if _node_exists "$prefix/current.new"; then
    _node_selector "$prefix/current.new" "$NODE_PREFIX_SHA" || return 1
    _node_private_dir "$prefix/node-$NODE_PREFIX_SHA" "$uid" &&
      _node_marker_matches "$prefix/node-$NODE_PREFIX_SHA/.batshit-node-runtime.owner" runtime "$nonce" "$uid" "$NODE_PREFIX_SHA" "$NODE_PREFIX_VERSION" || return 1
  fi
  _node_verify_tree "$prefix/node-$sha" "$nonce" "$sha" "$version" "$uid"
}

_node_publish_prefix() {
  local prefix="$1" nonce="$2" uid="$3" sha="$4" version="$5" old_sha="${6:-}" old_version="${7:-}" pending
  if _node_marker_matches "$prefix.owner" prefix "$nonce" "$uid" "$sha" "$version" "$old_sha" "$old_version"; then return 0; fi
  pending="$prefix.owner.new-$nonce-$sha"
  _node_write_marker "$pending" prefix "$nonce" "$uid" "$sha" "$version" "$old_sha" "$old_version" || return 1
  mv -Tf -- "$pending" "$prefix.owner"
}

# Internal prefix argument is solely for same-OS source tests. The product CLI fixes its path.
# The guest driver holds existing Delete-role admission/quiescence. A persistent kernel flock
# additionally covers a writing descendant that outlives a killed driver/Bash, never a daemon.
install_node_archive() {
  [[ $# = 7 ]] || return 1
  local archive="$1" sha="$2" nonce="$3" prefix="$4" version="$5" old_sha="$6" old_version="$7"
  local uid parent stage stage_owner next old='' entry name current_sha='' pending retirement='' retiring=0
  uid="$(id -u)"; parent="${prefix%/*}"
  [[ "$nonce" =~ ^[a-f0-9]{32}$ ]] && _node_tuple "$sha" "$version" || return 1
  if [[ -n "$old_sha" || -n "$old_version" ]]; then _node_tuple "$old_sha" "$old_version" || return 1; fi
  [[ "$sha" != "$old_sha" || "$version" = "$old_version" ]] || return 1
  _node_physical_path "$parent" && [[ "$(stat -c %u "$parent")" = "$uid" ]] || return 1
  [[ -f "$archive" && ! -L "$archive" && "$archive" != *$'\n'* && "$archive" != *$'\r'* ]] || return 1
  printf '%s  %s\n' "$sha" "$archive" | sha256sum -c - || return 1
  _node_acquire_write_lock "$prefix" "$nonce" "$uid" || return 1

  # A positive private prefix receipt precedes mkdir, so first-create interruptions are known.
  if ! _node_exists "$prefix.owner"; then
    [[ -z "$old_sha" ]] && ! _node_exists "$prefix" || { _node_refuse 'Unknown Node prefix retained.'; return 1; }
    _node_write_marker "$prefix.owner" prefix "$nonce" "$uid" "$sha" "$version" || return 1
  fi
  _node_read_prefix "$prefix.owner" "$nonce" "$uid" || { _node_refuse 'Node prefix receipt differs; retained.'; return 1; }
  if ! _node_marker_matches "$prefix.owner" prefix "$nonce" "$uid" "$sha" "$version" &&
     ! { [[ -n "$old_sha" ]] && _node_marker_matches "$prefix.owner" prefix "$nonce" "$uid" "$old_sha" "$old_version"; } &&
     ! { [[ -n "$old_sha" && "$old_sha" != "$sha" ]] && _node_marker_matches "$prefix.owner" prefix "$nonce" "$uid" "$sha" "$version" "$old_sha" "$old_version"; }; then
    _node_refuse 'Node prefix is not this exact old/new replacement.'; return 1
  fi
  if ! _node_exists "$prefix"; then [[ -z "$old_sha" ]] && mkdir -m 700 -- "$prefix" || return 1; fi
  _node_private_dir "$prefix" "$uid" || return 1
  stage="$prefix/.stage-$nonce-$sha"; stage_owner="$stage.owner"; next="$prefix/node-$sha"
  if [[ -n "$old_sha" ]]; then old="$prefix/node-$old_sha"; fi
  if [[ -n "$old_sha" && "$old_sha" != "$sha" ]]; then retirement="$prefix/.retire-$nonce-$old_sha.owner"; fi
  pending="$prefix.owner.new-$nonce-$sha"
  if _node_exists "$pending"; then
    _node_marker_matches "$pending" prefix "$nonce" "$uid" "$sha" "$version" ||
      { [[ -n "$old_sha" && "$sha" != "$old_sha" ]] && _node_marker_matches "$pending" prefix "$nonce" "$uid" "$sha" "$version" "$old_sha" "$old_version"; } || return 1
  fi
  for entry in "$prefix"/* "$prefix"/.[!.]* "$prefix"/..?*; do
    _node_exists "$entry" || continue; name="${entry##*/}"
    [[ "$name" = current || "$name" = current.new || "$entry" = "$next" || ( -n "$old" && "$entry" = "$old" ) || "$entry" = "$stage" || "$entry" = "$stage_owner" || ( -n "$retirement" && "$entry" = "$retirement" ) ]] || { _node_refuse "Unknown Node entry retained: $entry"; return 1; }
  done
  if _node_exists "$stage_owner"; then _node_marker_matches "$stage_owner" stage "$nonce" "$uid" "$sha" "$version" || return 1;
  elif _node_exists "$stage"; then _node_refuse 'Unknown Node staging retained.'; return 1; fi
  if _node_exists "$stage"; then _node_private_dir "$stage" "$uid" || return 1; fi
  if _node_exists "$prefix/current"; then
    _node_selector "$prefix/current" "$sha" "$old_sha" || return 1; current_sha="$NODE_SELECTOR_SHA"
  else [[ -z "$old_sha" ]] || { _node_refuse 'An existing Node selector is missing; retained.'; return 1; }; fi
  if _node_exists "$prefix/current.new"; then _node_selector "$prefix/current.new" "$sha" || return 1; fi
  if [[ -n "$retirement" ]] && _node_exists "$retirement"; then
    _node_read_retire "$retirement" "$nonce" "$uid" "$old_sha" "$old_version" || return 1
    [[ "$current_sha" = "$sha" ]] || return 1
    if _node_exists "$old"; then _node_retire_identity "$old" "$uid" || return 1; fi
    retiring=1
  fi
  if _node_exists "$next"; then _node_verify_tree "$next" "$nonce" "$sha" "$version" "$uid" || return 1; fi
  if [[ "$retiring" = 0 && -n "$old" && "$old" != "$next" ]] && _node_exists "$old"; then _node_verify_tree "$old" "$nonce" "$old_sha" "$old_version" "$uid" || return 1; fi
  if [[ -n "$current_sha" ]]; then
    if [[ "$current_sha" = "$sha" ]]; then _node_verify_tree "$next" "$nonce" "$sha" "$version" "$uid" || return 1;
    else _node_verify_tree "$old" "$nonce" "$old_sha" "$old_version" "$uid" || return 1; fi
  fi
  if _node_exists "$prefix/current.new"; then _node_verify_tree "$next" "$nonce" "$sha" "$version" "$uid" || return 1; fi

  if ! _node_exists "$next"; then
    _node_write_marker "$stage_owner" stage "$nonce" "$uid" "$sha" "$version" || return 1
    if _node_exists "$stage"; then rm -r -- "$stage" || return 1; fi
    mkdir -m 700 -- "$stage" || return 1
    (umask 077; tar -xJf "$archive" --no-same-owner --no-same-permissions --strip-components=1 -C "$stage") || return 1
    chmod 700 "$stage" || return 1
    _node_write_marker "$stage/.batshit-node-runtime.owner" runtime "$nonce" "$uid" "$sha" "$version" || return 1
    _node_verify_tree "$stage" "$nonce" "$sha" "$version" "$uid" || return 1
    mv -T -- "$stage" "$next" || return 1
  fi
  _node_verify_tree "$next" "$nonce" "$sha" "$version" "$uid" || return 1

  # Prepared marker first, then one atomic selector rename. Either old/new current remains valid
  # across a crash; publication never removes current, nor presents a half-extracted runtime.
  if [[ -n "$old_sha" && "$old_sha" != "$sha" && "$current_sha" != "$sha" ]]; then
    _node_publish_prefix "$prefix" "$nonce" "$uid" "$sha" "$version" "$old_sha" "$old_version" || return 1
  fi
  if ! _node_exists "$prefix/current.new"; then ln -s -- "node-$sha" "$prefix/current.new" || return 1; fi
  _node_selector "$prefix/current.new" "$sha" || return 1
  mv -Tf -- "$prefix/current.new" "$prefix/current" || return 1
  verify_node_runtime "$prefix" "$nonce" "$sha" "$version" || return 1
  _node_publish_prefix "$prefix" "$nonce" "$uid" "$sha" "$version" || return 1
  verify_node_runtime "$prefix" "$nonce" "$sha" "$version" || return 1

  # Only the exact old tuple may be reclaimed, after selected new is fully verified. Unknown
  # third directories were refused above; no user data, VHD, OS or arbitrary path is removed.
  if [[ -n "$old" && "$old" != "$next" ]] && _node_exists "$old"; then
    if [[ "$retiring" = 0 ]]; then
      _node_verify_tree "$old" "$nonce" "$old_sha" "$old_version" "$uid" || return 1
      NODE_RETIRE_DEVICE="$(stat -c %d "$old")"; NODE_RETIRE_INODE="$(stat -c %i "$old")"
      (umask 077; set -o noclobber; _node_retire_text "$nonce" "$uid" "$old_sha" "$old_version" "$NODE_RETIRE_DEVICE" "$NODE_RETIRE_INODE" > "$retirement") || return 1
    fi
    _node_read_retire "$retirement" "$nonce" "$uid" "$old_sha" "$old_version" && _node_retire_identity "$old" "$uid" || return 1
    rm -r -- "$old" || return 1
  fi
  if [[ -n "$retirement" ]] && _node_exists "$retirement"; then
    ! _node_exists "$old" && verify_node_runtime "$prefix" "$nonce" "$sha" "$version" &&
      _node_read_retire "$retirement" "$nonce" "$uid" "$old_sha" "$old_version" || return 1
    rm -- "$retirement" || return 1
  fi
  if _node_exists "$stage"; then _node_marker_matches "$stage_owner" stage "$nonce" "$uid" "$sha" "$version" && _node_private_dir "$stage" "$uid" || return 1; rm -r -- "$stage" || return 1; fi
  if _node_exists "$stage_owner"; then _node_marker_matches "$stage_owner" stage "$nonce" "$uid" "$sha" "$version" || return 1; rm -- "$stage_owner" || return 1; fi
  if _node_exists "$pending"; then
    _node_marker_matches "$pending" prefix "$nonce" "$uid" "$sha" "$version" ||
      { [[ -n "$old_sha" && "$sha" != "$old_sha" ]] && _node_marker_matches "$pending" prefix "$nonce" "$uid" "$sha" "$version" "$old_sha" "$old_version"; } || return 1
    rm -- "$pending" || return 1
  fi
  verify_node_runtime "$prefix" "$nonce" "$sha" "$version"
}

_node_guest_user_guard() {
  local nonce="$1"
  [[ "$(uname -s)" = Linux && "$EUID" = 1000 && "${HOME:-}" = /home/batshit && "$nonce" =~ ^[a-f0-9]{32}$ ]] || return 1
  _node_physical_path /home/batshit && [[ "$(stat -c %u /home/batshit)" = 1000 ]] || return 1
  _node_physical_path /etc || return 1
  [[ -f /etc/batshit-pinokio-instance && ! -L /etc/batshit-pinokio-instance && "$(stat -c %u /etc/batshit-pinokio-instance)" = 0 && "$(stat -c %a /etc/batshit-pinokio-instance)" = 644 && "$(stat -c %h /etc/batshit-pinokio-instance)" = 1 ]] || return 1
  cmp -s /etc/batshit-pinokio-instance <(printf '%s\n' "$nonce")
}

bootstrap_root() {
  local nonce="$1"
  [[ "$(uname -s)" = Linux && "$EUID" = 0 && "$nonce" =~ ^[a-f0-9]{32}$ ]] || return 1
  [[ "$(awk -F= '$1=="ID" {gsub(/"/,"",$2);print $2}' /etc/os-release)" = ubuntu && "$(awk -F= '$1=="VERSION_ID" {gsub(/"/,"",$2);print $2}' /etc/os-release)" = 24.04 ]] || { _node_refuse 'Guest OS runtime contract differs.'; return 1; }
  _node_physical_path /etc || return 1
  if _node_exists /etc/batshit-pinokio-instance; then
    [[ -f /etc/batshit-pinokio-instance && ! -L /etc/batshit-pinokio-instance && "$(stat -c %u /etc/batshit-pinokio-instance)" = 0 && "$(stat -c %a /etc/batshit-pinokio-instance)" = 644 && "$(stat -c %h /etc/batshit-pinokio-instance)" = 1 ]] && cmp -s /etc/batshit-pinokio-instance <(printf '%s\n' "$nonce") || return 1
  else (umask 022; set -o noclobber; printf '%s\n' "$nonce" > /etc/batshit-pinokio-instance) || return 1; fi
  if ! id batshit >/dev/null 2>&1; then
    ! getent passwd 1000 >/dev/null || { _node_refuse 'Guest UID1000 belongs to another user.'; return 1; }
    useradd --uid 1000 --create-home --shell /bin/bash batshit || return 1
  fi
  [[ "$(id -u batshit)" = 1000 && "$(getent passwd batshit | cut -d: -f6)" = /home/batshit ]] && _node_physical_path /home/batshit && [[ "$(stat -c %u /home/batshit)" = 1000 ]] || return 1
  export DEBIAN_FRONTEND=noninteractive
  apt-get update || return 1
  apt-get install -y --no-install-recommends ca-certificates xz-utils util-linux procps git build-essential ffmpeg libsystemd0 libssl3t64 libstdc++6 libgcc-s1 libcrypt1 || return 1
  printf '%s\n' 'Batshit: the Linux environment is prepared.'
}

bootstrap_main() {
  local mode="${1:-}" nonce="${2:-}" prefix=/home/batshit/.local/batshit-node
  # Privileged probes/package commands never search user-writable Node or Windows dev paths.
  PATH=/usr/sbin:/usr/bin:/sbin:/bin
  export PATH
  case "$mode" in
    bootstrap-root) [[ $# = 2 ]] && bootstrap_root "$nonce" ;;
    install-node)
      [[ $# = 7 ]] && _node_guest_user_guard "$nonce" || return 1
      if ! _node_exists /home/batshit/.local; then mkdir -m 700 -- /home/batshit/.local || return 1; fi
      _node_physical_path /home/batshit/.local && [[ "$(stat -c %u /home/batshit/.local)" = 1000 ]] || return 1
      install_node_archive "$3" "$4" "$nonce" "$prefix" "$5" "$6" "$7"
      ;;
    verify-node) [[ $# = 4 ]] && _node_guest_user_guard "$nonce" && verify_node_runtime "$prefix" "$nonce" "$3" "$4" ;;
    *) _node_refuse 'Unsupported Linux bootstrap operation.' ;;
  esac
}

if [[ "${BASH_SOURCE[0]}" = "$0" ]]; then bootstrap_main "$@"; fi
