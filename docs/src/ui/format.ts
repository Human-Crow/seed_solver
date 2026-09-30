// Number, time and name formatting.

export const pretty = (name: string) => name.replace(/_/g, " ");

export function fmt(v: number | undefined): string {
    if (v === undefined || !Number.isFinite(v)) return "–";
    return v >= 100 ? v.toFixed(2) : v >= 10 ? v.toFixed(3) : v.toFixed(4);
}

export function fmt_gap(gap: number): string {
    return `${(gap * 100).toFixed(gap < 0.001 ? 3 : 2)}%`;
}

export function fmt_time(sec: number): string {
    sec = Math.round(sec);
    if (sec < 60) return `${sec} s`;
    if (sec < 3600) return `${Math.floor(sec / 60)} m ${String(sec % 60).padStart(2, "0")} s`;
    return `${Math.floor(sec / 3600)} h ${String(Math.floor(sec / 60) % 60).padStart(2, "0")} m`;
}
