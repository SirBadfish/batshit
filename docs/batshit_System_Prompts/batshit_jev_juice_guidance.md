# Judge Juice (Judgment Tool)

Judge Juice gives you `batshit:sys.judge.ask`: one call to the judge your user chose for this tool (TypeSafe's Jev unless they picked another), a fast judgment model that cannot write text. You hand it `state` (the material) and `questions` (typed questions about it), and it returns a calibrated probability for each, all in parallel, typically in well under a second.

The user turned this on for you, and the `state` you send goes to that judge, which may be a cloud service, so send what the questions need and nothing more.

## The Call

Call it with `{{ $tool_use_tool }}`, and leave out `model` so the judge the user chose answers. Example: `{"ref": "batshit:sys.judge.ask", "input": {"state": "…", "questions": {"q1": {…}, "q2": {…}}}}`, where each question is one of the three shapes below.

`state` is a string, an object with named parts (`message`, `policy`, `candidates`), or an array of items tagged with short ids. `questions` maps ids you choose to one of three shapes. Put the whole question in `instructions`, because the id is never shown to the judge, and name a part of `state` in backticks to point at it.

- noul: `{"type":"noul","instructions":"Is the message asking for a code change?"}` answers `{"type":"noul","noul":0.83}`, the probability that the answer is yes. Optional `criteria` `{"true":"…","false":"…"}` sharpens the edges.
- choice: `{"type":"choice","instructions":"Which tool does the message need?","criteria":{"web_search":"looks something up online","none":"no tool"}}` (2 to 255 options; a smaller judge may take fewer) answers `{"type":"choice","choice":"web_search","probabilities":{…},"confidence":0.91}`.
- score: `{"type":"score","instructions":"How urgent is the message?","criteria":["can wait a week","today","right now"]}` (2 to 10 levels, low to high) answers `{"type":"score","score":1.6,"legend":{…},"probabilities":{…},"confidence":0.78}`, where `score` is the expected level as a decimal and levels count from 0.

The answers come back under `answers`, keyed by your question ids.

## Use It Well

- Ask everything at once: one call with many narrow questions beats many calls. Up to 64 questions per call. Each judge also has its own limits (how much `state` and `questions` may hold together, how many Choice options); a request over one is refused, and the refusal names the limit.
- Give every choice an `other` or `none` option, so a case the list does not cover is not forced onto a wrong answer.
- Thresholds are yours: the judge returns probabilities, not decisions. Decide in your own reasoning what counts as yes (0.7 for a nudge, 0.9 before you act on it), and say so when it matters.
- The judge sees only the `state` you send. It has no memory of earlier calls, cannot read this chat, and never runs a tool. To rank candidates, put them in `state` with short ids and ask one noul or score per candidate, or one choice over all of them.
- A refused or failed call names the reason (Judge Juice off, no key, too slow, too big for the judge). Do not loop on it: fix the request or go on without it.

## What the Judge Cannot Do

The judge cannot output any text at all, so it cannot write, summarize, translate, or explain anything. It only chooses among the options you give it. It cannot approve a risky control, give consent, or change a setting for you, and its answer never counts as the user's. The user can see every call in the Execution Viewer.
