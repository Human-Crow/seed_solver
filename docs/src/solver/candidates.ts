// Candidate power plant positions: every land position whose boosted square reaches a deposit.
// Positions that cover the same deposits and build over the same deposits are merged into one class;
// a class is dropped when another class of the same fuel covers everything it covers and builds over
// no more. Same rules as the Python solver's _candidates(). This reduction ignores that plants cannot
// overlap, so it is only exact for a search without that rule (see solve.ts / realize.ts).

import { PLANT_SHAPES } from "./data.js";

export interface Cand {
    kind: 0 | 1;            // 0 coal, 1 nuclear
    x: number;              // footprint top-left tile
    y: number;
    w: number;
    h: number;
    cover: Int32Array;      // deposit indices in the boosted square (sorted)
    foot: Int32Array;       // deposit indices under the footprint (sorted)
}

export interface Deposits {
    count: number;
    type: Uint8Array;       // 0..6 (raw item index)
    x: Int32Array;
    y: Int32Array;
}

// groups of deposits no plant square can connect (squares are at most 22 wide)
const LINK = 24;


function group_deposits(dep: Deposits): number[][] {
    const cell = new Map<string, number[]>();
    for (let i = 0; i < dep.count; i++) {
        const key = `${Math.floor(dep.x[i]! / LINK)},${Math.floor(dep.y[i]! / LINK)}`;
        let list = cell.get(key);
        if (!list) cell.set(key, (list = []));
        list.push(i);
    }
    const keys = [...cell.keys()];
    const index = new Map(keys.map((k, n) => [k, n]));
    const parent = keys.map((_, n) => n);
    const find = (a: number): number => {
        while (parent[a] !== a) a = parent[a] = parent[parent[a]!]!;
        return a;
    };
    for (const k of keys) {
        const [cx, cy] = k.split(",").map(Number) as [number, number];
        for (let dx = -1; dx <= 1; dx++) {
            for (let dy = -1; dy <= 1; dy++) {
                const o = index.get(`${cx + dx},${cy + dy}`);
                if (o !== undefined) parent[find(o)] = find(index.get(k)!);
            }
        }
    }
    const groups = new Map<number, number[]>();
    keys.forEach((k, n) => {
        const r = find(n);
        let g = groups.get(r);
        if (!g) groups.set(r, (g = []));
        g.push(...cell.get(k)!);
    });
    return [...groups.values()].map((g) => g.sort((a, b) => a - b));
}


function rand32(seed: number): () => number {
    let s = seed >>> 0 || 1;
    return () => {
        s ^= s << 13; s >>>= 0;
        s ^= s >>> 17;
        s ^= s << 5; s >>>= 0;
        return s | 0;
    };
}


/**
 * @param water every water tile within 12 tiles of a deposit (the only tiles a footprint can use)
 */
/** reduce: merge positions with the same effect (one kept); dominance: also drop dominated classes */
export function find_candidates(dep: Deposits, water: { x: Int32Array; y: Int32Array }, reduce = true, dominance = reduce): Cand[] {
    const out: Cand[] = [];
    const rnd = rand32(12345);
    const h1 = new Int32Array(dep.count), h2 = new Int32Array(dep.count);
    for (let i = 0; i < dep.count; i++) { h1[i] = rnd(); h2[i] = rnd(); }

    for (const ids of group_deposits(dep)) {
        let xmin = Infinity, ymin = Infinity, xmax = -Infinity, ymax = -Infinity;
        for (const i of ids) {
            xmin = Math.min(xmin, dep.x[i]!); xmax = Math.max(xmax, dep.x[i]!);
            ymin = Math.min(ymin, dep.y[i]!); ymax = Math.max(ymax, dep.y[i]!);
        }
        const x0 = xmin - 24, y0 = ymin - 24;
        const W = xmax - x0 + 25, H = ymax - y0 + 25, H1 = H + 1;
        const at = new Int32Array(W * H).fill(-1);           // deposit index per tile
        const P1 = new Int32Array((W + 1) * H1), P2 = new Int32Array((W + 1) * H1);
        const PC = new Int32Array((W + 1) * H1), PW = new Int32Array((W + 1) * H1);
        const g1 = new Int32Array(W * H), g2 = new Int32Array(W * H), gc = new Int32Array(W * H), gw = new Int32Array(W * H);
        for (const i of ids) {
            const c = (dep.x[i]! - x0) * H + (dep.y[i]! - y0);
            at[c] = i; g1[c] = h1[i]!; g2[c] = h2[i]!; gc[c] = 1;
        }
        for (let k = 0; k < water.x.length; k++) {
            const gx = water.x[k]! - x0, gy = water.y[k]! - y0;
            if (gx >= 0 && gy >= 0 && gx < W && gy < H) gw[gx * H + gy] = 1;
        }
        const prefix = (g: Int32Array, P: Int32Array) => {
            for (let a = 0; a < W; a++) {
                let run = 0;
                for (let b = 0; b < H; b++) {
                    run = (run + g[a * H + b]!) | 0;
                    P[(a + 1) * H1 + b + 1] = (P[a * H1 + b + 1]! + run) | 0;
                }
            }
        };
        prefix(g1, P1); prefix(g2, P2); prefix(gc, PC); prefix(gw, PW);
        const rect = (P: Int32Array, ax: number, ay: number, w: number, h: number) =>
            (P[(ax + w) * H1 + ay + h]! - P[ax * H1 + ay + h]! - P[(ax + w) * H1 + ay]! + P[ax * H1 + ay]!) | 0;

        for (const kind of [0, 1] as const) {
            const shapes = kind === 0 ? PLANT_SHAPES.coal : PLANT_SHAPES.nuclear;
            const classes = new Map<string, [number, number, number, number]>();
            for (const [[w, h], [aw, ah]] of shapes) {
                const lx = (aw - w) >> 1, ty = (ah - h) >> 1;
                for (let px = lx; px - lx + aw <= W; px++) {
                    for (let py = ty; py - ty + ah <= H; py++) {
                        if (rect(PC, px - lx, py - ty, aw, ah) === 0) continue;       // reaches no deposit
                        if (rect(PW, px, py, w, h) !== 0) continue;                  // footprint on water
                        const key = reduce
                            ? `${rect(P1, px - lx, py - ty, aw, ah)},${rect(P2, px - lx, py - ty, aw, ah)},${rect(P1, px, py, w, h)},${rect(P2, px, py, w, h)}`
                            : `${px},${py},${w}`;
                        if (!classes.has(key)) classes.set(key, [px, py, w, h]);
                    }
                }
            }
            // the real deposit sets of one position per class
            const reps: { cover: Int32Array; foot: Int32Array; x: number; y: number; w: number; h: number }[] = [];
            for (const [px, py, w, h] of classes.values()) {
                const shape = shapes.find(([f]) => f[0] === w && f[1] === h)!;
                const [aw, ah] = shape[1];
                const lx = (aw - w) >> 1, ty = (ah - h) >> 1;
                const cover: number[] = [], foot: number[] = [];
                for (let a = px - lx; a < px - lx + aw; a++) {
                    for (let b = py - ty; b < py - ty + ah; b++) {
                        const d = at[a * H + b]!;
                        if (d < 0) continue;
                        cover.push(d);
                        if (a >= px && a < px + w && b >= py && b < py + h) foot.push(d);
                    }
                }
                cover.sort((p, q) => p - q); foot.sort((p, q) => p - q);
                reps.push({ cover: Int32Array.from(cover), foot: Int32Array.from(foot), x: px + x0, y: py + y0, w, h });
            }
            reps.sort((p, q) => q.cover.length - p.cover.length);
            // dominance: dropped if a kept class covers all it covers and builds over no more
            const kept: typeof reps = [];
            const byDep = new Map<number, number[]>();
            const mark = new Int32Array(dep.count).fill(-1);
            let stamp = 0;
            for (const r of reps) {
                let dominated = false;
                if (dominance && r.cover.length) {
                    stamp++;
                    for (const d of r.foot) mark[d] = stamp;          // r's footprint
                    for (const j of byDep.get(r.cover[0]!) ?? []) {
                        const k = kept[j]!;
                        if (!is_subset(r.cover, k.cover)) continue;
                        let ok = true;
                        for (const d of k.foot) if (mark[d] !== stamp) { ok = false; break; }
                        if (ok) { dominated = true; break; }
                    }
                }
                if (dominated) continue;
                kept.push(r);
                for (const d of r.cover) {
                    let l = byDep.get(d);
                    if (!l) byDep.set(d, (l = []));
                    l.push(kept.length - 1);
                }
            }
            for (const r of kept) out.push({ kind, x: r.x, y: r.y, w: r.w, h: r.h, cover: r.cover, foot: r.foot });
        }
    }
    return out;
}


/** a (sorted) is a subset of b (sorted) */
function is_subset(a: Int32Array, b: Int32Array): boolean {
    if (a.length > b.length) return false;
    let j = 0;
    for (let i = 0; i < a.length; i++) {
        const v = a[i]!;
        while (j < b.length && b[j]! < v) j++;
        if (j === b.length || b[j] !== v) return false;
        j++;
    }
    return true;
}
