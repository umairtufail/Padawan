"""Create or update the two Yoda agents (and their client tools) in ElevenLabs. Safe to re-run.

    cd backend && uv run python -m scripts.setup_voice_agents              # create or update, print ids
    cd backend && uv run python -m scripts.setup_voice_agents --write-env  # also store the ids in ../.env

Reads ELEVENLABS_API_KEY from the repo-root .env (never printed). Agents are found by name, so a
second run updates them in place and the ids stay the same. System prompts come from
app/prompts/interviewer.system.md and tutor.system.md: edit them there, then re-run this script.
"""

import argparse
import re
import sys
from pathlib import Path

import httpx

from app.config import settings

API = "https://api.elevenlabs.io/v1/convai"
PROMPTS = Path(__file__).resolve().parent.parent / "app" / "prompts"
ENV_FILE = Path(__file__).resolve().parents[2] / ".env"

# Stock premade voice, old and calm ("Bill - Wise, Mature, Balanced"). Not a character voice.
VOICE_ID = "EGMW2itgJSj5DZQUUGwo"
TTS_MODEL = "eleven_v3_conversational"  # supports Expressive Mode
LLM = "gemini-2.5-flash"  # fast; change here if latency or quality needs it
# Ignore voices in the background (other people, TV) so they do not count as the speaker's turn.
# Reported to mute the speaker's own voice on speakerphone setups: use headphones, or set False.
BACKGROUND_VOICE_DETECTION = True
# Seconds of user silence before ElevenLabs gives the agent a turn. 30 is the maximum (it cannot be turned off);
# the capture mic is muted between questions, so a shorter value makes Yoda speak up over and over.
TURN_TIMEOUT_S = 30


def _str(desc: str) -> dict:
    return {"type": "string", "description": desc}


def _obj(props: dict, required: list[str]) -> dict:
    return {"type": "object", "properties": props, "required": required}


# name -> (description, parameters, expects_response)
TOOLS: dict[str, tuple[str, dict, bool]] = {
    "log_answer": (
        "Save the expert's answer to the question you just asked. Call it right after the answer.",
        _obj(
            {"question_id": _str("Id of the question, if the [ASK] message gave one, else empty."),
             "summary": _str("One-line summary of the expert's answer, in their words.")},
            ["summary"],
        ),
        False,
    ),
    "set_off_record": (
        "Pause or resume capture when the expert says 'off the record' or says to continue.",
        _obj({"on": {"type": "boolean", "description": "true = off the record (pause), false = resume."}}, ["on"]),
        False,
    ),
    "submit_teachback": (
        "End the debrief once the expert confirmed (or refused to confirm) your teach-back.",
        _obj(
            {"confirmed": {"type": "boolean", "description": "true if the expert confirmed the teach-back."},
             "corrections": _str("Corrections the expert made, empty if none.")},
            ["confirmed"],
        ),
        False,
    ),
    "record_prediction": (
        "Record what the learner predicted for the next move. Returns whether it was right.",
        _obj(
            {"step_idx": {"type": "integer", "description": "Index of the skill step the prediction is about."},
             "predicted": _str("What the learner predicted, in a few words.")},
            ["step_idx", "predicted"],
        ),
        True,
    ),
    "show_replay": (
        "Open the expert's recorded moment for a step in the learner's side panel.",
        _obj({"step_idx": {"type": "integer", "description": "Index of the skill step to replay."}}, ["step_idx"]),
        False,
    ),
    "finish_learning": (
        "End the learning session and show the learner their report.",
        {"type": "object", "properties": {}},
        False,
    ),
}

INTERVIEWER_TOOLS = ["log_answer", "set_off_record", "submit_teachback"]
TUTOR_TOOLS = ["record_prediction", "show_replay", "finish_learning"]

INTERVIEWER_VARS = {
    "mode": "live", "task_title": "a screen task", "gaps": "", "steps_summary": "",
    "last_screen_summary": "", "pending_question": "",
}
TUTOR_VARS = {
    "task_title": "a screen task", "skill_md": "(no skill loaded)", "expert": "the Master",
    "skill_steps": "(none)", "skill_guardrails": "(none)", "current_step": "(none)", "current_step_idx": "0",
}


def agent_body(name: str, prompt_file: str, first_message: str, tool_ids: list[str], variables: dict) -> dict:
    return {
        "name": name,
        "tags": ["padawan", "yoda"],
        "conversation_config": {
            "agent": {
                "first_message": first_message,
                "language": "en",
                "dynamic_variables": {"dynamic_variable_placeholders": variables},
                "prompt": {
                    "prompt": (PROMPTS / prompt_file).read_text(),
                    "llm": LLM,
                    "temperature": 0.4,
                    "tool_ids": tool_ids,
                },
            },
            "tts": {
                "voice_id": VOICE_ID, "model_id": TTS_MODEL, "expressive_mode": True,
                "stability": 0.6, "speed": 0.95,
            },
            # Patient turn-taking: the app drives questions, the agent must not jump in.
            "turn": {"turn_eagerness": "patient", "turn_timeout": TURN_TIMEOUT_S},
            "vad": {"background_voice_detection": BACKGROUND_VOICE_DETECTION},
            "conversation": {
                "max_duration_seconds": 3600,
                "client_events": [
                    "conversation_initiation_metadata", "audio", "interruption", "user_transcript",
                    "agent_response", "agent_response_correction", "client_tool_call", "ping",
                ],
            },
        },
        # Signed URL required: the browser never holds the API key, the backend mints the URL.
        "platform_settings": {"auth": {"enable_auth": True}},
    }


def upsert_tools(c: httpx.Client) -> dict[str, str]:
    existing = {}
    r = c.get("/tools", params={"page_size": 100})
    r.raise_for_status()
    for t in r.json().get("tools", []):
        existing[t["tool_config"]["name"]] = t["id"]
    ids = {}
    for name, (desc, params, expects) in TOOLS.items():
        cfg = {
            "type": "client", "name": name, "description": desc,
            "parameters": params, "expects_response": expects,
        }
        if name in existing:
            r = c.patch(f"/tools/{existing[name]}", json={"tool_config": cfg})
            ids[name] = existing[name]
        else:
            r = c.post("/tools", json={"tool_config": cfg})
            ids[name] = r.json().get("id", "") if r.is_success else ""
        r.raise_for_status()
        print(f"tool {name}: {'updated' if name in existing else 'created'} ({ids[name]})")
    return ids


def upsert_agent(c: httpx.Client, body: dict, configured_id: str = "") -> str:
    # Prefer the id already used by the app. Accounts can contain duplicate agents with the same name;
    # name-only lookup could update an unused duplicate while production keeps running the stale prompt.
    if configured_id:
        r = c.patch(f"/agents/{configured_id}", json=body)
        if r.status_code != 404:
            r.raise_for_status()
            print(f"agent {body['name']}: updated configured agent")
            return configured_id

    r = c.get("/agents", params={"search": body["name"], "page_size": 100})
    r.raise_for_status()
    found = [a["agent_id"] for a in r.json().get("agents", []) if a.get("name") == body["name"]]
    if found:
        r = c.patch(f"/agents/{found[0]}", json=body)
        r.raise_for_status()
        print(f"agent {body['name']}: updated")
        return found[0]
    r = c.post("/agents/create", json=body)
    r.raise_for_status()
    print(f"agent {body['name']}: created")
    return r.json()["agent_id"]


def write_env(values: dict[str, str]) -> None:
    text = ENV_FILE.read_text()
    for key, val in values.items():
        if re.search(rf"^{key}=.*$", text, flags=re.MULTILINE):
            text = re.sub(rf"^{key}=.*$", f"{key}={val}", text, flags=re.MULTILINE)
        else:
            text += f"\n{key}={val}\n"
    ENV_FILE.write_text(text)
    print(f"wrote {', '.join(values)} to {ENV_FILE.name}")


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--write-env", action="store_true", help="store the agent ids in the repo-root .env")
    args = ap.parse_args()
    if not settings.elevenlabs_api_key:
        print("ELEVENLABS_API_KEY is not set (repo-root .env)", file=sys.stderr)
        return 1
    try:
        with httpx.Client(base_url=API, headers={"xi-api-key": settings.elevenlabs_api_key}, timeout=60) as c:
            tools = upsert_tools(c)
            interviewer = upsert_agent(c, agent_body(
                "Yoda (Interviewer)", "interviewer.system.md", "",
                [tools[n] for n in INTERVIEWER_TOOLS], INTERVIEWER_VARS,
            ), settings.elevenlabs_interviewer_agent_id)
            tutor = upsert_agent(c, agent_body(
                "Yoda (Tutor)", "tutor.system.md",
                "Greetings, Padawan. {{expert}} taught me {{task_title}}. Are you ready to learn?",
                [tools[n] for n in TUTOR_TOOLS], TUTOR_VARS,
            ), settings.elevenlabs_tutor_agent_id)
    except httpx.HTTPStatusError as e:
        # Print the API's error text, never the request headers (they hold the key).
        print(f"ElevenLabs error {e.response.status_code}: {e.response.text[:800]}", file=sys.stderr)
        return 1
    ids = {"ELEVENLABS_INTERVIEWER_AGENT_ID": interviewer, "ELEVENLABS_TUTOR_AGENT_ID": tutor}
    for k, v in ids.items():
        print(f"{k}={v}")
    if args.write_env:
        write_env(ids)
    return 0


if __name__ == "__main__":
    sys.exit(main())
