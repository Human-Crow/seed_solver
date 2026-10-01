// The map view, its buttons and legend.
import { MapView, DEPOSIT_STYLE, PLANT_STYLE } from "../map.js";
import { map_block, map_canvas, zoom_in_btn, zoom_out_btn, zoom_fit_btn, areas_box, legend, deposit_table } from "./dom.js";
import { RAW_ITEMS } from "../solver/data.js";
import { pretty } from "./format.js";
const view = new MapView(map_canvas);
export function show_world(world) {
    map_block.classList.remove("hidden");
    view.setWorld(world);
    show_deposits(world);
}
// deposit tiles per resource, and how far the nearest one is from the middle of the world (0, 0)
function show_deposits(world) {
    const d = world.deposits;
    const tiles = new Array(7).fill(0), nearest = new Array(7).fill(Infinity);
    for (let i = 0; i < d.count; i++) {
        const k = d.id[i] - 11;
        if (k < 0 || k > 6)
            continue;
        tiles[k]++;
        nearest[k] = Math.min(nearest[k], Math.hypot(d.x[i], d.y[i]));
    }
    const head = `<tr><th></th><th class="num">Tiles</th><th class="num" title="Distance from the middle of the world">Nearest</th></tr>`;
    const rows = RAW_ITEMS.map((item, k) => `<tr><td><img class="item-img" src="assets/${item}.png" alt="${pretty(item)}" title="${pretty(item)}"></td>` +
        `<td class="num">${tiles[k]}</td><td class="num">${Number.isFinite(nearest[k]) ? Math.round(nearest[k]) : "–"}</td></tr>`).join("");
    deposit_table.innerHTML = head + rows;
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
    zoom_in_btn.addEventListener("click", () => view.zoom(1.6));
    zoom_out_btn.addEventListener("click", () => view.zoom(1 / 1.6));
    zoom_fit_btn.addEventListener("click", () => view.fit());
    areas_box.addEventListener("change", () => { view.showAreas = areas_box.checked; view.draw(); });
}
//# sourceMappingURL=map_ui.js.map