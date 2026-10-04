"""Seed one published sample Holocron through the running backend, so Learn mode works in the demo
even if live capture fails. Needs the backend running with a working Nebius key (the frames go through the
real vision model and the teach-back through the real synthesizer). Nothing is faked and nothing is written
to the database directly: it replays a short teach session over HTTP, exactly like the browser would.

Usage (from backend/, backend already running):
    uv run python -m scripts.seed_demo                                  # http://localhost:8000, dev or admin mode
    uv run python -m scripts.seed_demo --base-url http://localhost:8010
    uv run python -m scripts.seed_demo --token "$ACCESS_TOKEN"          # supabase mode: a real access token
    uv run python -m scripts.seed_demo --no-publish                     # leave it as a draft

In dev and admin mode the data lives in memory, so run this again after every backend restart.
It prints the Holocron id and the learn URL. Takes roughly 10 to 60 s (model calls).
"""

import argparse
import sys
from pathlib import Path

import httpx

FRAMES = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "frames"

# (t_ms, fixture file): the invoice as it arrives (4711), then after the Master re-codes it (0400).
SEED_FRAMES = [(1000, "01_erp_cost_center_4711.jpg"), (3000, "02_erp_cost_center_0400.jpg")]

# What the Master says. The synthesizer may only quote these lines word for word, so the guardrail
# the learn demo relies on (no capex on 4711, stop and ask without an asset number) is stated plainly here.
SEED_LINES = [
    (1500, "expert", "Invoice 4471 is a compressor from Kessler Pumpen, 7,200 euro, and it arrived on cost center 4711."),
    (2800, "expert", "Equipment over five thousand euro is always capex, so I change the cost center to 0400."),
    (4000, "agent", "What happens if there is no asset number?"),
    (5000, "expert", "I never book capex without an asset number. If it is empty, I stop and ask the controller."),
    (6500, "expert", "Equipment over five thousand euro never goes to 4711, that is the opex cost center."),
]


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base-url", default="http://localhost:8000")
    ap.add_argument("--token", default="", help="Bearer token (supabase mode). Default: demo login in dev/admin mode.")
    ap.add_argument("--user", default="admin")
    ap.add_argument("--password", default="admin")
    ap.add_argument("--title", default="Code equipment invoices (compressor demo)")
    ap.add_argument("--no-publish", action="store_true")
    a = ap.parse_args()

    with httpx.Client(base_url=a.base_url.rstrip("/"), timeout=120) as c:
        try:
            c.get("/health").raise_for_status()
        except httpx.HTTPError as e:
            print(f"Backend not reachable at {a.base_url}: {e}", file=sys.stderr)
            return 1

        token = a.token
        if not token:
            r = c.post("/v1/auth/login", json={"username": a.user, "password": a.password})
            if r.status_code == 200:
                token = r.json()["access_token"]
            elif r.status_code != 404:
                print(f"Login failed ({r.status_code}). Pass --token.", file=sys.stderr)
                return 1
        headers = {"Authorization": f"Bearer {token}"} if token else {}

        def call(method: str, path: str, **kw) -> dict:
            r = c.request(method, path, headers=headers, **kw)
            if r.status_code >= 400:
                print(f"{method} {path} -> {r.status_code}: {r.text[:300]}", file=sys.stderr)
                raise SystemExit(1)
            return r.json()

        sid = call("POST", "/v1/teach/sessions", json={"title": a.title, "language": "en"})["session_id"]
        print(f"teach session {sid}")

        for t_ms, name in SEED_FRAMES:
            data = (FRAMES / name).read_bytes()
            res = call("POST", f"/v1/sessions/{sid}/frames", data={"t_ms": str(t_ms)},
                       files={"frame": (name, data, "image/jpeg")})
            print(f"  frame {name}: {len(res['events'])} events, skipped={res['skipped']}, {res['latency_ms']} ms")
            if res["skipped"]:
                print("  The vision model did not answer. Check NEBIUS_API_KEY and try again.", file=sys.stderr)
                return 1

        call("POST", f"/v1/sessions/{sid}/utterances",
             json={"utterances": [{"t_ms": t, "speaker": s, "text": x} for t, s, x in SEED_LINES]})
        fin = call("POST", f"/v1/sessions/{sid}/finish")
        print(f"  finished: {len(fin['steps'])} steps, {len(fin['gaps'])} gaps")

        tb = call("POST", f"/v1/sessions/{sid}/teachback", json={"confirmed": True, "corrections": []})
        skill_id = tb["skill_id"]
        print(f"  Holocron {skill_id}: {tb['steps_count']} steps, {tb['guardrails_count']} guardrails (draft)")

        if not a.no_publish:
            call("POST", f"/v1/skills/{skill_id}/publish")
            print("  published to the Jedi Archives")

        print(f"\nOpen: http://localhost:3000/dashboard/skills/{skill_id}")
        print(f"Learn: http://localhost:3000/dashboard/learn/{skill_id}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
