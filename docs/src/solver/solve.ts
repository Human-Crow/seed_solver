// Exact production solver (port of builderment_solver.py): the most target items per minute a world can
// support, with real coal / nuclear power plants on real positions.
//
// The plant spots are reduced (spots with the same effect merged, spots another spot beats dropped). That is only
// safe without the rule "plants never overlap", so the areas are solved without it: the maximum is then a true
// upper limit. Each layout is then placed on real, non-overlapping positions that are at least as good
// (realize.ts) and scored exactly; those placed layouts are what is reported.
// The plant positions split into independent areas ("components": positions that share deposits or tiles).
// Step 1, column generation: a master LP picks the recipe mix and, per area, a mix of known layouts; a small
// MIP per area finds the layout worth most at the master's resource prices, until nothing improves the
// master. That gives the proven maximum; a MIP over the known layouts gives a first real layout.
// Step 2: the full MIP (all areas and the recipes together) closes the gap.

import { COAL_FUEL_PER_MIN, NUCLEAR_FUEL_PER_MIN, PLANT_SHAPES, RAW_ITEMS } from "./data.js";
import { find_candidates, type Cand, type Deposits } from "./candidates.js";
import { Columns, RecipeModel, speed_table, type SolverSettings } from "./model.js";
import { Positions, realize, type Placed } from "./realize.js";
import type { HighsModel, HighsRuntime } from "./highs.js";

export type { SolverSettings } from "./model.js";

export interface WorldInput {
    gen2: boolean;
    deposits: { id: ArrayLike<number>; x: Int32Array; y: Int32Array };   // ids 11..17
    water: { x: Int32Array; y: Int32Array };                          // water within 12 tiles of deposits
}

export interface Plant {
    kind: "coal" | "nuclear";
    x: number;                  // footprint top-left tile
    y: number;
    w: number;
    h: number;
    power?: number;             // share of the fuel it gets, 0..1 (missing = 1, fully powered)
}

export interface LayoutReport {
    score: number;              // target per minute of this layout (exact when `exact`)
    exact: boolean;
    bound: number;              // proven maximum so far
    plants: Plant[];
}

export interface Progress {
    step: string;
    message: string;
    best?: number;
    bound?: number;
}

export interface Hooks {
    progress(p: Progress): void;
    layout(l: LayoutReport): void;
}

// sel: chosen plants of the area, pow: their powered share (1 = full fuel), g: resource gain, nfc: fuel cells
type Layout = { sel: number[]; pow: number[]; g: Float64Array; nfc: number };

const POW_EPS = 1e-6;

/** chosen plants and their powered shares from a solution vector (unpowered plants are left out) */
function pick(nK: number, x: ArrayLike<number>, off: number, powVar: (j: number) => number, partial: boolean): [number[], number[]] {
    const sel: number[] = [], pow: number[] = [];
    for (let j = 0; j < nK; j++) {
        if (x[off + j]! <= 0.5) continue;
        let p = partial ? Math.min(1, Math.max(0, x[off + powVar(j)]!)) : 1;
        if (p < POW_EPS) continue;
        if (p > 1 - POW_EPS) p = 1;
        sel.push(j);
        pow.push(p);
    }
    return [sel, pow];
}

/**
 * Share of the time a tile is nuclear / coal boosted, from whether a fully powered plant of each kind reaches it
 * and the largest powered share of the partly powered ones. Worst case for partly powered plants: their on
 * times overlap each other and the nuclear plant's, so they add nothing beyond the largest share.
 */
function shares(fullN: number, maxN: number, fullC: number, maxC: number): [number, number] {
    const n = fullN ? 1 : maxN;
    const c = fullC ? 1 - n : Math.max(0, maxC - n);
    return [n, c];
}

const layout_key = (l: Layout) => l.sel.map((j, k) => `${j}:${l.pow[k]!.toFixed(6)}`).join(",");


// ---------------------------------------------------------------- one area of plant positions
class Comp {
    readonly nK: number;
    readonly nD: number;
    readonly nv: number;
    readonly deps: number[];
    readonly dt: Uint8Array;
    readonly s0: Float64Array;
    readonly sc: Float64Array;
    readonly sn: Float64Array;
    readonly G: Float64Array;           // 7 x nv resource gain per variable
    readonly nfc: Float64Array;         // fuel cells per variable
    readonly ub: Float64Array;
    readonly rows: { cols: number[]; vals: number[]; hi: number }[] = [];
    private pricing: HighsModel | null = null;

    readonly partial: boolean;

    /** variable of plant j's powered share (the plant variable itself when shares are off) */
    powVar(j: number): number {
        return this.partial ? this.nK + 2 * this.nD + j : j;
    }

    /** yes/no "plant j is fully powered" (only with partial power) */
    fullVar(j: number): number {
        return this.nK + 2 * this.nD + this.nK + j;
    }

    /** integer variables: plants built, and with partial power the "fully powered" choices */
    isInt(v: number): boolean {
        return v < this.nK || (this.partial && v >= this.nK + 2 * this.nD + this.nK);
    }

    constructor(readonly cands: Cand[], dtype: Uint8Array, S: Float64Array, partial = false, overlapRule = true) {
        this.partial = partial;
        const dset = new Set<number>();
        for (const c of cands) { c.cover.forEach((d) => dset.add(d)); c.foot.forEach((d) => dset.add(d)); }
        this.deps = [...dset].sort((a, b) => a - b);
        const di = new Map(this.deps.map((d, i) => [d, i]));
        const nK = cands.length, nD = this.deps.length;
        this.nK = nK; this.nD = nD; this.nv = nK + 2 * nD + (partial ? 2 * nK : 0);
        this.dt = Uint8Array.from(this.deps.map((d) => dtype[d]!));
        this.s0 = Float64Array.from(this.dt, (t) => S[t * 3]!);
        this.sc = Float64Array.from(this.dt, (t) => S[t * 3 + 1]!);
        this.sn = Float64Array.from(this.dt, (t) => S[t * 3 + 2]!);

        const covn = new Map<number, number[]>(), covc = new Map<number, number[]>(), foot = new Map<number, number[]>();
        const push = (m: Map<number, number[]>, k: number, v: number) => { let l = m.get(k); if (!l) m.set(k, (l = [])); l.push(v); };
        cands.forEach((c, j) => {
            for (const d of c.cover) push(c.kind === 1 ? covn : covc, di.get(d)!, j);
            for (const d of c.foot) push(foot, di.get(d)!, j);
        });
        // variables: y[nK] (plant built), bn[nD], bc[nD] (share of time an extractor is nuclear / coal boosted)
        // and, with partial power, p[nK] (share of the time plant j runs: the share of fuel it gets, p <= y)
        // and f[nK] (plant j fully powered: p = 1). A plant that is not fully powered may share no boosted
        // tile with any other plant, so its tiles are boosted exactly its share of the time, however the
        // plants' on / off times line up (rows added by exclusive()). Fully powered plants may overlap.
        const pv = (j: number) => this.powVar(j);
        for (let i = 0; i < nD; i++) {
            const n = covn.get(i), c = covc.get(i), f = foot.get(i) ?? [];
            if (n) this.rows.push({ cols: [nK + i, ...n.map(pv)], vals: [1, ...n.map(() => -1)], hi: 0 });
            if (c) this.rows.push({ cols: [nK + nD + i, ...c.map(pv)], vals: [1, ...c.map(() => -1)], hi: 0 });
            const r = new Map<number, number>([[nK + i, 1], [nK + nD + i, 1]]);
            for (const j of f) r.set(j, (r.get(j) ?? 0) + 1);
            this.rows.push({ cols: [...r.keys()], vals: [...r.values()], hi: 1 });
        }
        // footprints never overlap
        const tiles = new Map<string, number[]>();
        cands.forEach((c, j) => {
            for (let a = 0; a < c.w; a++) {
                for (let b = 0; b < c.h; b++) {
                    const key = `${c.x + a},${c.y + b}`;
                    let l = tiles.get(key);
                    if (!l) tiles.set(key, (l = []));
                    l.push(j);
                }
            }
        });
        const seen = new Set<string>();
        for (const js of overlapRule ? tiles.values() : []) {
            if (js.length < 2) continue;
            const key = js.join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            this.rows.push({ cols: js, vals: js.map(() => 1), hi: 1 });
        }
        if (partial) {
            for (let j = 0; j < nK; j++) {
                this.rows.push({ cols: [pv(j), j], vals: [1, -1], hi: 0 });                    // p <= y
                this.rows.push({ cols: [this.fullVar(j), pv(j)], vals: [1, -1], hi: 0 });      // f <= p
            }
            // "a plant that is not fully powered is the only plant on its tiles" is added only where it is
            // needed, after a search found such a plant next to others (exclusive())
        }
        this.ub = new Float64Array(this.nv);
        for (let j = 0; j < nK; j++) { this.ub[j] = 1; this.ub[pv(j)] = 1; if (partial) this.ub[this.fullVar(j)] = 1; }
        for (let i = 0; i < nD; i++) { this.ub[nK + i] = covn.has(i) ? 1 : 0; this.ub[nK + nD + i] = covc.has(i) ? 1 : 0; }
        // gains per variable and resource, fuel cells per plant
        this.G = new Float64Array(7 * this.nv);
        this.nfc = new Float64Array(this.nv);
        for (let i = 0; i < nD; i++) {
            const t = this.dt[i]!;
            this.G[t * this.nv + nK + i] += this.sn[i]! - this.s0[i]!;
            this.G[t * this.nv + nK + nD + i] += this.sc[i]! - this.s0[i]!;
            for (const j of foot.get(i) ?? []) this.G[t * this.nv + j] -= this.s0[i]!;
        }
        cands.forEach((c, j) => {
            if (c.kind === 0) this.G[4 * this.nv + pv(j)] -= COAL_FUEL_PER_MIN;     // coal is raw item 4
            else this.nfc[pv(j)] = NUCLEAR_FUEL_PER_MIN;
        });
    }

    private neighbours: number[][] | null = null;
    private exclusiveAll = false;

    /** positions sharing a boosted tile with position j */
    private near(j: number): number[] {
        if (!this.neighbours) {
            const by = new Map<number, number[]>();
            this.cands.forEach((c, k) => c.cover.forEach((d) => { let l = by.get(d); if (!l) by.set(d, (l = [])); l.push(k); }));
            const sets = this.cands.map(() => new Set<number>());
            for (const ks of by.values()) for (const a of ks) for (const b of ks) if (a !== b) sets[a]!.add(b);
            this.neighbours = sets.map((st) => [...st]);
        }
        return this.neighbours[j]!;
    }

    /**
     * If a layout has a partly powered plant in this area, every position of the area gets the rule
     * "only partly powered when none of the positions sharing its tiles is built" (y_k + y_j - f_j <= 1), so
     * the next search cannot just move the partial power to a neighbour. Returns how many plants broke it.
     */
    exclusive(l: Layout): number {
        const built = new Set(l.sel);
        let broken = 0, partial = false;
        l.sel.forEach((j, k) => {
            if (l.pow[k]! >= 1) return;
            partial = true;
            if (this.near(j).some((q) => built.has(q))) broken++;
        });
        if (partial && !this.exclusiveAll) {
            this.exclusiveAll = true;
            for (let j = 0; j < this.nK; j++) for (const q of this.near(j)) this.rows.push({ cols: [q, j, this.fullVar(j)], vals: [1, 1, -1], hi: 1 });
        }
        return broken;
    }

    /** column entries of variable v in this area's own rows */
    colsByVar(): { rows: number[]; vals: number[] }[] {
        const out = Array.from({ length: this.nv }, () => ({ rows: [] as number[], vals: [] as number[] }));
        this.rows.forEach((r, n) => r.cols.forEach((c, k) => { out[c]!.rows.push(n); out[c]!.vals.push(r.vals[k]!); }));
        return out;
    }

    /** Most valuable layout at resource prices pi[7] and fuel cell price pnfc: [value, layout]. */
    price(H: HighsRuntime, pi: Float64Array, pnfc: number): [number, Layout] | null {
        const cost = new Float64Array(this.nv);
        for (let v = 0; v < this.nv; v++) {
            let c = -pnfc * this.nfc[v]!;
            for (let r = 0; r < 7; r++) c += pi[r]! * this.G[r * this.nv + v]!;
            cost[v] = -c;
        }
        if (!this.pricing) {
            const cols = new Columns();
            const byVar = this.colsByVar();
            for (let v = 0; v < this.nv; v++) cols.add(byVar[v]!.rows, byVar[v]!.vals, 0, this.ub[v]!, cost[v]!, this.isInt(v));
            const m = H.createModel();
            m.passModel(cols.model(H, this.rows.length, this.rows.map(() => -Infinity), this.rows.map((r) => r.hi), true));
            m.options.set({ output_flag: false, mip_rel_gap: 1e-9 });
            this.pricing = m;
        } else {
            this.pricing.changeColsCost({ kind: "range", from: 0, to: this.nv - 1 }, cost);
        }
        const m = this.pricing;
        const run = m.run();
        if (run.modelStatus !== H.constants.modelStatus.optimal) return null;
        const x = m.getSolution().colValue;
        const [sel, pow] = pick(this.nK, x, 0, (j) => this.powVar(j), this.partial);
        return [-m.getObjectiveValue(), this.layout(sel, pow)];
    }

    /**
     * Resource gain of a layout. A tile is nuclear boosted for the summed share of the nuclear plants
     * reaching it (at most all the time), coal boosted for the rest of the time the coal plants run.
     * With every plant fully powered this is: nuclear wins, then coal.
     */
    layout(sel: number[], pow: number[] = sel.map(() => 1)): Layout {
        const di = new Map(this.deps.map((d, i) => [d, i]));
        const fullN = new Uint8Array(this.nD), fullC = new Uint8Array(this.nD), maxN = new Float64Array(this.nD), maxC = new Float64Array(this.nD);
        const rem = new Uint8Array(this.nD);
        let coalRun = 0, nucRun = 0;
        sel.forEach((j, k) => {
            const c = this.cands[j]!, p = pow[k]!, nuc = c.kind === 1;
            c.cover.forEach((d) => {
                const i = di.get(d)!;
                if (p >= 1) (nuc ? fullN : fullC)[i] = 1;
                else if (nuc) maxN[i] = Math.max(maxN[i]!, p);
                else maxC[i] = Math.max(maxC[i]!, p);
            });
            c.foot.forEach((d) => { rem[di.get(d)!] = 1; });
            if (nuc) nucRun += p; else coalRun += p;
        });
        const g = new Float64Array(7);
        for (let i = 0; i < this.nD; i++) {
            const t = this.dt[i]!;
            if (rem[i]) { g[t] -= this.s0[i]!; continue; }
            const [n, c] = shares(fullN[i]!, maxN[i]!, fullC[i]!, maxC[i]!);
            g[t] += n * (this.sn[i]! - this.s0[i]!) + c * (this.sc[i]! - this.s0[i]!);
        }
        g[4] -= COAL_FUEL_PER_MIN * coalRun;
        return { sel, pow, g, nfc: NUCLEAR_FUEL_PER_MIN * nucRun };
    }

    dispose() {
        this.pricing?.dispose();
        this.pricing = null;
    }
}


// ---------------------------------------------------------------- the whole problem
class Problem {
    readonly M: RecipeModel;
    readonly S: Float64Array;
    readonly base = new Float64Array(7);
    readonly comps: Comp[] = [];

    constructor(readonly H: HighsRuntime, readonly dep: Deposits, cands: Cand[], settings: SolverSettings, gen2: boolean) {
        this.M = new RecipeModel(settings.alt, settings.target);
        this.S = speed_table(settings.tier, gen2);
        for (let i = 0; i < dep.count; i++) this.base[dep.type[i]!] += this.S[dep.type[i]! * 3]!;
        // areas: union-find over shared deposits and shared footprint tiles
        const parent = cands.map((_, k) => k);
        const find = (a: number): number => { while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!; return a; };
        const first = new Map<string, number>();
        const join = (key: string, k: number) => {
            const o = first.get(key);
            if (o === undefined) first.set(key, k);
            else { const a = find(o), b = find(k); if (a !== b) parent[a] = b; }
        };
        cands.forEach((c, k) => {
            c.cover.forEach((d) => join(`d${d}`, k));
            c.foot.forEach((d) => join(`d${d}`, k));
            for (let a = 0; a < c.w; a++) for (let b = 0; b < c.h; b++) join(`${c.x + a},${c.y + b}`, k);
        });
        const groups = new Map<number, Cand[]>();
        cands.forEach((c, k) => { const r = find(k); let g = groups.get(r); if (!g) groups.set(r, (g = [])); g.push(c); });
        for (const g of groups.values()) this.comps.push(new Comp(g, dep.type, this.S, !!settings.partial, settings.spots === "classes" || settings.spots === "all"));
    }

    /** item rows: lower bounds (raw rows: minus the unboosted output) */
    itemLower(extra?: (lo: Float64Array) => void): number[] {
        const lo = new Float64Array(this.M.nI);
        this.M.rawRows.forEach((row, r) => { lo[row] = -this.base[r]!; });
        extra?.(lo);
        return Array.from(lo);
    }

    private recipeColumns(cols: Columns) {
        for (let k = 0; k < this.M.nx; k++) cols.add(this.M.colRows[k]!, this.M.colVals[k]!, 0, Infinity, k === this.M.nx - 1 ? -1 : 0);
    }

    /**
     * LP (or MIP over the given layouts) choosing recipes and one layout mix per area.
     * Returns score, column values, item prices (row duals) and area values.
     */
    master(pool: Layout[][], integer = false): { val: number; x: Float64Array; du: Float64Array; mu: Float64Array } | null {
        const { M, H } = this;
        const nI = M.nI, nC = pool.length;
        const cols = new Columns();
        this.recipeColumns(cols);
        pool.forEach((list, ci) => {
            for (const lay of list) {
                const rows: number[] = [], vals: number[] = [];
                M.rawRows.forEach((row, r) => { if (lay.g[r] !== 0) { rows.push(row); vals.push(lay.g[r]!); } });
                if (lay.nfc) { rows.push(M.fcRow); vals.push(-lay.nfc); }
                rows.push(nI + ci); vals.push(1);
                const order = rows.map((_, i) => i).sort((a, b) => rows[a]! - rows[b]!);
                cols.add(order.map((i) => rows[i]!), order.map((i) => vals[i]!), 0, integer ? 1 : Infinity, 0, integer);
            }
        });
        const lower = [...this.itemLower(), ...pool.map(() => 1)];
        const upper = [...new Array(nI).fill(Infinity), ...pool.map(() => 1)];
        const m = H.createModel();
        try {
            m.passModel(cols.model(H, nI + nC, lower, upper, integer));
            m.options.set({ output_flag: false, ...(integer ? { mip_rel_gap: 1e-9 } : {}) });
            const run = m.run();
            if (run.modelStatus !== H.constants.modelStatus.optimal) return null;
            const s = m.getSolution();
            const du = s.rowDual.slice(0, nI);
            const mu = Float64Array.from(s.rowDual.slice(nI), (v) => -v);
            return { val: -m.getObjectiveValue(), x: s.colValue.slice(), du, mu };
        } finally {
            m.dispose();
        }
    }

    evaluate(lays: Layout[]): number {
        const r = this.master(lays.map((l) => [l]));
        return r ? r.val : -1;
    }

    /** The full MIP: recipes and every area's plant choice together. */
    compact(gap: number, onImproving: (score: number, bound: number, lays: Layout[]) => void,
            onLog: (best: number, bound: number) => void): { optimal: boolean; score: number; bound: number; lays: Layout[] | null } {
        const { M, H } = this;
        const nI = M.nI;
        const cols = new Columns();
        this.recipeColumns(cols);
        const lower = this.itemLower(), upper: number[] = new Array(nI).fill(Infinity);
        const offsets: number[] = [];
        let rowBase = nI;
        for (const c of this.comps) {
            offsets.push(cols.count);
            const byVar = c.colsByVar();
            for (let v = 0; v < c.nv; v++) {
                const rows: number[] = [], vals: number[] = [];
                M.rawRows.forEach((row, r) => { const g = c.G[r * c.nv + v]!; if (g !== 0) { rows.push(row); vals.push(g); } });
                if (c.nfc[v]) { rows.push(M.fcRow); vals.push(-c.nfc[v]!); }
                const order = rows.map((_, i) => i).sort((a, b) => rows[a]! - rows[b]!);
                const rr = [...order.map((i) => rows[i]!), ...byVar[v]!.rows.map((q) => q + rowBase)];
                const vv = [...order.map((i) => vals[i]!), ...byVar[v]!.vals];
                cols.add(rr, vv, 0, c.ub[v]!, 0, c.isInt(v));
            }
            for (const r of c.rows) { lower.push(-Infinity); upper.push(r.hi); }
            rowBase += c.rows.length;
        }
        const layouts = (x: ArrayLike<number>) => this.comps.map((c, ci) => {
            const [sel, pow] = pick(c.nK, x, offsets[ci]!, (j) => c.powVar(j), c.partial);
            return c.layout(sel, pow);
        });
        const m = H.createModel();
        try {
            m.passModel(cols.model(H, rowBase, lower, upper, true));
            m.options.set({ output_flag: false, mip_rel_gap: gap, mip_min_logging_interval: 1 });
            const cb = H.constants.callbackType;
            const run = m.run({
                [cb.mipImprovingSolution!]: (e) => {
                    const d = e.data;
                    if (d.mip_solution) onImproving(-(d.objective_function_value ?? d.mip_primal_bound ?? 0), -(d.mip_dual_bound ?? -Infinity), layouts(d.mip_solution));
                },
                [cb.mipLogging!]: (e) => {
                    onLog(-(e.data.mip_primal_bound ?? Infinity), -(e.data.mip_dual_bound ?? -Infinity));
                },
            });
            const st = H.constants.modelStatus;
            const bound = -m.info.get("mip_dual_bound");
            if (run.modelStatus !== st.optimal) return { optimal: false, score: 0, bound, lays: null };
            return { optimal: true, score: -m.getObjectiveValue(), bound, lays: layouts(m.getSolution().colValue) };
        } finally {
            m.dispose();
        }
    }

    plants(lays: Layout[]): Plant[] {
        const out: Plant[] = [];
        lays.forEach((l, ci) => {
            l.sel.forEach((j, k) => {
                const c = this.comps[ci]!.cands[j]!;
                const p: Plant = { kind: c.kind === 1 ? "nuclear" : "coal", x: c.x, y: c.y, w: c.w, h: c.h };
                if (l.pow[k]! < 1) p.power = l.pow[k]!;
                out.push(p);
            });
        });
        return out;
    }

    dispose() {
        for (const c of this.comps) c.dispose();
    }
}


export function to_deposits(world: WorldInput): Deposits {
    const n = world.deposits.x.length;
    const type = new Uint8Array(n);
    for (let i = 0; i < n; i++) type[i] = world.deposits.id[i]! - 11;
    return { count: n, type, x: world.deposits.x, y: world.deposits.y };
}


/**
 * Solve a world. Reports every better layout through hooks.layout (the first one after step 1) and the
 * search state through hooks.progress. `gap`: stop when best >= proven maximum * (1 - gap).
 * With partial power: first the usual full-power solve, then the search for partly powered plants starts from
 * that layout, so the result is never worse. The first part's proven maximum is only for full power, so it is
 * not reported.
 */
export function solve(H: HighsRuntime, world: WorldInput, settings: SolverSettings, gap: number, hooks: Hooks): LayoutReport {
    if (!settings.partial || !settings.boost) return solve_core(H, world, { ...settings, partial: false }, gap, hooks, null);
    const full = solve_core(H, world, { ...settings, partial: false }, gap, {
        progress: (p) => hooks.progress({ step: p.step, message: `Full power first: ${p.message.charAt(0).toLowerCase()}${p.message.slice(1)}`, ...(p.best !== undefined ? { best: p.best } : {}) }),
        layout: (l) => hooks.layout({ ...l, bound: Infinity }),
    }, null);
    return solve_core(H, world, settings, gap, hooks, full);
}


function solve_core(H: HighsRuntime, world: WorldInput, settings: SolverSettings, gap: number, hooks: Hooks, start: LayoutReport | null): LayoutReport {
    const t0 = performance.now();
    const secs = () => ((performance.now() - t0) / 1000).toFixed(0) + " s";
    const dep = to_deposits(world);
    hooks.progress({ step: "setup", message: `${dep.count} deposit tiles; finding power plant spots…` });
    const spots = settings.spots ?? "reduced";
    const cands = settings.boost && dep.count ? find_candidates(dep, world.water, spots !== "all", spots === "reduced") : [];
    const P = new Problem(H, dep, cands, settings, world.gen2);
    try {
        const C = P.comps;
        hooks.progress({ step: "setup", message: `${cands.length} possible power plant spots in ${C.length} separate areas.` });
        const empty = (): Layout => ({ sel: [], pow: [], g: new Float64Array(7), nfc: 0 });
        let bestLays: Layout[] = C.map(empty);
        let bestVal = -1, bound = 0;
        let startPlants: Plant[] | null = null;         // the full-power layout, while nothing beats it
        // The areas are solved without "plants never overlap" (so the reduced spots are safe and the maximum is
        // a true upper limit). Every layout is placed on real, non-overlapping positions and scored exactly.
        let positions: Positions | null = null;
        const getPositions = () => (positions ??= new Positions(dep, world.water));
        const placedPlants = (lays: Layout[]) => {
            const chosen: Placed[] = [];
            lays.forEach((l, ci) => l.sel.forEach((j, k) => chosen.push({ cand: C[ci]!.cands[j]!, pow: l.pow[k]! })));
            const r = realize(chosen, getPositions);
            return r.placed.map(({ cand: c, pow }): Plant => {
                const p: Plant = { kind: c.kind === 1 ? "nuclear" : "coal", x: c.x, y: c.y, w: c.w, h: c.h };
                if (pow < 1) p.power = pow;
                return p;
            });
        };
        const real = (lays: Layout[]) => {
            const plants = placedPlants(lays);
            return { v: evaluate_layout(H, world, settings, plants).score, plants };
        };
        let bestReal: Plant[] = [];
        const take = (v: number, lays: Layout[], plants: Plant[]) => { bestVal = v; bestLays = lays; bestReal = plants; startPlants = null; };
        const bestPlants = () => startPlants ?? bestReal;
        const closed = () => bound - bestVal <= gap * Math.max(1, Math.abs(bound));

        if (!C.length) {
            bestVal = P.evaluate([]);
            bound = bestVal;
            const rep = { score: bestVal, exact: true, bound, plants: [] };
            hooks.layout(rep);
            return rep;
        }
        // step 1: column generation -> proven maximum and a first layout
        const pool: Layout[][] = C.map(() => [empty()]);
        const known: Set<string>[] = C.map(() => new Set([""]));
        let round = 0, val = 0;
        for (;;) {
            round++;
            const m = P.master(pool);
            if (!m) break;
            // upper limit (Lagrange): the master's value plus what every area could still add at these prices.
            // Without partial power that extra is 0 at the end; with it the area search is optimistic
            // (partly powered plants may still overlap there), so the extra keeps the limit honest.
            let extra = 0;
            const pi = Float64Array.from(P.M.rawRows, (row) => m.du[row]!);
            const pnfc = m.du[P.M.fcRow]!;
            let added = 0;
            C.forEach((comp, ci) => {
                const got = comp.price(H, pi, pnfc);
                if (!got) return;
                extra += Math.max(0, got[0] - m.mu[ci]!);
                const key = layout_key(got[1]);
                if (got[0] - m.mu[ci]! > 1e-7 * Math.max(1, Math.abs(got[0])) && !known[ci]!.has(key)) {
                    pool[ci]!.push(got[1]); known[ci]!.add(key); added++;
                }
            });
            val = m.val + extra;
            hooks.progress({ step: "bound", message: `Working out the proven maximum: round ${round}, ${added} better layouts (${secs()})` });
            if (!added) break;
        }
        bound = val;
        const r = P.master(pool, true);
        if (r) {
            let k = P.M.nx;
            bestLays = pool.map((list) => {
                let bi = 0, bv = -1;
                list.forEach((_, i) => { if (r.x[k + i]! > bv) { bv = r.x[k + i]!; bi = i; } });
                k += list.length;
                return list[bi]!;
            });
        }
        { const r0 = real(bestLays); bestVal = r0.v; bestReal = r0.plants; }
        if (start && start.score >= bestVal) { bestVal = start.score; startPlants = start.plants; }
        hooks.layout({ score: bestVal, exact: true, bound, plants: bestPlants() });

        // step 2: the full MIP closes the gap. With partial power: a partly powered plant must be the only plant
        // on its tiles; that rule is added for the plants a search made partly powered, then it searches again.
        for (let pass = 1; !closed(); pass++) {
            hooks.progress({ step: "search", message: "Searching for better layouts…", best: bestVal, bound });
            const seenLays: Layout[][] = [];       // layouts found during this search (for the partial power rule)
            const res = P.compact(gap,
                // no HiGHS calls inside HiGHS callbacks: report the search's own score; the page scores
                // every reported layout exactly (overlapping partly powered plants: worst case)
                (score, b, lays) => {
                    if (settings.partial) seenLays.push(lays);
                    // with partial power the search's own score can be optimistic (overlaps): report no more than
                    // the real best so far; the page shows the layout's exact score once it is scored
                    if (score > bestVal + 1e-12) hooks.layout({ score: settings.partial ? bestVal : score, exact: false, bound: Math.min(bound, b), plants: placedPlants(lays) });
                },
                (best, b) => hooks.progress({ step: "search", message: `Searching for better layouts${pass > 1 ? ` (round ${pass})` : ""} (${secs()})`, best: Math.max(best, bestVal), bound: Math.min(bound, b) }));
            if (res.lays) {
                const r = real(res.lays);
                if (r.v > bestVal) take(r.v, res.lays, r.plants);
            }
            if (Number.isFinite(res.bound)) bound = Math.min(bound, Math.max(res.bound, bestVal));
            if (!settings.partial || !res.lays) {
                if (res.optimal) bound = Math.min(bound, Math.max(bestVal, res.score, Number.isFinite(res.bound) ? res.bound : res.score));
                break;
            }
            // the best of the found layouts by their real score
            let better = false;
            for (const lays of seenLays) {
                const r = real(lays);
                if (r.v > bestVal + 1e-12) { take(r.v, lays, r.plants); better = true; }
            }
            if (better) hooks.layout({ score: bestVal, exact: true, bound, plants: bestPlants() });
            // partly powered plants next to other plants: add their rule (for every layout seen) and search again
            for (const lays of seenLays) C.forEach((comp, ci) => comp.exclusive(lays[ci]!));
            const broken = C.reduce((a, comp, ci) => a + comp.exclusive(res.lays![ci]!), 0);
            if (!broken) {
                if (res.optimal) bound = Math.min(bound, Math.max(bestVal, res.score, Number.isFinite(res.bound) ? res.bound : res.score));
                break;
            }
            hooks.progress({ step: "search", message: `${broken} partly powered plant${broken > 1 ? "s" : ""} shared tiles with other plants; searching again (${secs()})`, best: bestVal, bound });
        }
        // clean-up: partly powered plants at full power or removed, where that scores better (or the same:
        // fewer partly powered plants is simpler to build)
        if (settings.partial && !startPlants) {
            const before = bestVal;
            for (let changed = true; changed;) {
                changed = false;
                for (let ci = 0; ci < C.length && !changed; ci++) {
                    const l = bestLays[ci]!;
                    for (let k = 0; k < l.sel.length && !changed; k++) {
                        if (l.pow[k]! >= 1) continue;
                        for (const p of [1, 0]) {
                            const sel = p ? l.sel : l.sel.filter((_, q) => q !== k);
                            const pow = p ? l.pow.map((v, q) => (q === k ? 1 : v)) : l.pow.filter((_, q) => q !== k);
                            const lays = bestLays.slice();
                            lays[ci] = C[ci]!.layout(sel, pow);
                            const r = real(lays);
                            if (r.v >= bestVal - 1e-12) { take(Math.max(r.v, bestVal), lays, r.plants); changed = true; break; }
                        }
                    }
                }
            }
            if (bestVal > before + 1e-12) hooks.progress({ step: "search", message: `Tidied up the partly powered plants (${secs()})`, best: bestVal, bound });
        }
        bound = Math.max(bound, bestVal);
        const rep = { score: bestVal, exact: true, bound, plants: bestPlants() };
        hooks.layout(rep);
        return rep;
    } finally {
        P.dispose();
    }
}


// ---------------------------------------------------------------- scoring any layout (used for every report)
export interface LayoutDetails {
    score: number;
    recipes: { item: string; variant: string; rate: number }[];
    extraction: Record<string, number>;
    boosts: Record<string, { nuclear: number; coal: number; none: number; removed: number }>;
}

/** Exact score and details of a plant layout (boost areas and footprints from the plant list). */
export function evaluate_layout(H: HighsRuntime, world: WorldInput, settings: SolverSettings, plants: Plant[]): LayoutDetails {
    const dep = to_deposits(world);
    const M = new RecipeModel(settings.alt, settings.target);
    const S = speed_table(settings.tier, world.gen2);
    const boosts = boost_counts(dep, plants);
    const caps = new Float64Array(7);
    const sh = deposit_shares(dep, plants);
    for (let i = 0; i < dep.count; i++) {
        if (sh.removed[i]) continue;
        const t = dep.type[i]!;
        caps[t] += (1 - sh.nuclear[i]! - sh.coal[i]!) * S[t * 3]! + sh.coal[i]! * S[t * 3 + 1]! + sh.nuclear[i]! * S[t * 3 + 2]!;
    }
    const run_of = (kind: Plant["kind"]) => plants.reduce((a, p) => a + (p.kind === kind ? p.power ?? 1 : 0), 0);
    const ncoal = run_of("coal"), nnuc = run_of("nuclear");
    caps[4] -= COAL_FUEL_PER_MIN * ncoal;
    const cols = new Columns();
    for (let k = 0; k < M.nx; k++) cols.add(M.colRows[k]!, M.colVals[k]!, 0, Infinity, k === M.nx - 1 ? -1 : 0);
    const lo = new Array(M.nI).fill(0);
    M.rawRows.forEach((row, r) => { lo[row] = -caps[r]!; });
    lo[M.fcRow] = NUCLEAR_FUEL_PER_MIN * nnuc;
    const m = H.createModel();
    try {
        m.passModel(cols.model(H, M.nI, lo, new Array(M.nI).fill(Infinity), false));
        m.options.set({ output_flag: false });
        const run = m.run();
        const extraction: Record<string, number> = {};
        if (run.modelStatus !== H.constants.modelStatus.optimal) return { score: 0, recipes: [], extraction, boosts };
        const x = m.getSolution().colValue;
        const recipes = M.prod.map(([item, variant], k) => ({ item, variant, rate: x[k]! })).filter((r) => r.rate > 1e-9);
        // resources used = production recipes' raw inputs + coal burnt
        const use = new Float64Array(M.nI);
        for (let k = 0; k < M.nx - 1; k++) {
            const rows = M.colRows[k]!, vals = M.colVals[k]!;
            for (let q = 0; q < rows.length; q++) use[rows[q]!] -= vals[q]! * x[k]!;
        }
        RAW_ITEMS.forEach((item, r) => { extraction[item] = use[M.rawRows[r]!]! + (item === "Coal" ? COAL_FUEL_PER_MIN * ncoal : 0); });
        return { score: -m.getObjectiveValue(), recipes, extraction, boosts };
    } finally {
        m.dispose();
    }
}


/** per deposit: -1 built over, 0 none, 1 coal, 2 nuclear (nuclear wins when both cover a tile) */
export function deposit_levels(dep: Deposits, plants: Plant[]): Int8Array {
    const index = new Map<string, number>();
    for (let i = 0; i < dep.count; i++) index.set(`${dep.x[i]},${dep.y[i]}`, i);
    const level = new Int8Array(dep.count);
    const foot = new Set<number>();
    for (const p of plants) {
        const shapes = p.kind === "coal" ? PLANT_SHAPES.coal : PLANT_SHAPES.nuclear;
        const [, [aw, ah]] = shapes.find(([f]) => f[0] === p.w && f[1] === p.h)!;
        const lx = (aw - p.w) >> 1, ty = (ah - p.h) >> 1;
        const k = p.kind === "coal" ? 1 : 2;
        for (let a = p.x - lx; a < p.x - lx + aw; a++) {
            for (let b = p.y - ty; b < p.y - ty + ah; b++) {
                const d = index.get(`${a},${b}`);
                if (d === undefined) continue;
                if (a >= p.x && a < p.x + p.w && b >= p.y && b < p.y + p.h) foot.add(d);
                if (level[d]! < k) level[d] = k;
            }
        }
    }
    for (const d of foot) level[d] = -1;
    return level;
}


/**
 * Per deposit: built over, and the share of the time it is nuclear / coal boosted (see shares()).
 * Fully powered plants give 0 or 1 here, the same as deposit_levels.
 */
export function deposit_shares(dep: Deposits, plants: Plant[]) {
    const index = new Map<string, number>();
    for (let i = 0; i < dep.count; i++) index.set(`${dep.x[i]},${dep.y[i]}`, i);
    const n = dep.count;
    const fullN = new Uint8Array(n), fullC = new Uint8Array(n), maxN = new Float64Array(n), maxC = new Float64Array(n);
    const removed = new Uint8Array(n);
    for (const p of plants) {
        const shapes = p.kind === "coal" ? PLANT_SHAPES.coal : PLANT_SHAPES.nuclear;
        const [, [aw, ah]] = shapes.find(([f]) => f[0] === p.w && f[1] === p.h)!;
        const lx = (aw - p.w) >> 1, ty = (ah - p.h) >> 1;
        const pw = p.power ?? 1, nuc = p.kind === "nuclear";
        for (let a = p.x - lx; a < p.x - lx + aw; a++) {
            for (let b = p.y - ty; b < p.y - ty + ah; b++) {
                const d = index.get(`${a},${b}`);
                if (d === undefined) continue;
                if (a >= p.x && a < p.x + p.w && b >= p.y && b < p.y + p.h) removed[d] = 1;
                if (pw >= 1) (nuc ? fullN : fullC)[d] = 1;
                else if (nuc) maxN[d] = Math.max(maxN[d]!, pw);
                else maxC[d] = Math.max(maxC[d]!, pw);
            }
        }
    }
    const nuclear = new Float64Array(n), coal = new Float64Array(n);
    for (let i = 0; i < n; i++) {
        if (removed[i]) continue;
        [nuclear[i], coal[i]] = shares(fullN[i]!, maxN[i]!, fullC[i]!, maxC[i]!);
    }
    return { nuclear, coal, removed };
}


/** extractors per resource by boost (shares of the time count as fractions of an extractor) */
export function boost_counts(dep: Deposits, plants: Plant[]) {
    const sh = deposit_shares(dep, plants);
    const out: Record<string, { nuclear: number; coal: number; none: number; removed: number }> = {};
    for (const item of RAW_ITEMS) out[item] = { nuclear: 0, coal: 0, none: 0, removed: 0 };
    for (let i = 0; i < dep.count; i++) {
        const b = out[RAW_ITEMS[dep.type[i]!]!]!;
        if (sh.removed[i]) { b.removed++; continue; }
        b.nuclear += sh.nuclear[i]!;
        b.coal += sh.coal[i]!;
        b.none += 1 - sh.nuclear[i]! - sh.coal[i]!;
    }
    return out;
}
