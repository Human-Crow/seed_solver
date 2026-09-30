// Recipe model, extractor speeds and a small sparse-matrix helper for building HiGHS models.
import { RECIPES, RAW_ITEMS, EXTRACTOR_SECONDS, URANIUM_SECONDS, TIER_FACTORS, COAL_BOOST, NUCLEAR_BOOST, speed, } from "./data.js";
/** Extractor output per minute: S[r*3 + k] for raw item r, k = 0 unboosted, 1 coal, 2 nuclear. */
export function speed_table(tier, gen2) {
    const S = new Float64Array(21);
    const f = TIER_FACTORS[tier]?.[gen2 ? 1 : 0];
    if (f === undefined)
        throw new Error("tier must be 1..5");
    const nb = gen2 ? NUCLEAR_BOOST.gen2 : NUCLEAR_BOOST.gen1;
    RAW_ITEMS.forEach((item, r) => {
        const [s, ff] = item === "Uranium_Ore"
            ? [gen2 ? URANIUM_SECONDS.gen2 : URANIUM_SECONDS.gen1, 1]
            : [gen2 ? EXTRACTOR_SECONDS.gen2 : EXTRACTOR_SECONDS.gen1, f];
        S[r * 3] = speed(s, ff);
        S[r * 3 + 1] = speed(s, ff, COAL_BOOST);
        S[r * 3 + 2] = speed(s, ff, nb);
    });
    return S;
}
/** Recipe matrix: one column per recipe (items/min of its output) plus the target column T (last). */
export class RecipeModel {
    items;
    iidx = new Map();
    prod = [];
    colRows = [];
    colVals = [];
    rawRows;
    fcRow;
    nI;
    nx;
    constructor(alt, target) {
        const raw = new Set(RAW_ITEMS);
        const names = new Set(RAW_ITEMS);
        for (const [item] of RECIPES)
            names.add(item);
        if (!names.has(target))
            throw new Error(`Unknown target item '${target}'.`);
        this.items = [...names].sort();
        this.items.forEach((it, n) => this.iidx.set(it, n));
        for (const [item, variant, out, , , mats] of RECIPES) {
            if (raw.has(item) || item === "Coal_Power_Plant" || item === "Nuclear_Power_Plant")
                continue;
            if (!alt && variant === "ALT")
                continue;
            this.prod.push([item, variant]);
            const col = new Map();
            const add = (row, v) => col.set(row, (col.get(row) ?? 0) + v);
            add(this.iidx.get(item), 1);
            for (const [m, a] of mats)
                add(this.iidx.get(m), -a / out);
            this.pushCol(col);
        }
        this.pushCol(new Map([[this.iidx.get(target), -1]]));
        this.nI = this.items.length;
        this.nx = this.colRows.length;
        this.rawRows = RAW_ITEMS.map((r) => this.iidx.get(r));
        this.fcRow = this.iidx.get("Nuclear_Fuel_Cell");
    }
    pushCol(col) {
        const rows = [...col.keys()].sort((a, b) => a - b);
        this.colRows.push(Int32Array.from(rows));
        this.colVals.push(Float64Array.from(rows.map((r) => col.get(r))));
    }
}
/** Column-wise sparse matrix builder. */
export class Columns {
    starts = [0];
    indices = [];
    values = [];
    lower = [];
    upper = [];
    cost = [];
    integer = [];
    add(rows, vals, lower, upper, cost = 0, integer = false) {
        for (let i = 0; i < rows.length; i++) {
            if (vals[i] !== 0) {
                this.indices.push(rows[i]);
                this.values.push(vals[i]);
            }
        }
        this.starts.push(this.indices.length);
        this.lower.push(lower);
        this.upper.push(upper);
        this.cost.push(cost);
        this.integer.push(integer ? 1 : 0);
        return this.lower.length - 1;
    }
    get count() {
        return this.lower.length;
    }
    model(H, numRows, rowLower, rowUpper, mip) {
        const C = H.constants;
        return {
            numCols: this.count,
            numRows,
            sense: C.objectiveSense.minimize,
            colCost: this.cost,
            colLower: this.lower,
            colUpper: this.upper,
            rowLower,
            rowUpper,
            matrix: {
                format: "csc", numRows, numCols: this.count,
                starts: this.starts, indices: this.indices, values: this.values,
            },
            ...(mip ? { integrality: this.integer.map((i) => (i ? C.variableType.integer : C.variableType.continuous)) } : {}),
        };
    }
}
//# sourceMappingURL=model.js.map