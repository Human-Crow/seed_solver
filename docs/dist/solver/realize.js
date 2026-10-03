// Placement: the search works on a reduced set of plant spots and without the "plants never overlap" rule
// (that makes the reduction safe, so its maximum is a true upper limit). Here the chosen plants get real
// positions: a plant whose footprint overlaps another one moves to a position that boosts at least the same
// deposits and builds over no more, so it is never worse (also for a partly powered plant: the game counts
// its worst case on a shared tile, and boosting more never lowers that).
import { find_candidates } from "./candidates.js";
/** counts for testing: how often plants had to move, and how many could not be placed */
export const placement_stats = { calls: 0, moved: 0, failed: 0 };
/** every land position of every plant shape, with an index to find better-or-equal alternatives fast */
export class Positions {
    all;
    byDep = [new Map(), new Map()]; // [kind] deposit -> positions
    noCover = [[], []];
    constructor(dep, water) {
        this.all = find_candidates(dep, water, false);
        this.all.forEach((c, i) => {
            if (!c.cover.length) {
                this.noCover[c.kind].push(i);
                return;
            }
            const m = this.byDep[c.kind];
            for (const e of c.cover) {
                let l = m.get(e);
                if (!l)
                    m.set(e, (l = []));
                l.push(i);
            }
        });
    }
    /** every position (of either fuel) whose boosted square reaches one of these deposits */
    reaching(deps) {
        const out = new Set();
        for (const d of deps)
            for (const m of this.byDep)
                for (const i of m.get(d) ?? [])
                    out.add(i);
        return [...out].sort((a, b) => a - b).map((i) => this.all[i]);
    }
    /**
     * Positions as good as `c` or better: same kind, boosting every deposit `c` boosts (exactly the same ones
     * when `sameCover`), building over no deposit `c` does not. Nearest to `c` first.
     */
    alternatives(c, sameCover) {
        let pool;
        if (c.cover.length) {
            // the deposit with the fewest positions reaching it narrows the search most
            let best;
            for (const d of c.cover) {
                const l = this.byDep[c.kind].get(d);
                if (!l)
                    return [];
                if (!best || l.length < best.length)
                    best = l;
            }
            pool = best;
        }
        else {
            pool = this.noCover[c.kind];
        }
        const cover = new Set(c.cover), foot = new Set(c.foot);
        const out = [];
        for (const i of pool) {
            const q = this.all[i];
            if (sameCover ? q.cover.length !== c.cover.length : q.cover.length < c.cover.length)
                continue;
            let ok = true;
            for (const d of q.foot)
                if (!foot.has(d)) {
                    ok = false;
                    break;
                }
            if (!ok)
                continue;
            let n = 0;
            for (const d of q.cover)
                if (cover.has(d))
                    n++;
            if (n !== c.cover.length)
                continue;
            out.push(q);
        }
        const cx = c.x + c.w / 2, cy = c.y + c.h / 2;
        out.sort((a, b) => Math.hypot(a.x + a.w / 2 - cx, a.y + a.h / 2 - cy) - Math.hypot(b.x + b.w / 2 - cx, b.y + b.h / 2 - cy));
        return out;
    }
    /**
     * Every real position the reduced spot `c` stands for: same kind, boosting no deposit `c` does not, building
     * over every deposit `c` builds over (the reduction keeps one spot per such group, the one that is best).
     */
    represented(c) {
        const cover = new Set(c.cover), foot = new Set(c.foot), seen = new Set(), out = [];
        for (const d of c.cover) {
            for (const i of this.byDep[c.kind].get(d) ?? []) {
                if (seen.has(i))
                    continue;
                seen.add(i);
                const q = this.all[i];
                if (q.cover.length > c.cover.length || q.foot.length < c.foot.length)
                    continue;
                let ok = true;
                for (const e of q.cover)
                    if (!cover.has(e)) {
                        ok = false;
                        break;
                    }
                if (!ok)
                    continue;
                let n = 0;
                for (const e of q.foot)
                    if (foot.has(e))
                        n++;
                if (n === c.foot.length)
                    out.push(q);
            }
        }
        return out;
    }
}
/**
 * Real positions for plants that may each go to any position of their list, without overlapping: a complete
 * search. false is a proof that there are none, null that it took too long to decide.
 */
export function placeable(lists, maxSteps = 2_000_000) {
    const list = lists.map((l) => l.map((c) => ({ c, t: footprint(c) })));
    if (list.some((l) => !l.length))
        return false;
    const used = new Set(), pick = new Array(list.length);
    let steps = 0;
    const left = list.map((_, k) => k);
    const go = () => {
        if (!left.length)
            return true;
        // the plant with the fewest free positions next (none: dead end)
        let bi = -1, bn = Infinity, bfree = [];
        for (let a = 0; a < left.length; a++) {
            const free = list[left[a]].filter((x) => x.t.every((t) => !used.has(t)));
            if (free.length < bn) {
                bn = free.length;
                bi = a;
                bfree = free;
                if (!bn)
                    return false;
            }
        }
        const k = left[bi];
        left.splice(bi, 1);
        let res = false;
        for (const x of bfree) {
            if (++steps > maxSteps) {
                res = null;
                break;
            }
            x.t.forEach((t) => used.add(t));
            pick[k] = x.c;
            const r = go();
            x.t.forEach((t) => used.delete(t));
            if (r !== false) {
                res = r;
                break;
            }
        }
        left.splice(bi, 0, k);
        return res;
    };
    const r = go();
    return r === true ? pick : r;
}
const tileKey = (x, y) => x * 65536 + y;
export function footprint(c) {
    const t = [];
    for (let a = 0; a < c.w; a++)
        for (let b = 0; b < c.h; b++)
            t.push(tileKey(c.x + a, c.y + b));
    return t;
}
/**
 * Give the chosen plants positions that do not overlap. Plants that already fit keep their spot; the others
 * (and, if needed, their neighbours) are moved to equal-or-better positions. `failed` plants could not be
 * placed and are left out (the layout stays valid, only that plant is missing).
 */
export function realize(chosen, positions) {
    const n = chosen.length;
    const tiles = chosen.map((p) => footprint(p.cand));
    const owner = new Map();
    tiles.forEach((ts, i) => ts.forEach((t) => { let l = owner.get(t); if (!l)
        owner.set(t, (l = [])); l.push(i); }));
    const clash = new Set();
    for (const l of owner.values())
        if (l.length > 1)
            l.forEach((i) => clash.add(i));
    placement_stats.calls++;
    if (!clash.size)
        return { placed: chosen, failed: 0, moved: 0 };
    const P = positions();
    let movable = new Set(clash);
    for (let attempt = 0; attempt < 3; attempt++) {
        const res = place(chosen, tiles, movable, P);
        if (res) {
            placement_stats.moved += movable.size;
            return { placed: res, failed: 0, moved: movable.size };
        }
        // let the neighbours of the movable plants move too (their footprints within 6 tiles)
        const grow = new Set(movable);
        for (const i of movable) {
            const a = chosen[i].cand;
            for (let j = 0; j < n; j++) {
                const b = chosen[j].cand;
                if (Math.abs(a.x - b.x) <= 6 + a.w && Math.abs(a.y - b.y) <= 6 + a.h)
                    grow.add(j);
            }
        }
        if (grow.size === movable.size)
            break;
        movable = grow;
    }
    // could not place them all: keep every plant that fits, leave out the rest (largest first is kept)
    const order = [...Array(n).keys()].sort((a, b) => chosen[b].cand.cover.length - chosen[a].cand.cover.length);
    const used = new Set(), placed = [];
    let failed = 0;
    for (const i of order) {
        const alts = movable.has(i) ? P.alternatives(chosen[i].cand, false) : [chosen[i].cand];
        const q = alts.find((c) => footprint(c).every((t) => !used.has(t)));
        if (!q) {
            failed++;
            continue;
        }
        footprint(q).forEach((t) => used.add(t));
        placed.push({ cand: q, pow: chosen[i].pow });
    }
    placement_stats.failed += failed;
    return { placed, failed, moved: movable.size };
}
/** depth-first search: positions for the movable plants around the fixed ones (limited effort) */
function place(chosen, tiles, movable, P) {
    const used = new Set();
    chosen.forEach((_, i) => { if (!movable.has(i))
        tiles[i].forEach((t) => used.add(t)); });
    const list = [...movable].map((i) => ({ i, alts: P.alternatives(chosen[i].cand, false).map((c) => ({ c, t: footprint(c) })) }));
    if (list.some((x) => !x.alts.length))
        return null;
    // fewest choices first; only alternatives that avoid the fixed plants
    for (const x of list)
        x.alts = x.alts.filter((a) => a.t.every((t) => !used.has(t)));
    if (list.some((x) => !x.alts.length))
        return null;
    list.sort((a, b) => a.alts.length - b.alts.length);
    const pick = new Array(list.length);
    let steps = 0;
    const go = (k) => {
        if (k === list.length)
            return true;
        for (const a of list[k].alts) {
            if (++steps > 200000)
                return false;
            if (a.t.some((t) => used.has(t)))
                continue;
            a.t.forEach((t) => used.add(t));
            pick[k] = a.c;
            if (go(k + 1))
                return true;
            a.t.forEach((t) => used.delete(t));
        }
        return false;
    };
    if (!go(0))
        return null;
    const out = chosen.slice();
    list.forEach((x, k) => { out[x.i] = { cand: pick[k], pow: chosen[x.i].pow }; });
    return out;
}
//# sourceMappingURL=realize.js.map