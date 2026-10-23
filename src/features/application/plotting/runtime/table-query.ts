import type { TableColumn, TableRow, TableState } from './table-reducer';
export function queryTable(state: TableState, filter: string, sortKey?: string, descending = false): TableRow[] {
  const term = filter.toLocaleLowerCase();
  const rows = [...state.items.values()].filter(r => !term || [r.row_id, r.annotation_id, ...Object.values(r.values)].some(v => String(v ?? '').toLocaleLowerCase().includes(term)));
  const column = state.columns.find(c => c.key === sortKey);
  return rows.sort((a, b) => {
    let result = 0;
    if (column) {
      const av = a.values[column.key], bv = b.values[column.key];
      if (av === null || bv === null) result = av === bv ? 0 : av === null ? -1 : 1;
      else if (column.type === 'uint64' || column.type === 'int64') result = BigInt(av as string) < BigInt(bv as string) ? -1 : BigInt(av as string) > BigInt(bv as string) ? 1 : 0;
      else if (column.type === 'float64' || column.type === 'boolean') result = av < bv ? -1 : av > bv ? 1 : 0;
      else result = String(av).localeCompare(String(bv));
    }
    return (descending ? -result : result) || a.row_id.localeCompare(b.row_id);
  });
}
export function formatTableValue(value: TableRow['values'][string], c: TableColumn): string {
  if (value === null) return '—';
  if (c.type === 'float64' && typeof value === 'number') {
    if (c.unit === 'Hz') { const factor = Math.abs(value) >= 1e9 ? 1e9 : Math.abs(value) >= 1e6 ? 1e6 : Math.abs(value) >= 1e3 ? 1e3 : 1; return `${(value / factor).toFixed(6).replace(/\.?0+$/, '')} ${factor === 1e9 ? 'GHz' : factor === 1e6 ? 'MHz' : factor === 1e3 ? 'kHz' : 'Hz'}`; }
    if (c.unit) return `${value.toFixed(2)} ${c.unit}`;
  }
  return String(value);
}
