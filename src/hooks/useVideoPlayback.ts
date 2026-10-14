import { useCallback, useLayoutEffect, useEffect, useRef, useState } from "react";
import { isTauriRuntime } from "../services/native";
import { VlcVideoHandle, type VideoHandle } from "../services/vlcPlayer";
export function useVideoPlayback(mediaId: string, videoRef: React.RefObject<VideoHandle | null>, canvasRef: React.RefObject<HTMLCanvasElement | null>, options: {
    volume: number;
    muted: boolean;
    loop: boolean;
    mimeType?: string;
}, onLoadingChange: (loading: boolean) => void) {
    // This release bundles Windows DLLs only; retain the existing browser/WebKit
    // decoder on other platforms rather than attempting to load Windows libVLC.
    const nativeAvailable = isTauriRuntime() && /Win/.test(navigator.platform);
    const [fallbackState, setFallbackState] = useState<{ mediaId: string; engine: "mf" | "vlc" }>();
    // canPlayType is only a hint: MP4/WebM may contain an unsupported codec.
    // Try the original file in WebView, Media Foundation, then VLC without transcoding.
    const browserSupported = !options.mimeType || document.createElement("video").canPlayType(options.mimeType) !== "";
    const backend = nativeAvailable ? (fallbackState?.mediaId === mediaId ? fallbackState.engine : !browserSupported ? "mf" : "web") : "web";
    const native = backend !== "web";
    const resume = useRef<{ mediaId: string; time: number; paused: boolean } | undefined>(undefined);
    const [generation, setGeneration] = useState(0);
    const [status, setStatus] = useState({ phase: "loading", message: native ? "libVLCで動画を読み込み中…" : "動画を読み込み中…" });
    const initial = useRef(options);
    initial.current = options;
    useLayoutEffect(() => {
        if (!native || !canvasRef.current)
            return;
        let player: VlcVideoHandle;
        try {
            player = new VlcVideoHandle(canvasRef.current, mediaId, initial.current, backend === "mf" ? "mf" : "vlc");
            videoRef.current = player;
        }
        catch (error) {
            setStatus({ phase: "error", message: String(error) });
            onLoadingChange(false);
            return;
        }
        return () => { void player.dispose().catch(() => undefined); if (videoRef.current === player)
            videoRef.current = null; };
    }, [native, backend, mediaId, generation, videoRef, canvasRef, onLoadingChange]);
    useEffect(() => {
        const video = videoRef.current;
        if (!video)
            return;
        setStatus({ phase: "loading", message: backend === "mf" ? "Windows標準エンジンで元動画を読み込み中…" : native ? "libVLCで元動画を直接読み込み中…" : "元動画を直接読み込み中…" });
        let ready = false;
        let switched = false;
        let seekTimer: ReturnType<typeof setTimeout> | undefined;
        const settle = () => { if (video.readyState < 2)
            return; ready = true;
            if (resume.current?.mediaId === mediaId) {
                const saved = resume.current; resume.current = undefined;
                video.currentTime = saved.time;
                if (saved.paused) video.pause();
            }
            setStatus({ phase: "ready", message: "" }); onLoadingChange(false); };
        const fallback = () => {
            if (backend === "vlc" || !nativeAvailable || switched) return false;
            switched = true;
            // If the intermediate engine never became ready, retain the
            // original requested position instead of replacing it with zero.
            if (resume.current?.mediaId !== mediaId) {
                resume.current = { mediaId, time: Number.isFinite(video.currentTime) ? video.currentTime : 0, paused: video.paused };
            }
            setFallbackState({ mediaId, engine: backend === "web" ? "mf" : "vlc" });
            setStatus({ phase: "loading", message: "別の動画エンジンで元動画を読み込み中…" });
            onLoadingChange(true);
            setGeneration(value => value + 1);
            return true;
        };
        const fail = () => { if (fallback()) return; setStatus({ phase: "error", message: video.error?.message || "この動画を再生できませんでした。別の動画を開くか、再試行してください。" }); onLoadingChange(false); };
        const waiting = () => { if (ready)
            setStatus({ phase: "buffering", message: "動画を読み込み中…" }); };
        const restart = () => { setStatus({ phase: "loading", message: "動画を開き直しています…" }); setGeneration(value => value + 1); };
        const seeking = () => {
            clearTimeout(seekTimer);
            seekTimer = setTimeout(() => { fallback(); }, 5000);
        };
        const seeked = () => { clearTimeout(seekTimer); };
        video.addEventListener("seeking", seeking);
        video.addEventListener("seeked", seeked);
        const requestedFallback = () => { fallback(); };
        video.addEventListener("playbackfallback", requestedFallback);
        ["loadeddata", "canplay", "playing"].forEach(name => video.addEventListener(name, settle));
        video.addEventListener("error", fail);
        video.addEventListener("waiting", waiting);
        video.addEventListener("restart", restart);
        if (video.error)
            fail();
        else
            settle();
        const timeout = setTimeout(() => { if (!ready || (backend === "web" && !(Number.isFinite(video.duration) && video.duration > 0))) {
            if (fallback()) return;
            setStatus({ phase: "error", message: "動画の読み込みが進んでいません。再試行または別の動画を開いてください。" });
            onLoadingChange(false);
        } }, native || !nativeAvailable ? 30000 : 8000);
        return () => { clearTimeout(timeout); clearTimeout(seekTimer); video.removeEventListener("playbackfallback", requestedFallback); video.removeEventListener("seeking", seeking); video.removeEventListener("seeked", seeked); ["loadeddata", "canplay", "playing"].forEach(name => video.removeEventListener(name, settle)); video.removeEventListener("error", fail); video.removeEventListener("waiting", waiting); video.removeEventListener("restart", restart); };
    }, [mediaId, generation, native, backend, nativeAvailable, videoRef, onLoadingChange]);
    const retry = useCallback(() => { setStatus({ phase: "loading", message: "動画を開き直しています…" }); if (!native && videoRef.current instanceof HTMLVideoElement)
        videoRef.current.load(); setGeneration(value => value + 1); }, [native, videoRef]);
    return { ...status, native, backend, canSwitch: nativeAvailable && backend !== "vlc", retry, generation };
}
