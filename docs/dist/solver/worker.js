// Web Worker running the exact solver (and, in a second instance, exact scoring of layouts).
// Messages in:  {cmd: "solve", world, settings, gap} | {cmd: "world", world, settings} | {cmd: "evaluate", id, plants}
// Messages out: {type: "ready"} | {type: "progress", ...} | {type: "layout", report} | {type: "done", report}
//               | {type: "evaluated", id, details} | {type: "error", message}
import { solve, evaluate_layout } from "./solve.js";
const LIB = new URL("../../lib/", import.meta.url);
const VERSION = new URL(import.meta.url).searchParams.get("v") ?? "1";
async function load_highs() {
    // highs.js is a classic script defining `Module`; module workers cannot importScripts it
    const code = await (await fetch(new URL(`highs.js?v=${VERSION}`, LIB))).text();
    const factory = new Function(`${code}\nreturn Module;`)();
    return factory({ locateFile: (file) => new URL(`${file}?v=${VERSION}`, LIB).href });
}
const highs = load_highs();
highs.then(() => self.postMessage({ type: "ready" }), (e) => self.postMessage({ type: "error", message: `Could not load the solver: ${e}` }));
let evalWorld = null;
let evalSettings = null;
self.onmessage = async (event) => {
    const msg = event.data;
    try {
        const H = await highs;
        if (msg.cmd === "solve") {
            const report = solve(H, msg.world, msg.settings, msg.gap, {
                progress: (p) => self.postMessage({ type: "progress", ...p }),
                layout: (l) => self.postMessage({ type: "layout", report: l }),
            });
            self.postMessage({ type: "done", report });
        }
        else if (msg.cmd === "world") {
            evalWorld = msg.world;
            evalSettings = msg.settings;
        }
        else if (msg.cmd === "evaluate") {
            if (!evalWorld || !evalSettings)
                throw new Error("No world to evaluate");
            const details = evaluate_layout(H, evalWorld, evalSettings, msg.plants);
            self.postMessage({ type: "evaluated", id: msg.id, details });
        }
    }
    catch (e) {
        self.postMessage({ type: "error", message: e instanceof Error ? e.message : String(e) });
    }
};
//# sourceMappingURL=worker.js.map