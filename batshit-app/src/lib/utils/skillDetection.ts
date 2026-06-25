/**
 * Returns true if the given skill ID is an artifact-related skill.
 * Matches: 'artifact-creator', 'artifacts', 'artifacts_general', 'artifacts_huggingface_brain', etc.
 */
export function isArtifactSkillId(skillId: string | null | undefined): boolean {
	if (!skillId) return false
	const lower = skillId.trim().toLowerCase()
	return (
		lower === 'artifact-creator' ||
		lower === 'artifact_creator' ||
		lower === 'artifacts' ||
		lower.startsWith('artifacts_') ||
		lower.startsWith('artifacts-')
	)
}
