"""
aligner.py — episode_manager.generate_aligned_frames 의 순수 함수 버전.
테스트/스크립트에서 단독으로 사용할 수 있도록 분리.
"""

import numpy as np

DOF = 6


def align_frames_to_joints(
    camera_frames: list[dict],
    joint_rows: list[dict],
    episode_id: str = "",
) -> list[dict]:
    """
    camera_frames: [{frame_idx, t_host_ns, color_path, depth_path, ...}]
    joint_rows:    [{t_host_ns, q1..q6, gripper, ...}]
    → aligned: [{frame_idx, t_host_ns, color_path, depth_path, q1..q6, gripper, episode_id}]
    """
    if not camera_frames or not joint_rows:
        return []

    joint_ts = np.array([int(r["t_host_ns"]) for r in joint_rows], dtype=np.int64)
    joint_vals = {
        f"q{i+1}": np.array([float(r.get(f"q{i+1}", 0)) for r in joint_rows])
        for i in range(DOF)
    }
    joint_vals["gripper"] = np.array([float(r.get("gripper", 0)) for r in joint_rows])

    result = []
    for row in camera_frames:
        t_cam = int(row["t_host_ns"])
        idx = int(np.clip(np.searchsorted(joint_ts, t_cam), 0, len(joint_ts) - 1))

        if idx == 0 or idx >= len(joint_ts) - 1:
            interp = {k: float(v[idx]) for k, v in joint_vals.items()}
        else:
            t0, t1 = joint_ts[idx - 1], joint_ts[idx]
            alpha = (t_cam - t0) / max(t1 - t0, 1)
            interp = {
                k: float(v[idx - 1] + alpha * (v[idx] - v[idx - 1]))
                for k, v in joint_vals.items()
            }

        result.append({
            "frame_idx": row["frame_idx"],
            "t_host_ns": row["t_host_ns"],
            "color_path": row["color_path"],
            "depth_path": row.get("depth_path", ""),
            **interp,
            "episode_id": episode_id,
        })
    return result
