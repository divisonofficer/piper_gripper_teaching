# piper_cowork

**Kinesthetic teaching dataset generator for robot manipulation.**  
Single AgileX Piper arm — no teleoperation, no external controller.  
Operator physically guides the arm, the system records and replays.

---

## Overview

`piper_cowork` is a web-based platform for generating gripper manipulation datasets using **kinesthetic teaching**. The operator holds the robot arm and demonstrates a task by hand; the system records joint trajectories and camera streams, then replays the motion autonomously while logging ground-truth execution data for imitation learning.

**Hardware:**
- AgileX Piper 6-DOF arm (CAN bus, ROS2)
- Intel RealSense D4xx — RGB + depth, 1280×720
- 2× Logitech C270 webcams — side views

**Output format:** LeRobot v2.0 compatible (optional converter)

---

## Workflow

```
IDLE → connect → TEACH_READY
                     │
              start teaching
                     │
             TEACH_RECORDING   ← operator guides arm by hand
                     │
              stop teaching
                     │
             TRAJECTORY_CHECK  ← review recorded trajectory
                     │
              return home ──── backtrace (reverse trajectory)
                     │    └─── direct (SAFE_RETURN_WAYPOINTS)
             REPLAY_READY
                     │
              start replay
                     │
             REPLAY_RECORDING  ← arm replays, cameras record
                     │
              stop replay
                     │
                  REVIEW  ── save (success / failure) or discard
                                      │
                              add another take  ←─────────────┐
                              retake replay ←──────────────────┤
                              retake teach ←───────────────────┘
```

Each **episode** is one task (e.g. "pick red cup"). Each **take** is one teach→replay attempt within that episode.

---

## Directory Structure

```
piper_cowork/
├── app.py                   # Flask app entry point
├── controller.py            # State machine (IDLE → … → SAVED)
├── config.py                # All tuneable parameters
├── start.sh                 # Launch script
│
├── nodes/
│   ├── piper_node.py        # Teach / replay / home logic (ROS2 node)
│   ├── realsense_node.py    # RealSense color + depth stream
│   ├── webcam_node.py       # Logitech C270 frame capture
│   └── camera_manager.py   # Multi-camera coordinator
│
├── storage/
│   ├── episode_manager.py   # Episode/take lifecycle, CSV + video save
│   └── aligner.py           # Timestamp-align joint + camera streams
│
├── routes/
│   ├── capture_routes.py    # /api/connect, /api/teach/*, /api/replay/*, …
│   ├── episode_routes.py    # /api/episodes/save, /discard, /retake_*, …
│   ├── robot_routes.py      # /api/robot/gripper/*, /api/robot/status
│   └── mask_routes.py       # /api/mask/* (object mask library)
│
├── converters/
│   └── lerobot_converter.py # Convert takes → LeRobot v2.0 format
│
├── frontend/                # React web UI (desktop + mobile)
│   └── src/pages/
│       ├── CapturePage.tsx  # Main desktop workflow UI
│       ├── MobilePage.tsx   # Touch-optimized mobile UI
│       └── DatasetPage.tsx  # Dataset browser + export
│
└── dataset/                 # Recorded episodes (git-ignored)
    └── episode_YYYYMMDD_HHMMSS/
        ├── meta.json
        ├── label.json
        └── takes/
            └── take_001/
                ├── teach_joint.csv       # Raw kinesthetic recording (50 Hz)
                ├── replay_command.csv    # Commands sent during replay
                ├── executed_joint.csv    # Actual joint states during replay
                ├── camera_frames.csv     # RealSense frame timestamps
                ├── aligned_frames.csv    # Time-aligned joint + camera
                ├── events.json           # Gripper events, state transitions
                ├── frames/               # color_*.jpg + depth_*.png
                ├── video.mp4             # RealSense color video
                └── video_webcam_{0,1}.mp4
```

---

## Setup

### Requirements

```bash
# ROS2 (Humble or later) + piper_ros driver on CAN bus
pip install flask flask-socketio pyrealsense2 opencv-python scipy numpy pandas imageio-ffmpeg
```

### Configuration

Edit `config.py` before first run:

```python
# Safe return waypoints — measure on your physical robot:
# ros2 topic echo /joint_states_single --once  (move arm to desired pose first)
SAFE_RETURN_WAYPOINTS = [
    [q1, q2, q3, q4, q5, q6],   # clearance pose (EE well above table)
    [q1, q2, q3, q4, q5, q6],   # ready pose (task start position)
]
```

Without `SAFE_RETURN_WAYPOINTS`, automatic home return is disabled — the operator must manually reset the arm between takes.

### Run

```bash
cd piper_cowork
./start.sh
# → https://<host>:5002        (desktop UI)
# → https://<host>:5002/mobile (mobile UI, touch-optimized)
```

The server uses self-signed TLS (`cert.pem` / `key.pem`). Accept the browser warning on first visit.

---

## Gripper

Gripper state is **binary** during replay: fully open (`0.07 rad`) or fully closed (`0.0 rad`).

- Threshold: `0.022 rad` — below → CLOSED, above → OPEN
- Multi-step actuation: 8 steps over 0.64 s to overcome driver deadband
- Teach with any intermediate position; replay snaps to 0% or 100%
- UI slider: 0% / 100% only (no 50% step)

---

## Dataset Format

### Raw (per take)

| File | Content |
|------|---------|
| `teach_joint.csv` | `t_host_ns, q1–q6, gripper` at 50 Hz |
| `replay_command.csv` | Commands issued during replay |
| `executed_joint.csv` | Actual joint states during replay |
| `aligned_frames.csv` | Nearest-frame join of joint + camera timestamps |
| `events.json` | Gripper transitions, state changes, errors |

### LeRobot v2.0 Export

```bash
# from the Dataset page in the UI, or:
python -m converters.lerobot_converter --episode episode_YYYYMMDD_HHMMSS
```

Output: `observation.state` (7-dim: q1–q6 + gripper), `action`, `observation.images.cam_webcam_0/1` (224×224 @ 15 fps). Trimmed automatically: episode ends 1 s after the first gripper-open event past 10 s.

---

## Key Parameters

| Parameter | Default | Description |
|-----------|---------|-------------|
| `TEACH_LOG_HZ` | 50 | Joint recording frequency |
| `REPLAY_DEFAULT_SPEED` | 0.3 | First replay speed (30% of teach speed) |
| `GRIPPER_OPEN_RAD` | 0.07 | Full open position |
| `GRIPPER_CLOSE_RAD` | 0.0 | Full closed position |
| `GRIPPER_STEPS` | 8 | Actuation sub-steps (deadband workaround) |
| `REALSENSE_FPS` | 10 | RealSense capture rate |
| `REALSENSE_RESOLUTION` | 1280×720 | Color + depth resolution |
| `SAFE_RETURN_WAYPOINTS` | None | Home return waypoints (must set manually) |

---

## Notes

- **No teleoperation required.** The operator physically moves the arm during teaching. Motor torque is disabled (freedrive mode) via the enable flag topic.
- **Replay is deterministic.** The smoothed teach trajectory is replayed at a configurable speed; actual executed joints are logged separately from commands for quality analysis.
- **Safe return is path-safe, not just target-safe.** Home is reached via a verified waypoint sequence, not a single target command, to prevent mid-path collisions.
