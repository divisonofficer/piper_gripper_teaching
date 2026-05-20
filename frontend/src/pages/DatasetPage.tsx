import React, { useState, useEffect, useCallback, useMemo, useRef } from "react";
import type { Episode, EpisodeTake, JointSample, TakeJointsData, EESample, TakeTrajectoryData } from "../types";

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
  const videoRef = useRef<HTMLVideoElement>(null);
  const [filter, setFilter] = useState<"all" | "success" | "failure" | "unlabeled">("all");
  const [search, setSearch] = useState("");
  const [confirmDeleteEp, setConfirmDeleteEp] = useState<string | null>(null);
  const [confirmDeleteTake, setConfirmDeleteTake] = useState<string | null>(null);
  const [editingTask, setEditingTask] = useState(false);
  const [taskDraft, setTaskDraft] = useState("");

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
            {filtered.length}/{episodes.length} episodes · {totalTakes} takes · {fmtMb(totalSize)}
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
          <button style={styles.refreshBtn} onClick={fetchEpisodes}>↻</button>
        </div>
      </div>

      {/* Body */}
      <div style={styles.body}>
        {/* Episode list */}
        <div style={styles.listPanel}>
          {filtered.length === 0 && (
            <div style={styles.empty}>
              {search || filter !== "all" ? "No matches." : "No episodes yet."}
            </div>
          )}
          {filtered.map(ep => (
            <div key={ep.episode_id}
              style={{ ...styles.epRow, background: selected?.episode_id === ep.episode_id ? "#eef2ff" : "#fff" }}
              onClick={() => { setSelected(ep); setConfirmDeleteEp(null); }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={styles.epId}>{ep.episode_id.slice(-20)}</div>
                <div style={styles.epTask}>{ep.task || "—"}</div>
                <div style={styles.epMeta}>
                  <StatusBadge success={ep.success} />
                  <span style={styles.metaText}>{ep.takes_count ?? 0}t</span>
                  <span style={styles.metaText}>{fmtMb(ep.size_mb)}</span>
                  <span style={styles.metaText}>{ep.created_at?.slice(5, 16).replace("T", " ")}</span>
                </div>
              </div>
              <div style={{ flexShrink: 0 }}>
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
            </div>
          ))}
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
    display: "flex", alignItems: "center", gap: 10,
    padding: "9px 11px", borderRadius: 8, border: "1px solid #e5e7eb",
    cursor: "pointer",
  },
  epId: { fontFamily: "monospace", fontSize: 11, color: "#6366f1", fontWeight: 700 },
  epTask: {
    fontSize: 12, color: "#374151", marginTop: 1,
    overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap",
  },
  epMeta: { display: "flex", alignItems: "center", gap: 8, marginTop: 3 },
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
};
