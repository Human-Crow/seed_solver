// The map view, its buttons and legend.

import { MapView, DEPOSIT_STYLE, PLANT_STYLE } from "../map.js";
import type { World } from "../world_api.js";
import type { Plant } from "../solver/solve.js";
import { map_block, map_canvas, zoom_in_btn, zoom_out_btn, zoom_fit_btn, areas_box, legend } from "./dom.js";

const view = new MapView(map_canvas);

export function show_world(world: World) {
    map_block.classList.remove("hidden");
    view.setWorld(world);
}

export function show_plants(plants: Plant[]) {
    view.setPlants(plants);
}

function draw_legend() {
    const items = Object.values(DEPOSIT_STYLE).map((s) => `<span><i style="background:${s.color}"></i>${s.name}</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.coal.fill}"></i>Coal plant</span>`);
    items.push(`<span><i style="background:${PLANT_STYLE.nuclear.fill}"></i>Nuclear plant</span>`);
    legend.innerHTML = items.join("");
}

export function init_map() {
    draw_legend();
    zoom_in_btn.addEventListener("click", () => view.zoom(1.6));
    zoom_out_btn.addEventListener("click", () => view.zoom(1 / 1.6));
    zoom_fit_btn.addEventListener("click", () => view.fit());
    areas_box.addEventListener("change", () => { view.showAreas = areas_box.checked; view.draw(); });
}
