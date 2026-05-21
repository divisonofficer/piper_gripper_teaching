"""
Episode 관리 API
  GET    /api/episodes
  GET    /api/episodes/<episode_id>
  POST   /api/episodes/save     body: {"success": true, "reason": ""}
  POST   /api/episodes/discard
  POST   /api/episodes/retake_replay
  POST   /api/episodes/retake_teach
  POST   /api/episodes/add_take   (SAVED 상태에서 이어서 촬영)
  POST   /api/episodes/new
  DELETE /api/episodes/<episode_id>
  DELETE /api/episodes/<episode_id>/takes/<take>
  GET    /api/episodes/<episode_id>/video              ← 최신 take의 video.mp4
  GET    /api/episodes/<episode_id>/video_depth        ← 최신 take의 video_depth.mp4
  GET    /api/episodes/<episode_id>/takes/<take>/video
  GET    /api/episodes/<episode_id>/takes/<take>/video_depth
  GET    /api/episodes/<episode_id>/takes/<take>/joints      ← joint CSV data (teach/executed/command)
  GET    /api/episodes/<episode_id>/takes/<take>/trajectory  ← FK trajectory (ee + link positions)
  GET    /api/episodes/<episode_id>/frame/<frame_idx>        ← 최신 take의 frame
"""

import csv as csv_module
import json
import os
from typing import Optional

from flask import Blueprint, current_app, jsonify, request, send_file, abort

bp = Blueprint("episodes", __name__, url_prefix="/api/episodes")


def _ctrl():
    return current_app.config["CONTROLLER"]


def _mgr():
    return _ctrl()._episode


def _take_dir(episode_id: str, take: Optional[str] = None) -> Optional[str]:
    """take 디렉터리 반환. take=None이면 최신 take."""
    mgr = _mgr()
    if take:
        from config import DATASET_PATH
        d = os.path.join(DATASET_PATH, episode_id, "takes", take)
        return d if os.path.isdir(d) else None
    return mgr.get_latest_take_dir(episode_id)


@bp.get("")
def list_episodes():
    from config import DATASET_PATH
    episodes = _mgr().list_episodes()
    # 각 에피소드의 마지막 take edit_meta.json 확인 → has_postprocess 플래그
    for ep in episodes:
        ep_id = ep.get("episode_id", "")
        takes_dir = os.path.join(DATASET_PATH, ep_id, "takes")
        has_pp = False
        if os.path.isdir(takes_dir):
            take_names = sorted(d for d in os.listdir(takes_dir)
                                if os.path.isdir(os.path.join(takes_dir, d)))
            if take_names:
                em_path = os.path.join(takes_dir, take_names[-1], "edit_meta.json")
                if os.path.exists(em_path):
                    try:
                        with open(em_path) as f:
                            em = json.load(f)
                        has_pp = bool(em.get("trim", {}).get("enabled")) or bool(em.get("mask", {}).get("enabled"))
                    except (OSError, json.JSONDecodeError):
                        pass
        ep["has_postprocess"] = has_pp
    return jsonify(episodes)


@bp.get("/<episode_id>")
def get_episode(episode_id: str):
    meta = _mgr().get_episode_meta(episode_id)
    if meta is None:
        return abort(404)
    return jsonify(meta)


@bp.post("/save")
def save_episode():
    data = request.get_json(silent=True) or {}
    success = bool(data.get("success", True))
    reason = str(data.get("reason", ""))
    return jsonify(_ctrl().save_episode(success=success, reason=reason))


@bp.post("/discard")
def discard_episode():
    return jsonify(_ctrl().discard_episode())


@bp.post("/retake_replay")
def retake_replay():
    return jsonify(_ctrl().retake_replay())


@bp.post("/retake_teach")
def retake_teach():
    return jsonify(_ctrl().retake_teach())


@bp.post("/add_take")
def add_take():
    """SAVED 상태에서 같은 episode에 새 take 추가 (이어서 촬영)."""
    return jsonify(_ctrl().add_take_to_episode())


@bp.post("/new")
def new_episode():
    return jsonify(_ctrl().new_episode())


@bp.patch("/<episode_id>")
def update_episode(episode_id: str):
    data = request.get_json(silent=True) or {}
    ok = _mgr().update_episode_task(episode_id, str(data.get("task", "")))
    if not ok:
        return abort(404)
    return jsonify({"ok": True})


@bp.delete("/<episode_id>")
def delete_episode(episode_id: str):
    ok = _mgr().delete_episode(episode_id)
    if not ok:
        return abort(404)
    return jsonify({"ok": True})


@bp.delete("/<episode_id>/takes/<take>")
def delete_take(episode_id: str, take: str):
    ok = _mgr().delete_take(episode_id, take)
    if not ok:
        return abort(404)
    return jsonify({"ok": True})


# ── Video serving ──────────────────────────────────────────────────────

@bp.get("/<episode_id>/video")
def get_video(episode_id: str):
    td = _take_dir(episode_id)
    if not td:
        return abort(404)
    path = os.path.join(td, "video.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/video_depth")
def get_video_depth(episode_id: str):
    td = _take_dir(episode_id)
    if not td:
        return abort(404)
    path = os.path.join(td, "video_depth.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/video_webcam_0")
def get_video_webcam0(episode_id: str):
    td = _take_dir(episode_id)
    if not td:
        return abort(404)
    path = os.path.join(td, "video_webcam_0.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/video_webcam_1")
def get_video_webcam1(episode_id: str):
    td = _take_dir(episode_id)
    if not td:
        return abort(404)
    path = os.path.join(td, "video_webcam_1.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/takes/<take>/video")
def get_take_video(episode_id: str, take: str):
    td = _take_dir(episode_id, take)
    if not td:
        return abort(404)
    path = os.path.join(td, "video.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/takes/<take>/video_depth")
def get_take_video_depth(episode_id: str, take: str):
    td = _take_dir(episode_id, take)
    if not td:
        return abort(404)
    path = os.path.join(td, "video_depth.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/takes/<take>/video_webcam_0")
def get_take_video_webcam0(episode_id: str, take: str):
    td = _take_dir(episode_id, take)
    if not td:
        return abort(404)
    path = os.path.join(td, "video_webcam_0.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/takes/<take>/video_webcam_1")
def get_take_video_webcam1(episode_id: str, take: str):
    td = _take_dir(episode_id, take)
    if not td:
        return abort(404)
    path = os.path.join(td, "video_webcam_1.mp4")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="video/mp4")


@bp.get("/<episode_id>/frame/<int:frame_idx>")
def get_frame(episode_id: str, frame_idx: int):
    td = _take_dir(episode_id)
    if not td:
        return abort(404)
    path = os.path.join(td, "frames", f"color_{frame_idx:06d}.png")
    if not os.path.exists(path):
        return abort(404)
    return send_file(path, mimetype="image/png")


@bp.get("/<episode_id>/takes/<take>/joints")
def get_take_joints(episode_id: str, take: str):
    from config import DATASET_PATH
    td = os.path.join(DATASET_PATH, episode_id, "takes", take)
    if not os.path.isdir(td):
        return abort(404)

    def read_joint_csv(fname: str) -> list[dict]:
        path = os.path.join(td, fname)
        if not os.path.exists(path):
            return []
        samples = []
        t_offset = None
        with open(path) as f:
            reader = csv_module.DictReader(f)
            for row in reader:
                try:
                    t_ns = int(float(row["t_host_ns"]))
                    if t_offset is None:
                        t_offset = t_ns
                    samples.append({
                        "t": (t_ns - t_offset) / 1e9,
                        "q": [float(row[f"q{i}"]) for i in range(1, 7)],
                        "gripper": float(row.get("gripper", 0)),
                    })
                except (KeyError, ValueError):
                    continue
        return samples

    return jsonify({
        "teach": read_joint_csv("teach_joint.csv"),
        "executed": read_joint_csv("executed_joint.csv"),
        "command": read_joint_csv("replay_command.csv"),
    })


@bp.post("/export")
def export_episodes():
    from config import DATASET_PATH
    import io, zipfile

    data = request.get_json(silent=True) or {}
    episode_ids: list[str] = data.get("episode_ids", [])
    include_frames: bool = bool(data.get("include_frames", False))

    if not episode_ids:
        return abort(400)

    from datetime import datetime, timezone

    readme = _build_readme(episode_ids, include_frames)

    buf = io.BytesIO()
    with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
        zf.writestr("README.txt", readme)
        for ep_id in episode_ids:
            ep_dir = os.path.join(DATASET_PATH, ep_id)
            if not os.path.isdir(ep_dir):
                continue
            for root, dirs, files in os.walk(ep_dir):
                if not include_frames:
                    # Skip frame image directories (frames/, frames_webcam_0/, etc.)
                    dirs[:] = [d for d in dirs if not d.startswith("frames")]
                for fname in files:
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, os.path.dirname(ep_dir))
                    try:
                        zf.write(fpath, arcname)
                    except OSError:
                        pass

    buf.seek(0)
    name = f"piper_dataset_{len(episode_ids)}ep.zip"
    return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=name)


@bp.post("/export_lerobot")
def export_lerobot():
    """선택 에피소드를 LeRobot v2.0 형식 ZIP으로 변환·제공."""
    import io, zipfile, tempfile
    from converters.lerobot_converter import convert_episodes
    from config import DATASET_PATH

    data = request.get_json(silent=True) or {}
    episode_ids: list[str] = data.get("episode_ids", [])
    if not episode_ids:
        return abort(400)

    with tempfile.TemporaryDirectory() as tmp:
        out_dir = os.path.join(tmp, "lerobot")
        convert_episodes(episode_ids, DATASET_PATH, out_dir)

        buf = io.BytesIO()
        with zipfile.ZipFile(buf, "w", zipfile.ZIP_DEFLATED, allowZip64=True) as zf:
            for root, _, files in os.walk(out_dir):
                for fname in files:
                    fpath = os.path.join(root, fname)
                    arcname = os.path.relpath(fpath, tmp)
                    try:
                        zf.write(fpath, arcname)
                    except OSError:
                        pass
        buf.seek(0)
        name = f"piper_lerobot_{len(episode_ids)}ep.zip"
        return send_file(buf, mimetype="application/zip", as_attachment=True, download_name=name)


def _build_readme(episode_ids: list[str], include_frames: bool) -> str:
    from datetime import datetime, timezone
    from config import DATASET_PATH

    ep_lines = []
    for ep_id in episode_ids:
        meta_path = os.path.join(DATASET_PATH, ep_id, "meta.json")
        try:
            with open(meta_path) as f:
                meta = json.load(f)
            task = meta.get("task", {}).get("instruction") or meta.get("task") or "—"
            if isinstance(task, dict):
                task = task.get("instruction", "—")
            success = meta.get("success")
            label = "success" if success is True else "failure" if success is False else "unlabeled"
            takes = len(meta.get("takes", []))
            ep_lines.append(f"  {ep_id}  [{label}]  takes={takes}  task={task}")
        except (OSError, json.JSONDecodeError):
            ep_lines.append(f"  {ep_id}")

    exported_at = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M UTC")
    frame_note = (
        "Included: mp4 video, depth video, CSV joint logs, webcam video, raw PNG frames"
        if include_frames else
        "Included: mp4 video, depth video, CSV joint logs, webcam video  (raw frames excluded)"
    )

    return f"""\
Piper Robot Arm — Demonstration Dataset
========================================
Exported : {exported_at}
Episodes : {len(episode_ids)}
{frame_note}

EPISODES
--------
{chr(10).join(ep_lines)}

DIRECTORY STRUCTURE
-------------------
<episode_id>/
  meta.json                  Episode metadata (task, success label, timestamps)
  takes/
    take_001/
      teach_joint.csv        Joint angles recorded during kinesthetic teaching
      executed_joint.csv     Joint angles executed during replay
      replay_command.csv     Joint commands sent to the robot during replay
      video.mp4              RGB video from primary depth camera (color stream)
      video_depth.mp4        Depth-colorised video from primary camera
      video_webcam_0.mp4     RGB video from external webcam 0  (if available)
      video_webcam_1.mp4     RGB video from external webcam 1  (if available)
      frames/                Raw PNG frames — color_XXXXXX.png  (if included)
      frames_webcam_0/       Raw PNG frames from webcam 0       (if included)
    take_002/ ...

CSV FORMAT  (teach_joint.csv / executed_joint.csv / replay_command.csv)
-----------------------------------------------------------------------
Column      Type     Description
----------  -------  ---------------------------------------------------
t_host_ns   int64    Host-side timestamp, nanoseconds since Unix epoch
q1..q6      float    Joint angles in radians (joint 1 = base, 6 = wrist)
gripper     float    Gripper opening in metres (0 = closed, ~0.07 = open)

ROBOT
-----
Platform : AgileX Piper 6-DOF collaborative arm
Kinematics: DH parameters (dh_is_offset=0x01)
  Link  a (mm)    alpha (rad)  d (mm)
   1      0.00    0.000        123.00
   2      0.00   -π/2            0.00
   3    285.03    0.000           0.00
   4    -21.98   +π/2          250.75
   5      0.00   -π/2            0.00
   6      0.00   +π/2           91.00
"""


def _get_teach_duration(take_dir: str) -> float | None:
    """teach_joint.csv의 첫/마지막 t_host_ns 차이(초) 반환."""
    path = os.path.join(take_dir, "teach_joint.csv")
    if not os.path.exists(path):
        return None
    with open(path) as f:
        rows = list(csv_module.DictReader(f))
    if len(rows) < 2:
        return None
    t0 = int(float(rows[0]["t_host_ns"]))
    t1 = int(float(rows[-1]["t_host_ns"]))
    dur = (t1 - t0) / 1e9
    return dur if dur > 0 else None


def _get_video_duration(video_path: str) -> float | None:
    """OpenCV metadata로 mp4 duration(초) 반환."""
    if not os.path.exists(video_path):
        return None
    try:
        import cv2
    except ImportError:
        return None
    cap = cv2.VideoCapture(video_path)
    fps = cap.get(cv2.CAP_PROP_FPS)
    frames = cap.get(cv2.CAP_PROP_FRAME_COUNT)
    cap.release()
    if fps and fps > 0 and frames and frames > 0:
        return float(frames / fps)
    return None


@bp.get("/<episode_id>/takes/<take>/frame_webcam1_at")
def get_take_frame_webcam1_at(episode_id: str, take: str):
    """
    t_sec에 가장 가까운 webcam_1 프레임 반환.

    ref=video (기본): t_sec는 비디오 플레이어 시각.
        video duration으로 정규화한 비율로 카메라 프레임을 찾음.
        replay 비디오가 speed-adjust되어 있어도 올바른 프레임을 반환.
    ref=camera: 카메라 실시간 절대 시각 기준 (직접 timestamp 매핑).
    """
    from config import DATASET_PATH
    t_sec = float(request.args.get("t", 0))
    ref = request.args.get("ref", "video")  # "video" | "camera"

    td = os.path.join(DATASET_PATH, episode_id, "takes", take)
    frames_dir = os.path.join(td, "frames_webcam_1")
    if not os.path.isdir(frames_dir):
        return abort(404)

    cam_csv_path = os.path.join(td, "camera_frames_webcam_1.csv")
    frame_idx = 0
    if os.path.exists(cam_csv_path):
        with open(cam_csv_path) as f:
            rows = list(csv_module.DictReader(f))
        if rows:
            if ref == "video":
                # 비디오 시간을 카메라 프레임 비율로 변환.
                video_duration = _get_video_duration(os.path.join(td, "video_webcam_1.mp4"))
                if video_duration and video_duration > 0:
                    frac = max(0.0, min(1.0, t_sec / video_duration))
                    row_idx = int(round(frac * (len(rows) - 1)))
                else:
                    row_idx = 0
                frame_idx = int(rows[row_idx]["frame_idx"])
            else:
                # ref == "camera": 카메라 실시간 절대 시각 기준
                cam_t0_ns = int(float(rows[0]["t_host_ns"]))
                t_target_ns = cam_t0_ns + int(t_sec * 1e9)
                best = min(rows, key=lambda r: abs(int(float(r["t_host_ns"])) - t_target_ns))
                frame_idx = int(best["frame_idx"])

    for ext in ("jpg", "png"):
        path = os.path.join(frames_dir, f"color_{frame_idx:06d}.{ext}")
        if os.path.exists(path):
            return send_file(path, mimetype=f"image/{'jpeg' if ext == 'jpg' else ext}")
    return abort(404)


@bp.get("/<episode_id>/takes/<take>/edit_meta")
def get_edit_meta(episode_id: str, take: str):
    from config import DATASET_PATH
    td = os.path.join(DATASET_PATH, episode_id, "takes", take)
    if not os.path.isdir(td):
        return abort(404)
    path = os.path.join(td, "edit_meta.json")
    if not os.path.exists(path):
        return jsonify({"trim": {"enabled": False, "cut_t": None, "margin": 1.0},
                        "mask": {"enabled": False, "polygon": [], "fill": "black"}})
    with open(path) as f:
        return jsonify(json.load(f))


@bp.put("/<episode_id>/takes/<take>/edit_meta")
def put_edit_meta(episode_id: str, take: str):
    from config import DATASET_PATH
    td = os.path.join(DATASET_PATH, episode_id, "takes", take)
    if not os.path.isdir(td):
        return abort(404)
    data = request.get_json(silent=True)
    if data is None:
        return abort(400)
    path = os.path.join(td, "edit_meta.json")
    with open(path, "w") as f:
        json.dump(data, f, indent=2)
    return jsonify({"ok": True})


@bp.get("/<episode_id>/takes/<take>/trajectory")
def get_take_trajectory(episode_id: str, take: str):
    from config import DATASET_PATH
    from kinematics.fk import compute_trajectory

    td = os.path.join(DATASET_PATH, episode_id, "takes", take)
    if not os.path.isdir(td):
        return abort(404)

    cache_path = os.path.join(td, "trajectory_cache.json")
    if os.path.exists(cache_path):
        with open(cache_path) as f:
            return jsonify(json.load(f))

    def read_csv(fname: str) -> list[dict]:
        path = os.path.join(td, fname)
        if not os.path.exists(path):
            return []
        with open(path) as f:
            return list(csv_module.DictReader(f))

    result = {
        "teach":    compute_trajectory(read_csv("teach_joint.csv")),
        "executed": compute_trajectory(read_csv("executed_joint.csv")),
        "command":  compute_trajectory(read_csv("replay_command.csv")),
    }

    with open(cache_path, "w") as f:
        json.dump(result, f)

    return jsonify(result)
