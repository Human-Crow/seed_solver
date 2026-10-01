// Link to the Alt Calculator (Resource mode) with the layout's extractors, boosts, power plants and ALT ratios.
// Extractors on built-over deposits are not counted.

import { RAW_ITEMS } from "../solver/data.js";
import type { LayoutDetails, SolverSettings } from "../solver/solve.js";
import { CALC_URL } from "./config.js";

const RAW_KEYS: Record<string, string> = {
    Wood_Log: "wd", Stone: "st", Iron_Ore: "ir", Copper_Ore: "cp", Coal: "cl", Wolframite: "wr", Uranium_Ore: "ur",
};

const ALT_KEYS: Record<string, string> = {
    Copper_Wire: "cw", Iron_Gear: "ig", Steel: "st", Concrete: "cc", Electromagnet: "eg", Logic_Circuit: "lc",
    Electric_Motor: "em", Industrial_Frame: "if", Turbocharger: "tg", Super_Computer: "sc", Tungsten_Carbide: "tc", Rotor: "ro",
};

const num = (v: number) => String(Math.round(v * 1e6) / 1e6);

export function calc_link(settings: SolverSettings, gen2: boolean, d: LayoutDetails, ncoal: number, nnuc: number): string {
    const pairs: string[] = [
        "mode:Resource", `item:${settings.target}`, `alt:${settings.alt ? 1 : 0}`, `gen2:${gen2 ? 1 : 0}`,
        `t_ex:${settings.tier}`, `c_bst:${settings.boost ? 1 : 0}`, `n_bst:${settings.boost ? 1 : 0}`,
    ];
    if (settings.boost) pairs.push(`c_pp:${num(ncoal)}`, `n_pp:${num(nnuc)}`);     // partly powered plants count for their share
    for (const item of RAW_ITEMS) {
        const b = d.boosts[item]!, ex = Math.round(b.nuclear + b.coal + b.none), k = RAW_KEYS[item]!;
        pairs.push(`e_${k}:${ex}`);
        if (settings.boost) pairs.push(`c_${k}:${num(ex ? b.coal / ex : 0)}`, `n_${k}:${num(ex ? b.nuclear / ex : 0)}`);
    }
    // ALT share per item (0 = all STD, 1 = all ALT)
    if (settings.alt) {
        for (const [item, k] of Object.entries(ALT_KEYS)) {
            const rate = (v: string) => d.recipes.find((x) => x.item === item && x.variant === v)?.rate ?? 0;
            const alt = rate("ALT"), total = alt + rate("STD");
            pairs.push(`a_${k}:${num(total > 0 ? Math.max(0, Math.min(1, alt / total)) : 0)}`);
        }
    }
    return `${CALC_URL}?bulk=${pairs.join(",")}`;
}

/**
 * Link for a world that was only shown (not solved): the settings and every deposit tile as an extractor.
 * No power plant counts, boost shares or ALT ratios: those only exist after solving.
 * @param tiles deposit tiles per resource, in RAW_ITEMS order
 */
export function calc_link_world(settings: SolverSettings, gen2: boolean, tiles: number[]): string {
    const pairs: string[] = [
        "mode:Resource", `item:${settings.target}`, `alt:${settings.alt ? 1 : 0}`, `gen2:${gen2 ? 1 : 0}`,
        `t_ex:${settings.tier}`, `c_bst:${settings.boost ? 1 : 0}`, `n_bst:${settings.boost ? 1 : 0}`,
    ];
    RAW_ITEMS.forEach((item, k) => pairs.push(`e_${RAW_KEYS[item]}:${tiles[k] ?? 0}`));
    return `${CALC_URL}?bulk=${pairs.join(",")}`;
}
