export const VIDEO_VOLUME_REDUCTION_GAIN = 0.5;
export const VIDEO_VOLUME_SAMPLE_SECONDS = 8;

const ANALYSIS_TIMEOUT_MS = 4_500;
const ANALYSIS_POLL_MS = 120;
const EARLY_DECISION_SECONDS = 0.8;
const LOUD_RMS_THRESHOLD = 0.22;
const PEAK_RMS_THRESHOLD = 0.12;
const PEAK_THRESHOLD = 0.98;

export type VideoVolumeAnalysis = {
  rms: number;
  peak: number;
  shouldReduce: boolean;
};

export type VideoAudioPipeline = {
  context: AudioContext;
  analyser: AnalyserNode;
  gain: GainNode;
  source: MediaElementAudioSourceNode;
};

const pipelineByVideo = new WeakMap<HTMLVideoElement, VideoAudioPipeline>();
const analysisCache = new Map<string, VideoVolumeAnalysis>();
const ANALYSIS_CACHE_MAX_ENTRIES = 512;

export function getCachedVideoVolumeAnalysis(key: string): VideoVolumeAnalysis | undefined {
  return analysisCache.get(key);
}

export function cacheVideoVolumeAnalysis(key: string, analysis: VideoVolumeAnalysis): void {
  analysisCache.delete(key);
  analysisCache.set(key, analysis);
  while (analysisCache.size > ANALYSIS_CACHE_MAX_ENTRIES) {
    const oldest = analysisCache.keys().next().value as string | undefined;
    if (oldest === undefined) return;
    analysisCache.delete(oldest);
  }
}

/**
 * The fixed thresholds intentionally match the Android viewer's loud-track
 * policy. RMS is the average level; the peak clause catches near-clipped tracks
 * whose average is just below the main threshold.
 */
export function shouldReduceVideoVolume(rms: number, peak: number): boolean {
  return rms >= LOUD_RMS_THRESHOLD
    || (peak >= PEAK_THRESHOLD && rms >= PEAK_RMS_THRESHOLD);
}

/**
 * Route one video element through a Web Audio analyser and app gain node.
 * MediaElementSourceNode may only be created once for an element, so the
 * pipeline is kept for the lifetime of that element and reused when the
 * viewer advances to another video.
 */
export function createVideoAudioPipeline(video: HTMLVideoElement): VideoAudioPipeline | undefined {
  const existing = pipelineByVideo.get(video);
  if (existing) return existing;
  if (typeof window === "undefined" || typeof window.AudioContext !== "function") return undefined;

  try {
    const context = new window.AudioContext();
    const source = context.createMediaElementSource(video);
    const analyser = context.createAnalyser();
    const gain = context.createGain();
    analyser.fftSize = 2_048;
    analyser.smoothingTimeConstant = 0;
    gain.gain.value = 1;
    source.connect(analyser);
    analyser.connect(gain);
    gain.connect(context.destination);
    const pipeline = { context, source, analyser, gain };
    pipelineByVideo.set(video, pipeline);
    return pipeline;
  } catch {
    // A restricted WebView or an unsupported media source must not prevent
    // normal HTML video playback.
    return undefined;
  }
}

export function disposeVideoAudioPipeline(video: HTMLVideoElement): void {
  const pipeline = pipelineByVideo.get(video);
  if (!pipeline) return;
  pipelineByVideo.delete(video);
  try { pipeline.source.disconnect(); } catch { /* already disconnected */ }
  try { pipeline.analyser.disconnect(); } catch { /* already disconnected */ }
  try { pipeline.gain.disconnect(); } catch { /* already disconnected */ }
  void pipeline.context.close().catch(() => undefined);
}

/**
 * Sample the currently playing video's first few seconds. The promise always
 * settles within a bounded time; an unavailable/paused/unsupported track is
 * represented by undefined and leaves the user's volume untouched.
 */
export function analyzeVideoVolume(
  video: HTMLVideoElement,
  pipeline: VideoAudioPipeline,
): Promise<VideoVolumeAnalysis | undefined> {
  const { analyser } = pipeline;
  const samples = new Float32Array(analyser.fftSize);
  const startedAt = video.currentTime;
  const wallDeadline = performance.now() + ANALYSIS_TIMEOUT_MS;
  let timer: number | undefined;
  let sumSquares = 0;
  let sampleCount = 0;
  let peak = 0;
  let settled = false;

  return new Promise((resolve) => {
    const finish = (result: VideoVolumeAnalysis | undefined) => {
      if (settled) return;
      settled = true;
      if (timer !== undefined) window.clearTimeout(timer);
      resolve(result);
    };

    const tick = () => {
      if (settled) return;
      const now = performance.now();
      const playbackTime = video.currentTime;
      const elapsed = Math.max(0, playbackTime - startedAt);
      if (!video.paused && !video.ended && video.readyState >= HTMLMediaElement.HAVE_CURRENT_DATA) {
        analyser.getFloatTimeDomainData(samples);
        let frameSquares = 0;
        let framePeak = 0;
        for (const rawValue of samples) {
          const value = Math.max(-1, Math.min(1, rawValue));
          const absolute = Math.abs(value);
          frameSquares += value * value;
          framePeak = Math.max(framePeak, absolute);
        }
        sumSquares += frameSquares;
        sampleCount += samples.length;
        peak = Math.max(peak, framePeak);
      }

      const rms = sampleCount > 0 ? Math.sqrt(sumSquares / sampleCount) : 0;
      const hasEarlyDecision = sampleCount > 0
        && elapsed >= EARLY_DECISION_SECONDS
        && shouldReduceVideoVolume(rms, peak);
      const reachedSampleWindow = elapsed >= VIDEO_VOLUME_SAMPLE_SECONDS;
      const reachedEnd = video.ended || (Number.isFinite(video.duration) && video.duration > 0 && playbackTime >= video.duration);
      if (hasEarlyDecision || reachedSampleWindow || reachedEnd || now >= wallDeadline) {
        finish(sampleCount > 0 ? { rms, peak, shouldReduce: shouldReduceVideoVolume(rms, peak) } : undefined);
        return;
      }

      // If playback is paused, do not count a stale analyser frame as new
      // audio. Keep polling so a user-initiated resume can still be analysed.
      timer = window.setTimeout(tick, ANALYSIS_POLL_MS);
    };

    tick();
  });
}
