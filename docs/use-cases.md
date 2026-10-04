# Use cases for Padawan

Padawan teaches a **screen task**, not a document: an expert does something in a tool, Yoda asks *why* at the right pause, and the session becomes a Holocron (steps, reasons, guardrails) that Yoda later uses to tutor a new hire and stop them before a costly mistake.

A good use case has four things:
1. **It happens on a screen**, in an app the vision model can read (clear labels, panels, dialogs).
2. **The reasons are not visible.** A screen recording shows *what* happened; the value is *why this setting* and *when not to*.
3. **There is a costly wrong move** that Yoda can stop before it is committed (export, send, publish, delete, deploy, apply).
4. **A new hire repeats it often enough** that teaching it once pays off.

The demo so far uses an ERP-style form because it is easy to fake and screenshot. Nothing in the product is tied to forms: the same pipeline works for any tool with a visible UI. The options below are deliberately different from each other and not about invoices.

> Honest status: the vision pipeline was tested on a synthetic form recording (about 82% of expected changes found on average, see `backend/README.md`) and on hand-made frames. A dense editor UI (timeline, panels) is a harder screen and has **not** been tested yet. Run `backend/scripts/eval_recording.py` on a real recording of the candidate tool before committing to it for a demo.

---

## 1. Video editor: export a vertical clip for social media (recommended demo)

**Tool:** DaVinci Resolve, CapCut, Premiere Pro or iMovie (CapCut is free and runs in a browser or desktop).
**Expert:** a video editor with two years of experience.
**Learner:** a new social media intern.

**What the Master does on screen:** imports a 16:9 interview, creates a 9:16 timeline, reframes the subject, cuts the dead air, adds captions, normalises the audio, sets the export preset.

**Why questions Yoda asks (the value):**
- Why 9:16 and not 4:5 for this channel? Why is the safe zone for captions the middle third?
- Why cut at that breath and not at the end of the sentence?
- Why loudness target -14 LUFS, and what happens above it?
- When would you not reuse the preset? Who approves the first export of a new client?

**Guardrails the Holocron captures:**
- Never export before checking the captions are inside the platform safe zone.
- Never use the client's logo file from the "old" folder; only from `brand/current`.
- Stop before "Publish" if the audio meter peaks above 0 dB.

**Learn session:** the intern opens the same project; Yoda predicts with them ("what do you expect the caption box to do on 9:16?") and stops them at Export if the safe zone is not checked.
**Why it demos well:** visual, quick to understand in 30 seconds, no confidential data, everyone has watched a clip being edited.
**Risk:** dense timeline UI; test the vision model on it first.

## 2. Design handoff in Figma: prepare a component for developers

**Tool:** Figma. **Expert:** a senior product designer. **Learner:** a junior designer.

Steps: name layers, set auto layout, create variants (default, hover, disabled), attach tokens, write the spec note, mark "ready for dev".
Why questions: why auto layout instead of fixed frames, why variants instead of copies, why this spacing token and not 12px by hand, when would you not mark it ready.
Guardrails: never mark "ready for dev" with unnamed layers; never detach an instance of the design system component; stop before publishing the library if a variant is missing its disabled state.
Value: design systems are full of rules that live only in the heads of seniors.

## 3. Customer support: triage and answer a ticket (Zendesk, Intercom, Help Scout)

**Expert:** a support lead. **Learner:** a new agent in week one.

Steps: read the ticket, check the customer's plan and history, pick the macro, personalise it, set priority and tags, decide on escalation, send.
Why questions: why this macro and not the refund one, why tag it "billing-risk", when do you escalate to engineering instead of answering, what do you never promise in writing.
Guardrails: never promise a refund over a limit without approval; never send before checking the plan tier; stop before "Send and close" on a ticket tagged legal or security.
Value: tone, limits and escalation judgement are the hardest things to onboard.

## 4. Sales operations: qualify a lead and update the CRM (HubSpot, Salesforce)

**Expert:** an account executive. **Learner:** a new SDR.

Steps: open the lead, check company size and fit, scan recent activity, decide the stage, write the next-step note, assign the owner, schedule the follow-up.
Why questions: why this lead is "not a fit", what signal makes you move it to qualified, why assign to the enterprise team above 200 seats.
Guardrails: never change the owner of an active deal; never log a stage change without a next step; stop before "Mark as closed lost" if the last activity is under 14 days.

## 5. Data analyst: build a dashboard tile that the team can trust (Metabase, Looker, Excel/Sheets)

**Expert:** an analyst. **Learner:** a new analyst or a manager who wants self-service.

Steps: choose the dataset, filter test accounts, pick the metric definition, check the date range and time zone, build the chart, add the caption with the definition, share.
Why questions: why exclude internal accounts, why "weekly active" counts a user once per week, why this chart type, when would the number look wrong and who checks it.
Guardrails: never publish a tile without the definition in the caption; never use the raw events table when a cleaned model exists; stop before sharing if the date range is "all time" for a rate metric.
Value: wrong numbers that look right are expensive and the rules are tribal.

## 6. DevOps: ship a release safely (cloud console, CI dashboard, feature flags)

**Expert:** an on-call engineer. **Learner:** a new backend engineer on their first release.

Steps: check the CI run, read the diff summary, roll out to 5%, watch the error rate and latency panels, expand to 50%, then 100%, or roll back.
Why questions: why 5% first, which panel do you trust, what error rate makes you stop, who do you tell before a Friday deploy.
Guardrails: never deploy when the error budget is spent; never skip the 5% stage; stop before "Promote to 100%" if p95 latency rose more than 20%.
Value: runbooks exist but nobody reads them; a tutor that watches the real screen is better.
**Caution:** use a sandbox project, never real production credentials in a demo.

## 7. E-commerce: list a product that converts and does not get taken down (Shopify, WooCommerce, Etsy)

Steps: upload photos in the right order, write the title and bullets, choose the category, set variants and shipping profile, set the price, preview, publish.
Why questions: why the white-background photo first, why this keyword in the first 40 characters, why free shipping over a threshold, what words the marketplace rejects.
Guardrails: never publish with a missing shipping profile; never use a claim the marketplace flags ("cure", "guaranteed"); stop before "Publish" if the main image is under the minimum size.

## 8. Contract review: redline a standard agreement (Word, Google Docs)

**Expert:** an in-house lawyer. **Learner:** a paralegal or a junior business owner.

Steps: open the template, check the parties, scan the liability and termination clauses, apply the approved fallback wording, comment on anything outside policy, send for review.
Why questions: why cap liability at 12 months of fees, why this fallback and not the customer's, which clauses always go to a lawyer.
Guardrails: never accept unlimited liability; never remove the data-protection clause; stop before "Accept all changes" or "Send" if a clause is outside the playbook.
Note: legal content is sensitive; PII redaction and "off the record" matter most here.

## 9. Photo and image retouching: product photos to a brand standard (Photoshop, Lightroom, Canva)

Steps: crop to the ratio, fix white balance, remove the background, add the soft shadow, apply the brand colour profile, export for web.
Why questions: why this crop for marketplaces, why a soft shadow and not a hard one, why sRGB and not Adobe RGB for export.
Guardrails: never export with the wrong colour profile; never overwrite the original; stop before export if the file is over the size limit of the shop.

## 10. HR onboarding: set up a new employee across systems (Workday, BambooHR, Google Admin)

Steps: create the profile, choose the department and cost group, assign laptop and licences, set the access groups, schedule orientation.
Why questions: why access groups instead of individual permissions, why the laptop order must start 10 days before day one, who approves admin access.
Guardrails: never grant admin groups without approval; never create the account before the contract is signed; stop before "Send welcome email" if the start date is in the past.

---

## Which one to demo?

| Use case | Visual in 30 s | Costly wrong move | Safe to fake | Vision difficulty | Fit for a 3 minute demo |
|---|---|---|---|---|---|
| 1 Video editor (CapCut) | very high | export with bad audio or off-safe-zone | yes, local project | medium to hard (timeline) | **best story** |
| 2 Figma handoff | high | mark ready for dev incomplete | yes, a file | medium | good |
| 3 Support triage | medium | refund promise, legal ticket | yes, sandbox helpdesk | easy (text heavy) | good, easy to read |
| 4 CRM lead update | medium | overwrite owner, closed lost | yes, free CRM | easy | fine |
| 5 Dashboard tile | high | wrong metric published | yes, public dataset | medium (charts) | good |
| 6 Release rollout | medium | promote with bad metrics | needs sandbox | medium | strong for engineers |
| 7 Product listing | high | rejected or banned listing | yes, test shop | medium | good |
| 8 Contract redline | medium | unlimited liability | yes, sample contract | easy (text) | sensitive |
| 9 Photo retouch | very high | wrong colour profile | yes | hard (pixel work) | visual but subtle |
| 10 HR onboarding | low | wrong access | needs sandbox | easy | dull to watch |

**Recommendation:** use **1 (video editor)** for the pitch because it is the most visual, and keep **3 (support triage)** as the second example because it is easy to read and shows judgement and limits. Mention 5 and 6 as the enterprise angle ("every team has this tribal knowledge").

## How to adapt the demo to a new use case

1. **Pick a safe sandbox** (a local project, a free account, a copy of a file). No real customer data, no production credentials.
2. **Record a rehearsal** of the task and run `backend/scripts/eval_recording.py recording.mp4 --expect expectations.json` to see whether the vision model reads the screen (see `backend/README.md`). Write the expectations for the 6 to 8 changes that matter.
3. **Change the learning moment, not the product:** the guardrail checker needs one clear wrong move. Pick the one a new hire really makes, and prepare the "wrong" screen state for the learn demo.
4. **Seed a Holocron** for the learn part with `backend/scripts/seed_demo.py` (see `docs/demo.md`) so the demo does not depend on a live synthesis.
5. **Rewrite the script text** in `docs/demo.md` (task names, the wrong move, the reason) and keep the beats: pause, why, off the record, debrief, Holocron, Archives, learn, STOP, report.

## What changes in the product for a new tool

Nothing in the code. The prompts are generic ("screen task, fields, buttons, dialogs"). If the vision model misreads a very dense tool, the levers are: share a window instead of the whole screen, zoom the app (browser zoom or editor UI scale) so labels are readable at the frame size, and add the tool's vocabulary to `backend/app/prompts/vision_events.system.md` (and re-run `uv run python -m scripts.eval_vision --trials 5` before and after, as `AGENTS.md` asks).
