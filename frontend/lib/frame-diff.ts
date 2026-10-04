/**
 * Local-change detection for screen-share snapshots.
 *
 * Pure functions on luma buffers (no DOM, no canvas). The block grid makes a
 * tiny but real edit (a few characters) significant while single cursors,
 * carets and sensor/compression noise stay below the thresholds.
 */

export type Box = { x: number; y: number; w: number; h: number };

export type FrameDiffOptions = {
  width: number;
  height: number;
  blockSize?: number;
  pixelTolerance?: number;
  blockChangedFraction?: number;
  strongBlockFraction?: number;
  minClusterBlocks?: number;
  minScatteredBlocks?: number;
  areaThresholdPercent?: number;
  /**
   * Minimum changed pixels, as a percent of ALL pixels in the buffer, before any
   * of the three LOCAL rules (local-cluster, scattered, strong-block) may fire.
   * Filters mouse-cursor movement (old + new position leave two small blobs that
   * can straddle block boundaries). Default 0.03 (about 39 px at 480x270, 69 px
   * at 640x360). 0 disables the filter. The large-area rule ignores it.
   */
  minLocalChangedPercent?: number;
  detectSmallEdits?: boolean;
};

export type FrameDiffResult = {
  changedPixels: number;
  changedPercent: number;
  changedBlocks: number;
  totalBlocks: number;
  largestCluster: number;
  clusters: { blocks: number; box: Box }[];
  reason: "none" | "large-area" | "local-cluster" | "scattered" | "strong-block";
  significant: boolean;
  bbox: Box | null;
};

const DEFAULTS = {
  blockSize: 15,
  pixelTolerance: 25,
  blockChangedFraction: 0.04,
  strongBlockFraction: 0.25,
  minClusterBlocks: 2,
  minScatteredBlocks: 3,
  areaThresholdPercent: 3,
  minLocalChangedPercent: 0.03,
  detectSmallEdits: true,
} as const;

/** BT.601 luma with integer math: (77 R + 150 G + 29 B) >> 8. Alpha is ignored. */
export function rgbaToLuma(rgba: Uint8ClampedArray | Uint8Array): Uint8Array {
  const n = rgba.length >> 2;
  const out = new Uint8Array(n);
  for (let i = 0, j = 0; i < n; i++, j += 4) {
    out[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
  }
  return out;
}

// Scratch buffers reused between calls (keyed by grid size).
let scratchCounts = new Uint32Array(0);
let scratchLabels = new Int32Array(0);
let scratchStack = new Int32Array(0);

export function diffFrames(
  prevLuma: Uint8Array,
  currLuma: Uint8Array,
  opts: FrameDiffOptions,
): FrameDiffResult {
  const { width, height } = opts;
  const blockSize = Math.max(1, Math.floor(opts.blockSize ?? DEFAULTS.blockSize));
  const tol = opts.pixelTolerance ?? DEFAULTS.pixelTolerance;
  const blockFrac = opts.blockChangedFraction ?? DEFAULTS.blockChangedFraction;
  const strongFrac = opts.strongBlockFraction ?? DEFAULTS.strongBlockFraction;
  const minCluster = opts.minClusterBlocks ?? DEFAULTS.minClusterBlocks;
  const minScattered = opts.minScatteredBlocks ?? DEFAULTS.minScatteredBlocks;
  const areaPct = opts.areaThresholdPercent ?? DEFAULTS.areaThresholdPercent;
  const minLocalPct = opts.minLocalChangedPercent ?? DEFAULTS.minLocalChangedPercent;
  const small = opts.detectSmallEdits ?? DEFAULTS.detectSmallEdits;

  const cols = Math.ceil(width / blockSize);
  const rows = Math.ceil(height / blockSize);
  const totalBlocks = cols * rows;

  if (scratchCounts.length < totalBlocks) {
    scratchCounts = new Uint32Array(totalBlocks);
    scratchLabels = new Int32Array(totalBlocks);
    scratchStack = new Int32Array(totalBlocks);
  }
  const counts = scratchCounts;
  counts.fill(0, 0, totalBlocks);

  // Single pass over pixels, counting changed pixels per block.
  let changedPixels = 0;
  for (let by = 0; by < rows; by++) {
    const y0 = by * blockSize;
    const y1 = Math.min(height, y0 + blockSize);
    for (let y = y0; y < y1; y++) {
      const rowStart = y * width;
      for (let bx = 0; bx < cols; bx++) {
        const x0 = rowStart + bx * blockSize;
        const x1 = rowStart + Math.min(width, (bx + 1) * blockSize);
        let c = 0;
        for (let i = x0; i < x1; i++) {
          const d = currLuma[i] - prevLuma[i];
          if (d >= tol || -d >= tol) c++;
        }
        if (c !== 0) {
          counts[by * cols + bx] += c;
          changedPixels += c;
        }
      }
    }
  }

  const totalPixels = width * height;
  const changedPercent = totalPixels > 0 ? (changedPixels / totalPixels) * 100 : 0;

  // Classify blocks and find 8-connected clusters (iterative flood fill).
  const labels = scratchLabels;
  const stack = scratchStack;
  // label: 0 = not changed, -1 = changed & unvisited, >0 = cluster id
  let changedBlocks = 0;
  let strongBlock = false;
  let minBx = cols;
  let minBy = rows;
  let maxBx = -1;
  let maxBy = -1;
  for (let by = 0; by < rows; by++) {
    const bh = Math.min(height, (by + 1) * blockSize) - by * blockSize;
    for (let bx = 0; bx < cols; bx++) {
      const idx = by * cols + bx;
      const bw = Math.min(width, (bx + 1) * blockSize) - bx * blockSize;
      const frac = counts[idx] / (bw * bh);
      if (counts[idx] > 0 && frac >= blockFrac) {
        labels[idx] = -1;
        changedBlocks++;
        if (frac >= strongFrac) strongBlock = true;
        if (bx < minBx) minBx = bx;
        if (bx > maxBx) maxBx = bx;
        if (by < minBy) minBy = by;
        if (by > maxBy) maxBy = by;
      } else {
        labels[idx] = 0;
      }
    }
  }

  const clusters: { blocks: number; box: Box }[] = [];
  let largestCluster = 0;
  if (changedBlocks > 0) {
    for (let start = 0; start < totalBlocks; start++) {
      if (labels[start] !== -1) continue;
      let sp = 0;
      stack[sp++] = start;
      labels[start] = clusters.length + 1;
      let blocks = 0;
      let cMinX = cols;
      let cMinY = rows;
      let cMaxX = -1;
      let cMaxY = -1;
      while (sp > 0) {
        const cur = stack[--sp];
        const cy = (cur / cols) | 0;
        const cx = cur - cy * cols;
        blocks++;
        if (cx < cMinX) cMinX = cx;
        if (cx > cMaxX) cMaxX = cx;
        if (cy < cMinY) cMinY = cy;
        if (cy > cMaxY) cMaxY = cy;
        const ny0 = cy > 0 ? cy - 1 : 0;
        const ny1 = cy < rows - 1 ? cy + 1 : rows - 1;
        const nx0 = cx > 0 ? cx - 1 : 0;
        const nx1 = cx < cols - 1 ? cx + 1 : cols - 1;
        for (let ny = ny0; ny <= ny1; ny++) {
          for (let nx = nx0; nx <= nx1; nx++) {
            const ni = ny * cols + nx;
            if (labels[ni] === -1) {
              labels[ni] = clusters.length + 1;
              stack[sp++] = ni;
            }
          }
        }
      }
      if (blocks > largestCluster) largestCluster = blocks;
      clusters.push({ blocks, box: blockRangeToBox(cMinX, cMinY, cMaxX, cMaxY, blockSize, width, height) });
    }
  }

  let reason: FrameDiffResult["reason"] = "none";
  if (changedPercent >= areaPct && changedPixels > 0) reason = "large-area";
  else if (small && changedPercent >= minLocalPct) {
    if (largestCluster >= minCluster && largestCluster > 0) reason = "local-cluster";
    else if (changedBlocks >= minScattered && changedBlocks > 0) reason = "scattered";
    else if (strongBlock) reason = "strong-block";
  }
  const significant = reason !== "none";

  let bbox: Box | null = null;
  if (significant) {
    if (changedBlocks > 0) {
      bbox = blockRangeToBox(minBx, minBy, maxBx, maxBy, blockSize, width, height);
    } else {
      bbox = { x: 0, y: 0, w: width, h: height };
    }
  }

  return {
    changedPixels,
    changedPercent,
    changedBlocks,
    totalBlocks,
    largestCluster,
    clusters,
    reason,
    significant,
    bbox,
  };
}

function blockRangeToBox(
  minBx: number,
  minBy: number,
  maxBx: number,
  maxBy: number,
  blockSize: number,
  width: number,
  height: number,
): Box {
  const x = minBx * blockSize;
  const y = minBy * blockSize;
  return {
    x,
    y,
    w: Math.min(width, (maxBx + 1) * blockSize) - x,
    h: Math.min(height, (maxBy + 1) * blockSize) - y,
  };
}

export type DetectorOptions = FrameDiffOptions & {
  settleMs?: number;
  maxSettleMs?: number;
  cooldownMs?: number;
};

export type DetectorDecision = {
  action: "baseline" | "idle" | "waiting" | "capture";
  reason: "initial" | "change" | null;
  diff: FrameDiffResult | null;
};

const DETECTOR_DEFAULTS = { settleMs: 500, maxSettleMs: 3000, cooldownMs: 1000 } as const;

export class ChangeDetector {
  private options: DetectorOptions;
  private baseline: Uint8Array | null = null;
  private previous: Uint8Array | null = null;
  private current: Uint8Array | null = null;
  private pendingSince: number | null = null;
  private stableSince: number | null = null;
  private lastCaptureAt = -Infinity;

  constructor(options: DetectorOptions) {
    this.options = { ...options };
  }

  setOptions(partial: Partial<DetectorOptions>): void {
    const next: DetectorOptions = { ...this.options };
    for (const key of Object.keys(partial) as (keyof DetectorOptions)[]) {
      const v = partial[key];
      if (v !== undefined) (next as Record<string, unknown>)[key] = v;
    }
    const sizeChanged = next.width !== this.options.width || next.height !== this.options.height;
    this.options = next;
    if (sizeChanged) this.reset();
  }

  reset(): void {
    this.baseline = null;
    this.previous = null;
    this.pendingSince = null;
    this.stableSince = null;
    this.lastCaptureAt = -Infinity;
  }

  sample(rgba: Uint8ClampedArray | Uint8Array, nowMs: number): DetectorDecision {
    const o = this.options;
    const n = o.width * o.height;
    if (!this.current || this.current.length !== n) this.current = new Uint8Array(n);
    const curr = this.current;
    const px = Math.min(n, rgba.length >> 2);
    for (let i = 0, j = 0; i < px; i++, j += 4) {
      curr[i] = (77 * rgba[j] + 150 * rgba[j + 1] + 29 * rgba[j + 2]) >> 8;
    }

    if (!this.baseline || !this.previous) {
      this.baseline = curr.slice();
      this.previous = curr.slice();
      this.lastCaptureAt = nowMs;
      this.pendingSince = null;
      this.stableSince = null;
      return { action: "capture", reason: "initial", diff: null };
    }

    const diff = diffFrames(this.baseline, curr, o);
    const motion = diffFrames(this.previous, curr, o);
    this.previous.set(curr);

    if (!diff.significant) {
      this.pendingSince = null;
      this.stableSince = null;
      return { action: "idle", reason: null, diff };
    }

    if (this.pendingSince === null) this.pendingSince = nowMs;
    if (motion.significant) {
      this.stableSince = null;
    } else if (this.stableSince === null) {
      this.stableSince = nowMs;
    }

    const settleMs = o.settleMs ?? DETECTOR_DEFAULTS.settleMs;
    const maxSettleMs = o.maxSettleMs ?? DETECTOR_DEFAULTS.maxSettleMs;
    const cooldownMs = o.cooldownMs ?? DETECTOR_DEFAULTS.cooldownMs;
    const cooledDown = nowMs - this.lastCaptureAt >= cooldownMs;
    const settled = this.stableSince !== null && nowMs - this.stableSince >= settleMs;
    const forced = nowMs - this.pendingSince >= maxSettleMs;

    if (cooledDown && (settled || forced)) {
      this.baseline.set(curr);
      this.pendingSince = null;
      this.stableSince = null;
      this.lastCaptureAt = nowMs;
      return { action: "capture", reason: "change", diff };
    }
    return { action: "waiting", reason: null, diff };
  }
}
