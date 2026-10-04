"""Regenerates docs/architecture.svg. Edit the fe / be / ext lists below (built=True turns a box green),
then run:  python3 docs/make_architecture_svg.py
"""
from xml.sax.saxutils import escape as esc

W, H = 1700, 1110
PX = {"fe": 40, "be": 620, "ext": 1200}      # panel x
PW = 460                                      # panel width
BW, BH = 410, 50                              # box size
Y0, PITCH = 215, 72                           # first row y, row pitch
def row_y(i): return Y0 + i * PITCH
def bx(col): return PX[col] + 25
G, T = "#059669", "#94a3b8"                   # built / todo accents

out = []
def add(s): out.append(s)

add(f'<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}" font-family="-apple-system, BlinkMacSystemFont, Segoe UI, Helvetica, Arial, sans-serif">')
add('<title>Padawan architecture: green is built, gray dashed is not built yet</title>')
add('<defs>'
    f'<marker id="ag" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{G}"/></marker>'
    f'<marker id="at" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="11" markerHeight="11" markerUnits="userSpaceOnUse" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="{T}"/></marker>'
    '</defs>')
add(f'<rect width="{W}" height="{H}" fill="#ffffff"/>')

# header + legend
add('<text x="40" y="52" font-size="30" font-weight="800" fill="#0f172a">Padawan architecture</text>')
add('<text x="40" y="82" font-size="16" fill="#475569">Where we are: what is built (green) and what is still to build (gray, dashed).</text>')
add(f'<rect x="1090" y="36" width="34" height="22" rx="6" fill="#d1fae5" stroke="{G}" stroke-width="2"/>')
add('<text x="1136" y="53" font-size="15" fill="#0f172a">Built and merged to main</text>')
add(f'<rect x="1090" y="70" width="34" height="22" rx="6" fill="#f1f5f9" stroke="{T}" stroke-width="2" stroke-dasharray="6 4"/>')
add('<text x="1136" y="87" font-size="15" fill="#0f172a">Not built yet</text>')

# panels
def panel(col, title, sub, sub_fill="#64748b"):
    add(f'<rect x="{PX[col]}" y="118" width="{PW}" height="960" rx="18" fill="#f8fafc" stroke="#cbd5e1" stroke-width="2"/>')
    add(f'<text x="{PX[col]+25}" y="152" font-size="19" font-weight="800" fill="#0f172a">{esc(title)}</text>')
    add(f'<text x="{PX[col]+25}" y="176" font-size="13" fill="{sub_fill}">{esc(sub)}</text>')
panel("fe", "Frontend: Next.js on Vercel", "Vercel build is blocked, the old page is still live", "#b45309")
panel("be", "Backend: FastAPI on FastAPI Cloud", "Live, but running open (dev mode): set AUTH_MODE=admin", "#b45309")
panel("ext", "External services", "Nebius, Supabase, ElevenLabs")

def box(col, i, title, sub, built):
    x, y = bx(col), row_y(i)
    if built:
        add(f'<rect x="{x}" y="{y}" width="{BW}" height="{BH}" rx="10" fill="#d1fae5" stroke="{G}" stroke-width="2"/>')
        tc, sc = "#064e3b", "#047857"
    else:
        add(f'<rect x="{x}" y="{y}" width="{BW}" height="{BH}" rx="10" fill="#f1f5f9" stroke="{T}" stroke-width="2" stroke-dasharray="6 4"/>')
        tc, sc = "#475569", "#64748b"
    add(f'<text x="{x+14}" y="{y+22}" font-size="15" font-weight="700" fill="{tc}">{esc(title)}</text>')
    add(f'<text x="{x+14}" y="{y+40}" font-size="12" fill="{sc}">{esc(sub)}</text>')

# ---- boxes
fe = [
 (0, "Landing + admin login", "public page, login form talks to the backend", True),
 (1, "Dashboard + session page", "backend status, sessions, live events", True),
 (3, "Screen capture + frame gate", "sends only changed frames; real share not tested yet", True),
 (7, "Holocron / Work Map view", "steps, reasons and guardrails of a session", False),
 (8, "Jedi Archives marketplace", "browse Holocrons, start a session", False),
 (9, "Learn session", "replay the Master's moment, stop before Save", False),
 (10, "Supabase login UI", "email and password, Supabase mode (admin login stays the default)", True),
 (11, "Yoda voice UI", "mic, captions, pause controller", False),
]
be = [
 (0, "Auth", "admin login + token check, Supabase JWT check", True),
 (1, "Sessions API", "create, list, detail", True),
 (2, "Storage layer", "memory, or Supabase as the user (RLS)", True),
 (3, "Frames API", "one call in flight, timeout, skip, never queue", True),
 (4, "Vision service + prompts", "frame + previous summary gives events", True),
 (5, "Question planner", "what Yoda asks (prompt written, no code)", False),
 (6, "Step segmenter + gap finder", "steps for the debrief", False),
 (7, "Skill synthesizer", "Holocron JSON + SKILL.md, quotes checked", False),
 (8, "Skills API", "list, publish, export", False),
 (9, "Guardrail checker", "learn mode: stop the wrong move before Save", False),
 (10, "PII redaction + off the record", "Presidio, nothing stored in the range", False),
 (11, "Voice sessions", "signed URLs for the Yoda agents", False),
]
ext = [
 (0, "Supabase Auth", "email and password works; Google not set up", True),
 (2, "Supabase Postgres + RLS", "8 tables, sign-up trigger, owner policies", True),
 (4, "Nebius: DeepSeek V4.1 Flash", "vision model, 1 to 2 s per frame", True),
 (6, "Supabase Storage + Realtime", "keyframes bucket, live steps (enabled, unused)", False),
 (11, "ElevenLabs Agents", "Yoda interviewer + tutor", False),
]
for i,t,s,b in fe:  box("fe", i, t, s, b)
for i,t,s,b in be:  box("be", i, t, s, b)
for i,t,s,b in ext: box("ext", i, t, s, b)

# FE notes (rows with no box)
note = lambda x,y,s: add(f'<text x="{x}" y="{y}" font-size="12" font-style="italic" fill="#64748b">{esc(s)}</text>')
note(bx("fe")+4, row_y(4)+14, "All calls go through lib/api.ts (token handling, mock mode).")
note(bx("fe")+4, row_y(4)+34, "Frames go straight from the browser to the backend,")
note(bx("fe")+4, row_y(4)+52, "never through a Next.js route (Vercel body limit).")

# ---- arrows
def mid(col,i): return row_y(i) + BH/2
def right(col): return bx(col) + BW
def left(col):  return bx(col)
def harrow(x1, x2, y, built, label=None, label_dy=-8):
    st = f'stroke="{G}" stroke-width="2.5" marker-end="url(#ag)"' if built else f'stroke="{T}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#at)"'
    add(f'<line x1="{x1}" y1="{y}" x2="{x2}" y2="{y}" {st}/>')
    if label:
        add(f'<text x="{(x1+x2)/2}" y="{y+label_dy}" font-size="11" text-anchor="middle" fill="{G if built else "#64748b"}">{esc(label)}</text>')
def varrow(x, y1, y2, built):
    st = f'stroke="{G}" stroke-width="2.5" marker-end="url(#ag)"' if built else f'stroke="{T}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#at)"'
    add(f'<line x1="{x}" y1="{y1}" x2="{x}" y2="{y2}" {st}/>')
def darrow(x1,y1,x2,y2, built):
    st = f'stroke="{G}" stroke-width="2.5" marker-end="url(#ag)"' if built else f'stroke="{T}" stroke-width="2" stroke-dasharray="6 5" marker-end="url(#at)"'
    add(f'<line x1="{x1}" y1="{y1}" x2="{x2}" y2="{y2}" {st}/>')

gx1, gx2 = right("fe")+4, left("be")-4          # gap between FE and BE boxes
# built: FE -> BE
harrow(gx1, gx2, mid("fe",0), True, "login")
harrow(gx1, gx2, mid("fe",1), True, "sessions")
harrow(gx1, gx2, mid("fe",3), True, "JPEG frames")
# planned: FE -> BE
darrow(gx1, mid("fe",7), gx2, mid("be",8)-6, False)
harrow(gx1, gx2, mid("fe",8), False, "skills")
harrow(gx1, gx2, mid("fe",9), False, "learn")
harrow(gx1, gx2, mid("fe",11), False, "voice")
# BE -> EXT
ex1, ex2 = right("be")+4, left("ext")-4
harrow(ex1, ex2, mid("be",0), False, "verify tokens")
harrow(ex1, ex2, mid("be",2), True, "as the user")
harrow(ex1, ex2, mid("be",4), True, "frame + summary")
harrow(ex1, ex2, mid("be",6), False, "steps, keyframes")
harrow(ex1, ex2, mid("be",11), False, "signed URL")
# inside backend (vertical)
cx = bx("be") + BW/2
varrow(cx-70, row_y(1)+BH+2, row_y(2)-3, True)      # sessions -> storage
varrow(cx+70, row_y(3)-3, row_y(2)+BH+2, True)      # frames -> storage (up)
varrow(cx-70, row_y(3)+BH+2, row_y(4)-3, True)      # frames -> vision
for a,b in [(4,5),(5,6),(6,7),(7,8)]:
    varrow(cx, row_y(a)+BH+2, row_y(b)-3, False)

add('</svg>')
import pathlib
pathlib.Path(__file__).with_name("architecture.svg").write_text("\n".join(out))
print("ok", len("\n".join(out)), "bytes")
