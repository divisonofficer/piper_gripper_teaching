import React, { useState, useEffect } from "react";
import type { AppMode, SaveStep, SaveStepStatus } from "../types";

interface Props {
  mode: AppMode;
  availableActions: string[];
  episodeId?: string;
  saveSteps?: SaveStep[];
}

export default function ReviewPage({ mode, availableActions, episodeId, saveSteps = [] }: Props) {
  const [label, setLabel] = useState<"success" | "failure" | null>(null);
  const [reason, setReason] = useState("");
  const [saving, setSaving] = useState(false);

  const can = (a: string) => availableActions.includes(a);

  const handleSave = async () => {
    if (!label) return;
    setSaving(true);
    await fetch("/api/episodes/save", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ success: label === "success", reason }),
    });
    setSaving(false);
  };

  const handleDiscard = () => {
    if (window.confirm("Discard this episode? This cannot be undone.")) {
      fetch("/api/episodes/discard", { method: "POST" });
    }
  };

  const handleRetakeReplay = () => {
    fetch("/api/episodes/retake_replay", { method: "POST" });
  };

  const handleRetakeTeach = () => {
    fetch("/api/episodes/retake_teach", { method: "POST" });
  };

  const handleAddTake = () => {
    fetch("/api/episodes/add_take", { method: "POST" });
  };

  const handleNew = () => {
    fetch("/api/episodes/new", { method: "POST" });
  };

  type VideoTab = "color" | "depth" | "webcam_0" | "webcam_1";
  const [videoTab, setVideoTab] = useState<VideoTab>("color");
  const [hasWebcam0, setHasWebcam0] = useState(false);
  const [hasWebcam1, setHasWebcam1] = useState(false);

  useEffect(() => {
    if (!episodeId) return;
    fetch(`/api/episodes/${episodeId}`)
      .then(r => r.json())
      .then(ep => {
        // check latest take flags
        const takes: Array<{ has_webcam_0?: boolean; has_webcam_1?: boolean }> = ep.takes ?? [];
        if (takes.length > 0) {
          const latest = takes[takes.length - 1];
          setHasWebcam0(!!latest.has_webcam_0);
          setHasWebcam1(!!latest.has_webcam_1);
        }
      })
      .catch(() => {});
  }, [episodeId]);

  const VIDEO_TABS: Array<{ id: VideoTab; label: string }> = [
    { id: "color",    label: "Color" },
    { id: "depth",    label: "Depth" },
    ...(hasWebcam0 ? [{ id: "webcam_0" as VideoTab, label: "Cam0" }] : []),
    ...(hasWebcam1 ? [{ id: "webcam_1" as VideoTab, label: "Cam1" }] : []),
  ];

  const VIDEO_URL_MAP: Record<VideoTab, string> = {
    color:    `/api/episodes/${episodeId}/video`,
    depth:    `/api/episodes/${episodeId}/video_depth`,
    webcam_0: `/api/episodes/${episodeId}/video_webcam_0`,
    webcam_1: `/api/episodes/${episodeId}/video_webcam_1`,
  };

  const videoUrl = episodeId ? VIDEO_URL_MAP[videoTab] : null;

  if (mode === "PROCESSING") {
    return (
      <div style={styles.center}>
        <div style={{ fontSize: 36, marginBottom: 12 }}>⏳</div>
        <h2 style={{ color: "#6366f1", marginBottom: 4 }}>데이터 저장 중...</h2>
        <p style={{ ...styles.subtext, marginBottom: 24 }}>{episodeId}</p>
        <div style={stepListStyles.container}>
          {saveSteps.map(step => (
            <div key={step.key} style={stepListStyles.row}>
              <span style={stepListStyles.icon(step.status)}>
                {step.status === "waiting" ? "○"
                  : step.status === "running" ? "◐"
                  : step.status === "ok" ? "✓"
                  : "✗"}
              </span>
              <span style={stepListStyles.label}>{step.label}</span>
              {step.detail && (
                <span style={stepListStyles.detail}>{step.detail}</span>
              )}
            </div>
          ))}
        </div>
      </div>
    );
  }

  if (mode === "SAVED") {
    return (
      <div style={styles.center}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✓</div>
        <h2 style={{ color: "#15803d", marginBottom: 8 }}>Episode Saved</h2>
        <p style={styles.subtext}>{episodeId}</p>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, width: 260 }}>
          <button style={styles.primaryBtn} onClick={handleNew}>
            Start New Episode
          </button>
          {can("add_take") && (
            <button style={{ ...styles.secondaryBtn, fontSize: 14 }} onClick={handleAddTake}>
              Add Another Take to This Episode
            </button>
          )}
        </div>
      </div>
    );
  }

  if (mode === "DISCARDED") {
    return (
      <div style={styles.center}>
        <div style={{ fontSize: 48, marginBottom: 12 }}>✗</div>
        <h2 style={{ color: "#6b7280", marginBottom: 8 }}>Episode Discarded</h2>
        <button style={styles.primaryBtn} onClick={handleNew}>
          Start New Episode
        </button>
      </div>
    );
  }

  return (
    <div style={styles.container}>
      <h2 style={styles.title}>Review Episode</h2>
      {episodeId && <p style={styles.subtext}>{episodeId}</p>}

      <div style={styles.row}>
        {/* Video preview */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", gap: 8 }}>
          {/* 탭 */}
          <div style={{ display: "flex", gap: 4 }}>
            {VIDEO_TABS.map(({ id, label }) => (
              <button
                key={id}
                style={{
                  padding: "4px 14px",
                  borderRadius: 6,
                  border: "1px solid #e2e8f0",
                  background: videoTab === id ? "#6366f1" : "#f8fafc",
                  color: videoTab === id ? "#fff" : "#374151",
                  fontWeight: 600,
                  fontSize: 12,
                  cursor: "pointer",
                }}
                onClick={() => setVideoTab(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <div style={styles.videoBox}>
            {videoUrl ? (
              <video
                key={videoUrl}   /* key 변경으로 탭 전환 시 영상 재로드 */
                controls
                src={videoUrl}
                style={styles.video}
              />
            ) : (
              <div style={styles.noVideo}>Video not available yet</div>
            )}
          </div>
        </div>

        {/* Label & save */}
        <div style={styles.labelPanel}>
          <div style={styles.sectionTitle}>Label this episode</div>

          <div style={styles.labelBtns}>
            <LabelBtn
              label="Success"
              selected={label === "success"}
              color="#22c55e"
              onClick={() => setLabel("success")}
            />
            <LabelBtn
              label="Failure"
              selected={label === "failure"}
              color="#ef4444"
              onClick={() => setLabel("failure")}
            />
          </div>

          {label === "failure" && (
            <>
              <label style={styles.fieldLabel}>Failure reason</label>
              <select
                style={styles.select}
                value={reason}
                onChange={e => setReason(e.target.value)}
              >
                <option value="">— select —</option>
                <option value="grasp_fail">Grasp failed</option>
                <option value="object_slip">Object slipped</option>
                <option value="collision">Collision</option>
                <option value="camera_issue">Camera issue</option>
                <option value="trajectory_error">Trajectory error</option>
                <option value="other">Other</option>
              </select>
            </>
          )}

          <div style={styles.actionBtns}>
            <button
              style={{ ...styles.primaryBtn, opacity: (!label || saving) ? 0.5 : 1 }}
              onClick={handleSave}
              disabled={!label || saving || !can("save_episode")}
            >
              {saving ? "Saving..." : "Save Episode"}
            </button>

            {can("retake_replay") && (
              <button style={styles.secondaryBtn} onClick={handleRetakeReplay}>
                Re-replay (adjust speed)
              </button>
            )}

            {can("retake_teach") && (
              <button style={styles.secondaryBtn} onClick={handleRetakeTeach}>
                Re-teach (new recording)
              </button>
            )}

            {can("discard_episode") && (
              <button style={styles.dangerBtn} onClick={handleDiscard}>
                Discard
              </button>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function LabelBtn({
  label, selected, color, onClick,
}: { label: string; selected: boolean; color: string; onClick: () => void }) {
  return (
    <button
      style={{
        flex: 1,
        padding: "12px 0",
        border: `2px solid ${selected ? color : "#e5e7eb"}`,
        borderRadius: 8,
        background: selected ? color + "20" : "#fff",
        color: selected ? color : "#6b7280",
        fontWeight: 700,
        fontSize: 14,
        cursor: "pointer",
      }}
      onClick={onClick}
    >
      {label}
    </button>
  );
}

const STEP_COLORS: Record<SaveStepStatus, string> = {
  waiting: "#94a3b8",
  running: "#6366f1",
  ok:      "#22c55e",
  failed:  "#ef4444",
};

const stepListStyles = {
  container: {
    background: "#fff",
    borderRadius: 12,
    padding: "16px 24px",
    width: 360,
    display: "flex",
    flexDirection: "column",
    gap: 10,
  } as React.CSSProperties,
  row: {
    display: "flex",
    alignItems: "center",
    gap: 10,
    fontSize: 14,
  } as React.CSSProperties,
  icon: (status: SaveStepStatus): React.CSSProperties => ({
    width: 20,
    textAlign: "center",
    fontWeight: 700,
    color: STEP_COLORS[status],
    animation: status === "running" ? "spin 1s linear infinite" : undefined,
  }),
  label: {
    flex: 1,
    color: "#1e293b",
  } as React.CSSProperties,
  detail: {
    fontSize: 11,
    color: "#94a3b8",
    fontFamily: "monospace",
  } as React.CSSProperties,
};

const styles: Record<string, React.CSSProperties> = {
  container: {
    maxWidth: 900,
    margin: "0 auto",
  },
  title: {
    fontSize: 20,
    fontWeight: 700,
    marginBottom: 4,
    color: "#1e293b",
  },
  subtext: {
    fontSize: 12,
    color: "#94a3b8",
    fontFamily: "monospace",
    marginBottom: 20,
  },
  row: {
    display: "flex",
    gap: 20,
  },
  videoBox: {
    flex: 1,
    background: "#0f172a",
    borderRadius: 12,
    overflow: "hidden",
    minHeight: 300,
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
  },
  noVideo: {
    color: "#475569",
    fontSize: 13,
  },
  labelPanel: {
    width: 260,
    background: "#fff",
    borderRadius: 12,
    padding: 20,
    flexShrink: 0,
    display: "flex",
    flexDirection: "column",
    gap: 12,
  },
  sectionTitle: {
    fontWeight: 700,
    fontSize: 14,
    color: "#1e293b",
  },
  labelBtns: {
    display: "flex",
    gap: 8,
  },
  fieldLabel: {
    fontSize: 12,
    color: "#6b7280",
  },
  select: {
    width: "100%",
    border: "1px solid #d1d5db",
    borderRadius: 6,
    padding: "6px 8px",
    fontSize: 13,
  },
  actionBtns: {
    display: "flex",
    flexDirection: "column",
    gap: 8,
    marginTop: 8,
  },
  primaryBtn: {
    padding: "10px 0",
    background: "#6366f1",
    color: "#fff",
    border: "none",
    borderRadius: 8,
    fontWeight: 700,
    fontSize: 14,
    cursor: "pointer",
    width: "100%",
  },
  secondaryBtn: {
    padding: "8px 0",
    background: "#f1f5f9",
    color: "#374151",
    border: "none",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    width: "100%",
  },
  dangerBtn: {
    padding: "8px 0",
    background: "#fef2f2",
    color: "#dc2626",
    border: "1px solid #fca5a5",
    borderRadius: 8,
    fontSize: 13,
    cursor: "pointer",
    width: "100%",
  },
  center: {
    display: "flex",
    flexDirection: "column",
    alignItems: "center",
    justifyContent: "center",
    height: "60vh",
    textAlign: "center",
  },
};
