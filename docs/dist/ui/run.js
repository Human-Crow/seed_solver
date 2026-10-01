// One solve: get the world, run the solver worker, show progress and results, Stop.
import { fetch_world } from "../world_api.js";
import { seed_in, size_in, amount_in, gap_in, water_box, copy_link_btn, solve_btn, view_btn } from "./dom.js";
import { get_imported, import_warning } from "./import_world.js";
import { set_blueprint_world } from "./blueprint.js";
import { WORKER_SCRIPT } from "./config.js";
import { fmt_gap } from "./format.js";
import { get_version, set_running, settings_now } from "./inputs.js";
import { page_link } from "./url.js";
import { say, show_stats, show_time } from "./status.js";
import { hide_result, show_result } from "./result.js";
import { show_world, show_plants } from "./map_ui.js";
import { evaluate, set_evaluation_world } from "./evaluator.js";
let run = null;
const NO_WATER = { count: 0, x: new Int32Array(0), y: new Int32Array(0) };
/** the seed box is valid, or empty with an imported world */
function check_seed() {
    const seed = seed_in.value.trim();
    if (/^[0-9A-Za-z]{1,12}$/.test(seed) || (get_imported() && !seed))
        return true;
    say("Enter a seed as the game shows it (letters and digits).", true);
    return false;
}
/** get the world to show or solve: generated, or imported (then water + map come from the seed, if any) */
async function load_world() {
    const imported = get_imported();
    const seed = seed_in.value.trim();
    if (!imported)
        history.replaceState(null, "", page_link());
    copy_link_btn.classList.toggle("hidden", !!imported); // an imported world has no link
    say("Getting the world…");
    const request = { seed, size: Number(size_in.value), amount: Number(amount_in.value), version: get_version() };
    if (!imported) {
        try {
            return await fetch_world(request);
        }
        catch (e) {
            say(`Could not get the world: ${e instanceof Error ? e.message : e}`, true);
            return null;
        }
    }
    const world = {
        seed: 0, gen2: imported.gen2 ?? request.version === "ios2", size: request.size, amount: request.amount,
        deposits: imported.deposits, water: NO_WATER, map: null,
    };
    if (seed) {
        try {
            const gen = await fetch_world(request);
            world.water = gen.water;
            world.map = gen.map;
        }
        catch (e) {
            import_warning(`No water or map (could not get seed ${seed}: ${e instanceof Error ? e.message : e}).`);
        }
    }
    return world;
}
let viewing = false;
/** the Best / Proven max / Gap / Time numbers only mean something while solving */
const show_numbers = (on) => document.querySelector(".stat-grid")?.classList.toggle("hidden", !on);
/** "Show map": only get the world and show it, no solving */
export async function view() {
    if ((run && !run.finished) || viewing || !check_seed())
        return;
    viewing = true;
    show_numbers(false);
    view_btn.disabled = solve_btn.disabled = true;
    hide_result();
    show_stats(undefined, undefined);
    show_time(undefined);
    try {
        const world = await load_world();
        if (world) {
            show_world(world);
            say(`${world.deposits.count.toLocaleString("en-US")} deposit tiles. Press Solve to place power plants.`);
        }
    }
    finally {
        viewing = false;
        view_btn.disabled = solve_btn.disabled = false;
    }
}
export async function start() {
    if ((run && !run.finished) || viewing || !check_seed())
        return;
    const gapPct = Number(gap_in.value);
    if (!Number.isFinite(gapPct) || gapPct < 0) {
        say("The gap must be a number of 0 or more.", true);
        return;
    }
    const imported = get_imported(), seed = seed_in.value.trim();
    set_running(true);
    show_numbers(true);
    hide_result();
    set_blueprint_world(`Power Plants ${imported ? (seed || imported.file) : seed} ${size_in.value}% ${amount_in.value}%`);
    show_stats(undefined, undefined);
    show_time(undefined);
    const world = await load_world();
    if (!world) {
        set_running(false);
        return;
    }
    const input = { gen2: world.gen2, deposits: world.deposits, water: water_box.checked ? NO_WATER : world.water };
    const settings = settings_now();
    show_world(world);
    set_evaluation_world(input, settings);
    const r = {
        world, settings, solver: new Worker(WORKER_SCRIPT, { type: "module" }), t0: performance.now(), timer: 0,
        best: null, bound: Infinity, shown: -1, finished: false,
    };
    run = r;
    r.timer = window.setInterval(() => show_time((performance.now() - r.t0) / 1000), 500);
    say("Loading the solver…");
    r.solver.onmessage = (e) => on_solver(r, e.data);
    r.solver.onerror = (e) => finish(r, `Solver error: ${e.message}`, true);
    r.solver.postMessage({ cmd: "solve", world: input, settings, gap: gapPct / 100 });
}
function on_solver(r, m) {
    if (r !== run || r.finished)
        return;
    if (m.type === "progress") {
        say(String(m.message));
        if (typeof m.bound === "number")
            r.bound = Math.min(r.bound, m.bound);
        show_stats(r.shown >= 0 ? r.shown : undefined, Number.isFinite(r.bound) ? r.bound : undefined);
    }
    else if (m.type === "layout" || m.type === "done") {
        const rep = m.report;
        r.best = rep;
        r.bound = m.type === "done" ? rep.bound : Math.min(r.bound, rep.bound);
        show_plants(rep.plants);
        evaluate(rep.plants, (d, plants) => on_details(r, d, plants));
        if (m.type === "done") {
            const gap = rep.bound > 0 ? (rep.bound - rep.score) / rep.bound : 0;
            finish(r, gap <= 1e-9 ? "Done: this is the best layout (proven)." :
                `Done: proven to be within ${fmt_gap(gap)} of the best possible.`);
        }
    }
    else if (m.type === "error") {
        finish(r, `Solver error: ${m.message}`, true);
    }
}
export function stop() {
    const r = run;
    if (!r || r.finished)
        return;
    if (!r.best) {
        finish(r, "Stopped before a layout was found.", true);
        return;
    }
    const best = Math.max(r.shown, r.best.score);
    const gap = r.bound > 0 && Number.isFinite(r.bound) ? Math.max(0, (r.bound - best) / r.bound) : undefined;
    finish(r, gap === undefined ? "Stopped: showing the best layout found so far." :
        `Stopped: the layout below is within ${fmt_gap(gap)} of the proven maximum.`);
}
function finish(r, message, warn = false) {
    r.finished = true;
    r.solver.terminate();
    clearInterval(r.timer);
    show_time((performance.now() - r.t0) / 1000);
    set_running(false);
    say(message, warn);
}
// the exact score of a layout arrived (layouts can arrive out of order: keep the best)
function on_details(r, d, plants) {
    if (r !== run || d.score + 1e-12 < r.shown)
        return;
    r.shown = d.score;
    show_stats(d.score, Number.isFinite(r.bound) ? Math.max(r.bound, d.score) : undefined);
    show_result(r.settings, r.world.gen2, d, plants);
}
//# sourceMappingURL=run.js.map