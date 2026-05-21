"""
Piper 데이터셋 → LeRobot v2.0 형식 변환기
- teach_joint.csv → observation.state, action (7-dim: q1-q6, gripper)
- webcam_0 / webcam_1 영상 → 224×224 @ 15fps (imageio_ffmpeg 사용)
- 15fps 그리드에 맞게 joint 데이터 선형 보간
- 트리밍 규칙: 10초 이후 첫 gripper open 전환 감지 후 +1초에서 끊음
"""

import csv
import json
import os
import subprocess

import numpy as np
import pandas as pd

TARGET_FPS = 15
IMG_SIZE = 224
CODEBASE_VERSION = "v2.0"
ROBOT_TYPE = "piper"
CAM_KEYS = ["observation.images.cam_webcam_0", "observation.images.cam_webcam_1"]
CAM_FILES = ["video_webcam_0.mp4", "video_webcam_1.mp4"]

# gripper open/closed 판정 임계값 (piper_node.py 와 동일)
GRIPPER_MID = 0.02219
# 이 시간(초) 이후에 발생한 gripper open 전환만 인식
RELEASE_SEARCH_START = 10.0
# gripper open 전환 이후 추가로 포함할 시간(초)
RELEASE_TAIL = 1.0


def _get_ffmpeg():
    from imageio_ffmpeg import get_ffmpeg_exe
    return get_ffmpeg_exe()


def _resample_joints(csv_path: str, target_fps: int = TARGET_FPS) -> list[dict]:
    """teach_joint.csv를 읽어 target_fps 그리드로 선형 보간."""
    if not os.path.exists(csv_path):
        return []
    with open(csv_path) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return []

    t0 = int(float(rows[0]["t_host_ns"]))
    t_arr = np.array([(int(float(r["t_host_ns"])) - t0) / 1e9 for r in rows])
    q_arr = np.array(
        [[float(r[f"q{i}"]) for i in range(1, 7)] + [float(r["gripper"])] for r in rows]
    )

    t_end = t_arr[-1]
    t_grid = np.arange(0, t_end + 1 / target_fps / 2, 1 / target_fps)
    t_grid = t_grid[t_grid <= t_end + 1e-6]

    q_grid = np.stack(
        [np.interp(t_grid, t_arr, q_arr[:, i]) for i in range(7)], axis=1
    )
    return [{"t": float(t), "q": q.tolist()} for t, q in zip(t_grid, q_grid)]


def _find_trim_gripper_open_t(samples: list[dict]) -> float | None:
    """10초 이후 첫 gripper closed→open 전환 시각만 반환 (마진 미포함)."""
    prev_open: bool | None = None
    for s in samples:
        t = s["t"]
        is_open = s["q"][6] > GRIPPER_MID
        if prev_open is not None and t > RELEASE_SEARCH_START:
            if not prev_open and is_open:
                return t
        prev_open = is_open
    return None


def _find_trim_time(samples: list[dict]) -> float | None:
    """10초 이후 첫 gripper OPEN 전환 시각 + RELEASE_TAIL(1초) 반환."""
    t = _find_trim_gripper_open_t(samples)
    return t + RELEASE_TAIL if t is not None else None


def _trim_samples(samples: list[dict], cut_t: float | None) -> list[dict]:
    """cut_t(초) 이후 프레임을 제거. cut_t=None이면 원본 반환."""
    if cut_t is None:
        return samples
    return [s for s in samples if s["t"] <= cut_t + 1e-6]


def _find_webcam1_frame(take_dir: str, t_sec: float) -> str | None:
    """t_sec에 가장 가까운 webcam_1 프레임 파일 경로 반환."""
    csv_path = os.path.join(take_dir, "camera_frames_webcam_1.csv")
    if not os.path.exists(csv_path):
        return None
    with open(csv_path) as f:
        rows = list(csv.DictReader(f))
    if not rows:
        return None
    t0 = int(float(rows[0]["t_host_ns"]))
    t_target = t0 + int(t_sec * 1e9)
    best = min(rows, key=lambda r: abs(int(float(r["t_host_ns"])) - t_target))
    frame_idx = int(best["frame_idx"])
    frames_dir = os.path.join(take_dir, "frames_webcam_1")
    for ext in ("jpg", "png"):
        path = os.path.join(frames_dir, f"color_{frame_idx:06d}.{ext}")
        if os.path.exists(path):
            return path
    return None


def _make_mask_overlay(polygon_norm: list, size: int = IMG_SIZE) -> str | None:
    """
    polygon_norm: [[x_norm, y_norm], ...] normalized 0-1 좌표 (keep 영역)
    keep 영역 안은 투명, 밖은 검정 불투명인 PNG 파일 경로를 반환.
    polygon이 비어있으면 None 반환.
    """
    if not polygon_norm or len(polygon_norm) < 3:
        return None
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    import tempfile
    # 검정 불투명 (mask-out) 배경
    img = Image.new("RGBA", (size, size), (0, 0, 0, 255))
    draw = ImageDraw.Draw(img)
    # keep 영역만 투명으로
    pts = [(int(x * size), int(y * size)) for x, y in polygon_norm]
    draw.polygon(pts, fill=(0, 0, 0, 0))
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    img.save(tmp.name)
    tmp.close()
    return tmp.name


def _make_frame_capture_overlay(polygon_norm: list, frame_path: str, size: int = IMG_SIZE) -> str | None:
    """
    프레임 캡쳐 마스크: keep 영역(polygon 내부) = 투명, 외부 = 캡쳐 프레임 픽셀(불투명)
    ffmpeg overlay 시 keep 영역은 원본 비디오가, 외부는 고정 프레임이 보임.
    """
    if not polygon_norm or len(polygon_norm) < 3:
        return None
    try:
        from PIL import Image, ImageDraw
    except ImportError:
        return None
    import tempfile
    img = Image.open(frame_path).convert("RGBA").resize((size, size), Image.LANCZOS)
    # inside polygon → transparent (alpha=0), outside keeps frame pixels (alpha=255)
    alpha = Image.new("L", (size, size), 255)  # start fully opaque
    draw = ImageDraw.Draw(alpha)
    pts = [(int(x * size), int(y * size)) for x, y in polygon_norm]
    draw.polygon(pts, fill=0)  # inside = transparent
    img.putalpha(alpha)
    tmp = tempfile.NamedTemporaryFile(suffix=".png", delete=False)
    img.save(tmp.name)
    tmp.close()
    return tmp.name


def _encode_video(
    src_path: str,
    dst_path: str,
    target_fps: int = TARGET_FPS,
    size: int = IMG_SIZE,
    max_duration: float | None = None,
    mask_overlay: str | None = None,
):
    """imageio_ffmpeg bundled binary で src → size×size @ target_fps h264 mp4.
    max_duration이 주어지면 그 길이(초)까지만 인코딩.
    mask_overlay가 주어지면 해당 PNG를 오버레이(mask-out 영역 검정 처리).
    """
    ffmpeg = _get_ffmpeg()
    os.makedirs(os.path.dirname(dst_path), exist_ok=True)
    cmd = [ffmpeg, "-y", "-i", src_path]
    if mask_overlay:
        cmd += ["-i", mask_overlay]
    if max_duration is not None:
        cmd += ["-t", str(max_duration)]
    if mask_overlay:
        cmd += [
            "-filter_complex",
            f"[0:v]fps={target_fps},scale={size}:{size}[v];[1:v]scale={size}:{size}[m];[v][m]overlay=0:0[out]",
            "-map", "[out]",
        ]
    else:
        cmd += ["-vf", f"fps={target_fps},scale={size}:{size}"]
    cmd += ["-c:v", "libx264", "-pix_fmt", "yuv420p", "-preset", "fast", "-crf", "23", dst_path]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"ffmpeg failed:\n{result.stderr[-1000:]}")


def _get_latest_take_dir(ep_dir: str) -> str | None:
    """에피소드 디렉터리에서 가장 마지막 take 디렉터리 반환."""
    takes_dir = os.path.join(ep_dir, "takes")
    if not os.path.isdir(takes_dir):
        return None
    takes = sorted(
        [d for d in os.listdir(takes_dir) if os.path.isdir(os.path.join(takes_dir, d))]
    )
    if not takes:
        return None
    return os.path.join(takes_dir, takes[-1])


def convert_episodes(episode_ids: list[str], dataset_path: str, out_dir: str) -> None:
    """
    선택된 episode_ids를 LeRobot v2.0 형식으로 out_dir에 변환 저장.
    각 episode의 마지막 take를 LeRobot 에피소드 1개로 매핑.
    """
    os.makedirs(out_dir, exist_ok=True)

    # ── 1. 태스크 목록 수집 ──────────────────────────────────────────────
    task_to_idx: dict[str, int] = {}
    ep_tasks: list[str] = []

    for ep_id in episode_ids:
        meta_path = os.path.join(dataset_path, ep_id, "meta.json")
        task = "unknown"
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            raw = meta.get("task", {})
            if isinstance(raw, dict):
                task = raw.get("instruction") or raw.get("text") or "unknown"
            elif isinstance(raw, str):
                task = raw or "unknown"
        except (OSError, json.JSONDecodeError):
            pass
        ep_tasks.append(task)
        if task not in task_to_idx:
            task_to_idx[task] = len(task_to_idx)

    # ── 2. 에피소드별 변환 ───────────────────────────────────────────────
    global_frame_idx = 0
    episodes_meta: list[dict] = []
    all_states: list[list[float]] = []
    all_actions: list[list[float]] = []

    data_dir = os.path.join(out_dir, "data", "chunk-000")
    os.makedirs(data_dir, exist_ok=True)

    for ep_idx, (ep_id, task) in enumerate(zip(episode_ids, ep_tasks)):
        ep_dir = os.path.join(dataset_path, ep_id)
        take_dir = _get_latest_take_dir(ep_dir)
        if take_dir is None:
            continue

        # Joint 데이터 보간
        raw_samples = _resample_joints(os.path.join(take_dir, "teach_joint.csv"))
        if not raw_samples:
            continue

        # ── edit_meta 로드 ────────────────────────────────────────────────
        edit_meta_path = os.path.join(take_dir, "edit_meta.json")
        edit_meta: dict = {}
        if os.path.exists(edit_meta_path):
            with open(edit_meta_path) as f:
                edit_meta = json.load(f)

        # ── 트리밍 ────────────────────────────────────────────────────────
        trim_cfg = edit_meta.get("trim", {})
        if trim_cfg.get("enabled"):
            # 사용자가 설정한 cut_t (없으면 자동 감지)
            manual_cut_t = trim_cfg.get("cut_t")
            if manual_cut_t is not None:
                base_t = float(manual_cut_t)
            else:
                base_t = _find_trim_gripper_open_t(raw_samples) or raw_samples[-1]["t"]
            margin = float(trim_cfg.get("margin", 1.0))
            video_duration: float | None = base_t + margin
        else:
            # 기본 자동 트리밍 (converter 상수 기반)
            auto_cut = _find_trim_time(raw_samples)
            video_duration = auto_cut

        samples = _trim_samples(raw_samples, video_duration)

        # ── 마스크 ────────────────────────────────────────────────────────
        mask_cfg = edit_meta.get("mask", {})
        mask_overlay_path: str | None = None
        if mask_cfg.get("enabled") and mask_cfg.get("polygon"):
            fill = mask_cfg.get("fill", "black")
            if fill == "frame_capture":
                capture_t = float(mask_cfg.get("capture_t", 0))
                frame_path = _find_webcam1_frame(take_dir, capture_t)
                if frame_path:
                    mask_overlay_path = _make_frame_capture_overlay(mask_cfg["polygon"], frame_path)
            else:  # "black" or default
                mask_overlay_path = _make_mask_overlay(mask_cfg["polygon"])

        n_frames = len(samples)
        task_idx = task_to_idx[task]

        # Parquet 행 구성
        rows = []
        for fi, s in enumerate(samples):
            q = s["q"]
            rows.append({
                "index":             global_frame_idx + fi,
                "episode_index":     ep_idx,
                "frame_index":       fi,
                "timestamp":         float(s["t"]),
                "observation.state": q,
                "action":            q,
                "next.done":         fi == n_frames - 1,
                "task_index":        task_idx,
            })
            all_states.append(q)
            all_actions.append(q)

        df = pd.DataFrame(rows)
        parquet_path = os.path.join(data_dir, f"episode_{ep_idx:06d}.parquet")
        df.to_parquet(parquet_path, index=False)

        # 비디오 변환 — 트림 + 마스크 적용
        for cam_key, cam_file in zip(CAM_KEYS, CAM_FILES):
            src = os.path.join(take_dir, cam_file)
            if not os.path.exists(src):
                continue
            dst = os.path.join(
                out_dir, "videos", "chunk-000", cam_key,
                f"episode_{ep_idx:06d}.mp4",
            )
            # cam_webcam_1 (두 번째 캠)에만 마스크 적용
            apply_mask = mask_overlay_path if cam_key == CAM_KEYS[1] else None
            _encode_video(src, dst, max_duration=video_duration, mask_overlay=apply_mask)

        # 임시 마스크 PNG 정리
        if mask_overlay_path and os.path.exists(mask_overlay_path):
            os.unlink(mask_overlay_path)

        episodes_meta.append({
            "episode_index": ep_idx,
            "tasks":         [task],
            "length":        n_frames,
        })
        global_frame_idx += n_frames

    # ── 3. 통계 계산 ─────────────────────────────────────────────────────
    def _stats(arr: list[list[float]]) -> dict:
        a = np.array(arr, dtype=np.float32)
        return {
            "mean": a.mean(axis=0).tolist(),
            "std":  a.std(axis=0).tolist(),
            "min":  a.min(axis=0).tolist(),
            "max":  a.max(axis=0).tolist(),
        }

    joint_names = ["q1", "q2", "q3", "q4", "q5", "q6", "gripper"]
    stats_data: dict[str, dict] = {}
    if all_states:
        stats_data["observation.state"] = _stats(all_states)
        stats_data["action"] = _stats(all_actions)

    # ── 4. 메타 파일 작성 ────────────────────────────────────────────────
    meta_dir = os.path.join(out_dir, "meta")
    os.makedirs(meta_dir, exist_ok=True)
    total_eps = len(episodes_meta)
    total_frames = global_frame_idx

    cam_feature = {
        "dtype": "video",
        "shape": [IMG_SIZE, IMG_SIZE, 3],
        "names": ["height", "width", "channel"],
        "info": {
            "video.fps": TARGET_FPS,
            "video.codec": "av1",
            "video.pix_fmt": "yuv420p",
            "video.is_depth_map": False,
            "has_audio": False,
        },
    }
    info = {
        "codebase_version": CODEBASE_VERSION,
        "robot_type": ROBOT_TYPE,
        "fps": TARGET_FPS,
        "features": {
            "observation.state": {"dtype": "float32", "shape": [7], "names": joint_names},
            "action":            {"dtype": "float32", "shape": [7], "names": joint_names},
            CAM_KEYS[0]:         cam_feature,
            CAM_KEYS[1]:         cam_feature,
        },
        "splits":          {"train": f"0:{total_eps}"},
        "total_episodes":  total_eps,
        "total_frames":    total_frames,
        "total_tasks":     len(task_to_idx),
        "total_chunks":    1,
        "chunks_size":     1000,
        "data_path":       "data/chunk-{chunk_index:03d}/episode_{episode_index:06d}.parquet",
        "video_path":      "videos/chunk-{chunk_index:03d}/{video_key}/episode_{episode_index:06d}.mp4",
    }

    with open(os.path.join(meta_dir, "info.json"), "w") as f:
        json.dump(info, f, indent=2)

    with open(os.path.join(meta_dir, "stats.json"), "w") as f:
        json.dump(stats_data, f, indent=2)

    with open(os.path.join(meta_dir, "tasks.jsonl"), "w") as f:
        for task, idx in sorted(task_to_idx.items(), key=lambda x: x[1]):
            f.write(json.dumps({"task_index": idx, "task": task}) + "\n")

    with open(os.path.join(meta_dir, "episodes.jsonl"), "w") as f:
        for ep_meta in episodes_meta:
            f.write(json.dumps(ep_meta) + "\n")
