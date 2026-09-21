Jev Juice gives you `sys.judge.ask`: one call to TypeSafe's Jev, a fast judgment model that cannot write text. You hand it `state` (the material) and `questions` (typed questions about it), and it returns a calibrated probability for each, all in parallel, in about a quarter of a second. The user turned this on for you, and the `state` you send leaves this computer and goes to TypeSafe, so send what the questions need and nothing more.

## The call

`sys.judge.ask` takes `state` and `questions`. `state` is a string, an object with named parts (`message`, `policy`, `candidates`), or an array of items tagged with short ids. `questions` maps ids you choose to one of three shapes; put the whole question in `instructions`, because the id is never shown to Jev, and name a part of `state` in backticks to point at it.

- noul: `{"type":"noul","instructions":"Is the message asking for a code change?"}` answers `{"type":"noul","noul":0.83}`, the probability that the answer is yes. Optional `criteria` `{"true":"…","false":"…"}` sharpens the edges.
- choice: `{"type":"choice","instructions":"Which tool does the message need?","criteria":{"web_search":"looks something up online","none":"no tool"}}` (2 to 255 options) answers `{"type":"choice","choice":"web_search","probabilities":{…},"confidence":0.91}`.
- score: `{"type":"score","instructions":"How urgent is the message?","criteria":["can wait a week","today","right now"]}` (2 to 10 levels, low to high) answers `{"type":"score","score":1.6,"legend":{…},"probabilities":{…},"confidence":0.78}`, where `score` is the expected level as a decimal and levels count from 0.

`model` is optional and must be the configured Jev id; leave it out.

## Use it well

- Ask everything at once: one call with many narrow questions beats many calls. Up to 64 questions per call; `state` and `questions` together must stay under about 30k tokens, or the call is refused with a message that says so.
- Give every choice an `other` or `none` option, so a case the list does not cover is not forced onto a wrong answer.
- Thresholds are yours: Jev returns probabilities, not decisions. Decide in your own reasoning what counts as yes (0.7 for a nudge, 0.9 before you act on it), and say so when it matters.
- Jev sees only the `state` you send. It has no memory of earlier calls, cannot read this chat, and never runs a tool. To rank candidates, put them in `state` with short ids and ask one noul or score per candidate, or one choice over all of them.
- A refused or failed call names the reason (Jev Juice off, no key, too slow, too big). Do not loop on it: fix the request or go on without it.

## What Jev cannot do

Jev cannot write, summarize, translate, or explain anything; it only chooses among the options you give it. It cannot approve a risky control, give consent, or change a setting for you, and its answer never counts as the user's. The user can see every call in the Execution Viewer.
