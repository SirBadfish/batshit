# Expression Contract

Every engine record must declare one explicit expression strategy. This tells Batshit how (or whether) agents can influence the emotional tone, style, or prosody of generated speech.

---

## Why This Matters

Some engines let you say "speak warmly." Others want inline tags like `[laugh]`. Others control expression through request parameters. Many don't support expression at all.

If Batshit doesn't know which kind this engine is, agents will either send markup the engine chokes on, or miss expression capabilities it actually supports.

Get this right during setup and the agent's voice output will be natural. Get it wrong and you get either robotic speech (missed expression) or errors (wrong format).

---

## The Four Strategies

### `none`

**Use when:** The engine has no supported expressive control that Batshit should use.

This is the safe default. Most engines fall here:
- Basic TTS engines (Piper, espeak)
- APIs where the voice model handles emotion automatically (ElevenLabs)
- Engines where expression exists but isn't documented well enough to register reliably

**What Batshit does:** Strips unsupported XML/markup before sending to the engine. Agents get no expression guidance.

> *"ElevenLabs handles tone and emotion through the voice model itself — no separate expression control needed. Setting strategy to `none`."*

### `instructions`

**Use when:** Expression should be passed as instruction text — typically through an `instructions` field in the request.

Good for engines that accept natural-language style guidance like "speak warmly" or "use a professional news anchor tone." The instruction goes alongside the spoken text, not inside it.

**What Batshit does:** Passes the agent's expression guidance through the `instructions` field. The spoken text stays clean.

**Example engines:** OpenAI TTS (`instructions` parameter), Qwen3-TTS (`instruct` field)

**How to identify:** Look for API fields called `instructions`, `instruct`, `style`, `tone`, or `voice_description` that accept free-text prose.

> *"OpenAI's TTS API supports an `instructions` parameter for describing speaking style — things like 'warm and friendly' or 'dramatic narration.' Setting strategy to `instructions`."*

### `inline_tokens`

**Use when:** Expression belongs directly inside the spoken text as special tokens.

Good for engines that support bracket-style paralinguistic tags like `[laugh]`, `[sigh]`, `[cough]`, or `[whisper]`.

**What Batshit does:** Preserves supported tokens in the text stream. Agents include them naturally in speech output.

**Example engines:** Chatterbox (`[laugh]`, `[sigh]`, `[chuckle]`, etc.)

**How to identify:** Look for "paralinguistic tokens" or bracket-style tags in the documentation.

When using this strategy, record the known tokens:

```json
"expression": {
  "strategy": "inline_tokens",
  "supportedTokens": ["[laugh]", "[sigh]", "[cough]", "[chuckle]", "[gasp]"]
}
```

Only list tokens you've confirmed. Don't guess.

> *"Chatterbox supports inline tokens — `[laugh]` or `[sigh]` right in the text, and the engine renders them as natural sounds. Setting strategy to `inline_tokens`."*

### `request_options`

**Use when:** Expression belongs in a structured request field that takes specific values (not free text).

Less common. For engines that accept `{ "emotion": "happy" }` or `{ "style_id": 3 }`.

**How to identify:** Look for request fields with enumerated emotion/style values.

```json
"expression": {
  "strategy": "request_options",
  "requestOptionKey": "emotion"
}
```

> *"This engine has a `style` field that accepts 'neutral', 'happy', 'sad', 'angry'. Setting strategy to `request_options` with key `style`."*

---

## Decision Flow

```
Does the engine have ANY form of expression/style control?
├── No → "none"
└── Yes → How?
    ├── Free-text instructions alongside speech → "instructions"
    ├── Inline tokens in the text → "inline_tokens"
    ├── Structured request parameter → "request_options"
    └── Not sure / docs unclear → "none" (safe default — upgrade later)
```

**When in doubt, choose `none`.** It's always safe. Claiming expression support that doesn't work is worse than missing support that does.

---

## Cross-System Safety

Expression strategy must not interfere with:

- **Group chat** — `<batshit-group>` is the first-output control tag. Expression markup must not conflict.
- **Goons** — `*goon:*` cues and emoji parsing. Expression tokens must not collide with goon cue syntax.
- **speakable-text sanitization** — already strips unsupported XML before TTS. The strategy determines what gets preserved vs stripped.

When registering `inline_tokens`, make sure the token syntax doesn't look like XML tags (would get stripped) or goon cues (would get parsed as animation triggers).

---

## Telling the User

Explain in plain language, not jargon:

> *"This engine supports expression through inline tokens — agents can include `[laugh]` or `[sigh]` in their speech and the engine will render them naturally."*

> *"This engine doesn't have separate expression controls — the voice model handles tone automatically. Your agents will sound natural without special markup."*

> *"Agents can describe how they want to sound — like 'speak warmly' — and this engine will adjust."*
