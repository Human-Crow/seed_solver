// Exact production solver (port of builderment_solver.py): the most target items per minute a world can
// support, with real coal / nuclear power plants on real positions.
//
// The plant positions split into independent areas ("components": positions that share deposits or tiles).
// Step 1, column generation: a master LP picks the recipe mix and, per area, a mix of known layouts; a small
// MIP per area finds the layout worth most at the master's resource prices, until nothing improves the
// master. That gives the proven maximum; a MIP over the known layouts gives a first real layout.
// Step 2: the full MIP (all areas and the recipes together) closes the gap.

import { COAL_FUEL_PER_MIN, NUCLEAR_FUEL_PER_MIN, PLANT_SHAPES, RAW_ITEMS } from "./data.js";
import { find_candidates, type Cand, type Deposits } from "./candidates.js";
import { Columns, RecipeModel, speed_table, type SolverSettings } from "./model.js";
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

type Layout = { sel: number[]; g: Float64Array; nfc: number };


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

    constructor(readonly cands: Cand[], dtype: Uint8Array, S: Float64Array) {
        const dset = new Set<number>();
        for (const c of cands) { c.cover.forEach((d) => dset.add(d)); c.foot.forEach((d) => dset.add(d)); }
        this.deps = [...dset].sort((a, b) => a - b);
        const di = new Map(this.deps.map((d, i) => [d, i]));
        const nK = cands.length, nD = this.deps.length;
        this.nK = nK; this.nD = nD; this.nv = nK + 2 * nD;
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
        for (let i = 0; i < nD; i++) {
            const n = covn.get(i), c = covc.get(i), f = foot.get(i) ?? [];
            if (n) this.rows.push({ cols: [nK + i, ...n], vals: [1, ...n.map(() => -1)], hi: 0 });
            if (c) this.rows.push({ cols: [nK + nD + i, ...c], vals: [1, ...c.map(() => -1)], hi: 0 });
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
        for (const js of tiles.values()) {
            if (js.length < 2) continue;
            const key = js.join(",");
            if (seen.has(key)) continue;
            seen.add(key);
            this.rows.push({ cols: js, vals: js.map(() => 1), hi: 1 });
        }
        this.ub = new Float64Array(this.nv);
        for (let j = 0; j < nK; j++) this.ub[j] = 1;
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
            if (c.kind === 0) this.G[4 * this.nv + j] -= COAL_FUEL_PER_MIN;     // coal is raw item 4
            else this.nfc[j] = NUCLEAR_FUEL_PER_MIN;
        });
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
            for (let v = 0; v < this.nv; v++) cols.add(byVar[v]!.rows, byVar[v]!.vals, 0, this.ub[v]!, cost[v]!, v < this.nK);
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
        const sel: number[] = [];
        for (let j = 0; j < this.nK; j++) if (x[j]! > 0.5) sel.push(j);
        return [-m.getObjectiveValue(), this.layout(sel)];
    }

    layout(sel: number[]): Layout {
        const nuc = new Set<number>(), coal = new Set<number>(), rem = new Set<number>();
        let ncoal = 0;
        for (const j of sel) {
            const c = this.cands[j]!;
            if (c.kind === 1) c.cover.forEach((d) => nuc.add(d));
            else { c.cover.forEach((d) => coal.add(d)); ncoal++; }
            c.foot.forEach((d) => rem.add(d));
        }
        const g = new Float64Array(7);
        this.deps.forEach((d, i) => {
            const t = this.dt[i]!;
            if (rem.has(d)) g[t] -= this.s0[i]!;
            else if (nuc.has(d)) g[t] += this.sn[i]! - this.s0[i]!;
            else if (coal.has(d)) g[t] += this.sc[i]! - this.s0[i]!;
        });
        g[4] -= COAL_FUEL_PER_MIN * ncoal;
        return { sel, g, nfc: NUCLEAR_FUEL_PER_MIN * (sel.length - ncoal) };
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
        for (const g of groups.values()) this.comps.push(new Comp(g, dep.type, this.S));
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
                cols.add(rr, vv, 0, c.ub[v]!, 0, v < c.nK);
            }
            for (const r of c.rows) { lower.push(-Infinity); upper.push(r.hi); }
            rowBase += c.rows.length;
        }
        const layouts = (x: ArrayLike<number>) => this.comps.map((c, ci) => {
            const sel: number[] = [];
            for (let j = 0; j < c.nK; j++) if (x[offsets[ci]! + j]! > 0.5) sel.push(j);
            return c.layout(sel);
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
            for (const j of l.sel) {
                const c = this.comps[ci]!.cands[j]!;
                out.push({ kind: c.kind === 1 ? "nuclear" : "coal", x: c.x, y: c.y, w: c.w, h: c.h });
            }
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
 */
export function solve(H: HighsRuntime, world: WorldInput, settings: SolverSettings, gap: number, hooks: Hooks): LayoutReport {
    const t0 = performance.now();
    const secs = () => ((performance.now() - t0) / 1000).toFixed(0) + " s";
    const dep = to_deposits(world);
    hooks.progress({ step: "setup", message: `${dep.count} deposit tiles; finding power plant spots…` });
    const cands = settings.boost && dep.count ? find_candidates(dep, world.water) : [];
    const P = new Problem(H, dep, cands, settings, world.gen2);
    try {
        const C = P.comps;
        hooks.progress({ step: "setup", message: `${cands.length} possible power plant spots in ${C.length} separate areas.` });
        const empty = (): Layout => ({ sel: [], g: new Float64Array(7), nfc: 0 });
        let bestLays: Layout[] = C.map(empty);
        let bestVal = -1, bound = 0;
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
            val = m.val;
            const pi = Float64Array.from(P.M.rawRows, (row) => m.du[row]!);
            const pnfc = m.du[P.M.fcRow]!;
            let added = 0;
            C.forEach((comp, ci) => {
                const got = comp.price(H, pi, pnfc);
                if (!got) return;
                const key = got[1].sel.join(",");
                if (got[0] - m.mu[ci]! > 1e-7 * Math.max(1, Math.abs(got[0])) && !known[ci]!.has(key)) {
                    pool[ci]!.push(got[1]); known[ci]!.add(key); added++;
                }
            });
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
        bestVal = P.evaluate(bestLays);
        hooks.layout({ score: bestVal, exact: true, bound, plants: P.plants(bestLays) });

        // step 2: the full MIP closes the gap
        if (!closed()) {
            hooks.progress({ step: "search", message: "Searching for better layouts…", best: bestVal, bound });
            const res = P.compact(gap,
                (score, b, lays) => {
                    if (score > bestVal + 1e-12) hooks.layout({ score, exact: false, bound: Math.min(bound, b), plants: P.plants(lays) });
                },
                (best, b) => hooks.progress({ step: "search", message: `Searching for better layouts (${secs()})`, best: Math.max(best, bestVal), bound: Math.min(bound, b) }));
            if (res.lays) {
                const v = P.evaluate(res.lays);
                if (v > bestVal) { bestVal = v; bestLays = res.lays; }
            }
            if (res.optimal) bound = Math.min(bound, Math.max(bestVal, res.score, Number.isFinite(res.bound) ? res.bound : res.score));
            else if (Number.isFinite(res.bound)) bound = Math.min(bound, res.bound);
        }
        bound = Math.max(bound, bestVal);
        const rep = { score: bestVal, exact: true, bound, plants: P.plants(bestLays) };
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
    const level = deposit_levels(dep, plants);
    for (let i = 0; i < dep.count; i++) if (level[i]! >= 0) caps[dep.type[i]!] += S[dep.type[i]! * 3 + level[i]!]!;
    const ncoal = plants.filter((p) => p.kind === "coal").length;
    caps[4] -= COAL_FUEL_PER_MIN * ncoal;
    const cols = new Columns();
    for (let k = 0; k < M.nx; k++) cols.add(M.colRows[k]!, M.colVals[k]!, 0, Infinity, k === M.nx - 1 ? -1 : 0);
    const lo = new Array(M.nI).fill(0);
    M.rawRows.forEach((row, r) => { lo[row] = -caps[r]!; });
    lo[M.fcRow] = NUCLEAR_FUEL_PER_MIN * (plants.length - ncoal);
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


export function boost_counts(dep: Deposits, plants: Plant[]) {
    const level = deposit_levels(dep, plants);
    const out: Record<string, { nuclear: number; coal: number; none: number; removed: number }> = {};
    for (const item of RAW_ITEMS) out[item] = { nuclear: 0, coal: 0, none: 0, removed: 0 };
    for (let i = 0; i < dep.count; i++) {
        const b = out[RAW_ITEMS[dep.type[i]!]!]!;
        const l = level[i]!;
        if (l < 0) b.removed++; else if (l === 2) b.nuclear++; else if (l === 1) b.coal++; else b.none++;
    }
    return out;
}
