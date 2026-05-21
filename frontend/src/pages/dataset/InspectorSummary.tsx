import React from "react";
import type { Episode } from "../../types";
import { fmtMb } from "./datasetUtils";

export function SummaryItem({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.summaryItem}>
      <span style={styles.summaryLabel}>{label}</span>
      <span style={styles.summaryValue}>{value}</span>
    </div>
  );
}

export function EmptyInspector({
  episodes,
  totalTakes,
  totalSize,
  onFilter,
}: {
  episodes: Episode[];
  totalTakes: number;
  totalSize: number;
  onFilter: (filter: "all" | "success" | "failure" | "unlabeled") => void;
}) {
  const failures = episodes.filter(ep => ep.success === false).length;
  const unlabeled = episodes.filter(ep => ep.success !== true && ep.success !== false).length;
  const missingDepth = episodes.filter(ep => !ep.completeness?.depth).length;
  return (
    <div style={styles.detailPanel}>
      <div style={styles.emptyHero}>Select an episode to inspect</div>
      <div style={styles.summaryGrid}>
        <SummaryItem label="Episodes" value={String(episodes.length)} />
        <SummaryItem label="Takes" value={String(totalTakes)} />
        <SummaryItem label="Dataset size" value={fmtMb(totalSize)} />
        <SummaryItem label="Missing depth" value={String(missingDepth)} />
      </div>
      <div style={styles.quickFilters}>
        <button style={styles.quickFilterBtn} onClick={() => onFilter("unlabeled")}>Show unlabeled ({unlabeled})</button>
        <button style={styles.quickFilterBtn} onClick={() => onFilter("failure")}>Show failures ({failures})</button>
        <button style={styles.quickFilterBtn} onClick={() => onFilter("all")}>Show all</button>
      </div>
    </div>
  );
}

export function BatchInspector({
  episodes,
  status,
  onClear,
  onExport,
}: {
  episodes: Episode[];
  status: { success: number; failure: number; unlabeled: number };
  onClear: () => void;
  onExport: () => void;
}) {
  const tasks = Array.from(episodes.reduce((m, ep) => {
    const key = ep.task || "unspecified";
    m.set(key, (m.get(key) ?? 0) + 1);
    return m;
  }, new Map<string, number>()).entries()).sort((a, b) => b[1] - a[1]).slice(0, 6);
  const totalSize = episodes.reduce((s, ep) => s + (ep.size_mb ?? 0), 0);
  return (
    <div>
      <div style={styles.emptyHero}>{episodes.length} episodes selected</div>
      <div style={styles.summaryGrid}>
        <SummaryItem label="Success" value={String(status.success)} />
        <SummaryItem label="Failure" value={String(status.failure)} />
        <SummaryItem label="Unlabeled" value={String(status.unlabeled)} />
        <SummaryItem label="Size" value={fmtMb(totalSize)} />
      </div>
      <div style={{ marginTop: 16 }}>
        <div style={styles.sectionLabel}>Tasks</div>
        {tasks.map(([task, count]) => (
          <div key={task} style={styles.batchTaskRow}>
            <span>{task}</span>
            <strong>{count}</strong>
          </div>
        ))}
      </div>
      <div style={styles.batchActions}>
        <button style={styles.exportBarBtn} onClick={onExport}>Export</button>
        <button style={styles.cancelBtn} onClick={onClear}>Clear Selection</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  detailPanel: {
    flex: 1,
    overflowY: "auto",
    background: "#fff",
    borderRadius: 10,
    border: "1px solid #e5e7eb",
    padding: 16,
  },
  summaryGrid: {
    display: "grid",
    gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
  },
  summaryItem: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    padding: "9px 10px",
    background: "#f8fafc",
  },
  summaryLabel: { display: "block", fontSize: 10, color: "#94a3b8", fontWeight: 800, textTransform: "uppercase" },
  summaryValue: { display: "block", fontSize: 13, color: "#111827", fontWeight: 800, marginTop: 4 },
  emptyHero: { fontSize: 18, color: "#111827", fontWeight: 900, marginBottom: 14 },
  quickFilters: { display: "flex", gap: 8, flexWrap: "wrap", marginTop: 16 },
  quickFilterBtn: {
    border: "1px solid #e5e7eb",
    borderRadius: 8,
    background: "#fff",
    color: "#4f46e5",
    fontSize: 12,
    fontWeight: 800,
    padding: "8px 10px",
    cursor: "pointer",
  },
  sectionLabel: {
    fontSize: 10,
    textTransform: "uppercase",
    letterSpacing: 1,
    color: "#94a3b8",
    fontWeight: 700,
    marginBottom: 4,
  },
  batchTaskRow: {
    display: "flex",
    justifyContent: "space-between",
    gap: 10,
    padding: "7px 0",
    borderBottom: "1px solid #f1f5f9",
    fontSize: 13,
    color: "#334155",
  },
  batchActions: { display: "flex", gap: 8, marginTop: 16 },
  exportBarBtn: {
    padding: "7px 10px",
    background: "#4f46e5",
    color: "#fff",
    border: "none",
    borderRadius: 7,
    fontSize: 12,
    fontWeight: 800,
    cursor: "pointer",
  },
  cancelBtn: {
    background: "#e5e7eb",
    color: "#374151",
    border: "none",
    borderRadius: 4,
    padding: "2px 7px",
    fontSize: 11,
    cursor: "pointer",
  },
};
