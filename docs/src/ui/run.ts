// One solve: get the world, run the solver worker, show progress and results, Stop.

import { fetch_world, type World } from "../world_api.js";
import type { LayoutDetails, LayoutReport, Plant, SolverSettings, WorldInput } from "../solver/solve.js";
import { seed_in, size_in, amount_in, gap_in } from "./dom.js";
import { WORKER_SCRIPT } from "./config.js";
import { fmt_gap } from "./format.js";
import { get_version, set_running, settings_now } from "./inputs.js";
import { page_link } from "./url.js";
import { say, show_stats, show_time } from "./status.js";
import { hide_result, show_result } from "./result.js";
import { show_world, show_plants } from "./map_ui.js";
import { evaluate, set_evaluation_world } from "./evaluator.js";

interface Run {
    world: World;
    settings: SolverSettings;
    solver: Worker;
    t0: number;
    timer: number;
    best: LayoutReport | null;          // latest layout from the solver
    bound: number;                      // proven maximum so far
    shown: number;                      // best exact score shown
    finished: boolean;
}

let run: Run | null = null;

export async function start() {
    if (run && !run.finished) return;
    const seed = seed_in.value.trim();
    if (!/^[0-9A-Za-z]{1,12}$/.test(seed)) {
        say("Enter a seed as the game shows it (letters and digits).", true);
        return;
    }
    const gapPct = Number(gap_in.value);
    if (!Number.isFinite(gapPct) || gapPct < 0) {
        say("The gap must be a number of 0 or more.", true);
        return;
    }
    history.replaceState(null, "", page_link());
    set_running(true);
    hide_result();
    show_stats(undefined, undefined);
    show_time(undefined);
    say("Getting the world…");
    let world: World;
    try {
        world = await fetch_world({ seed, size: Number(size_in.value), amount: Number(amount_in.value), version: get_version() });
    } catch (e) {
        set_running(false);
        say(`Could not get the world: ${e instanceof Error ? e.message : e}`, true);
        return;
    }
    const input: WorldInput = { gen2: world.gen2, deposits: world.deposits, water: world.water };
    const settings = settings_now();
    show_world(world);
    set_evaluation_world(input, settings);

    const r: Run = {
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

function on_solver(r: Run, m: { type: string; [k: string]: unknown }) {
    if (r !== run || r.finished) return;
    if (m.type === "progress") {
        say(String(m.message));
        if (typeof m.bound === "number") r.bound = Math.min(r.bound, m.bound);
        show_stats(r.shown >= 0 ? r.shown : undefined, Number.isFinite(r.bound) ? r.bound : undefined);
    } else if (m.type === "layout" || m.type === "done") {
        const rep = m.report as LayoutReport;
        r.best = rep;
        r.bound = m.type === "done" ? rep.bound : Math.min(r.bound, rep.bound);
        show_plants(rep.plants);
        evaluate(rep.plants, (d, plants) => on_details(r, d, plants));
        if (m.type === "done") {
            const gap = rep.bound > 0 ? (rep.bound - rep.score) / rep.bound : 0;
            finish(r, gap <= 1e-9 ? "Done: this is the best layout (proven)." :
                `Done: proven to be within ${fmt_gap(gap)} of the best possible.`);
        }
    } else if (m.type === "error") {
        finish(r, `Solver error: ${m.message}`, true);
    }
}

export function stop() {
    const r = run;
    if (!r || r.finished) return;
    if (!r.best) {
        finish(r, "Stopped before a layout was found.", true);
        return;
    }
    const best = Math.max(r.shown, r.best.score);
    const gap = r.bound > 0 && Number.isFinite(r.bound) ? Math.max(0, (r.bound - best) / r.bound) : undefined;
    finish(r, gap === undefined ? "Stopped: showing the best layout found so far." :
        `Stopped: the layout below is within ${fmt_gap(gap)} of the proven maximum.`);
}

function finish(r: Run, message: string, warn = false) {
    r.finished = true;
    r.solver.terminate();
    clearInterval(r.timer);
    show_time((performance.now() - r.t0) / 1000);
    set_running(false);
    say(message, warn);
}

// the exact score of a layout arrived (layouts can arrive out of order: keep the best)
function on_details(r: Run, d: LayoutDetails, plants: Plant[]) {
    if (r !== run || d.score + 1e-12 < r.shown) return;
    r.shown = d.score;
    show_stats(d.score, Number.isFinite(r.bound) ? Math.max(r.bound, d.score) : undefined);
    show_result(r.settings, r.world.gen2, d, plants);
}
