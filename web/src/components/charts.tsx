import { useState } from 'react';
import { money } from '../lib/format';

/** Categorical slots from the validated reference palette (light mode). */
export const SERIES = ['#2a78d6', '#eb6834'];
const GRID = '#e7e5e4';
const INK2 = '#52514e';
const INK3 = '#78716c';

const compact = (n: number) => {
  const a = Math.abs(n);
  const s = a >= 1e7 ? `${(a / 1e7).toFixed(a >= 1e8 ? 0 : 1)}Cr` : a >= 1e5 ? `${(a / 1e5).toFixed(a >= 1e6 ? 0 : 1)}L` : a >= 1e3 ? `${(a / 1e3).toFixed(a >= 1e4 ? 0 : 1)}K` : `${Math.round(a)}`;
  return `${n < 0 ? '-' : ''}₹${s}`;
};
function niceTicks(max: number, min = 0, count = 4) {
  const span = Math.max(1, max - min);
  const raw = span / count;
  const mag = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
  const lo = Math.floor(min / step) * step;
  const hi = Math.ceil(max / step) * step;
  const ticks: number[] = [];
  for (let v = lo; v <= hi + step / 2; v += step) ticks.push(Math.round(v * 100) / 100);
  return ticks;
}
const monthLabel = (m: string) => new Date(`${m}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'short' });

/** A rect with 4px rounded data-end and a square base. */
function Bar({ x, y, w, h, fill, up = true }: { x: number; y: number; w: number; h: number; fill: string; up?: boolean }) {
  if (h <= 0) return null;
  const r = Math.min(4, h, w / 2);
  const d = up
    ? `M${x},${y + h} V${y + r} Q${x},${y} ${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h} Z`
    : `M${x},${y} V${y + h - r} Q${x},${y + h} ${x + r},${y + h} H${x + w - r} Q${x + w},${y + h} ${x + w},${y + h - r} V${y} Z`;
  return <path d={d} fill={fill} />;
}

export function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="flex flex-wrap gap-4 text-xs text-slate-600">
      {items.map((i) => <span key={i.label} className="inline-flex items-center gap-1.5"><span className="h-2.5 w-2.5 rounded-sm" style={{ background: i.color }} />{i.label}</span>)}
    </div>
  );
}

/** Grouped columns for a few series over months, one shared y-axis, hover tooltip per month. */
export function ColumnChart({ data, series, height = 220 }: { data: Record<string, any>[]; series: { key: string; label: string }[]; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, pad = { l: 52, r: 8, t: 10, b: 24 };
  const max = Math.max(1, ...data.flatMap((d) => series.map((s) => d[s.key] ?? 0)));
  const ticks = niceTicks(max);
  const top = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const band = iw / Math.max(1, data.length);
  const bw = Math.min(24, (band * 0.7 - 2 * (series.length - 1)) / series.length);
  const y = (v: number) => pad.t + ih - (v / top) * ih;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Column chart of ${series.map((s) => s.label).join(' and ')} by month`} onMouseLeave={() => setHover(null)}>
        {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} /><text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={INK3}>{compact(t)}</text></g>)}
        {data.map((d, i) => {
          const gx = pad.l + i * band + (band - (bw * series.length + 2 * (series.length - 1))) / 2;
          return (
            <g key={i}>
              <rect x={pad.l + i * band} y={pad.t} width={band} height={ih} fill={hover === i ? '#f5f5f4' : 'transparent'} onMouseEnter={() => setHover(i)} />
              {series.map((s, k) => <Bar key={s.key} x={gx + k * (bw + 2)} y={y(d[s.key] ?? 0)} w={bw} h={(pad.t + ih) - y(d[s.key] ?? 0)} fill={SERIES[k]} />)}
              <text x={pad.l + i * band + band / 2} y={H - 8} textAnchor="middle" fontSize="10" fill={INK2}>{monthLabel(d.month)}</text>
            </g>
          );
        })}
      </svg>
      {hover !== null && data[hover] && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md" style={{ left: `${Math.min(70, ((hover + 0.5) / data.length) * 100)}%` }}>
          <div className="mb-1 font-semibold text-slate-800">{new Date(`${data[hover].month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div>
          {series.map((s, k) => <div key={s.key} className="flex items-center gap-2 text-slate-700"><span className="h-2 w-2 rounded-sm" style={{ background: SERIES[k] }} />{s.label}<span className="ml-auto pl-3 tabular-nums">{money(data[hover][s.key])}</span></div>)}
        </div>
      )}
    </div>
  );
}

/** Single-series line with area wash, end label and crosshair tooltip. */
export function LineChart({ data, valueKey, label, height = 200 }: { data: Record<string, any>[]; valueKey: string; label: string; height?: number }) {
  const [hover, setHover] = useState<number | null>(null);
  const W = 640, H = height, pad = { l: 52, r: 56, t: 12, b: 24 };
  if (!data.length) return null;
  const vals = data.map((d) => d[valueKey] ?? 0);
  const ticks = niceTicks(Math.max(...vals, 1), Math.min(0, ...vals));
  const lo = ticks[0], hi = ticks[ticks.length - 1];
  const iw = W - pad.l - pad.r, ih = H - pad.t - pad.b;
  const x = (i: number) => pad.l + (data.length === 1 ? iw / 2 : (i / (data.length - 1)) * iw);
  const y = (v: number) => pad.t + ih - ((v - lo) / (hi - lo || 1)) * ih;
  const path = vals.map((v, i) => `${i ? 'L' : 'M'}${x(i)},${y(v)}`).join(' ');
  const area = `${path} L${x(vals.length - 1)},${y(Math.max(lo, 0))} L${x(0)},${y(Math.max(lo, 0))} Z`;
  const last = vals.length - 1;
  return (
    <div className="relative">
      <svg viewBox={`0 0 ${W} ${H}`} className="w-full" role="img" aria-label={`Line chart of ${label}`} onMouseLeave={() => setHover(null)}
        onMouseMove={(e) => {
          const r = (e.currentTarget as SVGSVGElement).getBoundingClientRect();
          const px = ((e.clientX - r.left) / r.width) * W;
          setHover(Math.max(0, Math.min(last, Math.round(((px - pad.l) / iw) * last))));
        }}>
        {ticks.map((t) => <g key={t}><line x1={pad.l} x2={W - pad.r} y1={y(t)} y2={y(t)} stroke={GRID} strokeWidth={1} /><text x={pad.l - 6} y={y(t) + 3} textAnchor="end" fontSize="10" fill={INK3}>{compact(t)}</text></g>)}
        <path d={area} fill={SERIES[0]} opacity={0.1} />
        <path d={path} fill="none" stroke={SERIES[0]} strokeWidth={2} strokeLinejoin="round" strokeLinecap="round" />
        {data.map((d, i) => <text key={i} x={x(i)} y={H - 8} textAnchor="middle" fontSize="10" fill={INK2}>{monthLabel(d.month)}</text>)}
        {hover !== null && <line x1={x(hover)} x2={x(hover)} y1={pad.t} y2={pad.t + ih} stroke={INK3} strokeWidth={1} />}
        <circle cx={x(hover ?? last)} cy={y(vals[hover ?? last])} r={4.5} fill={SERIES[0]} stroke="#fff" strokeWidth={2} />
        <text x={x(last) + 8} y={y(vals[last]) + 4} fontSize="11" fill="#1c1917" fontWeight={600}>{compact(vals[last])}</text>
      </svg>
      {hover !== null && (
        <div className="pointer-events-none absolute top-2 rounded-md border border-slate-200 bg-white px-3 py-2 text-xs shadow-md" style={{ left: `${Math.min(70, (hover / Math.max(1, last)) * 85)}%` }}>
          <div className="font-semibold text-slate-800">{new Date(`${data[hover].month}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div>
          <div className="text-slate-700">{label}: <span className="tabular-nums">{money(vals[hover])}</span></div>
        </div>
      )}
    </div>
  );
}

/** Horizontal bars (single series) with the value at each bar's tip. */
export function HBarChart({ data, labelKey, valueKey }: { data: Record<string, any>[]; labelKey: string; valueKey: string }) {
  const max = Math.max(1, ...data.map((d) => d[valueKey] ?? 0));
  return (
    <div className="space-y-2.5" role="list">
      {data.map((d) => (
        <div key={d[labelKey]} role="listitem" title={`${d[labelKey]}: ${money(d[valueKey])}`}>
          <div className="mb-1 flex justify-between gap-2 text-xs"><span className="truncate text-slate-600">{d[labelKey]}</span><span className="tabular-nums font-medium text-slate-800">{money(d[valueKey])}</span></div>
          <div className="h-2.5 w-full rounded-r bg-transparent">
            <div className="h-2.5 rounded-r" style={{ width: `${Math.max(1, (d[valueKey] / max) * 100)}%`, background: SERIES[0] }} />
          </div>
        </div>
      ))}
    </div>
  );
}
