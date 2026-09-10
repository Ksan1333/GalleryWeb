import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";

type Rect = { x: number; y: number; width: number; height: number };
type Layout = { rect: Rect; holes: Rect[]; visible: boolean };
type Input = { kind: string; x: number; y: number; delta: number; buttons: number };
const overlays = ".pv-video-controls,.pv-video-status,.pv-video-wheel-feedback,.pv-video-seek-preview,.pv-viewer-menu-restore,.pv-viewer-toast,.pv-media-info-panel,[role=menu],[data-native-video-occluder]";
const rendered = (element: Element) => {
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && Number(style.opacity) > 0.01;
};
export function surfaceLayout(element: HTMLElement): Layout {
    const dpr = window.devicePixelRatio || 1;
    const bounds = element.getBoundingClientRect();
    const rect = { x: Math.round(bounds.x * dpr), y: Math.round(bounds.y * dpr), width: Math.round(bounds.width * dpr), height: Math.round(bounds.height * dpr) };
    const blocked = [...document.querySelectorAll('[role="dialog"][aria-modal="true"]')].some(dialog => !dialog.contains(element) && rendered(dialog));
    const visible = element.isConnected && !document.hidden && !blocked && !element.closest('[inert]') && rendered(element) && bounds.width > 0 && bounds.height > 0;
    const holes = [...document.querySelectorAll(overlays)].filter(node => !node.contains(element) && rendered(node)).map(node => node.getBoundingClientRect()).filter(other => other.right > bounds.left && other.left < bounds.right && other.bottom > bounds.top && other.top < bounds.bottom).map(other => ({
        x: Math.floor((other.left - bounds.left) * dpr), y: Math.floor((other.top - bounds.top) * dpr),
        width: Math.ceil(other.width * dpr) + 2, height: Math.ceil(other.height * dpr) + 2,
    }));
    // More than the bounded native region budget means hide rather than covering UI.
    return { rect, holes: holes.slice(0, 64), visible: Boolean(visible && holes.length <= 64) };
}

/** Geometry/input only. No pixels or per-video-frame IPC. */
export class NativeVideoSurface {
    private stopped = false;
    private frame?: number;
    private timer: ReturnType<typeof setInterval>;
    private resize: ResizeObserver;
    private mutations: MutationObserver;
    private unlisten?: UnlistenFn;
    private last = "";
    private lastSent = 0;
    private sending = false;
    private suspended = false;
    constructor(private element: HTMLElement, private sessionId: string, private onError: (error: unknown) => void) {
        this.resize = new ResizeObserver(this.schedule);
        this.resize.observe(element);
        this.mutations = new MutationObserver(this.schedule);
        this.mutations.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ["class", "style", "hidden", "inert", "aria-modal"] });
        window.addEventListener("resize", this.schedule);
        document.addEventListener("scroll", this.schedule, true);
        document.addEventListener("visibilitychange", this.visibility);
        this.timer = setInterval(this.schedule, 500);
        void listen<Input>(`pixvault://vlc-input/${sessionId}`, event => this.input(event.payload)).then(stop => {
            if (this.stopped) stop(); else this.unlisten = stop;
        }).catch(onError);
        this.schedule();
    }
    private input(input: Input) {
        if (this.stopped) return;
        const dpr = window.devicePixelRatio || 1;
        const target = this.element.closest<HTMLElement>(".pv-video-surface") ?? this.element;
        const common = { bubbles: true, cancelable: true, clientX: input.x / dpr, clientY: input.y / dpr, buttons: input.buttons };
        if (input.kind === "wheel") target.dispatchEvent(new WheelEvent("wheel", { ...common, deltaY: input.delta }));
        else {
            if (input.kind === "pointerdown") target.focus({ preventScroll: true });
            target.dispatchEvent(new PointerEvent(input.kind, { ...common, pointerId: 77, pointerType: "mouse", isPrimary: true, button: input.kind === "pointermove" ? -1 : 0 }));
        }
        this.schedule();
    }
    private schedule = () => {
        if (this.stopped || this.frame !== undefined) return;
        this.frame = requestAnimationFrame(() => { this.frame = undefined; void this.sync(); });
    };
    private visibility = () => { void this.sync(); };
    async withHidden<T>(action: () => T): Promise<T> {
        this.suspended = true;
        try {
            // Drain any earlier geometry before sending the hide, so it cannot
            // race a synchronous browser confirmation dialog.
            while (this.sending) await new Promise(resolve => setTimeout(resolve, 10));
            await invoke("set_vlc_surface", { sessionId: this.sessionId, layout: { ...surfaceLayout(this.element), visible: false } });
            return action();
        } finally { this.suspended = false; this.last = ""; this.schedule(); }
    }
    private async sync() {
        if (this.stopped || this.sending || this.suspended) return;
        const layout = surfaceLayout(this.element), key = JSON.stringify(layout);
        if (key === this.last && performance.now() - this.lastSent < 1000) return;
        this.sending = true;
        try {
            await invoke("set_vlc_surface", { sessionId: this.sessionId, layout });
            this.last = key;
            this.lastSent = performance.now();
        } catch (error) { if (!this.stopped) this.onError(error); }
        finally { this.sending = false; if (!this.stopped && JSON.stringify(surfaceLayout(this.element)) !== this.last) this.schedule(); }
    }
    dispose() {
        this.stopped = true;
        if (this.frame !== undefined) cancelAnimationFrame(this.frame);
        clearInterval(this.timer);
        this.resize.disconnect(); this.mutations.disconnect(); this.unlisten?.();
        window.removeEventListener("resize", this.schedule);
        document.removeEventListener("scroll", this.schedule, true);
        document.removeEventListener("visibilitychange", this.visibility);
        // close_vlc_player owns hiding and destruction, including late opens.
    }
}
