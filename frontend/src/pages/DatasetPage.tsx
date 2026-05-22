import React, { useState, useEffect, useCallback, useMemo } from "react";
import type { Episode, EpisodeTake, JointSample, TakeJointsData, EditMeta, MaskMeta, MaskLibraryEntry, EESample, TakeTrajectoryData } from "../types";
import PiperRobotViewer from "../components/PiperRobotViewer";
import { CompletenessChips, EpisodeCollectionItem, ReviewIssueBadges, StatusBadge } from "./dataset/DatasetCollection";
import ExportModal from "./dataset/ExportModal";
import { BatchInspector, EmptyInspector, SummaryItem } from "./dataset/InspectorSummary";
import VideoPane, { type CameraTab } from "./dataset/VideoPane";
import { fmtDate, fmtDuration, fmtMb, statusLabel, takeDuration, type InspectorTab, type ViewMode } from "./dataset/datasetUtils";

// ── Constants ────────────────────────────────────────────────────────────
const JOINT_COLORS = ["#6366f1", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];
const JOINT_LABELS = ["J1", "J2", "J3", "J4", "J5", "J6"];

// ── Joint Plot SVG (P1) ───────────────────────────────────────────────────
const JointPlot = React.memo(function JointPlot({
  data, source, currentTime,
}: {
  data: TakeJointsData;
  source: "teach" | "executed" | "command";
  currentTime: number;
}) {
  const samples: JointSample[] = data[source];
  if (!samples || samples.length === 0) {
    return (
      <div style={plotStyles.empty}>No {source} data</div>
    );
  }

  const W = 600, H = 150, PADL = 30, PADB = 18, PADT = 6, PADR = 8;
  const plotW = W - PADL - PADR;
  const plotH = H - PADT - PADB;

  const tRange = samples[samples.length - 1].t || 1;

  let yMin = Infinity, yMax = -Infinity;
  for (const s of samples) {
    for (const v of s.q) {
      if (v < yMin) yMin = v;
      if (v > yMax) yMax = v;
    }
  }
  const yRange = yMax - yMin || 1;
  const yPad = yRange * 0.08;
  const yLo = yMin - yPad, yHi = yMax + yPad;

  const xScale = (t: number) => PADL + (t / tRange) * plotW;
  const yScale = (v: number) => PADT + (1 - (v - yLo) / (yHi - yLo)) * plotH;

  const lines = Array.from({ length: 6 }, (_, ji) =>
    samples.map(s => `${xScale(s.t).toFixed(1)},${yScale(s.q[ji]).toFixed(1)}`).join(" ")
  );

  const gripperMarkers: { x: number; open: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].gripper > 0.035;
    const curr = samples[i].gripper > 0.035;
    if (prev !== curr) {
      gripperMarkers.push({ x: xScale(samples[i].t), open: curr });
    }
  }

  const ticks = [yLo, (yLo + yHi) / 2, yHi];
  const timeTicks = [0, tRange / 2, tRange];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" style={{ width: "100%", height: "100%", minHeight: 0, display: "block" }}>
      {ticks.map((v, i) => (
        <g key={i}>
          <line x1={PADL} y1={yScale(v)} x2={W - PADR} y2={yScale(v)}
            stroke="#e2e8f0" strokeWidth={0.8} />
          <text x={PADL - 3} y={yScale(v) + 3} textAnchor="end"
            fontSize={7} fill="#94a3b8">
            {(v * 180 / Math.PI).toFixed(0)}°
          </text>
        </g>
      ))}
      {lines.map((pts, ji) => (
        <polyline key={ji} points={pts}
          fill="none" stroke={JOINT_COLORS[ji]} strokeWidth={1.5}
          strokeLinejoin="round" strokeLinecap="round" />
      ))}
      {gripperMarkers.map((m, i) => (
        <polygon key={i}
          points={`${m.x},${PADT + 1} ${m.x - 4},${PADT + 8} ${m.x + 4},${PADT + 8}`}
          fill={m.open ? "#22c55e" : "#ef4444"} opacity={0.75} />
      ))}
      <line x1={PADL} y1={H - PADB} x2={W - PADR} y2={H - PADB}
        stroke="#cbd5e1" strokeWidth={1} />
      {timeTicks.map((t, i) => (
        <text key={i} x={xScale(t)} y={H - 2}
          textAnchor={i === 0 ? "start" : i === 2 ? "end" : "middle"}
          fontSize={7} fill="#94a3b8">
          {t.toFixed(1)}s
        </text>
      ))}
      {/* 현재 재생 시간 세로선 */}
      {currentTime > 0 && currentTime <= tRange && (() => {
        const cx = xScale(currentTime);
        return (
          <g>
            <line x1={cx} y1={PADT} x2={cx} y2={H - PADB}
              stroke="#f59e0b" strokeWidth={1.5} strokeDasharray="3 2" />
            <text x={cx + 3} y={PADT + 9} fontSize={7} fill="#f59e0b">
              {currentTime.toFixed(1)}s
            </text>
          </g>
        );
      })()}
    </svg>
  );
});

const plotStyles: Record<string, React.CSSProperties> = {
  empty: {
    height: "100%", display: "flex", alignItems: "center",
    justifyContent: "center", color: "#94a3b8", fontSize: 12,
    background: "#f8fafc", borderRadius: 6,
  },
};

// ── Trajectory scale helper ───────────────────────────────────────────────
function trajScale(vals: number[], plotSize: number, pad = 28) {
  const usable = plotSize - pad * 2;
  let lo = Math.min(...vals), hi = Math.max(...vals);
  if (!isFinite(lo) || !isFinite(hi) || lo === hi) { lo -= 0.5; hi += 0.5; }
  const margin = (hi - lo) * 0.1;
  lo -= margin; hi += margin;
  const range = hi - lo;
  const scale = (v: number) => pad + ((v - lo) / range) * usable;
  const tickCount = 4;
  const ticks = Array.from({ length: tickCount + 1 }, (_, i) => lo + (range * i) / tickCount);
  return { scale, ticks, lo, hi };
}

// ── TrajectoryPlanView (XY plan view) ────────────────────────────────────
const TrajectoryPlanView = React.memo(function TrajectoryPlanView({
  samples, currentTime,
}: { samples: EESample[]; currentTime: number }) {
  if (!samples || samples.length === 0)
    return <div style={plotStyles.empty}>No trajectory data</div>;

  const W = 500, H = 200, PAD = 28;

  const xs = samples.map(s => s.ee[0]);
  const ys = samples.map(s => s.ee[1]);
  const { scale: xScale, ticks: xTicks } = trajScale(xs, W, PAD);
  const { scale: yRaw, ticks: yTicks } = trajScale(ys, H, PAD);
  // flip Y so up = positive
  const yScale = (v: number) => H - yRaw(v);

  const polyline = samples.map(s => `${xScale(s.ee[0]).toFixed(1)},${yScale(s.ee[1]).toFixed(1)}`).join(" ");

  const gripperDots: { x: number; y: number; open: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].gripper > 0.035;
    const curr = samples[i].gripper > 0.035;
    if (prev !== curr) {
      gripperDots.push({ x: xScale(samples[i].ee[0]), y: yScale(samples[i].ee[1]), open: curr });
    }
  }

  const nearest = samples.reduce((best, s) =>
    Math.abs(s.t - currentTime) < Math.abs(best.t - currentTime) ? s : best);
  const cx = xScale(nearest.ee[0]);
  const cy = yScale(nearest.ee[1]);

  const base = { x: xScale(0), y: yScale(0) };

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block" }}>
      {/* grid */}
      {xTicks.map((v, i) => (
        <g key={`xg${i}`}>
          <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e2e8f0" strokeWidth={0.7} />
          <text x={xScale(v)} y={H - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">
            {v.toFixed(2)}m
          </text>
        </g>
      ))}
      {yTicks.map((v, i) => (
        <g key={`yg${i}`}>
          <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e2e8f0" strokeWidth={0.7} />
          <text x={PAD - 3} y={yScale(v) + 3} textAnchor="end" fontSize={7} fill="#94a3b8">
            {v.toFixed(2)}
          </text>
        </g>
      ))}
      {/* path */}
      <polyline points={polyline} fill="none" stroke="#3b82f6" strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
      {/* base */}
      <circle cx={base.x} cy={base.y} r={5} fill="none" stroke="#64748b" strokeWidth={1.5} />
      {/* start / end */}
      <circle cx={xScale(samples[0].ee[0])} cy={yScale(samples[0].ee[1])} r={4} fill="#22c55e" />
      <circle cx={xScale(samples[samples.length - 1].ee[0])} cy={yScale(samples[samples.length - 1].ee[1])} r={4} fill="#ef4444" />
      {/* gripper events */}
      {gripperDots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={3}
          fill={d.open ? "#22c55e" : "#ef4444"} opacity={0.75} />
      ))}
      {/* cursor */}
      <circle cx={cx} cy={cy} r={5} fill="#f59e0b" opacity={0.9} />
    </svg>
  );
});

// ── TrajectorySideView (Reach/Z side view) ────────────────────────────────
const TrajectorySideView = React.memo(function TrajectorySideView({
  samples, currentTime,
}: { samples: EESample[]; currentTime: number }) {
  if (!samples || samples.length === 0)
    return <div style={plotStyles.empty}>No trajectory data</div>;

  const W = 500, H = 200, PAD = 28;

  const reaches = samples.map(s => Math.sqrt(s.ee[0] ** 2 + s.ee[1] ** 2));
  const zs = samples.map(s => s.ee[2]);
  const { scale: xScale, ticks: xTicks } = trajScale(reaches, W, PAD);
  const { scale: yRaw, ticks: yTicks } = trajScale(zs, H, PAD);
  const yScale = (v: number) => H - yRaw(v);

  const polyline = samples.map((s, i) =>
    `${xScale(reaches[i]).toFixed(1)},${yScale(s.ee[2]).toFixed(1)}`).join(" ");

  const gripperDots: { x: number; y: number; open: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].gripper > 0.035;
    const curr = samples[i].gripper > 0.035;
    if (prev !== curr) {
      gripperDots.push({ x: xScale(reaches[i]), y: yScale(samples[i].ee[2]), open: curr });
    }
  }

  const nearest = samples.reduce((best, s) =>
    Math.abs(s.t - currentTime) < Math.abs(best.t - currentTime) ? s : best);
  const nearestIdx = samples.indexOf(nearest);
  const cx = xScale(reaches[nearestIdx]);
  const cy = yScale(nearest.ee[2]);

  // skeleton: draw link positions as dashed polyline
  const skeletonPoints = nearest.links && nearest.links.length > 0
    ? [
        [0, 0, 0] as [number, number, number],
        ...nearest.links,
        nearest.ee,
      ].map(p => {
        const r = Math.sqrt(p[0] ** 2 + p[1] ** 2);
        return `${xScale(r).toFixed(1)},${yScale(p[2]).toFixed(1)}`;
      }).join(" ")
    : "";

  return (
    <svg viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none"
      style={{ width: "100%", height: "100%", display: "block" }}>
      {/* grid */}
      {xTicks.map((v, i) => (
        <g key={`xg${i}`}>
          <line x1={xScale(v)} y1={PAD} x2={xScale(v)} y2={H - PAD} stroke="#e2e8f0" strokeWidth={0.7} />
          <text x={xScale(v)} y={H - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">
            {(v * 100).toFixed(0)}cm
          </text>
        </g>
      ))}
      {yTicks.map((v, i) => (
        <g key={`yg${i}`}>
          <line x1={PAD} y1={yScale(v)} x2={W - PAD} y2={yScale(v)} stroke="#e2e8f0" strokeWidth={0.7} />
          <text x={PAD - 3} y={yScale(v) + 3} textAnchor="end" fontSize={7} fill="#94a3b8">
            {(v * 100).toFixed(0)}
          </text>
        </g>
      ))}
      {/* skeleton */}
      {skeletonPoints && (
        <polyline points={skeletonPoints} fill="none" stroke="#94a3b8"
          strokeWidth={1} strokeDasharray="4 3" opacity={0.6} />
      )}
      {/* link dots */}
      {nearest.links && nearest.links.map((lp, i) => {
        const r = Math.sqrt(lp[0] ** 2 + lp[1] ** 2);
        return <circle key={i} cx={xScale(r)} cy={yScale(lp[2])} r={2.5} fill="#94a3b8" />;
      })}
      {/* ee path */}
      <polyline points={polyline} fill="none" stroke="#06b6d4" strokeWidth={1.5}
        strokeLinejoin="round" strokeLinecap="round" />
      {/* gripper events */}
      {gripperDots.map((d, i) => (
        <circle key={i} cx={d.x} cy={d.y} r={3}
          fill={d.open ? "#22c55e" : "#ef4444"} opacity={0.75} />
      ))}
      {/* cursor */}
      <circle cx={cx} cy={cy} r={5} fill="#f59e0b" opacity={0.9} />
    </svg>
  );
});

// ── Inline confirm ────────────────────────────────────────────────────────
function ConfirmInline({ label, onConfirm, onCancel }: {
  label: string; onConfirm: () => void; onCancel: () => void;
}) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
      <span style={{ fontSize: 11, color: "#dc2626" }}>{label}</span>
      <button onClick={e => { e.stopPropagation(); onConfirm(); }} style={styles.confirmBtn}>Yes</button>
      <button onClick={e => { e.stopPropagation(); onCancel(); }} style={styles.cancelBtn}>No</button>
    </span>
  );
}

// ── Main ──────────────────────────────────────────────────────────────────
export default function DatasetPage() {
  const [episodes, setEpisodes] = useState<Episode[]>([]);
  const [selected, setSelected] = useState<Episode | null>(null);
  const [selectedTake, setSelectedTake] = useState<string | null>(null);
  const [videoSource, setVideoSource] = useState<string>("color");
  const [jointSource, setJointSource] = useState<"teach" | "executed" | "command">("executed");
  const [jointsData, setJointsData] = useState<TakeJointsData | null>(null);
  const [jointsLoading, setJointsLoading] = useState(false);
  const [trajectoryData, setTrajectoryData] = useState<TakeTrajectoryData | null>(null);
  const [view2D, setView2D] = useState<"plan" | "side">("plan");
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);
  const [filter, setFilter] = useState<"all" | "success" | "failure" | "unlabeled">("all");
  const [search, setSearch] = useState("");
  const [confirmDeleteEp, setConfirmDeleteEp] = useState<string | null>(null);
  const [confirmDeleteTake, setConfirmDeleteTake] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");
  const [selectedEps, setSelectedEps] = useState<Set<string>>(new Set());
  const [includeFrames, setIncludeFrames] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [exportingLerobot, setExportingLerobot] = useState(false);
  const [lerobotPreset, setLerobotPreset] = useState<"default" | "all" | "debug">("default");
  const [lerobotMaskMode, setLerobotMaskMode] = useState<"edit" | "off">("edit");
  const [maskFillColor, setMaskFillColor] = useState("#000000");
  const [exportSuccessOnly, setExportSuccessOnly] = useState(false);
  const [exportIssuePolicy, setExportIssuePolicy] = useState<"include_all" | "exclude_open">("include_all");
  const [bulkTask, setBulkTask] = useState("");
  const [bulkTaskSaving, setBulkTaskSaving] = useState(false);
  const [editMeta, setEditMeta] = useState<EditMeta | null>(null);
  const [sortBy, setSortBy] = useState<"date" | "task" | "size" | "duration" | "status">("date");
  const [viewMode, setViewMode] = useState<ViewMode>("thumbnail");
  const [inspectorTab, setInspectorTab] = useState<InspectorTab>("preview");
  const [postprocessMaskCameraId, setPostprocessMaskCameraId] = useState<string>("");
  const [hoveredEp, setHoveredEp] = useState<string | null>(null);
  const [focusedEp, setFocusedEp] = useState<string | null>(null);
  const [lastClickedIndex, setLastClickedIndex] = useState<number | null>(null);
  const [exportModal, setExportModal] = useState(false);

  const fetchEpisodes = useCallback(() => {
    fetch("/api/episodes")
      .then(r => r.json())
      .then((data: Episode[]) => setEpisodes(data))
      .catch(() => {});
  }, []);

  useEffect(() => { fetchEpisodes(); }, [fetchEpisodes]);

  const selectedId = selected?.episode_id;

  useEffect(() => {
    if (!selected) { setSelectedTake(null); setJointsData(null); setTrajectoryData(null); return; }
    const takes = selected.takes ?? [];
    setSelectedTake(takes.length > 0 ? takes[takes.length - 1].take : null);
    setJointsData(null);
    setTrajectoryData(null);
    setCurrentTime(0);
    setEditingTask(false);
  }, [selectedId]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setSelectedEps(new Set());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  useEffect(() => {
    if (selectedEps.size !== 1) return;
    const onlyId = Array.from(selectedEps)[0];
    if (selected?.episode_id === onlyId) return;
    const ep = episodes.find(e => e.episode_id === onlyId);
    if (ep) setSelected(ep);
  }, [episodes, selected, selectedEps]);

  useEffect(() => {
    if (!selectedId || !selectedTake) { setJointsData(null); return; }
    setJointsLoading(true);
    fetch(`/api/episodes/${selectedId}/takes/${selectedTake}/joints`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setJointsData(d); setJointsLoading(false); })
      .catch(() => { setJointsData(null); setJointsLoading(false); });
  }, [selectedId, selectedTake]);

  useEffect(() => {
    if (!selectedId || !selectedTake) { setTrajectoryData(null); return; }
    fetch(`/api/episodes/${selectedId}/takes/${selectedTake}/trajectory`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setTrajectoryData(d))
      .catch(() => setTrajectoryData(null));
  }, [selectedId, selectedTake]);

  const nearestSample = useMemo(() => {
    const arr = trajectoryData?.[jointSource];
    if (!arr?.length) return null;
    return arr.reduce((best, s) =>
      Math.abs(s.t - currentTime) < Math.abs(best.t - currentTime) ? s : best
    );
  }, [trajectoryData, jointSource, currentTime]);

  useEffect(() => {
    if (!selectedId || !selectedTake) { setEditMeta(null); return; }
    fetch(`/api/episodes/${selectedId}/takes/${selectedTake}/edit_meta`)
      .then(r => r.ok ? r.json() : null)
      .then(d => setEditMeta(d))
      .catch(() => setEditMeta(null));
  }, [selectedId, selectedTake]);

  const filtered = useMemo(() => episodes.filter(ep => {
    if (filter === "success" && ep.success !== true) return false;
    if (filter === "failure" && ep.success !== false) return false;
    if (filter === "unlabeled" && ep.success !== null && ep.success !== undefined) return false;
    if (search) {
      const q = search.toLowerCase();
      if (!ep.episode_id.toLowerCase().includes(q) && !(ep.task ?? "").toLowerCase().includes(q)) return false;
    }
    return true;
  }), [episodes, filter, search]);

  const sorted = useMemo(() => {
    const next = [...filtered];
    if (sortBy === "task") return next.sort((a, b) => (a.task ?? "").localeCompare(b.task ?? ""));
    if (sortBy === "size") return next.sort((a, b) => (b.size_mb ?? 0) - (a.size_mb ?? 0));
    if (sortBy === "duration") return next.sort((a, b) => (b.duration_s ?? 0) - (a.duration_s ?? 0));
    if (sortBy === "status") {
      return next.sort((a, b) => statusLabel(a.success).localeCompare(statusLabel(b.success)));
    }
    return next;
  }, [filtered, sortBy]);

  const totalSize = useMemo(() =>
    episodes.reduce((s, e) => s + (e.size_mb ?? 0), 0), [episodes]);

  const totalTakes = useMemo(() =>
    episodes.reduce((s, e) => s + (e.takes_count ?? 0), 0), [episodes]);

  const deleteEpisode = useCallback((epId: string) => {
    fetch(`/api/episodes/${epId}`, { method: "DELETE" })
      .then(() => {
        setEpisodes(prev => prev.filter(e => e.episode_id !== epId));
        setSelected(prev => prev?.episode_id === epId ? null : prev);
      })
      .catch(() => {})
      .finally(() => setConfirmDeleteEp(null));
  }, []);

  const deleteTake = useCallback((takeId: string) => {
    if (!selected) return;
    const epId = selected.episode_id;
    fetch(`/api/episodes/${epId}/takes/${takeId}`, { method: "DELETE" })
      .then(() => {
        const updatedTakes = selected.takes.filter(t => t.take !== takeId);
        const updatedEp: Episode = {
          ...selected,
          takes: updatedTakes,
          takes_count: updatedTakes.length,
        };
        setSelected(updatedEp);
        setEpisodes(prev => prev.map(e => e.episode_id === epId ? updatedEp : e));
        if (selectedTake === takeId) {
          setSelectedTake(updatedTakes.length > 0 ? updatedTakes[updatedTakes.length - 1].take : null);
        }
      })
      .catch(() => {})
      .finally(() => setConfirmDeleteTake(null));
  }, [selected, selectedTake]);

  const saveTask = useCallback((epId: string, task: string) => {
    fetch(`/api/episodes/${epId}`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ task }),
    }).then(() => {
      setSelected(prev => prev ? { ...prev, task } : prev);
      setEpisodes(prev => prev.map(e => e.episode_id === epId ? { ...e, task } : e));
      setEditingTask(false);
    }).catch(() => {});
  }, []);

  const setRangeSelection = useCallback((from: number, to: number, additive: boolean) => {
    const [start, end] = from < to ? [from, to] : [to, from];
    const ids = sorted.slice(start, end + 1).map(ep => ep.episode_id);
    setSelectedEps(prev => {
      const next = additive ? new Set(prev) : new Set<string>();
      ids.forEach(id => next.add(id));
      return next;
    });
  }, [sorted]);

  const toggleEpSelect = useCallback((epId: string, index: number, e: React.MouseEvent) => {
    e.stopPropagation();
    if (e.shiftKey && lastClickedIndex !== null) {
      setRangeSelection(lastClickedIndex, index, e.ctrlKey || e.metaKey);
      return;
    }
    setSelectedEps(prev => {
      const next = new Set(prev);
      next.has(epId) ? next.delete(epId) : next.add(epId);
      return next;
    });
    setLastClickedIndex(index);
  }, [lastClickedIndex, setRangeSelection]);

  const handleEpisodeClick = useCallback((ep: Episode, index: number, e: React.MouseEvent) => {
    setSelected(ep);
    setConfirmDeleteEp(null);
    const selectionMode = selectedEps.size > 0;
    if (e.shiftKey && lastClickedIndex !== null) {
      setRangeSelection(lastClickedIndex, index, true);
    } else if (e.ctrlKey || e.metaKey) {
      setSelectedEps(prev => {
        const next = new Set(prev);
        next.has(ep.episode_id) ? next.delete(ep.episode_id) : next.add(ep.episode_id);
        return next;
      });
      setLastClickedIndex(index);
    } else if (selectionMode) {
      setSelectedEps(prev => {
        const next = new Set(prev);
        next.has(ep.episode_id) ? next.delete(ep.episode_id) : next.add(ep.episode_id);
        return next;
      });
      setLastClickedIndex(index);
    } else {
      setLastClickedIndex(index);
    }
  }, [lastClickedIndex, selectedEps.size, setRangeSelection]);

  const exportSelected = useCallback(() => {
    if (!selectedEps.size || exporting) return;
    setExporting(true);
    fetch("/api/episodes/export", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ episode_ids: [...selectedEps], include_frames: includeFrames }),
    })
      .then(r => {
        if (!r.ok) throw new Error("export failed");
        return r.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `piper_dataset_${selectedEps.size}ep.zip`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => {})
      .finally(() => setExporting(false));
  }, [selectedEps, includeFrames, exporting]);

  const exportLerobot = useCallback(() => {
    if (!selectedEps.size || exportingLerobot) return;
    setExportingLerobot(true);
    fetch("/api/episodes/export_lerobot", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        episode_ids: [...selectedEps],
        preset: lerobotPreset,
        mask_mode: lerobotMaskMode,
        mask_fill_color: maskFillColor,
        success_only: exportSuccessOnly,
        issue_policy: exportIssuePolicy,
      }),
    })
      .then(r => {
        if (!r.ok) throw new Error("export_lerobot failed");
        return r.blob();
      })
      .then(blob => {
        const url = URL.createObjectURL(blob);
        const a = document.createElement("a");
        a.href = url;
        a.download = `piper_lerobot_${selectedEps.size}ep.zip`;
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(() => {})
      .finally(() => setExportingLerobot(false));
  }, [selectedEps, exportingLerobot, lerobotPreset, lerobotMaskMode, maskFillColor, exportSuccessOnly, exportIssuePolicy]);

  const applyBulkTask = useCallback(() => {
    if (!selectedEps.size || bulkTaskSaving) return;
    setBulkTaskSaving(true);
    const ids = [...selectedEps];
    Promise.all(ids.map(id =>
      fetch(`/api/episodes/${id}`, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ task: bulkTask }),
      })
    )).then(() => {
      const task = bulkTask;
      setEpisodes(prev => prev.map(e => selectedEps.has(e.episode_id) ? { ...e, task } : e));
      setSelected(prev => prev && selectedEps.has(prev.episode_id) ? { ...prev, task } : prev);
    }).catch(() => {}).finally(() => setBulkTaskSaving(false));
  }, [selectedEps, bulkTask, bulkTaskSaving]);

  const saveEditMeta = useCallback((meta: EditMeta) => {
    if (!selectedId || !selectedTake) return;
    fetch(`/api/episodes/${selectedId}/takes/${selectedTake}/edit_meta`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(meta),
    }).then(() => setEditMeta(meta)).catch(() => {});
  }, [selectedId, selectedTake]);

  // 자동 그리퍼 열림 감지: teach 데이터에서 10초 이후 closed→open 전환 시각
  const autoGripperOpenT = useMemo((): number | null => {
    const samples = jointsData?.teach;
    if (!samples) return null;
    const MID = 0.02219;
    let prevOpen: boolean | null = null;
    for (const s of samples) {
      const isOpen = s.gripper > MID;
      if (prevOpen !== null && s.t > 10 && !prevOpen && isOpen) return s.t;
      prevOpen = isOpen;
    }
    return null;
  }, [jointsData]);

  const selectSameTask = useCallback(() => {
    // 현재 선택된 에피소드들의 task 집합 추출
    const tasks = new Set(
      episodes
        .filter(e => selectedEps.has(e.episode_id))
        .map(e => e.task ?? "")
    );
    // filtered 목록 기준으로 같은 task인 에피소드 모두 추가
    setSelectedEps(prev => {
      const next = new Set(prev);
      filtered.forEach(e => {
        if (tasks.has(e.task ?? "")) next.add(e.episode_id);
      });
      return next;
    });
  }, [episodes, filtered, selectedEps]);

  const currentTake: EpisodeTake | null = selected?.takes.find(t => t.take === selectedTake) ?? null;
  const cameraTabs = useMemo<CameraTab[]>(() => {
    if (!currentTake) return [];
    const streamTabs = (currentTake.cameras ?? []).flatMap(camera => {
      const streams = camera.streams?.length
        ? camera.streams
        : [{ id: "color", label: "Color", kind: "color", video: camera.video, url: `/api/episodes/${selectedId}/takes/${selectedTake}/video_camera/${camera.id}/color`, maskable: true }];
      const hasMultipleStreams = streams.length > 1;
      return streams.map(stream => ({
        id: `${camera.id}:${stream.kind}`,
        label: hasMultipleStreams ? `${camera.label || camera.id} ${stream.label || stream.kind}` : camera.label || camera.id,
        avail: true,
        maskable: !!stream.maskable,
        maskCameraId: stream.maskable ? camera.id : undefined,
        url: stream.url,
        cameraId: camera.id,
        stream: stream.kind,
        role: camera.role,
      }));
    });
    if (streamTabs.length) return streamTabs;
    return [
      { id: "legacy:color", label: "RGB", avail: !!currentTake.has_video, maskable: true, maskCameraId: "realsense", url: `/api/episodes/${selectedId}/takes/${selectedTake}/video_camera/realsense/color` },
      { id: "legacy:depth", label: "Depth", avail: !!currentTake.has_video, maskable: false, url: `/api/episodes/${selectedId}/takes/${selectedTake}/video_camera/realsense/depth` },
      { id: "legacy:webcam_0", label: "Cam0 Ego", avail: !!currentTake.has_webcam_0, maskable: true, maskCameraId: "cam0", url: `/api/episodes/${selectedId}/takes/${selectedTake}/video_camera/cam0/color` },
      { id: "legacy:webcam_1", label: "Cam1 Overview", avail: !!currentTake.has_webcam_1, maskable: true, maskCameraId: "cam1", url: `/api/episodes/${selectedId}/takes/${selectedTake}/video_camera/cam1/color` },
    ];
  }, [currentTake, selectedId, selectedTake]);

  const maskableCameraTabs = useMemo(
    () => cameraTabs.filter(tab => tab.avail && tab.maskable && tab.maskCameraId),
    [cameraTabs],
  );
  const defaultMaskCameraId = maskableCameraTabs[0]?.maskCameraId ?? "";

  const videoSourceForMaskCamera = useCallback((cameraId: string) => {
    const tab = cameraTabs.find(t => t.maskCameraId === cameraId && t.avail);
    return tab?.id ?? cameraId;
  }, [cameraTabs]);

  const maskCameraForVideoSource = useCallback((source: string) => {
    return cameraTabs.find(t => t.id === source && t.maskable)?.maskCameraId;
  }, [cameraTabs]);

  useEffect(() => {
    if (!editMeta) return;
    setPostprocessMaskCameraId(editMeta.mask.camera_id || defaultMaskCameraId);
  }, [editMeta, defaultMaskCameraId]);

  useEffect(() => {
    if (inspectorTab !== "postprocess") return;
    const target = editMeta?.mask.camera_id || postprocessMaskCameraId || defaultMaskCameraId;
    if (!target) return;
    setPostprocessMaskCameraId(target);
    setVideoSource(videoSourceForMaskCamera(target));
  }, [inspectorTab, editMeta, defaultMaskCameraId, postprocessMaskCameraId, videoSourceForMaskCamera]);

  const handleVideoSourceChange = useCallback((source: string) => {
    setVideoSource(source);
    if (inspectorTab !== "postprocess") return;
    const target = maskCameraForVideoSource(source);
    if (target) setPostprocessMaskCameraId(target);
  }, [inspectorTab, maskCameraForVideoSource]);

  const videoUrl = useMemo(() => {
    return cameraTabs.find(t => t.id === videoSource && t.avail)?.url ?? null;
  }, [cameraTabs, videoSource]);

  useEffect(() => {
    if (!cameraTabs.length) return;
    if (!cameraTabs.some(t => t.id === videoSource && t.avail)) {
      setVideoSource(cameraTabs.find(t => t.avail)?.id ?? cameraTabs[0].id);
    }
  }, [cameraTabs, videoSource]);

  const duration = takeDuration(jointsData);
  const selectedBatch = useMemo(
    () => episodes.filter(ep => selectedEps.has(ep.episode_id)),
    [episodes, selectedEps],
  );
  const batchStatus = useMemo(() => ({
    success: selectedBatch.filter(ep => ep.success === true).length,
    failure: selectedBatch.filter(ep => ep.success === false).length,
    unlabeled: selectedBatch.filter(ep => ep.success !== true && ep.success !== false).length,
  }), [selectedBatch]);

  // lerobot converter와 동일한 시간 보정:
  // executed/command joint의 실제 시간축(0..joint_dur)을 video_duration으로 선형 스케일링
  // teach는 비디오가 teach duration 기준으로 인코딩되므로 그대로 사용
  const remappedJointsData = useMemo((): TakeJointsData | null => {
    if (!jointsData) return null;
    const remap = (samples: JointSample[], src: "teach" | "executed" | "command"): JointSample[] => {
      if (src === "teach" || !videoDuration || samples.length === 0) return samples;
      const tMax = samples[samples.length - 1].t;
      if (tMax <= 0) return samples;
      const scale = videoDuration / tMax;
      return samples.map(s => ({ ...s, t: s.t * scale }));
    };
    return {
      teach:    remap(jointsData.teach,    "teach"),
      executed: remap(jointsData.executed, "executed"),
      command:  remap(jointsData.command,  "command"),
    };
  }, [jointsData, videoDuration]);

  return (
    <div style={styles.root}>
      {/* Header */}
      <div style={styles.header}>
        <div style={styles.headerLeft}>
          <h2 style={styles.title}>Dataset Browser</h2>
          <span style={styles.stats}>
            {sorted.length}/{episodes.length} ep · {totalTakes} takes · {fmtMb(totalSize)}
          </span>
        </div>
        <div style={styles.headerRight}>
          <input
            type="text" placeholder="Search…" value={search}
            onChange={e => setSearch(e.target.value)}
            style={styles.searchInput}
          />
          {(["all", "success", "failure", "unlabeled"] as const).map(f => (
            <button key={f} onClick={() => setFilter(f)}
              style={{ ...styles.filterBtn, background: filter === f ? "#6366f1" : "#f1f5f9", color: filter === f ? "#fff" : "#374151" }}>
              {f === "all" ? "All" : f === "success" ? "✓" : f === "failure" ? "✗" : "?"}
            </button>
          ))}
          <select value={sortBy} onChange={e => setSortBy(e.target.value as typeof sortBy)}
            style={{ padding: "3px 6px", borderRadius: 5, border: "1px solid #e5e7eb", fontSize: 11, background: "#fff" }}>
            <option value="date">최신순</option>
            <option value="task">task순</option>
            <option value="size">용량순</option>
            <option value="duration">길이순</option>
            <option value="status">상태순</option>
          </select>
          <div style={styles.viewToggle}>
            {([
              ["compact", "List"],
              ["thumbnail", "Thumb"],
              ["grid", "Grid"],
            ] as Array<[ViewMode, string]>).map(([mode, label]) => (
              <button
                key={mode}
                onClick={() => setViewMode(mode)}
                style={{
                  ...styles.viewBtn,
                  background: viewMode === mode ? "#111827" : "#fff",
                  color: viewMode === mode ? "#fff" : "#475569",
                }}
              >
                {label}
              </button>
            ))}
          </div>
          <button style={styles.refreshBtn} onClick={fetchEpisodes}>↻</button>
        </div>
      </div>

      {/* Selection Toolbar */}
      {selectedEps.size > 0 && (
        <div style={styles.exportBar}>
          <span style={{ fontSize: 12, color: "#1e293b", fontWeight: 600, flexShrink: 0 }}>
            {selectedEps.size} selected
          </span>
          <button onClick={selectSameTask} style={{ ...styles.exportBarBtn, background: "#0891b2", fontSize: 11 }}>
            Select Same Task
          </button>
          <input
            type="text" placeholder="task 일괄 설정…" value={bulkTask}
            onChange={e => setBulkTask(e.target.value)}
            onKeyDown={e => { if (e.key === "Enter") applyBulkTask(); }}
            style={{ ...styles.bulkTaskInput, width: 180 }}
          />
          <button onClick={applyBulkTask} disabled={bulkTaskSaving || !bulkTask.trim()}
            style={{ ...styles.exportBarBtn, fontSize: 11 }}>
            {bulkTaskSaving ? "…" : "Set"}
          </button>
          <div style={{ flex: 1 }} />
          <button onClick={() => setInspectorTab("postprocess")}
            style={{ ...styles.exportBarBtn, background: "#7c3aed", fontSize: 11 }}>
            Postprocess
          </button>
          <button onClick={() => setExportModal(true)}
            style={{ ...styles.exportBarBtn, background: "#059669", fontSize: 11 }}>
            ↓ Export
          </button>
          <button onClick={() => setSelectedEps(new Set())}
            style={{ ...styles.cancelBtn, fontSize: 11 }}>
            Clear
          </button>
        </div>
      )}

      {/* Export Modal */}
      {exportModal && (
        <ExportModal
          count={selectedEps.size}
          exporting={exporting}
          exportingLerobot={exportingLerobot}
          includeFrames={includeFrames}
          lerobotPreset={lerobotPreset}
          lerobotMaskMode={lerobotMaskMode}
          maskFillColor={maskFillColor}
          successOnly={exportSuccessOnly}
          issuePolicy={exportIssuePolicy}
          onIncludeFrames={setIncludeFrames}
          onLerobotPreset={setLerobotPreset}
          onLerobotMaskMode={setLerobotMaskMode}
          onMaskFillColor={setMaskFillColor}
          onSuccessOnly={setExportSuccessOnly}
          onIssuePolicy={setExportIssuePolicy}
          onExportZip={exportSelected}
          onExportLerobot={exportLerobot}
          onClose={() => setExportModal(false)}
        />
      )}

      {/* Body */}
      <div style={styles.body}>
        {/* Episode collection */}
        <div style={{
          ...styles.listPanel,
          width: viewMode === "grid" ? 620 : viewMode === "compact" ? 640 : 430,
          flexShrink: viewMode === "thumbnail" ? 0 : 1,
          maxWidth: viewMode === "grid" ? "min(620px, 56vw)" : undefined,
        }}>
          <div style={styles.collectionHeader}>
            <span>Collection</span>
            <span>{sorted.length} shown</span>
          </div>
          {viewMode === "compact" && sorted.length > 0 && (
            <div style={styles.compactHead}>
              <span />
              <span>episode</span>
              <span>task</span>
              <span>status</span>
              <span>takes</span>
              <span>duration</span>
              <span>size</span>
            </div>
          )}
          {sorted.length === 0 && (
            <div style={styles.empty}>
              {search || filter !== "all" ? "No matches." : "No episodes yet."}
            </div>
          )}
          <div style={viewMode === "grid" ? styles.gridList : styles.linearList}>
            {sorted.map((ep, index) => {
            const isInspected = selected?.episode_id === ep.episode_id;
            const isSelected = selectedEps.has(ep.episode_id);
            const isHovered = hoveredEp === ep.episode_id;
            const deleteEpisodeClick = (epId: string, e: React.MouseEvent) => {
              e.stopPropagation();
              if (confirmDeleteEp === epId) deleteEpisode(epId);
              else setConfirmDeleteEp(epId);
            };
            return (
              <EpisodeCollectionItem
                key={ep.episode_id}
                ep={ep}
                index={index}
                viewMode={viewMode}
                inspected={isInspected}
                selected={isSelected}
                hovered={isHovered}
                onClick={handleEpisodeClick}
                onCheck={toggleEpSelect}
                onHover={setHoveredEp}
                onDelete={deleteEpisodeClick}
              />
            );
          })}
          </div>
        </div>

        {/* Detail panel */}
        {selectedEps.size > 1 ? (
          <div style={styles.detailPanel}>
            <BatchInspector
              episodes={selectedBatch}
              status={batchStatus}
              onClear={() => setSelectedEps(new Set())}
              onExport={() => setExportModal(true)}
            />
          </div>
        ) : selected ? (
          <div style={styles.detailPanel}>
            {/* Episode header */}
            <div style={{ marginBottom: 10 }}>
              <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 8 }}>
                <div style={{ fontFamily: "monospace", fontSize: 11, color: "#6366f1", fontWeight: 700, wordBreak: "break-all" as const }}>
                  {selected.episode_id}
                </div>
                <StatusBadge success={selected.success} />
              </div>
              {editingTask ? (
                <div style={{ display: "flex", gap: 4, marginTop: 4, alignItems: "center" }}>
                  <input
                    autoFocus
                    value={taskDraft}
                    onChange={e => setTaskDraft(e.target.value)}
                    onKeyDown={e => {
                      if (e.key === "Enter") saveTask(selected.episode_id, taskDraft);
                      if (e.key === "Escape") setEditingTask(false);
                    }}
                    style={styles.taskInput}
                  />
                  <button onClick={() => saveTask(selected.episode_id, taskDraft)} style={styles.confirmBtn}>Save</button>
                  <button onClick={() => setEditingTask(false)} style={styles.cancelBtn}>✕</button>
                </div>
              ) : (
                <div style={{ display: "flex", alignItems: "center", gap: 6, marginTop: 3 }}>
                  <span style={{ fontSize: 13, color: selected.task ? "#374151" : "#9ca3af" }}>
                    {selected.task || "unspecified"}
                  </span>
                  <button
                    onClick={() => { setTaskDraft(selected.task ?? ""); setEditingTask(true); }}
                    style={styles.editBtn} title="Edit task description">✎</button>
                </div>
              )}
              <div style={{ display: "flex", gap: 12, marginTop: 3 }}>
                <span style={{ fontSize: 11, color: "#94a3b8" }}>{fmtMb(selected.size_mb)}</span>
                <span style={{ fontSize: 11, color: "#94a3b8" }}>{selected.created_at?.slice(0, 16).replace("T", " ")}</span>
              </div>
            </div>

            {/* Take selector */}
            {selected.takes.length > 0 ? (
              <div style={styles.takeRow}>
                <select value={selectedTake ?? ""} onChange={e => setSelectedTake(e.target.value)}
                  style={styles.takeSelect}>
                  {selected.takes.map(t => (
                    <option key={t.take} value={t.take}>{t.take}</option>
                  ))}
                </select>
                {currentTake?.size_mb !== undefined && (
                  <span style={styles.takeChip}>{fmtMb(currentTake.size_mb)}</span>
                )}
                {duration !== undefined && (
                  <span style={{ ...styles.takeChip, color: "#6366f1" }}>{fmtDuration(duration)}</span>
                )}
                {selectedTake && (
                  confirmDeleteTake === selectedTake ? (
                    <ConfirmInline
                      label="Delete take?"
                      onConfirm={() => deleteTake(selectedTake)}
                      onCancel={() => setConfirmDeleteTake(null)}
                    />
                  ) : (
                    <button onClick={() => setConfirmDeleteTake(selectedTake)} style={styles.deleteBtn}>
                      ✕ take
                    </button>
                  )
                )}
              </div>
            ) : (
              <div style={{ fontSize: 12, color: "#9ca3af", marginBottom: 10 }}>No takes recorded.</div>
            )}

            <div style={styles.inspectorTabs}>
              {([
                ["preview", "Preview"],
                ["trajectory", "Trajectory"],
                ["postprocess", "Postprocess"],
                ["export", "Export"],
              ] as Array<[InspectorTab, string]>).map(([tab, label]) => (
                <button
                  key={tab}
                  onClick={() => setInspectorTab(tab)}
                  style={{
                    ...styles.inspectorTabBtn,
                    background: inspectorTab === tab ? "#4f46e5" : "#f8fafc",
                    color: inspectorTab === tab ? "#fff" : "#475569",
                  }}
                >
                  {label}
                </button>
              ))}
            </div>

            <div style={styles.workspaceGrid}>
              <VideoPane
                tabs={cameraTabs}
                videoSource={videoSource}
                videoUrl={videoUrl}
                currentTime={currentTime}
                loop={inspectorTab === "trajectory"}
                postprocessMode={inspectorTab === "postprocess"}
                maskEnabled={!!editMeta?.mask.enabled}
                maskCameraId={inspectorTab === "postprocess" ? postprocessMaskCameraId : (editMeta?.mask.camera_id || undefined)}
                onVideoSourceChange={handleVideoSourceChange}
                onMaskCameraChange={setPostprocessMaskCameraId}
                onLoadedMetadata={setVideoDuration}
                onTimeUpdate={setCurrentTime}
              />

              {inspectorTab === "preview" && (
                <>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Episode Summary</div>
                    <div style={styles.workspaceCellBody}>
                      <div style={styles.summaryGrid}>
                        <SummaryItem label="Status" value={statusLabel(selected.success)} />
                        <SummaryItem label="Takes" value={String(selected.takes_count ?? 0)} />
                        <SummaryItem label="Duration" value={fmtDuration(selected.duration_s ?? duration)} />
                        <SummaryItem label="Size" value={fmtMb(selected.size_mb)} />
                        <SummaryItem label="Created" value={fmtDate(selected.created_at)} />
                        <SummaryItem label="Postprocess" value={selected.has_postprocess ? "Enabled" : "None"} />
                        <SummaryItem label="Review issues" value={String(selected.review_issue_count ?? 0)} />
                      </div>
                      <ReviewIssueBadges issues={selected.review_issues} />
                    </div>
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Data Completeness</div>
                    <div style={styles.workspaceCellBody}>
                      <CompletenessChips ep={selected} />
                    </div>
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Export Readiness</div>
                    <div style={styles.workspaceCellBody}>
                      <div style={styles.exportReadyText}>
                        {selected.completeness?.cam0 && selected.completeness?.cam1
                          ? "Default LeRobot export has cam0 + cam1 available."
                          : "Check camera completeness before default LeRobot export."}
                      </div>
                      <button
                        style={styles.exportBarBtn}
                        onClick={() => {
                          setSelectedEps(new Set([selected.episode_id]));
                          setExportModal(true);
                        }}
                      >
                        Export Episode
                      </button>
                    </div>
                  </div>
                </>
              )}

              {inspectorTab === "trajectory" && (
                <>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>
                      <span>Joint Plot</span>
                      <div style={{ display: "flex", gap: 5, alignItems: "center", flexWrap: "wrap" }}>
                        {(["teach", "executed", "command"] as const).map(src => (
                          <button key={src} onClick={() => setJointSource(src)}
                            style={{ ...styles.tabBtn, background: jointSource === src ? "#334155" : "#f1f5f9", color: jointSource === src ? "#fff" : "#374151" }}>
                            {src}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={styles.trajCellBody}>
                      {jointsLoading ? (
                        <div style={plotStyles.empty}>Loading...</div>
                      ) : remappedJointsData ? (
                        <JointPlot data={remappedJointsData} source={jointSource} currentTime={currentTime} />
                      ) : (
                        <div style={plotStyles.empty}>No joint data</div>
                      )}
                    </div>
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Robot Pose · {jointSource}</div>
                    <div style={styles.trajCellBody}>
                      {remappedJointsData?.[jointSource]?.length ? (
                        <PiperRobotViewer samples={remappedJointsData[jointSource]} currentTime={currentTime} />
                      ) : (
                        <div style={plotStyles.empty}>No robot pose data</div>
                      )}
                    </div>
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>
                      <span>2D View</span>
                      <div style={{ display: "flex", gap: 4 }}>
                        {(["plan", "side"] as const).map(v => (
                          <button key={v} onClick={() => setView2D(v)}
                            style={{ ...styles.tabBtn, fontSize: 10,
                              background: view2D === v ? "#4f46e5" : "#f1f5f9",
                              color: view2D === v ? "#fff" : "#374151" }}>
                            {v === "plan" ? "Plan XY" : "Side Reach-Z"}
                          </button>
                        ))}
                      </div>
                    </div>
                    <div style={styles.trajCellBody}>
                      {trajectoryData ? (
                        view2D === "plan" ? (
                          <TrajectoryPlanView samples={trajectoryData[jointSource]} currentTime={currentTime} />
                        ) : (
                          <TrajectorySideView samples={trajectoryData[jointSource]} currentTime={currentTime} />
                        )
                      ) : (
                        <div style={plotStyles.empty}>{nearestSample ? "Loading..." : "No trajectory data"}</div>
                      )}
                    </div>
                  </div>
                </>
              )}

              {inspectorTab === "postprocess" && editMeta !== null && (
                <>
                  <div style={styles.workspaceWide}>
                    <EditPanel
                      editMeta={editMeta}
                      autoGripperOpenT={autoGripperOpenT}
                      episodeId={selectedId!}
                      take={selectedTake!}
                      currentTime={currentTime}
                      duration={videoDuration}
                      selectedMaskCameraId={postprocessMaskCameraId}
                      onSave={meta => {
                        saveEditMeta(meta);
                        const hasAny = meta.trim.enabled || meta.mask.enabled;
                        setEpisodes(prev => prev.map(e =>
                          e.episode_id === selectedId ? { ...e, has_postprocess: hasAny } : e
                        ));
                        setSelected(prev => prev?.episode_id === selectedId
                          ? { ...prev, has_postprocess: hasAny } : prev);
                      }}
                    />
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Mask Target</div>
                    <div style={styles.workspaceCellBody}>
                      <div style={styles.exportReadyText}>
                        Select an RGB camera in the video pane to choose where the mask is applied. Depth is reference-only.
                      </div>
                      <SummaryItem label="Current target" value={postprocessMaskCameraId} />
                      <SummaryItem label="Current time" value={fmtDuration(currentTime)} />
                    </div>
                  </div>
                </>
              )}

              {inspectorTab === "export" && (
                <>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Export Options</div>
                    <div style={styles.workspaceCellBody}>
                      <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12, color: "#475569" }}>
                        <input type="checkbox" checked={includeFrames} onChange={e => setIncludeFrames(e.target.checked)} />
                        Include raw frames
                      </label>
                      <label style={{ display: "grid", gap: 5, marginTop: 10, fontSize: 12, color: "#475569" }}>
                        LeRobot preset
                        <select value={lerobotPreset} onChange={e => setLerobotPreset(e.target.value as "default" | "all" | "debug")}
                          style={{ padding: "6px 8px", borderRadius: 6, border: "1px solid #cbd5e1", fontSize: 12 }}>
                          <option value="default">default · cam0 + cam1</option>
                          <option value="all">all · export-enabled RGB cameras</option>
                          <option value="debug">debug · cam0 + cam1 + depth sensor RGB</option>
                        </select>
                      </label>
                    </div>
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Selected Take</div>
                    <div style={styles.workspaceCellBody}>
                      <SummaryItem label="Take" value={selectedTake ?? "-"} />
                      <SummaryItem label="Duration" value={fmtDuration(duration)} />
                      <SummaryItem label="Size" value={fmtMb(currentTake?.size_mb)} />
                    </div>
                  </div>
                  <div style={styles.workspaceCell}>
                    <div style={styles.trajCellHeader}>Action</div>
                    <div style={styles.workspaceCellBody}>
                      <button
                        style={styles.exportBarBtn}
                        onClick={() => {
                          setSelectedEps(new Set([selected.episode_id]));
                          setExportModal(true);
                        }}
                      >
                        Export Episode
                      </button>
                    </div>
                  </div>
                </>
              )}
            </div>

          </div>
        ) : (
          <EmptyInspector
            episodes={episodes}
            totalTakes={totalTakes}
            totalSize={totalSize}
            onFilter={setFilter}
          />
        )}
      </div>
    </div>
  );
}

// ── EditPanel ─────────────────────────────────────────────────────────────

function EditPanel({
  editMeta, autoGripperOpenT, episodeId, take, currentTime, duration, selectedMaskCameraId, onSave,
}: {
  editMeta: EditMeta;
  autoGripperOpenT: number | null;
  episodeId: string;
  take: string;
  currentTime: number;
  duration?: number;
  selectedMaskCameraId: string;
  onSave: (m: EditMeta) => void;
}) {
  const [trim, setTrim] = React.useState(editMeta.trim);
  const [mask, setMask] = React.useState(editMeta.mask);
  const [dirty, setDirty] = React.useState(false);

  // editMeta prop이 바뀌면(take 전환) 로컬 상태 동기화
  React.useEffect(() => { setTrim(editMeta.trim); setMask(editMeta.mask); setDirty(false); }, [editMeta]);
  React.useEffect(() => {
    if (!selectedMaskCameraId) return;
    const current = mask.camera_id || selectedMaskCameraId;
    if (current === selectedMaskCameraId) return;
    setMask(p => ({ ...p, camera_id: selectedMaskCameraId, polygon: [] }));
    setDirty(true);
  }, [selectedMaskCameraId, mask.camera_id]);

  const effectiveCutT = trim.cut_t ?? autoGripperOpenT;
  const trimEnd = effectiveCutT !== null ? effectiveCutT + trim.margin : null;
  const targetCamera = mask.camera_id || selectedMaskCameraId;

  const save = () => { onSave({ trim, mask }); setDirty(false); };

  return (
    <div style={{ height: "100%", minHeight: 0, border: "1px solid #e2e8f0", borderRadius: 10, overflow: "hidden", background: "#fff", display: "flex", flexDirection: "column" }}>
      <div style={{ padding: "12px 14px", borderBottom: "1px solid #f1f5f9", display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <div>
          <div style={{ fontSize: 13, fontWeight: 800, color: "#1e293b" }}>Export edit options</div>
          <div style={{ fontSize: 11, color: "#94a3b8", marginTop: 2 }}>Trim and mask settings applied during export.</div>
        </div>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {trim.enabled && <span style={{ background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>Trim ON</span>}
          {mask.enabled && <span style={{ background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 6px", fontSize: 11, fontWeight: 700 }}>Mask ON</span>}
          {dirty && <span style={{ color: "#ef4444", fontSize: 11, fontWeight: 800 }}>Unsaved</span>}
        </span>
      </div>
      <div style={{ padding: "12px 14px", background: "#fff", overflow: "auto", minHeight: 0 }}>
          {/* ── Trim / Mask 가로 grid ── */}
          <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 16, alignItems: "start", marginBottom: 12 }}>
          {/* ── Trim Editor ── */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 0.7, marginBottom: 8 }}>
              Trim (그리퍼 열림 기준 자르기)
            </div>

            {/* 감지 정보 */}
            <div style={{ background: "#f1f5f9", borderRadius: 6, padding: "6px 10px", fontSize: 12, color: "#374151", marginBottom: 8 }}>
              {autoGripperOpenT !== null
                ? <>자동 감지: <strong>t = {autoGripperOpenT.toFixed(2)}s</strong> (10초 이후 첫 gripper open)</>
                : <span style={{ color: "#94a3b8" }}>그리퍼 열림 전환 감지 안 됨 (teach 데이터 없거나 10초 이내)</span>}
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={trim.enabled}
                onChange={e => { setTrim(p => ({ ...p, enabled: e.target.checked })); setDirty(true); }} />
              trim 활성화
            </label>

            {trim.enabled && (
              <>
                {/* cut_t 수동 override */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
                  <span style={{ fontSize: 12, color: "#64748b", flexShrink: 0 }}>Gripper open t (s):</span>
                  <input
                    type="number" step="0.1" min={0}
                    placeholder={autoGripperOpenT !== null ? autoGripperOpenT.toFixed(2) : "auto"}
                    value={trim.cut_t ?? ""}
                    onChange={e => {
                      const v = e.target.value === "" ? null : parseFloat(e.target.value);
                      setTrim(p => ({ ...p, cut_t: v }));
                      setDirty(true);
                    }}
                    style={{ width: 80, padding: "3px 6px", borderRadius: 5, border: "1px solid #cbd5e1", fontSize: 12 }}
                  />
                  {trim.cut_t !== null && (
                    <button onClick={() => { setTrim(p => ({ ...p, cut_t: null })); setDirty(true); }}
                      style={{ fontSize: 11, color: "#6366f1", background: "none", border: "none", cursor: "pointer" }}>
                      ↺ auto
                    </button>
                  )}
                </div>

                {/* trim offset slider */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "#64748b", flexShrink: 0 }}>컷 오프셋:</span>
                  <input type="range" min={-2} max={3} step={0.1}
                    value={trim.margin}
                    onChange={e => { setTrim(p => ({ ...p, margin: parseFloat(e.target.value) })); setDirty(true); }}
                    style={{ flex: 1, accentColor: "#6366f1" }} />
                  <span style={{
                    fontSize: 12,
                    fontWeight: 700,
                    color: trim.margin < 0 ? "#0f766e" : "#6366f1",
                    minWidth: 44,
                    textAlign: "right" as const,
                  }}>{trim.margin > 0 ? "+" : ""}{trim.margin.toFixed(1)}s</span>
                </div>

                {/* 최종 trim 시각 표시 */}
                {(() => {
                  const overDuration = trimEnd !== null && duration !== undefined && trimEnd > duration;
                  const underDuration = trimEnd !== null && trimEnd < 0;
                  const isWarning = overDuration || underDuration;
                  return (
                    <div style={{ fontSize: 12, borderRadius: 5, padding: "4px 8px", marginBottom: 6,
                      background: isWarning ? "#fff7ed" : "#eef2ff",
                      border: isWarning ? "1px solid #fed7aa" : "none" }}>
                      <div>
                        최종 컷: {trimEnd !== null
                          ? <strong style={{ color: isWarning ? "#c2410c" : "#1d4ed8" }}>{trimEnd.toFixed(2)}s</strong>
                          : "—"}
                        {effectiveCutT !== null && (
                          <span style={{ color: "#94a3b8" }}> ({effectiveCutT.toFixed(2)} {trim.margin >= 0 ? "+" : "-"} {Math.abs(trim.margin).toFixed(1)}s)</span>
                        )}
                      </div>
                      {duration !== undefined && (
                        <div style={{ marginTop: 2, color: isWarning ? "#c2410c" : "#94a3b8" }}>
                          {underDuration
                            ? "⚠ 최종 컷이 0초보다 앞입니다"
                            : overDuration
                            ? `⚠ 영상 길이 ${duration.toFixed(1)}s 초과 → trim 효과 없음`
                            : `영상 길이: ${duration.toFixed(1)}s`}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {trimEnd !== null && targetCamera && (
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                      컷 지점 프레임 (joint t={trimEnd.toFixed(2)}s):
                    </div>
                    <CameraFrame episodeId={episodeId} take={take} cameraId={targetCamera} tSec={trimEnd} tBase="video" />
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Mask Editor ── */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 0.7, marginBottom: 8 }}>
              Video Mask
            </div>
            <div style={{ fontSize: 12, color: "#64748b", marginBottom: 8 }}>
              Target camera follows the active RGB camera tab: <strong style={{ color: "#15803d" }}>{targetCamera || "none"}</strong>
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={mask.enabled} disabled={!targetCamera}
                onChange={e => { setMask(p => ({ ...p, enabled: e.target.checked })); setDirty(true); }} />
              mask 활성화
            </label>

            {mask.enabled && targetCamera && (
              <MaskPolygonEditor
                episodeId={episodeId}
                take={take}
                currentTime={currentTime}
                mask={mask}
                cameraId={targetCamera}
                onMaskChange={m => { setMask(m); setDirty(true); }}
              />
            )}
          </div>
          </div>{/* end grid */}

          {/* 저장 버튼 */}
          <button
            onClick={save}
            disabled={!dirty}
            style={{ padding: "6px 18px", background: dirty ? "#6366f1" : "#e2e8f0",
              color: dirty ? "#fff" : "#94a3b8", border: "none", borderRadius: 6,
              fontSize: 13, fontWeight: 700, cursor: dirty ? "pointer" : "default" }}
          >
            {dirty ? "저장" : "저장됨"}
          </button>
      </div>
    </div>
  );
}

// ── Shared camera frame preview ──────────────────────────────────────────

function CameraFrame({
  episodeId, take, cameraId, tSec, tBase = "video", style, onAspectRatio,
}: {
  episodeId: string;
  take: string;
  cameraId: string;
  tSec: number;
  tBase?: "video" | "camera";
  style?: React.CSSProperties;
  onAspectRatio?: (ratio: number) => void;
}) {
  const [url, setUrl] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  const makeFrameUrl = React.useCallback(() => {
    const t = tSec.toFixed(2);
    const cache = Date.now();
    return `/api/episodes/${episodeId}/takes/${take}/frame_camera_at/${cameraId}?t=${t}&ref=${tBase}&_=${cache}`;
  }, [episodeId, take, cameraId, tSec, tBase]);

  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setLoading(true);  // tSec 변경 즉시 dim → 로딩 중 피드백
    setFailed(false);
    timerRef.current = setTimeout(() => {
      setUrl(makeFrameUrl());
    }, 200);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [makeFrameUrl]);

  return (
    <div style={{ position: "relative", width: "100%", aspectRatio: "16 / 9", minHeight: 160, borderRadius: 8, overflow: "hidden", background: "#0f172a", ...style }}>
      {url && !failed && (
        <img
          src={url}
          alt={`${cameraId} @${tSec.toFixed(1)}s`}
          onLoad={e => {
            setLoading(false);
            const { naturalWidth, naturalHeight } = e.currentTarget;
            if (naturalWidth > 0 && naturalHeight > 0) {
              onAspectRatio?.(naturalWidth / naturalHeight);
            }
          }}
          onError={() => {
            setLoading(false);
            setFailed(true);
          }}
          style={{
            width: "100%",
            height: "100%",
            objectFit: "contain",
            display: "block",
            opacity: loading ? 0.35 : 1,
            transition: "opacity 0.15s",
          }}
        />
      )}
      {(!url || failed) && (
        <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center", justifyContent: "center", color: "#94a3b8", fontSize: 12, fontWeight: 800, padding: 12, textAlign: "center" }}>
          {failed ? `No frame for ${cameraId}` : "Loading frame..."}
        </div>
      )}
    </div>
  );
}

// ── Mask Polygon Editor ───────────────────────────────────────────────────

function MaskPolygonEditor({
  episodeId, take, currentTime, mask, cameraId, onMaskChange,
}: {
  episodeId: string;
  take: string;
  currentTime: number;
  mask: MaskMeta;
  cameraId: string;
  onMaskChange: (m: MaskMeta) => void;
}) {
  const polygon = mask.polygon;
  const [showMask, setShowMask] = React.useState(true);
  const [library, setLibrary] = React.useState<MaskLibraryEntry[]>([]);
  const [saveName, setSaveName] = React.useState("");
  const [showLib, setShowLib] = React.useState(false);
  const [frameAspect, setFrameAspect] = React.useState(16 / 9);

  const loadLibrary = React.useCallback(() => {
    fetch("/api/masks").then(r => r.json()).then(setLibrary).catch(() => {});
  }, []);
  React.useEffect(() => { if (showLib) loadLibrary(); }, [showLib, loadLibrary]);

  const saveToLibrary = () => {
    if (polygon.length < 3 || !saveName.trim()) return;
    fetch("/api/masks", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: saveName.trim(), polygon, source_episode: episodeId, source_take: take }),
    }).then(r => r.json()).then(entry => {
      setLibrary(prev => [...prev, entry]);
      setSaveName("");
    }).catch(() => {});
  };

  // 프레임 캡쳐 마스크: 캡쳐 기준 프레임 URL
  const frameUrl = React.useCallback((t: number) => {
    return `/api/episodes/${episodeId}/takes/${take}/frame_camera_at/${cameraId}?t=${t.toFixed(2)}&ref=video`;
  }, [episodeId, take, cameraId]);

  const captureFrameUrl = React.useMemo(() => {
    if (mask.fill !== "frame_capture" || mask.capture_t === undefined) return "";
    return frameUrl(mask.capture_t);
  }, [frameUrl, mask.fill, mask.capture_t]);

  const deleteFromLibrary = (id: string) => {
    fetch(`/api/masks/${id}`, { method: "DELETE" })
      .then(() => setLibrary(prev => prev.filter(e => e.id !== id)))
      .catch(() => {});
  };

  const handleSvgClick = (e: React.MouseEvent<SVGSVGElement>) => {
    const rect = e.currentTarget.getBoundingClientRect();
    const x = (e.clientX - rect.left) / rect.width;
    const y = (e.clientY - rect.top) / rect.height;
    onMaskChange({ ...mask, polygon: [...polygon, [x, y] as [number, number]] });
  };

  const removePoint = (i: number, e: React.MouseEvent) => {
    e.stopPropagation();
    onMaskChange({ ...mask, polygon: polygon.filter((_, idx) => idx !== i) });
  };

  const outsidePath = polygon.length >= 3
    ? `M0 0 L1 0 L1 1 L0 1 Z M${polygon.map(([x, y]) => `${x} ${y}`).join(" L")} Z`
    : null;

  return (
    <div>
      {/* 마스크 타입 선택 */}
      <div style={{ display: "flex", gap: 6, marginBottom: 10 }}>
        {(["black", "frame_capture"] as const).map(type => (
          <button key={type}
            onClick={() => onMaskChange({ ...mask, fill: type })}
            style={{
              padding: "4px 12px", borderRadius: 6, fontSize: 11, fontWeight: 700, cursor: "pointer",
              border: `2px solid ${mask.fill === type ? "#6366f1" : "#e2e8f0"}`,
              background: mask.fill === type ? "#eef2ff" : "#fff",
              color: mask.fill === type ? "#4338ca" : "#64748b",
            }}>
            {type === "black" ? "🖤 검정 마스크" : "📷 프레임 캡쳐 마스크"}
          </button>
        ))}
      </div>

      {/* 프레임 캡쳐 타입: 캡쳐 시각 설정 */}
      {mask.fill === "frame_capture" && (
        <div style={{ background: "#f0fdf4", border: "1px solid #bbf7d0", borderRadius: 6, padding: "8px 10px", marginBottom: 8 }}>
          <div style={{ fontSize: 11, color: "#166534", marginBottom: 6 }}>
            외부 = 캡쳐 프레임 고정 · 내부(keep 영역) = 원본 비디오
          </div>
          <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
            <span style={{ fontSize: 12, color: "#374151" }}>
              캡쳐 기준: {mask.capture_t !== undefined
                ? <strong>{mask.capture_t.toFixed(2)}s</strong>
                : <em style={{ color: "#94a3b8" }}>미설정</em>}
            </span>
            <button
              onClick={() => onMaskChange({ ...mask, capture_t: currentTime })}
              style={{ padding: "3px 10px", borderRadius: 5, border: "none", fontSize: 11, fontWeight: 700,
                background: "#16a34a", color: "#fff", cursor: "pointer" }}>
              현재 프레임으로 캡쳐 ({currentTime.toFixed(2)}s)
            </button>
          </div>
        </div>
      )}

      <div style={{ fontSize: 11, color: "#94a3b8", marginBottom: 6 }}>
        SVG 클릭 → 꼭짓점 추가 · 점 클릭 → 제거
      </div>

      {/* 프레임 + SVG 오버레이 (실제 export 결과 미리보기) */}
      <div style={{
        position: "relative",
        width: "100%",
        aspectRatio: `${frameAspect}`,
        background: "#000",
        borderRadius: 8,
        overflow: "hidden",
        marginBottom: 8,
      }}>
        {/* 레이어 1: 현재 프레임 (keep 영역의 실제 비디오) */}
        <CameraFrame
          episodeId={episodeId}
          take={take}
          cameraId={cameraId}
          tSec={currentTime}
          onAspectRatio={setFrameAspect}
          style={{
            position: "absolute",
            inset: 0,
            height: "100%",
            minHeight: 0,
            aspectRatio: "auto",
            borderRadius: 0,
            opacity: showMask && mask.fill === "black" ? 0.6 : 1,
          }}
        />

        {/* 레이어 2 + 3: SVG — 마스크 미리보기 + 폴리곤 편집 */}
        <svg viewBox="0 0 1 1" preserveAspectRatio="none"
          style={{ position: "absolute", top: 0, left: 0, width: "100%", height: "100%", cursor: "crosshair" }}
          onClick={handleSvgClick}
        >
          {showMask && outsidePath && (
            mask.fill === "frame_capture" && captureFrameUrl ? (
              // 프레임 캡쳐 타입: 캡쳐 프레임을 외부 영역에만 렌더링 (evenodd clipPath)
              <>
                <defs>
                  <clipPath id="cp-mask-outside" clipPathUnits="userSpaceOnUse">
                    <path d={outsidePath} clipRule="evenodd" />
                  </clipPath>
                </defs>
                <image
                  href={captureFrameUrl}
                  x="0" y="0" width="1" height="1"
                  preserveAspectRatio="none"
                  clipPath="url(#cp-mask-outside)"
                />
              </>
            ) : mask.fill === "black" ? (
              // 검정 마스크: 외부 영역 검정 반투명
              <path d={outsidePath} fill="rgba(0,0,0,0.55)" fillRule="evenodd" />
            ) : null
          )}
          {polygon.length >= 2 && (
            <polygon points={polygon.map(([x, y]) => `${x},${y}`).join(" ")}
              fill="none" stroke="#22c55e" strokeWidth="0.004" />
          )}
          {polygon.map(([x, y], i) => (
            <circle key={i} cx={x} cy={y} r="0.018"
              fill="#22c55e" stroke="#fff" strokeWidth="0.005"
              style={{ cursor: "pointer" }}
              onClick={e => removePoint(i, e as unknown as React.MouseEvent)} />
          ))}
        </svg>

        {currentTime === 0 && (
          <div style={{ position: "absolute", inset: 0, display: "flex", alignItems: "center",
            justifyContent: "center", color: "#94a3b8", fontSize: 11, pointerEvents: "none" }}>
            비디오 재생 후 원하는 시점 정지 → 프레임 표시
          </div>
        )}
      </div>

      {/* 컨트롤 */}
      <div style={{ display: "flex", gap: 6, flexWrap: "wrap" as const, alignItems: "center", marginBottom: 8 }}>
        <label style={{ fontSize: 12, display: "flex", alignItems: "center", gap: 4, cursor: "pointer", color: "#475569" }}>
          <input type="checkbox" checked={showMask} onChange={e => setShowMask(e.target.checked)} />
          마스크 미리보기
        </label>
        <button onClick={() => onMaskChange({ ...mask, polygon: polygon.slice(0, -1) })} disabled={polygon.length === 0}
          style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: "1px solid #e2e8f0", background: "#fff", color: "#374151", cursor: "pointer" }}>
          마지막 점 제거
        </button>
        <button onClick={() => onMaskChange({ ...mask, polygon: [] })}
          style={{ fontSize: 11, padding: "3px 10px", borderRadius: 5, border: "1px solid #e2e8f0", background: "#fff", color: "#ef4444", cursor: "pointer" }}>
          초기화
        </button>
        <span style={{ fontSize: 11, color: "#94a3b8" }}>{polygon.length}개 꼭짓점</span>
      </div>

      {/* 마스크 라이브러리 */}
      <div style={{ border: "1px solid #e2e8f0", borderRadius: 6, overflow: "hidden" }}>
        <button onClick={() => setShowLib(v => !v)}
          style={{ width: "100%", padding: "6px 10px", background: "#f8fafc", border: "none",
            cursor: "pointer", fontSize: 11, fontWeight: 700, color: "#475569",
            display: "flex", justifyContent: "space-between" }}>
          <span>📚 마스크 라이브러리</span>
          <span>{showLib ? "▲" : "▼"}</span>
        </button>
        {showLib && (
          <div style={{ padding: "8px 10px" }}>
            <div style={{ display: "flex", gap: 6, marginBottom: 8 }}>
              <input type="text" placeholder="마스크 이름…" value={saveName}
                onChange={e => setSaveName(e.target.value)}
                style={{ flex: 1, padding: "3px 7px", borderRadius: 5, border: "1px solid #cbd5e1", fontSize: 11 }} />
              <button onClick={saveToLibrary} disabled={polygon.length < 3 || !saveName.trim()}
                style={{ padding: "3px 10px", borderRadius: 5, border: "none", fontSize: 11, fontWeight: 700,
                  background: polygon.length >= 3 && saveName.trim() ? "#6366f1" : "#e2e8f0",
                  color: polygon.length >= 3 && saveName.trim() ? "#fff" : "#94a3b8", cursor: "pointer" }}>
                저장
              </button>
            </div>
            {library.length === 0
              ? <div style={{ fontSize: 11, color: "#94a3b8", textAlign: "center", padding: "8px 0" }}>저장된 마스크 없음</div>
              : library.map(entry => (
                <div key={entry.id}
                  style={{ display: "flex", alignItems: "center", gap: 6, padding: "5px 0",
                    borderBottom: "1px solid #f1f5f9", fontSize: 11 }}>
                  <button onClick={() => onMaskChange({ ...mask, polygon: entry.polygon as [number, number][] })}
                    style={{ flex: 1, textAlign: "left", background: "none", border: "none",
                      cursor: "pointer", color: "#1d4ed8", fontWeight: 600, fontSize: 11 }}>
                    {entry.name}
                  </button>
                  <span style={{ color: "#94a3b8", fontSize: 10 }}>
                    {entry.polygon.length}pts · {entry.created_at}
                  </span>
                  {entry.source_episode && (
                    <span style={{ color: "#94a3b8", fontSize: 10 }}>{entry.source_episode.slice(-12)}</span>
                  )}
                  <button onClick={() => deleteFromLibrary(entry.id)}
                    style={{ background: "none", border: "none", color: "#ef4444", cursor: "pointer", fontSize: 12 }}>✕</button>
                </div>
              ))
            }
          </div>
        )}
      </div>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: { display: "flex", flexDirection: "column", height: "100%", gap: 0 },
  header: {
    display: "flex", alignItems: "center", justifyContent: "space-between",
    gap: 12, marginBottom: 12, flexWrap: "wrap",
  },
  headerLeft: { display: "flex", alignItems: "baseline", gap: 12 },
  headerRight: { display: "flex", alignItems: "center", gap: 6, flexWrap: "wrap" as const },
  title: { fontSize: 18, fontWeight: 700, color: "#1e293b", margin: 0 },
  stats: { fontSize: 12, color: "#94a3b8" },
  searchInput: {
    padding: "4px 10px", borderRadius: 6, border: "1px solid #e5e7eb",
    fontSize: 12, width: 160, outline: "none",
  },
  filterBtn: { padding: "3px 10px", border: "none", borderRadius: 5, fontSize: 11, fontWeight: 700, cursor: "pointer" },
  refreshBtn: { padding: "3px 10px", background: "#f1f5f9", border: "none", borderRadius: 5, fontSize: 14, cursor: "pointer" },
  viewToggle: { display: "flex", border: "1px solid #e5e7eb", borderRadius: 6, overflow: "hidden" },
  viewBtn: { border: "none", padding: "4px 8px", fontSize: 11, fontWeight: 700, cursor: "pointer" },
  body: { display: "flex", flex: 1, gap: 16, minHeight: 0, overflow: "hidden" },
  listPanel: {
    width: 430, flexShrink: 0, overflowY: "auto", overflowX: "hidden",
    display: "flex", flexDirection: "column", gap: 8,
    minWidth: 0,
  },
  collectionHeader: {
    display: "flex", justifyContent: "space-between", alignItems: "center",
    fontSize: 11, fontWeight: 800, color: "#64748b", textTransform: "uppercase",
    letterSpacing: 0.8,
  },
  linearList: { display: "flex", flexDirection: "column", gap: 8 },
  gridList: { display: "grid", gridTemplateColumns: "repeat(4, minmax(0, 1fr))", gap: 8 },
  detailPanel: {
    flex: 1, overflowY: "auto", background: "#fff", borderRadius: 10,
    border: "1px solid #e5e7eb", padding: 16,
  },
  empty: { color: "#9ca3af", fontSize: 13, padding: "24px 0", textAlign: "center" },
  epRow: {
    display: "flex", alignItems: "center", gap: 8,
    padding: "6px 10px", borderRadius: 8, border: "1px solid #e5e7eb",
    cursor: "pointer", minHeight: 52,
  },
  epId: { fontFamily: "monospace", fontSize: 10, color: "#6366f1", fontWeight: 700 },
  epTask: {
    fontSize: 11, color: "#374151", marginTop: 1,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  epMeta: { display: "flex", alignItems: "center", gap: 6, marginTop: 2 },
  metaText: { fontSize: 10, color: "#9ca3af" },
  badge: { padding: "1px 6px", borderRadius: 4, fontSize: 10, fontWeight: 700 },
  thumbRow: {
    display: "flex", alignItems: "center", gap: 10,
    border: "1px solid #e5e7eb", borderRadius: 10,
    padding: 9, cursor: "pointer", minHeight: 98,
  },
  thumbTitleRow: { display: "flex", alignItems: "center", gap: 6, minWidth: 0 },
  thumbTask: {
    fontSize: 13, color: "#111827", fontWeight: 700, marginTop: 5,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  thumbMeta: { fontSize: 11, color: "#64748b", marginTop: 4 },
  postprocessBadge: {
    fontSize: 9, background: "#dbeafe", color: "#1d4ed8",
    borderRadius: 3, padding: "1px 5px", fontWeight: 800,
  },
  rowDeleteBtn: {
    width: 24, height: 24, borderRadius: 5, border: "none",
    background: "#f8fafc", color: "#94a3b8", cursor: "pointer",
    fontSize: 16, lineHeight: 1, flexShrink: 0,
  },
  videoThumb: {
    position: "relative",
    width: 104, aspectRatio: "16 / 9", borderRadius: 8,
    overflow: "hidden", background: "#0f172a", flexShrink: 0,
    display: "flex", alignItems: "center", justifyContent: "center",
  },
  videoThumbMedia: { width: "100%", height: "100%", objectFit: "cover", display: "block" },
  videoThumbEmpty: { color: "#94a3b8", fontSize: 11, fontWeight: 700 },
  thumbStatusOverlay: {
    position: "absolute",
    top: 6,
    right: 6,
    color: "#fff",
    borderRadius: 4,
    padding: "1px 5px",
    fontSize: 9,
    fontWeight: 900,
    letterSpacing: 0.4,
    lineHeight: 1.4,
  },
  chipRow: { display: "flex", gap: 4, flexWrap: "wrap" as const, marginTop: 6 },
  dataChip: {
    border: "1px solid #e2e8f0", borderRadius: 4,
    padding: "1px 4px", fontSize: 9, fontWeight: 800,
  },
  compactHead: {
    display: "grid", gridTemplateColumns: "22px minmax(0, 1.15fr) minmax(0, 1.45fr) 76px 44px 70px 78px",
    gap: 6, alignItems: "center", padding: "0 10px",
    color: "#94a3b8", fontSize: 10, fontWeight: 800, textTransform: "uppercase",
    boxSizing: "border-box",
  },
  compactRow: {
    display: "grid", gridTemplateColumns: "22px minmax(0, 1.15fr) minmax(0, 1.45fr) 76px 44px 70px 78px",
    gap: 6, alignItems: "center", border: "1px solid #e5e7eb",
    borderRadius: 8, padding: "7px 8px", cursor: "pointer",
    boxSizing: "border-box", width: "100%", minWidth: 0,
  },
  compactId: { fontFamily: "monospace", fontSize: 10, color: "#4f46e5", fontWeight: 800, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  compactTask: { fontSize: 11, color: "#111827", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
  compactMeta: { fontSize: 11, color: "#64748b" },
  gridCard: {
    position: "relative", border: "1px solid #e5e7eb", borderRadius: 10,
    background: "#fff", padding: 7, cursor: "pointer", minWidth: 0,
  },
  gridCheckbox: { position: "absolute", top: 8, left: 8, zIndex: 2, accentColor: "#6366f1" },
  gridDeleteBtn: {
    position: "absolute", top: 8, right: 8, zIndex: 2,
    width: 22, height: 22, border: "none", borderRadius: 5,
    background: "rgba(15,23,42,0.58)", color: "#fff", cursor: "pointer",
  },
  gridTask: {
    fontSize: 10, fontWeight: 800, color: "#111827", marginTop: 6,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  gridMeta: { fontSize: 9, color: "#64748b", margin: "3px 0 4px" },
  deleteBtn: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: 11, color: "#94a3b8", padding: "2px 4px",
  },
  confirmBtn: {
    background: "#ef4444", color: "#fff", border: "none",
    borderRadius: 4, padding: "2px 7px", fontSize: 11, cursor: "pointer",
  },
  cancelBtn: {
    background: "#e5e7eb", color: "#374151", border: "none",
    borderRadius: 4, padding: "2px 7px", fontSize: 11, cursor: "pointer",
  },
  takeRow: { display: "flex", alignItems: "center", gap: 6, marginBottom: 2 },
  takeSelect: {
    padding: "4px 8px", borderRadius: 6, border: "1px solid #e5e7eb",
    fontSize: 12, flex: 1,
  },
  takeChip: { fontSize: 11, color: "#94a3b8", flexShrink: 0 },
  sectionLabel: {
    fontSize: 10, textTransform: "uppercase" as const,
    letterSpacing: 1, color: "#94a3b8", fontWeight: 700, marginBottom: 4,
  },
  tabBtn: { padding: "3px 8px", border: "none", borderRadius: 5, fontSize: 11, cursor: "pointer", fontWeight: 600 },
  inspectorTabs: {
    display: "flex", gap: 6, borderTop: "1px solid #f1f5f9",
    paddingTop: 10, marginTop: 10,
  },
  inspectorTabBtn: {
    border: "1px solid #e5e7eb", borderRadius: 6,
    padding: "6px 12px", fontSize: 12, fontWeight: 800, cursor: "pointer",
  },
  noSelection: {
    flex: 1, display: "flex", alignItems: "center",
    justifyContent: "center", color: "#94a3b8", fontSize: 14,
  },
  mediaGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
    marginTop: 12,
    alignItems: "start",
  },
  mediaCell: {
    minWidth: 0,
    minHeight: 0,
  },
  workspaceGrid: {
    display: "grid",
    gridTemplateColumns: "minmax(360px, 1fr) minmax(320px, 1fr)",
    gridTemplateRows: "minmax(240px, 0.9fr) minmax(280px, 1.1fr)",
    gap: 10,
    height: "calc(100vh - 245px)",
    minHeight: 560,
    marginTop: 10,
    overflow: "hidden",
  },
  workspaceCell: {
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
    display: "flex",
    flexDirection: "column",
  },
  workspaceCellBody: {
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "auto",
    padding: 10,
  },
  workspaceWide: {
    gridColumn: "2 / 3",
    gridRow: "1 / 3",
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
  },
  exportReadyText: {
    fontSize: 13,
    lineHeight: 1.5,
    color: "#475569",
    marginBottom: 12,
  },
  trajectoryTab: {
    display: "flex",
    flexDirection: "column",
    height: "calc(100vh - 230px)",
    minHeight: 400,
    overflow: "hidden",
    marginTop: 8,
    gap: 8,
  },
  trajectoryToolbar: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    gap: 6,
  },
  trajectoryGrid: {
    flex: "1 1 auto",
    minHeight: 0,
    display: "grid",
    gridTemplateColumns: "minmax(0,1fr) minmax(0,1fr)",
    gridTemplateRows: "minmax(0,1fr) minmax(0,1fr)",
    gap: 10,
    overflow: "hidden",
  },
  trajCell: {
    minWidth: 0,
    minHeight: 0,
    overflow: "hidden",
    border: "1px solid #e5e7eb",
    borderRadius: 10,
    background: "#fff",
    display: "flex",
    flexDirection: "column",
  },
  trajCellHeader: {
    flex: "0 0 auto",
    display: "flex",
    alignItems: "center",
    justifyContent: "space-between",
    padding: "5px 10px",
    fontSize: 11,
    fontWeight: 700,
    color: "#64748b",
    letterSpacing: "0.05em",
    textTransform: "uppercase",
    borderBottom: "1px solid #f1f5f9",
  },
  trajCellBody: {
    flex: "1 1 auto",
    minHeight: 0,
    overflow: "hidden",
    position: "relative",
  },
  summaryGrid: {
    display: "grid", gridTemplateColumns: "repeat(2, minmax(0, 1fr))",
    gap: 8,
  },
  summaryItem: {
    border: "1px solid #e5e7eb", borderRadius: 8,
    padding: "9px 10px", background: "#f8fafc",
  },
  summaryLabel: { display: "block", fontSize: 10, color: "#94a3b8", fontWeight: 800, textTransform: "uppercase" },
  summaryValue: { display: "block", fontSize: 13, color: "#111827", fontWeight: 800, marginTop: 4 },
  emptyHero: { fontSize: 18, color: "#111827", fontWeight: 900, marginBottom: 14 },
  quickFilters: { display: "flex", gap: 8, flexWrap: "wrap" as const, marginTop: 16 },
  quickFilterBtn: {
    border: "1px solid #e5e7eb", borderRadius: 8, background: "#fff",
    color: "#4f46e5", fontSize: 12, fontWeight: 800, padding: "8px 10px", cursor: "pointer",
  },
  batchTaskRow: {
    display: "flex", justifyContent: "space-between", gap: 12,
    borderBottom: "1px solid #f1f5f9", padding: "7px 0",
    fontSize: 13, color: "#374151",
  },
  batchActions: { display: "flex", gap: 8, marginTop: 16 },
  exportInspector: {
    marginTop: 12, border: "1px solid #e5e7eb",
    borderRadius: 10, padding: 16, background: "#f8fafc",
  },
  taskInput: {
    flex: 1, padding: "3px 8px", borderRadius: 6,
    border: "1px solid #6366f1", fontSize: 13, outline: "none",
  },
  editBtn: {
    background: "none", border: "none", cursor: "pointer",
    fontSize: 13, color: "#94a3b8", padding: "0 2px", lineHeight: 1,
  },
  checkbox: {
    width: 15, height: 15, flexShrink: 0, cursor: "pointer", accentColor: "#6366f1",
  },
  exportBar: {
    display: "flex", alignItems: "center", gap: 12, flexWrap: "wrap" as const,
    padding: "8px 14px", background: "#eef2ff", borderRadius: 8,
    border: "1px solid #c7d2fe", marginBottom: 10,
  },
  bulkTaskRow: {
    display: "flex", alignItems: "center", gap: 4,
  },
  bulkTaskInput: {
    padding: "4px 8px", borderRadius: 6, fontSize: 12,
    border: "1px solid #a5b4fc", outline: "none", width: 240,
  },
  exportBarBtn: {
    padding: "5px 14px", background: "#6366f1", color: "#fff",
    border: "none", borderRadius: 6, fontSize: 12, fontWeight: 700,
    cursor: "pointer",
  },
};
