"""
Controller
----------
전체 상태 기계(State Machine) + 오케스트레이션.

상태 전이:
  IDLE → CONNECTING → READY
       → TEACH_READY → TEACH_RECORDING → TRAJECTORY_CHECK
       → RETURN_HOME → REPLAY_READY → REPLAY_RECORDING
       → REVIEW → SAVED | DISCARDED

핵심 설계:
  - 프론트엔드는 controller.get_status() 를 보고 available_actions 만 표시
  - controller가 모든 상태 전이 guard를 가짐
  - SocketIO emit은 on_emit 콜백으로 주입받음 (테스트 가능)
"""

import json
import os
import threading
import time
from enum import Enum, auto
from typing import Callable, Optional

import rclpy
from rclpy.executors import MultiThreadedExecutor

from nodes.piper_node import PiperTeachReplayNode
from nodes.camera_manager import CameraManager
from storage.episode_manager import EpisodeManager
from config import REPLAY_DEFAULT_SPEED, HOME_APPROACH_SPEED, DATASET_PATH, GRIPPER_OPEN_RAD, JOINT_LIMITS_FILE


class State(str, Enum):
    IDLE = "IDLE"
    CONNECTING = "CONNECTING"
    READY = "READY"
    CALIBRATING = "CALIBRATING"
    TEACH_READY = "TEACH_READY"
    TEACH_RECORDING = "TEACH_RECORDING"
    TRAJECTORY_CHECK = "TRAJECTORY_CHECK"
    RETURN_HOME = "RETURN_HOME"
    REPLAY_READY = "REPLAY_READY"
    REPLAY_RECORDING = "REPLAY_RECORDING"
    PROCESSING = "PROCESSING"   # replay 완료 후 CSV flush + 비디오 인코딩 중
    REVIEW = "REVIEW"
    SAVED = "SAVED"
    DISCARDED = "DISCARDED"


_NEXT_ACTIONS = {
    State.IDLE:             "Connect the robot and camera to begin.",
    State.CONNECTING:       "Waiting for robot and camera to connect...",
    State.READY:            "System ready. Press 'Confirm Ready Pose' to start a teaching session.",
    State.CALIBRATING:      "Move arm freely through its full range of motion, then press 'Finish Calibration'.",
    State.TEACH_READY:      "Robot is in home position. Press 'Start Teaching' when ready.",
    State.TEACH_RECORDING:  "Guide the robot arm by hand. Press 'Stop Teaching' when done.",
    State.TRAJECTORY_CHECK: "Trajectory recorded. Review the summary and return home before replay.",
    State.RETURN_HOME:      "Robot is returning to home position. Please wait.",
    State.REPLAY_READY:     "Robot is at home. Set replay speed and press 'Start Replay Recording'.",
    State.REPLAY_RECORDING: "Replay in progress. Camera and joint data are being recorded.",
    State.PROCESSING:       "Replay done. Encoding videos and saving data...",
    State.REVIEW:           "Review the episode. Label as success/failure and save or discard.",
    State.SAVED:            "Episode saved. Start a new episode or add another take.",
    State.DISCARDED:        "Episode discarded. You can start a new episode.",
}

_AVAILABLE_ACTIONS: dict[State, list[str]] = {
    State.IDLE:             ["connect"],
    State.CONNECTING:       [],
    State.READY:            ["confirm_ready_pose", "calibrate", "open_gripper", "close_gripper"],
    State.CALIBRATING:      ["stop_calibration", "hold_position"],
    State.TEACH_READY:      ["start_teach", "calibrate", "open_gripper", "close_gripper"],
    State.TEACH_RECORDING:  ["stop_teach", "open_gripper", "close_gripper", "hold_position"],
    State.TRAJECTORY_CHECK: ["return_home", "return_home_direct", "discard_episode"],
    State.RETURN_HOME:      ["hold_position"],
    State.REPLAY_READY:     ["start_replay", "discard_episode", "open_gripper", "close_gripper"],
    State.REPLAY_RECORDING: ["stop_replay", "hold_position", "open_gripper", "close_gripper", "gripper_set"],
    State.PROCESSING:       [],
    State.REVIEW:           ["save_episode", "discard_episode", "retake_replay", "retake_teach"],
    State.SAVED:            ["new_episode", "add_take"],
    State.DISCARDED:        ["new_episode"],
}


class Controller:

    def __init__(self, on_emit: Optional[Callable] = None):
        """
        on_emit(event, data): SocketIO emit 콜백.
                              None이면 emit 없이 동작 (테스트용).
        """
        self._on_emit = on_emit or (lambda e, d: None)
        self._state = State.IDLE
        self._lock = threading.Lock()

        # ── 서브시스템 ──────────────────────────────────────────────
        self._piper: Optional[PiperTeachReplayNode] = None
        self._cameras: Optional[CameraManager] = None
        self._episode: EpisodeManager = EpisodeManager(DATASET_PATH)
        self._ros_executor: Optional[MultiThreadedExecutor] = None
        self._ros_thread: Optional[threading.Thread] = None

        # ── calibration ────────────────────────────────────────────────
        self._calib_prev_state: State = State.READY

        # ── trajectory cache (teach → check → replay 사이에 보관) ───
        self._teach_buffer: list[dict] = []
        self._smoothed_trajectory: list[dict] = []
        self._trajectory_check: dict = {}
        self._replay_speed: float = REPLAY_DEFAULT_SPEED

        # ── 상태 폴링 스레드 ───────────────────────────────────────
        self._poll_stop = threading.Event()
        self._poll_thread = threading.Thread(target=self._poll_loop, daemon=True)
        self._poll_thread.start()

        # ── 이벤트 로그 ────────────────────────────────────────────
        self._event_log: list[dict] = []

        print("[Controller] Initialized")

    # ─────────────────────────────────────────────────────────────────
    # State helpers
    # ─────────────────────────────────────────────────────────────────

    def _set_state(self, new_state: State, extra: dict = None):
        with self._lock:
            self._state = new_state
        payload = self.get_status()
        if extra:
            payload.update(extra)
        self._on_emit("mode_change", payload)
        self._add_event_log(f"State → {new_state.value}")

    def get_state(self) -> State:
        with self._lock:
            return self._state

    def get_status(self) -> dict:
        state = self.get_state()
        status = {
            "mode": state.value,
            "next_action": _NEXT_ACTIONS.get(state, ""),
            "available_actions": _AVAILABLE_ACTIONS.get(state, []),
        }
        if self._trajectory_check:
            status["trajectory_summary"] = self._trajectory_check
        return status

    def _add_event_log(self, message: str):
        entry = {"t": time.time(), "message": message}
        self._event_log.append(entry)
        if len(self._event_log) > 200:
            self._event_log = self._event_log[-200:]
        self._on_emit("event_log", entry)

    def get_event_log(self) -> list[dict]:
        return self._event_log[-50:]

    # ─────────────────────────────────────────────────────────────────
    # Polling loop (10Hz → robot_state, camera_state, logger_state emit)
    # ─────────────────────────────────────────────────────────────────

    def _poll_loop(self):
        while not self._poll_stop.is_set():
            self._emit_robot_state()
            self._emit_camera_state()
            self._emit_logger_state()
            time.sleep(0.1)  # 10 Hz

    def _emit_robot_state(self):
        if self._piper is None:
            self._on_emit("robot_state", {"connected": False})
            return
        state = self._piper.get_state()
        self._on_emit("robot_state", {
            "connected": True,
            "position": [round(v, 4) for v in state["position"]],
            "gripper": round(state["gripper"], 4),
            "velocity": [round(v, 4) for v in state["velocity"]],
            "is_moving": state["is_moving"],
            "mode": state["mode"],
            "hz": state["hz"],
        })

    def _emit_camera_state(self):
        if self._cameras is None:
            self._on_emit("camera_state", {"connected": False, "cameras": {}})
            return
        self._on_emit("camera_state", self._cameras.get_status())

    def _emit_logger_state(self):
        import shutil as _shutil
        free = _shutil.disk_usage(DATASET_PATH).free // (1024 ** 3)
        piper_samples = len(self._piper.get_teach_buffer()) if self._piper else 0
        self._on_emit("logger_state", {
            "episode_id": self._episode.current_episode_id,
            "disk_free_gb": free,
            "teach_samples": piper_samples,
            "exec_samples": len(self._piper.get_executed_buffer()) if self._piper else 0,
            "cam_frames": self._get_total_cam_frames(),
        })

    def _get_total_cam_frames(self) -> int:
        """모든 카메라의 captured_frames 합계."""
        if self._cameras is None:
            return 0
        status = self._cameras.get_status()
        total = 0
        for cam_info in status.get("cameras", {}).values():
            total += cam_info.get("captured_frames", 0)
        return total

    # ─────────────────────────────────────────────────────────────────
    # Actions (guard → execute → transition)
    # ─────────────────────────────────────────────────────────────────

    def connect(self) -> dict:
        # 레이스 컨디션 방지: 상태 확인과 변경을 같은 lock 안에서 처리
        with self._lock:
            if self._state not in (State.IDLE, State.DISCARDED, State.SAVED):
                return {"ok": False, "reason": f"Already in state {self._state.value}"}
            self._state = State.CONNECTING

        # lock 밖에서 emit (deadlock 방지)
        self._on_emit("mode_change", self.get_status())
        self._add_event_log("State → CONNECTING")
        threading.Thread(target=self._connect_async, daemon=True).start()
        return {"ok": True}

    def _connect_async(self):
        try:
            # ROS2 초기화
            if not rclpy.ok():
                rclpy.init()

            self._piper = PiperTeachReplayNode(on_state_update=None)
            self._ros_executor = MultiThreadedExecutor()
            self._ros_executor.add_node(self._piper)
            self._ros_thread = threading.Thread(target=self._ros_executor.spin, daemon=True)
            self._ros_thread.start()

            # 카메라 초기화 (RealSense + USB 웹캠, 1대라도 연결되면 진행)
            self._cameras = CameraManager()
            cam_ok = self._cameras.connect()
            if not cam_ok:
                print("[Controller] Warning: no cameras available — continuing without camera")

            time.sleep(1.0)  # 안정화

            # 저장된 joint limits 로드 (있으면 적용)
            self._load_joint_limits()

            self._set_state(State.READY)
            self._add_event_log("Robot and camera connected")

        except Exception as e:
            self._add_event_log(f"Connection failed: {e}")
            self._set_state(State.IDLE)

    def confirm_ready_pose(self) -> dict:
        if self.get_state() != State.READY:
            return {"ok": False, "reason": "Not in READY state"}
        self._set_state(State.TEACH_READY)
        return {"ok": True}

    def start_teach(self, task: str = "unspecified", operator: str = "unknown") -> dict:
        if self.get_state() != State.TEACH_READY:
            return {"ok": False, "reason": "Must be in TEACH_READY state"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}

        # 활성 episode가 없을 때만 새 episode 생성 (retake/add_take 후에는 이미 take가 준비되어 있음)
        if self._episode.current_episode_id is None:
            self._episode.create_episode(task=task, operator=operator)

        self._piper.start_teach(disable_delay=5.0)
        self._set_state(State.TEACH_RECORDING)
        take = self._episode.get_current_take_name()
        self._add_event_log(f"Teaching started: {task} ({take})")
        return {"ok": True, "episode_id": self._episode.current_episode_id, "take": take}

    def stop_teach(self) -> dict:
        if self.get_state() != State.TEACH_RECORDING:
            return {"ok": False, "reason": "Not in TEACH_RECORDING state"}

        self._teach_buffer = self._piper.stop_teach()

        if len(self._teach_buffer) < 10:
            self._add_event_log("Teaching too short, discarding")
            self._set_state(State.TEACH_READY)
            return {"ok": False, "reason": "Teaching too short (< 10 samples)"}

        # Trajectory smoothing & check
        smoothed, check = PiperTeachReplayNode.smooth_trajectory(self._teach_buffer, self._replay_speed)
        self._smoothed_trajectory = smoothed
        self._trajectory_check = check
        self._trajectory_check["gripper_events"] = sum(
            1 for e in self._piper.get_events() if "gripper" in e.get("event", "")
        )

        # Flush teach CSV
        self._episode.flush_teach_joint(self._teach_buffer)
        self._episode.flush_events(self._piper.get_events())

        self._set_state(State.TRAJECTORY_CHECK)
        self._add_event_log(f"Teach done: {len(self._teach_buffer)} samples, check={'OK' if check['ok'] else 'WARN'}")
        return {"ok": True, "trajectory_check": check}

    def return_home(self) -> dict:
        if self.get_state() != State.TRAJECTORY_CHECK:
            return {"ok": False, "reason": "Must be in TRAJECTORY_CHECK state"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}
        if not self._smoothed_trajectory:
            self._add_event_log("return_home blocked: no trajectory — going to TEACH_READY")
            self._set_state(State.TEACH_READY)
            return {"ok": False, "reason": "No trajectory available"}

        self._set_state(State.RETURN_HOME)
        self._add_event_log("Returning to teach_start via reverse trajectory")

        ok = self._piper.safe_return_to_start(
            trajectory=self._smoothed_trajectory,
            done_callback=self._on_home_reached,
            abort_callback=self._on_home_abort,
        )
        if not ok:
            self._add_event_log("safe_return_to_start refused — reverting to TRAJECTORY_CHECK")
            self._set_state(State.TRAJECTORY_CHECK)
            return {"ok": False, "reason": "safe_return_to_start refused"}

        return {"ok": True}

    def return_home_direct(self) -> dict:
        """역방향 궤적 없이 SAFE_RETURN_WAYPOINTS 경유로 바로 홈 복귀."""
        if self.get_state() != State.TRAJECTORY_CHECK:
            return {"ok": False, "reason": "Must be in TRAJECTORY_CHECK state"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}

        self._set_state(State.RETURN_HOME)
        self._add_event_log("Returning home directly via safe waypoints (no backtrace)")

        ok = self._piper.go_to_safe_ready(done_callback=self._on_home_reached, abort_callback=self._on_home_abort)
        if not ok:
            self._add_event_log("go_to_safe_ready refused — reverting to TRAJECTORY_CHECK")
            self._set_state(State.TRAJECTORY_CHECK)
            return {"ok": False, "reason": "SAFE_RETURN_WAYPOINTS not configured. Set them in the Setup page first."}

        return {"ok": True}

    def _get_teach_start_position(self) -> Optional[list]:
        """smoothed trajectory의 첫 번째 waypoint (teaching 시작 위치). 없으면 None."""
        if self._smoothed_trajectory:
            first = self._smoothed_trajectory[0]
            return [first.get(f"q{i+1}", 0.0) for i in range(6)]
        if self._teach_buffer:
            first = self._teach_buffer[0]
            return [first.get(f"q{i+1}", 0.0) for i in range(6)]
        return None  # [0]*6 zero-pose fallback 금지

    _START_POSE_TOL = 0.08   # rad: 이 이상이면 replay 차단

    def _on_home_reached(self):
        """홈 복귀 완료 — start pose 오차 확인 후 REPLAY_READY 또는 TRAJECTORY_CHECK."""
        if self._piper and self._smoothed_trajectory:
            target = [self._smoothed_trajectory[0].get(f"q{i+1}", 0.0) for i in range(6)]
            cur = self._piper.get_state().get("position", [])
            if len(cur) >= 6:
                err = max(abs(cur[i] - target[i]) for i in range(6))
                if err > self._START_POSE_TOL:
                    self._add_event_log(
                        f"Start pose error {err:.3f} rad > {self._START_POSE_TOL} — "
                        f"replay blocked. Return home again or retake."
                    )
                    self._set_state(State.TRAJECTORY_CHECK)
                    return
                self._add_event_log(f"Start pose OK: err={err:.3f} rad")

        self._add_event_log("Robot reached start position")
        self._set_state(State.REPLAY_READY)

    def _on_home_abort(self):
        """홈 복귀 실패(waypoint timeout) — TRAJECTORY_CHECK로 복귀해 재시도 허용."""
        self._add_event_log("Return home failed (timeout) — reverted to TRAJECTORY_CHECK. Retry or discard.")
        self._set_state(State.TRAJECTORY_CHECK)

    def _is_at_trajectory_start(self, tol: float = 0.06) -> tuple:
        """현재 위치가 trajectory 시작점에 충분히 가까운지 확인."""
        if not self._smoothed_trajectory or not self._piper:
            return False, 999.0
        traj0 = [self._smoothed_trajectory[0].get(f"q{i+1}", 0.0) for i in range(6)]
        cur = self._piper.get_state().get("position", [])
        if len(cur) < 6:
            return False, 999.0
        err = max(abs(cur[i] - traj0[i]) for i in range(6))
        return err < tol, round(err, 4)

    def start_replay(self, speed_scale: Optional[float] = None) -> dict:
        if self.get_state() != State.REPLAY_READY:
            return {"ok": False, "reason": "Must be in REPLAY_READY state"}
        if not self._smoothed_trajectory:
            return {"ok": False, "reason": "No trajectory available"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}

        at_start, err = self._is_at_trajectory_start(tol=0.06)
        if not at_start:
            return {
                "ok": False,
                "reason": f"Robot not at trajectory start (err={err} rad > 0.06). Return home first.",
            }

        speed = speed_scale if speed_scale is not None else self._replay_speed
        self._replay_speed = speed   # cleanup 시 동일한 속도로 비디오 인코딩
        self._set_state(State.REPLAY_RECORDING)

        # 카메라 녹화 시작 (연결된 모든 카메라)
        episode_dir = self._episode.get_episode_dir()
        if self._cameras:
            self._cameras.start_all_recording(episode_dir)
        self._add_event_log(f"Replay started (speed={speed})")

        # 로봇 replay
        self._piper.start_replay(
            self._smoothed_trajectory,
            speed_scale=speed,
            done_callback=self._on_replay_done,
        )
        return {"ok": True}

    def _on_replay_done(self):
        self._stop_replay_cleanup()

    def stop_replay(self) -> dict:
        """사용자가 수동으로 멈춤"""
        if self.get_state() != State.REPLAY_RECORDING:
            return {"ok": False, "reason": "Not in REPLAY_RECORDING state"}
        # replay thread에 중단 신호 (join하지 않음: cleanup이 main thread에서 처리)
        if self._piper:
            self._piper._replay_stop_event.set()
        self._stop_replay_cleanup()
        return {"ok": True}

    def _stop_replay_cleanup(self):
        # 이중 호출 방지: 상태를 원자적으로 확인 후 변경
        # (자연 완료 시 replay thread 내부에서, 수동 중단 시 main thread에서 모두 호출될 수 있음)
        with self._lock:
            if self._state != State.REPLAY_RECORDING:
                return  # 이미 cleanup 완료
            self._state = State.PROCESSING  # ← replay 완료, 후처리 시작

        # PROCESSING 상태 즉시 알림 (프론트엔드가 진행 표시 시작)
        self._on_emit("mode_change", self.get_status())

        def _progress(step: str, status: str, detail: str = ""):
            self._on_emit("save_progress", {"step": step, "status": status, "detail": detail})

        # ── 카메라 녹화 중단 ───────────────────────────────────────────
        _progress("stop_cameras", "running")
        cam_buffers: dict = {}
        if self._cameras:
            cam_buffers = self._cameras.stop_all_recording()
        total_cam = sum(len(v) for v in cam_buffers.values())
        _progress("stop_cameras", "ok", f"{total_cam} frames")

        # ── 로봇 버퍼 + CSV flush ─────────────────────────────────────
        _progress("flush_csv", "running")
        exec_buf = self._piper.get_executed_buffer() if self._piper else []
        cmd_buf = self._piper.get_command_buffer() if self._piper else []
        self._episode.flush_executed_joint(exec_buf)
        self._episode.flush_replay_command(cmd_buf)
        self._episode.flush_camera_frames_multi(cam_buffers)
        self._episode.flush_events(self._piper.get_events() if self._piper else [])
        _progress("flush_csv", "ok", f"exec={len(exec_buf)} cmd={len(cmd_buf)}")

        # ── 프레임 정렬 ───────────────────────────────────────────────
        _progress("align_frames", "running")
        self._episode.generate_aligned_frames()
        _progress("align_frames", "ok")

        # ── 비디오 인코딩 ─────────────────────────────────────────────
        self._episode.generate_preview_videos(
            replay_speed=self._replay_speed,
            on_step=_progress,
        )

        # ── REVIEW 전환 ───────────────────────────────────────────────
        with self._lock:
            self._state = State.REVIEW
        self._on_emit("mode_change", self.get_status())
        self._add_event_log(f"Replay done → REVIEW (cam={total_cam}, exec={len(exec_buf)} samples)")

    def save_episode(self, success: bool, reason: str = "") -> dict:
        if self.get_state() != State.REVIEW:
            return {"ok": False, "reason": "Not in REVIEW state"}
        result = self._episode.finalize_episode(success=success, reason=reason)
        quality = self._episode.compute_tracking_quality()
        self._set_state(State.SAVED)
        self._add_event_log(f"Episode saved: success={success}")
        return {"ok": True, **result, "quality": quality}

    def discard_episode(self) -> dict:
        state = self.get_state()
        if state not in (State.TRAJECTORY_CHECK, State.REPLAY_READY, State.REVIEW):
            return {"ok": False, "reason": f"Cannot discard in state {state.value}"}
        self._episode.discard_episode()
        self._set_state(State.DISCARDED)
        self._add_event_log("Episode discarded")
        return {"ok": True}

    def new_episode(self) -> dict:
        state = self.get_state()
        if state not in (State.SAVED, State.DISCARDED):
            return {"ok": False, "reason": "Episode not finalized yet"}
        # 버퍼 초기화 + episode 참조 해제 (start_teach에서 새 episode 생성하도록)
        self._teach_buffer = []
        self._smoothed_trajectory = []
        self._trajectory_check = {}
        self._episode.current_episode_id = None
        self._episode.current_episode_dir = None
        self._episode.current_take_dir = None
        self._episode._take_num = 0
        if self._piper:
            self._piper.clear_events()
            self._piper.clear_gripper_close_arm_pos()

        # 로봇이 연결되어 있으면 safe_ready 위치로 복귀 후 TEACH_READY
        def _on_home():
            self._add_event_log("Robot at safe ready pose — ready for new episode")
            self._set_state(State.TEACH_READY)

        def _on_home_abort():
            self._add_event_log("Return home failed — reverted to TEACH_READY")
            self._set_state(State.TEACH_READY)

        if self._piper:
            self._set_state(State.RETURN_HOME)
            ok = self._piper.go_to_safe_ready(done_callback=_on_home, abort_callback=_on_home_abort)
            if not ok:
                self._add_event_log("SAFE_RETURN_WAYPOINTS not configured — skipping home move")
                self._set_state(State.TEACH_READY)
        else:
            self._set_state(State.TEACH_READY)

        return {"ok": True}

    def retake_replay(self) -> dict:
        """REVIEW → 동일 trajectory로 재촬영 (속도 변경 가능).
        같은 episode에 새 take를 추가하고 홈 복귀 후 REPLAY_READY."""
        if self.get_state() != State.REVIEW:
            return {"ok": False, "reason": "Not in REVIEW state"}
        if not self._smoothed_trajectory:
            return {"ok": False, "reason": "No trajectory to replay"}
        # 같은 episode에 새 take 추가 (episode 폐기 없음)
        self._episode.add_take()
        if self._piper:
            self._piper.clear_events()
        self._set_state(State.RETURN_HOME)
        self._add_event_log(f"Retake replay (take {self._episode.get_current_take_name()}) — reverse return to teach_start")
        if self._piper:
            ok = self._piper.safe_return_to_start(
                trajectory=self._smoothed_trajectory,
                done_callback=self._on_home_reached,
            )
            if not ok:
                self._add_event_log("safe_return_to_start refused — reverting to TRAJECTORY_CHECK")
                self._set_state(State.TRAJECTORY_CHECK)
        return {"ok": True}

    def retake_teach(self) -> dict:
        """REVIEW → 새 Teaching. 같은 episode에 새 take 추가 후 홈 복귀 → TEACH_READY."""
        if self.get_state() != State.REVIEW:
            return {"ok": False, "reason": "Not in REVIEW state"}
        # 같은 episode에 새 take 추가
        self._episode.add_take()
        self._teach_buffer = []
        self._smoothed_trajectory = []
        self._trajectory_check = {}
        if self._piper:
            self._piper.clear_events()
            self._piper.clear_gripper_close_arm_pos()
        self._add_event_log(f"Retake teach (take {self._episode.get_current_take_name()}) — going to safe ready pose")

        def _on_home_for_teach():
            self._add_event_log("Robot at safe ready pose — ready to re-teach")
            self._set_state(State.TEACH_READY)

        def _on_home_for_teach_abort():
            self._add_event_log("Return home failed — reverted to TEACH_READY. Manually move robot before teaching.")
            self._set_state(State.TEACH_READY)

        if self._piper:
            self._set_state(State.RETURN_HOME)
            ok = self._piper.go_to_safe_ready(done_callback=_on_home_for_teach, abort_callback=_on_home_for_teach_abort)
            if not ok:
                self._add_event_log(
                    "SAFE_RETURN_WAYPOINTS not configured — manual reset required before re-teaching"
                )
                self._set_state(State.TEACH_READY)
        else:
            self._set_state(State.TEACH_READY)
        return {"ok": True}

    def add_take_to_episode(self) -> dict:
        """SAVED → 같은 episode에 새 take 추가 후 홈 복귀 → TEACH_READY."""
        if self.get_state() != State.SAVED:
            return {"ok": False, "reason": "Not in SAVED state"}
        self._episode.add_take()
        self._teach_buffer = []
        self._smoothed_trajectory = []
        self._trajectory_check = {}
        if self._piper:
            self._piper.clear_events()
        self._add_event_log(f"Adding take {self._episode.get_current_take_name()} to episode — going to safe ready pose")

        def _on_home_for_teach():
            self._add_event_log("Robot at safe ready pose — ready for new take")
            self._set_state(State.TEACH_READY)

        def _on_home_for_new_take_abort():
            self._add_event_log("Return home failed — reverted to TEACH_READY. Manually move robot before new take.")
            self._set_state(State.TEACH_READY)

        if self._piper:
            self._set_state(State.RETURN_HOME)
            ok = self._piper.go_to_safe_ready(done_callback=_on_home_for_teach, abort_callback=_on_home_for_new_take_abort)
            if not ok:
                self._add_event_log(
                    "SAFE_RETURN_WAYPOINTS not configured — manual reset required before new take"
                )
                self._set_state(State.TEACH_READY)
        else:
            self._set_state(State.TEACH_READY)
        return {"ok": True, "episode_id": self._episode.current_episode_id}

    # ─────────────────────────────────────────────────────────────────
    # Safety / gripper
    # ─────────────────────────────────────────────────────────────────

    def hold_position(self) -> dict:
        """Soft stop: 현재 position hold"""
        if self._piper:
            self._piper.hold_position()
            self._add_event_log("HOLD POSITION (soft stop)")
        return {"ok": True}

    def motors_enable(self) -> dict:
        """모터 활성화 (Advanced joint control 용)"""
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}
        self._piper.enable_motors()
        self._add_event_log("Motors enabled (manual)")
        return {"ok": True}

    def motors_disable(self) -> dict:
        """모터 비활성화 / freedrive (Advanced joint control 용)"""
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}
        self._piper.disable_motors()
        self._add_event_log("Motors disabled / freedrive (manual)")
        return {"ok": True}

    def gripper_set(self, pct: float) -> dict:
        """그리퍼를 0~100% 위치로 이동. 0=닫힘, 100=완전 열림."""
        if self._piper:
            self._piper.gripper_set(pct)
        return {"ok": True, "pct": pct}

    def gripper_open(self) -> dict:
        if self._piper:
            self._piper.gripper_open()
        return {"ok": True}

    def gripper_close(self) -> dict:
        if self._piper:
            self._piper.gripper_close()
        return {"ok": True}

    def go_back_to_teach(self) -> dict:
        """TRAJECTORY_CHECK / REPLAY_READY → TEACH_READY로 복귀.
        현재 take가 첫 번째이면 episode 전체 폐기, 아니면 현재 take만 폐기."""
        state = self.get_state()
        if state not in (State.TRAJECTORY_CHECK, State.REPLAY_READY):
            return {"ok": False, "reason": f"Cannot go back from state {state.value}"}
        take_num = self._episode._take_num
        if take_num <= 1:
            self._episode.discard_episode()
            self._add_event_log("Went back to TEACH_READY (episode discarded)")
        else:
            self._episode.discard_current_take()
            self._add_event_log(f"Went back to TEACH_READY (take {take_num} discarded, episode kept)")
        self._teach_buffer = []
        self._smoothed_trajectory = []
        self._trajectory_check = {}
        if self._piper:
            self._piper.clear_events()
        self._set_state(State.TEACH_READY)
        return {"ok": True}

    def set_replay_speed(self, speed: float) -> dict:
        clamped = max(0.1, min(2.0, speed))
        self._replay_speed = clamped
        return {"ok": True, "speed_scale": clamped}

    # ─────────────────────────────────────────────────────────────────
    # ROM Calibration
    # ─────────────────────────────────────────────────────────────────

    def _load_joint_limits(self):
        """서버 시작 시 저장된 joint_limits.json 로드 → piper node에 적용."""
        try:
            if not os.path.exists(JOINT_LIMITS_FILE):
                return
            with open(JOINT_LIMITS_FILE) as f:
                limits = json.load(f)
            if self._piper:
                self._piper.set_pm_joint_limits(limits)
            self._add_event_log(f"Joint limits loaded from {JOINT_LIMITS_FILE}")
        except Exception as e:
            self._add_event_log(f"Failed to load joint limits: {e}")

    def start_calibration(self) -> dict:
        """READY / TEACH_READY → CALIBRATING. 모터 OFF, ROM 측정 시작."""
        state = self.get_state()
        if state not in (State.READY, State.TEACH_READY):
            return {"ok": False, "reason": f"Cannot calibrate from state {state.value}"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}
        self._calib_prev_state = state
        self._piper.start_calib()
        self._set_state(State.CALIBRATING)
        self._add_event_log("Calibration started — move arm through full ROM")
        return {"ok": True}

    def stop_calibration(self) -> dict:
        """CALIBRATING → 이전 상태(READY / TEACH_READY). limits 저장 + 적용."""
        if self.get_state() != State.CALIBRATING:
            return {"ok": False, "reason": "Not in CALIBRATING state"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}

        limits = self._piper.stop_calib()

        # piper node에 즉시 적용
        self._piper.set_pm_joint_limits(limits)

        # JSON 저장
        try:
            os.makedirs(os.path.dirname(JOINT_LIMITS_FILE), exist_ok=True)
            with open(JOINT_LIMITS_FILE, "w") as f:
                json.dump(limits, f, indent=2)
            self._add_event_log(f"Joint limits saved → {JOINT_LIMITS_FILE}")
        except Exception as e:
            self._add_event_log(f"Failed to save joint limits: {e}")

        self._set_state(self._calib_prev_state)
        measured = [k for k, v in limits.items() if v.get("measured")]
        self._add_event_log(f"Calibration done — measured: {measured}")
        return {"ok": True, "limits": limits}

    def enable_phone_mouse(self) -> dict:
        """
        Phone Mouse 모드 진입 시 호출.
        - freedrive 5초 타이머 취소 (모터 OFF 방지)
        - 즉시 teach recording 시작 (motors ON 유지)
        TEACH_RECORDING 상태에서만 유효.
        """
        if self.get_state() != State.TEACH_RECORDING:
            return {"ok": False, "reason": "Not in TEACH_RECORDING state"}
        if self._piper is None:
            return {"ok": False, "reason": "Robot not connected"}
        self._piper.begin_teach_recording()
        self._add_event_log("Phone Mouse enabled — recording started (motors ON)")
        return {"ok": True}

    # ─────────────────────────────────────────────────────────────────
    # Phone Mouse (gyro-based joint delta streaming)
    # ─────────────────────────────────────────────────────────────────

    _PM_MAX_DELTA   = 0.05   # rad/step 최대 관절 이동량
    _PM_TIMEOUT_S   = 0.20   # watchdog 타임아웃 (초)

    def _ensure_pm_state(self):
        """phone mouse 관련 state 필드가 없으면 초기화."""
        if not hasattr(self, "_pm_lock"):
            self._pm_lock = threading.Lock()
            self._pm_last_cmd_time: float = 0.0
            self._pm_active: bool = False

    def handle_phone_mouse_cmd(self, data: dict):
        """
        Socket.IO 'phone_mouse_cmd' 이벤트 핸들러.
        data: { j1, j2, j4 (rad delta), seq }
        TEACH_RECORDING 상태에서만 동작.
        """
        if self._piper is None:
            return
        with self._lock:
            if self._state != State.TEACH_RECORDING:
                return

        self._ensure_pm_state()

        mx = self._PM_MAX_DELTA
        j1 = max(-mx, min(mx, float(data.get("j1", 0.0))))
        j2 = max(-mx, min(mx, float(data.get("j2", 0.0))))
        j4 = max(-mx, min(mx, float(data.get("j4", 0.0))))

        with self._pm_lock:
            self._pm_last_cmd_time = time.time()
            if not self._pm_active:
                self._pm_active = True
                threading.Thread(target=self._pm_watchdog, daemon=True).start()

        self._piper.apply_joint_delta(j1=j1, j2=j2, j4=j4)

    def _pm_watchdog(self):
        """200ms 이내에 새 명령이 없으면 pm_active = False 후 종료."""
        while True:
            time.sleep(0.05)
            with self._pm_lock:
                if time.time() - self._pm_last_cmd_time > self._PM_TIMEOUT_S:
                    self._pm_active = False
                    return

    def handle_ee_twist_cmd(self, data: dict):
        """
        Socket.IO 'ee_twist_cmd' 이벤트 핸들러 — Cartesian jog.
        data: { vx, vy, vz, wx, wy, wz (m/s or rad/s), dt (s) }
        TEACH_RECORDING 상태에서만 동작.
        """
        if self._piper is None:
            return
        with self._lock:
            if self._state != State.TEACH_RECORDING:
                return

        self._ensure_pm_state()
        with self._pm_lock:
            self._pm_last_cmd_time = time.time()
            if not self._pm_active:
                self._pm_active = True
                threading.Thread(target=self._pm_watchdog, daemon=True).start()

        self._piper.apply_ee_twist(
            vx=float(data.get("vx", 0.0)),
            vy=float(data.get("vy", 0.0)),
            vz=float(data.get("vz", 0.0)),
            wx=float(data.get("wx", 0.0)),
            wy=float(data.get("wy", 0.0)),
            wz=float(data.get("wz", 0.0)),
            dt=float(data.get("dt", 0.05)),
        )

    # ─────────────────────────────────────────────────────────────────
    # Diagnostics
    # ─────────────────────────────────────────────────────────────────

    def get_diagnostics(self) -> dict:
        return {
            "state": self.get_state().value,
            "piper_connected": self._piper is not None,
            "cameras_connected": self._cameras.any_available if self._cameras else False,
            "ros_ok": rclpy.ok() if rclpy else False,
            "teach_buffer_len": len(self._teach_buffer),
            "trajectory_check": self._trajectory_check,
            "episode_id": self._episode.current_episode_id,
            "event_log_len": len(self._event_log),
        }

    # ─────────────────────────────────────────────────────────────────
    # Shutdown
    # ─────────────────────────────────────────────────────────────────

    def shutdown(self):
        self._poll_stop.set()
        if self._realsense:
            try:
                self._realsense.stop_stream()
            except Exception:
                pass
        if self._ros_executor:
            try:
                self._ros_executor.shutdown()
            except Exception:
                pass
        if rclpy.ok():
            rclpy.shutdown()
        print("[Controller] Shutdown complete")
