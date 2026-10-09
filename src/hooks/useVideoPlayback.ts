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
    const [fallbackMediaId, setFallbackMediaId] = useState<string>();
    // canPlayType is only a hint: MP4/WebM may contain an unsupported codec.
    // Try the original file in WebView first, then use VLC without transcoding.
    const browserSupported = !options.mimeType || document.createElement("video").canPlayType(options.mimeType) !== "";
    const native = nativeAvailable && (!browserSupported || fallbackMediaId === mediaId);
    const [generation, setGeneration] = useState(0);
    const [status, setStatus] = useState({ phase: "loading", message: native ? "libVLCで動画を読み込み中…" : "動画を読み込み中…" });
    const initial = useRef(options);
    initial.current = options;
    useLayoutEffect(() => {
        if (!native || !canvasRef.current)
            return;
        let player: VlcVideoHandle;
        try {
            player = new VlcVideoHandle(canvasRef.current, mediaId, initial.current);
            videoRef.current = player;
        }
        catch (error) {
            setStatus({ phase: "error", message: String(error) });
            onLoadingChange(false);
            return;
        }
        return () => { void player.dispose().catch(() => undefined); if (videoRef.current === player)
            videoRef.current = null; };
    }, [native, mediaId, generation, videoRef, canvasRef, onLoadingChange]);
    useEffect(() => {
        const video = videoRef.current;
        if (!video)
            return;
        setStatus({ phase: "loading", message: native ? "libVLCで元動画を直接読み込み中…" : "元動画を直接読み込み中…" });
        let ready = false;
        const settle = () => { if (video.readyState < 2)
            return; ready = true; setStatus({ phase: "ready", message: "" }); onLoadingChange(false); };
        const fallback = () => {
            if (native || !nativeAvailable) return false;
            setFallbackMediaId(mediaId);
            setStatus({ phase: "loading", message: "libVLCで元動画を直接読み込み中…" });
            onLoadingChange(true);
            setGeneration(value => value + 1);
            return true;
        };
        const fail = () => { if (fallback()) return; setStatus({ phase: "error", message: video.error?.message || "この動画を再生できませんでした。別の動画を開くか、再試行してください。" }); onLoadingChange(false); };
        const waiting = () => { if (ready)
            setStatus({ phase: "buffering", message: "動画を読み込み中…" }); };
        const restart = () => { setStatus({ phase: "loading", message: "動画を開き直しています…" }); setGeneration(value => value + 1); };
        ["loadeddata", "canplay", "playing"].forEach(name => video.addEventListener(name, settle));
        video.addEventListener("error", fail);
        video.addEventListener("waiting", waiting);
        video.addEventListener("restart", restart);
        if (video.error)
            fail();
        else
            settle();
        const timeout = setTimeout(() => { if (!ready) {
            if (fallback()) return;
            setStatus({ phase: "error", message: "動画の読み込みが進んでいません。再試行または別の動画を開いてください。" });
            onLoadingChange(false);
        } }, native || !nativeAvailable ? 30000 : 8000);
        return () => { clearTimeout(timeout); ["loadeddata", "canplay", "playing"].forEach(name => video.removeEventListener(name, settle)); video.removeEventListener("error", fail); video.removeEventListener("waiting", waiting); video.removeEventListener("restart", restart); };
    }, [mediaId, generation, native, nativeAvailable, videoRef, onLoadingChange]);
    const retry = useCallback(() => { setStatus({ phase: "loading", message: "動画を開き直しています…" }); if (!native && videoRef.current instanceof HTMLVideoElement)
        videoRef.current.load(); setGeneration(value => value + 1); }, [native, videoRef]);
    return { ...status, native, retry, generation };
}
