// World map: terrain, deposits and power plants on a canvas, with drag / pinch / wheel zoom.
export const TERRAIN_COLORS = {
    1: "#5678b8", 2: "#6ba577", 3: "#d7c0a3", 4: "#2f6e57", 5: "#37804d", 6: "#3e9158",
};
// Deposit colours as in the game's item icons.
export const DEPOSIT_STYLE = {
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
    canvas;
    world = null;
    plants = [];
    terrain = null;
    cx = 0;
    cy = 0;
    scale = 1; // CSS pixels per tile
    pointers = new Map();
    pinch = null;
    queued = false;
    showAreas = true;
    flip = false;
    constructor(canvas) {
        this.canvas = canvas;
        new ResizeObserver(() => this.draw()).observe(canvas);
        canvas.addEventListener("pointerdown", (e) => this.down(e));
        canvas.addEventListener("pointermove", (e) => this.move(e));
        for (const t of ["pointerup", "pointercancel", "pointerleave"])
            canvas.addEventListener(t, (e) => this.up(e));
        canvas.addEventListener("wheel", (e) => {
            e.preventDefault();
            const r = canvas.getBoundingClientRect();
            this.zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
        }, { passive: false });
        // phones: a double tap or long press must not select text or open the callout menu
        // (dragging and pinching use the pointer events above, which still fire)
        canvas.addEventListener("touchstart", (e) => e.preventDefault(), { passive: false });
        for (const t of ["selectstart", "dblclick", "contextmenu", "gesturestart"])
            canvas.addEventListener(t, (e) => e.preventDefault());
    }
    setWorld(world) {
        this.world = world;
        this.plants = [];
        const m = world.map;
        this.terrain = null;
        if (m) {
            const c = document.createElement("canvas");
            c.width = m.width;
            c.height = m.height;
            const ctx = c.getContext("2d");
            const img = ctx.createImageData(m.width, m.height);
            const rgb = {};
            for (const [k, v] of Object.entries(TERRAIN_COLORS))
                rgb[+k] = [1, 3, 5].map((i) => parseInt(v.slice(i, i + 2), 16));
            for (let i = 0; i < m.terrain.length; i++) {
                const [r, g, b] = rgb[m.terrain[i]] ?? [0, 0, 0];
                img.data[4 * i] = r;
                img.data[4 * i + 1] = g;
                img.data[4 * i + 2] = b;
                img.data[4 * i + 3] = 255;
            }
            ctx.putImageData(img, 0, 0);
            this.terrain = c;
        }
        this.fit();
    }
    setPlants(plants) {
        this.plants = plants;
        this.draw();
    }
    /** show every deposit */
    fit() {
        const w = this.world;
        if (!w || !w.deposits.count)
            return;
        let x0 = Infinity, x1 = -Infinity, y0 = Infinity, y1 = -Infinity;
        for (let i = 0; i < w.deposits.count; i++) {
            x0 = Math.min(x0, w.deposits.x[i]);
            x1 = Math.max(x1, w.deposits.x[i]);
            y0 = Math.min(y0, w.deposits.y[i]);
            y1 = Math.max(y1, w.deposits.y[i]);
        }
        const { width, height } = this.canvas.getBoundingClientRect();
        this.cx = (x0 + x1) / 2;
        this.cy = (y0 + y1) / 2;
        this.scale = Math.min(width / (x1 - x0 + 40), height / (y1 - y0 + 40)) || 1;
        this.draw();
    }
    zoom(factor) {
        const { width, height } = this.canvas.getBoundingClientRect();
        this.zoomAt(factor, width / 2, height / 2);
    }
    zoomAt(factor, sx, sy) {
        const { width, height } = this.canvas.getBoundingClientRect();
        const [wx, wy] = this.toWorld(sx, sy, width, height);
        this.scale = Math.min(40, Math.max(0.05, this.scale * factor));
        // keep the point under the finger in place
        this.cx = wx - (sx - width / 2) / this.scale;
        this.cy = wy - (this.flip ? -1 : 1) * (sy - height / 2) / this.scale;
        this.draw();
    }
    toWorld(sx, sy, width, height) {
        return [this.cx + (sx - width / 2) / this.scale, this.cy + (this.flip ? -1 : 1) * (sy - height / 2) / this.scale];
    }
    down(e) {
        this.canvas.setPointerCapture(e.pointerId);
        this.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
        if (this.pointers.size === 2) {
            const [a, b] = [...this.pointers.values()];
            this.pinch = { dist: Math.hypot(a.x - b.x, a.y - b.y), scale: this.scale };
        }
    }
    move(e) {
        const p = this.pointers.get(e.pointerId);
        if (!p)
            return;
        const r = this.canvas.getBoundingClientRect();
        if (this.pointers.size === 1) {
            this.cx -= (e.clientX - p.x) / this.scale;
            this.cy -= (this.flip ? -1 : 1) * (e.clientY - p.y) / this.scale;
            p.x = e.clientX;
            p.y = e.clientY;
            this.draw();
        }
        else if (this.pointers.size === 2 && this.pinch) {
            p.x = e.clientX;
            p.y = e.clientY;
            const [a, b] = [...this.pointers.values()];
            const dist = Math.hypot(a.x - b.x, a.y - b.y);
            const target = this.pinch.scale * dist / Math.max(1, this.pinch.dist);
            this.zoomAt(target / this.scale, (a.x + b.x) / 2 - r.left, (a.y + b.y) / 2 - r.top);
        }
    }
    up(e) {
        this.pointers.delete(e.pointerId);
        if (this.pointers.size < 2)
            this.pinch = null;
    }
    /** redraw on the next animation frame */
    draw() {
        if (this.queued)
            return;
        this.queued = true;
        requestAnimationFrame(() => {
            this.queued = false;
            this.render();
        });
    }
    render() {
        const canvas = this.canvas, w = this.world;
        const { width, height } = canvas.getBoundingClientRect();
        if (!width || !height)
            return;
        const dpr = window.devicePixelRatio || 1;
        if (canvas.width !== Math.round(width * dpr) || canvas.height !== Math.round(height * dpr)) {
            canvas.width = Math.round(width * dpr);
            canvas.height = Math.round(height * dpr);
        }
        const ctx = canvas.getContext("2d");
        ctx.setTransform(1, 0, 0, 1, 0, 0);
        ctx.fillStyle = TERRAIN_COLORS[1];
        ctx.fillRect(0, 0, canvas.width, canvas.height);
        if (!w)
            return;
        const s = this.scale * dpr, fy = this.flip ? -1 : 1;
        // world tile (x, y) -> device pixels; a tile covers [x, x+1) x [y, y+1)
        const X = (x) => (x - this.cx) * s + canvas.width / 2;
        const Y = (y) => fy * (y - this.cy) * s + canvas.height / 2;
        const rect = (x, y, rw, rh) => {
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
        // boost areas under everything else
        if (this.showAreas) {
            for (const p of this.plants) {
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
        }
        // Deposits and plants never get smaller than a few screen pixels, and sit on a dark halo,
        // so they stay easy to see when zoomed out (tile size grows normally when zoomed in).
        const HALO = "rgba(10, 14, 16, 0.45)";
        const inView = (x, y, m) => x > -m && y > -m && x < canvas.width + m && y < canvas.height + m;
        const sz = Math.max(s, 3.2 * dpr), half = sz / 2, o = Math.max(dpr, sz * 0.18);
        const pos = new Float32Array(2 * w.deposits.count);
        for (let i = 0; i < w.deposits.count; i++) {
            pos[2 * i] = X(w.deposits.x[i] + 0.5);
            pos[2 * i + 1] = Y(w.deposits.y[i] + 0.5);
        }
        ctx.fillStyle = HALO;
        for (let i = 0; i < w.deposits.count; i++) {
            const x = pos[2 * i], y = pos[2 * i + 1];
            if (inView(x, y, sz + o))
                ctx.fillRect(x - half - o, y - half - o, sz + 2 * o, sz + 2 * o);
        }
        for (const [id, st] of Object.entries(DEPOSIT_STYLE)) {
            ctx.fillStyle = st.color;
            for (let i = 0; i < w.deposits.count; i++) {
                if (w.deposits.id[i] !== +id)
                    continue;
                const x = pos[2 * i], y = pos[2 * i + 1];
                if (inView(x, y, sz))
                    ctx.fillRect(x - half, y - half, sz, sz);
            }
        }
        // power plants on top: never smaller than 2.2 screen pixels per tile (so a 2x2 coal plant
        // is about 4 px and a nuclear plant 7-9 px when zoomed out), dark halo, yellow outline
        for (const p of this.plants) {
            const st = PLANT_STYLE[p.kind];
            const mx = X(p.x + p.w / 2), my = Y(p.y + p.h / 2);
            const minTile = 2.2 * dpr;
            const pw = Math.abs(p.w) * Math.max(s, minTile), ph = Math.abs(p.h) * Math.max(s, minTile);
            const po = Math.max(dpr, Math.min(pw, ph) * 0.12);
            if (!inView(mx, my, Math.max(pw, ph) + po))
                continue;
            ctx.fillStyle = HALO;
            ctx.fillRect(mx - pw / 2 - po, my - ph / 2 - po, pw + 2 * po, ph + 2 * po);
            ctx.fillStyle = st.fill;
            ctx.fillRect(mx - pw / 2, my - ph / 2, pw, ph);
            ctx.strokeStyle = "#fff08c";
            ctx.lineWidth = Math.max(dpr, s * 0.15);
            ctx.strokeRect(mx - pw / 2, my - ph / 2, pw, ph);
        }
    }
}
//# sourceMappingURL=map.js.map