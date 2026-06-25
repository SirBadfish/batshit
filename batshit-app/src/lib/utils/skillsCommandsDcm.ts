export const SKILLS_COMMANDS_USAGE_LINES = [
  '- Prompt commands expand reusable instruction templates.',
  '- Skill commands load context-heavy skills with reference documentation.',
  '- An enabled skill is permission to use that skill when it clearly matches the user\'s request. You may proactively invoke any listed skill by calling native_skill with its listed skillId and action="invoke"; the user does not need to type the slash command first. Use judgment; skip skills for simple requests that do not need the skill workflow.',
  '- When a skill is explicitly invoked, you will see a "[Skill: name | skillId=id]" marker in the message. You MUST immediately activate the skill: call native_skill with that skillId and action="invoke". This returns the SKILL.md instructions plus available references. Then follow ALL instructions in the SKILL.md; it will tell you what reference files to load next (use native_skill with action="read").',
  '- If the user asks to import a skill, you may perform the import on their behalf.',
  '- CLI slash commands are separate and are not expanded outside CLI agents.'
] as const

export function appendSkillsCommandsUsageLines(lines: string[]) {
  lines.push('skills_commands_usage:')
  lines.push(...SKILLS_COMMANDS_USAGE_LINES)
}
