// Game data for the exact solver (generated from builderment_solver.py).

/** (item, variant) -> [output, seconds, building, [[material, amount], ...]] */
export const RECIPES: ReadonlyArray<readonly [string, string, number, number, string, ReadonlyArray<readonly [string, number]>]> = [
    ["Atomic_Locator", "STD", 1, 30, "Manufacturer", [["Super_Computer", 2], ["Electron_Microscope", 2], ["Concrete", 24], ["Copper_Wire", 50]]],
    ["Battery", "STD", 1, 24, "Machine_Shop", [["Electromagnet", 8], ["Graphite", 8]]],
    ["Carbon_Fiber", "STD", 1, 8, "Workshop", [["Graphite", 4]]],
    ["Coal_Power_Plant", "STD", 0.5, 30, "Coal_Power_Plant", [["Coal", 5]]],
    ["Computer", "STD", 1, 8, "Industrial_Factory", [["Metal_Frame", 1], ["Heat_Sink", 3], ["Logic_Circuit", 3]]],
    ["Concrete", "ALT", 1, 12, "Forge", [["Stone", 20], ["Wood_Frame", 4]]],
    ["Concrete", "STD", 1, 8, "Forge", [["Sand", 10], ["Steel_Rod", 1]]],
    ["Condenser_Lens", "STD", 1, 3, "Workshop", [["Glass", 3]]],
    ["Copper_Ingot", "STD", 1, 2, "Furnace", [["Copper_Ore", 1]]],
    ["Copper_Wire", "ALT", 8, 8, "Workshop", [["Carbon_Fiber", 1]]],
    ["Copper_Wire", "STD", 2, 4, "Workshop", [["Copper_Ingot", 3]]],
    ["Coupler", "STD", 1, 10, "Workshop", [["Tungsten_Carbide", 1]]],
    ["Earth_Token", "STD", 1, 42, "Earth_Teleporter", [["Matter_Duplicator", 1]]],
    ["Electric_Motor", "ALT", 1, 22, "Industrial_Factory", [["Electromagnet", 6], ["Steel", 6], ["Empty_Fuel_Cell", 1]]],
    ["Electric_Motor", "STD", 1, 20, "Industrial_Factory", [["Battery", 1], ["Iron_Gear", 4], ["Rotor", 2]]],
    ["Electromagnet", "ALT", 12, 20, "Machine_Shop", [["Nano_Wire", 1], ["Steel_Rod", 1]]],
    ["Electromagnet", "STD", 1, 8, "Machine_Shop", [["Copper_Wire", 6], ["Iron_Ingot", 2]]],
    ["Electron_Microscope", "STD", 1, 24, "Manufacturer", [["Nano_Wire", 2], ["Electromagnet", 8], ["Condenser_Lens", 4], ["Metal_Frame", 2]]],
    ["Empty_Fuel_Cell", "STD", 1, 15, "Machine_Shop", [["Tungsten_Carbide", 3], ["Glass", 5]]],
    ["Energy_Cube", "STD", 1, 30, "Machine_Shop", [["Battery", 2], ["Industrial_Frame", 1]]],
    ["Enriched_Uranium", "STD", 1, 60, "Furnace", [["Uranium_Ore", 30]]],
    ["Gem_Apple", "STD", 1, 300, "Gem_Tree", []],
    ["Glass", "STD", 1, 6, "Furnace", [["Sand", 4]]],
    ["Graphite", "STD", 1, 4, "Forge", [["Coal", 3], ["Wood_Log", 3]]],
    ["Gyroscope", "STD", 1, 12, "Machine_Shop", [["Copper_Wire", 12], ["Rotor", 2]]],
    ["Heat_Sink", "STD", 1, 6, "Workshop", [["Copper_Ingot", 5]]],
    ["Industrial_Frame", "ALT", 1, 36, "Industrial_Factory", [["Steel", 18], ["Iron_Plating", 10], ["Carbon_Fiber", 4]]],
    ["Industrial_Frame", "STD", 1, 20, "Industrial_Factory", [["Concrete", 6], ["Metal_Frame", 2], ["Tungsten_Carbide", 8]]],
    ["Iron_Gear", "ALT", 8, 8, "Workshop", [["Steel", 1]]],
    ["Iron_Gear", "STD", 1, 4, "Workshop", [["Iron_Ingot", 2]]],
    ["Iron_Ingot", "STD", 1, 2, "Furnace", [["Iron_Ore", 1]]],
    ["Iron_Plating", "STD", 2, 6, "Workshop", [["Iron_Ingot", 4]]],
    ["Logic_Circuit", "ALT", 1, 8, "Machine_Shop", [["Iron_Plating", 1], ["Heat_Sink", 1]]],
    ["Logic_Circuit", "STD", 1, 6, "Machine_Shop", [["Copper_Wire", 3], ["Silicon", 2]]],
    ["Magnetic_Field_Generator", "STD", 1, 40, "Manufacturer", [["Stabilizer", 1], ["Industrial_Frame", 1], ["Electromagnet", 10], ["Nano_Wire", 10]]],
    ["Matter_Compressor", "STD", 1, 30, "Manufacturer", [["Industrial_Frame", 1], ["Turbocharger", 2], ["Electric_Motor", 2], ["Tank", 1]]],
    ["Matter_Duplicator", "STD", 1, 90, "Manufacturer", [["Atomic_Locator", 4], ["Quantum_Entangler", 2], ["Energy_Cube", 5], ["Particle_Glue", 100]]],
    ["Metal_Frame", "STD", 1, 12, "Machine_Shop", [["Wood_Frame", 1], ["Iron_Plating", 4]]],
    ["Nano_Wire", "STD", 1, 12, "Machine_Shop", [["Carbon_Fiber", 2], ["Glass", 4]]],
    ["Nuclear_Fuel_Cell", "STD", 1, 30, "Industrial_Factory", [["Empty_Fuel_Cell", 1], ["Steel_Rod", 1], ["Enriched_Uranium", 1]]],
    ["Nuclear_Power_Plant", "STD", 2, 120, "Nuclear_Power_Plant", [["Nuclear_Fuel_Cell", 1]]],
    ["Particle_Glue", "STD", 10, 30, "Workshop", [["Matter_Compressor", 1]]],
    ["Quantum_Entangler", "STD", 1, 60, "Machine_Shop", [["Magnetic_Field_Generator", 1], ["Stabilizer", 2]]],
    ["Rotor", "ALT", 1, 18, "Machine_Shop", [["Copper_Ingot", 18], ["Iron_Plating", 18]]],
    ["Rotor", "STD", 1, 6, "Machine_Shop", [["Steel_Rod", 1], ["Iron_Plating", 2]]],
    ["Sand", "STD", 1, 1.5, "Workshop", [["Stone", 1]]],
    ["Silicon", "STD", 1, 3, "Furnace", [["Sand", 2]]],
    ["Stabilizer", "STD", 1, 24, "Industrial_Factory", [["Computer", 1], ["Electric_Motor", 1], ["Gyroscope", 2]]],
    ["Steel", "ALT", 1, 6, "Forge", [["Iron_Ore", 4], ["Coal", 4]]],
    ["Steel", "STD", 1, 8, "Forge", [["Graphite", 1], ["Iron_Ore", 6]]],
    ["Steel_Rod", "STD", 1, 4, "Workshop", [["Steel", 3]]],
    ["Super_Computer", "ALT", 2, 30, "Manufacturer", [["Computer", 2], ["Silicon", 40], ["Gyroscope", 2], ["Industrial_Frame", 1]]],
    ["Super_Computer", "STD", 1, 30, "Manufacturer", [["Computer", 2], ["Heat_Sink", 8], ["Turbocharger", 1], ["Coupler", 8]]],
    ["Tank", "STD", 1, 10, "Industrial_Factory", [["Glass", 2], ["Concrete", 4], ["Tungsten_Carbide", 4]]],
    ["Tungsten_Carbide", "ALT", 2, 15, "Forge", [["Tungsten_Ore", 1], ["Steel", 1]]],
    ["Tungsten_Carbide", "STD", 1, 5, "Forge", [["Tungsten_Ore", 2], ["Graphite", 1]]],
    ["Tungsten_Ore", "STD", 1, 2.5, "Furnace", [["Wolframite", 5]]],
    ["Turbocharger", "ALT", 1, 10, "Manufacturer", [["Heat_Sink", 4], ["Computer", 1], ["Gyroscope", 1], ["Tungsten_Carbide", 1]]],
    ["Turbocharger", "STD", 1, 15, "Manufacturer", [["Iron_Gear", 8], ["Logic_Circuit", 4], ["Nano_Wire", 2], ["Coupler", 4]]],
    ["Uranium_Ore", "GEN1", 1, 6, "Uranium_Extractor", []],
    ["Uranium_Ore", "GEN2", 1, 1.2, "Uranium_Extractor", []],
    ["Wood_Frame", "STD", 1, 8, "Workshop", [["Wood_Plank", 4]]],
    ["Wood_Plank", "STD", 1, 4, "Workshop", [["Wood_Log", 1]]],
];

/** save-file deposit id - 11 -> raw item */
export const RAW_ITEMS = ["Wood_Log", "Stone", "Iron_Ore", "Copper_Ore", "Coal", "Wolframite", "Uranium_Ore"] as const;
export const EXTRACTOR_SECONDS = { gen1: 8.0, gen2: 4.0 };     // Extractor (tier factor applies)
export const URANIUM_SECONDS = { gen1: 6.0, gen2: 1.2 };       // Uranium Extractor (no tiers)
export const TIER_FACTORS: Record<number, readonly [number, number]> = {"1": [1, 1], "2": [1.5, 2], "3": [2, 4], "4": [3, 8], "5": [4, 10]};   // [Gen 1.0, Gen 2.0]
export const COAL_BOOST = 1.2;
export const NUCLEAR_BOOST = { gen1: 1.4, gen2: 1.6 };
export const COAL_FUEL_PER_MIN = 10.0;        // Coal per coal plant
export const NUCLEAR_FUEL_PER_MIN = 0.5;     // Nuclear Fuel Cells per nuclear plant

/** footprint [w, h] and boosted square [w, h]; the footprint sits in the middle of the square */
export const PLANT_SHAPES = {
    coal: [[[2, 2], [12, 12]]],
    nuclear: [[[3, 4], [21, 22]], [[4, 3], [22, 21]]],
} as const;

/** Items per minute of one building, rounded to whole game ticks (60 per second). */
export function speed(seconds: number, factor = 1, boost = 1, output = 1): number {
    const ticks = seconds / (factor * boost) * 60;
    const efficiency = ticks / Math.ceil(ticks);
    return 60 / seconds * factor * output * boost * efficiency;
}
