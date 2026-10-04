# Demo runbook (Hack-Nation pitch and local testing)

For ticket #44. Three parts: how to run everything and what to check before going on stage, a 3-minute script grounded in the screens that exist today, and what to do when something breaks. The last part is the recording checklist and the questions judges will ask.

Rules of the pitch: say what is real and what is staged (`AGENTS.md`, rule 7). The honest list of untested parts is in the README, section Status; section 6 below repeats it.

Contents: [1 Run it](#1-run-everything-locally) · [2 Pre-flight](#2-pre-flight-checklist) · [3 The 3-minute script](#3-the-3-minute-script) · [4 Seed a Holocron](#4-pre-seed-a-published-holocron) · [5 Failures](#5-failure-and-fallback-table) · [6 Recording and judge questions](#6-recording-checklist-and-judge-questions)

## 1. Run everything locally

You need [uv](https://docs.astral.sh/uv/), Node 20+, Chrome (screen share and microphone are the most reliable there) and the team keys.

### 1.1 Environment values

The keys are **not** in git. Copy them from the Notion page **Keys and environment values** (team only):

1. Repo-root `.env` (gitignored): `cp .env.example .env`, then fill `NEBIUS_API_KEY`, `NEBIUS_BASE_URL`, `NEBIUS_VLM_MODEL`, `ELEVENLABS_API_KEY`, `ELEVENLABS_INTERVIEWER_AGENT_ID`, `ELEVENLABS_TUTOR_AGENT_ID`. For Supabase mode also `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS_URL`.
2. `frontend/.env.local` (gitignored): `cp frontend/.env.example frontend/.env.local`. Only public values go here (`NEXT_PUBLIC_*`). The default `NEXT_PUBLIC_API_URL=http://localhost:8000` is right for a local backend.

Never paste a key into a chat, a ticket, a PR or a screenshot. Never put `SUPABASE_SERVICE_ROLE_KEY` anywhere near the frontend.

### 1.2 Start the backend and the frontend

```bash
# terminal 1: backend on http://localhost:8000 (docs at /docs)
cd backend && uv sync
AUTH_MODE=dev uv run fastapi dev app/main.py

# terminal 2: frontend on http://localhost:3000
cd frontend && npm install && npm run dev
```

Check: `curl localhost:8000/health` returns `{"status":"ok"}`, and the backend log shows one `SECURITY: AUTH_MODE=dev` line (expected locally, never deploy like this).

Port 8000 or 3000 is taken (an old run still alive)? Find it with `lsof -nP -iTCP:8000 -sTCP:LISTEN` and stop your own process, or move: `uv run fastapi dev app/main.py --port 8010`, `npm run dev -- -p 3010`, then set `NEXT_PUBLIC_API_URL=http://localhost:8010` for the frontend and add the frontend URL to `ALLOWED_ORIGINS` for the backend (CORS only allows `http://localhost:3000` by default).

Stop both servers with Ctrl+C when you are done.

### 1.3 The three auth modes

| Mode | Backend `AUTH_MODE` | Frontend `NEXT_PUBLIC_AUTH_MODE` | Login | Data | Use it for |
|---|---|---|---|---|---|
| dev | `dev` | `admin` | The login page shows; `admin` / `admin` works (the backend accepts any request anyway) | Memory, lost on restart | Rehearsal and the safest stage setup |
| admin | `admin` (also the default if unset) | `admin` | `admin` / `admin` (or `ADMIN_USER`, `ADMIN_PASSWORD`) | Memory, lost on restart | The deployed demo until Supabase login is on |
| supabase | `supabase` | `supabase` | A real account (email and password) | Postgres, survives restarts | The real flow |

Both sides must use the same mode. In `supabase` mode the backend's `/v1/auth/login` returns 404.

There is also a **no-backend UI mode**: `NEXT_PUBLIC_API_MOCK=1 npm run dev` in `frontend/`. Every call is faked, Yoda is a script (no ElevenLabs, no microphone) and the session page has a "mock screen" button. It is good for UI work and as a last-resort look at the flow. It proves nothing about the models, so never present it as the real thing.

### 1.4 Switch to Supabase mode locally

Shared project `reuueppvukwdiytfxezj`. Be careful: other people use it, and test users and rows must be cleaned up afterwards (`AGENTS.md`, definition of done).

1. Backend (`.env` or inline): `AUTH_MODE=supabase` plus `SUPABASE_URL`, `SUPABASE_PUBLISHABLE_KEY`, `SUPABASE_JWKS_URL`.
2. Frontend `.env.local`: `NEXT_PUBLIC_AUTH_MODE=supabase`, `NEXT_PUBLIC_SUPABASE_URL`, `NEXT_PUBLIC_SUPABASE_ANON_KEY` (the publishable key), `NEXT_PUBLIC_API_URL=http://localhost:8000`. Restart `npm run dev` (these values are read at start).
3. Supabase dashboard, **Authentication, URL Configuration**: `http://localhost:3000` must be in the redirect URLs. The **Site URL** decides where the confirmation email link goes. It is `https://padawan-bay.vercel.app` for the deployment. To sign up locally and click the link on your own machine, set it **temporarily to `http://localhost:3000`** and put it back afterwards. Never leave it on localhost: the deployed site's confirmation mails would break.
4. **Confirm email** stays **on** (sign-ups are open and spend Nebius credits). The simplest local route that avoids email completely: **Authentication, Users, Add user** with an email and password and **Auto Confirm User** ticked, then sign in on the login page.
5. Check (see `docs/supabase-login.md`): no token gives 401, and `/v1/auth/login` gives 404.

Data written in `supabase` mode persists, which is what you want for a Holocron that must survive a backend restart. Details: `docs/supabase-login.md`.

## 2. Pre-flight checklist

Do it the morning of, again 30 minutes before, and once more on the venue network (ticket #44). Tick every line.

**Services**
- [ ] Keys valid: run the voice and vision probe below (both must return 200 or events).
- [ ] Backend healthy: `curl <backend>/health`. Frontend loads and login works.
- [ ] Nebius and ElevenLabs reachable from the venue network (`curl -sI https://api.elevenlabs.io` and the frame probe).
- [ ] Not on `AUTH_MODE=dev` if the backend is public. Locally it is fine.
- [ ] A published Holocron exists (section 4). Reload `/dashboard/skills` and see it.

```bash
# run from the repo root
# vision works (one fixture frame; expect events, skipped null)
SID=$(curl -s -X POST localhost:8000/v1/teach/sessions -H 'Content-Type: application/json' -d '{"title":"preflight"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session_id'])")
curl -s -X POST localhost:8000/v1/sessions/$SID/frames -F t_ms=1000 -F "frame=@backend/tests/fixtures/frames/01_erp_cost_center_4711.jpg;type=image/jpeg" | python3 -c "import sys,json;d=json.load(sys.stdin);print('skipped:',d['skipped'],'latency_ms:',d['latency_ms'],'events:',len(d['events']))"
# voice works (a signed URL comes back; never print it)
curl -s -X POST localhost:8000/v1/voice/sessions -H 'Content-Type: application/json' -d "{\"session_id\":\"$SID\",\"mode\":\"capture\"}" | python3 -c "import sys,json;d=json.load(sys.stdin);print('signed_url ok:',d.get('signed_url','').startswith('wss://'))"
```

**Microphone and speakers**
- [ ] Use **headphones** for the Master and the Padawan. Yoda speaks aloud; on speakers the microphone hears him and the agent answers itself or the expert detector fires.
- [ ] Quiet room. A noisy room makes Yoda think the expert is still talking, so the pause controller never lets him ask.
- [ ] Browser microphone permission granted for the site (lock icon in the address bar). Pick the right input device in Chrome and in macOS (System Settings, Sound). Speak one sentence and watch the input level.
- [ ] macOS: System Settings, Privacy and Security, **Screen and System Audio Recording** and **Microphone** both allow Chrome. After changing it, quit and reopen Chrome.
- [ ] Volume at a level you can hear on stage; the hall hears Yoda only if you route audio to the room (a speaker pitch loses the headphones, so test it).

**Screen share picker (Chrome)**
- **Tab**: shares one tab only. Safest for privacy and lowest chance of showing a notification. The Padawan tab itself is excluded (the app asks the browser to leave it out), so you cannot share it by mistake. Chrome shows "switch to this tab": you flip between the shared tab and the Padawan tab to read Yoda's captions.
- **Window**: shares one window. **Recommended for the stage**: put the fake ERP in its **own Chrome window** next to the Padawan window; share that window and keep the Padawan window on the projector.
- **Entire screen**: avoid. It also shows the Padawan UI, Slack and notification banners (PII risk) and the vision model reads everything.
- The pointer is not part of the stream (the app asks for no cursor), and the app compares frames and only sends changed ones.
- [ ] Notifications off (macOS Focus, Do Not Disturb). Slack, mail and calendar closed. Bookmarks bar and other tabs hidden in the shared window.

**Which tab or window to share, and the safe demo task**

There is no interactive sandbox ERP in the repo. The demo uses the four fixture screenshots in `backend/tests/fixtures/frames/` (1024x620, "SandboxERP, Accounts Payable", invoice 4471 "Compressor KX-9" from Kessler Pumpen, EUR 7,200.00, asset no. empty). Fake data only, so nothing sensitive can leak.

| File | Shows | Use |
|---|---|---|
| `01_erp_cost_center_4711.jpg` | Cost center **4711**, asset no. empty | Teach: the start. Learn: the wrong move |
| `02_erp_cost_center_0400.jpg` | Cost center **0400**, asset no. empty | Teach: after the Master re-codes. Learn: the starting screen |
| `04_erp_cost_center_0400_cursor_moved.jpg` | Same as 02, mouse pointer moved | Shows that a pointer move is not a change |
| `03_holocron_view.jpg` | A Holocron page | **Do not use in the live demo**: it takes the screen away from the ERP |

Setup: open a **new Chrome window** that contains one tab. Open `file:///.../backend/tests/fixtures/frames/01_erp_cost_center_4711.jpg` in it and zoom so the image fills the window (Cmd and +). To "edit the field", change that tab's URL to the `02` file (Cmd+L, paste, Enter). Rehearse the switch: it must feel like one click. A second tab for the learn start (`02` loaded) saves a few seconds. Keep the list of the four paths in a note.

Why this works (checked locally against the real vision model): `01` then `02` gives the event "Cost center changed from 4711 to 0400" and the planner returns three questions (reason, exception, limit). In learn mode, `02` then `01` gives the guardrail verdict **stop** ("Equipment over five thousand euro is capex, so cost center 4711 is wrong here"). `01` as the very first frame is only `ok` (the model saw an invoice opened, not a change). **So in learn mode always start on `02` and then switch to `01`.**

## 3. The 3-minute script

Roles: **the Master** (presenter, speaks to Yoda and the room) and **the Padawan** (a second person or a judge, learn part only). Yoda speaks his questions aloud, the text on screen is only captions. Total spoken lines by the presenter are short on purpose: Yoda needs silence to ask.

Times are targets, not measurements. Rehearse twice with a timer and write down your real times. The teach-back and the Holocron write-up call a model (several seconds, up to about 30 s), and that is the main source of overrun.

| Time | Screen and action | The Master says | What Yoda does |
|---|---|---|---|
| 0:00 to 0:15 | Dashboard `/dashboard`. Backend chip says "Backend reachable". Two cards: Teach Yoda (the Master) and Learn from Yoda (the Padawan). | "Every company has a person who knows why. When she leaves, the why leaves. Padawan is an apprentice, not a recorder." | Nothing. |
| 0:15 to 0:35 | **Teach Yoda**. Task name: "Code supplier invoices". Click **Start recording**, choose the ERP **window** in the picker. The session page opens already recording. | "I teach Yoda how I code supplier invoices. I just share the screen and work, nothing to install." | Wakes up by voice at the start (the click allowed audio and the microphone). Stays silent. His mic is muted to him while I work. |
| 0:35 to 1:00 | In the shared window, switch from `01` to `02` (4711 to 0400). Then **stop moving and stop talking** for about 3 seconds. | While working: "Kessler Pumpen, a compressor, 7,200 euro. It arrived on 4711, I change it to 0400." Then silence. | The screen shows frames analysed, the event "Cost center changed from 4711 to 0400", steps filling. After the screen idles 2 s and I am silent 1.5 s, Yoda asks aloud: "Why did you change the cost center from 4711 to 0400?" The mic opens for the answer. |
| 1:00 to 1:15 | Answer, then press **Ask Yoda** for a second question. | Answer: "Equipment over five thousand euro is always capex." Then, to the room: "Yoda asks at the pause, never over me. Next he asks about the limit." After his question: "I never book capex without an asset number. If it is empty I stop and ask the controller." | Says "Got it" and logs the answer ("What Yoda learned" list). **Ask Yoda** asks the best waiting question now. Automatic questions are at least 60 s apart, so the second one on a 3-minute stage is the button. |
| 1:15 to 1:25 | **Off the record.** | "Yoda, off the record." (one beat) "Back on the record." | Marks the session **off the record** (red chip), pauses frame upload and transcript, then resumes on the second phrase. Nothing in between is analysed or stored. |
| 1:25 to 1:40 | Click **Finish session**. "Yoda is sorting the steps..." then the **debrief** page. | "I finish. Yoda sorts what he saw and asks what is still unclear." | The debrief starts by itself. Greets, asks the first open gap aloud (the list on screen is "What is still unclear"). Mic stays open in debrief. |
| 1:40 to 2:00 | Answer one gap. Yoda gives the **teach-back**. Say "yes, exactly", with a correction in writing or voice. Spinner: "Yoda is writing the Holocron... this can take up to 30 seconds". | "Yes, exactly. One correction: the hold applies to every supplier that bills twice in December." While it spins: "Why not just record? A recording shows clicks. This captures the reason and the limit, and checks them with me before anything is saved." | Explains the process back in under a minute, step by step with reasons and limits, asks "Did I get it right?", then calls `submit_teachback`. The backend synthesizes the Holocron and checks that every quote is a verbatim line the Master said. |
| 2:00 to 2:15 | The **Holocron** page: Work map, step detail (screen moment, decision, "Why, in the Master's words", Guardrails with quotes, "Yoda will ask the Padawan"). Click **Publish to the Archives**. Then open **The Jedi Archives**. | "Every limit has my own words and a timestamp. Nothing invented. I read it, I publish, and it is in the Archives for the next hire." | Silent. |
| 2:15 to 2:35 | Switch person to **the Padawan**. In the Archives pick the Holocron, **Start learning**, **Begin the lesson**, share the ERP window which already shows **`02`**. | The Padawan: "New here. A 7,200 euro compressor, what do I code?" | The tutor starts by voice, explains step 1 in the Master's words and asks what the Padawan expects. The Padawan answers by voice: "4711". The prediction is recorded. |
| 2:35 to 2:50 | The Padawan switches the window from `02` to `01` (cost center 4711, asset no. empty). | "I type 4711." | The frame shows "Cost center changed from 0400 to 4711". The guardrail checker returns **stop** before Save: a red banner with the rule, the Master's quote and the reason, and Yoda speaks at once: "Wait. The Master would stop here. Why do you think?" He explains capex, quotes the Master, and the replay shows the Master's moment. |
| 2:50 to 3:00 | Click **Finish the lesson**. The **mastery report**: score, step by step (predicted right or not, stops), "Practise next", Yoda's 2 to 3 sentence summary. | "That is the loop: the expert teaches once, every new hire is stopped by the expert's own rule." | Says the result aloud (two short sentences). |

Close with one sentence on honesty: "The screen here is a staged sandbox, the models, the voice and the stop are real."

If you are short of time, cut in this order: off the record (keep it if privacy is the topic), the second question, the Jedi Archives page. If you are at risk of the Holocron write-up taking long, use the pre-seeded Holocron (section 4) for the learn part and show the teach part as a recording.

The learn part never needs the teach part: open `/dashboard/skills`, pick the seeded Holocron, **Start learning**.

## 4. Pre-seed a published Holocron

A published Holocron is what the learn demo needs. In `dev` and `admin` mode it lives in memory, so **seed again after every backend restart**. In `supabase` mode it persists.

There is no endpoint that creates a skill directly: a Holocron only comes out of a teach session (`teachback`). The script replays one over HTTP, exactly like the browser: create session, send the two fixture frames (`01` then `02`) through the real vision model, post the Master's lines, `finish`, `teachback` (real synthesizer, quote check), `publish`. So it needs the backend running with a working Nebius key.

```bash
cd backend
uv run python -m scripts.seed_demo                           # dev or admin mode on http://localhost:8000
uv run python -m scripts.seed_demo --base-url http://localhost:8010
uv run python -m scripts.seed_demo --token "$ACCESS_TOKEN"   # supabase mode: a real access token
uv run python -m scripts.seed_demo --no-publish              # leave it as a draft
```

Each run adds another Holocron (the Archives show duplicates if you run it twice; restart the backend in dev mode to clear them). It prints the Holocron id and the two URLs (`/dashboard/skills/{id}` and `/dashboard/learn/{id}`). It takes about 10 seconds. Tested locally in `dev` mode: it produced a published Holocron with one step and four guardrails; the learn flow then gave **stop** on `02` then `01`, a correct prediction and a mastery report. The wording of the generated Holocron is produced by a model and can vary between runs: look at it once before you go on stage.

The skill the script creates is "Coding equipment invoices: capex vs opex" (or similar), step "Re-code the equipment invoice from 4711 to 0400", guardrails: equipment over EUR 5,000 never goes to 4711, and no capex without an asset number (stop and ask the controller).

By hand with curl, from the repo root (`docs/frontend-integration.md` has every shape; `dev` mode needs no token, other modes add `-H "Authorization: Bearer $TOKEN"`):

```bash
B=http://localhost:8000
SID=$(curl -s -X POST $B/v1/teach/sessions -H 'Content-Type: application/json' -d '{"title":"Code equipment invoices"}' | python3 -c "import sys,json;print(json.load(sys.stdin)['session_id'])")
curl -s -X POST $B/v1/sessions/$SID/frames -F t_ms=1000 -F "frame=@backend/tests/fixtures/frames/01_erp_cost_center_4711.jpg;type=image/jpeg" >/dev/null
curl -s -X POST $B/v1/sessions/$SID/frames -F t_ms=3000 -F "frame=@backend/tests/fixtures/frames/02_erp_cost_center_0400.jpg;type=image/jpeg" >/dev/null
curl -s -X POST $B/v1/sessions/$SID/utterances -H 'Content-Type: application/json' -d '{"utterances":[{"t_ms":2800,"speaker":"expert","text":"Equipment over five thousand euro is always capex, so I change the cost center to 0400."},{"t_ms":5000,"speaker":"expert","text":"I never book capex without an asset number. If it is empty, I stop and ask the controller."}]}' >/dev/null
curl -s -X POST $B/v1/sessions/$SID/finish >/dev/null
SK=$(curl -s -X POST $B/v1/sessions/$SID/teachback -H 'Content-Type: application/json' -d '{"confirmed":true,"corrections":[]}' | python3 -c "import sys,json;print(json.load(sys.stdin)['skill_id'])")
curl -s -X POST $B/v1/skills/$SK/publish >/dev/null && echo "published $SK"
```

## 5. Failure and fallback table

Rule of thumb: stay calm, say one honest sentence, switch to the fallback, keep the story going. Most failures are designed to be non-fatal: a slow or failed model call returns `skipped` and the stream carries on.

| What happens | What you see | What to do |
|---|---|---|
| **Voice connection hangs** (Yoda never speaks, status stuck on "Connecting...") | The Yoda panel chip stays on connecting, or shows an error | Click **Send Yoda away**, then **Wake Yoda** (a new signed URL is requested). Frames keep being captured meanwhile, so nothing is lost. If it hangs twice: check the ElevenLabs probe (section 2), switch network (phone hotspot), then fall back to the recording. In capture you can still read the captions and the on-screen events and continue the talk yourself. |
| **Nebius is slow** | Frame chips show "not analysed" and latency climbs. Backend gives each vision call 8 s, then `skipped: timeout` (also `busy`, `vision_error`, `parse_error`) | Normal and by design: a skipped frame is dropped, not retried, and at most one call is in flight per session. The browser keeps at most 6 waiting frames (oldest dropped) and retries the **first** frame twice. Make the change **once more** and wait: for example flip `02` back to `01`, then to `02`. Measured typical latency is about 1.4 s per frame with outliers up to 8 s. If a stop does not fire in the learn part (the checker has a 5 s budget and falls back to `ok`): flip the window once more, the same stop is not repeated within 30 s, so wait that long or use the seeded replay. Last resort: the recording. |
| **Yoda does not hear the Master** | Captions show nothing from you; "Microphone is muted to Yoda" | In **capture** the mic to Yoda is muted on purpose while you work, and **opens when he asks** (for 30 s). If your answer is not caught, press **Mic off, unmute** (a toggle in the Yoda panel: "Mic on, mute"), speak again. In **debrief and learn** the mic is open from the start; if it is not, use the same toggle. Check browser permission, the input device, and headphones (echo). In the debrief you can also use **Answer in writing instead** (typed answers). Pressing the toggle by hand stops the automatic muting. |
| **Screen share denied or cancelled** | "Screen sharing was cancelled. Press the button again when you are ready." | Press the button again and click **Share** in the picker. If the picker never shows macOS permission is missing: System Settings, Privacy and Security, Screen and System Audio Recording, enable Chrome, restart Chrome. Share a **window** instead of the tab if the tab is not listed. |
| **Microphone denied** | An error in the Yoda panel ("Microphone not available...") | Lock icon, allow the microphone, reload the page. If a session was already running, start a new one. |
| **Backend restarts** | In `dev` and `admin` mode all sessions and Holocrons are gone: "Session not found" or "Holocron not found", empty Archives; you may be sent back to the login | Sign in again, **re-run the seed** (section 4, about 10 s), reload the Archives. Run the backend **without** `--reload` on stage (`uv run fastapi run app/main.py` or leave `fastapi dev` alone and do not save files), so an edit cannot restart it. In `supabase` mode data persists. Guardrail checks and gaps for unasked questions also live partly in server memory (README, known limits). |
| **Debrief page is empty or lost** | "Yoda is sorting..." forever, or a load error | The finish result is kept in the browser tab (`sessionStorage`): do not open the debrief in another tab. If lost, create the Holocron through curl (section 4) and carry on from the Holocron page. |
| **Teach-back takes long or fails** | Spinner for more than 30 s, or "Try again" | Synthesis has a 60 s limit. Press **Try again** once. Then use the pre-seeded Holocron and continue with learn. |
| **Wrong or empty questions** | Yoda does not ask, or asks something odd | Press **Ask Yoda** (asks the best waiting candidate, or a generic "why" question). Candidates only come when a frame has a salient event, so make a clear change (`01` to `02`). |
| **Venue network blocks the voice websocket** | Voice fails everywhere, probes fail | Phone hotspot. If that also fails: play the recording and run learn with the seeded Holocron (text and captions still work only if voice connects, so state it plainly). |
| **Everything is down** | | Play the fallback recording (section 6) and walk the judges through the live code and the Holocron JSON. |

## 6. Recording checklist and judge questions

### Recording the fallback video

Ticket #44 asks for one full successful run as a video and a seeded skill for learn.

- [ ] Same setup as the stage: fixtures in a separate window, headphones off or a loopback so Yoda's voice is recorded (QuickTime does not capture system audio; use OBS with the macOS audio capture source, or a loopback driver, and record a 10 s test first to check that Yoda's voice and your microphone are both on the track).
- [ ] 1080p, 30 fps, a dark or plain desktop, notifications off, other tabs closed, no personal data on screen (also in the address bar and bookmarks).
- [ ] Record the **real** product end to end (teach, off the record, debrief, teach-back, Holocron, publish, learn, stop, report). No cuts that hide a failure. Cuts to skip waiting are fine if the video says "sped up".
- [ ] Take at least two runs; keep the best, name it with the date (`padawan-demo-fallback-2026-10-XX.mp4`), keep a copy on the presenter laptop (offline) and in a shared folder.
- [ ] Play it once from the laptop with Wi-Fi off, with sound, on the room's display output.
- [ ] Keep it under the pitch limit; a 3-minute cut and a longer full version.
- [ ] Say on the video or on the slide that it is a recording ("recorded run").

### Likely judge questions, honest answers

**1. What is real and what is mocked?** Real: the vision model (DeepSeek V4.1 Flash on Nebius) reads the frames and reports changes, the question planner, the ElevenLabs voice agents (Yoda speaks his questions aloud and listens), the gap finder, the teach-back, the Holocron synthesizer with a quote check, the guardrail checker and the mastery report. Staged: the "ERP" is four fixture screenshots (`backend/tests/fixtures/frames/`), the Master's lines are rehearsed, and in dev mode login is a demo account and data is in memory. We also have a mock mode with a scripted Yoda; we do not demo it as the product.

**2. What did you not test?** From the README: a browser session with a real microphone and the ElevenLabs agent all the way through (we tested the voice over a real websocket and the flows in a browser with a fake screen share), real screen recordings of a real workflow (#39), token renewal after an hour, and the Supabase login on the deployed frontend. The guardrail checker scored 40 of 40 on hand-written cases, which is a small set we wrote ourselves.

**3. Privacy and PII?** Frames are redacted on the backend before anything is stored or returned (emails, IBANs and card numbers checked, phone numbers, names after a cue such as "Herr" or "Mr."). Invoice numbers and cost centers stay on purpose. It is not a guarantee: free-form names and addresses can slip through, and the transcript lines are not redacted yet (check `docs/frontend-integration.md` before you claim otherwise). The Master can say "off the record" and frames and transcript stop. Only changed frames leave the browser, straight to our backend. Each user's data is separated in the database with row-level security (tested with two users). Keyframes are small, stripped JPEGs in a private bucket. Learners cannot see an author's keyframes yet.

**4. Why not just record the screen?** A recording shows what was clicked, not why, and nobody watches hours of video. Yoda asks at natural pauses, captures the reason and the limit in the Master's own words, gets the Master to confirm a teach-back, and only then writes the Holocron, and every guardrail quote must be a verbatim line from the Master (the backend rejects a skill whose quotes do not match). Later it intervenes in real time, which a video cannot.

**5. Cost per hour?** Measured: about 1.4 s per frame (1.2 to 2.5 s in our runs) and 200 to 300 completion tokens per frame on four fixtures. One call is in flight at a time, so the ceiling is about 2,500 frames per hour even if every sample changed. The browser only sends changed frames, so a real hour is far below that: for illustration, one meaningful change every 10 to 15 s would be 240 to 360 frames. We did not measure a bill: multiply frames by the model's price per token (prompt tokens, including the image, were not logged) and add three text calls (planner, synthesis once, guardrail check per learn frame with a change) and the ElevenLabs conversation minutes. We do not quote a dollar figure because we have not measured one.

**6. Does it generalize beyond this ERP screen?** Not shown. The prompts and the pipeline are generic (screen summary, events, entities, a skill JSON with steps, reasons and guardrails), the model is a general vision model, but we only ran it on the sandbox fixtures and an evaluation script (`scripts/eval_vision`). Real workflows (#39) are not tested. Dense screens, small text and other languages (`language` is a field, only English was exercised) are risks.

**7. How do you keep Yoda from hallucinating a rule?** The synthesizer is only allowed to quote the Master. Every quote is checked as a verbatim span of an expert line; a skill that fails the check is never saved, and a reason can be `null` when the Master never gave one (the backend never invents one). The tutor prompt treats the Holocron as the only source of truth and says "ask the Master" when it does not cover a case. The guardrail checker is conservative: a **stop** needs confidence of at least 0.8 and a real guardrail id, otherwise it is a warning.

**8. What are the limits and failure modes?** The vision call takes about 1.4 s on average with outliers up to 8 s, so a very fast mistake can pass before the verdict, and a move that is already saved is never a stop (too late, it is a warning). The checker has a 5 s budget and on a timeout the verdict is `ok`, which is a miss, not a false alarm. One vision call at a time per session; extra frames are skipped, not queued. The first Holocron write-up takes up to about 30 s. A restart loses the in-memory data (not in Supabase mode). Questions are limited to one per 60 s automatically (at most five in ten minutes) so Yoda stays an apprentice and not an interrogator.

### Boundaries to keep in the pitch

Name and style only: no official logos, film stills, character art, music or the real voice (`AGENTS.md`). Yoda is our AI, the voice is an ElevenLabs agent.
