import { describe, expect, it } from "vitest";
import { ChangeDetector, diffFrames, rgbaToLuma, type FrameDiffOptions } from "./frame-diff";

const W = 480;
const H = 270;
const OPTS: FrameDiffOptions = { width: W, height: H };

function fill(w: number, h: number, v: number): Uint8Array {
  return new Uint8Array(w * h).fill(v);
}

function rect(buf: Uint8Array, w: number, x: number, y: number, rw: number, rh: number, v: number): void {
  for (let j = y; j < y + rh; j++) for (let i = x; i < x + rw; i++) buf[j * w + i] = v;
}

/** mulberry32 seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function addNoise(buf: Uint8Array, amp: number, seed: number): Uint8Array {
  const rnd = prng(seed);
  const out = new Uint8Array(buf.length);
  for (let i = 0; i < buf.length; i++) {
    const d = Math.round((rnd() * 2 - 1) * amp);
    out[i] = Math.max(0, Math.min(255, buf[i] + d));
  }
  return out;
}

function toRgba(luma: Uint8Array): Uint8ClampedArray {
  const out = new Uint8ClampedArray(luma.length * 4);
  for (let i = 0; i < luma.length; i++) {
    out[i * 4] = luma[i];
    out[i * 4 + 1] = luma[i];
    out[i * 4 + 2] = luma[i];
    out[i * 4 + 3] = 255;
  }
  return out;
}

describe("rgbaToLuma", () => {
  it("uses BT.601 integer weights and ignores alpha", () => {
    const rgba = new Uint8Array([255, 0, 0, 255, 0, 255, 0, 10, 0, 0, 255, 0, 255, 255, 255, 255, 0, 0, 0, 255]);
    const luma = rgbaToLuma(rgba);
    expect(luma.length).toBe(5);
    expect(Array.from(luma)).toEqual([(77 * 255) >> 8, (150 * 255) >> 8, (29 * 255) >> 8, (256 * 255) >> 8, 0]);
    expect(luma[3]).toBe(255);
  });

  it("accepts Uint8ClampedArray", () => {
    expect(rgbaToLuma(new Uint8ClampedArray([128, 128, 128, 255]))[0]).toBe(128);
  });
});

describe("diffFrames", () => {
  it("identical frames are not significant", () => {
    const a = fill(W, H, 120);
    const r = diffFrames(a, a.slice(), OPTS);
    expect(r.reason).toBe("none");
    expect(r.significant).toBe(false);
    expect(r.changedPixels).toBe(0);
    expect(r.changedBlocks).toBe(0);
    expect(r.totalBlocks).toBe(32 * 18);
    expect(r.bbox).toBeNull();
    expect(r.clusters).toEqual([]);
  });

  it("ignores +-4 noise", () => {
    const a = addNoise(fill(W, H, 128), 0, 1);
    const b = addNoise(a, 4, 2);
    const r = diffFrames(a, b, OPTS);
    expect(r.significant).toBe(false);
    expect(r.changedPixels).toBe(0);
  });

  it("ignores a cursor-sized change", () => {
    const a = fill(W, H, 255);
    const b = a.slice();
    rect(b, W, 52, 52, 3, 5, 0);
    const r = diffFrames(a, b, OPTS);
    expect(r.changedPixels).toBe(15);
    expect(r.significant).toBe(false);
  });

  it("ignores a caret-sized change", () => {
    const a = fill(W, H, 255);
    const b = a.slice();
    rect(b, W, 100, 100, 1, 5, 0);
    expect(diffFrames(a, b, OPTS).significant).toBe(false);
  });

  it("ignores a short one-pixel shimmer", () => {
    const a = fill(W, H, 255);
    const b = a.slice();
    rect(b, W, 200, 40, 1, 12, 0);
    expect(diffFrames(a, b, OPTS).significant).toBe(false);
  });

  it("detects a text-like change spanning two blocks", () => {
    const a = fill(W, H, 20);
    const b = a.slice();
    // 10x4 area straddling the block boundary at x=60; 40 px dark -> light
    rect(b, W, 55, 100, 10, 4, 230);
    const r = diffFrames(a, b, OPTS);
    expect(r.changedPixels).toBe(40);
    expect(r.significant).toBe(true);
    expect(["local-cluster", "strong-block"]).toContain(r.reason);
    expect(r.reason).toBe("local-cluster");
    expect(r.largestCluster).toBe(2);
    const box = r.bbox;
    expect(box).not.toBeNull();
    if (box) {
      expect(box.x).toBeLessThanOrEqual(55);
      expect(box.y).toBeLessThanOrEqual(100);
      expect(box.x + box.w).toBeGreaterThanOrEqual(65);
      expect(box.y + box.h).toBeGreaterThanOrEqual(104);
      expect(box.w * box.h).toBeLessThan(W * H * 0.01);
    }
  });

  it("detects a single strong block", () => {
    const a = fill(W, H, 20);
    const b = a.slice();
    rect(b, W, 31, 31, 8, 8, 230); // 64 px inside block (2,2): 28% of 225
    const r = diffFrames(a, b, OPTS);
    expect(r.changedBlocks).toBe(1);
    expect(r.reason).toBe("strong-block");
    expect(r.bbox).toEqual({ x: 30, y: 30, w: 15, h: 15 });
  });

  it("two far-apart tiny changes are not significant, three are scattered", () => {
    const a = fill(W, H, 255);
    const mk = (points: [number, number][]): Uint8Array => {
      const b = a.slice();
      for (const [x, y] of points) rect(b, W, x, y, 3, 5, 0);
      return b;
    };
    const two = diffFrames(a, mk([[20, 20], [400, 200]]), OPTS);
    expect(two.changedBlocks).toBe(2);
    expect(two.significant).toBe(false);

    const three = diffFrames(a, mk([[20, 20], [400, 200], [200, 100]]), OPTS);
    expect(three.changedBlocks).toBe(3);
    expect(three.largestCluster).toBe(1);
    expect(three.reason).toBe("scattered");
    expect(three.bbox).not.toBeNull();
    if (three.bbox) {
      expect(three.bbox.x).toBeLessThanOrEqual(20);
      expect(three.bbox.x + three.bbox.w).toBeGreaterThanOrEqual(403);
      expect(three.bbox.y + three.bbox.h).toBeGreaterThanOrEqual(205);
    }
  });

  it("detects a 60x30 region and a full screen switch as large-area", () => {
    const a = fill(W, H, 20);
    const b = a.slice();
    rect(b, W, 100, 100, 60, 30, 230);
    const r = diffFrames(a, b, OPTS);
    expect(r.significant).toBe(true);
    expect(r.changedPixels).toBe(1800);
    // 1800 / 129600 = 1.4%: below area rule, so found by the local rules
    expect(r.reason).toBe("local-cluster");

    const sw = diffFrames(a, fill(W, H, 200), OPTS);
    expect(sw.reason).toBe("large-area");
    expect(sw.changedPercent).toBe(100);
    expect(sw.bbox).toEqual({ x: 0, y: 0, w: W, h: H });
    expect(sw.clusters.length).toBe(1);
    expect(sw.clusters[0].blocks).toBe(sw.totalBlocks);
  });

  it("large area wins over local rules and reports reason large-area", () => {
    const a = fill(W, H, 20);
    const b = a.slice();
    rect(b, W, 0, 0, 200, 40, 230); // 8000 px = 6.2%
    const r = diffFrames(a, b, OPTS);
    expect(r.changedPercent).toBeGreaterThan(3);
    expect(r.reason).toBe("large-area");
  });

  it("detectSmallEdits:false ignores the text change but keeps large-area", () => {
    const a = fill(W, H, 20);
    const b = a.slice();
    rect(b, W, 55, 100, 10, 4, 230);
    const opts = { ...OPTS, detectSmallEdits: false };
    expect(diffFrames(a, b, opts).significant).toBe(false);
    const r = diffFrames(a, fill(W, H, 200), opts);
    expect(r.significant).toBe(true);
    expect(r.reason).toBe("large-area");
  });

  it("handles partial edge blocks using their real pixel count", () => {
    const w = 40;
    const h = 40; // 3x3 grid, last block is 10x10 = 100 px
    const a = fill(w, h, 0);
    const b = a.slice();
    rect(b, w, 30, 30, 5, 5, 255); // 25 px in the 10x10 corner block = 25%
    const r = diffFrames(a, b, { width: w, height: h });
    expect(r.totalBlocks).toBe(9);
    expect(r.changedBlocks).toBe(1);
    expect(r.reason).toBe("strong-block");
    expect(r.bbox).toEqual({ x: 30, y: 30, w: 10, h: 10 });
  });

  it("honours pixelTolerance", () => {
    const a = fill(W, H, 100);
    const b = a.slice();
    rect(b, W, 0, 0, W, H, 130); // diff of 30
    expect(diffFrames(a, b, OPTS).reason).toBe("large-area");
    expect(diffFrames(a, b, { ...OPTS, pixelTolerance: 31 }).significant).toBe(false);
    expect(diffFrames(a, b, { ...OPTS, pixelTolerance: 30 }).significant).toBe(true);
  });

  it("is fast: 100 diffs of 480x270 in a generous bound", () => {
    const a = addNoise(fill(W, H, 128), 40, 7);
    const b = addNoise(a, 60, 8);
    diffFrames(a, b, OPTS); // warm up
    const t0 = performance.now();
    for (let i = 0; i < 100; i++) diffFrames(a, b, OPTS);
    expect(performance.now() - t0).toBeLessThan(1500);
  });
});

describe("minLocalChangedPercent (cursor filter)", () => {
  const a = fill(W, H, 255);
  const MIN_PX = Math.ceil((0.03 / 100) * W * H); // 39 px at 480x270
  const paint = (rects: [number, number, number, number][]): Uint8Array => {
    const b = a.slice();
    for (const [x, y, w, h] of rects) rect(b, W, x, y, w, h, 0);
    return b;
  };

  it("ignores a cursor moving far (aligned, one block per position)", () => {
    // three 12 px blobs, one block each: old rule 'scattered'
    const b = paint([[16, 16, 4, 3], [200, 100, 4, 3], [400, 200, 4, 3]]);
    const r = diffFrames(a, b, OPTS);
    expect(r.changedBlocks).toBe(3);
    expect(r.significant).toBe(false);
    expect(diffFrames(a, b, { ...OPTS, minLocalChangedPercent: 0 }).reason).toBe("scattered");
  });

  it("ignores a cursor moving far (positions straddling block boundaries)", () => {
    // 10x2 straddling x=60 (10 px in each of two blocks) + 4x4 elsewhere = 36 px
    const b = paint([[55, 58, 10, 2], [300, 150, 4, 4]]);
    const r = diffFrames(a, b, OPTS);
    expect(r.changedPixels).toBe(36);
    expect(r.largestCluster).toBe(2);
    expect(r.significant).toBe(false);
    const old = diffFrames(a, b, { ...OPTS, minLocalChangedPercent: 0 });
    expect(old.significant).toBe(true);
    expect(old.reason).toBe("local-cluster");
  });

  it("ignores a 3x-scaled cursor with anti-aliasing noise", () => {
    const b = paint([[57, 57, 6, 3], [300, 150, 5, 3]]); // ~33 px, straddling
    // anti-aliasing fringe, below pixelTolerance
    rect(b, W, 56, 56, 8, 1, 235);
    rect(b, W, 299, 149, 7, 1, 240);
    const r = diffFrames(a, b, OPTS);
    expect(r.changedPixels).toBeLessThan(MIN_PX);
    expect(r.significant).toBe(false);
  });

  it("still detects a 6-character text edit", () => {
    const b = paint([[52, 100, 16, 4]]); // 64 px = 0.049%, straddles x=60
    const r = diffFrames(a, b, OPTS);
    expect(r.changedPercent).toBeGreaterThan(0.03);
    expect(r.reason).toBe("local-cluster");
  });

  it("detects a text edit that appears together with a cursor", () => {
    const b = paint([[52, 100, 16, 4], [300, 150, 3, 5], [10, 10, 3, 5]]);
    const r = diffFrames(a, b, OPTS);
    expect(r.significant).toBe(true);
    expect(r.reason).toBe("local-cluster");
  });

  it("the smallest passing edit is the minimum percent (39 px at 480x270)", () => {
    const pass = diffFrames(a, paint([[54, 100, 13, 3]]), OPTS); // 39 px
    expect(pass.changedPixels).toBe(39);
    expect(pass.significant).toBe(true);
    const fail = diffFrames(a, paint([[51, 100, 19, 2]]), OPTS); // 38 px
    expect(fail.changedPixels).toBe(38);
    expect(fail.significant).toBe(false);
  });

  it("applies to strong-block and honours an override", () => {
    const b = paint([[31, 31, 6, 6]]); // 36 px in one block: 16% , below strong anyway
    const c = paint([[31, 31, 7, 7]]); // 49 px = 0.038%, 21.8% of block
    expect(diffFrames(a, c, OPTS).significant).toBe(false); // below strong 25%
    const d = paint([[31, 31, 8, 7]]); // 56 px = 24.9%
    expect(diffFrames(a, d, { ...OPTS, strongBlockFraction: 0.2 }).reason).toBe("strong-block");
    expect(diffFrames(a, b, { ...OPTS, strongBlockFraction: 0.1 }).significant).toBe(false); // 36 px < 39
    expect(diffFrames(a, b, { ...OPTS, strongBlockFraction: 0.1, minLocalChangedPercent: 0 }).reason).toBe(
      "strong-block",
    );
  });

  it("does not affect the large-area rule", () => {
    const b = a.slice();
    rect(b, W, 0, 0, 200, 40, 0);
    const r = diffFrames(a, b, { ...OPTS, minLocalChangedPercent: 50 });
    expect(r.reason).toBe("large-area");
  });
});

describe("ChangeDetector", () => {
  const base = fill(W, H, 20);
  const edited = (): Uint8Array => {
    const b = base.slice();
    rect(b, W, 55, 100, 10, 4, 230);
    return b;
  };
  const frame = (l: Uint8Array): Uint8ClampedArray => toRgba(l);
  const make = (extra: Partial<ConstructorParameters<typeof ChangeDetector>[0]> = {}): ChangeDetector =>
    new ChangeDetector({ width: W, height: H, settleMs: 500, maxSettleMs: 3000, cooldownMs: 1000, ...extra });

  it("captures the first sample as initial and is idle on identical samples", () => {
    const d = make();
    const first = d.sample(frame(base), 0);
    expect(first).toEqual({ action: "capture", reason: "initial", diff: null });
    const second = d.sample(frame(base), 200);
    expect(second.action).toBe("idle");
    expect(second.reason).toBeNull();
    expect(second.diff?.significant).toBe(false);
  });

  it("waits during motion then captures after settleMs of stability", () => {
    const d = make({ cooldownMs: 0 });
    d.sample(frame(base), 0);
    // moving: a different region each sample
    const m1 = base.slice();
    rect(m1, W, 100, 100, 60, 30, 230);
    const m2 = base.slice();
    rect(m2, W, 200, 100, 60, 30, 230);
    expect(d.sample(frame(m1), 1000).action).toBe("waiting");
    expect(d.sample(frame(m2), 1200).action).toBe("waiting");
    // stable from 1400
    expect(d.sample(frame(m2), 1400).action).toBe("waiting");
    expect(d.sample(frame(m2), 1800).action).toBe("waiting"); // 400 ms stable
    const cap = d.sample(frame(m2), 1900);
    expect(cap.action).toBe("capture");
    expect(cap.reason).toBe("change");
    expect(cap.diff?.significant).toBe(true);
    // new baseline: same frame is now idle
    expect(d.sample(frame(m2), 2000).action).toBe("idle");
  });

  it("maxSettleMs forces a capture during continuous motion", () => {
    const d = make({ cooldownMs: 0, maxSettleMs: 3000 });
    d.sample(frame(base), 0);
    let t = 1000;
    let captured = -1;
    for (let i = 0; i < 40 && captured < 0; i++, t += 250) {
      const f = base.slice();
      rect(f, W, 20 + (i % 2) * 200, 100, 60, 30, 230); // flips every sample
      const r = d.sample(frame(f), t);
      if (r.action === "capture") captured = t;
      else expect(r.action).toBe("waiting");
    }
    expect(captured).toBe(1000 + 3000);
  });

  it("respects the cooldown", () => {
    const d = make({ cooldownMs: 5000 });
    d.sample(frame(base), 0);
    const e = edited();
    expect(d.sample(frame(e), 1000).action).toBe("waiting");
    expect(d.sample(frame(e), 1600).action).toBe("waiting"); // settled but cooling down
    expect(d.sample(frame(e), 4900).action).toBe("waiting");
    const cap = d.sample(frame(e), 5000);
    expect(cap.action).toBe("capture");
    expect(cap.reason).toBe("change");
  });

  it("returns to idle when the change is reverted", () => {
    const d = make({ cooldownMs: 0 });
    d.sample(frame(base), 0);
    expect(d.sample(frame(edited()), 1000).action).toBe("waiting");
    expect(d.sample(frame(base), 1200).action).toBe("idle");
    // pending state cleared: a fresh change needs the full settle time again
    expect(d.sample(frame(edited()), 1300).action).toBe("waiting");
    expect(d.sample(frame(edited()), 1700).action).toBe("waiting");
    expect(d.sample(frame(edited()), 2100).action).toBe("waiting"); // stable since 1700
    expect(d.sample(frame(edited()), 2200).action).toBe("capture");
  });

  it("reset makes the next sample an initial capture", () => {
    const d = make();
    d.sample(frame(base), 0);
    d.reset();
    const r = d.sample(frame(base), 10);
    expect(r).toEqual({ action: "capture", reason: "initial", diff: null });
  });

  it("setOptions changes behaviour without losing state", () => {
    const d = make({ cooldownMs: 0 });
    d.sample(frame(base), 0);
    const e = edited();
    expect(d.sample(frame(e), 1000).action).toBe("waiting");
    expect(d.sample(frame(e), 1300).action).toBe("waiting");
    // stable since 1300; with the default 500 ms it would still wait at 1550
    d.setOptions({ settleMs: 200 });
    expect(d.sample(frame(e), 1550).action).toBe("capture");

    // state kept: baseline is the edited frame, so it is idle, not initial
    expect(d.sample(frame(e), 1500).action).toBe("idle");
    // turn small edits off: same edit is now ignored
    d.setOptions({ detectSmallEdits: false });
    expect(d.sample(frame(base), 1600).action).toBe("idle");
  });

  it("keeps a copy of the baseline (caller buffer is reused)", () => {
    const d = make({ cooldownMs: 0 });
    const buf = frame(base);
    d.sample(buf, 0);
    // mutate the same buffer into the edited frame, as a reused canvas buffer would be
    buf.set(frame(edited()));
    expect(d.sample(buf, 1000).action).toBe("waiting");
    buf.set(frame(base));
    expect(d.sample(buf, 1100).action).toBe("idle");
  });
});
