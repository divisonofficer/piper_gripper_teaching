import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Episode, EpisodeTake, JointSample, TakeJointsData, EESample, TakeTrajectoryData, EditMeta, MaskMeta, MaskLibraryEntry } from "../types";

// ── Constants ────────────────────────────────────────────────────────────
const JOINT_COLORS = ["#6366f1", "#06b6d4", "#22c55e", "#f59e0b", "#ef4444", "#8b5cf6"];
const JOINT_LABELS = ["J1", "J2", "J3", "J4", "J5", "J6"];

// ── Helpers ───────────────────────────────────────────────────────────────
function fmtMb(mb?: number): string {
  if (mb === undefined || mb === null) return "—";
  if (mb < 1) return `${Math.round(mb * 1024)} KB`;
  if (mb < 1024) return `${mb.toFixed(1)} MB`;
  return `${(mb / 1024).toFixed(2)} GB`;
}

function fmtDuration(seconds?: number): string {
  if (seconds === undefined || seconds === null) return "—";
  if (seconds < 60) return `${seconds.toFixed(1)}s`;
  const m = Math.floor(seconds / 60);
  const s = (seconds % 60).toFixed(0).padStart(2, "0");
  return `${m}m ${s}s`;
}

function takeDuration(data: TakeJointsData | null): number | undefined {
  if (!data) return undefined;
  for (const src of ["teach", "executed", "command"] as const) {
    const samples = data[src];
    if (samples.length > 1) return samples[samples.length - 1].t;
  }
  return undefined;
}

// ── Joint Plot SVG (P1) ───────────────────────────────────────────────────
const JointPlot = React.memo(function JointPlot({
  data, source,
}: {
  data: TakeJointsData;
  source: "teach" | "executed" | "command";
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
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
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
    </svg>
  );
});

const plotStyles: Record<string, React.CSSProperties> = {
  empty: {
    height: 150, display: "flex", alignItems: "center",
    justifyContent: "center", color: "#94a3b8", fontSize: 12,
    background: "#f8fafc", borderRadius: 6,
  },
};

// ── Trajectory SVG components ─────────────────────────────────────────────

const TRAJ_W = 500, TRAJ_H = 200, TRAJ_PAD = 28;

function trajScale(
  vals: number[], plotSize: number, pad: number = TRAJ_PAD
): { scale: (v: number) => number; ticks: number[] } {
  const min = Math.min(...vals), max = Math.max(...vals);
  const range = max - min || 0.001;
  const lo = min - range * 0.1, hi = max + range * 0.1;
  const scale = (v: number) => pad + ((v - lo) / (hi - lo)) * plotSize;
  const ticks = [lo, (lo + hi) / 2, hi];
  return { scale, ticks };
}

function gripperEvents(samples: EESample[]): { x: number; y: number; open: boolean }[] {
  const result: { x: number; y: number; open: boolean }[] = [];
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1].gripper > 0.035;
    const curr = samples[i].gripper > 0.035;
    if (prev !== curr) result.push({ x: i, y: 0, open: curr });
  }
  return result;
}

const TrajectoryPlanView = React.memo(function TrajectoryPlanView({
  samples, currentTime,
}: { samples: EESample[]; currentTime: number }) {
  if (!samples.length) return <div style={plotStyles.empty}>No data</div>;

  const W = TRAJ_W, H = TRAJ_H, PAD = TRAJ_PAD;
  const plotW = W - PAD * 2, plotH = H - PAD * 2;

  const xs = samples.map(s => s.ee[0]);
  const ys = samples.map(s => s.ee[1]);
  const { scale: sx, ticks: xTicks } = trajScale(xs, plotW);
  const { scale: syRaw, ticks: yTicks } = trajScale(ys, plotH);
  // flip y so positive is up
  const sy = (v: number) => H - syRaw(v);

  const pts = samples.map(s => `${sx(s.ee[0]).toFixed(1)},${sy(s.ee[1]).toFixed(1)}`).join(" ");

  // base origin
  const bx = sx(0), by = sy(0);

  // current cursor
  const tRange = samples[samples.length - 1].t || 1;
  const curIdx = Math.min(samples.length - 1,
    samples.findIndex(s => s.t >= currentTime) === -1
      ? samples.length - 1
      : Math.max(0, samples.findIndex(s => s.t >= currentTime)));
  const cur = samples[curIdx];

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <rect width={W} height={H} rx={6} fill="#f8fafc" />
      {/* grid */}
      {yTicks.map((v, i) => (
        <g key={i}>
          <line x1={PAD} x2={W - PAD} y1={sy(v)} y2={sy(v)} stroke="#e2e8f0" strokeWidth={0.8} />
          <text x={PAD - 3} y={sy(v) + 3} textAnchor="end" fontSize={7} fill="#94a3b8">
            {v.toFixed(2)}m
          </text>
        </g>
      ))}
      {xTicks.map((v, i) => (
        <text key={i} x={sx(v)} y={H - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">
          {v.toFixed(2)}
        </text>
      ))}
      {/* base */}
      <circle cx={bx} cy={by} r={5} fill="#1e293b" />
      <text x={bx + 6} y={by - 5} fontSize={7} fill="#64748b">base</text>
      {/* path */}
      <polyline points={pts} fill="none" stroke="#2563eb" strokeWidth={2} strokeLinejoin="round" />
      {/* start / end */}
      <circle cx={sx(samples[0].ee[0])} cy={sy(samples[0].ee[1])} r={4} fill="#22c55e" />
      <circle cx={sx(samples[samples.length-1].ee[0])} cy={sy(samples[samples.length-1].ee[1])} r={4} fill="#ef4444" />
      {/* gripper events */}
      {samples.map((s, i) => {
        if (i === 0) return null;
        const prev = samples[i-1].gripper > 0.035, curr = s.gripper > 0.035;
        if (prev === curr) return null;
        return <circle key={i} cx={sx(s.ee[0])} cy={sy(s.ee[1])} r={5} fill={curr ? "#22c55e" : "#ef4444"} opacity={0.8} />;
      })}
      {/* cursor */}
      <circle cx={sx(cur.ee[0])} cy={sy(cur.ee[1])} r={6} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
      <text x={W - PAD} y={14} textAnchor="end" fontSize={8} fill="#94a3b8">XY Plan View</text>
    </svg>
  );
});

const TrajectorySideView = React.memo(function TrajectorySideView({
  samples, currentTime,
}: { samples: EESample[]; currentTime: number }) {
  if (!samples.length) return <div style={plotStyles.empty}>No data</div>;

  const W = TRAJ_W, H = TRAJ_H, PAD = TRAJ_PAD;
  const plotW = W - PAD * 2, plotH = H - PAD * 2;

  // X = horizontal reach from base, Y = height (z)
  const reaches = samples.map(s => Math.sqrt(s.ee[0] ** 2 + s.ee[1] ** 2));
  const zs = samples.map(s => s.ee[2]);
  const { scale: sr, ticks: rTicks } = trajScale(reaches, plotW);
  const { scale: szRaw, ticks: zTicks } = trajScale(zs, plotH);
  const sz = (v: number) => H - szRaw(v);

  const pts = samples.map((s, i) => `${sr(reaches[i]).toFixed(1)},${sz(s.ee[2]).toFixed(1)}`).join(" ");

  const curIdx = Math.min(samples.length - 1,
    samples.findIndex(s => s.t >= currentTime) === -1
      ? samples.length - 1
      : Math.max(0, samples.findIndex(s => s.t >= currentTime)));
  const cur = samples[curIdx];

  // skeleton at current frame
  const base = [0, 0, 0] as [number, number, number];
  const skelPts = [[0, 0, 0] as [number, number, number], ...cur.links]
    .map(p => {
      const r = Math.sqrt(p[0] ** 2 + p[1] ** 2);
      return `${sr(r).toFixed(1)},${sz(p[2]).toFixed(1)}`;
    }).join(" ");

  return (
    <svg viewBox={`0 0 ${W} ${H}`} style={{ width: "100%", height: "auto", display: "block" }}>
      <rect width={W} height={H} rx={6} fill="#f8fafc" />
      {zTicks.map((v, i) => (
        <g key={i}>
          <line x1={PAD} x2={W - PAD} y1={sz(v)} y2={sz(v)} stroke="#e2e8f0" strokeWidth={0.8} />
          <text x={PAD - 3} y={sz(v) + 3} textAnchor="end" fontSize={7} fill="#94a3b8">
            {(v * 100).toFixed(0)}cm
          </text>
        </g>
      ))}
      {rTicks.map((v, i) => (
        <text key={i} x={sr(v)} y={H - 4} textAnchor="middle" fontSize={7} fill="#94a3b8">
          {(v * 100).toFixed(0)}cm
        </text>
      ))}
      {/* EE path */}
      <polyline points={pts} fill="none" stroke="#0891b2" strokeWidth={2} strokeLinejoin="round" />
      <circle cx={sr(reaches[0])} cy={sz(samples[0].ee[2])} r={4} fill="#22c55e" />
      <circle cx={sr(reaches[samples.length-1])} cy={sz(samples[samples.length-1].ee[2])} r={4} fill="#ef4444" />
      {/* skeleton */}
      <polyline points={skelPts} fill="none" stroke="#94a3b8" strokeWidth={1.5}
        strokeLinejoin="round" strokeDasharray="4 2" />
      {[[0,0,0] as [number,number,number], ...cur.links].map((p, i) => {
        const r = Math.sqrt(p[0]**2 + p[1]**2);
        return <circle key={i} cx={sr(r)} cy={sz(p[2])} r={i === 0 ? 4 : 3}
          fill={i === 0 ? "#1e293b" : "#6366f1"} />;
      })}
      {/* cursor on EE path */}
      <circle cx={sr(Math.sqrt(cur.ee[0]**2 + cur.ee[1]**2))} cy={sz(cur.ee[2])}
        r={6} fill="#f59e0b" stroke="#fff" strokeWidth={2} />
      <text x={W - PAD} y={14} textAnchor="end" fontSize={8} fill="#94a3b8">Side / Reach-Z View</text>
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
  const [videoSource, setVideoSource] = useState<"color" | "depth" | "webcam_0" | "webcam_1">("color");
  const [jointSource, setJointSource] = useState<"teach" | "executed" | "command">("teach");
  const [jointsData, setJointsData] = useState<TakeJointsData | null>(null);
  const [jointsLoading, setJointsLoading] = useState(false);
  const [trajectoryData, setTrajectoryData] = useState<TakeTrajectoryData | null>(null);
  const [trajLoading, setTrajLoading] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [videoDuration, setVideoDuration] = useState<number | undefined>(undefined);
  const videoRef = useRef<HTMLVideoElement>(null);
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
  const [bulkTask, setBulkTask] = useState("");
  const [bulkTaskSaving, setBulkTaskSaving] = useState(false);
  const [editMeta, setEditMeta] = useState<EditMeta | null>(null);
  const [sortBy, setSortBy] = useState<"date" | "task">("date");
  const [hoveredEp, setHoveredEp] = useState<string | null>(null);
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
    if (!selectedId || !selectedTake) { setJointsData(null); return; }
    setJointsLoading(true);
    fetch(`/api/episodes/${selectedId}/takes/${selectedTake}/joints`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setJointsData(d); setJointsLoading(false); })
      .catch(() => { setJointsData(null); setJointsLoading(false); });
  }, [selectedId, selectedTake]);

  useEffect(() => {
    if (!selectedId || !selectedTake) { setTrajectoryData(null); return; }
    setTrajLoading(true);
    fetch(`/api/episodes/${selectedId}/takes/${selectedTake}/trajectory`)
      .then(r => r.ok ? r.json() : null)
      .then(d => { setTrajectoryData(d); setTrajLoading(false); })
      .catch(() => { setTrajectoryData(null); setTrajLoading(false); });
  }, [selectedId, selectedTake]);

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
    if (sortBy === "task") {
      return [...filtered].sort((a, b) => (a.task ?? "").localeCompare(b.task ?? ""));
    }
    return filtered;
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

  const toggleEpSelect = useCallback((epId: string, e: React.MouseEvent) => {
    e.stopPropagation();
    setSelectedEps(prev => {
      const next = new Set(prev);
      next.has(epId) ? next.delete(epId) : next.add(epId);
      return next;
    });
  }, []);

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
      body: JSON.stringify({ episode_ids: [...selectedEps] }),
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
  }, [selectedEps, exportingLerobot]);

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

  const nearestSample = useMemo((): EESample | null => {
    const arr = trajectoryData?.[jointSource];
    if (!arr || !arr.length) return null;
    let best = arr[0];
    for (const s of arr) {
      if (Math.abs(s.t - currentTime) < Math.abs(best.t - currentTime)) best = s;
    }
    return best;
  }, [trajectoryData, jointSource, currentTime]);

  const currentTake: EpisodeTake | null = selected?.takes.find(t => t.take === selectedTake) ?? null;

  const videoUrl = useMemo(() => {
    if (!selectedId || !selectedTake) return null;
    const base = `/api/episodes/${selectedId}/takes/${selectedTake}`;
    if (videoSource === "color") return `${base}/video`;
    if (videoSource === "depth") return `${base}/video_depth`;
    if (videoSource === "webcam_0") return `${base}/video_webcam_0`;
    if (videoSource === "webcam_1") return `${base}/video_webcam_1`;
    return null;
  }, [selectedId, selectedTake, videoSource]);

  const duration = takeDuration(jointsData);

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
          <select value={sortBy} onChange={e => setSortBy(e.target.value as "date" | "task")}
            style={{ padding: "3px 6px", borderRadius: 5, border: "1px solid #e5e7eb", fontSize: 11, background: "#fff" }}>
            <option value="date">최신순</option>
            <option value="task">task순</option>
          </select>
          <button style={styles.refreshBtn} onClick={fetchEpisodes}>↻</button>
        </div>
      </div>

      {/* Selection Toolbar */}
      {selectedEps.size > 0 && (
        <div style={styles.exportBar}>
          <span style={{ fontSize: 12, color: "#1e293b", fontWeight: 600, flexShrink: 0 }}>
            {selectedEps.size}개 선택
          </span>
          <button onClick={selectSameTask} style={{ ...styles.exportBarBtn, background: "#0891b2", fontSize: 11 }}>
            같은 task 선택
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
          onIncludeFrames={setIncludeFrames}
          onExportZip={exportSelected}
          onExportLerobot={exportLerobot}
          onClose={() => setExportModal(false)}
        />
      )}

      {/* Body */}
      <div style={styles.body}>
        {/* Episode list */}
        <div style={styles.listPanel}>
          {sorted.length === 0 && (
            <div style={styles.empty}>
              {search || filter !== "all" ? "No matches." : "No episodes yet."}
            </div>
          )}
          {sorted.map(ep => {
            const isSelected = selected?.episode_id === ep.episode_id;
            const isHovered = hoveredEp === ep.episode_id;
            const showDelete = isHovered || confirmDeleteEp === ep.episode_id;
            return (
              <div key={ep.episode_id}
                style={{ ...styles.epRow, background: isSelected ? "#eef2ff" : "#fff" }}
                onClick={() => { setSelected(ep); setConfirmDeleteEp(null); }}
                onMouseEnter={() => setHoveredEp(ep.episode_id)}
                onMouseLeave={() => setHoveredEp(null)}>
                <input
                  type="checkbox"
                  checked={selectedEps.has(ep.episode_id)}
                  onChange={() => {}}
                  onClick={e => toggleEpSelect(ep.episode_id, e)}
                  style={styles.checkbox}
                />
                <div style={{ flex: 1, minWidth: 0 }}>
                  <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
                    <span style={styles.epId}>{ep.episode_id.slice(-18)}</span>
                    {ep.has_postprocess && (
                      <span title="postprocess 편집 있음"
                        style={{ fontSize: 9, background: "#dbeafe", color: "#1d4ed8", borderRadius: 3, padding: "0 4px", fontWeight: 700 }}>
                        ✂
                      </span>
                    )}
                  </div>
                  <div style={styles.epMeta}>
                    <StatusBadge success={ep.success} />
                    <span style={styles.metaText}>{ep.task || "—"}</span>
                    <span style={{ ...styles.metaText, marginLeft: "auto" }}>{ep.takes_count ?? 0}t · {fmtMb(ep.size_mb)}</span>
                  </div>
                </div>
                {showDelete && (
                  <div style={{ flexShrink: 0 }} onClick={e => e.stopPropagation()}>
                    {confirmDeleteEp === ep.episode_id ? (
                      <ConfirmInline
                        label="Delete?"
                        onConfirm={() => deleteEpisode(ep.episode_id)}
                        onCancel={() => setConfirmDeleteEp(null)}
                      />
                    ) : (
                      <button
                        onClick={e => { e.stopPropagation(); setConfirmDeleteEp(ep.episode_id); }}
                        style={styles.deleteBtn}>✕</button>
                    )}
                  </div>
                )}
              </div>
            );
          })}
        </div>

        {/* Detail panel */}
        {selected ? (
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

            {/* Video + Joint Plot — 2-column grid */}
            <div style={styles.mediaGrid}>
              {/* Left: Video */}
              <div style={styles.mediaCell}>
                <div style={styles.sectionLabel}>Video</div>
                {currentTake ? (
                  <>
                    <div style={{ display: "flex", gap: 3, marginBottom: 6, flexWrap: "wrap" as const }}>
                      {[
                        { id: "color" as const, label: "Color", avail: currentTake.has_video },
                        { id: "depth" as const, label: "Depth", avail: currentTake.has_video },
                        { id: "webcam_0" as const, label: "Cam0", avail: currentTake.has_webcam_0 },
                        { id: "webcam_1" as const, label: "Cam1", avail: currentTake.has_webcam_1 },
                      ].filter(v => v.avail).map(v => (
                        <button key={v.id} onClick={() => setVideoSource(v.id)}
                          style={{ ...styles.tabBtn, background: videoSource === v.id ? "#6366f1" : "#f1f5f9", color: videoSource === v.id ? "#fff" : "#374151" }}>
                          {v.label}
                        </button>
                      ))}
                    </div>
                    {videoUrl ? (
                      <video key={videoUrl} ref={videoRef} controls
                        onLoadedMetadata={() => setVideoDuration(videoRef.current?.duration)}
                        onTimeUpdate={() => setCurrentTime(videoRef.current?.currentTime ?? 0)}
                        style={{ width: "100%", borderRadius: 6, background: "#000", display: "block" }}>
                        <source src={videoUrl} type="video/mp4" />
                      </video>
                    ) : (
                      <div style={plotStyles.empty}>No video available</div>
                    )}
                  </>
                ) : (
                  <div style={plotStyles.empty}>No take selected</div>
                )}
              </div>

              {/* Right: Joint Plot */}
              <div style={styles.mediaCell}>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 4 }}>
                  <div style={styles.sectionLabel}>Joint Plot</div>
                  <div style={{ display: "flex", gap: 3 }}>
                    {(["teach", "executed", "command"] as const).map(src => (
                      <button key={src} onClick={() => setJointSource(src)}
                        style={{ ...styles.tabBtn, background: jointSource === src ? "#334155" : "#f1f5f9", color: jointSource === src ? "#fff" : "#374151" }}>
                        {src}
                      </button>
                    ))}
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" as const, marginBottom: 4 }}>
                  {JOINT_LABELS.map((lbl, i) => (
                    <span key={lbl} style={{ display: "flex", alignItems: "center", gap: 3, fontSize: 10, color: "#374151" }}>
                      <span style={{ width: 14, height: 2.5, background: JOINT_COLORS[i], borderRadius: 1, display: "inline-block" }} />
                      {lbl}
                    </span>
                  ))}
                  <span style={{ fontSize: 10, color: "#22c55e" }}>▲ open</span>
                  <span style={{ fontSize: 10, color: "#ef4444" }}>▲ close</span>
                </div>
                {jointsLoading ? (
                  <div style={plotStyles.empty}>Loading…</div>
                ) : jointsData ? (
                  <JointPlot data={jointsData} source={jointSource} />
                ) : (
                  <div style={plotStyles.empty}>No joint data</div>
                )}
              </div>
            </div>

            {/* Postprocess panel — above trajectory so video is visible while editing */}
            {editMeta !== null && (
              <EditPanel
                editMeta={editMeta}
                autoGripperOpenT={autoGripperOpenT}
                episodeId={selectedId!}
                take={selectedTake!}
                currentTime={currentTime}
                duration={videoDuration}
                onSave={meta => {
                  saveEditMeta(meta);
                  // update has_postprocess flag locally
                  const hasAny = meta.trim.enabled || meta.mask.enabled;
                  setEpisodes(prev => prev.map(e =>
                    e.episode_id === selectedId ? { ...e, has_postprocess: hasAny } : e
                  ));
                  setSelected(prev => prev?.episode_id === selectedId
                    ? { ...prev, has_postprocess: hasAny } : prev);
                }}
              />
            )}

            {/* Trajectory views */}
            {(trajectoryData || trajLoading) && (
              <div style={{ marginTop: 14 }}>
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                  <div style={styles.sectionLabel}>Trajectory</div>
                  {trajectoryData && (
                    <span style={{ fontSize: 10, color: "#94a3b8" }}>
                      {trajectoryData[jointSource].length} pts · scrub video to move cursor
                    </span>
                  )}
                </div>
                {trajLoading ? (
                  <div style={plotStyles.empty}>Computing FK…</div>
                ) : trajectoryData && (
                  <div style={styles.trajGrid}>
                    <div style={styles.mediaCell}>
                      <div style={styles.sectionLabel}>Plan View (XY)</div>
                      <TrajectoryPlanView
                        samples={trajectoryData[jointSource]}
                        currentTime={currentTime}
                      />
                    </div>
                    <div style={styles.mediaCell}>
                      <div style={styles.sectionLabel}>Side View (reach-Z)</div>
                      <TrajectorySideView
                        samples={trajectoryData[jointSource]}
                        currentTime={currentTime}
                      />
                    </div>
                  </div>
                )}
              </div>
            )}

          </div>
        ) : (
          <div style={styles.noSelection}>Select an episode to view details</div>
        )}
      </div>
    </div>
  );
}

// ── EditPanel ─────────────────────────────────────────────────────────────

function EditPanel({
  editMeta, autoGripperOpenT, episodeId, take, currentTime, duration, onSave,
}: {
  editMeta: EditMeta;
  autoGripperOpenT: number | null;
  episodeId: string;
  take: string;
  currentTime: number;
  duration?: number;
  onSave: (m: EditMeta) => void;
}) {
  const [open, setOpen] = React.useState(false);
  const [trim, setTrim] = React.useState(editMeta.trim);
  const [mask, setMask] = React.useState(editMeta.mask);
  const [dirty, setDirty] = React.useState(false);

  // editMeta prop이 바뀌면(take 전환) 로컬 상태 동기화
  React.useEffect(() => { setTrim(editMeta.trim); setMask(editMeta.mask); setDirty(false); }, [editMeta]);

  const effectiveCutT = trim.cut_t ?? autoGripperOpenT;
  const trimEnd = effectiveCutT !== null ? effectiveCutT + trim.margin : null;

  const save = () => { onSave({ trim, mask }); setDirty(false); };

  return (
    <div style={{ marginTop: 16, border: "1px solid #e2e8f0", borderRadius: 8, overflow: "hidden" }}>
      {/* 헤더 */}
      <button
        onClick={() => setOpen(v => !v)}
        style={{ width: "100%", display: "flex", alignItems: "center", justifyContent: "space-between",
          padding: "8px 12px", background: "#f8fafc", border: "none", cursor: "pointer",
          fontSize: 12, fontWeight: 700, color: "#475569" }}
      >
        <span>✂ Export 편집 옵션</span>
        <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {trim.enabled && <span style={{ background: "#dbeafe", color: "#1d4ed8", borderRadius: 4, padding: "1px 6px" }}>Trim ON</span>}
          {mask.enabled && <span style={{ background: "#d1fae5", color: "#065f46", borderRadius: 4, padding: "1px 6px" }}>Mask ON</span>}
          {dirty && <span style={{ color: "#ef4444", fontSize: 10 }}>●</span>}
          <span>{open ? "▲" : "▼"}</span>
        </span>
      </button>

      {open && (
        <div style={{ padding: "12px 14px", background: "#fff" }}>
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

                {/* margin 슬라이더 */}
                <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                  <span style={{ fontSize: 12, color: "#64748b", flexShrink: 0 }}>여유 마진:</span>
                  <input type="range" min={0} max={3} step={0.1}
                    value={trim.margin}
                    onChange={e => { setTrim(p => ({ ...p, margin: parseFloat(e.target.value) })); setDirty(true); }}
                    style={{ flex: 1, accentColor: "#6366f1" }} />
                  <span style={{ fontSize: 12, fontWeight: 700, color: "#6366f1", minWidth: 32 }}>{trim.margin.toFixed(1)}s</span>
                </div>

                {/* 최종 trim 시각 표시 */}
                {(() => {
                  const overDuration = trimEnd !== null && duration !== undefined && trimEnd > duration;
                  return (
                    <div style={{ fontSize: 12, borderRadius: 5, padding: "4px 8px", marginBottom: 6,
                      background: overDuration ? "#fff7ed" : "#eef2ff",
                      border: overDuration ? "1px solid #fed7aa" : "none" }}>
                      <div>
                        최종 컷: {trimEnd !== null
                          ? <strong style={{ color: overDuration ? "#c2410c" : "#1d4ed8" }}>{trimEnd.toFixed(2)}s</strong>
                          : "—"}
                        {effectiveCutT !== null && (
                          <span style={{ color: "#94a3b8" }}> ({effectiveCutT.toFixed(2)} + {trim.margin.toFixed(1)}s)</span>
                        )}
                      </div>
                      {duration !== undefined && (
                        <div style={{ marginTop: 2, color: overDuration ? "#c2410c" : "#94a3b8" }}>
                          {overDuration
                            ? `⚠ 영상 길이 ${duration.toFixed(1)}s 초과 → trim 효과 없음`
                            : `영상 길이: ${duration.toFixed(1)}s`}
                        </div>
                      )}
                    </div>
                  );
                })()}

                {/* 컷 지점 webcam_1 프레임 미리보기 (joint 시간 기준) */}
                {trimEnd !== null && (
                  <div>
                    <div style={{ fontSize: 11, color: "#64748b", marginBottom: 4 }}>
                      컷 지점 프레임 (joint t={trimEnd.toFixed(2)}s):
                    </div>
                    <Webcam1Frame episodeId={episodeId} take={take} tSec={trimEnd} tBase="video" />
                  </div>
                )}
              </>
            )}
          </div>

          {/* ── Mask Editor ── */}
          <div style={{ minWidth: 0 }}>
            <div style={{ fontSize: 11, fontWeight: 700, color: "#64748b", textTransform: "uppercase" as const, letterSpacing: 0.7, marginBottom: 8 }}>
              Mask (cam_webcam_1 keep 영역)
            </div>

            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 13, marginBottom: 8, cursor: "pointer" }}>
              <input type="checkbox" checked={mask.enabled}
                onChange={e => { setMask(p => ({ ...p, enabled: e.target.checked })); setDirty(true); }} />
              mask 활성화
            </label>

            {mask.enabled && (
              <MaskPolygonEditor
                episodeId={episodeId}
                take={take}
                currentTime={currentTime}
                mask={mask}
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
      )}
    </div>
  );
}

// ── Shared webcam_1 frame preview ────────────────────────────────────────

function Webcam1Frame({
  episodeId, take, tSec, tBase = "video", style,
}: { episodeId: string; take: string; tSec: number; tBase?: "video" | "camera"; style?: React.CSSProperties }) {
  const [url, setUrl] = React.useState("");
  const [loading, setLoading] = React.useState(false);
  const timerRef = React.useRef<ReturnType<typeof setTimeout> | null>(null);

  React.useEffect(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    setLoading(true);  // tSec 변경 즉시 dim → 로딩 중 피드백
    timerRef.current = setTimeout(() => {
      setUrl(`/api/episodes/${episodeId}/takes/${take}/frame_webcam1_at?t=${tSec.toFixed(2)}&ref=${tBase}&_=${Date.now()}`);
    }, 200);
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [episodeId, take, tSec, tBase]);

  if (!url) return null;
  return (
    <img src={url} alt={`webcam_1 @${tSec.toFixed(1)}s`}
      onLoad={() => setLoading(false)}
      onError={() => setLoading(false)}
      style={{ width: "100%", borderRadius: 5, display: "block", background: "#000",
               opacity: loading ? 0.35 : 1, transition: "opacity 0.15s", ...style }} />
  );
}

// ── Mask Polygon Editor ───────────────────────────────────────────────────

function MaskPolygonEditor({
  episodeId, take, currentTime, mask, onMaskChange,
}: {
  episodeId: string;
  take: string;
  currentTime: number;
  mask: MaskMeta;
  onMaskChange: (m: MaskMeta) => void;
}) {
  const polygon = mask.polygon;
  const [showMask, setShowMask] = React.useState(true);
  const [library, setLibrary] = React.useState<MaskLibraryEntry[]>([]);
  const [saveName, setSaveName] = React.useState("");
  const [showLib, setShowLib] = React.useState(false);

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
  const captureFrameUrl = React.useMemo(() => {
    if (mask.fill !== "frame_capture" || mask.capture_t === undefined) return "";
    return `/api/episodes/${episodeId}/takes/${take}/frame_webcam1_at?t=${mask.capture_t.toFixed(2)}&ref=video`;
  }, [episodeId, take, mask.fill, mask.capture_t]);

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
      <div style={{ position: "relative", background: "#000", borderRadius: 6, overflow: "hidden", marginBottom: 8 }}>
        {/* 레이어 1: 현재 프레임 (keep 영역의 실제 비디오) */}
        <Webcam1Frame episodeId={episodeId} take={take} tSec={currentTime}
          style={{ opacity: showMask && mask.fill === "black" ? 0.6 : 1 }} />

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

// ── Export Modal ──────────────────────────────────────────────────────────

function ExportModal({ count, exporting, exportingLerobot, includeFrames, onIncludeFrames, onExportZip, onExportLerobot, onClose }: {
  count: number;
  exporting: boolean;
  exportingLerobot: boolean;
  includeFrames: boolean;
  onIncludeFrames: (v: boolean) => void;
  onExportZip: () => void;
  onExportLerobot: () => void;
  onClose: () => void;
}) {
  return (
    <div style={{ position: "fixed", inset: 0, background: "rgba(0,0,0,0.4)", zIndex: 1000,
      display: "flex", alignItems: "center", justifyContent: "center" }}
      onClick={onClose}>
      <div style={{ background: "#fff", borderRadius: 12, padding: "24px 28px", minWidth: 320,
        boxShadow: "0 20px 40px rgba(0,0,0,0.15)" }}
        onClick={e => e.stopPropagation()}>
        <h3 style={{ margin: "0 0 16px", fontSize: 16, fontWeight: 700, color: "#1e293b" }}>
          Export Dataset
        </h3>
        <div style={{ fontSize: 13, color: "#64748b", marginBottom: 16 }}>
          {count}개 에피소드 선택됨
        </div>

        <label style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 13, color: "#374151", cursor: "pointer", marginBottom: 20 }}>
          <input type="checkbox" checked={includeFrames} onChange={e => onIncludeFrames(e.target.checked)} />
          Raw 프레임 이미지 포함 (용량 큼)
        </label>

        <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
          <button onClick={() => { onExportZip(); onClose(); }} disabled={exporting}
            style={{ padding: "10px 16px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 700,
              background: "#6366f1", color: "#fff", cursor: "pointer", textAlign: "left" }}>
            {exporting ? "압축 중…" : "↓ Basic ZIP (원본 형식)"}
            <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.8, marginTop: 2 }}>CSV + 비디오 + 메타데이터</div>
          </button>
          <button onClick={() => { onExportLerobot(); onClose(); }} disabled={exportingLerobot}
            style={{ padding: "10px 16px", borderRadius: 8, border: "none", fontSize: 13, fontWeight: 700,
              background: "#059669", color: "#fff", cursor: "pointer", textAlign: "left" }}>
            {exportingLerobot ? "변환 중…" : "↓ LeRobot v2.0 ZIP"}
            <div style={{ fontSize: 10, fontWeight: 400, opacity: 0.8, marginTop: 2 }}>224×224 @ 15fps · parquet · postprocess 적용</div>
          </button>
        </div>

        <button onClick={onClose}
          style={{ marginTop: 16, width: "100%", padding: "8px", borderRadius: 8, border: "1px solid #e5e7eb",
            background: "#fff", fontSize: 12, color: "#64748b", cursor: "pointer" }}>
          취소
        </button>
      </div>
    </div>
  );
}

function StatusBadge({ success }: { success: boolean | null | undefined }) {
  if (success === null || success === undefined)
    return <span style={{ ...styles.badge, background: "#f1f5f9", color: "#6b7280" }}>?</span>;
  if (success)
    return <span style={{ ...styles.badge, background: "#dcfce7", color: "#15803d" }}>✓</span>;
  return <span style={{ ...styles.badge, background: "#fee2e2", color: "#dc2626" }}>✗</span>;
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
  body: { display: "flex", flex: 1, gap: 16, minHeight: 0, overflow: "hidden" },
  listPanel: {
    width: 300, flexShrink: 0, overflowY: "auto",
    display: "flex", flexDirection: "column", gap: 6,
  },
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
  trajGrid: {
    display: "grid",
    gridTemplateColumns: "1fr 1fr",
    gap: 14,
    alignItems: "start",
  },
  mediaCell: {
    minWidth: 0,
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
