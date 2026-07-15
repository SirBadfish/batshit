# Writing Skills That Work for Any LLM

This reference helps you write skill instructions that work well across all AI models — from large frontier models to smaller local ones. When you create a skill, you are writing instructions that a model will follow. The quality of those instructions directly determines how well the skill works.

Load this reference when you are creating a skill that needs careful, well-structured instructions — especially skills that will be used across different models or by agents the user may not be able to easily debug.

---

## The Core Challenge

Different models have different capabilities:

- **Large models** (Claude, GPT-4, Gemini Pro) can handle nuance, implicit instructions, and complex multi-step reasoning
- **Medium models** follow explicit instructions well but may struggle with ambiguity or very long documents
- **Small local models** need very clear, step-by-step instructions and can lose track of context that appears far from where it's needed

Your goal is to write instructions that the largest models find natural AND the smallest models can still follow successfully. This is not about dumbing things down — it is about being clear, structured, and explicit.

---

## Structure Patterns That Work

### 1. Ground the Agent Immediately

The first 2-3 lines of a SKILL.md body should tell the agent:
- **What** it is (its role)
- **What** its job is (the outcome it should produce)

**Good:**
> "You are a code security auditor. Your job is to analyze code for security vulnerabilities and produce a clear report of findings with severity ratings and fix recommendations."

**Bad:**
> "This skill helps with code. It can find problems. When the user asks about security, you should look at their code and think about whether there might be issues."

The good version tells the model exactly who it is and what it delivers. The bad version is vague — a small model might interpret "helps with code" as "write code" or "explain code."

### 2. Use Numbered Steps, Not Prose

Models follow ordered lists more reliably than paragraphs of instructions.

**Good:**
> ### Your Workflow
> 1. Read the code the user provided
> 2. Identify potential security issues (injection, auth bypass, data exposure, etc.)
> 3. Rate each issue: Critical, High, Medium, Low
> 4. For each issue, explain what's wrong and how to fix it
> 5. Summarize the overall security posture

**Bad:**
> When you get code, you should analyze it for security. Think about different kinds of vulnerabilities. Consider how severe they are. You might want to suggest fixes too. At the end, give an overall assessment.

The bad version leaves the model guessing about the order, what's required vs optional, and what "think about" actually means.

### 3. Put Important Rules Early

Models prioritize instructions partly based on where they appear. Critical rules should show up in the first quarter of the document, not buried at the bottom.

**Pattern:**
```markdown
# Skill Name

[Role statement — 2-3 lines]

## Important Rules (Read First)
- Rule 1
- Rule 2

## Your Workflow
[Steps...]

## Detailed Reference
[Deeper material loaded on demand...]
```

If a rule is truly non-negotiable, put it near the top AND repeat it briefly where it's relevant in the workflow. The small cost of repetition is worth the reliability.

### 4. Use Tables for Routing Decisions

When the agent needs to choose between paths, tables are more reliable than prose. Models parse tabular structure well.

**Good:**

| The user wants... | Do this |
|---|---|
| A full security audit | Run all checks, produce complete report |
| A quick scan | Focus on Critical and High issues only |
| Help fixing a specific issue | Analyze just that code path, suggest the fix |

**Bad:**
> If the user wants a full audit, run all checks and produce a complete report. But if they just want a quick scan, focus only on the critical and high issues. And if they need help fixing one specific thing, just analyze that code path.

The table version is scannable, unambiguous, and hard to misinterpret. The prose version buries conditions in conjunctions.

### 5. Include Real Examples

Show what good output looks like. Models learn from concrete examples far more effectively than from abstract descriptions.

**Good:**
> ### Example Finding
> **Issue:** SQL Injection in user search
> **Severity:** Critical
> **Location:** `searchUsers()` in `api/users.ts`, line 45
> **Problem:** User input is concatenated directly into SQL query without parameterization
> **Fix:** Use parameterized query: `db.query('SELECT * FROM users WHERE name = $1', [searchTerm])`

**Bad:**
> Your findings should include the issue name, how bad it is, where it is, what's wrong, and how to fix it.

The bad version tells the model WHAT to include but not WHAT IT LOOKS LIKE. The good version shows the exact format.

### 6. Write for the Confused Model

If a step could be misinterpreted, add a one-line clarification. This costs almost nothing for large models but saves small models from going off-track.

**Good:**
> 3. Rate each issue: Critical, High, Medium, Low
>    - "Critical" means the vulnerability could be exploited right now with minimal effort
>    - "Low" means it's a theoretical concern or bad practice, not an active risk

**Bad:**
> 3. Rate each issue by severity

The clarification lines are essentially free for large models (they would have rated correctly anyway) but they prevent small models from inventing their own severity scale or skipping the rating entirely.

### 7. Keep Rules Absolute

"Never do X" is clearer than "Try to avoid X when possible." Hedged language gives models permission to ignore the rule.

**Good:**
- Never show raw SQL queries in the report — always use placeholders
- Never skip the severity rating, even for minor issues

**Bad:**
- Try not to include raw SQL queries if you can help it
- It would be nice to include severity ratings when applicable

### 8. Use "Handling Common Situations" Sections

Instead of trying to cover every edge case in the main workflow, add a dedicated section for common scenarios. This keeps the main flow clean while still giving the agent guidance for tricky situations.

**Pattern:**
```markdown
## Handling Common Situations

### The user provides minified code
Explain that minified code is harder to audit accurately. Offer to analyze it
anyway with the caveat that line numbers won't be meaningful. Suggest they
provide the source version if possible.

### The code is in a language you don't recognize
Say so honestly. Offer to look for common patterns (hardcoded credentials,
obvious injection points) but be clear that a language-specific audit would
be more thorough.
```

This pattern works because it tells the model EXACTLY what to do in specific situations, rather than hoping it figures out the right response.

---

## Anti-Patterns to Avoid

### The Wall of Text
Long, unstructured paragraphs of instructions. Models lose track of what matters when everything is buried in prose. Break it up with headers, lists, and tables.

### The Assumption Trap
Assuming the model knows what a specific tool, system, or term means without explaining it. Even if it's likely in the model's training data, a quick one-liner prevents confusion — especially for smaller models.

**Instead of:** "Use the Fabric registry to save."
**Write:** "Use the Fabric control transport available in this lane to call `sys.skill.save`, then surface any save error in plain language."

### The Ambiguous Fork
"Do X or Y depending on the situation." Which situation? Be explicit about the conditions that determine which path to take.

**Instead of:** "Choose the right format based on the context."
**Write:** "If the user asked for a summary, use bullet points. If they asked for a full report, use the detailed format with sections."

### The Hidden Rule
A critical constraint buried in paragraph 4 of section 7. If a rule matters, it should be visible — either near the top of the document, or clearly labeled in a "Rules" section that the model will scan.

### The Over-Specification
Specifying every micro-detail when the model would make perfectly good default choices. This wastes tokens and can actually make smaller models perform worse by overwhelming them with instructions they can't all hold in context.

**Rule of thumb:** Specify the things that MUST be a certain way. Let the model handle things that just need to be reasonable.

### The Jargon Dump
Using technical terms without brief explanations. Not all models have equal training on specialized vocabulary, and the end users who read the agent's output may not understand heavy jargon either.

---

## Writing Skills That Depend on Tools

### CLI Tool Dependencies

When a skill needs CLI tools to function, handle it explicitly:

1. **Declare the tools early** — list them near the top of the SKILL.md body so the agent knows what's needed before starting
2. **Add a preflight check** — tell the agent to verify tools exist (`which <tool>`, `command -v <tool>`) before attempting the workflow
3. **Provide a fallback** — if the tool isn't available, tell the user what to install and how to register it in Batshit (via `/cli-tool-creator`)
4. **Don't duplicate tool details** — the CLI tool's manifest already defines inputs, args, and output format. The skill teaches when and why to use it, not how the tool's flags work.

**Example preflight section:**
```markdown
## Before You Start

Check that these CLI tools are registered in Batshit:
1. Run `which yt-dlp` — if missing, the user needs to install yt-dlp and register it with `/cli-tool-creator`
2. Run `which ffmpeg` — if missing, the user needs to install ffmpeg and register it with `/cli-tool-creator`

Do not proceed until both tools are confirmed available.
```

### MCP Tool Dependencies

When a skill needs MCP tools, declare them as dependencies in the frontmatter and check availability at runtime through the tool-discovery method available in the current lane. If a required MCP tool isn't available, explain what gateway or service the user needs to set up.

### Fabric Dependencies

When a skill operates on Batshit features, use Fabric controls directly:
- Use the control-discovery and control-execution method available in the current lane
- Execute the exact Fabric control ID or ref the lane provides
- If a control returns an error, surface the error to the user in plain language — don't silently fail

---

## Batshit-Specific Writing Tips

### Reference the Batshit Guide for Deep Context

If your skill needs the agent to understand Batshit systems in depth (artifacts, voice engines, sessions, etc.), don't try to explain everything inside the skill. Instead, tell the agent to invoke the **Batshit Guide** system skill (`/batshit-guide`), whose references are the official Batshit docs:

> "If you need detailed information about Batshit's artifact system, invoke the Batshit Guide skill and read its artifact references."

This keeps skills focused on their specific job while giving agents a clear path to deeper context when needed.

### Tool Instructions Should Be Explicit

When your skill uses Batshit tools, spell out the tool name and what to call:

**Good:**
> Call `sys.artifact.create` through the current Fabric control transport and provide the `name` and `content` fields inside `input`.

**Bad:**
> Create the artifact using the Fabric system.

The good version tells the model exactly what to call and what to pass. The bad version assumes the model knows how Fabric works.

### Safety and Permissions Should Be Visible

If your skill does anything that writes files, uses the network, accesses saved keys, or modifies Batshit state, say so clearly in the skill body. Don't hide risky operations inside steps that look innocent.

### Keep the User Informed

Skills that perform multi-step operations should include checkpoints where the agent reports progress to the user. Don't let the agent silently run through 10 steps — the user should know what's happening and have chances to course-correct.

---

## Starter Template

Here is a minimal but well-structured starter template. This skeleton works for skills of any complexity — expand the sections as needed.

```markdown
---
name: "my-skill-name"
description: "One clear sentence about what this skill does."
metadata: {"displayName":"My Skill Name"}
---

# My Skill Name

You are a [role]. Your job is to [what you do] when the user [trigger/request].

---

## How This Works

[2-3 sentences explaining the core concept, if needed]

---

## Your Workflow

1. [First step]
2. [Second step]
3. [Third step]
4. [Report back to the user with a clear summary]

---

## Handling Common Situations

### [Situation 1]
[What to do]

### [Situation 2]
[What to do]

---

## Rules

- [Rule 1]
- [Rule 2]
```

This template has been proven to work well across models of all sizes. The key elements: clear role statement, numbered workflow, common situations, and explicit rules.
