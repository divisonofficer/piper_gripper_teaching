"""
Forward Kinematics for Piper 6-DOF arm.

DH parameters sourced from piper_sdk.kinematics.piper_fk (C_PiperForwardKinematics,
dh_is_offset=0x01). Pure Python — no external dependencies.

CalFK([q1..q6]) returns j_pos[0..5], each [x, y, z, roll, pitch, yaw]
where xyz is in mm and rpy in degrees.
j_pos[5] = link6 / end-effector tip.
base_link is at [0, 0, 0].
"""

import math

_PI = math.pi

# DH parameters (dh_is_offset=0x01)
_A     = [0,      0,           285.03,        -21.98,       0,           0       ]
_ALPHA = [0,     -_PI / 2,     0,              _PI / 2,    -_PI / 2,     _PI / 2 ]
_THETA = [0,     -_PI * 172.22 / 180, -102.78 / 180 * _PI, 0,           0,       0]
_D     = [123,    0,           0,              250.75,       0,           91      ]


def _link_transform(alpha: float, a: float, theta: float, d: float) -> list[float]:
    """Returns flat 4x4 row-major transform matrix as list[16]."""
    ca, sa = math.cos(alpha), math.sin(alpha)
    ct, st = math.cos(theta), math.sin(theta)
    return [
        ct,       -st,       0,        a,
        st * ca,   ct * ca, -sa,      -sa * d,
        st * sa,   ct * sa,  ca,       ca * d,
        0,         0,        0,        1,
    ]


def _mat_mul(A: list[float], B: list[float]) -> list[float]:
    """4x4 matrix multiply, both stored row-major flat."""
    out = [0.0] * 16
    for i in range(4):
        for j in range(4):
            s = 0.0
            for k in range(4):
                s += A[4 * i + k] * B[4 * k + j]
            out[4 * i + j] = s
    return out


def _mat_to_xyzrpy(T: list[float]) -> list[float]:
    """Extract [x, y, z, roll, pitch, yaw] from flat 4x4 row-major matrix."""
    x, y, z = T[3], T[7], T[11]
    if T[8] < -1 + 1e-4:
        pitch = _PI / 2
        yaw   = 0.0
        roll  = math.atan2(T[1], T[5])
    elif T[8] > 1 - 1e-4:
        pitch = -_PI / 2
        yaw   = 0.0
        roll  = -math.atan2(T[1], T[5])
    else:
        pitch = math.atan2(-T[8], math.sqrt(T[0] ** 2 + T[4] ** 2))
        cp    = math.cos(pitch)
        yaw   = math.atan2(T[4] / cp, T[0] / cp)
        roll  = math.atan2(T[9] / cp, T[10] / cp)
    DEG = 180 / _PI
    return [x, y, z, roll * DEG, pitch * DEG, yaw * DEG]


def cal_fk(q: list[float]) -> list[list[float]]:
    """
    Forward kinematics for Piper arm.

    q: joint angles [q1..q6] in radians.
    Returns j_pos[0..5], each [x, y, z, roll, pitch, yaw]
      xyz in mm, rpy in degrees.
    """
    Rt = [_link_transform(_ALPHA[i], _A[i], q[i] + _THETA[i], _D[i]) for i in range(6)]
    T = Rt[0]
    j_pos = [_mat_to_xyzrpy(T)]
    for i in range(1, 6):
        T = _mat_mul(T, Rt[i])
        j_pos.append(_mat_to_xyzrpy(T))
    return j_pos


def compute_trajectory(rows: list[dict]) -> list[dict]:
    """
    rows: list of CSV row dicts with keys t_host_ns, q1..q6, gripper.
    Returns list of samples:
      {
        "t":       float,        # seconds from start
        "gripper": float,
        "ee":      [x, y, z],    # link6 position in meters (base_link frame)
        "links":   [[x,y,z]x6],  # link1..6 positions in meters
      }
    """
    if not rows:
        return []

    try:
        t0 = int(float(rows[0]["t_host_ns"]))
    except (KeyError, ValueError):
        return []

    samples = []
    for row in rows:
        try:
            q = [float(row[f"q{i}"]) for i in range(1, 7)]
            j_pos = cal_fk(q)
            t_ns = int(float(row["t_host_ns"]))
            samples.append({
                "t":       (t_ns - t0) / 1e9,
                "gripper": float(row.get("gripper", 0)),
                "ee":      [j_pos[5][k] / 1000.0 for k in range(3)],
                "links":   [[j_pos[i][k] / 1000.0 for k in range(3)] for i in range(6)],
            })
        except (KeyError, ValueError, IndexError):
            continue

    return samples
