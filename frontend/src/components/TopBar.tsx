import React from "react";
import type { AppMode, RobotState, CameraState, LoggerState } from "../types";

interface Props {
  mode: AppMode;
  robot: RobotState;
  camera: CameraState;
  logger: LoggerState;
  devMode: boolean;
  onToggleDev: () => void;
}

type ChipStatus = "ok" | "warn" | "error" | "off";

interface Chip {
  label: string;
  detail: string;
  status: ChipStatus;
}

const CHIP_COLOR: Record<ChipStatus, string> = {
  ok: "#22c55e",
  warn: "#f59e0b",
  error: "#ef4444",
  off: "#9ca3af",
};

export default function TopBar({ mode, robot, camera, logger, devMode, onToggleDev }: Props) {
  const camVals = Object.values(camera.cameras ?? {});
  const camStreaming = camVals.length > 0
    ? camVals.some(c => c.streaming)
    : (camera.streaming ?? false);
  const camDropped = camVals.reduce((s, c) => s + (c.dropped_frames ?? 0), 0);

  const chips: Chip[] = [
    {
      label: "Robot",
      detail: robot.connected ? `${robot.hz ?? 0} Hz` : "disconnected",
      status: robot.connected ? "ok" : "error",
    },
    {
      label: "Camera",
      detail: camStreaming ? (camDropped > 0 ? `${camDropped} dropped` : "streaming") : "disconnected",
      status: camStreaming ? (camDropped > 0 ? "warn" : "ok") : "error",
    },
    {
      label: "Logger",
      detail: logger.episode_id ? logger.episode_id.slice(-12) : "idle",
      status: logger.episode_id ? "ok" : "off",
    },
    {
      label: "Disk",
      detail: logger.disk_free_gb !== undefined ? `${logger.disk_free_gb} GB free` : "-",
      status: (logger.disk_free_gb ?? 999) > 10 ? "ok" : "warn",
    },
  ];

  return (
    <header style={styles.bar}>
      <span style={styles.title}>Piper Capture</span>

      <div style={styles.chips}>
        {chips.map(c => (
          <span key={c.label} style={{ ...styles.chip, borderColor: CHIP_COLOR[c.status] }}>
            <span style={{ ...styles.dot, background: CHIP_COLOR[c.status] }} />
            <strong>{c.label}</strong>&nbsp;{c.detail}
          </span>
        ))}
      </div>

      <div style={styles.right}>
        <button
          style={{ ...styles.devBtn, background: devMode ? "#6366f1" : "#e5e7eb" }}
          onClick={onToggleDev}
        >
          {devMode ? "DEV ON" : "DEV"}
        </button>
      </div>
    </header>
  );
}

const styles: Record<string, React.CSSProperties> = {
  bar: {
    display: "flex",
    alignItems: "center",
    gap: 12,
    background: "#1e293b",
    color: "#fff",
    padding: "8px 16px",
    flexShrink: 0,
    flexWrap: "wrap",
  },
  title: {
    fontWeight: 700,
    fontSize: 15,
    letterSpacing: 0.3,
    marginRight: 8,
  },
  chips: {
    display: "flex",
    gap: 8,
    flex: 1,
    flexWrap: "wrap",
  },
  chip: {
    display: "flex",
    alignItems: "center",
    gap: 5,
    background: "#334155",
    border: "1.5px solid",
    borderRadius: 6,
    padding: "3px 10px",
    fontSize: 12,
    fontFamily: "monospace",
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: "50%",
    flexShrink: 0,
  },
  right: {
    display: "flex",
    alignItems: "center",
    gap: 8,
  },
  devBtn: {
    border: "none",
    borderRadius: 4,
    padding: "3px 10px",
    cursor: "pointer",
    fontSize: 11,
    fontWeight: 700,
    color: "#1e293b",
  },
};
