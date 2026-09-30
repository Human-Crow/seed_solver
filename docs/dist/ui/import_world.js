// Importing your own world from a text file: settings lines plus one deposit per line.
//
//   seed: Q1            (base62, as the game shows it; optional, used to get water and the map)
//   size: 50            (optional)
//   amount: 100         (optional, also "resources:")
//   gen2: 0             (optional: 1/0, true/false, yes/no)
//   platform: steam     (optional: steam or ios)
//   Wood, 10, -3        (resource name or id 11-17, then x, y)
//   13 4 5
//
// Commas, semicolons, tabs or spaces separate the values. Lines starting with # are ignored.
// The CSV from the Builderment Seed Map page (header "x,y,resource") also works.
import { seed_in, size_in, amount_in, import_btn, import_file, import_clear_btn, import_note } from "./dom.js";
import { get_version, set_version } from "./inputs.js";
const NAME_TO_ID = {
    wood: 11, stone: 12, iron: 13, copper: 14, coal: 15, wolframite: 16, tungsten: 16, uranium: 17,
};
function resource_id(token) {
    const t = token.trim();
    if (/^\d+$/.test(t)) {
        const n = Number(t);
        return n >= 11 && n <= 17 ? n : null;
    }
    const key = t.toLowerCase().replace(/[\s_-]+/g, "").replace(/ore$/, "");
    return NAME_TO_ID[key] ?? null;
}
const is_int = (t) => /^[+-]?\d+$/.test(t.trim());
function parse_bool(v) {
    const t = v.trim().toLowerCase();
    if (["1", "true", "yes", "y", "on"].includes(t))
        return true;
    if (["0", "false", "no", "n", "off"].includes(t))
        return false;
    return null;
}
/** parse the text; throws an Error with a readable message when something is wrong */
export function parse_world_text(text, file = "world.txt") {
    const out = { file, seed: null, size: null, amount: null, gen2: null, platform: null, deposits: { count: 0, id: new Uint8Array(0), x: new Int32Array(0), y: new Int32Array(0) }, duplicates: 0 };
    const ids = [], xs = [], ys = [];
    const bad = [];
    // column order for all-number lines: resource, x, y unless a header says otherwise
    let order = ["r", "x", "y"];
    const lines = text.replace(/^﻿/, "").split(/\r?\n/);
    lines.forEach((raw, n) => {
        const line = raw.replace(/(^|\s)(#|\/\/).*$/, "").trim();
        if (!line)
            return;
        const kv = line.match(/^(seed|size|world\s*size|amount|resources?|res|gen2|gen|platform|version)\s*[:=]\s*(.*)$/i);
        if (kv) {
            const key = kv[1].toLowerCase().replace(/\s+/g, ""), val = kv[2].trim();
            if (key === "seed") {
                if (!/^[0-9A-Za-z]{1,12}$/.test(val))
                    throw new Error(`Line ${n + 1}: the seed must be letters and digits, as the game shows it.`);
                out.seed = val;
            }
            else if (key === "size" || key === "worldsize") {
                out.size = Number(val.replace("%", ""));
                if (!Number.isFinite(out.size))
                    throw new Error(`Line ${n + 1}: size must be a number.`);
            }
            else if (key === "gen2") {
                out.gen2 = parse_bool(val);
                if (out.gen2 === null)
                    throw new Error(`Line ${n + 1}: gen2 must be 1 or 0 (or true / false).`);
            }
            else if (key === "gen") {
                if (!["1", "2"].includes(val))
                    throw new Error(`Line ${n + 1}: gen must be 1 or 2.`);
                out.gen2 = val === "2";
            }
            else if (key === "platform" || key === "version") {
                const v = val.toLowerCase();
                if (v === "steam" || v === "pc")
                    out.platform = "steam";
                else if (v === "ios" || v === "ios1")
                    out.platform = "ios";
                else if (v === "ios2") {
                    out.platform = "ios";
                    out.gen2 = true;
                }
                else
                    throw new Error(`Line ${n + 1}: platform must be steam or ios.`);
            }
            else {
                out.amount = Number(val.replace("%", ""));
                if (!Number.isFinite(out.amount))
                    throw new Error(`Line ${n + 1}: amount must be a number.`);
            }
            return;
        }
        let fields = line.split(/\s*[,;\t]\s*/).filter((f) => f !== "");
        if (fields.length < 3)
            fields = line.split(/\s+/);
        if (fields.length > 3) {
            // "Iron Ore 4 5": glue the words back together
            const nums = fields.filter(is_int), words = fields.filter((f) => !is_int(f));
            fields = nums.length === 2 ? [words.join(" "), nums[0], nums[1]] : fields;
        }
        if (fields.length !== 3) {
            bad.push(n + 1);
            return;
        }
        // header line such as "x,y,resource"
        const lower = fields.map((f) => f.toLowerCase());
        if (lower.every((f) => ["x", "y", "resource", "deposit", "type", "id", "name"].includes(f))) {
            order = lower.map((f) => (f === "x" ? "x" : f === "y" ? "y" : "r"));
            return;
        }
        let r, x, y;
        const words = fields.filter((f) => !is_int(f));
        if (words.length === 1) {
            r = words[0];
            const nums = fields.filter(is_int);
            // keep x before y in the order they appear
            [x, y] = [nums[0], nums[1]];
        }
        else if (words.length === 0) {
            const get = (c) => fields[order.indexOf(c)];
            r = get("r");
            x = get("x");
            y = get("y");
        }
        else {
            bad.push(n + 1);
            return;
        }
        const id = resource_id(r);
        if (id === null || !is_int(x) || !is_int(y)) {
            bad.push(n + 1);
            return;
        }
        ids.push(id);
        xs.push(Number(x));
        ys.push(Number(y));
    });
    if (bad.length) {
        const shown = bad.slice(0, 5).join(", ") + (bad.length > 5 ? ` and ${bad.length - 5} more` : "");
        throw new Error(`Could not read line ${shown}. Use: resource, x, y (resource as a name like Iron or an id 11-17).`);
    }
    if (!ids.length)
        throw new Error("No deposits found in the file.");
    if (ids.length > 500000)
        throw new Error("Too many deposits (more than 500,000).");
    // one deposit per tile: a later line replaces an earlier one
    const at = new Map();
    for (let i = 0; i < ids.length; i++)
        at.set(`${xs[i]},${ys[i]}`, i);
    const keep = [...at.values()].sort((a, b) => a - b);
    out.duplicates = ids.length - keep.length;
    out.deposits = {
        count: keep.length,
        id: Uint8Array.from(keep, (i) => ids[i]),
        x: Int32Array.from(keep, (i) => xs[i]),
        y: Int32Array.from(keep, (i) => ys[i]),
    };
    return out;
}
let imported = null;
export function get_imported() {
    return imported;
}
/** the version to use for an imported world: the file decides where it can, otherwise the buttons */
export function imported_version(w, current) {
    if (w.gen2)
        return "ios2";
    if (w.platform === "steam")
        return "steam";
    if (w.platform === "ios")
        return "ios1";
    if (w.gen2 === false && current === "ios2")
        return "ios1";
    return current;
}
/** add a warning below the import note (e.g. water unknown) */
export function import_warning(text) {
    const base = import_note.dataset.base ?? import_note.textContent ?? "";
    import_note.dataset.base = base;
    show_note(`${base} ${text}`.trim(), true);
}
function show_note(text, warn = false) {
    import_note.textContent = text;
    import_note.classList.toggle("color-red", warn);
    import_note.classList.toggle("hidden", !text);
}
function use(w) {
    imported = w;
    seed_in.value = w.seed ?? ""; // no seed: water and map stay unknown unless you type one
    if (w.size !== null)
        size_in.value = String(w.size);
    if (w.amount !== null)
        amount_in.value = String(w.amount);
    set_version(imported_version(w, get_version()));
    import_clear_btn.classList.remove("hidden");
    const extra = [
        w.duplicates ? `${w.duplicates} duplicate tiles dropped` : "",
        w.seed ? "" : "no seed: type it above to get water and the map, otherwise power plants may be placed on water",
    ].filter(Boolean).join("; ");
    delete import_note.dataset.base;
    show_note(`Using ${w.file}: ${w.deposits.count.toLocaleString("en-US")} deposit tiles` + (extra ? ` (${extra}).` : "."));
}
export function clear_import() {
    imported = null;
    import_clear_btn.classList.add("hidden");
    delete import_note.dataset.base;
    show_note("");
}
export function init_import() {
    import_btn.addEventListener("click", () => import_file.click());
    import_file.addEventListener("change", async () => {
        const f = import_file.files?.[0];
        import_file.value = "";
        if (!f)
            return;
        try {
            use(parse_world_text(await f.text(), f.name));
        }
        catch (e) {
            show_note(`Could not import ${f.name}: ${e instanceof Error ? e.message : e}`, true);
        }
    });
    import_clear_btn.addEventListener("click", clear_import);
}
//# sourceMappingURL=import_world.js.map