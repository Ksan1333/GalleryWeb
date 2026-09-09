import { invoke } from "@tauri-apps/api/core";
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
// A DOM-compatible control surface, not a fake HTML video decoder. Native VLC
// reads the original file and outputs audio; only decoded display pixels cross
// binary IPC. One request may be in flight, with no JSON/base64 or frame queue.
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
    private sequence = 0;
    private timer?: ReturnType<typeof setTimeout>;
    private animation?: number;
    private seekPendingUntil = 0;
    private volumePendingUntil = 0;
    private draw: (packet: ArrayBuffer) => void;
    private releaseDraw: () => void;
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
        const renderer = createFrameRenderer(canvas);
        this.draw = renderer.draw;
        this.releaseDraw = renderer.dispose;
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
            void this.frame();
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
        return; this.error = error instanceof Error ? error : new Error(String(error)); clearTimeout(this.timer); this.emit("error"); if (this.id) {
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
    private async frame() {
        if (this.closed || this.error || !this.id)
            return;
        try {
            if (!document.hidden) {
                const packet = await invoke<ArrayBuffer>("read_vlc_frame", { sessionId: this.id, after: this.sequence });
                if (this.closed || this.error)
                    return;
                if (packet.byteLength) {
                    const view = new DataView(packet);
                    this.draw(packet);
                    this.sequence = view.getUint32(12, true);
                    if (this.readyState < 2) {
                        this.readyState = 4;
                        this.emit("loadeddata");
                        this.emit("canplay");
                    }
                }
            }
        }
        catch (error) {
            this.fail(error);
            return;
        }
        if (!this.closed)
            this.animation = requestAnimationFrame(() => void this.frame());
    }
    dispose(): Promise<void> {
        if (this.closed)
            return this.closing ?? Promise.resolve();
        this.closed = true;
        clearTimeout(this.timer);
        if (this.animation !== undefined)
            cancelAnimationFrame(this.animation);
        this.releaseDraw();
        this.pending = [];
        this.closing ??= this.id ? invoke<void>("close_vlc_player", { sessionId: this.id }) : this.opening;
        return this.closing;
    }
}
export function createFrameRenderer(canvas: HTMLCanvasElement) {
    const gl = canvas.getContext("webgl", { alpha: false, antialias: false, preserveDrawingBuffer: true });
    if (!gl)
        throw new Error("動画描画用のWebGLを初期化できませんでした。");
    const shader = (type: number, source: string) => { const shader = gl.createShader(type); if (!shader)
        throw new Error("描画用シェーダーを作成できません。"); gl.shaderSource(shader, source); gl.compileShader(shader); if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
        throw new Error("描画用シェーダーの初期化に失敗しました。"); return shader; };
    const vertex = shader(gl.VERTEX_SHADER, "attribute vec2 position; varying vec2 uv; void main(){gl_Position=vec4(position,0.,1.);uv=vec2((position.x+1.)*.5,(1.-position.y)*.5);}");
    const fragment = shader(gl.FRAGMENT_SHADER, "precision mediump float;varying vec2 uv;uniform sampler2D pixels;uniform float crop;void main(){vec4 pixel=texture2D(pixels,vec2(uv.x*crop,uv.y));gl_FragColor=vec4(pixel.b,pixel.g,pixel.r,1.);}");
    const program = gl.createProgram()!;
    gl.attachShader(program, vertex);
    gl.attachShader(program, fragment);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS))
        throw new Error("描画プログラムを初期化できませんでした。");
    const buffer = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]), gl.STATIC_DRAW);
    gl.useProgram(program);
    const position = gl.getAttribLocation(program, "position");
    gl.enableVertexAttribArray(position);
    gl.vertexAttribPointer(position, 2, gl.FLOAT, false, 0, 0);
    const texture = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const crop = gl.getUniformLocation(program, "crop");
    let textureWidth = 0, textureHeight = 0;
    return { draw(packet: ArrayBuffer) {
            if (packet.byteLength < 24)
                throw new Error("動画フレームが不完全です。");
            const header = new DataView(packet), width = header.getUint32(0, true), height = header.getUint32(4, true), pitch = header.getUint32(8, true);
            if (!width || !height || width > 1920 || height > 1080 || pitch < width * 4 || pitch > 1920 * 4 + 32 || pitch % 4 || packet.byteLength !== 24 + pitch * height)
                throw new Error("動画フレームのサイズが不正です。");
            if (canvas.width !== width || canvas.height !== height) {
                canvas.width = width;
                canvas.height = height;
                gl.viewport(0, 0, width, height);
            }
            const pixels = new Uint8Array(packet, 24);
            gl.bindTexture(gl.TEXTURE_2D, texture);
            if (textureWidth !== pitch / 4 || textureHeight !== height) {
                gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, pitch / 4, height, 0, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
                textureWidth = pitch / 4;
                textureHeight = height;
            }
            else
                gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, pitch / 4, height, gl.RGBA, gl.UNSIGNED_BYTE, pixels);
            gl.uniform1f(crop, width / (pitch / 4));
            gl.drawArrays(gl.TRIANGLE_STRIP, 0, 4);
        }, dispose() { gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(program); gl.deleteShader(vertex); gl.deleteShader(fragment); } };
}
