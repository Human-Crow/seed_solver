// Deposits an extractor cannot use: all four sides deposits or water.
/**
 * Per deposit 1 if all four sides are deposits or water: an extractor there has no free side and cannot be used,
 * so the solver leaves it out (shown as removed). The world itself stays as the game makes it.
 */
export function enclosed_deposits(world) {
    const n = world.deposits.x.length;
    const out = new Uint8Array(n);
    if (!world.water.x.length)
        return out; // water ignored (or unknown): every free side counts as land
    const blocked = new Set();
    for (let i = 0; i < n; i++)
        blocked.add(`${world.deposits.x[i]},${world.deposits.y[i]}`);
    for (let i = 0; i < world.water.x.length; i++)
        blocked.add(`${world.water.x[i]},${world.water.y[i]}`);
    for (let i = 0; i < n; i++) {
        const x = world.deposits.x[i], y = world.deposits.y[i];
        if (blocked.has(`${x},${y + 1}`) && blocked.has(`${x},${y - 1}`) && blocked.has(`${x + 1},${y}`) && blocked.has(`${x - 1},${y}`))
            out[i] = 1;
    }
    return out;
}
//# sourceMappingURL=enclosed.js.map