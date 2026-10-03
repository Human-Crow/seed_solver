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
import { Positions, footprint, placeable, realize, type Placed } from "./realize.js";
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
// src: the positions `sel` points into, when not the area's own (layouts listed on every position)
type Layout = { sel: number[]; pow: number[]; g: Float64Array; nfc: number; src?: Cand[] };

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

/** most small searches one area may use to list its layouts (Comp.options) */
const OPTION_RUNS = 400;
/** longest a host area's exact search with partly powered plants may run (then its proven upper limit is used) */
const HOST_SECONDS = 15;
/** most positions reaching several raw items an area may have for Comp.mixedOptions (2^n bridge choices) */
const MAX_BRIDGES = 6;

/** see Comp.mixedOptions */
interface MixedOptions {
    subsets: { B: number[]; parts: { t: number; opts: { sel: number[]; n: number; c: number; gain: number }[] }[] }[];
}

const layout_key = (l: Layout) => l.sel.map((j, k) => `${j}:${l.pow[k]!.toFixed(6)}`).join(",");


// ---------------------------------------------------------------- one area of plant positions
export class Comp {
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
    private listModel: HighsModel | null = null;

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

    private exclusiveAll = false;

    /**
     * If a layout has a partly powered plant in this area, every position of the area gets the rule
     * "only partly powered when no other plant reaches its tiles" (one row per deposit, see below), so
     * the next search cannot just move the partial power to a neighbour. Returns how many plants broke it.
     */
    exclusive(l: Layout): number {
        // how many built plants reach each deposit
        const reach = new Map<number, number>();
        for (const j of l.sel) for (const d of this.cands[j]!.cover) reach.set(d, (reach.get(d) ?? 0) + 1);
        let broken = 0, partial = false;
        l.sel.forEach((j, k) => {
            if (l.pow[k]! >= 1) return;
            partial = true;
            if ([...this.cands[j]!.cover].some((d) => reach.get(d)! > 1)) broken++;
        });
        if (partial && !this.exclusiveAll) {
            this.exclusiveAll = true;
            // one row per deposit (not per pair of positions: that is millions of rows on big worlds):
            // built plants reaching it + (M - 1) * partly powered ones reaching it <= M, M = positions reaching it.
            // A partly powered plant there leaves room for itself only; without one the row allows everything.
            const by = new Map<number, number[]>();
            this.cands.forEach((c, k) => c.cover.forEach((d) => { let l = by.get(d); if (!l) by.set(d, (l = [])); l.push(k); }));
            for (const ks of by.values()) {
                const M = ks.length;
                if (M < 2) continue;
                // y_j + (M - 1) (y_j - f_j): coefficient M on y_j, -(M - 1) on f_j
                this.rows.push({ cols: [...ks, ...ks.map((j) => this.fullVar(j))], vals: [...ks.map(() => M), ...ks.map(() => -(M - 1))], hi: M });
            }
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
     * The best layout for raw item t with at most maxN nuclear and maxC coal plants chosen from `allowed`, the
     * plants in `fixed` always built (not counted): [item gain without coal burnt, chosen plants (not `fixed`)].
     * One model per area, reused: the plant counts are two whole-number columns whose bounds are the limits.
     */
    private bestWith(H: HighsRuntime, t: number, allowed: number[], fixed: number[], budget: { runs: number }):
            (maxN: number, maxC: number) => [number, number[]] | null {
        const nv = this.nv;
        const isAllowed = new Uint8Array(this.nK), isFixed = new Uint8Array(this.nK);
        allowed.forEach((j) => (isAllowed[j] = 1));
        fixed.forEach((j) => (isFixed[j] = 1));
        // objective: item t's gain without coal burnt (that is fixed by the number of coal plants)
        const cost = new Float64Array(nv);
        for (let v = 0; v < nv; v++) cost[v] = -this.G[t * nv + v]!;
        if (t === 4) this.cands.forEach((c, j) => { if (c.kind === 0) cost[j] = cost[j]! - COAL_FUEL_PER_MIN; });
        const lo = new Float64Array(nv), hi = Float64Array.from(this.ub);
        for (let j = 0; j < this.nK; j++) {
            if (isFixed[j]) { lo[j] = 1; hi[j] = 1; } else if (!isAllowed[j]) hi[j] = 0;
        }
        if (!this.listModel) {
            const byVar = this.colsByVar();
            const nRows = this.rows.length;
            const cols = new Columns();
            for (let v = 0; v < nv; v++) {
                const rows = [...byVar[v]!.rows], vals = [...byVar[v]!.vals];
                if (v < this.nK) { rows.push(this.cands[v]!.kind === 1 ? nRows : nRows + 1); vals.push(1); }
                cols.add(rows, vals, 0, this.ub[v]!, 0, this.isInt(v));
            }
            cols.add([nRows], [-1], 0, Infinity, 0, true);
            cols.add([nRows + 1], [-1], 0, Infinity, 0, true);
            const m = H.createModel();
            m.passModel(cols.model(H, nRows + 2, [...this.rows.map(() => -Infinity), 0, 0], [...this.rows.map((r) => r.hi), 0, 0], true));
            m.options.set({ output_flag: false, mip_rel_gap: 1e-12, mip_abs_gap: 1e-12, presolve: "off" });
            this.listModel = m;
        }
        const m = this.listModel;
        const fixedN = fixed.filter((j) => this.cands[j]!.kind === 1).length, fixedC = fixed.length - fixedN;
        return (maxN, maxC) => {
            if (--budget.runs < 0) return null;
            m.changeColsBounds({ kind: "range", from: 0, to: nv - 1 }, lo, hi);
            m.changeColsCost({ kind: "range", from: 0, to: nv - 1 }, cost);
            m.changeColsBounds({ kind: "range", from: nv, to: nv + 1 }, [0, 0], [maxN + fixedN, maxC + fixedC]);
            if (m.run().modelStatus !== H.constants.modelStatus.optimal) return null;
            const x = m.getSolution().colValue;
            return [-m.getObjectiveValue(), pick(this.nK, x, 0, (j) => j, false)[0].filter((j) => !isFixed[j])];
        };
    }

    /**
     * The layouts worth considering for one raw item t: plants chosen from `allowed`, the plants in `fixed`
     * always built. For every useful number of nuclear (n) and coal (m) plants (not counting `fixed`) the
     * most of item t (small exact searches); only those no other one beats are kept. Plants on other items'
     * deposits are not counted here (the caller makes sure they cannot matter). null: too many searches.
     */
    private listFor(H: HighsRuntime, t: number, allowed: number[], fixed: number[], budget: { runs: number }):
            { sel: number[]; n: number; c: number; gain: number }[] | null {
        const nuc = allowed.filter((j) => this.cands[j]!.kind === 1).length, coal = allowed.length - nuc;
        const best = this.bestWith(H, t, allowed, fixed, budget);
        const eps = 1e-9;
        const found = new Map<string, number[]>([["", []]]);
        const add = (sel: number[]) => found.set(sel.join(","), sel);
        // more nuclear plants help only while the best with unlimited coal plants still grows
        let prevAll = -Infinity;
        for (let n = 0; n <= nuc; n++) {
            const all = best(n, coal);
            if (!all) return null;
            if (all[0] <= prevAll + eps * Math.max(1, Math.abs(prevAll))) break;
            prevAll = all[0];
            add(all[1]);
            // more coal plants help only until the unlimited-coal best is reached
            for (let k = 0; k < coal; k++) {
                const r = best(n, k);
                if (!r) return null;
                add(r[1]);
                if (r[0] >= all[0] - eps * Math.max(1, Math.abs(all[0]))) break;
            }
        }
        const fixedC = fixed.filter((j) => this.cands[j]!.kind === 0).length;
        const list = [...found.values()].map((sel) => {
            const n = sel.filter((j) => this.cands[j]!.kind === 1).length, c = sel.length - n;
            const g = this.layout([...fixed, ...sel]).g[t]! + (t === 4 ? COAL_FUEL_PER_MIN * (c + fixedC) : 0);
            return { sel, n, c, gain: g };
        });
        // keep the ones no other one beats (at least as much of the item with no more plants of either kind)
        return list.filter((a) => !list.some((b) => b !== a && b.n <= a.n && b.c <= a.c && b.gain >= a.gain - 1e-12
            && (b.n < a.n || b.c < a.c || b.gain > a.gain + 1e-12)));
    }

    /**
     * For a one-item area: the best layout with at most n nuclear and c coal plants (null: none found). Used on
     * an area built from every real position with the no-overlap rule, to correct one listed layout.
     */
    bestLayout(H: HighsRuntime, n: number, c: number): Layout | null {
        const t = this.dt[0]!;
        const r = this.bestWith(H, t, this.cands.map((_, j) => j), [], { runs: 1 })(n, c);
        return r && { ...this.layout(r[1]), src: this.cands };
    }

    /**
     * Every layout of this area worth considering, when all its deposits are of one raw item and plants are
     * fully powered: then a layout only matters through how much it adds of that item and how many coal and
     * nuclear plants it uses (see listFor). The full search then picks one of these per area, which is much
     * easier than choosing every plant itself. null: deposits of several items, or too many choices (the area
     * is then searched plant by plant).
     */
    options(H: HighsRuntime): Layout[] | null {
        if (this.partial || !this.nD) return null;
        const t = this.dt[0]!;
        if (this.dt.some((x) => x !== t)) return null;
        const list = this.listFor(H, t, this.cands.map((_, j) => j), [], { runs: OPTION_RUNS });
        return list && list.map((o) => ({ ...this.layout(o.sel), src: this.cands }));
    }

    /**
     * An area with deposits of several raw items, where only a few positions ("bridges") reach deposits of more
     * than one item: for every choice of bridges the other positions split into parts of one item each, and
     * each part's layouts are listed like a one-item area (listFor) with those bridges built. The search then
     * picks one bridge choice and one layout per part. null: too many bridges or searches.
     */
    mixedOptions(H: HighsRuntime, dtype: Uint8Array): MixedOptions | null {
        if (this.partial || !this.nD) return null;
        const itemsOf = (c: Cand) => new Set([...c.cover, ...c.foot].map((d) => dtype[d]!));
        const bridges: number[] = [], part = new Map<number, number[]>();
        this.cands.forEach((c, j) => {
            const it = itemsOf(c);
            if (it.size > 1) bridges.push(j);
            else if (it.size === 1) { const t = [...it][0]!; let l = part.get(t); if (!l) part.set(t, (l = [])); l.push(j); }
        });
        if (bridges.length > MAX_BRIDGES) return null;
        const items = [...new Set(this.dt)];
        const budget = { runs: OPTION_RUNS * items.length * 2 };
        const subsets: MixedOptions["subsets"] = [];
        for (let mask = 0; mask < 1 << bridges.length; mask++) {
            const B = bridges.filter((_, i) => mask & (1 << i));
            const parts: MixedOptions["subsets"][number]["parts"] = [];
            for (const t of items) {
                const list = this.listFor(H, t, part.get(t) ?? [], B, budget);
                if (!list) return null;
                parts.push({ t, opts: list });
            }
            subsets.push({ B, parts });
        }
        return { subsets };
    }

    /**
     * Exact value for one raw item t (an area made of all one-item areas of that item, plants fully powered in
     * this Comp): the most of item t with at most N fully powered nuclear and C coal plants, plus at most one
     * nuclear plant running a share p of the time and one coal plant running q (scored like the game: on a
     * shared tile a fully powered plant wins, partly powered ones count the worst case, see shares()).
     * `others`: the item's other areas as their table (exactly one row); `seconds`: time limit (then the best
     * found and HiGHS's limit); `extra`: rows "at most hi of these plants"; `noPartial`: plants that may not be
     * the partly powered one. Returns the item gain (coal burnt not counted) and the plants with their power.
     */
    partialBest(H: HighsRuntime, t: number, N: number, C: number, p: number, q: number,
                others: { N: number; C: number; gain: number }[] | null = null, seconds = Infinity, extra: { js: number[]; hi: number }[] = [],
                noPartial: number[] = []):
            { value: number; bound: number; sel: number[]; pow: number[]; part: boolean[]; other: number } | null {
        const { nK, nD } = this;
        const di = new Map(this.deps.map((d, i) => [d, i]));
        const covN: number[][] = Array.from({ length: nD }, () => []), covC: number[][] = Array.from({ length: nD }, () => []);
        const foot: number[][] = Array.from({ length: nD }, () => []);
        this.cands.forEach((c, j) => {
            for (const d of c.cover) (c.kind === 1 ? covN : covC)[di.get(d)!]!.push(j);
            for (const d of c.foot) foot[di.get(d)!]!.push(j);
        });
        // columns: y[nK] built at full power, bn[nD], bc[nD] boosted shares, z[nK] built partly powered
        const Y = 0, BN = nK, BC = nK + nD, Z = nK + 2 * nD, nv = nK * 2 + 2 * nD;
        const pw = (j: number) => (this.cands[j]!.kind === 1 ? p : q);
        const rows: { cols: number[]; vals: number[]; hi: number }[] = [];
        const m = Math.min(p, q);
        for (let i = 0; i < nD; i++) {
            const n = covN[i]!, c = covC[i]!;
            // nuclear share <= full nuclear plants + p * partly powered nuclear plant (and <= 1 by its bound)
            if (n.length) rows.push({ cols: [BN + i, ...n.map((j) => Y + j), ...n.map((j) => Z + j)], vals: [1, ...n.map(() => -1), ...n.map(() => -p)], hi: 0 });
            if (c.length) rows.push({ cols: [BC + i, ...c.map((j) => Y + j), ...c.map((j) => Z + j)], vals: [1, ...c.map(() => -1), ...c.map(() => -q)], hi: 0 });
            // both partly powered on the tile and no full plant: together at most max(p, q) (worst case)
            if (n.length && c.length) {
                const all = [...n, ...c];
                rows.push({ cols: [BN + i, BC + i, ...all.map((j) => Y + j), ...n.map((j) => Z + j), ...c.map((j) => Z + j)],
                    vals: [1, 1, ...all.map(() => -1), ...n.map(() => -(p - m)), ...c.map(() => -(q - m))], hi: m });
            }
            // a built-over tile is not boosted
            const f = foot[i]!;
            rows.push({ cols: [BN + i, BC + i, ...f.map((j) => Y + j), ...f.map((j) => Z + j)], vals: [1, 1, ...f.map(() => 1), ...f.map(() => 1)], hi: 1 });
        }
        const nuc = this.cands.map((_, j) => j).filter((j) => this.cands[j]!.kind === 1), coal = this.cands.map((_, j) => j).filter((j) => this.cands[j]!.kind === 0);
        // the other areas of the item: exactly one row of their table (columns after the plants', see below)
        const O = nv, nO = others ? others.length : 0;
        rows.push({ cols: [...nuc.map((j) => Y + j), ...Array.from({ length: nO }, (_, r) => O + r)], vals: [...nuc.map(() => 1), ...(others ?? []).map((o) => o.N)], hi: N });
        rows.push({ cols: [...coal.map((j) => Y + j), ...Array.from({ length: nO }, (_, r) => O + r)], vals: [...coal.map(() => 1), ...(others ?? []).map((o) => o.C)], hi: C });
        const oneRow = rows.length;
        if (nO) rows.push({ cols: Array.from({ length: nO }, (_, r) => O + r), vals: (others ?? []).map(() => 1), hi: 1 });
        if (nuc.length) rows.push({ cols: nuc.map((j) => Z + j), vals: nuc.map(() => 1), hi: 1 });
        if (coal.length) rows.push({ cols: coal.map((j) => Z + j), vals: coal.map(() => 1), hi: 1 });
        for (let j = 0; j < nK; j++) rows.push({ cols: [Y + j, Z + j], vals: [1, 1], hi: 1 });
        // extra rules: of these spots at most hi (spots that cannot all fit on real positions, see partial_search)
        for (const { js, hi } of extra) rows.push({ cols: [...js.map((j) => Y + j), ...js.map((j) => Z + j)], vals: [...js.map(() => 1), ...js.map(() => 1)], hi });
        // objective: item t gain (coal burnt is counted by the caller)
        const cost = new Float64Array(nv + nO), ub = new Float64Array(nv + nO).fill(1);
        (others ?? []).forEach((o, r) => { cost[O + r] = -o.gain; });
        for (let i = 0; i < nD; i++) {
            if (this.dt[i] !== t) continue;
            cost[BN + i] = -(this.sn[i]! - this.s0[i]!);
            cost[BC + i] = -(this.sc[i]! - this.s0[i]!);
            if (!covN[i]!.length) ub[BN + i] = 0;
            if (!covC[i]!.length) ub[BC + i] = 0;
            for (const j of foot[i]!) { cost[Y + j] = cost[Y + j]! + this.s0[i]!; cost[Z + j] = cost[Z + j]! + this.s0[i]!; }
        }
        for (let j = 0; j < nK; j++) if (pw(j) <= 0) ub[Z + j] = 0;
        for (const j of noPartial) ub[Z + j] = 0;
        const byVar = Array.from({ length: nv + nO }, () => ({ r: [] as number[], v: [] as number[] }));
        rows.forEach((r, k) => r.cols.forEach((c, x) => { byVar[c]!.r.push(k); byVar[c]!.v.push(r.vals[x]!); }));
        const cols = new Columns();
        for (let v = 0; v < nv + nO; v++) {
            const o = byVar[v]!.r.map((_, x) => x).sort((a, b) => byVar[v]!.r[a]! - byVar[v]!.r[b]!);
            cols.add(o.map((x) => byVar[v]!.r[x]!), o.map((x) => byVar[v]!.v[x]!), 0, ub[v]!, cost[v]!, v < BN || v >= Z);
        }
        const lowers = rows.map(() => -Infinity);
        if (nO) lowers[oneRow] = 1;           // exactly one row of the other areas' table
        const model = H.createModel();
        try {
            model.passModel(cols.model(H, rows.length, lowers, rows.map((r) => r.hi), true));
            model.options.set({ output_flag: false, mip_rel_gap: 1e-12, mip_abs_gap: 1e-12, presolve: "off", ...(Number.isFinite(seconds) ? { time_limit: seconds } : {}) });
            const status = model.run().modelStatus;
            const optimal = status === H.constants.modelStatus.optimal;
            // stopped by the time limit: the best found so far and HiGHS's proven upper limit
            const bound = optimal ? -model.getObjectiveValue() : -model.info.get("mip_dual_bound");
            if (!optimal && !(Number.isFinite(bound) && Number.isFinite(model.getObjectiveValue()))) return null;
            const x = model.getSolution().colValue;
            const sel: number[] = [], pow: number[] = [], part: boolean[] = [];
            for (let j = 0; j < nK; j++) {
                if (x[Y + j]! > 0.5) { sel.push(j); pow.push(1); part.push(false); }
                else if (x[Z + j]! > 0.5) { sel.push(j); pow.push(Math.min(1, pw(j))); part.push(true); }
            }
            let other = -1;
            for (let r = 0; r < nO; r++) if (x[O + r]! > 0.5) other = r;
            return { value: -model.getObjectiveValue(), bound: Math.max(bound, -model.getObjectiveValue()), sel, pow, part, other };
        } finally {
            model.dispose();
        }
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
        this.listModel?.dispose();
        this.listModel = null;
    }
}


// ---------------------------------------------------------------- areas of one raw item combined
/**
 * All areas of one raw item together: for every number of nuclear (N) and coal (C) plants, the most of the item
 * those plants can add when spread over the areas in the best way (exact, by going through the areas one by one).
 * Only rows that beat every row with no more plants are kept. choose(row) gives each area's layout (option index).
 */
/** what the full-power solve hands to the partial power one: each area's listed layouts */
interface Shared {
    options?: (Layout[] | null)[];
}

/** a box of a table cell for the partial power search: corners (p, q) with an upper limit or exact value */
interface PartialBox {
    N: number;
    C: number;
    verts: { p: number; q: number; val: number; exact: boolean }[];
}

/** a raw item's table and its cell boxes (key "N,C") */
interface PartialItem {
    t: number;
    cis: number[];
    table: Table;
    boxes: Map<string, PartialBox[]>;
}

/** a solution of the partial power search: per item a table row or a box point (p, q), and plain areas' layouts */
interface PartialChoice {
    per: ({ t: number; point: number } | { t: number; key: string; box: number; N: number; C: number; p: number; q: number; val: number })[];
    plainLays: Map<number, Layout>;
}

interface Table {
    points: { N: number; C: number; gain: number }[];
    /** each area's option index for row p */
    choose: (p: number) => number[];
    /** the whole grid: top[N * (cMax + 1) + C] = most of the item with at most N nuclear and C coal plants */
    nMax: number;
    cMax: number;
    top: Float64Array;
    /** each area's option index for a grid point (the best layout with at most N, C plants) */
    chooseAt: (N: number, C: number) => number[];
}

function combine(areas: { n: number; c: number; gain: number }[][]): Table {
    let nMax = 0, cMax = 0;
    let best = new Float64Array([0]);           // best[N * (cMax + 1) + C]
    const steps: { cw: number; pick: Int32Array }[] = [];
    for (const opts of areas) {
        const n2 = nMax + Math.max(...opts.map((o) => o.n)), c2 = cMax + Math.max(...opts.map((o) => o.c));
        const next = new Float64Array((n2 + 1) * (c2 + 1)).fill(-Infinity);
        const pick = new Int32Array(next.length).fill(-1);
        for (let N = 0; N <= nMax; N++) {
            for (let C = 0; C <= cMax; C++) {
                const v = best[N * (cMax + 1) + C]!;
                if (v === -Infinity) continue;
                opts.forEach((o, i) => {
                    const k = (N + o.n) * (c2 + 1) + C + o.c, w = v + o.gain;
                    if (w > next[k]!) { next[k] = w; pick[k] = i; }
                });
            }
        }
        steps.push({ cw: c2 + 1, pick });
        best = next; nMax = n2; cMax = c2;
    }
    // rows worth having: better than every row with fewer of either plant
    const cw = cMax + 1, top = new Float64Array(best.length), root = new Int32Array(best.length);
    const points: { N: number; C: number; gain: number }[] = [], at: number[] = [];
    for (let N = 0; N <= nMax; N++) {
        for (let C = 0; C <= cMax; C++) {
            const k = N * cw + C, v = best[k]!;
            const a = N ? top[k - cw]! : -Infinity, b = C ? top[k - 1]! : -Infinity;
            const prev = Math.max(a, b);
            top[k] = Math.max(v, prev);
            root[k] = v >= prev ? k : a >= b ? root[k - cw]! : root[k - 1]!;
            if (v > prev + 1e-9 * Math.max(1, Math.abs(v))) { points.push({ N, C, gain: v }); at.push(k); }
        }
    }
    const back = (k: number): number[] => {
        const out: number[] = new Array(areas.length).fill(0);
        let N = Math.floor(k / cw), C = k % cw;
        for (let a = areas.length - 1; a >= 0; a--) {
            const st = steps[a]!, i = st.pick[N * st.cw + C]!;
            out[a] = i;
            N -= areas[a]![i]!.n; C -= areas[a]![i]!.c;
        }
        return out;
    };
    return {
        points, choose: (p) => back(at[p]!), nMax, cMax, top,
        chooseAt: (N, C) => back(root[Math.min(N, nMax) * cw + Math.min(C, cMax)]!),
    };
}


/**
 * Partly powered plants searched plant by plant add up their shares on a shared tile; the game counts only the
 * largest (worst case). For a group S of plants that are partly powered together on some tile, yes/no
 * variables o_a (one per member, exactly one chosen; indexes from nv on) choose whose share counts on the tiles
 * all of S reach:  share <= p_a + (other members fully powered) + (power of plants outside S) + (1 - o_a).
 * With the right choice this holds for every real layout, so the search stays an upper limit; it only removes
 * the adding up that cannot happen. A group of one kind limits that kind's share; nuclear with coal: both.
 */
function group_rows(c: Comp, groups: number[][]): { rows: { cols: number[]; vals: number[]; hi: number }[]; n: number } {
    const rows: { cols: number[]; vals: number[]; hi: number }[] = [];
    let n = 0;
    if (!groups.length) return { rows, n };
    const di = new Map(c.deps.map((d, i) => [d, i]));
    const reach = new Map<number, number[]>();
    c.cands.forEach((q, j) => q.cover.forEach((d) => { let l = reach.get(d); if (!l) reach.set(d, (l = [])); l.push(j); }));
    for (const S of groups) {
        const o = S.map((_, k) => c.nv + n + k);
        n += S.length;
        rows.push({ cols: o, vals: o.map(() => 1), hi: 1 });
        rows.push({ cols: o, vals: o.map(() => -1), hi: -1 });
        const kinds = new Set(S.map((j) => c.cands[j]!.kind));
        const inS = new Set(S);
        let common: Set<number> = new Set(c.cands[S[0]!]!.cover);
        for (const j of S.slice(1)) { const cv = new Set(c.cands[j]!.cover); common = new Set([...common].filter((d) => cv.has(d))); }
        for (const d of common) {
            const i = di.get(d)!;
            const kind = [...kinds][0]!;
            const shareCols = kinds.size === 1 ? [kind === 1 ? c.nK + i : c.nK + c.nD + i] : [c.nK + i, c.nK + c.nD + i];
            const oth = (reach.get(d) ?? []).filter((l) => !inS.has(l) && (kinds.size > 1 || c.cands[l]!.kind === kind)).map((l) => c.powVar(l));
            S.forEach((a, k) => {
                const full = S.filter((b) => b !== a).map((b) => c.fullVar(b));
                rows.push({ cols: [...shareCols, c.powVar(a), ...full, ...oth, o[k]!],
                    vals: [...shareCols.map(() => 1), -1, ...full.map(() => -1), ...oth.map(() => -1), 1], hi: 1 });
            });
        }
    }
    return { rows, n };
}


// ---------------------------------------------------------------- the whole problem
export class Problem {
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

    /**
     * The full MIP: recipes and every area's plant choice together. Areas with a list of layouts (one raw item
     * each, see Comp.options) are combined per raw item first (combine()): the search then picks one "N nuclear
     * and C coal plants for this item" row per item instead of a layout per area.
     */
    compact(gap: number, onImproving: (score: number, bound: number, lays: Layout[]) => void,
            onLog: (best: number, bound: number) => void,
            options: (Layout[] | null)[] = [],
            mixed: (MixedOptions | null)[] = [],
            seconds = Infinity): { optimal: boolean; score: number; bound: number; lays: Layout[] | null } {
        const { M, H } = this;
        const nI = M.nI;
        const cols = new Columns();
        this.recipeColumns(cols);
        const lower = this.itemLower(), upper: number[] = new Array(nI).fill(Infinity);
        // areas with listed layouts, by raw item
        const byItem = new Map<number, number[]>();
        this.comps.forEach((c, ci) => { if (options[ci]) { const t = c.dt[0]!; let l = byItem.get(t); if (!l) byItem.set(t, (l = [])); l.push(ci); } });
        const tables = [...byItem].map(([t, cis]) => ({ t, cis, table: combine(cis.map((ci) => options[ci]!.map((lay) => {
            let n = 0;
            for (const j of lay.sel) if ((lay.src ?? this.comps[ci]!.cands)[j]!.kind === 1) n++;
            const c = lay.sel.length - n;
            return { n, c, gain: lay.g[t]! + (t === 4 ? COAL_FUEL_PER_MIN * c : 0) };
        }))) }));
        // rows: per plain area its own rows; per raw item "exactly one row of its table"; the plant totals
        let rowBase = nI;
        const isPlain = (ci: number) => !options[ci] && !mixed[ci];
        const mixedRows = mixed.reduce((a, mo) => a + (mo ? 1 + mo.subsets.reduce((b, sb) => b + sb.parts.length, 0) : 0), 0);
        const plainRows = this.comps.reduce((a, c, ci) => a + (isPlain(ci) ? c.rows.length : 0), 0) + mixedRows;
        const nPlain = this.comps.filter((_, ci) => isPlain(ci)).length;
        const rowN = nI + plainRows + tables.length, rowC = rowN + 1;
        // per plain area: its own nuclear / coal totals (rows after the overall totals)
        let plainK = 0;
        const areaRow = this.comps.map((_, ci) => (isPlain(ci) ? rowC + 1 + 2 * plainK++ : -1));
        const offsets: number[] = [];
        // a column: raw item gains, coal plants (coal burnt), nuclear plants (fuel cells), totals, other rows
        const planCol = (gains: [number, number][], n: number, c: number, extra: [number, number][]) => {
            const entries = new Map<number, number>();
            const add = (row: number, v: number) => { if (v) entries.set(row, (entries.get(row) ?? 0) + v); };
            for (const [t, v] of gains) add(M.rawRows[t]!, v);
            add(M.rawRows[4]!, -COAL_FUEL_PER_MIN * c);
            add(M.fcRow, -NUCLEAR_FUEL_PER_MIN * n);
            add(rowN, n); add(rowC, c);
            for (const [r, v] of extra) add(r, v);
            const rows = [...entries.keys()].sort((a, b) => a - b);
            cols.add(rows, rows.map((r) => entries.get(r)!), 0, 1, 0, true);
        };
        this.comps.forEach((c, ci) => {
            offsets.push(cols.count);
            if (options[ci]) return;
            const mo = mixed[ci];
            if (mo) {
                // one bridge choice (z_B); per part one layout, only with that choice
                const choice = rowBase++;
                lower.push(1); upper.push(1);
                for (const sb of mo.subsets) {
                    const nB = sb.B.filter((j) => c.cands[j]!.kind === 1).length;
                    const links = sb.parts.map(() => { lower.push(0); upper.push(0); return rowBase++; });
                    planCol([], nB, sb.B.length - nB, [[choice, 1], ...links.map((r): [number, number] => [r, -1])]);
                    sb.parts.forEach((pt, k) => { for (const o of pt.opts) planCol([[pt.t, o.gain]], o.n, o.c, [[links[k]!, 1]]); });
                }
                return;
            }
            const byVar = c.colsByVar();
            for (let v = 0; v < c.nv; v++) {
                const rows: number[] = [], vals: number[] = [];
                M.rawRows.forEach((row, r) => { const g = c.G[r * c.nv + v]!; if (g !== 0) { rows.push(row); vals.push(g); } });
                if (c.nfc[v]) { rows.push(M.fcRow); vals.push(-c.nfc[v]!); }
                const order = rows.map((_, i) => i).sort((a, b) => rows[a]! - rows[b]!);
                const rr = [...order.map((i) => rows[i]!), ...byVar[v]!.rows.map((q) => q + rowBase)];
                const vv = [...order.map((i) => vals[i]!), ...byVar[v]!.vals];
                if (v < c.nK) {
                    const nuc = c.cands[v]!.kind === 1;
                    rr.push(nuc ? rowN : rowC, areaRow[ci]! + (nuc ? 0 : 1)); vv.push(1, 1);
                }
                cols.add(rr, vv, 0, c.ub[v]!, 0, c.isInt(v));
            }
            for (const r of c.rows) { lower.push(-Infinity); upper.push(r.hi); }
            rowBase += c.rows.length;
        });
        const tOffsets: number[] = [];
        for (const { t, table } of tables) {
            tOffsets.push(cols.count);
            for (const pt of table.points) {
                // the item's gain; coal burnt by the coal plants; fuel cells of the nuclear plants; the totals
                const entries = new Map<number, number>();
                const add = (row: number, v: number) => { if (v) entries.set(row, (entries.get(row) ?? 0) + v); };
                add(M.rawRows[t]!, pt.gain - (t === 4 ? COAL_FUEL_PER_MIN * pt.C : 0));
                if (t !== 4) add(M.rawRows[4]!, -COAL_FUEL_PER_MIN * pt.C);
                add(M.fcRow, -NUCLEAR_FUEL_PER_MIN * pt.N);
                add(rowBase, 1);
                add(rowN, pt.N);
                add(rowC, pt.C);
                const rows = [...entries.keys()].sort((a, b) => a - b);
                cols.add(rows, rows.map((r) => entries.get(r)!), 0, 1, 0, true);
            }
            lower.push(1); upper.push(1);
            rowBase += 1;
        }
        cols.add([rowN], [-1], 0, Infinity, 0, true);
        cols.add([rowC], [-1], 0, Infinity, 0, true);
        lower.push(0, 0); upper.push(0, 0);
        rowBase += 2;
        for (let k = 0; k < nPlain; k++) {
            cols.add([rowBase], [-1], 0, Infinity, 0, true);
            cols.add([rowBase + 1], [-1], 0, Infinity, 0, true);
            lower.push(0, 0); upper.push(0, 0);
            rowBase += 2;
        }
        const layouts = (x: ArrayLike<number>) => {
            const out: Layout[] = this.comps.map((c, ci) => {
                if (options[ci]) return options[ci]![0]!;
                const mo = mixed[ci];
                if (mo) {
                    let k = offsets[ci]!, bestZ = -1, sel: number[] = [];
                    for (const sb of mo.subsets) {
                        const z = x[k++]!;
                        const chosen: number[] = [...sb.B];
                        for (const pt of sb.parts) {
                            let bi = 0;
                            pt.opts.forEach((_, i) => { if (x[k + i]! > x[k + bi]!) bi = i; });
                            chosen.push(...pt.opts[bi]!.sel);
                            k += pt.opts.length;
                        }
                        if (z > bestZ) { bestZ = z; sel = chosen; }
                    }
                    return c.layout(sel);
                }
                const [sel, pow] = pick(c.nK, x, offsets[ci]!, (j) => c.powVar(j), c.partial);
                return c.layout(sel, pow);
            });
            tables.forEach(({ cis, table }, k) => {
                let bi = 0;
                table.points.forEach((_, i) => { if (x[tOffsets[k]! + i]! > x[tOffsets[k]! + bi]!) bi = i; });
                table.choose(bi).forEach((o, a) => { out[cis[a]!] = options[cis[a]!]![o]!; });
            });
            return out;
        };
        const m = H.createModel();
        try {
            m.passModel(cols.model(H, rowBase, lower, upper, true));
            // the log must be on for the progress callback; it is not printed
            m.options.set({ output_flag: true, log_to_console: false, mip_rel_gap: gap, mip_min_logging_interval: 1, ...(Number.isFinite(seconds) ? { time_limit: seconds } : {}) });
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

    /**
     * The search with partly powered plants (see partial_search() in solve_core). Per raw item with a table:
     * exactly one of its full-power rows, or one "cell" box: N nuclear and C coal plants plus a nuclear plant
     * at power p and a coal plant at power q, (p, q) inside the box, with value at most the box corners'
     * values mixed with the same weights (an upper limit: the best value is convex in p and q). Areas without
     * a table (several raw items) are searched plant by plant with partial power (optimistic on shared tiles).
     */
    partialMip(gap: number, items: PartialItem[], plain: number[], groups: Map<number, number[][]>,
               onImproving: (x: Float64Array, score: number) => void, onLog: (best: number, bound: number) => void,
               cutoff = -Infinity):
            { optimal: boolean; score: number; bound: number; x: Float64Array | null; decode: (x: ArrayLike<number>) => PartialChoice } {
        const { M, H } = this;
        const nI = M.nI;
        const cols = new Columns();
        this.recipeColumns(cols);
        const lower = this.itemLower(), upper: number[] = new Array(nI).fill(Infinity);
        // per raw item and fuel: at most one partly powered plant that only reaches that item (in a table's box or
        // in a plain area). Moving power between two such plants never lowers the best (convex), so this holds.
        const single = (t: number, kind: number) => nI + t * 2 + kind;
        for (let k = 0; k < 14; k++) { lower.push(-Infinity); upper.push(1); }
        let rowBase = nI + 14;
        const offsets = new Map<number, number>();
        for (const ci of plain) {
            const c = this.comps[ci]!;
            offsets.set(ci, cols.count);
            // plants reaching one raw item only: partly powered = built (y) and not fully powered (f)
            const only = c.cands.map((q) => { const its = new Set([...q.cover, ...q.foot].map((d) => this.dep.type[d]!)); return its.size === 1 ? [...its][0]! : -1; });
            // the area's rows, and per group of overlapping partly powered plants its rows (group_rows)
            const extra = group_rows(c, groups.get(ci) ?? []);
            const all = [...c.rows, ...extra.rows];
            const byVar = Array.from({ length: c.nv + extra.n }, () => ({ rows: [] as number[], vals: [] as number[] }));
            all.forEach((r, n) => r.cols.forEach((v, k) => { byVar[v]!.rows.push(n); byVar[v]!.vals.push(r.vals[k]!); }));
            for (let v = 0; v < c.nv + extra.n; v++) {
                const rows: number[] = [], vals: number[] = [];
                if (v < c.nv) {
                    M.rawRows.forEach((row, r) => { const g = c.G[r * c.nv + v]!; if (g !== 0) { rows.push(row); vals.push(g); } });
                    if (c.nfc[v]) { rows.push(M.fcRow); vals.push(-c.nfc[v]!); }
                    if (v < c.nK && only[v]! >= 0) { rows.push(single(only[v]!, c.cands[v]!.kind)); vals.push(1); }
                    const j = v - (c.nK + 2 * c.nD + c.nK);
                    if (c.partial && j >= 0 && j < c.nK && only[j]! >= 0) { rows.push(single(only[j]!, c.cands[j]!.kind)); vals.push(-1); }
                }
                const order = rows.map((_, i) => i).sort((a, b) => rows[a]! - rows[b]!);
                cols.add([...order.map((i) => rows[i]!), ...byVar[v]!.rows.map((q) => q + rowBase)], [...order.map((i) => vals[i]!), ...byVar[v]!.vals],
                    0, v < c.nv ? c.ub[v]! : 1, 0, v < c.nv ? c.isInt(v) : true);
            }
            for (const r of all) { lower.push(-Infinity); upper.push(r.hi); }
            rowBase += all.length;
        }
        const col = (entries: [number, number][], ub: number, integer: boolean) => {
            const map = new Map<number, number>();
            for (const [r, v] of entries) if (v) map.set(r, (map.get(r) ?? 0) + v);
            const rows = [...map.keys()].sort((a, b) => a - b);
            return cols.add(rows, rows.map((r) => map.get(r)!), 0, ub, 0, integer);
        };
        const fuel = (t: number, gain: number, n: number, c: number): [number, number][] =>
            [[M.rawRows[t]!, gain], [M.rawRows[4]!, -COAL_FUEL_PER_MIN * c], [M.fcRow, -NUCLEAR_FUEL_PER_MIN * n]];
        const layout: { item: number; full: number[]; boxes: { key: string; b: number; z: number; w: number[] }[] }[] = [];
        for (const [k, it] of items.entries()) {
            const one = rowBase++;
            lower.push(1); upper.push(1);
            const full = it.table.points.map((pt) => col([...fuel(it.t, pt.gain, pt.N, pt.C), [one, 1]], 1, true));
            const boxes: { key: string; b: number; z: number; w: number[] }[] = [];
            for (const [key, list] of it.boxes) {
                list.forEach((box, b) => {
                    const link = rowBase++;
                    lower.push(0); upper.push(0);
                    const z = col([...fuel(it.t, 0, box.N, box.C), [one, 1], [link, -1]], 1, true);
                    const w = box.verts.map((v) => col([...fuel(it.t, v.val, v.p, v.q), [link, 1], [single(it.t, 1), v.p], [single(it.t, 0), v.q]], 1, false));
                    boxes.push({ key, b, z, w });
                });
            }
            layout.push({ item: k, full, boxes });
        }
        const decode = (x: ArrayLike<number>): PartialChoice => {
            const per = layout.map(({ item, full, boxes }) => {
                const it = items[item]!;
                const f = full.findIndex((c) => x[c]! > 0.5);
                if (f >= 0) return { t: it.t, point: f } as const;
                for (const bx of boxes) {
                    if (x[bx.z]! <= 0.5) continue;
                    const box = it.boxes.get(bx.key)![bx.b]!;
                    let p = 0, q = 0, val = 0, sw = 0;
                    bx.w.forEach((c, i) => { const w = Math.max(0, x[c]!); sw += w; p += w * box.verts[i]!.p; q += w * box.verts[i]!.q; val += w * box.verts[i]!.val; });
                    if (sw > 0) { p /= sw; q /= sw; val /= sw; }
                    return { t: it.t, key: bx.key, box: bx.b, N: box.N, C: box.C, p, q, val } as const;
                }
                return { t: it.t, point: 0 } as const;
            });
            const plainLays = new Map<number, Layout>();
            for (const ci of plain) {
                const c = this.comps[ci]!;
                const [sel, pow] = pick(c.nK, x, offsets.get(ci)!, (j) => c.powVar(j), c.partial);
                plainLays.set(ci, c.layout(sel, pow));
            }
            return { per, plainLays };
        };
        const m = H.createModel();
        try {
            m.passModel(cols.model(H, rowBase, lower, upper, true));
            // cutoff: only layouts scoring more are searched
            m.options.set({ output_flag: true, log_to_console: false, mip_rel_gap: gap, mip_min_logging_interval: 1,
                ...(Number.isFinite(cutoff) ? { objective_bound: -cutoff } : {}) });
            const cb = H.constants.callbackType;
            const run = m.run({
                [cb.mipImprovingSolution!]: (e) => { if (e.data.mip_solution) onImproving(Float64Array.from(e.data.mip_solution), -(e.data.objective_function_value ?? e.data.mip_primal_bound ?? 0)); },
                [cb.mipLogging!]: (e) => onLog(-(e.data.mip_primal_bound ?? Infinity), -(e.data.mip_dual_bound ?? -Infinity)),
            });
            const st = H.constants.modelStatus, status = run.modelStatus;
            // nothing above the cutoff found (HiGHS also stops when its limit is within the gap of the cutoff)
            const dual = -m.info.get("mip_dual_bound");
            const bound = Number.isFinite(dual) ? Math.max(dual, cutoff) : cutoff;
            const none = { optimal: true, score: -Infinity, bound, x: null, decode };
            if (status === st.infeasible || status === st.objectiveBound) return none;
            if (status === st.optimal && Number.isFinite(cutoff) && -m.getObjectiveValue() <= cutoff) return none;
            if (status !== st.optimal) return { optimal: false, score: 0, bound, x: null, decode };
            return { optimal: true, score: -m.getObjectiveValue(), bound, x: Float64Array.from(m.getSolution().colValue), decode };
        } finally {
            m.dispose();
        }
    }

    plants(lays: Layout[]): Plant[] {
        const out: Plant[] = [];
        lays.forEach((l, ci) => {
            l.sel.forEach((j, k) => {
                const c = (l.src ?? this.comps[ci]!.cands)[j]!;
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
    const share: Shared = {};
    const full = solve_core(H, world, { ...settings, partial: false }, gap, {
        progress: (p) => hooks.progress({ step: p.step, message: `Full power first: ${p.message.charAt(0).toLowerCase()}${p.message.slice(1)}`, ...(p.best !== undefined ? { best: p.best } : {}) }),
        layout: (l) => hooks.layout({ ...l, bound: Infinity }),
    }, null, share);
    // The partly powered search can need a lot of memory on very big worlds (HiGHS then aborts). Then the best
    // layout found so far is kept: the full-power one or a better one this search already reported.
    let best: LayoutReport = full, bound = Infinity;
    try {
        return solve_core(H, world, settings, gap, {
            progress: hooks.progress,
            layout: (l) => {
                if (Number.isFinite(l.bound)) bound = Math.min(bound, l.bound);
                if (l.exact && l.score > best.score) best = l;
                hooks.layout(l);
            },
        }, full, share);
    } catch (e) {
        hooks.progress({ step: "search", message: `The search for partly powered plants ran out of memory (${e instanceof Error ? e.message.split(".")[0] : e}); keeping the best layout found.`, best: best.score });
        return { ...best, bound: Number.isFinite(bound) ? Math.max(bound, best.score) : Infinity };
    }
}


function solve_core(H: HighsRuntime, world: WorldInput, settings: SolverSettings, gap: number, hooks: Hooks, start: LayoutReport | null,
                    share: Shared = {}): LayoutReport {
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
            lays.forEach((l, ci) => l.sel.forEach((j, k) => chosen.push({ cand: (l.src ?? C[ci]!.cands)[j]!, pow: l.pow[k]! })));
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
        const finish_up = (): LayoutReport => {
            // clean-up: partly powered plants at full power or removed, where that scores better (or the same:
            // fewer partly powered plants is simpler to build)
            if (settings.partial && !startPlants) {
                const before = bestVal;
                for (let changed = true; changed;) {
                    changed = false;
                    for (let ci = 0; ci < C.length && !changed; ci++) {
                        const l = bestLays[ci]!;
                        if (l.src) continue;
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
                if (bestVal > before + 1e-12) hooks.progress({ step: "search", message: `Tidied up the partly powered plants`, best: bestVal, bound });
            }
            bound = Math.max(bound, bestVal);
            const rep = { score: bestVal, exact: true, bound, plants: bestPlants() };
            hooks.layout(rep);
            return rep;
        };

        /**
         * Partly powered plants. Per raw item at most one partly powered nuclear and one coal plant matter
         * (moving power between two of the same kind never lowers the best: the value is convex in the powers).
         * Every one-item area's useful full-power layouts (from the full-power solve) are combined per item into
         * a table; with N nuclear and C coal plants plus one at power p and one at power q the item gets at most
         * the table's values at the corners of the cell mixed by (p, q). The search uses these limits; where it
         * chooses such a cell, the exact best for that (N, C, p, q) is worked out (Comp.partialBest). If that is
         * less than the limit, the cell's corners get their exact values and the cell is split at (p, q), and the
         * search runs again. Every limit stays a true upper limit, so the proven maximum stays exact.
         */
        const partial_search = (): LayoutReport => {
            bound = Infinity;
            bestVal = start!.score; startPlants = start!.plants;
            let options = share.options;
            if (!options) {
                hooks.progress({ step: "search", message: `Listing the useful layouts per area…`, best: bestVal });
                options = C.map((c) => { const f = new Comp(c.cands, dep.type, P.S, false, false); const o = f.options(H); f.dispose(); return o; });
            }
            const opts = options;
            const kinds = (lay: Layout, ci: number) => {
                let n = 0;
                for (const j of lay.sel) if ((lay.src ?? C[ci]!.cands)[j]!.kind === 1) n++;
                return [n, lay.sel.length - n] as const;
            };
            const byItem = new Map<number, number[]>();
            C.forEach((c, ci) => { if (opts[ci]) { const t = c.dt[0]!; let l = byItem.get(t); if (!l) byItem.set(t, (l = [])); l.push(ci); } });
            const plain = C.map((_, ci) => ci).filter((ci) => !opts[ci]);
            const eps = 1e-9;
            const items: PartialItem[] = [...byItem].map(([t, cis]) => {
                const table = combine(cis.map((ci) => opts[ci]!.map((lay) => {
                    const [n, c] = kinds(lay, ci);
                    return { n, c, gain: lay.g[t]! + (t === 4 ? COAL_FUEL_PER_MIN * c : 0) };
                })));
                const { nMax, cMax, top } = table, cw = cMax + 1;
                const T = (N: number, Cc: number) => top[N * cw + Cc]!;
                const boxes = new Map<string, PartialBox[]>();
                for (let N = 0; N <= nMax; N++) {
                    for (let Cc = 0; Cc <= cMax; Cc++) {
                        const t00 = T(N, Cc);
                        const aP = N < nMax && (T(N + 1, Cc) > t00 + eps || (Cc < cMax && T(N + 1, Cc + 1) > T(N, Cc + 1) + eps));
                        const aQ = Cc < cMax && (T(N, Cc + 1) > t00 + eps || (N < nMax && T(N + 1, Cc + 1) > T(N + 1, Cc) + eps));
                        if (!aP && !aQ) continue;
                        const verts = [{ p: 0, q: 0, val: t00, exact: true }];
                        if (aP) verts.push({ p: 1, q: 0, val: T(N + 1, Cc), exact: false });
                        if (aQ) verts.push({ p: 0, q: 1, val: T(N, Cc + 1), exact: false });
                        if (aP && aQ) verts.push({ p: 1, q: 1, val: T(N + 1, Cc + 1), exact: false });
                        boxes.set(`${N},${Cc}`, [{ N, C: Cc, verts }]);
                    }
                }
                return { t, cis, table, boxes };
            });
            // Exact values (exact()). At the cell corners (powers 0 or 1) the item's table is exact: a plant at
            // power 1 is one more fully powered plant. In between, at most one area of the item holds the partly
            // powered plant of each kind ("host"): a small search over the host's plants with the other areas as
            // their table, for each host in turn (best limit first; hosts whose limit cannot win are skipped).
            const cache = new Map<string, { value: number; lays: Map<number, Layout> }>();
            // per host set: its search's result (also when the time limit stopped it)
            const setCache = new Map<string, { value: number; bound: number; lays: Map<number, Layout> } | null>();
            // How an area is searched as a host. Level 0: its reduced spots (each stands for the real positions it
            // beats, Positions.represented). When a layout's plants do not fit, the next level: 1, one spot per group
            // of real positions boosting and building over exactly the same deposits; 2, every real position. On
            // levels 1 and 2 a tile every position of a spot builds on allows only one of them. Spot combinations
            // proven not to fit (placeable) are ruled out per level. Every level is a true upper limit.
            const level = new Map<number, number>();
            const realPos = new Map<number, Cand[]>();
            const real_cands = (ci: number) => {
                let a = realPos.get(ci);
                if (!a) {
                    const deps = new Set(C[ci]!.deps);
                    const inside = (x: Int32Array) => x.every((d) => deps.has(d));
                    a = getPositions().reaching(deps).filter((q) => inside(q.cover) && inside(q.foot));
                    realPos.set(ci, a);
                }
                return a;
            };
            // per spot: its real positions (same deposits)
            interface AreaView { cands: Cand[]; same: Cand[][]; rows: { js: number[]; hi: number }[]; comp: Comp }
            const views = new Map<string, AreaView>();
            const view_of = (ci: number): AreaView | null => {
                const lv = level.get(ci) ?? 0;
                if (!lv) return null;
                const vk = `${ci}|${lv}`;
                let v = views.get(vk);
                if (v) return v;
                const groups = new Map<string, Cand[]>();
                real_cands(ci).forEach((q, k) => {
                    const key = lv < 2 ? `${q.kind}|${q.cover.join(",")}|${q.foot.join(",")}` : String(k);
                    let g = groups.get(key);
                    if (!g) groups.set(key, (g = []));
                    g.push(q);
                });
                const same = [...groups.values()];
                const sureOf = same.map((g) => {
                    let tiles = new Set(footprint(g[0]!));
                    for (let k = 1; k < g.length && tiles.size; k++) { const f = new Set(footprint(g[k]!)); tiles = new Set([...tiles].filter((t) => f.has(t))); }
                    return tiles;
                });
                // per tile: the spots all of whose positions build on it
                const sure = new Map<number, number[]>();
                sureOf.forEach((tiles, j) => { for (const t of tiles) { let l = sure.get(t); if (!l) sure.set(t, (l = [])); l.push(j); } });
                const seen = new Set<string>(), rows: AreaView["rows"] = [];
                for (const js of sure.values()) {
                    if (js.length < 2) continue;
                    const k = js.join(",");
                    if (seen.has(k)) continue;
                    seen.add(k);
                    rows.push({ js, hi: 1 });
                }
                const cands = same.map((g) => g[0]!);
                v = { cands, same, rows, comp: new Comp(cands, dep.type, P.S, false, true) };
                views.set(vk, v);
                return v;
            };
            const realComps = new Map<number, Comp>();
            const real_comp = (ci: number) => {
                let c = realComps.get(ci);
                if (!c) realComps.set(ci, (c = new Comp(real_cands(ci), dep.type, P.S, false, true)));
                return c;
            };
            const nogoods = new Map<string, { js: number[]; hi: number }[]>();
            const nogoods_of = (ci: number) => nogoods.get(`${ci}|${level.get(ci) ?? 0}`) ?? [];
            const mode = (it: PartialItem) => it.cis.map((ci) => `${level.get(ci) ?? 0}:${nogoods_of(ci).length}`).join(",");
            const version = new Map<number, number>();           // per item: changes when its options change
            const tableCache = new Map<string, Table>();
            const stats = (ci: number, t: number) => opts[ci]!.map((lay) => {
                const [n, c] = kinds(lay, ci);
                return { n, c, gain: lay.g[t]! + (t === 4 ? COAL_FUEL_PER_MIN * c : 0) };
            });
            const table_of = (it: PartialItem, set: number[]) => {
                const key = `${it.t}|${version.get(it.t) ?? 0}|${set.join(",")}`;
                let tb = tableCache.get(key);
                if (!tb) { tb = combine(set.map((ci) => stats(ci, it.t))); tableCache.set(key, tb); }
                return tb;
            };
            const T = (tb: Table, N: number, Cc: number) => (N < 0 || Cc < 0 ? -Infinity : tb.top[Math.min(N, tb.nMax) * (tb.cMax + 1) + Math.min(Cc, tb.cMax)]!);
            const hostComps = new Map<string, { comp: Comp; where: [number, number][]; start: Map<number, number> }>();
            const host_comp = (set: number[]) => {
                const key = set.map((ci) => `${ci}:${level.get(ci) ?? 0}`).join(",");
                let h = hostComps.get(key);
                if (!h) {
                    const where: [number, number][] = [], all: Cand[] = [], start = new Map<number, number>();
                    for (const ci of set) { start.set(ci, all.length); (view_of(ci)?.cands ?? C[ci]!.cands).forEach((c, j) => { all.push(c); where.push([ci, j]); }); }
                    h = { comp: new Comp(all, dep.type, P.S, false, false), where, start };
                    hostComps.set(key, h);
                }
                return h;
            };
            const option_lays = (rest: number[], tb: Table, choice: number[]) => {
                const lays = new Map<number, Layout>();
                choice.forEach((o, a) => lays.set(rest[a]!, opts[rest[a]!]![o]!));
                return lays;
            };
            /** host sets for (p, q) with their upper limits, best first */
            const host_limits = (it: PartialItem, N: number, Cc: number, p: number, q: number) => {
                const intP = p === 0 || p === 1, intQ = q === 0 || q === 1;
                const N2 = N + (intP ? p : 0), C2 = Cc + (intQ ? q : 0), pp = intP ? 0 : p, qq = intQ ? 0 : q;
                const limit = (set: number[]) => {
                    const hs = table_of(it, set), rest = table_of(it, it.cis.filter((ci) => !set.includes(ci)));
                    let best = -Infinity;
                    for (let n = 0; n <= hs.nMax; n++) {
                        for (let c = 0; c <= hs.cMax; c++) {
                            const r = T(rest, N2 - n, C2 - c);
                            if (r === -Infinity) continue;
                            const v = (1 - pp) * (1 - qq) * T(hs, n, c) + pp * (1 - qq) * T(hs, n + 1, c) + (1 - pp) * qq * T(hs, n, c + 1) + pp * qq * T(hs, n + 1, c + 1) + r;
                            if (v > best) best = v;
                        }
                    }
                    return best;
                };
                // the partly powered nuclear plant in area a, the coal one in area b (each convex in its power)
                const split = (a: number, b: number) => {
                    const A = table_of(it, [a]), B = table_of(it, [b]), rest = table_of(it, it.cis.filter((ci) => ci !== a && ci !== b));
                    const ap: number[] = [], bq: number[] = [];
                    for (let n = 0; n <= A.nMax; n++) for (let c = 0; c <= A.cMax; c++) ap.push((1 - pp) * T(A, n, c) + pp * T(A, n + 1, c));
                    for (let n = 0; n <= B.nMax; n++) for (let c = 0; c <= B.cMax; c++) bq.push((1 - qq) * T(B, n, c) + qq * T(B, n, c + 1));
                    let best = -Infinity;
                    for (let n1 = 0; n1 <= A.nMax && n1 <= N2; n1++) for (let c1 = 0; c1 <= A.cMax && c1 <= C2; c1++) {
                        const va = ap[n1 * (A.cMax + 1) + c1]!;
                        for (let n2 = 0; n2 <= B.nMax && n1 + n2 <= N2; n2++) for (let c2 = 0; c2 <= B.cMax && c1 + c2 <= C2; c2++) {
                            const v = va + bq[n2 * (B.cMax + 1) + c2]! + T(rest, N2 - n1 - n2, C2 - c1 - c2);
                            if (v > best) best = v;
                        }
                    }
                    return best;
                };
                // one area holds both partly powered plants (or the only one), or (both kinds partly powered) two areas one each
                const out: { set: number[]; split: boolean; ub: number }[] = it.cis.map((ci) => ({ set: [ci], split: false, ub: limit([ci]) }));
                if (!intP && !intQ) for (const a of it.cis) for (const b of it.cis) if (a !== b) out.push({ set: [a, b], split: true, ub: split(a, b) });
                return out.sort((a, b) => b.ub - a.ub);
            };
            /**
             * The exact best at (N, C, p, q) and its layouts. With a target: stops as soon as a layout reaches it
             * (exact: false; enough to know the target is reached), or knows without a search that none can.
             */
            const exact = (it: PartialItem, N: number, Cc: number, p: number, q: number, target = Infinity): { value: number; upper: number; lays: Map<number, Layout>; exact: boolean } => {
                const key = `${mode(it)}|${it.t}|${version.get(it.t) ?? 0}|${N}|${Cc}|${p}|${q}`;
                const hit = cache.get(key);
                if (hit) return { ...hit, upper: hit.value, exact: true };
                const intP = p === 0 || p === 1, intQ = q === 0 || q === 1;
                const N2 = N + (intP ? p : 0), C2 = Cc + (intQ ? q : 0), pp = intP ? 0 : p, qq = intQ ? 0 : q;
                let out: { value: number; lays: Map<number, Layout> };
                let complete = true, upper = -Infinity;
                if (intP && intQ) {
                    const all = table_of(it, it.cis);
                    out = { value: T(all, N2, C2), lays: option_lays(it.cis, all, all.chooseAt(N2, C2)) };
                } else {
                    // host sets: one area (both partly powered plants there) or, with both kinds, two areas
                    const order = host_limits(it, N, Cc, p, q);
                    out = { value: -Infinity, lays: new Map() };
                    for (const [k, { set, split, ub }] of order.entries()) {
                        if (ub <= out.value + 1e-9 * Math.max(1, Math.abs(out.value))) break;
                        if (out.value >= target - 1e-9 * Math.max(1, Math.abs(target))) { complete = false; upper = Math.max(upper, ...order.slice(k).map((x) => x.ub)); break; }
                        const h = host_comp([...set].sort((a, b) => a - b));
                        const restCis = it.cis.filter((ci) => !set.includes(ci));
                        const rest = table_of(it, restCis);
                        const sk = `${key}|${set.join(",")}|${split}`;
                        let sr = setCache.get(sk);
                        if (!sr) {
                            const extra = set.flatMap((ci) => [...(view_of(ci)?.rows ?? []), ...nogoods_of(ci)].map((x) => ({ js: x.js.map((j) => h.start.get(ci)! + j), hi: x.hi })));
                            // split: no partly powered coal plant in the first area, no nuclear one in the second
                            const off = split ? h.where.map((_, j) => j).filter((j) => (h.where[j]![0] === set[0]) === (h.comp.cands[j]!.kind === 0)) : [];
                            const r = h.comp.partialBest(H, it.t, N2, C2, pp, qq, rest.points, HOST_SECONDS, extra, off);
                            sr = null;
                            if (r) {
                                const lays = option_lays(restCis, rest, r.other >= 0 ? rest.choose(r.other) : restCis.map(() => 0));
                                const per = new Map<number, { sel: number[]; pow: number[] }>(set.map((ci) => [ci, { sel: [], pow: [] }]));
                                r.sel.forEach((j, k) => { const [ci, lj] = h.where[j]!; per.get(ci)!.sel.push(lj); per.get(ci)!.pow.push(r.pow[k]!); });
                                for (const [ci, x] of per) {
                                    const v = view_of(ci);
                                    lays.set(ci, v ? { ...v.comp.layout(x.sel, x.pow), src: v.cands } : C[ci]!.layout(x.sel, x.pow));
                                }
                                sr = { value: r.value, bound: r.bound, lays };
                            }
                            setCache.set(sk, sr);
                        }
                        if (sr && sr.bound > sr.value + 1e-9 * Math.max(1, Math.abs(sr.value))) { complete = false; upper = Math.max(upper, Math.min(ub, sr.bound)); }
                        if (!sr) { complete = false; upper = Math.max(upper, ub); continue; }
                        if (sr.value <= out.value) continue;
                        out = { value: sr.value, lays: new Map(sr.lays) };
                    }
                }
                if (complete) cache.set(key, out);
                return { ...out, upper: Math.max(upper, out.value), exact: complete };
            };
            // Plants of the search's result that do not fit on real positions: a table's layout is replaced by the
            // area's exact best with the same plants (real positions, no overlap) and the table rebuilt; for a host's
            // layout the combination is ruled out or the area goes to the next level (see view_of), and the item's
            // box corners are worked out again.
            const fixedLays = new Set<Layout>();
            const rebuild = (it: PartialItem) => {
                version.set(it.t, (version.get(it.t) ?? 0) + 1);
                it.table = combine(it.cis.map((ci) => opts[ci]!.map((lay) => {
                    const [n, c] = kinds(lay, ci);
                    return { n, c, gain: lay.g[it.t]! + (it.t === 4 ? COAL_FUEL_PER_MIN * c : 0) };
                })));
            };
            let placedAny = false;
            const fit = (lays: Layout[]): number => {
                let n = 0;
                for (const it of items) {
                    let dirty = false, cut = false;
                    for (const ci of it.cis) {
                        const l = lays[ci]!;
                        if (!l.sel.length || fixedLays.has(l)) continue;
                        const chosen = l.sel.map((j, k): Placed => ({ cand: (l.src ?? C[ci]!.cands)[j]!, pow: l.pow[k]! }));
                        if (!realize(chosen, getPositions).failed) continue;
                        const idx = opts[ci]!.indexOf(l);
                        if (idx >= 0) {
                            const [nn, cc] = kinds(l, ci);
                            const ex = real_comp(ci).bestLayout(H, nn, cc) ?? { ...C[ci]!.layout([]), src: C[ci]!.cands };
                            fixedLays.add(ex);
                            opts[ci]![idx] = ex;
                            dirty = true;
                            continue;
                        }
                        // a complete search for real positions the spots stand for: found on level 1 or 2 (same
                        // deposits): use them. None: rule out the combination (a smaller part of it when that also
                        // cannot fit). Undecided, or found with fewer deposits on level 0: the next level.
                        const lv = level.get(ci) ?? 0, v = view_of(ci), Ps = getPositions();
                        const lists = (g: number[]) => g.map((j) => (v ? v.same[j]! : Ps.represented(C[ci]!.cands[j]!)));
                        let g = [...new Set(l.sel)];
                        const pr = placeable(lists(g)), own = v ? pr : null;
                        if (own) {
                            l.src = own; l.sel = own.map((_, k) => k);
                            fixedLays.add(l);
                            placedAny = true;
                        } else if (pr === false) {
                            for (let k = g.length - 1; k >= 0 && g.length > 2; k--) {
                                const h = g.filter((_, x) => x !== k);
                                if (placeable(lists(h), 200_000) === false) g = h;
                            }
                            const nk = `${ci}|${lv}`;
                            let list = nogoods.get(nk);
                            if (!list) nogoods.set(nk, (list = []));
                            list.push({ js: g.sort((a, b) => a - b), hi: g.length - 1 });
                            cut = true;
                        } else if (lv < 2) {
                            level.set(ci, lv + 1);
                            cut = true;
                        }
                    }
                    if (dirty) rebuild(it);
                    if (dirty || cut) {
                        // every corner is worked out again (exact values may now be lower)
                        for (const list of it.boxes.values()) for (const b of list) for (const v of b.verts) v.exact = false;
                        n++;
                    }
                }
                return n;
            };
            // a search result as layouts (box points: their exact best); inexact: boxes whose limit was too high
            const assemble = (ch: PartialChoice) => {
                const lays: Layout[] = C.map(() => ({ sel: [], pow: [], g: new Float64Array(7), nfc: 0 }));
                const inexact: { it: PartialItem; key: string; box: number; p: number; q: number; value: number; exact: boolean }[] = [];
                ch.per.forEach((e, k) => {
                    const it = items[k]!;
                    if ("point" in e) {
                        it.table.choose(e.point).forEach((o, a) => { lays[it.cis[a]!] = opts[it.cis[a]!]![o]!; });
                        return;
                    }
                    const r = exact(it, e.N, e.C, e.p, e.q, e.val);
                    if (r.value < e.val - 1e-9 * Math.max(1, Math.abs(e.val))) inexact.push({ it, key: e.key, box: e.box, p: e.p, q: e.q, value: r.upper, exact: r.exact });
                    if (r.value === -Infinity) {
                        it.table.chooseAt(e.N, e.C).forEach((o, a) => { lays[it.cis[a]!] = opts[it.cis[a]!]![o]!; });
                    } else {
                        for (const [ci, l] of r.lays) lays[ci] = l;
                    }
                });
                for (const [ci, l] of ch.plainLays) lays[ci] = l;
                return { lays, inexact };
            };
            // a box whose limit was too high at (p, q): exact corners, then split at (p, q)
            const tighten = (x: { it: PartialItem; key: string; box: number; p: number; q: number; value: number; exact: boolean }): boolean => {
                const list = x.it.boxes.get(x.key)!, box = list[x.box]!;
                let changed = false;
                for (const v of box.verts) {
                    if (v.exact) continue;
                    const r = exact(x.it, box.N, box.C, v.p, v.q);
                    if (r.upper < v.val - 1e-9 * Math.max(1, Math.abs(v.val))) changed = true;
                    v.val = Math.min(v.val, r.upper); v.exact = r.exact; if (r.exact) changed = true;
                }
                // the corners (p, q at 0 or 1: quick) of the neighbouring cells too: the search often moves there next
                for (let dn = -1; dn <= 1; dn++) for (let dc = -1; dc <= 1; dc++) {
                    if (!dn && !dc) continue;
                    for (const nb of x.it.boxes.get(`${box.N + dn},${box.C + dc}`) ?? []) {
                        for (const v of nb.verts) {
                            if (v.exact || (v.p !== 0 && v.p !== 1) || (v.q !== 0 && v.q !== 1)) continue;
                            v.val = Math.min(v.val, exact(x.it, nb.N, nb.C, v.p, v.q).value); v.exact = true; changed = true;
                        }
                    }
                }
                const ps = [...new Set(box.verts.map((v) => v.p))].sort((a, b) => a - b), qs = [...new Set(box.verts.map((v) => v.q))].sort((a, b) => a - b);
                const splitP = ps.length > 1 && x.p > ps[0]! + 1e-9 && x.p < ps[1]! - 1e-9;
                const splitQ = qs.length > 1 && x.q > qs[0]! + 1e-9 && x.q < qs[1]! - 1e-9;
                if (!splitP && !splitQ) return changed;
                const pp = splitP ? [ps[0]!, x.p, ps[1]!] : ps, qq = splitQ ? [qs[0]!, x.q, qs[1]!] : qs;
                // new corners: worked out now (a search round costs far more than these)
                const val = (p: number, q: number) => {
                    const old = box.verts.find((v) => v.p === p && v.q === q);
                    if (old) return old;
                    if (p === x.p && q === x.q && x.exact) return { val: x.value, exact: true };
                    const r = exact(x.it, box.N, box.C, p, q);
                    return { val: p === x.p && q === x.q ? Math.min(r.upper, x.value) : r.upper, exact: r.exact };
                };
                const parts: PartialBox[] = [];
                for (let a = 0; a + 1 < pp.length || (pp.length === 1 && a === 0); a++) {
                    for (let b = 0; b + 1 < qq.length || (qq.length === 1 && b === 0); b++) {
                        const p2 = pp.length === 1 ? [pp[0]!] : [pp[a]!, pp[a + 1]!], q2 = qq.length === 1 ? [qq[0]!] : [qq[b]!, qq[b + 1]!];
                        const verts: PartialBox["verts"] = [];
                        for (const q of q2) for (const p of p2) { const v = val(p, q); verts.push({ p, q, val: v.val, exact: v.exact }); }
                        parts.push({ N: box.N, C: box.C, verts });
                    }
                }
                list.splice(x.box, 1, ...parts);
                return true;
            };
            // groups of overlapping partly powered plants per plain area (group_rows), added when a search used them:
            // per tile the partly powered plants reaching it, and per kind those of that kind
            const groups = new Map<number, number[][]>();
            const add_groups = (plainLays: Map<number, Layout>): number => {
                let added = 0;
                for (const [ci, l] of plainLays) {
                    const c = C[ci]!, list = groups.get(ci) ?? [];
                    const seen = new Set(list.map((g) => g.join(",")));
                    const part = l.sel.filter((_, k) => l.pow[k]! < 1);
                    const at = new Map<number, number[]>();
                    for (const j of part) for (const d of c.cands[j]!.cover) { let x = at.get(d); if (!x) at.set(d, (x = [])); x.push(j); }
                    for (const js of at.values()) {
                        if (js.length < 2) continue;
                        const cands = [js, js.filter((j) => c.cands[j]!.kind === 1), js.filter((j) => c.cands[j]!.kind === 0)];
                        for (const g of cands) {
                            if (g.length < 2) continue;
                            const key = [...g].sort((a, b) => a - b).join(",");
                            if (seen.has(key)) continue;
                            seen.add(key); list.push(key.split(",").map(Number)); added++;
                        }
                    }
                    if (list.length) groups.set(ci, list);
                }
                return added;
            };
            hooks.layout({ score: bestVal, exact: true, bound: Infinity, plants: bestPlants() });
            try {
                for (let pass = 1; ; pass++) {
                    // only layouts that beat the best one are searched (HiGHS stops when its limit is within the gap)
                    const cutoff = bestVal;
                    hooks.progress({ step: "search", message: `Searching with partly powered plants${pass > 1 ? ` (round ${pass})` : ""}…`, best: bestVal, ...(Number.isFinite(bound) ? { bound } : {}) });
                    const sols: { x: Float64Array; score: number }[] = [];
                    const res = P.partialMip(gap, items, plain, groups, (x, score) => sols.push({ x, score }),
                        (_, b) => hooks.progress({ step: "search", message: `Searching with partly powered plants${pass > 1 ? ` (round ${pass})` : ""}`, best: bestVal, bound: Math.min(bound, Math.max(b, cutoff)) }),
                        cutoff);
                    if (Number.isFinite(res.bound)) bound = Math.min(bound, Math.max(res.bound, bestVal));
                    // found layouts whose own (upper limit) score could beat the best real one, and the final one
                    const before = bestVal;
                    const check = sols.filter((x) => x.score > before + 1e-12);
                    if (res.x) check.push({ x: res.x, score: res.score });
                    let better = false, last: ReturnType<typeof assemble> | null = null;
                    const allInexact: ReturnType<typeof assemble>["inexact"] = [];
                    let newPairs = 0;
                    hooks.progress({ step: "search", message: `Checking the partly powered plants of ${check.length} found layout${check.length > 1 ? "s" : ""} exactly…`, best: bestVal, ...(Number.isFinite(bound) ? { bound } : {}) });
                    for (const { x } of check) {
                        const ch = res.decode(x);
                        const a = assemble(ch);
                        last = a;
                        allInexact.push(...a.inexact);
                        newPairs += add_groups(ch.plainLays);
                        const r = real(a.lays);
                        if (r.v > bestVal + 1e-12) { take(r.v, a.lays, r.plants); better = true; }
                    }
                    if (better) hooks.layout({ score: bestVal, exact: true, bound, plants: bestPlants() });
                    if (closed() || !res.optimal || !last) break;
                    // every limit a found layout used that no real layout reaches: tighten it and search again (each box
                    // once; boxes of the same cell from the last one, so the indexes stay valid while splitting)
                    const uniq = new Map<string, (typeof allInexact)[number]>();
                    for (const x of allInexact) { const k = `${x.it.t}|${x.key}|${x.box}`; if (!uniq.has(k)) uniq.set(k, x); }
                    const order = [...uniq.values()].sort((a, b) => a.it.t - b.it.t || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0) || b.box - a.box);
                    if (order.length) hooks.progress({ step: "search", message: `Working out ${order.length} limit${order.length > 1 ? "s" : ""} for partly powered plants exactly…`, best: bestVal, bound });
                    const tightened = order.map(tighten).filter(Boolean).length;
                    placedAny = false;
                    const fixes = fit(last.lays);
                    if (placedAny) {
                        const r = real(last.lays);
                        if (r.v > bestVal + 1e-12) { take(r.v, last.lays, r.plants); hooks.layout({ score: bestVal, exact: true, bound, plants: bestPlants() }); }
                    }
                    if (!tightened && !newPairs && !fixes) break;
                    const changed = tightened + newPairs + fixes;
                    hooks.progress({ step: "search", message: `Partly powered plants: ${changed} limit${changed > 1 ? "s" : ""} made exact${fixes ? ` (plants did not fit in ${fixes} item${fixes > 1 ? "s" : ""})` : ""}; searching again`, best: bestVal, bound });
                }
            } finally {
                for (const h of hostComps.values()) h.comp.dispose();
                for (const v of views.values()) v.comp.dispose();
                for (const c of realComps.values()) c.dispose();
            }
            return finish_up();
        };

        if (settings.partial && start) return partial_search();

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
            hooks.progress({ step: "bound", message: `Working out the proven maximum: round ${round}, ${added} better layouts` });
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
        // Without partial power: every area's useful layouts are listed first (Comp.options / mixedOptions) and
        // the search picks among those (much faster than plant by plant, above all when the last few plants
        // decide, e.g. ALT recipes off). Areas that cannot be listed are still searched plant by plant.
        let options: (Layout[] | null)[] = [];
        let mixed: (MixedOptions | null)[] = [];
        if (!settings.partial && !closed()) {
            hooks.progress({ step: "search", message: `Listing the useful layouts per area…`, best: bestVal, bound });
            options = C.map((c) => c.options(H));
            mixed = C.map((c, ci) => (options[ci] ? null : c.mixedOptions(H, dep.type)));
        }
        // An area's listed layouts ignore that plants cannot overlap (so they are an upper limit). If the
        // search picks one whose plants do not fit, that one layout is replaced by the area's best with the same
        // number of plants on every real position with the no-overlap rule (exact), and the search runs again.
        const exactLays = new Set<Layout>();
        const exactComps: (Comp | null)[] = C.map(() => null);
        const refine = (lays: Layout[]): number => {
            let n = 0;
            C.forEach((c, ci) => {
                const l = lays[ci]!, opts = options[ci];
                if (!opts || exactLays.has(l) || !l.sel.length) return;
                const idx = opts.indexOf(l);
                if (idx < 0) return;
                const chosen = l.sel.map((j, k): Placed => ({ cand: (l.src ?? c.cands)[j]!, pow: l.pow[k]! }));
                if (!realize(chosen, getPositions).failed) return;
                if (!exactComps[ci]) {
                    const deps = new Set(c.deps);
                    const inside = (a: Int32Array) => a.every((d) => deps.has(d));
                    exactComps[ci] = new Comp(getPositions().reaching(deps).filter((q) => inside(q.cover) && inside(q.foot)), dep.type, P.S, false, true);
                }
                const nN = l.sel.filter((j) => (l.src ?? c.cands)[j]!.kind === 1).length;
                const exact = exactComps[ci]!.bestLayout(H, nN, l.sel.length - nN) ?? { ...c.layout([]), src: c.cands };
                exactLays.add(exact);
                opts[idx] = exact;
                n++;
            });
            return n;
        };
        for (let pass = 1; !closed(); pass++) {
            hooks.progress({ step: "search", message: "Searching for better layouts…", best: bestVal, bound });
            const seenLays: Layout[][] = [];       // layouts found during this search (for the partial power rule)
            const res = P.compact(gap,
                // no HiGHS calls inside HiGHS callbacks: report the search's own score; the page scores
                // every reported layout exactly (overlapping partly powered plants: worst case)
                (score, b, lays) => {
                    seenLays.push(lays);
                    // with partial power the search's own score can be optimistic (overlaps): report no more than
                    // the real best so far; the page shows the layout's exact score once it is scored
                    if (score > bestVal + 1e-12) hooks.layout({ score: settings.partial ? bestVal : score, exact: false, bound: Math.min(bound, b), plants: placedPlants(lays) });
                },
                (best, b) => hooks.progress({ step: "search", message: `Searching for better layouts${pass > 1 ? ` (round ${pass})` : ""}`, best: Math.max(best, bestVal), bound: Math.min(bound, b) }),
                options, mixed);
            if (res.lays) {
                const r = real(res.lays);
                if (r.v > bestVal) take(r.v, res.lays, r.plants);
            }
            if (Number.isFinite(res.bound)) bound = Math.min(bound, Math.max(res.bound, bestVal));
            if (!settings.partial || !res.lays) {
                if (res.optimal) bound = Math.min(bound, Math.max(bestVal, res.score, Number.isFinite(res.bound) ? res.bound : res.score));
                if (!settings.partial) {
                    // every layout the search found, on real positions (the last one may not fit as chosen)
                    let better = false;
                    for (const lays of seenLays) {
                        const r = real(lays);
                        if (r.v > bestVal + 1e-12) { take(r.v, lays, r.plants); better = true; }
                    }
                    if (better) hooks.layout({ score: bestVal, exact: true, bound, plants: bestPlants() });
                    if (res.lays && res.optimal && !closed()) {
                        const n = refine(res.lays);
                        if (n) {
                            hooks.progress({ step: "search", message: `Plants did not fit in ${n} area${n > 1 ? "s" : ""}: correcting ${n > 1 ? "those layouts" : "that layout"}`, best: bestVal, bound });
                            continue;
                        }
                    }
                }
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
            hooks.progress({ step: "search", message: `${broken} partly powered plant${broken > 1 ? "s" : ""} shared tiles with other plants; searching again`, best: bestVal, bound });
        }
        exactComps.forEach((c) => c?.dispose());
        if (!settings.partial && options.length) share.options = options;
        return finish_up();
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
