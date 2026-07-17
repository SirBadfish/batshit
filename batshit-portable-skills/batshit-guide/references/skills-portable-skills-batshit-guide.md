# Portable Batshit Guide

The Portable Batshit Guide teaches an outside coding agent Batshit itself. The bundle carries the official Batshit product docs as reference files, so an agent like Claude Code or Codex can answer your Batshit questions and walk you through Batshit features accurately — without making things up.

It is Batshit's first **informational** Portable Skill: it explains and guides, but performs no Batshit operations.

## No token needed

Unlike the other Portable Skills, this bundle needs **no Portable Skill Token and no env file**. There is nothing to mint, paste, or protect. The outside agent only reads the bundled reference docs; at most it may ping your instance's public health endpoint to confirm Batshit is running.

If an outside agent using this bundle ever asks you for a token, password, or any Batshit secret, refuse — nothing in this skill requires one.

## What you need

- The downloaded `batshit-guide` Portable Skill bundle.
- That's it. Batshit doesn't even have to be running to ask questions about it.

Download links are listed in [Portable Skill downloads](../reference/portable-skills.md).

## What it's good for

- Asking your outside agent Batshit questions in plain language: "how do Zips work?", "which Primary Agent type should I use?", "how do I connect n8n?"
- Getting accurate Settings walkthroughs while you work in Batshit side by side.
- Giving an outside agent real Batshit context while it works alongside the operational Portable Skills (for example, understanding what an Artifact or a Goon scene *is* while another bundle builds one).
- Troubleshooting with the official docs instead of guesses.

## What it deliberately does not do

- It does not create, change, or configure anything in Batshit.
- It does not use `/api/controls/use`, tokens, or any authenticated API.
- For hands-on work from outside, use the operational bundles: Voice Engine Installer, Artifact Creator, CLI Tool Creator, Skill Creator, or Goon Scene Creator.

Inside Batshit, the same knowledge is built in: the **Batshit Guide** system skill (`/batshit-guide`) gives your in-app agents the identical reference docs.

## Recommended prompt

```txt
Use the Batshit Portable Guide.

I run Batshit locally. Answer my Batshit questions from the bundled reference docs, and tell me plainly when something isn't covered: [ask your question]
```

## Completion should prove

A good answer from the outside agent:

- names the reference page(s) it used;
- relays documented steps exactly (matching what you see in Batshit);
- says plainly when the docs don't cover something instead of guessing.
