// A second worker scores every reported layout exactly (the solver cannot while it searches).
// Every layout is scored, in order, one request at a time (a skipped one could have been the best).
import { WORKER_SCRIPT } from "./config.js";
let worker;
let busy = false;
let queue = [];
let token = {}; // changes with every new world; older answers are dropped
let seq = 0;
const pending = new Map();
export function init_evaluator() {
    worker = new Worker(WORKER_SCRIPT, { type: "module" });
    worker.onmessage = (e) => {
        const m = e.data;
        if (m.type !== "evaluated" && m.type !== "error")
            return;
        busy = false;
        const w = pending.get(m.id);
        pending.delete(m.id);
        if (m.type === "evaluated" && w && w.token === token)
            w.done(m.details, w.plants);
        if (m.type === "error")
            console.warn(m.message);
        pump();
    };
}
/** the world and settings the next layouts belong to */
export function set_evaluation_world(world, settings) {
    token = {};
    queue = [];
    worker.postMessage({ cmd: "world", world, settings });
}
export function evaluate(plants, done) {
    queue.push({ plants, done, token });
    pump();
}
function pump() {
    if (busy)
        return;
    let w = queue.shift();
    while (w && w.token !== token)
        w = queue.shift(); // skip layouts of an older world
    if (!w)
        return;
    busy = true;
    const id = ++seq;
    pending.set(id, w);
    worker.postMessage({ cmd: "evaluate", id, plants: w.plants });
}
//# sourceMappingURL=evaluator.js.map