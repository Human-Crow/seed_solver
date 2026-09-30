// "Make Blueprint": turns the power plant layout into a Builderment blueprint with the worker's
// writeBlp + uploadBlp (the same methods the other blueprint pages use), then shows its id and link.

import type { Plant } from "../solver/solve.js";
import { DEFAULT_WORKER } from "../world_api.js";
import { blp_btn, blp_box, blp_id, blp_link, blp_note } from "./dom.js";

// ids and orientations as in the worker (src/methods/blp_edit/enums.ts)
const COAL_POWER_PLANT = 3038;
const NUCLEAR_POWER_PLANT = 3039;
const NORTH = 0;
const EAST = 3;

interface Buildings {
    count: number;
    id: Uint16Array;
    x: Int32Array;
    y: Int32Array;
    o: Uint8Array;
    tier: Uint8Array;
    rec_fil: Int16Array;
    color: Uint32Array;
    text: string[];
}

interface SaveFile {
    name: string;
    link: string;
    buildings: Buildings;
}

interface BlpApi {
    writeBlp(worker: string, blp: SaveFile): Promise<ArrayBuffer>;
    uploadBlp(worker: string, data: ArrayBuffer): Promise<{ id: string; url: string }>;
}

let api: Promise<BlpApi> | null = null;

function load_api(): Promise<BlpApi> {
    api ??= import(`${DEFAULT_WORKER}/api.js`) as Promise<BlpApi>;
    api.catch(() => (api = null));          // try again next time
    return api;
}

/** a building's position in a blueprint is its pivot, not the footprint's top-left tile */
export function make_builds(plants: Plant[]): Buildings {
    const n = plants.length;
    const b: Buildings = {
        count: n,
        id: new Uint16Array(n),
        x: new Int32Array(n),
        y: new Int32Array(n),
        o: new Uint8Array(n),
        tier: new Uint8Array(n),
        rec_fil: new Int16Array(n),
        color: new Uint32Array(n),
        text: new Array<string>(n).fill(""),
    };
    plants.forEach((p, i) => {
        let { x, y } = p, o = NORTH;
        if (p.kind === "coal") {
            x += 1; y += 1;
        } else if (p.h > p.w) {
            x += 1; y += 2;
        } else {
            o = EAST;
            x += 1; y += 1;
        }
        b.id[i] = p.kind === "coal" ? COAL_POWER_PLANT : NUCLEAR_POWER_PLANT;
        b.x[i] = x;
        b.y[i] = y;
        b.o[i] = o;
    });
    return b;
}


let plants: Plant[] = [];
let name = "Power Plants";
let made = new Map<string, { id: string; url: string }>();     // layout -> uploaded blueprint
let busy = false;

const key = (ps: Plant[]) => ps.map((p) => `${p.kind[0]}${p.x},${p.y},${p.w}`).join(";");

function show(result: { id: string; url: string } | null) {
    blp_box.classList.toggle("hidden", !result);
    if (!result) return;
    blp_id.textContent = result.id;
    blp_link.href = result.url;
    blp_link.textContent = result.url;
}

function note(text: string, warn = false) {
    blp_note.textContent = text;
    blp_note.classList.toggle("hidden", !text);
    blp_note.classList.toggle("color-red", warn);
}

/** a new world: blueprints of the old one no longer apply */
export function set_blueprint_world(world_name: string) {
    name = world_name;
    made = new Map();
    set_blueprint_plants([]);
}

/** the layout shown on the page changed */
export function set_blueprint_plants(ps: Plant[]) {
    plants = ps;
    blp_btn.classList.toggle("hidden", !ps.length);
    show(made.get(key(ps)) ?? null);
    if (!busy) note("");
}

async function make() {
    if (busy || !plants.length) return;
    const ps = plants, k = key(ps);
    const done = made.get(k);
    if (done) { show(done); return; }
    busy = true;
    blp_btn.disabled = true;
    note("Making the blueprint…");
    try {
        const { writeBlp, uploadBlp } = await load_api();
        const buffer = await writeBlp(DEFAULT_WORKER, { name, link: "", buildings: make_builds(ps) });
        const result = await uploadBlp(DEFAULT_WORKER, buffer);
        made.set(k, result);
        note("");
        if (plants === ps) show(result);
    } catch (e) {
        note(`Could not make the blueprint: ${e instanceof Error ? e.message : e}`, true);
    } finally {
        busy = false;
        blp_btn.disabled = false;
    }
}

export function init_blueprint() {
    blp_btn.addEventListener("click", () => void make());
}
