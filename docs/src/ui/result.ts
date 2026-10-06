// Result block: score, power plants, deposits per resource and the calculator link.

import { RAW_ITEMS } from "../solver/data.js";
import type { LayoutDetails, Plant, SolverSettings } from "../solver/solve.js";
import { result_block, result_img, result_score, result_note, partial_note, boost_table, calc_link_a, deposit_block } from "./dom.js";
import { fmt, pretty } from "./format.js";
import { calc_link } from "./calc_link.js";
import { set_blueprint_plants, make_builds } from "./blueprint.js";
import { go_to } from "./map_ui.js";

export function hide_result() {
    result_block.classList.add("hidden");
}

export function show_result(settings: SolverSettings, gen2: boolean, d: LayoutDetails, plants: Plant[]) {
    result_block.classList.remove("hidden");
    deposit_block.classList.add("hidden");     // one table at a time: the boost table has the same rows
    const target = settings.target;
    result_img.src = `assets/${target}.png`;
    result_score.textContent = `${fmt(d.score)} ${pretty(target)} per minute`;
    const ncoal = plants.filter((p) => p.kind === "coal").length, nnuc = plants.length - ncoal;
    const removed = Object.values(d.boosts).reduce((s, b) => s + b.removed, 0);     // built over or enclosed
    const removedNote = removed ? `${removed} deposit tile${removed > 1 ? "s" : ""} removed` : "";
    const partly = plants.filter((p) => (p.power ?? 1) < 1);
    result_note.textContent = settings.boost
        ? `${ncoal} coal and ${nnuc} nuclear power plants${removedNote ? `, ${removedNote}` : ""}.`
        : `Without power plants${removedNote ? `, ${removedNote}` : ""}.`;
    // with "Partly powered plants" on: always say how many are used
    const showPartial = settings.boost && !!settings.partial;
    partial_note.classList.toggle("hidden", !showPartial);
    if (showPartial) {
        partial_note.innerHTML = partial_table(partly);
        // "Go to" (or anywhere on the row): the map jumps to that plant
        partial_note.querySelectorAll<HTMLTableRowElement>("tr[data-x]").forEach((tr) =>
            tr.addEventListener("click", () => go_to(Number(tr.dataset.x), Number(tr.dataset.y))));
    }
    // fuel actually burnt: partly powered plants count for their share (for the calculator)
    const run = (kind: Plant["kind"]) => plants.reduce((a, p) => a + (p.kind === kind ? p.power ?? 1 : 0), 0);

    const head = `<tr><th></th><th class="num">Extractors</th><th class="num color-green">Nuclear</th>` +
        `<th class="num color-yellow">Coal</th><th class="num">None</th><th class="num color-red" title="Built over by a power plant, or enclosed: all four sides deposits or water, so an extractor there cannot be used">Removed</th></tr>`;
    // partly powered plants boost part of the time: those extractors count as fractions
    const n = (v: number) => { const r = Math.round(v * 10) / 10; return Number.isInteger(r) ? String(r) : r.toFixed(1); };
    const rows = RAW_ITEMS.map((item) => {
        const b = d.boosts[item]!;
        const ex = Math.round(b.nuclear + b.coal + b.none);
        if (!ex && !b.removed) return "";
        return `<tr><td><img class="item-img" src="assets/${item}.png" alt="${pretty(item)}" title="${pretty(item)}"></td>` +
            `<td class="num">${ex}</td><td class="num color-green">${n(b.nuclear)}</td><td class="num color-yellow">${n(b.coal)}</td>` +
            `<td class="num">${n(b.none)}</td><td class="num color-red">${b.removed}</td></tr>`;
    }).join("");
    boost_table.innerHTML = head + rows;
    calc_link_a.href = calc_link(settings, gen2, d, run("coal"), run("nuclear"));
    set_blueprint_plants(plants);
}


/**
 * Partly powered plants: their power share (not rounded: 4 decimals) and position as in the game / blueprint
 * (the building's position, the same as make_builds gives).
 */
function partial_table(partly: Plant[]): string {
    if (!partly.length) return `<p class="partial-none">No partly powered power plants used.</p>`;
    const pos = make_builds(partly);
    const pct = (v: number) => `${(v * 100).toFixed(4).replace(/\.?0+$/, "")}%`;
    const rows = partly.map((p, i) => {
        const item = p.kind === "coal" ? "Coal_Power_Plant" : "Nuclear_Power_Plant";
        return `<tr class="goto-row-link" data-x="${pos.x[i]}" data-y="${pos.y[i]}" title="Show on the map"><td><img class="item-img" src="assets/${item}.png" alt="${pretty(item)}" title="${pretty(item)}"></td>` +
            `<td class="num">${pct(p.power!)}</td><td class="num">${pos.x[i]}</td><td class="num">${pos.y[i]}</td>` +
            `<td class="goto-cell"><button class="button partial-goto-btn" type="button">Go to</button></td></tr>`;
    }).join("");
    return `<table class="item-boosts partial-table"><tr><th></th><th class="num">Power</th><th class="num">X</th><th class="num">Y</th><th></th></tr>${rows}</table>`;
}
