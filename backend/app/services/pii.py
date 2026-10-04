"""PII redaction for model output. Lightweight on purpose: regex plus checksum validators, no extra dependency.

Presidio was considered and rejected for now: it needs spaCy plus a language model download (hundreds of MB,
a runtime download that is fragile on FastAPI Cloud) and adds seconds of cold start. The patterns below cover the
structured identifiers; names are only caught through explicit cues (see NAME_CUES), which is a known gap.

Principles: precision first. Invoice numbers, cost centers (4711), dates, amounts and article numbers must survive,
because the skill is built from them. IBANs must pass mod 97, card numbers must pass Luhn.
"""

import re
from dataclasses import dataclass, field

EMAIL_RE = re.compile(r"[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}")
IBAN_RE = re.compile(r"\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{1,4}){3,9}\b")
CARD_RE = re.compile(r"(?<![\w-])\d{4}(?:([ -])\d{4}){2,3}(?:\1\d{1,4})?(?![\w-])|(?<![\w-])\d{13,19}(?![\w-])")
# International (+49 ..., 0049 ...) or national with a leading 0 and separators. Needs 8 to 15 digits in total.
PHONE_RE = re.compile(
    r"(?<![\w+/.-])(?:(?:\+|00)\d{1,3}[ .-]?(?:\(0\)[ .-]?)?\(?\d(?:[ ./()-]{0,2}\d){6,12}"
    r"|0\d{1,4}(?: ?[/.-] ?| )\d{3,}(?:(?: ?[/.-] ?| )\d{1,6}){0,3})(?![\w-])"
)
# Names only after an explicit cue: a title or a label. Two capitalised words at most.
_CAP = r"[A-ZÄÖÜ][a-zäöüß]+(?:-[A-ZÄÖÜ][a-zäöüß]+)?"
NAME_CUES = re.compile(
    r"(\b(?:Mr|Mrs|Ms|Dr|Herr|Frau|Hr|Fr|Mister|Madame|Monsieur)\.?\s+|"
    r"\b(?:Customer|Contact|Kunde|Ansprechpartner(?:in)?|Name|Employee|Mitarbeiter(?:in)?|Approver|"
    r"Sachbearbeiter(?:in)?)\s*[:=]\s*)"
    rf"({_CAP}(?:\s+{_CAP})?)"
)


@dataclass
class Redactor:
    """Redacts text and counts what it found by kind."""

    counts: dict[str, int] = field(default_factory=dict)

    @property
    def total(self) -> int:
        return sum(self.counts.values())

    def _hit(self, kind: str) -> str:
        self.counts[kind] = self.counts.get(kind, 0) + 1
        return f"[{kind}]"

    def text(self, s: str) -> str:
        if not s:
            return s
        s = EMAIL_RE.sub(lambda m: self._hit("EMAIL"), s)
        s = IBAN_RE.sub(self._iban, s)
        s = CARD_RE.sub(self._card, s)
        s = PHONE_RE.sub(self._phone, s)
        return NAME_CUES.sub(lambda m: m.group(1) + self._hit("NAME"), s)

    def value(self, v):
        """Redact any JSON-like value (strings inside lists and dicts)."""
        if isinstance(v, str):
            return self.text(v)
        if isinstance(v, list):
            return [self.value(x) for x in v]
        if isinstance(v, dict):
            return {k: self.value(x) for k, x in v.items()}
        return v

    def _iban(self, m: re.Match) -> str:
        groups = m.group(0).split(" ")
        # A greedy match can swallow following capitalised words; shorten until the checksum passes.
        for n in range(len(groups), 0, -1):
            if is_valid_iban("".join(groups[:n])):
                rest = " ".join(groups[n:])
                return self._hit("IBAN") + (" " + rest if rest else "")
        return m.group(0)

    def _card(self, m: re.Match) -> str:
        return self._hit("CARD") if luhn_ok(re.sub(r"\D", "", m.group(0))) else m.group(0)

    def _phone(self, m: re.Match) -> str:
        digits = re.sub(r"\D", "", m.group(0))
        # National numbers need 9+ digits so that "0815 4711" (an article number) is left alone.
        minimum = 8 if m.group(0).startswith(("+", "00")) else 9
        return self._hit("PHONE") if minimum <= len(digits) <= 15 else m.group(0)


def luhn_ok(digits: str) -> bool:
    if not 13 <= len(digits) <= 19 or not digits.isdigit() or len(set(digits)) == 1:
        return False
    total = 0
    for i, ch in enumerate(reversed(digits)):
        d = int(ch)
        if i % 2:
            d = d * 2 - 9 if d > 4 else d * 2
        total += d
    return total % 10 == 0


def is_valid_iban(s: str) -> bool:
    s = s.replace(" ", "").upper()
    if not 15 <= len(s) <= 34 or not re.fullmatch(r"[A-Z]{2}\d{2}[A-Z0-9]+", s):
        return False
    moved = s[4:] + s[:4]
    return int("".join(str(int(c, 36)) for c in moved)) % 97 == 1


def redact_frame_result(summary: str, events: list[dict]) -> tuple[str, list[dict], int]:
    """Redact screen_summary and the text fields of events. Returns (summary, events, redactions found)."""
    r = Redactor()
    clean_events = []
    for ev in events:
        ev = dict(ev)
        for key in ("summary", "visible_text", "entities"):
            if key in ev:
                ev[key] = r.value(ev[key])
        clean_events.append(ev)
    return r.text(summary), clean_events, r.total
