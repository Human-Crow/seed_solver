// Fetches a generated world from the Cloudflare worker (the generator itself stays on the server).
export const DEFAULT_WORKER = "https://builderment.hcrow.workers.dev";
function align4(offset) {
    return (offset + 3) & ~3;
}
function decode_world(buffer) {
    const view = new DataView(buffer);
    const length = view.getUint32(0, true);
    const meta = JSON.parse(new TextDecoder().decode(new Uint8Array(buffer, 4, length)));
    let offset = align4(4 + length);
    const take = (make, n, bytes) => {
        offset = align4(offset);
        const a = make(offset, n);
        offset += n * bytes;
        return a;
    };
    const n = meta.deposits, nw = meta.water;
    const x = take((o, k) => new Int32Array(buffer, o, k), n, 4);
    const y = take((o, k) => new Int32Array(buffer, o, k), n, 4);
    const id = take((o, k) => new Uint8Array(buffer, o, k), n, 1);
    const wx = take((o, k) => new Int32Array(buffer, o, k), nw, 4);
    const wy = take((o, k) => new Int32Array(buffer, o, k), nw, 4);
    let map = null;
    if (meta.map) {
        const m = meta.map;
        const terrain = take((o, k) => new Uint8Array(buffer, o, k), m.width * m.height, 1);
        map = { x0: m.x0, y0: m.y0, step: m.step, width: m.width, height: m.height, terrain };
    }
    return {
        seed: meta.seed,
        gen2: meta.gen === 2,
        size: meta.size,
        amount: meta.amount,
        deposits: { count: n, id, x, y },
        water: { count: nw, x: wx, y: wy },
        map,
    };
}
export async function fetch_world(req) {
    const q = new URLSearchParams({
        seed: req.seed.trim(),
        size: String(req.size),
        amount: String(req.amount),
        platform: req.version === "steam" ? "steam" : "ios",
        gen: req.version === "ios2" ? "2" : "1",
        map: "auto",
        gv: "3", // generator version: the server ignores it, but a new address makes browsers fetch worlds
        // again after a generator fix (each answer is kept in the browser for a year)
    });
    const res = await fetch(`${DEFAULT_WORKER}/generateWorld?${q}`);
    if (!res.ok) {
        let message = `The world server answered ${res.status}`;
        try {
            const data = await res.json();
            if (data && typeof data.error === "string")
                message = data.error;
        }
        catch { /* not JSON */ }
        throw new Error(message);
    }
    if (!res.body)
        throw new Error("Empty answer from the world server");
    const stream = res.body.pipeThrough(new DecompressionStream("gzip"));
    return decode_world(await new Response(stream).arrayBuffer());
}
//# sourceMappingURL=world_api.js.map