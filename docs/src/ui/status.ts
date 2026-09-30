// Status line and the Best / Proven max / Gap / Time numbers.

import { status_box, status_text, stat_best, stat_bound, stat_gap, stat_time } from "./dom.js";
import { fmt, fmt_gap, fmt_time } from "./format.js";

export function say(text: string, warn = false) {
    status_box.classList.remove("hidden");
    status_text.textContent = text;
    status_text.classList.toggle("note", warn);
    status_text.classList.toggle("help-note", !warn);
}

export function show_stats(best: number | undefined, bound: number | undefined) {
    stat_best.textContent = fmt(best);
    stat_bound.textContent = fmt(bound);
    const gap = best !== undefined && bound !== undefined && bound > 0 ? Math.max(0, (bound - best) / bound) : undefined;
    stat_gap.textContent = gap === undefined ? "–" : fmt_gap(gap);
}

export function show_time(sec: number | undefined) {
    stat_time.textContent = sec === undefined ? "–" : fmt_time(sec);
}
