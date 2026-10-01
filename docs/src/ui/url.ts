// Settings in the page URL, and the "Copy link to this world" button.

import type { Version } from "../world_api.js";
import { seed_in, size_in, amount_in, tier_in, gap_in, alt_box, boost_box, water_box, item_sel, copy_link_btn } from "./dom.js";
import { get_version, set_version, sync_segs } from "./inputs.js";

export function read_url() {
    const p = new URLSearchParams(location.search);
    const get = (k: string) => p.get(k);
    if (get("seed")) seed_in.value = get("seed")!;
    if (get("size")) size_in.value = get("size")!;
    if (get("res")) amount_in.value = get("res")!;
    sync_segs();
    const v = get("ver");
    set_version(v === "ios1" || v === "ios2" ? (v as Version) : "steam");
    const item = get("item");
    if (item && [...item_sel.options].some((o) => o.value === item)) {
        item_sel.value = item;
        item_sel.dispatchEvent(new Event("change"));
    }
    if (get("tier")) {
        tier_in.value = get("tier")!;
        tier_in.dispatchEvent(new Event("change"));
    }
    if (get("alt")) alt_box.checked = get("alt") !== "0";
    if (get("pp")) boost_box.checked = get("pp") !== "0";
    if (get("gap")) gap_in.value = get("gap")!;
    if (get("water")) water_box.checked = get("water") === "0";
}

export function page_link(): string {
    const p = new URLSearchParams({
        seed: seed_in.value.trim(), size: size_in.value, res: amount_in.value, ver: get_version(),
        item: item_sel.value, tier: tier_in.value, alt: alt_box.checked ? "1" : "0", pp: boost_box.checked ? "1" : "0",
        gap: gap_in.value,
    });
    if (water_box.checked) p.set("water", "0");
    const worker = new URLSearchParams(location.search).get("worker");     // local testing only
    if (worker) p.set("worker", worker);
    return `${location.origin}${location.pathname}?${p}`;
}

export function init_url() {
    read_url();
    copy_link_btn.addEventListener("click", () => {
        void navigator.clipboard.writeText(page_link()).then(() => {
            const old = copy_link_btn.textContent;
            copy_link_btn.textContent = "Copied!";
            setTimeout(() => (copy_link_btn.textContent = old), 1000);
        });
    });
}
