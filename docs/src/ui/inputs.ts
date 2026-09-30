// Inputs: item picker, +/- buttons, version buttons, and reading the solver settings.

import { RECIPES, RAW_ITEMS } from "../solver/data.js";
import type { SolverSettings } from "../solver/solve.js";
import type { Version } from "../world_api.js";
import {
    seed_in, size_in, amount_in, tier_in, tier_img, gap_in, alt_box, boost_box, water_box, item_sel, fake_sel,
    solve_btn, stop_btn, import_btn, import_clear_btn,
} from "./dom.js";
import { pretty } from "./format.js";

let version: Version = "steam";

export function get_version(): Version {
    return version;
}

export function set_version(v: Version) {
    version = v;
    document.querySelectorAll<HTMLButtonElement>(".version-btn").forEach((b) => b.classList.toggle("active", b.dataset.version === v));
}

export function settings_now(): SolverSettings {
    return {
        tier: Math.min(5, Math.max(1, Math.round(Number(tier_in.value)) || 5)),
        alt: alt_box.checked,
        boost: boost_box.checked,
        target: item_sel.value,
    };
}

/** disable the inputs while solving; swap Solve / Stop */
export function set_running(on: boolean) {
    solve_btn.classList.toggle("hidden", on);
    stop_btn.classList.toggle("hidden", !on);
    for (const el of [seed_in, size_in, amount_in, tier_in, gap_in, alt_box, boost_box, water_box, import_btn, import_clear_btn]) el.disabled = on;
    document.querySelectorAll<HTMLButtonElement>(".version-btn, .mp-input-btn").forEach((b) => (b.disabled = on));
}


function fill_items() {
    const names = new Set<string>(RAW_ITEMS);
    for (const [item] of RECIPES) names.add(item);
    names.delete("Coal_Power_Plant");
    names.delete("Nuclear_Power_Plant");
    for (const name of [...names].sort()) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = pretty(name);
        if (name === "Earth_Token") o.selected = true;
        item_sel.appendChild(o);
    }
}

// item picker with icons (same look as the Alt Calculator)
function init_fake_select() {
    const selected = fake_sel.querySelector<HTMLButtonElement>(".selected")!;
    const options = fake_sel.querySelector<HTMLDivElement>(".options")!;
    const html = (o: HTMLOptionElement) => `<img src="assets/${o.value}.png" alt=""><span>${o.textContent}</span>`;
    const render = () => {
        const o = item_sel.selectedOptions[0];
        if (o) selected.innerHTML = html(o);
    };
    for (const o of item_sel.options) {
        const div = document.createElement("div");
        div.className = "option";
        div.innerHTML = html(o);
        div.addEventListener("click", () => {
            item_sel.value = o.value;
            render();
            fake_sel.classList.remove("open");
            item_sel.dispatchEvent(new Event("change"));
        });
        options.appendChild(div);
    }
    selected.addEventListener("click", (e) => {
        e.stopPropagation();
        fake_sel.classList.toggle("open");
    });
    document.addEventListener("click", (e) => {
        if (e.target instanceof Node && !fake_sel.contains(e.target)) fake_sel.classList.remove("open");
    });
    item_sel.addEventListener("change", render);
    render();
}

// +/- buttons; data-values="50,75,..." steps through a fixed list
function init_min_plus() {
    document.querySelectorAll<HTMLElement>(".min-plus-input").forEach((wrap) => {
        const input = wrap.querySelector<HTMLInputElement>(".mp-input-field")!;
        const values = input.dataset.values?.split(",").map(Number);
        const step = (dir: 1 | -1) => {
            const v = Number(input.value);
            if (values) {
                const next = dir > 0 ? values.find((x) => x > v) : [...values].reverse().find((x) => x < v);
                if (next !== undefined) input.value = String(next);
            } else if (dir > 0) {
                input.stepUp();
            } else {
                input.stepDown();
            }
            input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        wrap.querySelector('[data-action="decrease"]')!.addEventListener("click", () => step(-1));
        wrap.querySelector('[data-action="increase"]')!.addEventListener("click", () => step(1));
    });
    tier_in.addEventListener("change", () => {
        const t = Math.min(5, Math.max(1, Math.round(Number(tier_in.value)) || 5));
        tier_in.value = String(t);
        tier_img.src = `assets/Extractor_${t}.png`;
    });
}

export function init_inputs() {
    fill_items();
    init_fake_select();
    init_min_plus();
    document.querySelectorAll<HTMLButtonElement>(".version-btn").forEach((b) =>
        b.addEventListener("click", () => set_version(b.dataset.version as Version)));
}
