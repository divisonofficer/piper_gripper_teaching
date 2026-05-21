import React, { useState, useEffect } from "react";
import type { CameraManifest, CameraManifestEntry, RobotState } from "../types";

interface Props {
  robot: RobotState;
}

type Waypoint = number[];  // [q1, q2, q3, q4, q5, q6]

export default function SetupPage({ robot }: Props) {
  const [waypoints, setWaypoints] = useState<Waypoint[]>([]);
  const [savedWaypoints, setSavedWaypoints] = useState<Waypoint[]>([]);
  const [saving, setSaving] = useState(false);
  const [recording, setRecording] = useState(false);
  const [msg, setMsg] = useState<{ text: string; ok: boolean } | null>(null);
  const [cameraManifest, setCameraManifest] = useState<CameraManifest | null>(null);
  const [savedCameraManifest, setSavedCameraManifest] = useState<CameraManifest | null>(null);
  const [savingCameras, setSavingCameras] = useState(false);

  const isDirty = JSON.stringify(waypoints) !== JSON.stringify(savedWaypoints);
  const camerasDirty = JSON.stringify(cameraManifest) !== JSON.stringify(savedCameraManifest);

  const showMsg = (text: string, ok: boolean) => {
    setMsg({ text, ok });
    setTimeout(() => setMsg(null), 3000);
  };

  // 서버에서 기존 waypoints 로드
  useEffect(() => {
    fetch("/api/robot/safe_waypoints")
      .then(r => r.json())
      .then(d => {
        if (d.ok && Array.isArray(d.waypoints)) {
          setWaypoints(d.waypoints);
          setSavedWaypoints(d.waypoints);
        }
      })
      .catch(() => {});
    fetch("/api/cameras/manifest")
      .then(r => r.json())
      .then((d: CameraManifest) => {
        setCameraManifest(d);
        setSavedCameraManifest(d);
      })
      .catch(() => {});
  }, []);

  // 현재 joint 위치 캡처
  const handleRecord = () => {
    setRecording(true);
    fetch("/api/robot/safe_waypoints/record", { method: "POST" })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.position) {
          setWaypoints(prev => [...prev, d.position]);
          showMsg("Waypoint recorded", true);
        } else {
          showMsg(d.reason ?? "Record failed", false);
        }
      })
      .catch(() => showMsg("Request failed", false))
      .finally(() => setRecording(false));
  };

  // 저장
  const handleSave = () => {
    setSaving(true);
    fetch("/api/robot/safe_waypoints/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ waypoints }),
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok) {
          setSavedWaypoints(waypoints);
          showMsg(`Saved ${d.count} waypoint${d.count !== 1 ? "s" : ""}`, true);
        } else {
          showMsg(d.reason ?? "Save failed", false);
        }
      })
      .catch(() => showMsg("Request failed", false))
      .finally(() => setSaving(false));
  };

  const handleDelete = (idx: number) => {
    setWaypoints(prev => prev.filter((_, i) => i !== idx));
  };

  const handleMoveUp = (idx: number) => {
    if (idx === 0) return;
    setWaypoints(prev => {
      const next = [...prev];
      [next[idx - 1], next[idx]] = [next[idx], next[idx - 1]];
      return next;
    });
  };

  const handleMoveDown = (idx: number) => {
    setWaypoints(prev => {
      if (idx >= prev.length - 1) return prev;
      const next = [...prev];
      [next[idx], next[idx + 1]] = [next[idx + 1], next[idx]];
      return next;
    });
  };

  const handleClear = () => {
    if (window.confirm("Clear all waypoints? The saved file will be overwritten on next Save.")) {
      setWaypoints([]);
    }
  };

  const updateCamera = (id: string, patch: Partial<CameraManifestEntry>) => {
    setCameraManifest(prev => prev ? {
      ...prev,
      cameras: prev.cameras.map(c => c.id === id ? { ...c, ...patch } : c),
    } : prev);
  };

  const togglePreset = (cam: CameraManifestEntry, preset: "default" | "all" | "debug") => {
    updateCamera(cam.id, {
      export_presets: cam.export_presets.includes(preset)
        ? cam.export_presets.filter(p => p !== preset)
        : [...cam.export_presets, preset],
    });
  };

  const saveCameraManifest = () => {
    if (!cameraManifest) return;
    setSavingCameras(true);
    fetch("/api/cameras/manifest", {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(cameraManifest),
    })
      .then(r => r.json())
      .then((d: CameraManifest) => {
        setCameraManifest(d);
        setSavedCameraManifest(d);
        showMsg("Camera manifest saved", true);
      })
      .catch(() => showMsg("Camera manifest save failed", false))
      .finally(() => setSavingCameras(false));
  };

  // 현재 로봇 위치 (실시간 표시용)
  const currentPos = robot.position ?? [];

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Safe Return Waypoints</h2>
      <p style={styles.desc}>
        Robot returns through these waypoints (in order) after <strong>retake_teach</strong> or <strong>add_take</strong>.
        At least 2 waypoints recommended: <em>clearance</em> → <em>ready</em>.
      </p>

      {/* 현재 위치 패널 */}
      <div style={styles.currentPanel}>
        <div style={styles.panelLabel}>Current Joint Position (live)</div>
        <div style={styles.jointRow}>
          {[1, 2, 3, 4, 5, 6].map(i => (
            <div key={i} style={styles.jointCell}>
              <div style={styles.jointLabel}>q{i}</div>
              <div style={styles.jointVal}>
                {currentPos[i - 1] !== undefined ? currentPos[i - 1].toFixed(4) : "—"}
              </div>
            </div>
          ))}
        </div>

        <div style={{ display: "flex", gap: 8, marginTop: 12, alignItems: "center" }}>
          <button
            style={{
              ...styles.recordBtn,
              opacity: (recording || !robot.connected) ? 0.5 : 1,
            }}
            onClick={handleRecord}
            disabled={recording || !robot.connected}
          >
            {recording ? "Recording..." : "⊕ Record Current Position"}
          </button>
          <span style={styles.hint}>
            Move robot to desired pose (freedrive), then click Record.
          </span>
        </div>
      </div>

      {/* Waypoint 목록 */}
      <div style={styles.listSection}>
        <div style={styles.listHeader}>
          <span style={styles.listTitle}>
            Waypoints ({waypoints.length})
            {isDirty && <span style={styles.unsaved}> — unsaved changes</span>}
          </span>
          {waypoints.length > 0 && (
            <button style={styles.clearBtn} onClick={handleClear}>Clear all</button>
          )}
        </div>

        {waypoints.length === 0 ? (
          <div style={styles.empty}>
            No waypoints recorded yet. Record at least 2 (clearance + ready).
          </div>
        ) : (
          <div style={styles.list}>
            {waypoints.map((wp, idx) => (
              <WaypointRow
                key={idx}
                index={idx}
                total={waypoints.length}
                wp={wp}
                onMoveUp={() => handleMoveUp(idx)}
                onMoveDown={() => handleMoveDown(idx)}
                onDelete={() => handleDelete(idx)}
              />
            ))}
          </div>
        )}
      </div>

      {/* 저장 버튼 + 상태 */}
      <div style={{ display: "flex", alignItems: "center", gap: 12, marginTop: 4 }}>
        <button
          style={{
            ...styles.saveBtn,
            opacity: (saving || !isDirty) ? 0.5 : 1,
          }}
          onClick={handleSave}
          disabled={saving || !isDirty}
        >
          {saving ? "Saving..." : "Save Waypoints"}
        </button>
        {msg && (
          <span style={{ ...styles.msgBadge, background: msg.ok ? "#dcfce7" : "#fee2e2", color: msg.ok ? "#15803d" : "#dc2626" }}>
            {msg.ok ? "✓" : "✗"} {msg.text}
          </span>
        )}
        {!isDirty && waypoints.length > 0 && !msg && (
          <span style={styles.savedBadge}>✓ Saved — automatic home return active</span>
        )}
        {!isDirty && waypoints.length === 0 && !msg && (
          <span style={styles.warnBadge}>⚠ No waypoints — manual reset required after retake</span>
        )}
      </div>

      {/* 사용법 안내 */}
      <div style={styles.guide}>
        <div style={styles.guideTitle}>How to set up</div>
        <ol style={styles.guideList}>
          <li>Disable motors (freedrive): <code>Motors → Disable</code> in Diagnostics, or use the robot&apos;s teach button.</li>
          <li>Move robot to <strong>clearance pose</strong> (EE clear of table/objects).</li>
          <li>Click <strong>Record Current Position</strong>.</li>
          <li>Move robot to <strong>ready pose</strong> (task start position).</li>
          <li>Click <strong>Record Current Position</strong> again.</li>
          <li>Click <strong>Save Waypoints</strong>.</li>
        </ol>
        <p style={styles.guideNote}>
          Tip: waypoints are executed in top-to-bottom order. If a waypoint is not reached within timeout, the return motion aborts at that position.
        </p>
      </div>

      <div style={styles.cameraSection}>
        <h2 style={styles.title}>Camera Manifest</h2>
        <p style={styles.desc}>
          Camera roles keep the dataset contract stable: cam0 is ego view, cam1 is overview, RealSense is the depth sensor.
        </p>
        {!cameraManifest ? (
          <div style={styles.empty}>Camera manifest unavailable.</div>
        ) : (
          <div style={styles.cameraList}>
            {cameraManifest.cameras.map(cam => (
              <div key={cam.id} style={styles.cameraRow}>
                <div>
                  <div style={styles.camId}>{cam.id}</div>
                  <div style={styles.camRole}>{cam.role} · {cam.type}</div>
                  <div style={styles.camRole}>legacy: {cam.legacy_id}</div>
                </div>
                <label style={styles.checkboxLabel}>
                  <input type="checkbox" checked={cam.enabled} onChange={e => updateCamera(cam.id, { enabled: e.target.checked })} />
                  enabled
                </label>
                <input value={cam.label} onChange={e => updateCamera(cam.id, { label: e.target.value })}
                  style={styles.cameraInput} placeholder="Label" />
                <input value={cam.device} onChange={e => updateCamera(cam.id, { device: e.target.value })}
                  style={styles.cameraInput} placeholder="/dev/video4 or auto:C270:0" />
                <div style={styles.presetGroup}>
                  {(["default", "all", "debug"] as const).map(p => (
                    <label key={p} style={styles.presetChip}>
                      <input type="checkbox" checked={cam.export_presets.includes(p)} onChange={() => togglePreset(cam, p)} />
                      {p}
                    </label>
                  ))}
                </div>
              </div>
            ))}
          </div>
        )}
        <button
          style={{ ...styles.saveBtn, opacity: (!camerasDirty || savingCameras) ? 0.5 : 1 }}
          onClick={saveCameraManifest}
          disabled={!camerasDirty || savingCameras}
        >
          {savingCameras ? "Saving..." : "Save Camera Manifest"}
        </button>
      </div>
    </div>
  );
}

function WaypointRow({
  index, total, wp, onMoveUp, onMoveDown, onDelete,
}: {
  index: number; total: number; wp: Waypoint;
  onMoveUp: () => void; onMoveDown: () => void; onDelete: () => void;
}) {
  const label = index === 0 ? "clearance" : index === total - 1 ? "ready" : `wp ${index + 1}`;
  return (
    <div style={styles.wpRow}>
      <div style={styles.wpIndex}>{index + 1}</div>
      <div style={styles.wpLabel}>{label}</div>
      <div style={styles.wpVals}>
        {wp.map((v, j) => (
          <span key={j} style={styles.wpVal}>
            <span style={styles.wpValKey}>q{j + 1}</span>
            {v.toFixed(3)}
          </span>
        ))}
      </div>
      <div style={styles.wpActions}>
        <button style={styles.iconBtn} onClick={onMoveUp} disabled={index === 0} title="Move up">↑</button>
        <button style={styles.iconBtn} onClick={onMoveDown} disabled={index === total - 1} title="Move down">↓</button>
        <button style={{ ...styles.iconBtn, color: "#ef4444" }} onClick={onDelete} title="Delete">✕</button>
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: { maxWidth: 860 },
  title: { fontSize: 20, fontWeight: 700, color: "#1e293b", marginBottom: 4 },
  desc: { fontSize: 13, color: "#6b7280", marginBottom: 20, lineHeight: 1.6 },

  currentPanel: {
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: 16,
    marginBottom: 16,
  },
  panelLabel: { fontSize: 11, fontWeight: 700, color: "#94a3b8", letterSpacing: 1, marginBottom: 10 },
  jointRow: { display: "flex", gap: 8 },
  jointCell: {
    flex: 1,
    background: "#f8fafc",
    borderRadius: 6,
    padding: "6px 8px",
    textAlign: "center" as const,
  },
  jointLabel: { fontSize: 10, color: "#94a3b8", fontWeight: 700 },
  jointVal: { fontSize: 12, fontFamily: "monospace", color: "#1e293b", fontWeight: 700, marginTop: 2 },

  recordBtn: {
    padding: "8px 18px",
    background: "#6366f1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 13,
    cursor: "pointer",
    whiteSpace: "nowrap" as const,
  },
  hint: { fontSize: 12, color: "#94a3b8" },

  listSection: { background: "#fff", border: "1px solid #e5e7eb", borderRadius: 10, padding: 16, marginBottom: 16 },
  listHeader: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 },
  listTitle: { fontWeight: 700, fontSize: 14, color: "#1e293b" },
  unsaved: { color: "#f59e0b", fontSize: 12, fontWeight: 600 },
  clearBtn: {
    background: "transparent", border: "1px solid #e5e7eb",
    borderRadius: 6, padding: "3px 10px", fontSize: 12, color: "#6b7280", cursor: "pointer",
  },
  empty: { fontSize: 13, color: "#9ca3af", textAlign: "center" as const, padding: "20px 0" },
  list: { display: "flex", flexDirection: "column", gap: 6 },

  wpRow: {
    display: "flex", alignItems: "center", gap: 10,
    background: "#f8fafc", borderRadius: 8, padding: "8px 12px",
    border: "1px solid #e5e7eb",
  },
  wpIndex: { width: 20, fontWeight: 700, fontSize: 13, color: "#6366f1", flexShrink: 0 },
  wpLabel: { width: 70, fontSize: 11, color: "#94a3b8", fontWeight: 700, flexShrink: 0 },
  wpVals: { flex: 1, display: "flex", gap: 10, flexWrap: "wrap" as const },
  wpVal: { fontFamily: "monospace", fontSize: 12, color: "#374151" },
  wpValKey: { fontSize: 10, color: "#94a3b8", marginRight: 2 },
  wpActions: { display: "flex", gap: 4, flexShrink: 0 },
  iconBtn: {
    background: "transparent", border: "1px solid #e5e7eb",
    borderRadius: 5, width: 26, height: 26,
    fontSize: 12, cursor: "pointer", color: "#374151",
    display: "flex", alignItems: "center", justifyContent: "center",
  } as React.CSSProperties,

  saveBtn: {
    padding: "9px 22px",
    background: "#22c55e",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
  },
  msgBadge: { padding: "6px 12px", borderRadius: 6, fontSize: 13, fontWeight: 600 },
  savedBadge: { fontSize: 12, color: "#15803d", fontWeight: 600 },
  warnBadge: { fontSize: 12, color: "#b45309", fontWeight: 600 },

  guide: {
    background: "#f8fafc",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: 16,
    marginTop: 16,
  },
  guideTitle: { fontWeight: 700, fontSize: 13, color: "#374151", marginBottom: 8 },
  guideList: { fontSize: 13, color: "#4b5563", lineHeight: 2, paddingLeft: 20, margin: 0 },
  guideNote: { fontSize: 12, color: "#94a3b8", marginTop: 10, marginBottom: 0 },

  cameraSection: {
    marginTop: 24,
    background: "#fff",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    padding: 16,
  },
  cameraList: { display: "flex", flexDirection: "column", gap: 8, marginBottom: 12 },
  cameraRow: {
    display: "grid",
    gridTemplateColumns: "110px 90px 1fr 1.4fr 210px",
    gap: 8,
    alignItems: "center",
    padding: 10,
    border: "1px solid #eef2f7",
    borderRadius: 8,
  },
  camId: { fontSize: 13, fontWeight: 800, color: "#1e293b" },
  camRole: { fontSize: 10, color: "#94a3b8", marginTop: 2 },
  checkboxLabel: { display: "flex", alignItems: "center", gap: 5, fontSize: 12, color: "#475569" },
  cameraInput: { padding: "6px 8px", border: "1px solid #cbd5e1", borderRadius: 6, fontSize: 12 },
  presetGroup: { display: "flex", gap: 6, flexWrap: "wrap" as const },
  presetChip: { display: "flex", alignItems: "center", gap: 3, fontSize: 11, color: "#475569" },
};
