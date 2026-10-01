// Inputs: item picker, +/- buttons, version buttons, and reading the solver settings.
import { RECIPES, RAW_ITEMS } from "../solver/data.js";
import { seed_in, tier_in, tier_img, gap_in, alt_box, boost_box, water_box, partial_box, item_sel, fake_sel, solve_btn, stop_btn, view_btn, import_btn, import_clear_btn, random_btn, } from "./dom.js";
import { pretty } from "./format.js";
let version = "steam";
export function get_version() {
    return version;
}
export function set_version(v) {
    version = v;
    document.querySelectorAll(".version-btn").forEach((b) => b.classList.toggle("active", b.dataset.version === v));
}
export function settings_now() {
    return {
        tier: Math.min(5, Math.max(1, Math.round(Number(tier_in.value)) || 5)),
        alt: alt_box.checked,
        boost: boost_box.checked,
        partial: partial_box.checked,
        target: item_sel.value,
    };
}
/** disable the inputs while solving; swap Solve / Stop */
export function set_running(on) {
    solve_btn.classList.toggle("hidden", on);
    stop_btn.classList.toggle("hidden", !on);
    view_btn.classList.toggle("hidden", on);
    for (const el of [seed_in, random_btn, tier_in, gap_in, alt_box, boost_box, water_box, partial_box, import_btn, import_clear_btn])
        el.disabled = on;
    document.querySelectorAll(".seg input").forEach((r) => (r.disabled = on));
    document.querySelectorAll(".version-btn, .mp-input-btn").forEach((b) => (b.disabled = on));
    // checkboxes: their label shows it (same look as everything else that is locked)
    for (const box of [alt_box, boost_box, water_box, partial_box])
        box.closest(".check-label-container")?.classList.toggle("is-disabled", on);
    // the item picker
    const picker = fake_sel.querySelector(".selected");
    if (picker)
        picker.disabled = on;
    fake_sel.classList.toggle("is-disabled", on);
    if (on)
        fake_sel.classList.remove("open");
}
// ---- seed ----
const B62 = "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
/** a random seed as the game shows it: base62 of a 32-bit number (0 .. 4gfFC3) */
export function random_seed() {
    let n = crypto.getRandomValues(new Uint32Array(1))[0], s = "";
    do {
        s = B62[n % 62] + s;
        n = Math.floor(n / 62);
    } while (n > 0);
    return s;
}
// ---- World size / Resources: segmented buttons that write into a hidden input ----
function init_segs() {
    document.querySelectorAll(".seg[data-for]").forEach((seg) => {
        const input = document.getElementById(seg.dataset.for);
        for (const v of seg.dataset.values.split(",")) {
            const label = document.createElement("label");
            const radio = document.createElement("input");
            radio.type = "radio";
            radio.name = seg.dataset.for;
            radio.value = v;
            radio.addEventListener("change", () => { if (radio.checked)
                input.value = v; });
            const span = document.createElement("span");
            span.textContent = `${v}%`;
            label.append(radio, span);
            seg.appendChild(label);
        }
    });
    sync_segs();
}
/** show the hidden inputs' values on the buttons (after the URL or an import changed them) */
export function sync_segs() {
    document.querySelectorAll(".seg[data-for]").forEach((seg) => {
        const value = document.getElementById(seg.dataset.for).value;
        seg.querySelectorAll("input").forEach((r) => (r.checked = r.value === value));
    });
}
function fill_items() {
    const names = new Set(RAW_ITEMS);
    for (const [item] of RECIPES)
        names.add(item);
    names.delete("Coal_Power_Plant");
    names.delete("Nuclear_Power_Plant");
    for (const name of [...names].sort()) {
        const o = document.createElement("option");
        o.value = name;
        o.textContent = pretty(name);
        if (name === "Earth_Token")
            o.selected = true;
        item_sel.appendChild(o);
    }
}
// item picker with icons (same look as the Alt Calculator)
function init_fake_select() {
    const selected = fake_sel.querySelector(".selected");
    const options = fake_sel.querySelector(".options");
    const html = (o) => `<img src="assets/${o.value}.png" alt=""><span>${o.textContent}</span>`;
    const render = () => {
        const o = item_sel.selectedOptions[0];
        if (o)
            selected.innerHTML = html(o);
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
        if (e.target instanceof Node && !fake_sel.contains(e.target))
            fake_sel.classList.remove("open");
    });
    item_sel.addEventListener("change", render);
    render();
}
// +/- buttons; data-values="50,75,..." steps through a fixed list
function init_min_plus() {
    document.querySelectorAll(".min-plus-input").forEach((wrap) => {
        const input = wrap.querySelector(".mp-input-field");
        const values = input.dataset.values?.split(",").map(Number);
        const step = (dir) => {
            const v = Number(input.value);
            if (values) {
                const next = dir > 0 ? values.find((x) => x > v) : [...values].reverse().find((x) => x < v);
                if (next !== undefined)
                    input.value = String(next);
            }
            else if (dir > 0) {
                input.stepUp();
            }
            else {
                input.stepDown();
            }
            input.dispatchEvent(new Event("change", { bubbles: true }));
        };
        wrap.querySelector('[data-action="decrease"]').addEventListener("click", () => step(-1));
        wrap.querySelector('[data-action="increase"]').addEventListener("click", () => step(1));
    });
    tier_in.addEventListener("change", () => {
        const t = Math.min(5, Math.max(1, Math.round(Number(tier_in.value)) || 5));
        tier_in.value = String(t);
        tier_img.src = `assets/Extractor_${t}.png`;
    });
}
export function init_inputs() {
    init_segs();
    random_btn.addEventListener("click", () => { seed_in.value = random_seed(); });
    fill_items();
    init_fake_select();
    init_min_plus();
    document.querySelectorAll(".version-btn").forEach((b) => b.addEventListener("click", () => set_version(b.dataset.version)));
}
//# sourceMappingURL=inputs.js.map