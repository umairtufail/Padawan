"""Render the synthetic test recording in tests/fixtures/recording_synth/ (fake ERP form, fake data only).

    uv run python -m scripts.make_synth_recording

Ten frames, 1 s apart: cursor-only move, typing in progress, cost center 4711 -> 0400, status Open -> Hold,
a Save dialog with an empty asset number, nothing changing, a saved banner, and a list with two similar rows.
It is NOT a substitute for a real recording (clean fonts, no compression noise); it only exercises the tool.
"""

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUT = Path(__file__).resolve().parent.parent / "tests" / "fixtures" / "recording_synth"
W, H = 1024, 576
FONT = "/System/Library/Fonts/Supplemental/Arial.ttf"


def font(size: int):
    try:
        return ImageFont.truetype(FONT, size)
    except OSError:
        return ImageFont.load_default(size)


def base(d: ImageDraw.ImageDraw, title: str) -> None:
    d.rectangle([0, 0, W, 34], fill="#1f3a5f")
    d.text((14, 8), f"SAPish ERP   |   {title}", fill="white", font=font(15))
    d.rectangle([0, 34, W, 64], fill="#e8ecf1")
    for i, label in enumerate(["Invoices", "Suppliers", "Assets", "Reports"]):
        d.text((16 + i * 90, 42), label, fill="#1f3a5f", font=font(13))


def field(d, x, y, label, value, w=260, active=False):
    d.text((x, y), label, fill="#444", font=font(12))
    d.rectangle([x, y + 18, x + w, y + 44], fill="white", outline="#2b7de9" if active else "#9aa5b1", width=2 if active else 1)
    d.text((x + 8, y + 24), value, fill="#111", font=font(14))


def cursor(d, x, y):
    d.polygon([(x, y), (x, y + 17), (x + 5, y + 13), (x + 10, y + 21), (x + 13, y + 19), (x + 8, y + 11), (x + 14, y + 11)],
              fill="black", outline="white")


def button(d, x, y, w, label, primary=False):
    d.rectangle([x, y, x + w, y + 30], fill="#2b7de9" if primary else "#dfe4ea", outline="#9aa5b1")
    d.text((x + 14, y + 8), label, fill="white" if primary else "#222", font=font(13))


def form(notes="", cost="4711", status="Open", cur=(700, 120), dialog=False, banner=False):
    im = Image.new("RGB", (W, H), "#f6f7f9")
    d = ImageDraw.Draw(im)
    base(d, "Post supplier invoice")
    d.text((24, 80), "Invoice INV-4471   Supplier: Nordwind Metallbau GmbH", fill="#111", font=font(17))
    field(d, 24, 116, "Amount", "1.250,00 EUR")
    field(d, 310, 116, "Cost center", cost, active=False)
    field(d, 596, 116, "Asset no.", "", w=200)
    field(d, 24, 176, "Notes", notes, w=546, active=bool(notes) and notes != "Replacement pump line 3")
    d.text((596, 176), "Status", fill="#444", font=font(12))
    colour = "#f5a623" if status == "Hold" else "#3aa655"
    d.rounded_rectangle([596, 194, 690, 220], radius=12, fill=colour)
    d.text((620, 200), status, fill="white", font=font(13))
    button(d, 24, 244, 90, "Save", primary=True)
    button(d, 126, 244, 90, "Cancel")
    d.text((24, 300), "Recent postings", fill="#444", font=font(12))
    rows = [("INV-4460", "Kuehne Logistik", "310,20", "4711", "Posted"), ("INV-4461", "Nordwind Metallbau", "980,00", "0400", "Posted"),
            ("INV-4462", "Elektro Brandt", "75,90", "4711", "Posted"), ("INV-4463", "Bürobedarf Lang", "44,10", "4711", "Posted"),
            ("INV-4464", "Nordwind Metallbau", "1.120,00", "0400", "Posted"), ("INV-4465", "Kuehne Logistik", "310,20", "4711", "Posted")]
    d.rectangle([24, 320, 1000, 342], fill="#dfe4ea")
    for i, h in enumerate(["Document", "Supplier", "Amount", "Cost ctr", "State"]):
        d.text((32 + i * 190, 325), h, fill="#222", font=font(10))
    for r, row in enumerate(rows):
        y = 346 + r * 22
        d.rectangle([24, y, 1000, y + 20], fill="white" if r % 2 == 0 else "#f0f2f5")
        for i, c in enumerate(row):
            d.text((32 + i * 190, y + 4), c, fill="#222", font=font(10))
    if banner:
        d.rectangle([24, 490, 1000, 530], fill="#d9f2e0", outline="#3aa655")
        d.text((36, 502), "Saved. Document 5100002291 posted.", fill="#17552a", font=font(15))
    if dialog:
        ov = Image.new("RGBA", (W, H), (0, 0, 0, 110))
        im.paste(ov, (0, 0), ov)
        d = ImageDraw.Draw(im)
        d.rectangle([300, 190, 724, 370], fill="white", outline="#555", width=2)
        d.text((318, 204), "Save invoice?", fill="#111", font=font(17))
        d.text((318, 242), "Asset no. is empty. Post anyway?", fill="#333", font=font(14))
        d.text((318, 268), "Cost center 0400 differs from supplier default.", fill="#a33", font=font(12))
        button(d, 460, 320, 110, "Post anyway", primary=True)
        button(d, 584, 320, 110, "Back")
    cursor(d, *cur)
    return im


def list_view(selected=1, cur=(500, 200)):
    im = Image.new("RGB", (W, H), "#f6f7f9")
    d = ImageDraw.Draw(im)
    base(d, "Open invoices")
    d.text((24, 80), "Open invoices (2)", fill="#111", font=font(17))
    rows = [("INV-4471", "Nordwind Metallbau GmbH", "1.250,00", "Hold"), ("INV-4417", "Nordwind Metallbau GmbH", "1.205,00", "Open")]
    d.rectangle([24, 120, 1000, 146], fill="#dfe4ea")
    for i, h in enumerate(["Document", "Supplier", "Amount", "Status"]):
        d.text((32 + i * 230, 128), h, fill="#222", font=font(12))
    for r, row in enumerate(rows):
        y = 150 + r * 34
        d.rectangle([24, y, 1000, y + 30], fill="#cfe3ff" if r == selected else "white", outline="#c4ccd6")
        for i, c in enumerate(row):
            d.text((32 + i * 230, y + 8), c, fill="#222", font=font(13))
    cursor(d, *cur)
    return im


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    frames = [
        form(),
        form(cur=(760, 300)),
        form(notes="Replac", cur=(300, 200)),
        form(notes="Replacement pump line 3", cur=(560, 205)),
        form(notes="Replacement pump line 3", cost="0400", cur=(500, 140)),
        form(notes="Replacement pump line 3", cost="0400", status="Hold", cur=(640, 210)),
        form(notes="Replacement pump line 3", cost="0400", status="Hold", cur=(70, 258), dialog=True),
        form(notes="Replacement pump line 3", cost="0400", status="Hold", cur=(70, 258), dialog=True),
        form(notes="Replacement pump line 3", cost="0400", status="Hold", cur=(520, 335), banner=True),
        list_view(),
    ]
    for i, im in enumerate(frames, 1):
        im.save(OUT / f"frame_{i:02d}.jpg", quality=80)
    exp = [
        {"name": "cursor moved only", "t_ms_range": [1000, 1000], "must_mention": [], "max_events": 0},
        {"name": "typing in notes", "t_ms_range": [2000, 3000], "must_mention": ["pump"]},
        {"name": "cost center 4711 -> 0400", "t_ms_range": [4000, 4000], "must_mention": ["4711", "0400"]},
        {"name": "status Open -> Hold", "t_ms_range": [5000, 5000], "must_mention": ["hold"]},
        {"name": "save dialog with empty asset no.", "t_ms_range": [6000, 6000], "must_mention": ["asset"]},
        {"name": "dialog unchanged", "t_ms_range": [7000, 7000], "must_mention": [], "max_events": 0},
        {"name": "saved banner", "t_ms_range": [8000, 8000], "must_mention": ["5100002291"]},
        {"name": "list with two similar rows, 4417 selected", "t_ms_range": [9000, 9000], "must_mention": ["4417"]},
    ]
    (OUT / "expectations.json").write_text(json.dumps(exp, indent=1) + "\n")
    print(f"wrote {len(frames)} frames to {OUT}")


if __name__ == "__main__":
    main()
