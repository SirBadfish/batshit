import type { BuiltinVoiceCatalogEntry, BuiltinVoiceLane, BuiltinVoiceProviderId, VoiceCatalogView } from '$lib/types/builtinVoiceCatalog'
import { legacyVoiceCatalogSelection, selectedVoiceCatalogCompatibility } from '$lib/utils/builtinVoiceCatalogProjection'
import { BUILTIN_VOICE_CATALOG_RULES } from '$lib/data/builtinVoiceCatalog'
import { voiceCatalogEntryCompatibility } from '$lib/utils/builtinVoiceCatalog'
import { LOCAL_VOICE_CATALOG_KEY } from './services/builtinVoiceCatalogStore'

type Semantic = Readonly<{ admission: string | null; profile: string | null; block: string | null; eligible: boolean }>
export type VoiceCatalogSelectionGuard = Readonly<{
  providerId: BuiltinVoiceProviderId; lane: BuiltinVoiceLane; modelId: string
  expected: Semantic; legacy: Semantic | null; allowAbsent: boolean
}>
const semantic = (entry: Pick<BuiltinVoiceCatalogEntry, 'admission' | 'compatibilityProfileId' | 'blockedReason'> | undefined, eligible = false): Semantic => ({
  admission: entry?.admission ?? null, profile: entry?.compatibilityProfileId ?? null, block: entry?.blockedReason ?? null, eligible
})

export function voiceCatalogSelectionGuard(view: VoiceCatalogView, providerId: BuiltinVoiceProviderId, lane: BuiltinVoiceLane, modelId: string) {
  const selected = selectedVoiceCatalogCompatibility(view, providerId, lane, modelId)
  if (selected.state !== 'compatible' && selected.state !== 'unlisted') throw new Error('tts_catalog_compatibility_unavailable')
  const facts = selected.facts ? JSON.parse(selected.facts) as BuiltinVoiceCatalogEntry : undefined
  const legacy = legacyVoiceCatalogSelection(providerId, lane, modelId)
  return Object.freeze({ key: LOCAL_VOICE_CATALOG_KEY, voiceCatalog: Object.freeze({ providerId, lane, modelId,
    expected: semantic(facts, selected.state === 'compatible'), legacy: legacy ? semantic(legacy, true) : null, allowAbsent: view.snapshot === null }) })
}

/** Finite selected facts only; this is not whole-catalog identity or new-model authority. */
export function sameVoiceCatalogSelection(left: VoiceCatalogSelectionGuard, right: VoiceCatalogSelectionGuard): boolean {
  return left.providerId === right.providerId && left.lane === right.lane && left.modelId === right.modelId &&
    left.expected.admission === right.expected.admission && left.expected.profile === right.expected.profile && left.expected.block === right.expected.block && left.expected.eligible === right.expected.eligible
}

/** Twin of the bounded final Lua extraction. Full schema/digest admission stays with the reader. */
export function matchesVoiceCatalogSelectionGuard(guard: VoiceCatalogSelectionGuard, raw: unknown): boolean {
  const same = (value: Semantic) => value.admission === guard.expected.admission && value.profile === guard.expected.profile && value.block === guard.expected.block && value.eligible === guard.expected.eligible
  if (raw === undefined || raw === null) return guard.allowAbsent && same(guard.legacy ?? semantic(undefined))
  if (typeof raw !== 'string' || Buffer.byteLength(raw, 'utf8') > 1024 * 1024 + 1024) return false
  try {
    const cache = JSON.parse(raw), snapshot = cache?.snapshot
    if (cache?.schemaVersion !== 1 || typeof cache.checkedAt !== 'string' || snapshot?.schemaVersion !== 1 || !Number.isSafeInteger(snapshot.generation) || snapshot.generation < 1 ||
      !Number.isSafeInteger(snapshot.sequence) || snapshot.sequence < 1 || typeof snapshot.revision !== 'string' || !/^[a-f0-9]{64}$/.test(snapshot.revision)) return false
    const provider = snapshot.providers?.[guard.providerId]
    if (!provider || !Array.isArray(provider.entries) || provider.entries.length > 1000) return false
    const matches = provider.entries.filter((entry: unknown) => entry && typeof entry === 'object' &&
      (entry as BuiltinVoiceCatalogEntry).modelId === guard.modelId && (entry as BuiltinVoiceCatalogEntry).lane === guard.lane)
    if (matches.length > 1) return false
    const entry = matches[0]
    if (!entry) return same(guard.legacy ?? semantic(undefined))
    if (!['qualified','candidate','blocked'].includes(entry.admission) || !['bundled-legacy','qualified-source'].includes(entry.provenance) ||
      !Array.isArray(entry.evidenceUrls) || entry.evidenceUrls.length > 8 || entry.evidenceUrls.some((url: unknown) => typeof url !== 'string') ||
      !(entry.qualifiedAt === null || typeof entry.qualifiedAt === 'string' && Number.isFinite(Date.parse(entry.qualifiedAt))) ||
      entry.compatibilityProfileId !== undefined && typeof entry.compatibilityProfileId !== 'string' ||
      entry.qualificationRuleId !== undefined && (typeof entry.qualificationRuleId !== 'string' || !entry.qualificationRuleId.length || Buffer.byteLength(entry.qualificationRuleId, 'utf8') > 256) ||
      entry.blockedReason !== undefined && !['contract-changed','profile-unavailable','qualification-required'].includes(entry.blockedReason) ||
      entry.admission === 'blocked' && !entry.blockedReason || entry.admission === 'qualified' && (!entry.compatibilityProfileId || entry.blockedReason ||
        entry.provenance === 'qualified-source' && (!entry.qualifiedAt || !entry.evidenceUrls.length))) return false
    return same(guard.legacy && entry.admission === 'candidate' && (!entry.blockedReason || entry.blockedReason === 'qualification-required') &&
      (!entry.compatibilityProfileId || entry.compatibilityProfileId === guard.legacy.profile) && !entry.qualificationRuleId ? guard.legacy :
      semantic(entry, voiceCatalogEntryCompatibility(guard.providerId, entry).compatible))
  } catch { return false }
}

const installedRulesLua = BUILTIN_VOICE_CATALOG_RULES.map(rule =>
  `[${JSON.stringify(rule.id)}] = {provider=${JSON.stringify(rule.providerId)},lane=${JSON.stringify(rule.lane)},profile=${JSON.stringify(rule.compatibilityProfileId)}}`).join(',')

export const CHECK_VOICE_CATALOG_SELECTION_LUA = `
local function voice_catalog_semantic_current(source)
  local spec = source.voiceCatalog
  local kind = redis.call('TYPE', KEYS[source.keyIndex]).ok
  local function same(value)
    return value.admission == spec.expected.admission and value.profile == spec.expected.profile and value.block == spec.expected.block and value.eligible == spec.expected.eligible
  end
  local empty = {admission=cjson.null, profile=cjson.null, block=cjson.null, eligible=false}
  local rules = {${installedRulesLua}}
  local legacy = type(spec.legacy) == 'table' and spec.legacy or nil
  local function finite_array(value, limit, nonempty)
    if type(value) ~= 'table' then return false end
    local count = 0
    for key, _ in pairs(value) do
      if type(key) ~= 'number' or key < 1 or key ~= math.floor(key) then return false end
      count = count + 1
    end
    return count == #value and count <= limit and (not nonempty or count > 0)
  end
  if kind == 'none' then return spec.allowAbsent == true and same(legacy or empty) end
  if kind ~= 'string' then return false end
  local raw = redis.call('GET', KEYS[source.keyIndex])
  if type(raw) ~= 'string' or string.len(raw) > 1049600 then return false end
  local ok, cache = pcall(cjson.decode, raw)
  if not ok or type(cache) ~= 'table' or cache.schemaVersion ~= 1 or type(cache.checkedAt) ~= 'string' or type(cache.snapshot) ~= 'table' then return false end
  local snapshot = cache.snapshot
  local function positive(value) return type(value) == 'number' and value >= 1 and value <= 9007199254740991 and value == math.floor(value) end
  if snapshot.schemaVersion ~= 1 or not positive(snapshot.generation) or not positive(snapshot.sequence) or type(snapshot.revision) ~= 'string' or #snapshot.revision ~= 64 or string.find(snapshot.revision, '[^a-f0-9]') or type(snapshot.providers) ~= 'table' then return false end
  local provider = snapshot.providers[spec.providerId]
  if type(provider) ~= 'table' or not finite_array(provider.entries, 1000, true) then return false end
  local selected = nil
  for _, entry in ipairs(provider.entries) do
    if type(entry) == 'table' and entry.modelId == spec.modelId and entry.lane == spec.lane then
      if selected then return false end
      selected = entry
    end
  end
  if not selected then return same(legacy or empty) end
  local entry = selected
  if entry.admission ~= 'qualified' and entry.admission ~= 'candidate' and entry.admission ~= 'blocked' then return false end
  if entry.provenance ~= 'bundled-legacy' and entry.provenance ~= 'qualified-source' then return false end
  if not finite_array(entry.evidenceUrls, 8, entry.provenance == 'qualified-source' and entry.admission == 'qualified') then return false end
  for _, url in ipairs(entry.evidenceUrls) do if type(url) ~= 'string' then return false end end
  if entry.qualifiedAt ~= cjson.null and (type(entry.qualifiedAt) ~= 'string' or not string.match(entry.qualifiedAt, '^%d%d%d%d%-%d%d%-%d%dT%d%d:%d%d:%d%d')) then return false end
  if entry.compatibilityProfileId ~= nil and type(entry.compatibilityProfileId) ~= 'string' then return false end
  if entry.qualificationRuleId ~= nil and (type(entry.qualificationRuleId) ~= 'string' or #entry.qualificationRuleId == 0 or #entry.qualificationRuleId > 256) then return false end
  if entry.blockedReason ~= nil and entry.blockedReason ~= 'contract-changed' and entry.blockedReason ~= 'profile-unavailable' and entry.blockedReason ~= 'qualification-required' then return false end
  if entry.admission == 'blocked' and not entry.blockedReason then return false end
  if entry.admission == 'qualified' and (not entry.compatibilityProfileId or entry.compatibilityProfileId == '' or entry.blockedReason or entry.provenance == 'qualified-source' and (entry.qualifiedAt == cjson.null or #entry.evidenceUrls == 0)) then return false end
  if legacy and entry.admission == 'candidate' and (not entry.blockedReason or entry.blockedReason == 'qualification-required') and (not entry.compatibilityProfileId or entry.compatibilityProfileId == legacy.profile) and not entry.qualificationRuleId then return same(legacy) end
  local rule = entry.qualificationRuleId and rules[entry.qualificationRuleId] or nil
  local supported_rule = rule and rule.provider == spec.providerId and rule.lane == spec.lane and rule.profile == entry.compatibilityProfileId
  local baseline = legacy and legacy.profile == entry.compatibilityProfileId
  local eligible = entry.admission == 'qualified' and not entry.blockedReason and (not entry.qualificationRuleId or supported_rule) and (baseline or supported_rule and entry.provenance == 'qualified-source')
  return same({admission=entry.admission, profile=entry.compatibilityProfileId or cjson.null, block=entry.blockedReason or cjson.null, eligible=eligible and true or false})
end
`
