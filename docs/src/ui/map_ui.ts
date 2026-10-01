// The map view, its buttons and legend.

import { MapView, DEPOSIT_STYLE, PLANT_STYLE } from "../map.js";
import type { World } from "../world_api.js";
import type { Plant } from "../solver/solve.js";
import { map_block, map_canvas, zoom_in_btn, zoom_out_btn, zoom_fit_btn, areas_box, map_hud, goto_x, goto_y, goto_btn, only_partial_box, only_partial_label, legend, deposit_table, deposit_block, calc_link_world_a } from "./dom.js";
import { settings_now } from "./inputs.js";
import { calc_link_world } from "./calc_link.js";
import { RAW_ITEMS } from "../solver/data.js";
import { pretty } from "./format.js";

const view = new MapView(map_canvas);

export function show_world(world: World) {
    map_block.classList.remove("hidden");
    view.setWorld(world);
    only_partial_label.classList.add("hidden");     // no plants yet
    only_partial_box.checked = false;
    view.onlyPartial = false;
    show_deposits(world);
}

let shown: { gen2: boolean; tiles: number[] } | null = null;

// deposit tiles per resource
function show_deposits(world: World) {
    const d = world.deposits;
    const tiles = new Array<number>(7).fill(0);
    for (let i = 0; i < d.count; i++) {
        const k = d.id[i]! - 11;
        if (k >= 0 && k <= 6) tiles[k]!++;
    }
    const head = `<tr><th></th><th class="num">Tiles</th></tr>`;
    const rows = RAW_ITEMS.map((item, k) =>
        `<tr><td><img class="item-img" src="assets/${item}.png" alt="${pretty(item)}" title="${pretty(item)}"></td>` +
        `<td class="num">${tiles[k]}</td></tr>`).join("");
    deposit_table.innerHTML = head + rows;
    deposit_block.classList.remove("hidden");
    shown = { gen2: world.gen2, tiles };
    update_world_link();
}

/** the calculator link uses the settings at the moment it is opened */
function update_world_link() {
    if (shown) calc_link_world_a.href = calc_link_world(settings_now(), shown.gen2, shown.tiles);
}

export function show_plants(plants: Plant[]) {
    // "Only partly powered" is only offered while the layout has partly powered plants
    const any = plants.some((p) => (p.power ?? 1) < 1);
    only_partial_label.classList.toggle("hidden", !any);
    if (!any) only_partial_box.checked = false;
    view.onlyPartial = only_partial_box.checked;
    view.setPlants(plants);
}

function draw_legend() {
    const items = Object.values(DEPOSIT_STYLE).map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.coal.fill}"></i>Coal plant</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.nuclear.fill}"></i>Nuclear plant</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.coal.area};border-color:${PLANT_STYLE.coal.edge}"></i>Boost area</span>`);
    legend.innerHTML = items.join("");
}

/** centre the map on a tile (also used by the partly powered table) */
export function go_to(x: number, y: number) {
    goto_x.value = String(x);
    goto_y.value = String(y);
    map_canvas.scrollIntoView({ behavior: "smooth", block: "center" });
    view.goTo(x, y);
}

function go_from_inputs() {
    // allow "211, 200" typed in the first box too
    const both = goto_x.value.match(/^\s*(-?\d+)\s*[, ]\s*(-?\d+)\s*$/);
    const x = both ? Number(both[1]) : parseInt(goto_x.value.trim(), 10);
    const y = both ? Number(both[2]) : parseInt(goto_y.value.trim(), 10);
    const bad = !Number.isFinite(x) || !Number.isFinite(y);
    goto_x.classList.toggle("input-bad", bad && !both && !Number.isFinite(x));
    goto_y.classList.toggle("input-bad", bad && !both && !Number.isFinite(y));
    if (!bad) go_to(x, y);
}

export function init_map() {
    draw_legend();
    view.onView = (x, y) => { map_hud.textContent = `Looking at ${x}, ${y}`; };
    goto_btn.addEventListener("click", go_from_inputs);
    for (const el of [goto_x, goto_y]) el.addEventListener("keydown", (e) => { if (e.key === "Enter") go_from_inputs(); });
    calc_link_world_a.addEventListener("click", update_world_link);
    zoom_in_btn.addEventListener("click", () => view.zoom(1.6));
    zoom_out_btn.addEventListener("click", () => view.zoom(1 / 1.6));
    zoom_fit_btn.addEventListener("click", () => view.fit());
    areas_box.addEventListener("change", () => { view.showAreas = areas_box.checked; view.draw(); });
    only_partial_box.addEventListener("change", () => { view.onlyPartial = only_partial_box.checked; view.draw(); });
}
