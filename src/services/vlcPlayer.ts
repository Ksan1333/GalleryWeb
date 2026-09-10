import { invoke } from "@tauri-apps/api/core";
import { NativeVideoSurface } from "./nativeVideoSurface";
type Status = {
    state: string;
    message: string;
    time: number;
    duration: number;
    width: number;
    height: number;
    volume: number;
    muted: boolean;
    autoReduced: boolean;
};
export type VideoHandle = HTMLVideoElement | VlcVideoHandle;
type Options = {
    volume: number;
    muted: boolean;
    loop: boolean;
};
// DOM-compatible controls around native Direct3D playback. Only status,
// geometry, input and explicit snapshots cross IPC; never continuous pixels.
export class VlcVideoHandle extends EventTarget {
    readonly native = true;
    readyState = 0;
    duration = 0;
    videoWidth = 0;
    videoHeight = 0;
    paused = false;
    ended = false;
    error: Error | null = null;
    autoReduced = false;
    private time = 0;
    private level: number;
    private silent: boolean;
    private looping: boolean;
    private id?: string;
    private closed = false;
    private timer?: ReturnType<typeof setTimeout>;
    private seekPendingUntil = 0;
    private volumePendingUntil = 0;
    private surface?: NativeVideoSurface;
    private pending: Record<string, unknown>[] = [];
    private opening: Promise<void>;
    private closing?: Promise<void>;
    private restoredVolume: number;
    constructor(readonly canvas: HTMLCanvasElement, mediaId: string, options: Options) {
        super();
        this.level = options.volume;
        this.restoredVolume = options.volume;
        this.silent = options.muted;
        this.looping = options.loop;
        // A single video session is owned by this handle. A delayed open response
        // must be closed even if React has already navigated to another item.
        this.opening = invoke<string>("open_vlc_player", { mediaId, volume: this.level, muted: this.silent, looped: this.looping }).then(async (id) => {
            if (this.closed) {
                await invoke("close_vlc_player", { sessionId: id });
                return;
            }
            this.id = id;
            for (const control of this.pending)
                this.control(control);
            this.pending = [];
            void this.poll();
            this.surface = new NativeVideoSurface(canvas, id, error => this.fail(error));
        }).catch(error => { if (this.closed)
            throw error; this.fail(error); });
    }
    get currentTime() { return this.time; }
    restoreVolumePreference(value: number) {
        if (!Number.isFinite(value) || value === this.restoredVolume) return;
        this.restoredVolume = value;
        // A late saved-preference read is not a user turning up the volume.
        // Native normalization stays in effect; explicit volume controls use
        // the normal setter and always take precedence over this restoration.
        this.control({ type: "initialVolume", volume: value });
    }
    set currentTime(time: number) { if (!Number.isFinite(time))
        return; this.time = Math.max(0, this.duration > 0 ? Math.min(time, this.duration) : time); this.seekPendingUntil = performance.now() + 400; this.control({ type: "seek", time: this.time }); this.emit("timeupdate"); }
    get volume() { return this.level; }
    set volume(value: number) { const next = Math.max(0, Math.min(1, value)); if (!Number.isFinite(next) || next === this.level)
        return; this.level = next; this.volumePendingUntil = performance.now() + 400; this.control({ type: "volume", volume: next, muted: this.silent }); this.emit("volumechange"); }
    get muted() { return this.silent; }
    set muted(value: boolean) { if (this.silent === value)
        return; this.silent = value; this.volumePendingUntil = performance.now() + 400; this.control({ type: "volume", volume: this.level, muted: value }); this.emit("volumechange"); }
    get loop() { return this.looping; }
    set loop(value: boolean) { if (this.looping === value)
        return; this.looping = value; this.control({ type: "loop", enabled: value }); }
    async play() { if (this.closed)
        throw new Error("再生セッションは終了しています。"); if (this.error)
        throw this.error; this.paused = false; this.ended = false; this.control({ type: "play" }); this.emit("play"); }
    pause() { this.paused = true; this.control({ type: "pause" }); this.emit("pause"); }
    private emit(name: string) { if (!this.closed)
        this.dispatchEvent(new Event(name)); }
    private control(control: Record<string, unknown>) {
        if (this.closed)
            return;
        if (!this.id) {
            this.pending = this.pending.filter(c => c.type !== control.type);
            this.pending.push(control);
            return;
        }
        void invoke("control_vlc_player", { sessionId: this.id, control }).catch(error => this.fail(error));
    }
    private fail(error: unknown) { if (this.closed || this.error)
        return; this.surface?.dispose(); this.error = error instanceof Error ? error : new Error(String(error)); clearTimeout(this.timer); this.emit("error"); if (this.id) {
        this.closing = invoke<void>("close_vlc_player", { sessionId: this.id });
        void this.closing.catch(() => undefined);
        this.id = undefined;
    } }
    private async poll() {
        if (this.closed || this.error || !this.id)
            return;
        try {
            const status = await invoke<Status>("read_vlc_status", { sessionId: this.id });
            if (this.closed || this.error)
                return;
            if (status.state === "error") {
                this.fail(status.message);
                return;
            }
            const oldDuration = this.duration, oldWidth = this.videoWidth, wasPaused = this.paused, wasEnded = this.ended;
            this.duration = status.duration;
            this.videoWidth = status.width;
            this.videoHeight = status.height;
            if (this.readyState < 2 && status.width > 0 && status.height > 0 && ["playing", "paused"].includes(status.state)) {
                this.readyState = 4;
                this.emit("loadeddata");
                this.emit("canplay");
            }
            if (performance.now() >= this.seekPendingUntil)
                this.time = status.time;
            if (oldDuration !== this.duration || oldWidth !== this.videoWidth) {
                this.emit("loadedmetadata");
                this.emit("durationchange");
            }
            if (performance.now() >= this.volumePendingUntil && (this.level !== status.volume || this.silent !== status.muted)) {
                this.level = status.volume;
                this.silent = status.muted;
                this.emit("volumechange");
            }
            if (this.autoReduced !== status.autoReduced) {
                this.autoReduced = status.autoReduced;
                this.emit("volumeanalysis");
            }
            this.paused = status.state === "paused" || status.state === "ended";
            this.ended = status.state === "ended";
            if (status.state === "playing" && (wasPaused || this.readyState >= 2))
                this.emit("playing");
            if (this.paused && !wasPaused)
                this.emit("pause");
            if (this.ended && !wasEnded)
                this.emit("ended");
            if (status.state === "buffering")
                this.emit("waiting");
            this.emit("timeupdate");
            this.timer = setTimeout(() => void this.poll(), 150);
        }
        catch (error) {
            this.fail(error);
        }
    }
    async capture(width = 0): Promise<string> {
        if (this.closed || this.error || !this.id || this.readyState < 2) throw new Error("動画をまだ読み込んでいます。");
        const packet = await invoke<ArrayBuffer>("capture_vlc_frame", { sessionId: this.id, width });
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => resolve(String(reader.result));
            reader.onerror = () => reject(reader.error);
            reader.readAsDataURL(new Blob([packet], { type: "image/png" }));
        });
    }
    async confirm(message: string): Promise<boolean> {
        return this.surface ? this.surface.withHidden(() => window.confirm(message)) : window.confirm(message);
    }
    dispose(): Promise<void> {
        if (this.closed)
            return this.closing ?? Promise.resolve();
        this.closed = true;
        clearTimeout(this.timer);
        this.surface?.dispose();
        this.pending = [];
        this.closing ??= this.id ? invoke<void>("close_vlc_player", { sessionId: this.id }) : this.opening;
        return this.closing;
    }
}
