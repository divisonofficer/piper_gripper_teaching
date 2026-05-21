import React from "react";

interface ExportModalProps {
  count: number;
  exporting: boolean;
  exportingLerobot: boolean;
  includeFrames: boolean;
  lerobotPreset: "default" | "all" | "debug";
  onIncludeFrames: (value: boolean) => void;
  onLerobotPreset: (value: "default" | "all" | "debug") => void;
  onExportZip: () => void;
  onExportLerobot: () => void;
  onClose: () => void;
}

export default function ExportModal({
  count,
  exporting,
  exportingLerobot,
  includeFrames,
  lerobotPreset,
  onIncludeFrames,
  onLerobotPreset,
  onExportZip,
  onExportLerobot,
  onClose,
}: ExportModalProps) {
  return (
    <div style={styles.backdrop} onClick={onClose}>
      <div style={styles.modal} onClick={e => e.stopPropagation()}>
        <h3 style={styles.title}>Export Dataset</h3>
        <div style={styles.count}>{count}개 에피소드 선택됨</div>

        <label style={styles.checkboxLabel}>
          <input type="checkbox" checked={includeFrames} onChange={e => onIncludeFrames(e.target.checked)} />
          Raw 프레임 이미지 포함 (용량 큼)
        </label>

        <label style={styles.selectLabel}>
          LeRobot camera preset
          <select
            value={lerobotPreset}
            onChange={e => onLerobotPreset(e.target.value as "default" | "all" | "debug")}
            style={styles.select}
          >
            <option value="default">default · cam0 + cam1</option>
            <option value="all">all · export-enabled RGB cameras</option>
            <option value="debug">debug · cam0 + cam1 + depth sensor RGB</option>
          </select>
        </label>

        <div style={styles.actions}>
          <button onClick={() => { onExportZip(); onClose(); }} disabled={exporting} style={{ ...styles.primaryButton, background: "#6366f1" }}>
            {exporting ? "압축 중..." : "Basic ZIP"}
            <div style={styles.buttonSubtext}>CSV + video + metadata</div>
          </button>
          <button onClick={() => { onExportLerobot(); onClose(); }} disabled={exportingLerobot} style={{ ...styles.primaryButton, background: "#059669" }}>
            {exportingLerobot ? "변환 중..." : "LeRobot v2.0 ZIP"}
            <div style={styles.buttonSubtext}>224x224 @ 15fps · parquet · postprocess applied</div>
          </button>
        </div>

        <button onClick={onClose} style={styles.cancelButton}>취소</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  backdrop: {
    position: "fixed",
    inset: 0,
    background: "rgba(0,0,0,0.4)",
    zIndex: 1000,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  modal: {
    background: "#fff",
    borderRadius: 12,
    padding: "24px 28px",
    minWidth: 320,
    boxShadow: "0 20px 40px rgba(0,0,0,0.15)",
  },
  title: { margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#1e293b" },
  count: { fontSize: 13, color: "#64748b", marginBottom: 16 },
  checkboxLabel: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    fontSize: 13,
    color: "#374151",
    cursor: "pointer",
    marginBottom: 20,
  },
  selectLabel: { display: "grid", gap: 6, fontSize: 12, color: "#475569", marginBottom: 14 },
  select: { padding: "7px 9px", borderRadius: 7, border: "1px solid #cbd5e1", fontSize: 13 },
  actions: { display: "flex", flexDirection: "column", gap: 8 },
  primaryButton: {
    padding: "10px 16px",
    borderRadius: 8,
    border: "none",
    fontSize: 13,
    fontWeight: 700,
    color: "#fff",
    cursor: "pointer",
    textAlign: "left",
  },
  buttonSubtext: { fontSize: 10, fontWeight: 400, opacity: 0.8, marginTop: 2 },
  cancelButton: {
    marginTop: 16,
    width: "100%",
    padding: 8,
    borderRadius: 8,
    border: "1px solid #e5e7eb",
    background: "#fff",
    fontSize: 12,
    color: "#64748b",
    cursor: "pointer",
  },
};
