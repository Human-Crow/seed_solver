// Placement: the search works on a reduced set of plant spots and without the "plants never overlap" rule
// (that makes the reduction safe, so its maximum is a true upper limit). Here the chosen plants get real
// positions: a plant whose footprint overlaps another one moves to a position that boosts at least the same
// deposits and builds over no more (same deposits for a partly powered plant), so it is never worse.

import { find_candidates, type Cand, type Deposits } from "./candidates.js";

/** counts for testing: how often plants had to move, and how many could not be placed */
export const placement_stats = { calls: 0, moved: 0, failed: 0 };

export interface Placed {
    cand: Cand;
    pow: number;            // powered share (1 = full)
}

/** every land position of every plant shape, with an index to find better-or-equal alternatives fast */
export class Positions {
    private readonly all: Cand[];
    private readonly byDep: Map<number, number[]>[] = [new Map(), new Map()];     // [kind] deposit -> positions
    private readonly noCover: number[][] = [[], []];

    constructor(dep: Deposits, water: { x: Int32Array; y: Int32Array }) {
        this.all = find_candidates(dep, water, false);
        this.all.forEach((c, i) => {
            if (!c.cover.length) { this.noCover[c.kind]!.push(i); return; }
            const m = this.byDep[c.kind]!;
            for (const e of c.cover) {
                let l = m.get(e);
                if (!l) m.set(e, (l = []));
                l.push(i);
            }
        });
    }

    /**
     * Positions as good as `c` or better: same kind, boosting every deposit `c` boosts (exactly the same ones
     * when `sameCover`), building over no deposit `c` does not. Nearest to `c` first.
     */
    alternatives(c: Cand, sameCover: boolean): Cand[] {
        let pool: number[];
        if (c.cover.length) {
            // the deposit with the fewest positions reaching it narrows the search most
            let best: number[] | undefined;
            for (const d of c.cover) {
                const l = this.byDep[c.kind]!.get(d);
                if (!l) return [];
                if (!best || l.length < best.length) best = l;
            }
            pool = best!;
        } else {
            pool = this.noCover[c.kind]!;
        }
        const cover = new Set(c.cover), foot = new Set(c.foot);
        const out: Cand[] = [];
        for (const i of pool) {
            const q = this.all[i]!;
            if (sameCover ? q.cover.length !== c.cover.length : q.cover.length < c.cover.length) continue;
            let ok = true;
            for (const d of q.foot) if (!foot.has(d)) { ok = false; break; }
            if (!ok) continue;
            let n = 0;
            for (const d of q.cover) if (cover.has(d)) n++;
            if (n !== c.cover.length) continue;
            out.push(q);
        }
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        out.sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy));
        return out;
    }
}


const tileKey = (x: number, y: number) => x * 65536 + y;

function footprint(c: Cand): number[] {
    const t: number[] = [];
    for (let a = 0; a < c.w; a++) for (let b = 0; b < c.h; b++) t.push(tileKey(c.x + a, c.y + b));
    return t;
}


/**
 * Give the chosen plants positions that do not overlap. Plants that already fit keep their spot; the others
 * (and, if needed, their neighbours) are moved to equal-or-better positions. `failed` plants could not be
 * placed and are left out (the layout stays valid, only that plant is missing).
 */
export function realize(chosen: Placed[], positions: () => Positions): { placed: Placed[]; failed: number; moved: number } {
    const n = chosen.length;
    const tiles = chosen.map((p) => footprint(p.cand));
    const owner = new Map<number, number[]>();
    tiles.forEach((ts, i) => ts.forEach((t) => { let l = owner.get(t); if (!l) owner.set(t, (l = [])); l.push(i); }));
    const clash = new Set<number>();
    for (const l of owner.values()) if (l.length > 1) l.forEach((i) => clash.add(i));
    placement_stats.calls++;
    if (!clash.size) return { placed: chosen, failed: 0, moved: 0 };

    const P = positions();
    let movable = new Set(clash);
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = place(chosen, tiles, movable, P);
        if (res) { placement_stats.moved += movable.size; return { placed: res, failed: 0, moved: movable.size }; }
        // let the neighbours of the movable plants move too (their footprints within 6 tiles)
        const grow = new Set(movable);
        for (const i of movable) {
            const a = chosen[i]!.cand;
            for (let j = 0; j < n; j++) {
                const b = chosen[j]!.cand;
                if (Math.abs(a.x - b.x) <= 6 + a.w && Math.abs(a.y - b.y) <= 6 + a.h) grow.add(j);
            }
        }
        if (grow.size === movable.size) break;
        movable = grow;
    }
    // could not place them all: keep every plant that fits, leave out the rest (largest first is kept)
    const order = [...Array(n).keys()].sort((a, b) => chosen[b]!.cand.cover.length - chosen[a]!.cand.cover.length);
    const used = new Set<number>(), placed: Placed[] = [];
    let failed = 0;
    for (const i of order) {
        const alts = movable.has(i) ? P.alternatives(chosen[i]!.cand, chosen[i]!.pow < 1) : [chosen[i]!.cand];
        const q = alts.find((c) => footprint(c).every((t) => !used.has(t)));
        if (!q) { failed++; continue; }
        footprint(q).forEach((t) => used.add(t));
        placed.push({ cand: q, pow: chosen[i]!.pow });
    }
    placement_stats.failed += failed;
    return { placed, failed, moved: movable.size };
}


/** depth-first search: positions for the movable plants around the fixed ones (limited effort) */
function place(chosen: Placed[], tiles: number[][], movable: Set<number>, P: Positions): Placed[] | null {
    const used = new Set<number>();
    chosen.forEach((_, i) => { if (!movable.has(i)) tiles[i]!.forEach((t) => used.add(t)); });
    const list = [...movable].map((i) => ({ i, alts: P.alternatives(chosen[i]!.cand, chosen[i]!.pow < 1).map((c) => ({ c, t: footprint(c) })) }));
    if (list.some((x) => !x.alts.length)) return null;
    // fewest choices first; only alternatives that avoid the fixed plants
    for (const x of list) x.alts = x.alts.filter((a) => a.t.every((t) => !used.has(t)));
    if (list.some((x) => !x.alts.length)) return null;
    list.sort((a, b) => a.alts.length - b.alts.length);
    const pick: Cand[] = new Array(list.length);
    let steps = 0;
    const go = (k: number): boolean => {
        if (k === list.length) return true;
        for (const a of list[k]!.alts) {
            if (++steps > 200000) return false;
            if (a.t.some((t) => used.has(t))) continue;
            a.t.forEach((t) => used.add(t));
            pick[k] = a.c;
            if (go(k + 1)) return true;
            a.t.forEach((t) => used.delete(t));
        }
        return false;
    };
    if (!go(0)) return null;
    const out = chosen.slice();
    list.forEach((x, k) => { out[x.i] = { cand: pick[k]!, pow: chosen[x.i]!.pow }; });
    return out;
}
