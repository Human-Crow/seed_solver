// World map: terrain, deposits and power plants on a canvas, with drag / pinch / wheel zoom.

import type { World } from "./world_api.js";
import type { Plant } from "./solver/solve.js";

export const TERRAIN_COLORS: Record<number, string> = {
    1: "#5678b8", 2: "#6ba577", 3: "#d7c0a3", 4: "#2f6e57", 5: "#37804d", 6: "#3e9158",
};

// Deposit colours as in the game's item icons.
export const DEPOSIT_STYLE: Record<number, { name: string; color: string }> = {
    11: { name: "Wood", color: "#21885D" },
    12: { name: "Stone", color: "#92A1A8" },
    13: { name: "Iron", color: "#4891D7" },
    14: { name: "Copper", color: "#EE651B" },
    15: { name: "Coal", color: "#2C212D" },
    16: { name: "Wolframite", color: "#AB352E" },
    17: { name: "Uranium", color: "#8AD164" },
};

// In the game both boost areas are light yellow; the plants themselves differ.
const BOOST_AREA = "rgba(255, 240, 140, 0.24)";
const BOOST_EDGE = "rgba(188, 176, 102, 0.9)";
export const PLANT_STYLE = {
    coal: { name: "Coal Power Plant", fill: "#3c3c3c", area: BOOST_AREA, edge: BOOST_EDGE },
    nuclear: { name: "Nuclear Power Plant", fill: "#4ec9b0", area: BOOST_AREA, edge: BOOST_EDGE },
};

const AREA = { coal: { aw: 12, ah: 12 }, nuclear: { aw: 21, ah: 22 } };


export class MapView {
    private world: World | null = null;
    private plants: Plant[] = [];
    private terrain: HTMLCanvasElement | null = null;
    private cx = 0;
    private cy = 0;
    private scale = 1;          // CSS pixels per tile
    private pointers = new Map<number, { x: number; y: number }>();
    private pinch: { dist: number; scale: number } | null = null;
    private queued = false;
    showAreas = true;
    onlyPartial = false;        // fade fully powered plants and their boost areas
    onView: ((x: number, y: number) => void) | null = null;     // called after every redraw with the middle tile
    private target: { x: number; y: number; until: number } | null = null;
    flip = false;

    constructor(private canvas: HTMLCanvasElement) {
        new ResizeObserver(() => this.draw()).observe(canvas);
        canvas.addEventListener("pointerdown", (e) => this.down(e));
        canvas.addEventListener("pointermove", (e) => this.move(e));
        for (const t of ["pointerup", "pointercancel", "pointerleave"]) canvas.addEventListener(t, (e) => this.up(e as PointerEvent));
        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            const r = canvas.getBoundingClientRect();
            this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        // phones: a double tap or long press must not select text or open the callout menu
        // (dragging and pinching use the pointer events above, which still fire)
        canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
        for (const t of ["selectstart", "dblclick", "contextmenu", "gesturestart"]) canvas.addEventListener(t, (e) => e.preventDefault());
    }

    setWorld(world: World) {
        this.world = world;
        this.plants = [];
        const m = world.map;
        this.terrain = null;
        if (m) {
            const c = document.createElement("canvas");
            c.width = m.width; c.height = m.height;
            const ctx = c.getContext("2d")!;
            const img = ctx.createImageData(m.width, m.height);
            const rgb: Record<number, [number, number, number]> = {};
            for (const [k, v] of Object.entries(TERRAIN_COLORS)) rgb[+k] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16)) as [number, number, number];
            for (let i = 0; i < m.terrain.length; i++) {
                const [r, g, b] = rgb[m.terrain[i]!] ?? [0, 0, 0];
                img.data[4 * i] = r; img.data[4 * i + 1] = g; img.data[4 * i + 2] = b; img.data[4 * i + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
            this.terrain = c;
        }
        this.fit();
    }

    setPlants(plants: Plant[]) {
        this.plants = plants;
        this.draw();
    }

    /** show every deposit */
    fit() {
        const w = this.world;
        if (!w || !w.deposits.count) return;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < w.deposits.count; i++) {
            x0 = Math.min(x0, w.deposits.x[i]!); x1 = Math.max(x1, w.deposits.x[i]!);
            y0 = Math.min(y0, w.deposits.y[i]!); y1 = Math.max(y1, w.deposits.y[i]!);
        }
        const { width, height } = this.canvas.getBoundingClientRect();
        this.cx = (x0 + x1) / 2; this.cy = (y0 + y1) / 2;
        this.scale = Math.min(width / (x1 - x0 + 40), height / (y1 - y0 + 40)) || 1;
        this.draw();
    }

    zoom(factor: number) {
        const { width, height } = this.canvas.getBoundingClientRect();
        this.zoomAt(factor, width / 2, height / 2);
    }

    /** the tile in the middle of the map */
    centerTile(): [number, number] {
        return [Math.floor(this.cx), Math.floor(this.cy)];
    }

    /** centre the map on tile (x, y), zoom in to at least 12 screen pixels per tile, and mark the tile briefly */
    goTo(x: number, y: number) {
        this.cx = x + 0.5;
        this.cy = y + 0.5;
        this.scale = Math.min(40, Math.max(this.scale, 12));
        this.target = { x, y, until: performance.now() + 2500 };
        this.draw();
        setTimeout(() => this.draw(), 2600);
    }

    private zoomAt(factor: number, sx: number, sy: number) {
        const { width, height } = this.canvas.getBoundingClientRect();
        const [wx, wy] = this.toWorld(sx, sy, width, height);
        this.scale = Math.min(40, Math.max(0.05, this.scale * factor));
        // keep the point under the finger in place
        this.cx = wx - (sx - width / 2) / this.scale;
        this.cy = wy - (this.flip ? -1 : 1) * (sy - height / 2) / this.scale;
        this.draw();
    }

    private toWorld(sx: number, sy: number, width: number, height: number): [number, number] {
        return [this.cx + (sx - width / 2) / this.scale, this.cy + (this.flip ? -1 : 1) * (sy - height / 2) / this.scale];
    }

    private down(e: PointerEvent) {
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 2) {
            const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
            this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
        }
    }

    private move(e: PointerEvent) {
        const p = this.pointers.get(e.pointerId);
        if (!p) return;
        const r = this.canvas.getBoundingClientRect();
        if (this.pointers.size === 1) {
            this.cx -= (e.clientX - p.x) / this.scale;
            this.cy -= (this.flip ? -1 : 1) * (e.clientY - p.y) / this.scale;
            p.x = e.clientX; p.y = e.clientY;
            this.draw();
        } else if (this.pointers.size === 2 && this.pinch) {
            p.x = e.clientX; p.y = e.clientY;
            const [a, b] = [...this.pointers.values()] as [{ x: number; y: number }, { x: number; y: number }];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const target = this.pinch.scale * dist / Math.max(1, this.pinch.dist);
            this.zoomAt(target / this.scale, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        }
    }

    private up(e: PointerEvent) {
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2) this.pinch = null;
    }

    /** redraw on the next animation frame */
    draw() {
        if (this.queued) return;
        this.queued = true;
        requestAnimationFrame(() => {
            this.queued = false;
            this.render();
        });
    }

    private render() {
        const canvas = this.canvas, w = this.world;
        const { width, height } = canvas.getBoundingClientRect();
        if (!width || !height) return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext("2d")!;
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = TERRAIN_COLORS[1]!;
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!w) return;
        const s = this.scale * dpr, fy = this.flip ? -1 : 1;
        // world tile (x, y) -> device pixels; a tile covers [x, x+1) x [y, y+1)
        const X = (x: number) => (x - this.cx) * s + canvas.width / 2;
        const Y = (y: number) => fy * (y - this.cy) * s + canvas.height / 2;
        const rect = (x: number, y: number, rw: number, rh: number) => {
            const a = X(x), b = X(x + rw), c = Y(y), d = Y(y + rh);
            ctx.fillRect(Math.min(a, b), Math.min(c, d), Math.abs(b - a), Math.abs(d - c));
        };

        if (this.terrain && w.map) {
            const m = w.map;
            ctx.imageSmoothingEnabled = false;
            // sample (i, j) is tile (x0 + i*step, y0 + j*step); draw it centred on that tile
            ctx.setTransform(s * m.step, 0, 0, fy * s * m.step, X(m.x0 + 0.5 - m.step / 2), Y(m.y0 + 0.5 - m.step / 2));
            ctx.drawImage(this.terrain, 0, 0);
            ctx.setTransform(1, 0, 0, 1, 0, 0);
        }

        // "only partly powered": fully powered plants and their areas are faded, the others drawn on top
        const faded = (p: Plant) => this.onlyPartial && (p.power ?? 1) >= 1;
        const plants = this.onlyPartial ? [...this.plants].sort((a, b) => Number(faded(b)) - Number(faded(a))) : this.plants;
        const FADE = 0.15;

        // boost areas under everything else
        if (this.showAreas) {
            for (const p of plants) {
                ctx.globalAlpha = faded(p) ? FADE : 1;
                const st = PLANT_STYLE[p.kind];
                const aw = p.kind === "coal" ? AREA.coal.aw : (p.w === 3 ? 21 : 22);
                const ah = p.kind === "coal" ? AREA.coal.ah : (p.w === 3 ? 22 : 21);
                const lx = (aw - p.w) >> 1, ty = (ah - p.h) >> 1;
                ctx.fillStyle = st.area;
                rect(p.x - lx, p.y - ty, aw, ah);
                ctx.strokeStyle = st.edge;
                ctx.lineWidth = Math.max(1, dpr);
                const a = X(p.x - lx), b = X(p.x - lx + aw), c = Y(p.y - ty), d = Y(p.y - ty + ah);
                ctx.strokeRect(Math.min(a, b), Math.min(c, d), Math.abs(b - a), Math.abs(d - c));
            }
            ctx.globalAlpha = 1;
        }

        // Deposits and plants never get smaller than a few screen pixels, and sit on a dark halo,
        // so they stay easy to see when zoomed out (tile size grows normally when zoomed in).
        const HALO = "rgba(10, 14, 16, 0.45)";
        const inView = (x: number, y: number, m: number) => x > -m && y > -m && x < canvas.width + m && y < canvas.height + m;
        const sz = Math.max(s, 3.2 * dpr), half = sz / 2, o = Math.max(dpr, sz * 0.18);
        const pos = new Float32Array(2 * w.deposits.count);
        for (let i = 0; i < w.deposits.count; i++) {
            pos[2 * i] = X(w.deposits.x[i]! + 0.5);
            pos[2 * i + 1] = Y(w.deposits.y[i]! + 0.5);
        }
        ctx.fillStyle = HALO;
        for (let i = 0; i < w.deposits.count; i++) {
            const x = pos[2 * i]!, y = pos[2 * i + 1]!;
            if (inView(x, y, sz + o)) ctx.fillRect(x - half - o, y - half - o, sz + 2 * o, sz + 2 * o);
        }
        for (const [id, st] of Object.entries(DEPOSIT_STYLE)) {
            ctx.fillStyle = st.color;
            for (let i = 0; i < w.deposits.count; i++) {
                if (w.deposits.id[i] !== +id) continue;
                const x = pos[2 * i]!, y = pos[2 * i + 1]!;
                if (inView(x, y, sz)) ctx.fillRect(x - half, y - half, sz, sz);
            }
        }

        // power plants on top: never smaller than 2.2 screen pixels per tile (so a 2x2 coal plant
        // is about 4 px and a nuclear plant 7-9 px when zoomed out), dark halo, yellow outline
        for (const p of plants) {
            ctx.globalAlpha = faded(p) ? FADE : 1;
            const st = PLANT_STYLE[p.kind];
            const mx = X(p.x + p.w / 2), my = Y(p.y + p.h / 2);
            const minTile = 2.2 * dpr;
            const pw = Math.abs(p.w) * Math.max(s, minTile), ph = Math.abs(p.h) * Math.max(s, minTile);
            const po = Math.max(dpr, Math.min(pw, ph) * 0.12);
            if (!inView(mx, my, Math.max(pw, ph) + po)) continue;
            ctx.fillStyle = HALO;
            ctx.fillRect(mx - pw / 2 - po, my - ph / 2 - po, pw + 2 * po, ph + 2 * po);
            // partly powered: filled from the bottom up to its share, like a fuel gauge
            const power = p.power ?? 1;
            if (power < 1) {
                // the empty part: light for the dark coal plant, dark for the light nuclear plant
                ctx.fillStyle = p.kind === "coal" ? "#c8c8c8" : "#1e1e1e";
                ctx.fillRect(mx - pw / 2, my - ph / 2, pw, ph);
            }
            ctx.fillStyle = st.fill;
            const fh = ph * power;
            ctx.fillRect(mx - pw / 2, my + ph / 2 - fh, pw, fh);
            ctx.strokeStyle = "#fff08c";
            ctx.lineWidth = Math.max(dpr, s * 0.15);
            ctx.strokeRect(mx - pw / 2, my - ph / 2, pw, ph);
            if (power < 1) {
                // the percentage fills the middle 2 x 2 tiles of a coal plant / 3 x 3 of a nuclear plant, with a
                // margin so it never touches the plant's border; it scales with the zoom (hidden when too small)
                const tile = pw / Math.abs(p.w);
                const margin = Math.max(ctx.lineWidth + 1.5 * dpr, 0.18 * tile);
                const box = (p.kind === "coal" ? 2 : 3) * tile - 2 * margin;
                const label = `${Math.round(power * 100)}%`;
                ctx.font = "bold 100px sans-serif";
                const m = ctx.measureText(label);
                const textH = (m.actualBoundingBoxAscent + m.actualBoundingBoxDescent) || 72;
                const size = 100 * Math.min(box / (m.width + 16), box / (textH + 16));     // + its outline (0.16 x size)
                if (size >= 7 * dpr) {
                    ctx.font = `bold ${size.toFixed(1)}px sans-serif`;
                    ctx.textAlign = "center";
                    ctx.textBaseline = "middle";
                    ctx.lineJoin = "round";
                    ctx.lineWidth = Math.max(2 * dpr, size * 0.16);
                    ctx.strokeStyle = "rgba(0, 0, 0, 0.85)";
                    ctx.strokeText(label, mx, my);
                    ctx.fillStyle = "#ffffff";
                    ctx.fillText(label, mx, my);
                }
            }
        }
        ctx.globalAlpha = 1;

        // tile picked with "Go to": a bright frame for a moment
        if (this.target && performance.now() < this.target.until) {
            // the tile itself framed, and a ring around it so it is easy to see next to the crosshair
            const t = this.target, tx = X(t.x + 0.5), ty = Y(t.y + 0.5);
            ctx.lineWidth = 2 * dpr;
            ctx.strokeStyle = "#ff4fd8";
            ctx.strokeRect(tx - s / 2, ty - s / 2, s, s);
            const r = Math.max(1.6 * s, 16 * dpr);
            for (const [color, width] of [["rgba(0, 0, 0, 0.8)", 5 * dpr], ["#ff4fd8", 2.5 * dpr]] as const) {
                ctx.strokeStyle = color;
                ctx.lineWidth = width;
                ctx.beginPath();
                ctx.arc(tx, ty, r, 0, 2 * Math.PI);
                ctx.stroke();
            }
        } else {
            this.target = null;
        }

        // crosshair: the "Looking at" tile is the one under it
        const cxp = canvas.width / 2, cyp = canvas.height / 2, arm = 7 * dpr;
        for (const [color, width] of [["rgba(0, 0, 0, 0.7)", 3 * dpr], ["#ffffff", 1.2 * dpr]] as const) {
            ctx.strokeStyle = color;
            ctx.lineWidth = width;
            ctx.beginPath();
            ctx.moveTo(cxp - arm, cyp); ctx.lineTo(cxp + arm, cyp);
            ctx.moveTo(cxp, cyp - arm); ctx.lineTo(cxp, cyp + arm);
            ctx.stroke();
        }
        this.onView?.(...this.centerTile());
    }
}
