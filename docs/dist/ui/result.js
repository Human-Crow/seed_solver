// Result block: score, power plants, deposits per resource and the calculator link.
import { RAW_ITEMS } from "../solver/data.js";
import { result_block, result_img, result_score, result_note, boost_table, calc_link_a } from "./dom.js";
import { fmt, pretty } from "./format.js";
import { calc_link } from "./calc_link.js";
export function hide_result() {
    result_block.classList.add("hidden");
}
export function show_result(settings, gen2, d, plants) {
    result_block.classList.remove("hidden");
    const target = settings.target;
    result_img.src = `assets/${target}.png`;
    result_score.textContent = `${fmt(d.score)} ${pretty(target)} per minute`;
    const ncoal = plants.filter((p) => p.kind === "coal").length, nnuc = plants.length - ncoal;
    const removed = Object.values(d.boosts).reduce((s, b) => s + b.removed, 0);
    result_note.textContent = settings.boost
        ? `${ncoal} coal and ${nnuc} nuclear power plants${removed ? `, ${removed} deposit tile${removed > 1 ? "s" : ""} built over` : ""}.`
        : "Without power plants.";
    const head = `<tr><th></th><th class="num">Extractors</th><th class="num color-green">Nuclear</th>` +
        `<th class="num color-yellow">Coal</th><th class="num">None</th><th class="num color-red">Built over</th></tr>`;
    const rows = RAW_ITEMS.map((item) => {
        const b = d.boosts[item];
        const ex = b.nuclear + b.coal + b.none;
        if (!ex && !b.removed)
            return "";
        return `<tr><td><img class="item-img" src="assets/${item}.png" alt="${pretty(item)}" title="${pretty(item)}"></td>` +
            `<td class="num">${ex}</td><td class="num color-green">${b.nuclear}</td><td class="num color-yellow">${b.coal}</td>` +
            `<td class="num">${b.none}</td><td class="num color-red">${b.removed}</td></tr>`;
    }).join("");
    boost_table.innerHTML = head + rows;
    calc_link_a.href = calc_link(settings, gen2, d, ncoal, nnuc);
}
//# sourceMappingURL=result.js.map