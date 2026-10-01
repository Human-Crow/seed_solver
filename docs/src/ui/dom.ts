// Page elements used by the scripts.

export const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;

export const seed_in = $<HTMLInputElement>("seed_in");
export const random_btn = $<HTMLButtonElement>("random_btn");
export const size_in = $<HTMLInputElement>("size_in");
export const amount_in = $<HTMLInputElement>("amount_in");
export const tier_in = $<HTMLInputElement>("tier_in");
export const tier_img = $<HTMLImageElement>("tier_img");
export const gap_in = $<HTMLInputElement>("gap_in");
export const alt_box = $<HTMLInputElement>("alt_box");
export const boost_box = $<HTMLInputElement>("boost_box");
export const water_box = $<HTMLInputElement>("water_box");
export const import_btn = $<HTMLButtonElement>("import_btn");
export const import_file = $<HTMLInputElement>("import_file");
export const import_clear_btn = $<HTMLButtonElement>("import_clear_btn");
export const import_note = $<HTMLParagraphElement>("import_note");
export const item_sel = $<HTMLSelectElement>("item_select");
export const fake_sel = $<HTMLDivElement>("fake_item_select");
export const solve_btn = $<HTMLButtonElement>("solve_btn");
export const stop_btn = $<HTMLButtonElement>("stop_btn");
export const view_btn = $<HTMLButtonElement>("view_btn");
export const deposit_table = $<HTMLTableElement>("deposit_table");
export const deposit_block = $<HTMLDivElement>("deposit_block");
export const calc_link_world_a = $<HTMLAnchorElement>("calc_link_world");
export const copy_link_btn = $<HTMLButtonElement>("copy_link_btn");

export const status_box = $<HTMLDivElement>("status");
export const status_text = $<HTMLParagraphElement>("status_text");
export const stat_best = $("stat_best");
export const stat_bound = $("stat_bound");
export const stat_gap = $("stat_gap");
export const stat_time = $("stat_time");

export const result_block = $<HTMLDivElement>("result");
export const result_img = $<HTMLImageElement>("result_img");
export const result_score = $("result_score");
export const result_note = $("result_note");
export const boost_table = $<HTMLTableElement>("boost_table");
export const calc_link_a = $<HTMLAnchorElement>("calc_link");
export const blp_btn = $<HTMLButtonElement>("blp_btn");
export const blp_box = $<HTMLDivElement>("blp_box");
export const blp_id = $("blp_id");
export const blp_link = $<HTMLAnchorElement>("blp_link");
export const blp_note = $<HTMLParagraphElement>("blp_note");

export const map_block = $<HTMLDivElement>("map_block");
export const map_canvas = $<HTMLCanvasElement>("map_canvas");
export const zoom_in_btn = $<HTMLButtonElement>("zoom_in_btn");
export const zoom_out_btn = $<HTMLButtonElement>("zoom_out_btn");
export const zoom_fit_btn = $<HTMLButtonElement>("zoom_fit_btn");
export const areas_box = $<HTMLInputElement>("areas_box");
export const legend = $<HTMLDivElement>("legend");
