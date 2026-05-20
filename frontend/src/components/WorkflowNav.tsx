import React from "react";
import type { AppMode } from "../types";
import type { Page } from "../App";

interface Props {
  mode: AppMode;
  page: Page;
  onNavigate: (p: Page) => void;
  onGoBack?: () => void;  // TRAJECTORY_CHECK / REPLAY_READY / REVIEW → TEACH_READY
}

const STEPS: { modes: AppMode[]; label: string }[] = [
  { modes: ["IDLE", "CONNECTING", "READY"], label: "1. Setup" },
  { modes: ["TEACH_READY", "TEACH_RECORDING"], label: "2. Teach" },
  { modes: ["TRAJECTORY_CHECK", "RETURN_HOME", "REPLAY_READY"], label: "3. Home" },
  { modes: ["REPLAY_RECORDING"], label: "4. Record" },
  { modes: ["REVIEW", "SAVED", "DISCARDED"], label: "5. Review" },
];

// 현재 mode가 몇 번째 step에 있는지
function currentStepIdx(mode: AppMode): number {
  return STEPS.findIndex(s => s.modes.includes(mode));
}

// "뒤로 가기" 버튼을 보여줄 모드
const GO_BACK_MODES: AppMode[] = ["TRAJECTORY_CHECK", "REPLAY_READY", "REVIEW"];

const PAGE_LINKS: { page: Page; label: string }[] = [
  { page: "capture", label: "Capture" },
  { page: "review", label: "Review" },
  { page: "dataset", label: "Dataset" },
  { page: "setup", label: "Setup" },
  { page: "diagnostics", label: "Diagnostics" },
];

export default function WorkflowNav({ mode, page, onNavigate, onGoBack }: Props) {
  const curIdx = currentStepIdx(mode);
  const canGoBack = GO_BACK_MODES.includes(mode) && onGoBack;

  return (
    <nav style={styles.nav}>
      <div style={styles.section}>
        <div style={styles.sectionTitle}>WORKFLOW</div>
        {STEPS.map((step, stepIdx) => {
          const status: "done" | "active" | "pending" =
            stepIdx < curIdx ? "done" : stepIdx === curIdx ? "active" : "pending";

          // "2. Teach" step은 현재 step이 그 이후이고 back 가능하면 클릭 가능
          const isClickable = status === "done" && stepIdx === 1 && canGoBack;

          return (
            <div
              key={step.label}
              style={{
                ...styles.step,
                ...stepStyle(status),
                cursor: isClickable ? "pointer" : "default",
              }}
              title={isClickable ? "Click to retake from this step" : undefined}
              onClick={isClickable ? onGoBack : undefined}
            >
              <span style={styles.stepIcon}>
                {status === "done" ? "✓" : status === "active" ? "●" : "○"}
              </span>
              {step.label}
              {isClickable && <span style={styles.backHint}>↩</span>}
            </div>
          );
        })}
      </div>

      {/* 현재 step이 TRAJECTORY_CHECK 이후면 "← Retake" 버튼 표시 */}
      {canGoBack && (
        <div style={styles.section}>
          <button style={styles.goBackBtn} onClick={onGoBack}>
            ← Retake
          </button>
        </div>
      )}

      <div style={styles.section}>
        <div style={styles.sectionTitle}>PAGES</div>
        {PAGE_LINKS.map(({ page: p, label }) => (
          <button
            key={p}
            style={{ ...styles.navBtn, background: page === p ? "#e0e7ff" : "transparent" }}
            onClick={() => onNavigate(p)}
          >
            {label}
          </button>
        ))}
      </div>
    </nav>
  );
}

function stepStyle(status: "done" | "active" | "pending"): React.CSSProperties {
  if (status === "done") return { color: "#22c55e", fontWeight: 600 };
  if (status === "active") return { color: "#6366f1", fontWeight: 700, background: "#eef2ff", borderRadius: 6 };
  return { color: "#9ca3af" };
}

const styles: Record<string, React.CSSProperties> = {
  nav: {
    width: 160,
    background: "#fff",
    borderRight: "1px solid #e5e7eb",
    padding: "16px 8px",
    display: "flex",
    flexDirection: "column",
    gap: 20,
    flexShrink: 0,
    overflowY: "auto",
  },
  section: {
    display: "flex",
    flexDirection: "column",
    gap: 2,
  },
  sectionTitle: {
    fontSize: 10,
    fontWeight: 700,
    color: "#94a3b8",
    letterSpacing: 1,
    padding: "4px 8px",
    marginBottom: 4,
  },
  step: {
    display: "flex",
    alignItems: "center",
    gap: 8,
    padding: "6px 8px",
    fontSize: 13,
    transition: "all 0.15s",
    borderRadius: 6,
    userSelect: "none",
  },
  stepIcon: {
    fontSize: 14,
    width: 16,
    flexShrink: 0,
  },
  backHint: {
    marginLeft: "auto",
    fontSize: 11,
    color: "#6366f1",
    opacity: 0.7,
  },
  goBackBtn: {
    background: "#fef3c7",
    border: "1px solid #fcd34d",
    borderRadius: 6,
    padding: "6px 10px",
    fontSize: 12,
    fontWeight: 600,
    color: "#92400e",
    cursor: "pointer",
    textAlign: "left" as const,
  },
  navBtn: {
    display: "block",
    width: "100%",
    textAlign: "left",
    border: "none",
    borderRadius: 6,
    padding: "6px 12px",
    fontSize: 13,
    cursor: "pointer",
    color: "#374151",
  },
};
