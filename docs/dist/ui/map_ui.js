// The map view, its buttons and legend.
import { MapView, DEPOSIT_STYLE, PLANT_STYLE } from "../map.js";
import { map_block, map_canvas, zoom_in_btn, zoom_out_btn, zoom_fit_btn, areas_box, legend, deposit_table, deposit_block, calc_link_world_a } from "./dom.js";
import { settings_now } from "./inputs.js";
import { calc_link_world } from "./calc_link.js";
import { RAW_ITEMS } from "../solver/data.js";
import { pretty } from "./format.js";
const view = new MapView(map_canvas);
export function show_world(world) {
    map_block.classList.remove("hidden");
    view.setWorld(world);
    show_deposits(world);
}
let shown = null;
// deposit tiles per resource
function show_deposits(world) {
    const d = world.deposits;
    const tiles = new Array(7).fill(0);
    for (let i = 0; i < d.count; i++) {
        const k = d.id[i] - 11;
        if (k >= 0 && k <= 6)
            tiles[k]++;
    }
    const head = `<tr><th></th><th class="num">Tiles</th></tr>`;
    const rows = RAW_ITEMS.map((item, k) => `<tr><td><img class="item-img" src="assets/${item}.png" alt="${pretty(item)}" title="${pretty(item)}"></td>` +
        `<td class="num">${tiles[k]}</td></tr>`).join("");
    deposit_table.innerHTML = head + rows;
    deposit_block.classList.remove("hidden");
    shown = { gen2: world.gen2, tiles };
    update_world_link();
}
/** the calculator link uses the settings at the moment it is opened */
function update_world_link() {
    if (shown)
        calc_link_world_a.href = calc_link_world(settings_now(), shown.gen2, shown.tiles);
}
export function show_plants(plants) {
    view.setPlants(plants);
}
function draw_legend() {
    const items = Object.values(DEPOSIT_STYLE).map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.coal.fill}"></i>Coal plant</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.nuclear.fill}"></i>Nuclear plant</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.coal.area};border-color:${PLANT_STYLE.coal.edge}"></i>Boost area</span>`);
    legend.innerHTML = items.join("");
}
export function init_map() {
    draw_legend();
    calc_link_world_a.addEventListener("click", update_world_link);
    zoom_in_btn.addEventListener("click", () => view.zoom(1.6));
    zoom_out_btn.addEventListener("click", () => view.zoom(1 / 1.6));
    zoom_fit_btn.addEventListener("click", () => view.fit());
    areas_box.addEventListener("change", () => { view.showAreas = areas_box.checked; view.draw(); });
}
//# sourceMappingURL=map_ui.js.map