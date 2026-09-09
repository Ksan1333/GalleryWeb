import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { isTauriRuntime, localAssetUrl } from "../services/native";

type JobStatus = { state: string; message: string; progress?: number; path?: string };
type Playback = { source?: string; phase: "loading" | "ready" | "buffering" | "preparing" | "error"; message: string };
const STARTUP_TIMEOUT_MS = 15_000;

// Each keyed VideoViewer owns one hook/session. A source fallback reuses that
// session's video element (and its Web Audio pipeline); navigation cancels it.
export function useVideoPlaybackSource(
  mediaId: string,
  originalSource: string | undefined,
  videoRef: React.RefObject<HTMLVideoElement | null>,
  onLoadingChange: (value: boolean) => void,
) {
  const [playback, setPlayback] = useState<Playback>({ source: originalSource, phase: "loading", message: "動画を読み込み中…" });
  const [attempt, setAttempt] = useState(0);
  const attemptRef = useRef(0);
  const mounted = useRef(true);
  const resumeAt = useRef(0);
  const shouldResume = useRef(true);
  const fallback = useCallback(() => {
    if (attemptRef.current >= 2) {
      setPlayback(current => ({ ...current, phase: "error", message: "この動画を再生できませんでした。再試行できます。" }));
      onLoadingChange(false);
      return;
    }
    const video = videoRef.current;
    if (video && Number.isFinite(video.currentTime) && video.currentTime > 0) {
      resumeAt.current = video.currentTime;
      shouldResume.current = !video.paused;
    }
    attemptRef.current += 1;
    setAttempt(current => current + 1);
    setPlayback(current => ({ ...current, phase: "preparing", message: "互換再生を準備中…" }));
    // Release first-paint-only work too: a failed video must not trap Explorer
    // hydration, the rail, or the user's ability to navigate away.
    onLoadingChange(false);
  }, [onLoadingChange, videoRef]);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);

  useEffect(() => {
    if (!attempt) return;
    let active = true;
    let jobId: string | undefined;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const cancel = (id: string) => void invoke("cancel_video_playback", { jobId: id }).catch(() => undefined);
    const fail = (error: unknown) => {
      if (active) setPlayback(current => ({ ...current, phase: "error", message: String(error) }));
    };
    if (!isTauriRuntime()) {
      fail("互換再生はPCインストール版で利用できます。");
      return;
    }
    void invoke<string>("start_video_playback", { mediaId, transcode: attemptRef.current > 1 }).then(async id => {
      jobId = id;
      if (!active) { cancel(id); return; }
      const poll = async () => {
        try {
          const status = await invoke<JobStatus>("get_video_playback_status", { jobId: id });
          if (!active) return;
          if (status.state === "ready") {
            const source = localAssetUrl(status.path);
            if (!source) throw new Error("再生用の動画を開けませんでした。");
            setPlayback({ source, phase: "loading", message: "互換形式で再生を開始中…" });
          } else if (status.state === "error") {
            fail(status.message);
          } else {
            setPlayback(current => ({ ...current, phase: "preparing", message: `${status.message}${status.progress == null ? "" : ` ${status.progress}%`}` }));
            timer = setTimeout(poll, 500);
          }
        } catch (error) { fail(error); }
      };
      await poll();
    }).catch(fail);
    return () => { active = false; clearTimeout(timer); if (jobId) cancel(jobId); };
  }, [attempt, mediaId]);

  useEffect(() => {
    const video = videoRef.current;
    if (!video || !playback.source || playback.phase === "preparing") return;
    let ready = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (!mounted.current || video.readyState < 2) return;
      const firstFrame = !ready;
      ready = true;
      clearTimeout(timer);
      setPlayback(current => current.phase === "ready" ? current : ({ ...current, phase: "ready", message: "" }));
      if (firstFrame) onLoadingChange(false);
    };
    const metadata = () => {
      if (resumeAt.current > 0) {
        video.currentTime = Math.min(resumeAt.current, Number.isFinite(video.duration) ? video.duration : resumeAt.current);
        resumeAt.current = 0;
      }
      if (!shouldResume.current) video.pause();
    };
    const waiting = () => {
      if (ready) setPlayback(current => ({ ...current, phase: "buffering", message: "動画を読み込み中…" }));
    };
    const failed = () => { clearTimeout(timer); fallback(); };
    const events = ["loadeddata", "canplay", "playing", "timeupdate"];
    events.forEach(name => video.addEventListener(name, settle));
    video.addEventListener("loadedmetadata", metadata);
    video.addEventListener("waiting", waiting);
    video.addEventListener("error", failed);
    if (video.error) failed();
    else {
      settle();
      if (!ready) timer = setTimeout(() => { settle(); if (!ready) failed(); }, STARTUP_TIMEOUT_MS);
    }
    return () => {
      clearTimeout(timer);
      events.forEach(name => video.removeEventListener(name, settle));
      video.removeEventListener("loadedmetadata", metadata);
      video.removeEventListener("waiting", waiting);
      video.removeEventListener("error", failed);
    };
    // Phase updates (including buffering) must not re-arm the startup timeout.
  }, [playback.source, attempt, fallback, onLoadingChange, videoRef]);

  const retry = () => { attemptRef.current = 0; fallback(); };
  return { ...playback, autoPlay: shouldResume.current, retry, useCompatibility: fallback };
}
