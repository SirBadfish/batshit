/**
 * Batshit Face Control Abstraction Layer
 *
 * Provides intuitive Batshit-native controls (Eyes, Brows, Mouth, Head)
 * that map to raw morph targets on VRM models. Auto-detects VRoid models and applies
 * the appropriate mapping. Designed for future extensibility with custom VRM mappings.
 */

// ---------------------------------------------------------------------------
// Batshit Face Control Schema
// ---------------------------------------------------------------------------

export type BatshitFaceControlId =
	| 'eyelids_left' // -1 (shut) to +1 (open)
	| 'eyelids_right' // -1 (shut) to +1 (open)
	| 'eyes_widen' // 0 (neutral) to 1 (wide)
	| 'eyes_squint' // 0 (neutral) to 1 (squint)
	| 'eyes_tense' // 0 (neutral) to 1 (tense)
	| 'eyes_soft' // 0 (neutral) to 1 (soft/sad)
	| 'eyes_happy' // 0 (neutral) to 1 (happy)
	| 'eyebrows' // -1 (furrowed) to +1 (raised)
	| 'brows_raise' // 0 (neutral) to 1 (raised)
	| 'brows_furrow' // 0 (neutral) to 1 (furrowed)
	| 'brows_sad' // 0 (neutral) to 1 (sad)
	| 'brows_playful' // 0 (neutral) to 1 (playful)
	| 'mouth_smile' // -1 (frown) to +1 (smile)
	| 'mouth_corners' // -1 (down) to +1 (up)
	| 'mouth_open' // 0 (closed) to 1 (open)
	| 'mouth_width' // -1 (narrow) to +1 (wide)
	| 'mouth_tension' // 0 (neutral) to 1 (tense)
	| 'mouth_round' // 0 (neutral) to 1 (round/surprised)
	| 'head_leftright' // -1 (left) to +1 (right)  — mapped to expressionTargets, not raw morph
	| 'head_updown' // -1 (down) to +1 (up)      — mapped to expressionTargets, not raw morph
	| 'eyes_leftright' // -1 (left) to +1 (right)  — mapped to expressionTargets, not raw morph
	| 'eyes_updown' // -1 (down) to +1 (up)      — mapped to expressionTargets, not raw morph

export type GoonFaceControl = {
	control: BatshitFaceControlId
	value: number
}

export type GoonRawMorphTarget = {
	target: string
	value: number
}

export type FaceControlSpec = {
	id: BatshitFaceControlId
	label: string
	region: 'eyes' | 'brows' | 'mouth' | 'head'
	bipolar: boolean
	negativeLabel?: string
	positiveLabel?: string
	min: number
	max: number
	step: number
	/** Group key for controls that share a lock toggle (e.g. 'eyelids') */
	lockGroup?: string
	/** Controls in this group are morph-target-based (need VRoid detection) */
	requiresMorphTargets?: boolean
	/** Hide from the normal semantic UI, but keep support for existing cues. */
	hiddenInNormalUi?: boolean
}

export type FaceControlSection = {
	id: FaceControlSpec['region']
	label: string
	specs: FaceControlSpec[]
}

export type FaceControlBehaviorGroup = {
	id: 'two_way' | 'one_way'
	label: string
	description: string
	specs: FaceControlSpec[]
}

// ---------------------------------------------------------------------------
// UI Specs — grouped for rendering
// ---------------------------------------------------------------------------

/** Eyelid controls (always shown as Left/Right with a lock toggle) */
export const EYELID_SPECS: FaceControlSpec[] = [
	{
		id: 'eyelids_left',
		label: 'Left Eye',
		region: 'eyes',
		bipolar: true,
		negativeLabel: 'Shut',
		positiveLabel: 'Open',
		min: -1,
		max: 1,
		step: 0.05,
		lockGroup: 'eyelids',
		requiresMorphTargets: true
	},
	{
		id: 'eyelids_right',
		label: 'Right Eye',
		region: 'eyes',
		bipolar: true,
		negativeLabel: 'Shut',
		positiveLabel: 'Open',
		min: -1,
		max: 1,
		step: 0.05,
		lockGroup: 'eyelids',
		requiresMorphTargets: true
	}
]

/** Additional semantic eye controls (require morph target detection) */
export const EYE_SHAPE_SPECS: FaceControlSpec[] = [
	{
		id: 'eyes_widen',
		label: 'Widen',
		region: 'eyes',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Wide',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'eyes_squint',
		label: 'Squint',
		region: 'eyes',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Squint',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'eyes_tense',
		label: 'Tense',
		region: 'eyes',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Tense',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'eyes_soft',
		label: 'Soft / Sad',
		region: 'eyes',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Soft',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'eyes_happy',
		label: 'Happy',
		region: 'eyes',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Happy',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	}
]

/** Brow controls (require morph target detection) */
export const BROW_SPECS: FaceControlSpec[] = [
	{
		id: 'brows_raise',
		label: 'Raise',
		region: 'brows',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Raised',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'brows_furrow',
		label: 'Furrow',
		region: 'brows',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Furrowed',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'brows_sad',
		label: 'Sad',
		region: 'brows',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Sad',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'brows_playful',
		label: 'Playful',
		region: 'brows',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Playful',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	}
]

/** Mouth controls (require morph target detection) */
export const MOUTH_SPECS: FaceControlSpec[] = [
	{
		id: 'mouth_corners',
		label: 'Corners',
		region: 'mouth',
		bipolar: true,
		negativeLabel: 'Down',
		positiveLabel: 'Up',
		min: -1,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'mouth_open',
		label: 'Open',
		region: 'mouth',
		bipolar: false,
		negativeLabel: 'Closed',
		positiveLabel: 'Open',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'mouth_width',
		label: 'Width',
		region: 'mouth',
		bipolar: true,
		negativeLabel: 'Narrow',
		positiveLabel: 'Wide',
		min: -1,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'mouth_tension',
		label: 'Tension',
		region: 'mouth',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Tense',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	},
	{
		id: 'mouth_round',
		label: 'Roundness',
		region: 'mouth',
		bipolar: false,
		negativeLabel: 'Neutral',
		positiveLabel: 'Round',
		min: 0,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true
	}
]

/** Legacy combined controls kept for existing cues but hidden from normal UI */
export const LEGACY_FACE_SHAPE_SPECS: FaceControlSpec[] = [
	{
		id: 'eyebrows',
		label: 'Eyebrows',
		region: 'brows',
		bipolar: true,
		negativeLabel: 'Furrowed',
		positiveLabel: 'Raised',
		min: -1,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true,
		hiddenInNormalUi: true
	},
	{
		id: 'mouth_smile',
		label: 'Mouth Expression',
		region: 'mouth',
		bipolar: true,
		negativeLabel: 'Frown',
		positiveLabel: 'Smile',
		min: -1,
		max: 1,
		step: 0.05,
		requiresMorphTargets: true,
		hiddenInNormalUi: true
	}
]

/** Eye direction controls (work on any VRM — use existing expression/bone system) */
export const EYE_DIRECTION_SPECS: FaceControlSpec[] = [
	{
		id: 'eyes_leftright',
		label: 'Look Left / Right',
		region: 'eyes',
		bipolar: true,
		negativeLabel: 'Left',
		positiveLabel: 'Right',
		min: -1,
		max: 1,
		step: 0.05
	},
	{
		id: 'eyes_updown',
		label: 'Look Up / Down',
		region: 'eyes',
		bipolar: true,
		negativeLabel: 'Down',
		positiveLabel: 'Up',
		min: -1,
		max: 1,
		step: 0.05
	}
]

/** Head controls (work on any VRM — use existing expression/bone system) */
export const HEAD_DIRECTION_SPECS: FaceControlSpec[] = [
	{
		id: 'head_leftright',
		label: 'Head Left / Right',
		region: 'head',
		bipolar: true,
		negativeLabel: 'Left',
		positiveLabel: 'Right',
		min: -1,
		max: 1,
		step: 0.05
	},
	{
		id: 'head_updown',
		label: 'Head Up / Down',
		region: 'head',
		bipolar: true,
		negativeLabel: 'Down',
		positiveLabel: 'Up',
		min: -1,
		max: 1,
		step: 0.05
	}
]

/** Semantic face control sections for the normal authoring UI */
export const NORMAL_FACE_CONTROL_SECTIONS: FaceControlSection[] = [
	{
		id: 'eyes',
		label: 'Eyes',
		specs: [...EYELID_SPECS, ...EYE_SHAPE_SPECS, ...EYE_DIRECTION_SPECS]
	},
	{
		id: 'brows',
		label: 'Brows',
		specs: [...BROW_SPECS]
	},
	{
		id: 'mouth',
		label: 'Mouth',
		specs: [...MOUTH_SPECS]
	},
	{
		id: 'head',
		label: 'Head',
		specs: [...HEAD_DIRECTION_SPECS]
	}
]

/** All morph-target-based face controls (semantic + legacy) */
export const MORPH_FACE_CONTROL_SPECS: FaceControlSpec[] = [
	...EYELID_SPECS,
	...EYE_SHAPE_SPECS,
	...BROW_SPECS,
	...MOUTH_SPECS,
	...LEGACY_FACE_SHAPE_SPECS
]

/** All direction controls */
export const ALL_DIRECTION_SPECS: FaceControlSpec[] = [
	...EYE_DIRECTION_SPECS,
	...HEAD_DIRECTION_SPECS
]

/** All face control specs combined */
export const ALL_FACE_CONTROL_SPECS: FaceControlSpec[] = [
	...MORPH_FACE_CONTROL_SPECS,
	...ALL_DIRECTION_SPECS
]

/** IDs that should be hidden from the expression preset dropdown (handled by sliders) */
export const SLIDER_HANDLED_PRESETS = new Set([
	'blink',
	'blinkLeft',
	'blinkRight',
	'lookUp',
	'lookDown',
	'lookLeft',
	'lookRight',
	'lookUpHead',
	'lookDownHead',
	'lookLeftHead',
	'lookRightHead'
])

// ---------------------------------------------------------------------------
// Direction Control ↔ Expression Target mapping
// ---------------------------------------------------------------------------

/**
 * Direction controls map to existing expression targets (not raw morph targets).
 * This function converts direction face controls into expression target patches.
 */
export type DirectionExpressionMapping = {
	negative: string // preset name for negative values
	positive: string // preset name for positive values
}

export const DIRECTION_EXPRESSION_MAP: Record<string, DirectionExpressionMapping> = {
	head_leftright: { negative: 'lookLeftHead', positive: 'lookRightHead' },
	head_updown: { negative: 'lookDownHead', positive: 'lookUpHead' },
	eyes_leftright: { negative: 'lookLeft', positive: 'lookRight' },
	eyes_updown: { negative: 'lookDown', positive: 'lookUp' }
}

/** Check if a face control ID is a direction control (uses expression targets, not morph targets) */
export function isDirectionControl(id: BatshitFaceControlId): boolean {
	return id in DIRECTION_EXPRESSION_MAP
}

const SPEAKING_MOUTH_CONTROL_MULTIPLIERS: Partial<Record<BatshitFaceControlId, number>> = {
	mouth_open: 0,
	mouth_width: 0.25,
	mouth_round: 0.25,
	mouth_smile: 0.5,
	mouth_corners: 0.5,
	mouth_tension: 0.5
}

/**
 * While speaking, let lip sync own mouth openness and most mouth shape,
 * but keep a dampened version of authored mouth expression so moods/emotes
 * still read without fighting the spoken visemes.
 */
export function resolveSpeakingFaceControl(
	faceControl: GoonFaceControl,
	options: {
		speaking: boolean
		pausedForCue?: boolean
	}
): GoonFaceControl | null {
	if (!options.speaking || options.pausedForCue) return faceControl

	const multiplier = SPEAKING_MOUTH_CONTROL_MULTIPLIERS[faceControl.control]
	if (multiplier === undefined) return faceControl
	if (multiplier <= 0) return null

	return {
		control: faceControl.control,
		value: faceControl.value * multiplier
	}
}

/**
 * Mood face should only show when no spoken lip sync or emote is actively
 * owning the face. Motion layering is handled separately in the engine.
 */
export function shouldApplyMoodFaceLayer(options: {
	speaking: boolean
	emoteActive: boolean
}): boolean {
	return !options.speaking && !options.emoteActive
}

export function stepFaceLayerBlend(
	current: number,
	options: {
		active: boolean
		deltaMs: number
		durationMs: number
	}
): number {
	const clampedCurrent = Math.max(0, Math.min(1, current))
	const safeDuration = Math.max(1, options.durationMs)
	const step = Math.max(0, options.deltaMs) / safeDuration

	if (options.active) {
		return Math.min(1, clampedCurrent + step)
	}

	return Math.max(0, clampedCurrent - step)
}

// ---------------------------------------------------------------------------
// VRM Source Detection
// ---------------------------------------------------------------------------

export type VRMSourceType = 'vroid' | 'unknown'

/**
 * Detect the VRM source based on available morph target names.
 * VRoid models use the `Fcl_` prefix convention (possibly after a longer prefix).
 */
export function detectVRMSource(morphTargetNames: string[]): VRMSourceType {
	const fclCount = morphTargetNames.filter((n) => n.includes('Fcl_')).length
	// VRoid models typically have 50+ Fcl_ morph targets (after normalization,
	// both long and short names count)
	return fclCount >= 10 ? 'vroid' : 'unknown'
}

// ---------------------------------------------------------------------------
// Morph Target Mapping
// ---------------------------------------------------------------------------

export type MorphTargetBinding = {
	/** Raw morph target name on the mesh (e.g. "Fcl_EYE_Close") */
	target: string
	/** Weight multiplier applied to the control value */
	scale: number
}

export type FaceControlMapping = {
	/** Morph targets activated when control value is negative (bipolar controls only) */
	negative?: MorphTargetBinding[]
	/** Morph targets activated when control value is positive (or for unipolar controls) */
	positive: MorphTargetBinding[]
}

export type FaceControlMappingSet = Record<string, FaceControlMapping>

/** Morph-target-based face control IDs (subset that needs VRoid mapping) */
type MorphFaceControlId =
	| 'eyelids_left'
	| 'eyelids_right'
	| 'eyes_widen'
	| 'eyes_squint'
	| 'eyes_tense'
	| 'eyes_soft'
	| 'eyes_happy'
	| 'eyebrows'
	| 'brows_raise'
	| 'brows_furrow'
	| 'brows_sad'
	| 'brows_playful'
	| 'mouth_smile'
	| 'mouth_corners'
	| 'mouth_open'
	| 'mouth_width'
	| 'mouth_tension'
	| 'mouth_round'

/** VRoid Studio morph target mapping for Batshit face controls */
const VROID_MAPPING: Record<MorphFaceControlId, FaceControlMapping> = {
	eyelids_left: {
		negative: [{ target: 'Fcl_EYE_Close_L', scale: 1 }],
		// VRoid limitation: no per-eye wide, so we use the bilateral surprised
		positive: [{ target: 'Fcl_EYE_Surprised', scale: 0.7 }]
	},
	eyelids_right: {
		negative: [{ target: 'Fcl_EYE_Close_R', scale: 1 }],
		positive: [{ target: 'Fcl_EYE_Surprised', scale: 0.7 }]
	},
	eyes_widen: {
		positive: [
			{ target: 'Fcl_EYE_Surprised', scale: 0.75 },
			{ target: 'Fcl_EYE_Spread', scale: 0.25 }
		]
	},
	eyes_squint: {
		positive: [
			{ target: 'Fcl_EYE_Close_L', scale: 0.3 },
			{ target: 'Fcl_EYE_Close_R', scale: 0.3 },
			{ target: 'Fcl_EYE_Angry', scale: 0.5 }
		]
	},
	eyes_tense: {
		positive: [{ target: 'Fcl_EYE_Angry', scale: 1 }]
	},
	eyes_soft: {
		positive: [{ target: 'Fcl_EYE_Sorrow', scale: 1 }]
	},
	eyes_happy: {
		positive: [
			{ target: 'Fcl_EYE_Joy', scale: 0.65 },
			{ target: 'Fcl_EYE_Fun', scale: 0.35 }
		]
	},
	eyebrows: {
		negative: [{ target: 'Fcl_BRW_Angry', scale: 1 }],
		positive: [{ target: 'Fcl_BRW_Surprised', scale: 1 }]
	},
	brows_raise: {
		positive: [{ target: 'Fcl_BRW_Surprised', scale: 1 }]
	},
	brows_furrow: {
		positive: [{ target: 'Fcl_BRW_Angry', scale: 1 }]
	},
	brows_sad: {
		positive: [{ target: 'Fcl_BRW_Sorrow', scale: 1 }]
	},
	brows_playful: {
		positive: [
			{ target: 'Fcl_BRW_Fun', scale: 0.7 },
			{ target: 'Fcl_BRW_Joy', scale: 0.3 }
		]
	},
	mouth_smile: {
		negative: [
			{ target: 'Fcl_MTH_Down', scale: 0.85 },
			{ target: 'Fcl_MTH_Close', scale: 0.35 },
			{ target: 'Fcl_MTH_Angry', scale: 0.2 }
		],
		positive: [
			{ target: 'Fcl_MTH_Fun', scale: 0.6 },
			{ target: 'Fcl_MTH_Joy', scale: 0.4 }
		]
	},
	mouth_corners: {
		negative: [
			// On current VRoid faces, Fcl_MTH_Down reads more like lowering the
			// whole mouth on the face than pulling just the corners downward.
			// Approximate "corners down" with a sorrow/close/angry mix instead,
			// and fold in the same per-value tension recipe under the hood so
			// corners-down gets the stronger drop Josh validated live.
			{ target: 'Fcl_MTH_Sorrow', scale: 0.65 },
			{ target: 'Fcl_MTH_Close', scale: 0.3 },
			{ target: 'Fcl_MTH_Angry', scale: 0.75 }
		],
		positive: [
			{ target: 'Fcl_MTH_Up', scale: 0.4 },
			{ target: 'Fcl_MTH_Fun', scale: 0.35 },
			{ target: 'Fcl_MTH_Joy', scale: 0.25 }
		]
	},
	mouth_open: {
		positive: [{ target: 'Fcl_MTH_A', scale: 1 }]
	},
	mouth_width: {
		negative: [{ target: 'Fcl_MTH_Small', scale: 1 }],
		positive: [{ target: 'Fcl_MTH_Large', scale: 1 }]
	},
	mouth_tension: {
		positive: [
			{ target: 'Fcl_MTH_Angry', scale: 0.75 },
			{ target: 'Fcl_MTH_Close', scale: 0.3 }
		]
	},
	mouth_round: {
		positive: [
			{ target: 'Fcl_MTH_Surprised', scale: 0.6 },
			{ target: 'Fcl_MTH_O', scale: 0.25 },
			{ target: 'Fcl_MTH_U', scale: 0.15 }
		]
	}
}

/**
 * Get the face control mapping for a given VRM source type.
 * Returns null if the source type has no mapping (unknown/custom VRM without user mapping).
 */
export function getFaceControlMapping(
	source: VRMSourceType
): Record<string, FaceControlMapping> | null {
	switch (source) {
		case 'vroid':
			return VROID_MAPPING
		default:
			return null
	}
}

function getMorphFaceControlMapping(
	source: VRMSourceType,
	controlId: BatshitFaceControlId
): FaceControlMapping | null {
	if (isDirectionControl(controlId)) return null
	const mapping = getFaceControlMapping(source)
	if (!mapping) return null
	return mapping[controlId] ?? null
}

function hasAnyBindingTarget(
	bindings: MorphTargetBinding[] | undefined,
	availableMorphTargets: Set<string>
): boolean {
	if (!bindings || bindings.length === 0) return false
	return bindings.some((binding) => availableMorphTargets.has(binding.target))
}

function buildNormalizedMorphTargetSet(availableMorphTargetNames: string[]): Set<string> {
	const normalized = new Set<string>()
	for (const name of availableMorphTargetNames) {
		normalized.add(name)
		const fclIdx = name.indexOf('Fcl_')
		if (fclIdx >= 0) {
			normalized.add(name.substring(fclIdx))
		}
	}
	return normalized
}

// ---------------------------------------------------------------------------
// Face Control Resolution
// ---------------------------------------------------------------------------

/**
 * Resolve Batshit face controls into raw morph target name → weight pairs.
 * Handles bipolar controls by routing negative values to negative bindings
 * and positive values to positive bindings.
 * Direction controls are EXCLUDED — they're handled separately via expression targets.
 */
export function resolveMappedFaceControls(
	controls: GoonFaceControl[],
	mapping: FaceControlMappingSet,
	options: {
		includeDirectionControls?: boolean
	} = {}
): Map<string, number> {
	const result = new Map<string, number>()
	const includeDirectionControls = options.includeDirectionControls ?? false

	for (const fc of controls) {
		if (!includeDirectionControls && isDirectionControl(fc.control)) continue

		const m = mapping[fc.control]
		if (!m) continue

		const v = fc.value
		if (v === 0) continue

		if (v < 0 && m.negative) {
			// Bipolar negative side
			const absV = Math.abs(v)
			for (const binding of m.negative) {
				const weight = absV * binding.scale
				const current = result.get(binding.target) ?? 0
				result.set(binding.target, Math.max(current, weight))
			}
		} else if (v > 0) {
			// Positive side (or unipolar)
			for (const binding of m.positive) {
				const weight = v * binding.scale
				const current = result.get(binding.target) ?? 0
				result.set(binding.target, Math.max(current, weight))
			}
		}
	}

	return result
}

export function resolveFaceControls(
	controls: GoonFaceControl[],
	mapping: FaceControlMappingSet
): Map<string, number> {
	return resolveMappedFaceControls(controls, mapping)
}

/** Resolve expert raw-morph controls into a morph target -> weight map. */
export function resolveRawMorphTargets(rawMorphTargets: GoonRawMorphTarget[]): Map<string, number> {
	const result = new Map<string, number>()

	for (const rawMorph of rawMorphTargets) {
		if (!rawMorph.target) continue
		const weight = Math.max(0, Math.min(1, rawMorph.value))
		if (weight === 0) continue
		const current = result.get(rawMorph.target) ?? 0
		result.set(rawMorph.target, Math.max(current, weight))
	}

	return result
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Check if face controls are supported for a given VRM source */
export function hasFaceControlSupport(source: VRMSourceType): boolean {
	return getFaceControlMapping(source) !== null
}

/** Check whether a specific control is truthfully supported by the current model. */
export function supportsFaceControl(
	controlId: BatshitFaceControlId,
	source: VRMSourceType,
	availableMorphTargetNames: string[]
): boolean {
	if (isDirectionControl(controlId)) return true
	const mapping = getMorphFaceControlMapping(source, controlId)
	if (!mapping) return false
	const targets = buildNormalizedMorphTargetSet(availableMorphTargetNames)
	const hasPositive = hasAnyBindingTarget(mapping.positive, targets)
	if (!mapping.negative || mapping.negative.length === 0) {
		return hasPositive
	}
	return hasPositive && hasAnyBindingTarget(mapping.negative, targets)
}

/** Get the supported normal-UI sections for the current model/source. */
export function getSupportedNormalFaceControlSections(
	source: VRMSourceType,
	availableMorphTargetNames: string[]
): FaceControlSection[] {
	return NORMAL_FACE_CONTROL_SECTIONS.map((section) => ({
		...section,
		specs: section.specs.filter((spec) => {
			if (spec.hiddenInNormalUi) return false
			return supportsFaceControl(spec.id, source, availableMorphTargetNames)
		})
	})).filter((section) => section.specs.length > 0)
}

/** Build visible normal-UI sections from controls already authored on a cue. */
export function getNormalFaceControlSectionsForControls(
	controls: GoonFaceControl[] | undefined | null
): FaceControlSection[] {
	const authoredIds = new Set((controls ?? []).map((control) => control.control))
	if (authoredIds.size === 0) return []

	return NORMAL_FACE_CONTROL_SECTIONS.map((section) => ({
		...section,
		specs: section.specs.filter((spec) => authoredIds.has(spec.id))
	})).filter((section) => section.specs.length > 0)
}

/** Split a section into two-way vs one-way controls for clearer UI grouping. */
export function getFaceControlBehaviorGroups(
	section: FaceControlSection
): FaceControlBehaviorGroup[] {
	const groups: FaceControlBehaviorGroup[] = []
	const twoWay = section.specs.filter((spec) => spec.bipolar)
	const oneWay = section.specs.filter((spec) => !spec.bipolar)
	if (twoWay.length > 0) {
		groups.push({
			id: 'two_way',
			label: 'Two-Way',
			description: 'Neutral sits in the center.',
			specs: twoWay
		})
	}
	if (oneWay.length > 0) {
		groups.push({
			id: 'one_way',
			label: 'One-Way',
			description: 'Builds from the left edge.',
			specs: oneWay
		})
	}
	return groups
}

/** Face-control sliders fill from neutral/closed point rather than always from the left edge. */
export function getFaceControlFillFrom(spec: FaceControlSpec): number {
	return spec.bipolar ? 0 : spec.min
}

/** Format semantic face-control values for the editor. */
export function formatFaceControlDisplayValue(spec: FaceControlSpec, value: number): string {
	const clamped = Math.max(spec.min, Math.min(spec.max, value))
	if (spec.bipolar) {
		const normalized = Math.abs(clamped) < 0.0001 ? 0 : clamped
		return `${normalized > 0 ? '+' : ''}${normalized.toFixed(2)}`
	}
	return `${Math.round(clamped * 100)}%`
}

/** Get the resolved eyelids value from a set of face controls (for ambient blink suppression) */
export function getEyelidsValue(controls: GoonFaceControl[]): number {
	const left = controls.find((c) => c.control === 'eyelids_left')
	const right = controls.find((c) => c.control === 'eyelids_right')
	if (left || right) {
		return Math.min(left?.value ?? 0, right?.value ?? 0)
	}
	return 0
}
