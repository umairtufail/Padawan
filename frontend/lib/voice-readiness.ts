export const MIC_SAMPLE_MS = 3_000;
export const MIN_USABLE_MIC_RMS = 0.012;

export type MicQuality = "good" | "quiet";

export function classifyMicPeak(peakRms: number): MicQuality {
  return peakRms >= MIN_USABLE_MIC_RMS ? "good" : "quiet";
}

const MIC_CONSTRAINTS: MediaTrackConstraints = {
  echoCancellation: true,
  noiseSuppression: true,
  autoGainControl: true,
  channelCount: { ideal: 1 },
};

/** Measures the loudest short microphone window without recording or uploading audio. */
export async function measureMicrophone(onLevel: (level: number) => void): Promise<number> {
  if (!navigator.mediaDevices?.getUserMedia) throw new Error("Microphone testing is not supported in this browser.");

  const stream = await navigator.mediaDevices.getUserMedia({ audio: MIC_CONSTRAINTS });
  const context = new AudioContext();
  const analyser = context.createAnalyser();
  analyser.fftSize = 1024;
  const samples = new Float32Array(analyser.fftSize);
  const source = context.createMediaStreamSource(stream);
  source.connect(analyser);
  let peak = 0;
  const started = performance.now();

  try {
    await context.resume();
    while (performance.now() - started < MIC_SAMPLE_MS) {
      analyser.getFloatTimeDomainData(samples);
      let squareSum = 0;
      for (const sample of samples) squareSum += sample * sample;
      const rms = Math.sqrt(squareSum / samples.length);
      peak = Math.max(peak, rms);
      onLevel(Math.min(1, rms / 0.15));
      await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
    }
    return peak;
  } finally {
    source.disconnect();
    stream.getTracks().forEach((track) => track.stop());
    await context.close();
  }
}
