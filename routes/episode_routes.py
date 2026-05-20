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
    return jsonify(_mgr().list_episodes())


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
