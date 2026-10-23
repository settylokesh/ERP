import { Download } from 'lucide-react';
import type { ReactNode } from 'react';
import { Empty } from './ui';

export interface Col<T> { key: string; label: string; render?: (row: T) => ReactNode; num?: boolean; csv?: (row: T) => unknown; className?: string }

export function toCsv<T>(cols: Col<T>[], rows: T[]) {
  const esc = (v: unknown) => {
    const s = v == null ? '' : String(v);
    return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  };
  return [cols.map((c) => esc(c.label)).join(','), ...rows.map((r: any) => cols.map((c) => esc(c.csv ? c.csv(r) : r[c.key])).join(','))].join('\n');
}
export function saveCsv(name: string, csv: string) {
  const url = URL.createObjectURL(new Blob([csv], { type: 'text/csv;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = url;
  a.download = `${name}.csv`;
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

export function DataTable<T extends Record<string, any>>({ cols, rows, onRow, empty, footer, exportName }: { cols: Col<T>[]; rows: T[]; onRow?: (r: T) => void; empty?: ReactNode; footer?: ReactNode; exportName?: string }) {
  if (!rows.length) return <div className="card">{empty ?? <Empty title="No records yet" />}</div>;
  return (
    <div className="card overflow-hidden">
      {exportName && (
        <div className="flex justify-end border-b border-slate-100 px-3 py-1.5">
          <button className="btn btn-ghost btn-sm" onClick={() => saveCsv(exportName, toCsv(cols, rows))}><Download className="h-3.5 w-3.5" />Export CSV</button>
        </div>
      )}
      <div className="overflow-x-auto">
        <table className="table">
          <thead><tr>{cols.map((c) => <th key={c.key} className={`${c.num ? 'num' : ''} ${c.className ?? ''}`}>{c.label}</th>)}</tr></thead>
          <tbody>
            {rows.map((r, i) => (
              <tr key={r.id ?? i} className={onRow ? 'cursor-pointer' : ''} onClick={() => onRow?.(r)}>
                {cols.map((c) => <td key={c.key} className={`${c.num ? 'num' : ''} ${c.className ?? ''}`}>{c.render ? c.render(r) : r[c.key] ?? '-'}</td>)}
              </tr>
            ))}
          </tbody>
          {footer && <tfoot>{footer}</tfoot>}
        </table>
      </div>
    </div>
  );
}
