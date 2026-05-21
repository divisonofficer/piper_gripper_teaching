import React from "react";

export interface CameraTab {
  id: string;
  label: string;
  avail: boolean;
  maskable: boolean;
  maskCameraId?: string;
}

interface VideoPaneProps {
  tabs: CameraTab[];
  videoSource: string;
  videoUrl: string | null;
  currentTime: number;
  loop?: boolean;
  postprocessMode?: boolean;
  maskEnabled?: boolean;
  maskCameraId?: string;
  onVideoSourceChange: (id: string) => void;
  onMaskCameraChange?: (cameraId: string) => void;
  onLoadedMetadata: (duration?: number) => void;
  onTimeUpdate: (time: number) => void;
}

export default function VideoPane({
  tabs,
  videoSource,
  videoUrl,
  currentTime,
  loop = false,
  postprocessMode = false,
  maskEnabled = false,
  maskCameraId,
  onVideoSourceChange,
  onMaskCameraChange,
  onLoadedMetadata,
  onTimeUpdate,
}: VideoPaneProps) {
  const videoRef = React.useRef<HTMLVideoElement>(null);

  const handleTabClick = (tab: CameraTab) => {
    onVideoSourceChange(tab.id);
    if (postprocessMode && tab.maskable && tab.maskCameraId) {
      onMaskCameraChange?.(tab.maskCameraId);
    }
  };

  return (
    <div style={styles.cell}>
      <div style={styles.header}>
        <span>Video</span>
        <span style={styles.time}>{currentTime.toFixed(2)}s</span>
      </div>
      <div style={styles.tabs}>
        {tabs.filter(t => t.avail).map(tab => {
          const active = videoSource === tab.id;
          const isMaskTarget = !!maskCameraId && tab.maskCameraId === maskCameraId;
          const showMaskOn = isMaskTarget && maskEnabled;
          return (
            <button
              key={tab.id}
              onClick={() => handleTabClick(tab)}
              title={!tab.maskable && postprocessMode ? "Reference only. Depth streams cannot be mask targets." : undefined}
              style={{
                ...styles.tab,
                background: active ? "#4f46e5" : "#f1f5f9",
                color: active ? "#fff" : "#334155",
                borderColor: isMaskTarget ? "#22c55e" : "transparent",
                boxShadow: isMaskTarget ? "0 0 0 1px #22c55e inset" : "none",
              }}
            >
              <span>{tab.label}</span>
              {isMaskTarget && <span style={styles.maskBadge}>{showMaskOn ? "Mask ON" : "MASK"}</span>}
              {postprocessMode && !tab.maskable && <span style={styles.refBadge}>REF</span>}
            </button>
          );
        })}
      </div>
      <div style={styles.videoWrap}>
        {videoUrl ? (
          <video
            key={videoUrl}
            ref={videoRef}
            controls
            loop={loop}
            playsInline
            onLoadedMetadata={() => onLoadedMetadata(videoRef.current?.duration)}
            onTimeUpdate={() => onTimeUpdate(videoRef.current?.currentTime ?? 0)}
            style={styles.video}
          >
            <source src={videoUrl} type="video/mp4" />
          </video>
        ) : (
          <div style={styles.empty}>No video available</div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  cell: {
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
    display: "flex",
    flexDirection: "column",
  },
  header: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "6px 10px",
    borderBottom: "1px solid #f1f5f9",
    fontSize: 11,
    fontWeight: 800,
    color: "#64748b",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
  },
  time: {
    color: "#4f46e5",
    fontWeight: 900,
    textTransform: "none",
    letterSpacing: 0,
  },
  tabs: {
    flex: "0 0 auto",
    display: "flex",
    gap: 4,
    padding: "7px 8px",
    overflowX: "auto",
  },
  tab: {
    display: "inline-flex",
    alignItems: "center",
    gap: 5,
    border: "1px solid transparent",
    borderRadius: 6,
    padding: "4px 8px",
    fontSize: 11,
    fontWeight: 800,
    cursor: "pointer",
    whiteSpace: "nowrap",
  },
  maskBadge: {
    borderRadius: 4,
    padding: "1px 4px",
    background: "#dcfce7",
    color: "#15803d",
    fontSize: 8,
    fontWeight: 900,
    lineHeight: 1.2,
  },
  refBadge: {
    borderRadius: 4,
    padding: "1px 4px",
    background: "#e2e8f0",
    color: "#64748b",
    fontSize: 8,
    fontWeight: 900,
    lineHeight: 1.2,
  },
  videoWrap: {
    flex: "1 1 auto",
    minHeight: 0,
    background: "#0f172a",
    overflow: "hidden",
  },
  video: {
    width: "100%",
    height: "100%",
    objectFit: "contain",
    background: "#0f172a",
    display: "block",
  },
  empty: {
    height: "100%",
    display: "flex",
    alignItems: "center",
    justifyContent: "center",
    color: "#94a3b8",
    fontSize: 12,
    fontWeight: 800,
  },
};
