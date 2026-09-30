// A second worker scores every reported layout exactly (the solver cannot while it searches).
// Only the newest layout is scored, one request at a time.

import type { LayoutDetails, Plant, SolverSettings, WorldInput } from "../solver/solve.js";
import { WORKER_SCRIPT } from "./config.js";

type Done = (details: LayoutDetails, plants: Plant[]) => void;

let worker: Worker;
let busy = false;
let wanted: { plants: Plant[]; done: Done; token: object } | null = null;
let token: object = {};            // changes with every new world; older answers are dropped
let seq = 0;
const pending = new Map<number, { plants: Plant[]; done: Done; token: object }>();

export function init_evaluator() {
    worker = new Worker(WORKER_SCRIPT, { type: "module" });
    worker.onmessage = (e) => {
        const m = e.data;
        if (m.type !== "evaluated" && m.type !== "error") return;
        busy = false;
        const w = pending.get(m.id);
        pending.delete(m.id);
        if (m.type === "evaluated" && w && w.token === token) w.done(m.details as LayoutDetails, w.plants);
        if (m.type === "error") console.warn(m.message);
        pump();
    };
}

/** the world and settings the next layouts belong to */
export function set_evaluation_world(world: WorldInput, settings: SolverSettings) {
    token = {};
    wanted = null;
    worker.postMessage({ cmd: "world", world, settings });
}

export function evaluate(plants: Plant[], done: Done) {
    wanted = { plants, done, token };
    pump();
}

function pump() {
    if (busy || !wanted) return;
    const w = wanted;
    wanted = null;
    if (w.token !== token) return;
    busy = true;
    const id = ++seq;
    pending.set(id, w);
    worker.postMessage({ cmd: "evaluate", id, plants: w.plants });
}
