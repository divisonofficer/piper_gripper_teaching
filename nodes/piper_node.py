"""
PiperTeachReplayNode
---------------------
두 가지 모드:
  TEACH  : /joint_states_single 구독 → teach_buffer 에 (t_host_ns, q1..q6, gripper) 기록
  REPLAY : smoothed trajectory → /joint_ctrl_single 발행 + executed_buffer 기록

gripper는 별도 이벤트(gripper_open / gripper_close)로 처리.
실제 E-stop은 CAN/물리 수준이므로, 여기서는 "현재 position hold" soft-stop만 제공.
"""

import time
import threading
from collections import deque
from typing import Callable, Optional

import numpy as np
from scipy.signal import savgol_filter

try:
    import pinocchio as pin
    _PIN_AVAILABLE = True
except ImportError:
    _PIN_AVAILABLE = False

import rclpy
from rclpy.node import Node
from sensor_msgs.msg import JointState
from std_msgs.msg import Bool

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import (
    ROS_PIPER_JOINT_STATE_TOPIC,
    ROS_PIPER_JOINT_CTRL_TOPIC,
    TEACH_LOG_HZ,
    REPLAY_DEFAULT_SPEED,
    REPLAY_SMOOTHING_WINDOW,
    REPLAY_SMOOTHING_POLYORDER,
    MAX_JOINT_VELOCITY_RAD_S,
    MAX_WAYPOINT_DELTA_RAD,
    HOME_VELOCITY,
    HOME_WAIT_S,
    GRIPPER_OPEN_RAD,
    GRIPPER_CLOSE_RAD,
    GRIPPER_VELOCITY,
    GRIPPER_STEPS,
    GRIPPER_STEP_DELAY,
)

DOF = 6  # Piper 6-DOF arm (그리퍼 제외)


class PiperTeachReplayNode(Node):

    def __init__(self, on_state_update: Optional[Callable] = None):
        """
        on_state_update: 10Hz 폴링 대신 joint callback마다 호출할 콜백 (optional).
                         Controller 가 소켓 emit에 쓸 수 있음.
        """
        super().__init__("piper_teach_replay")

        self.on_state_update = on_state_update

        # ── publishers / subscribers ──────────────────────────────────
        self.pub = self.create_publisher(JointState, ROS_PIPER_JOINT_CTRL_TOPIC, 10)
        self.enable_pub = self.create_publisher(Bool, 'enable_flag', 1)
        self.sub = self.create_subscription(
            JointState, ROS_PIPER_JOINT_STATE_TOPIC, self._joint_callback, 10
        )

        # ── shared state ──────────────────────────────────────────────
        self._lock = threading.Lock()
        self._mode = "IDLE"           # IDLE | TEACH | REPLAY | HOLD

        self._latest_position = [0.0] * (DOF + 1)  # q1..q6 + gripper
        self._latest_velocity = [0.0] * (DOF + 1)
        self._latest_t_ns = 0

        self._joint_hz_counter = 0
        self._joint_hz = 0.0
        self._hz_window_start = time.time()

        # ── teach buffer ──────────────────────────────────────────────
        self._teach_buffer: list[dict] = []
        self._teach_start_t: Optional[int] = None
        self._last_teach_log_t = 0.0   # host timestamp for throttling
        self._teach_disable_timer: Optional[threading.Timer] = None

        # ── motor enable state ────────────────────────────────────────
        self._motors_enabled = True

        # ── executed buffer (replay 중) ───────────────────────────────
        self._executed_buffer: list[dict] = []

        # ── replay ───────────────────────────────────────────────────
        self._replay_thread: Optional[threading.Thread] = None
        self._replay_stop_event = threading.Event()
        self._replay_command_buffer: list[dict] = []
        self._replay_progress: float = 0.0   # 0.0~1.0, 재생 진행률

        # ── events log (gripper 등) ───────────────────────────────────
        self._events: list[dict] = []

        # ── Phone Mouse 관절 한계 (calibration 전까지 기본값) ─────────
        # (min_rad, max_rad) per joint — set_pm_joint_limits()로 업데이트
        self._pm_joint_limits: list[tuple] = [
            (-2.618,  2.618),   # j1: base rotation
            (-0.5,    1.8),     # j2: shoulder — 기본 보수값 (calibration 후 갱신)
            (-1.8,    2.618),   # j3: elbow
            (-2.618,  2.618),   # j4: wrist pitch
            (-2.618,  2.618),   # j5: wrist roll
            (-2.618,  2.618),   # j6: wrist yaw
        ]

        # ── Calibration (ROM 측정) ────────────────────────────────────
        self._calib_active = False
        self._calib_min = [float("inf")]  * DOF
        self._calib_max = [float("-inf")] * DOF

        # ── gripper state (command 기준) ──────────────────────────────
        self._gripper_cmd = 0.0  # 0 = open, 1 = close (normalized)
        # 그리퍼를 닫은 순간의 arm 위치 (return_home 시 해당 위치에서 gripper open)
        self._gripper_close_arm_pos: Optional[list] = None

        # ── Pinocchio (Cartesian jog IK) ─────────────────────────────
        self._pin_model = None
        self._pin_data = None
        self._pin_ee_id = 6  # joint6 = last arm joint (joints 1-6 = arm, 7-8 = gripper)
        if _PIN_AVAILABLE:
            self._load_urdf()

        self.get_logger().info("PiperTeachReplayNode initialized")

    # ─────────────────────────────────────────────────────────────────
    # ROS2 callback
    # ─────────────────────────────────────────────────────────────────

    def _joint_callback(self, msg: JointState):
        t_host_ns = time.time_ns()

        with self._lock:
            if msg.position:
                self._latest_position = list(msg.position[:DOF + 1])
            if msg.velocity:
                self._latest_velocity = list(msg.velocity[:DOF + 1])
            self._latest_t_ns = t_host_ns
            mode = self._mode

            # Hz 계산
            self._joint_hz_counter += 1
            now = time.time()
            elapsed = now - self._hz_window_start
            if elapsed >= 1.0:
                self._joint_hz = self._joint_hz_counter / elapsed
                self._joint_hz_counter = 0
                self._hz_window_start = now

        # Calibration: 관절 min/max 추적
        if self._calib_active:
            with self._lock:
                pos = self._latest_position[:DOF]
            for i in range(DOF):
                self._calib_min[i] = min(self._calib_min[i], pos[i])
                self._calib_max[i] = max(self._calib_max[i], pos[i])

        # TEACH 기록 (throttle to TEACH_LOG_HZ)
        if mode == "TEACH":
            interval = 1.0 / TEACH_LOG_HZ
            now_f = time.time()
            if now_f - self._last_teach_log_t >= interval:
                self._last_teach_log_t = now_f
                row = self._make_joint_row(t_host_ns, tag="teach")
                with self._lock:
                    self._teach_buffer.append(row)

        # REPLAY 중 executed 기록
        elif mode == "REPLAY":
            row = self._make_joint_row(t_host_ns, tag="replay")
            with self._lock:
                self._executed_buffer.append(row)

        if self.on_state_update:
            self.on_state_update(self.get_state())

    def _make_joint_row(self, t_host_ns: int, tag: str) -> dict:
        with self._lock:
            pos = self._latest_position.copy()
            vel = self._latest_velocity.copy()

        row: dict = {"t_host_ns": t_host_ns, "mode": tag}
        for i in range(DOF):
            row[f"q{i+1}"] = pos[i] if i < len(pos) else 0.0
        row["gripper"] = pos[DOF] if DOF < len(pos) else 0.0
        for i in range(DOF):
            row[f"dq{i+1}"] = vel[i] if i < len(vel) else 0.0
        return row

    # ─────────────────────────────────────────────────────────────────
    # State queries
    # ─────────────────────────────────────────────────────────────────

    def get_state(self) -> dict:
        with self._lock:
            return {
                "position": self._latest_position[:DOF],
                "gripper": self._latest_position[DOF] if len(self._latest_position) > DOF else 0.0,
                "velocity": self._latest_velocity[:DOF],
                "is_moving": any(abs(v) > 0.05 for v in self._latest_velocity[:DOF]),
                "mode": self._mode,
                "hz": round(self._joint_hz, 1),
                "t_ns": self._latest_t_ns,
                "replay_progress": round(self._replay_progress, 3),
            }

    def get_mode(self) -> str:
        with self._lock:
            return self._mode

    def is_moving(self) -> bool:
        with self._lock:
            return any(abs(v) > 0.05 for v in self._latest_velocity[:DOF])

    # ─────────────────────────────────────────────────────────────────
    # Teach
    # ─────────────────────────────────────────────────────────────────

    def start_teach(self, disable_delay: float = 5.0):
        """
        Teaching 시작.
        disable_delay 초 후에 모터를 비활성화해 손으로 자유롭게 움직일 수 있게 함.
        _mode 는 모터 비활성화 시점까지 IDLE 유지 → 카운트다운 중 joint callback 미기록.
        """
        with self._lock:
            self._mode = "IDLE"  # 아직 recording 시작 안 함
            self._teach_buffer.clear()
            self._teach_start_t = None
            self._last_teach_log_t = 0.0

        # 이전 타이머 정리
        if self._teach_disable_timer is not None:
            self._teach_disable_timer.cancel()

        def _on_disable():
            self.disable_motors()
            with self._lock:
                self._mode = "TEACH"  # 모터 비활성화 후 recording 시작
                self._teach_start_t = time.time_ns()
                self._last_teach_log_t = 0.0
            self._log_event("teach_recording_started")
            self.get_logger().info("Teach recording started (motors disabled)")

        # disable_delay 초 후 모터 비활성화 + recording 시작
        self._teach_disable_timer = threading.Timer(disable_delay, _on_disable)
        self._teach_disable_timer.daemon = True
        self._teach_disable_timer.start()

        self._log_event(f"teach_start (motors_off_in={disable_delay:.0f}s)")
        self.get_logger().info(f"Teach started — motors will disable in {disable_delay}s")

    def begin_teach_recording(self):
        """
        모터를 건드리지 않고 즉시 recording 시작.
        Phone Mouse 모드에서 "Enable Phone Mouse" 클릭 시 호출.
        - 5초 freedrive 타이머가 걸려 있으면 취소 (모터 OFF 방지)
        - _mode = "TEACH" 로 전환 → _joint_callback 이 teach_buffer 기록 시작
        """
        # freedrive 타이머 취소 (아직 안 끝났으면)
        if self._teach_disable_timer is not None:
            self._teach_disable_timer.cancel()
            self._teach_disable_timer = None

        with self._lock:
            if self._mode == "TEACH":
                return  # 이미 recording 중
            self._mode = "TEACH"
            self._teach_buffer.clear()
            self._teach_start_t = time.time_ns()
            self._last_teach_log_t = 0.0

        self._log_event("teach_recording_started (phone_mouse, motors_on)")
        self.get_logger().info("Phone Mouse teach recording started (motors ON)")

    def stop_teach(self) -> list[dict]:
        # 타이머가 아직 안 끝났으면 취소
        if self._teach_disable_timer is not None:
            self._teach_disable_timer.cancel()
            self._teach_disable_timer = None

        # 모터 재활성화 (비활성화 상태일 경우)
        self.enable_motors()

        with self._lock:
            self._mode = "IDLE"
            buf = self._teach_buffer.copy()
        self._log_event("teach_stop")
        self.get_logger().info(f"Teach recording stopped: {len(buf)} samples")
        return buf

    # ─────────────────────────────────────────────────────────────────
    # Trajectory smoothing & validation
    # ─────────────────────────────────────────────────────────────────

    @staticmethod
    def smooth_trajectory(teach_buffer: list[dict], speed_scale: float = REPLAY_DEFAULT_SPEED) -> tuple[list[dict], dict]:
        """
        teach_buffer를 실제 timestamp 기반 resampling + Savitzky-Golay smoothing.
        Returns (smoothed_trajectory, check_result)
        """
        from scipy.interpolate import interp1d as _interp1d

        if len(teach_buffer) < REPLAY_SMOOTHING_WINDOW + 2:
            return teach_buffer, {"ok": False, "reason": "Too few samples to smooth"}

        keys = [f"q{i+1}" for i in range(DOF)]
        arr = np.array([[r[k] for k in keys] for r in teach_buffer])  # (N, 6)

        # ── 실제 teach timestamp 추출 (단조 보장) ────────────────────────
        t_raw = np.array(
            [(r["t_host_ns"] - teach_buffer[0]["t_host_ns"]) * 1e-9 for r in teach_buffer],
            dtype=float,
        )
        for i in range(1, len(t_raw)):
            if t_raw[i] <= t_raw[i - 1]:
                t_raw[i] = t_raw[i - 1] + 1e-3

        # ── 실제 duration 기반 uniform 50Hz grid ─────────────────────────
        dt = 1.0 / TEACH_LOG_HZ
        t_uni = np.arange(0, t_raw[-1] + 0.5 * dt, dt)  # +0.5*dt: 마지막 pose 잘림 방지

        # ── Joint: linear interpolation → resample to uniform grid ───────
        interp_fn = _interp1d(
            t_raw, arr, axis=0, kind="linear",
            bounds_error=False, fill_value=(arr[0], arr[-1]),
        )
        arr_resampled = interp_fn(t_uni)

        # ── Gripper: nearest-neighbor (state 전환 보존) ───────────────────
        g_raw = np.array([r.get("gripper", 0.0) for r in teach_buffer])
        g_fn = _interp1d(
            t_raw, g_raw, kind="nearest",
            bounds_error=False, fill_value=(g_raw[0], g_raw[-1]),
        )
        gripper_resampled = g_fn(t_uni)

        # ── Savitzky-Golay smoothing ──────────────────────────────────────
        window = REPLAY_SMOOTHING_WINDOW
        if window > len(arr_resampled):
            window = len(arr_resampled) if len(arr_resampled) % 2 == 1 else len(arr_resampled) - 1

        smoothed = savgol_filter(arr_resampled, window_length=window, polyorder=REPLAY_SMOOTHING_POLYORDER, axis=0)

        # Velocity check (finite differences at uniform 50Hz)
        velocity = np.diff(smoothed, axis=0) / dt
        max_vel = float(np.max(np.abs(velocity)))

        actual_duration = float(t_raw[-1])
        check = {
            "ok": True,
            "duration_s": round(actual_duration, 2),
            "samples": len(smoothed),
            "max_joint_velocity_rad_s": round(max_vel, 4),
            "velocity_limit_ok": max_vel <= MAX_JOINT_VELOCITY_RAD_S,
            "speed_scale": speed_scale,
        }

        if not check["velocity_limit_ok"]:
            check["ok"] = False
            check["reason"] = f"Max velocity {max_vel:.3f} rad/s exceeds limit {MAX_JOINT_VELOCITY_RAD_S}"

        # Waypoint delta check
        deltas = np.abs(np.diff(smoothed, axis=0))
        max_delta = float(np.max(deltas))
        check["max_waypoint_delta_rad"] = round(max_delta, 4)
        check["waypoint_delta_ok"] = max_delta <= MAX_WAYPOINT_DELTA_RAD

        # ── Build result rows (실제 timestamp 기반) ───────────────────────
        t0_ns = teach_buffer[0]["t_host_ns"]
        result = []
        for i, (row_s, grip) in enumerate(zip(smoothed, gripper_resampled)):
            r = {f"q{j+1}": float(row_s[j]) for j in range(DOF)}
            r["t_host_ns"] = t0_ns + int(t_uni[i] * 1e9)
            r["gripper"] = float(grip)
            result.append(r)

        return result, check

    # ─────────────────────────────────────────────────────────────────
    # Home
    # ─────────────────────────────────────────────────────────────────

    def _wait_until_close(
        self,
        target: list,
        tol: float = 0.05,
        vel_tol: float = 0.12,
        timeout: float = 8.0,
    ) -> bool:
        """
        피드백 기반 도착 확인.
        pos_err < tol AND max_vel < vel_tol → True 반환.
        timeout 초 초과 → False (경고 로그 출력).
        """
        t0 = time.time()
        n = min(len(target), DOF)
        pos_err = float("inf")
        max_vel = float("inf")
        while time.time() - t0 < timeout:
            with self._lock:
                cur = list(self._latest_position[:DOF])
                vel = list(self._latest_velocity[:DOF])
            if len(cur) < n:
                time.sleep(0.03)
                continue
            pos_err = max(abs(cur[i] - target[i]) for i in range(n))
            max_vel = max(abs(v) for v in vel[:n]) if vel else 0.0
            if pos_err < tol and max_vel < vel_tol:
                return True
            time.sleep(0.03)
        self.get_logger().warn(
            f"_wait_until_close timeout: pos_err={pos_err:.3f}rad vel={max_vel:.3f}rad/s"
        )
        return False

    def _follow_home_waypoints(
        self,
        waypoints: list,
        done_callback: Optional[Callable] = None,
        gripper_during: Optional[float] = None,
        gripper_after: Optional[float] = None,
    ) -> bool:
        """
        검증된 waypoint sequence를 순서대로 실행하는 안전 복귀 primitive.
        각 waypoint 도착 실패(timeout) 시 그 자리에서 abort — 다음 waypoint로 진행하지 않는다.
        done_callback은 모든 waypoint 도착 성공 시에만 호출된다.
        """
        if not waypoints:
            self.get_logger().error("_follow_home_waypoints: empty waypoints — refused.")
            return False

        def _loop():
            self.enable_motors()
            time.sleep(0.3)

            with self._lock:
                gripper_now = (
                    self._latest_position[DOF]
                    if len(self._latest_position) > DOF
                    else 0.0
                )
            grip = gripper_during if gripper_during is not None else gripper_now

            for idx, wp in enumerate(waypoints):
                with self._lock:
                    cur = list(self._latest_position[:DOF])

                max_dist = max(abs(cur[i] - wp[i]) for i in range(min(DOF, len(wp))))
                timeout = max(4.0, max_dist / 0.25 + 1.0)

                self.get_logger().info(
                    f"safe_home waypoint {idx}/{len(waypoints)-1}: "
                    f"{[round(x, 3) for x in wp]}, dist={max_dist:.3f}rad, timeout={timeout:.1f}s"
                )

                self._publish_joint_cmd(wp, velocity=HOME_VELOCITY, gripper=grip)
                reached = self._wait_until_close(wp[:DOF], tol=0.05, timeout=timeout)

                if not reached:
                    self.get_logger().error(
                        f"safe_home waypoint {idx} not reached in {timeout:.1f}s — aborting. "
                        f"Robot stopped at current position."
                    )
                    self._log_event(f"safe_home_abort_waypoint_{idx}")
                    return  # abort — done_callback 호출 금지

            if gripper_after is not None:
                self._gripper_move(gripper_after)

            self._log_event("safe_home_done")
            self.get_logger().info("safe_home: all waypoints reached")
            if done_callback:
                done_callback()

        threading.Thread(target=_loop, daemon=True).start()
        return True

    def safe_return_to_start(
        self,
        trajectory: list,
        done_callback: Optional[Callable] = None,
    ) -> bool:
        """
        recorded trajectory를 역방향으로 따라 teach_start까지 안전 복귀.

        - gripper OPEN↔CLOSE 전환점은 downsample 시에도 반드시 포함
        - 각 waypoint에서 _wait_until_close() 도착 확인
        - 도착 실패 시 해당 위치에서 abort (다음 waypoint 진행 금지, done_callback 호출 금지)
        - done_callback은 teach_start 도달 성공 시에만 호출
        - gripper 처리: trajectory gripper 필드 역방향 상태 전환 감지 → OPEN/CLOSE 자동 처리
        """
        if not trajectory:
            self.get_logger().error("safe_return_to_start: empty trajectory — refused.")
            return False

        _GRIPPER_MID = (GRIPPER_OPEN_RAD + GRIPPER_CLOSE_RAD) / 2.0
        n = len(trajectory)

        # ── 그리퍼 전환 인덱스 추출 (forward trajectory) ──────────────
        # 이 인덱스들은 downsample 후에도 반드시 포함
        transition_fwd: set = set()
        _prev_g_open = None
        for i, wp in enumerate(trajectory):
            g = wp.get("gripper")
            if g is None:
                continue
            g_open = g > _GRIPPER_MID
            if g_open != _prev_g_open and _prev_g_open is not None:
                transition_fwd.update([max(0, i - 1), i])
            _prev_g_open = g_open

        # ── 현재 로봇 위치에서 가장 가까운 trajectory 시작점 탐색 ─────
        # replay 후 tracking error로 인해 trajectory[-1]과 실제 위치가 다를 수 있음.
        # 후반부 50%에서만 탐색 (앞부분은 실제로 진행된 구간이 아닐 가능성 높음).
        with self._lock:
            cur_pos = list(self._latest_position[:DOF])

        start_fwd_idx = n - 1  # 기본값: 마지막 waypoint
        if len(cur_pos) >= DOF:
            best_err = float("inf")
            search_start = max(0, n // 2)
            for i in range(search_start, n):
                q = [trajectory[i].get(f"q{j+1}", 0.0) for j in range(DOF)]
                err = max(abs(cur_pos[k] - q[k]) for k in range(DOF))
                if err < best_err:
                    best_err = err
                    start_fwd_idx = i
            self.get_logger().info(
                f"safe_return_to_start: nearest fwd_idx={start_fwd_idx}/{n-1} "
                f"(pos_err={best_err:.3f}rad)"
            )

        # ── reverse + downsample (~50 waypoints) ─────────────────────
        relevant_transitions = {i for i in transition_fwd if i <= start_fwd_idx}
        stride = max(1, start_fwd_idx // 50) if start_fwd_idx > 0 else 1
        must_include = {0, start_fwd_idx} | relevant_transitions
        fwd_indices = sorted(
            set(range(start_fwd_idx, -1, -stride)) | must_include,
            reverse=True,   # end → start 순서 (역방향)
        )
        sampled = [trajectory[i] for i in fwd_indices]

        self.get_logger().info(
            f"safe_return_to_start: {n} waypoints → {len(sampled)} sampled "
            f"(stride={stride}, gripper transitions={len(relevant_transitions)//2})"
        )
        return self._execute_reverse_path(sampled, done_callback)

    def _execute_reverse_path(
        self,
        waypoints: list,
        done_callback: Optional[Callable] = None,
    ) -> bool:
        """
        역방향 waypoint sequence를 순차 실행.
        각 waypoint 도착 실패 시 abort. done_callback은 전체 성공 시에만 호출.
        """
        if not waypoints:
            self.get_logger().error("_execute_reverse_path: empty waypoints.")
            return False

        _GRIPPER_MID = (GRIPPER_OPEN_RAD + GRIPPER_CLOSE_RAD) / 2.0
        RETURN_VELOCITY = 20.0   # MotionCtrl_2 % — replay보다 느리게

        def _loop():
            self.enable_motors()
            time.sleep(0.3)

            prev_gripper_is_open: Optional[bool] = None
            total = len(waypoints)

            for idx, wp in enumerate(waypoints):
                q = [wp.get(f"q{j+1}", 0.0) for j in range(DOF)]
                gripper_raw = wp.get("gripper")

                # 그리퍼 상태 전환 감지 (_replay_loop과 동일 로직)
                gripper_cmd: Optional[float] = None
                if gripper_raw is not None:
                    g_open = gripper_raw > _GRIPPER_MID
                    if g_open != prev_gripper_is_open:
                        if prev_gripper_is_open is not None:
                            # 실제 전환 — 명령 발행
                            gripper_cmd = GRIPPER_OPEN_RAD if g_open else GRIPPER_CLOSE_RAD
                            self.get_logger().info(
                                f"[ReverseReturn] Gripper {'OPEN' if g_open else 'CLOSE'} "
                                f"@ waypoint {idx}/{total-1}"
                            )
                        prev_gripper_is_open = g_open

                with self._lock:
                    cur = list(self._latest_position[:DOF])

                max_dist = max(abs(cur[i] - q[i]) for i in range(DOF)) if cur else 0.0
                # 보수적 timeout: 20% velocity ≈ 0.05 rad/s 기준 (실측치)
                timeout = max(10.0, max_dist / 0.05 + 2.0)

                self._publish_joint_cmd(q, velocity=RETURN_VELOCITY, gripper=gripper_cmd)

                reached = self._wait_until_close(q, tol=0.06, vel_tol=0.20, timeout=timeout)
                if not reached:
                    self.get_logger().error(
                        f"[ReverseReturn] Waypoint {idx}/{total-1} not reached "
                        f"(max_dist={max_dist:.3f}rad, timeout={timeout:.1f}s) — aborting."
                    )
                    self._log_event(f"reverse_return_abort_{idx}")
                    return  # ★ abort — done_callback 호출 금지

                # 그리퍼 명령 후 actuation 대기
                if gripper_cmd is not None:
                    time.sleep(GRIPPER_STEPS * GRIPPER_STEP_DELAY + 0.2)

            self._log_event("reverse_return_done")
            self.get_logger().info("[ReverseReturn] Reached teach_start successfully.")
            if done_callback:
                done_callback()

        threading.Thread(target=_loop, daemon=True).start()
        return True

    def go_to_safe_ready(
        self,
        done_callback: Optional[Callable] = None,
        gripper_after: Optional[float] = None,
    ) -> bool:
        """
        저장된 safe return waypoints 순서대로 이동.
        우선순위: dataset/safe_return_waypoints.json (UI로 기록) → config.SAFE_RETURN_WAYPOINTS
        둘 다 없으면 이동을 거부하고 False를 반환한다.
        done_callback은 모든 waypoint 도착 성공 시에만 호출된다.
        """
        import json as _json
        import os as _os
        from config import SAFE_RETURN_WAYPOINTS, DATASET_PATH

        waypoints = None

        # 1순위: UI로 저장한 JSON 파일
        wp_file = _os.path.join(DATASET_PATH, "safe_return_waypoints.json")
        if _os.path.exists(wp_file):
            try:
                with open(wp_file) as f:
                    data = _json.load(f)
                if data and isinstance(data, list):
                    waypoints = data
            except Exception as e:
                self.get_logger().warn(f"go_to_safe_ready: failed to read {wp_file}: {e}")

        # 2순위: config.py 정적 설정
        if not waypoints and SAFE_RETURN_WAYPOINTS:
            waypoints = SAFE_RETURN_WAYPOINTS

        if not waypoints:
            self.get_logger().error(
                "go_to_safe_ready(): no safe waypoints defined — movement refused. "
                "Record waypoints in the Setup page."
            )
            self._log_event("safe_home_refused_no_waypoints")
            return False

        self.get_logger().info(
            f"go_to_safe_ready: {len(waypoints)} waypoints (source={'file' if _os.path.exists(wp_file) else 'config'})"
        )
        return self._follow_home_waypoints(
            waypoints=waypoints,
            done_callback=done_callback,
            gripper_after=gripper_after,
        )

    def go_home(
        self,
        home_position: Optional[list] = None,
        done_callback: Optional[Callable] = None,
        gripper_during: Optional[float] = None,   # 이동 중 유지할 그리퍼 위치
        gripper_after: Optional[float] = None,    # 도착 후 열 그리퍼 위치
    ) -> bool:
        """
        단일 target pose로 이동 (return_home / go_home_with_release 내부용).
        home_position: q1..q6 (rad). None이면 이동을 거부하고 False를 반환한다.
        도착 실패(timeout) 시에도 done_callback을 호출한다 (복귀 흐름 유지).
        ★ 직접 호출 금지 — 안전 복귀에는 go_to_safe_ready() / _follow_home_waypoints() 사용.
        """
        if home_position is None:
            self.get_logger().error(
                "go_home() requires explicit home_position — movement refused."
            )
            self._log_event("go_home_refused_no_target")
            return False

        pos = list(home_position)
        self.get_logger().info(f"go_home target: {[round(p, 3) for p in pos]}")

        def _sequential():
            self.enable_motors()
            time.sleep(0.5)

            with self._lock:
                current = list(self._latest_position[:DOF])
                gripper_now = (
                    self._latest_position[DOF]
                    if len(self._latest_position) > DOF
                    else 0.0
                )

            grip = gripper_during if gripper_during is not None else gripper_now
            self.get_logger().info(f"  current:  {[round(p, 3) for p in current]}")
            self.get_logger().info(f"  gripper:  {grip:.3f}")

            # Phase 1: J4, J5, J6 먼저 — 손목을 접어 엔드이펙터 반경 최소화
            working = list(current)
            group1 = [3, 4, 5]
            max_dist_1 = max(abs(current[i] - pos[i]) for i in group1)
            if max_dist_1 >= 0.01:
                for i in group1:
                    working[i] = pos[i]
                timeout1 = max(4.0, max_dist_1 / 0.25 + 1.0)
                self.get_logger().info(
                    f"  J4-6: dist={max_dist_1:.3f} rad, timeout={timeout1:.1f}s"
                )
                self._publish_joint_cmd(working, velocity=HOME_VELOCITY, gripper=grip)
                if not self._wait_until_close(working[:DOF], tol=0.05, timeout=timeout1):
                    self.get_logger().warn(
                        f"go_home: J4-6 did not converge in {timeout1:.1f}s — continuing"
                    )

            # Phase 2: J1, J2, J3 — 어깨/팔꿈치 이동
            group2 = [0, 1, 2]
            max_dist_2 = max(abs(current[i] - pos[i]) for i in group2)
            if max_dist_2 >= 0.01:
                for i in group2:
                    working[i] = pos[i]
                timeout2 = max(4.0, max_dist_2 / 0.25 + 1.0)
                self.get_logger().info(
                    f"  J1-3: dist={max_dist_2:.3f} rad, timeout={timeout2:.1f}s"
                )
                self._publish_joint_cmd(working, velocity=HOME_VELOCITY, gripper=grip)
                if not self._wait_until_close(working[:DOF], tol=0.05, timeout=timeout2):
                    self.get_logger().warn(
                        f"go_home: J1-3 did not converge in {timeout2:.1f}s — continuing"
                    )

            if max_dist_1 < 0.01 and max_dist_2 < 0.01:
                self.get_logger().info("go_home: already at target (no movement needed)")

            if gripper_after is not None:
                self._gripper_move(gripper_after)
            if done_callback:
                done_callback()

        threading.Thread(target=_sequential, daemon=True).start()
        return True

    def go_home_with_release(
        self,
        teach_start: list,
        gripper_close_pos: list,
        done_callback: Optional[Callable] = None,
    ):
        """
        [DEPRECATED] — use safe_return_to_start() instead.
        safe_return_to_start()는 trajectory gripper 필드를 자동 감지해
        grasp 위치에서 gripper를 열고 역방향 경로로 복귀한다.

        2-phase return home with object release at pickup location.
        Phase 1: arm → gripper_close_pos  (gripper stays CLOSED — holding object)
        Phase 2: open gripper (release object) → arm → teach_start
        """
        self.get_logger().info(
            f"go_home_with_release: phase1={[round(p, 3) for p in gripper_close_pos]}, "
            f"phase2={[round(p, 3) for p in teach_start]}"
        )

        def _phase2():
            # Release object at the exact position where it was picked up
            self._gripper_move(GRIPPER_OPEN_RAD)
            time.sleep(GRIPPER_STEPS * GRIPPER_STEP_DELAY + 0.3)
            # Now move arm back to teaching start
            self.go_home(home_position=teach_start, done_callback=done_callback)

        # Phase 1: travel to pickup position keeping gripper closed
        self.go_home(
            home_position=gripper_close_pos,
            done_callback=_phase2,
            gripper_during=GRIPPER_CLOSE_RAD,
        )

    # ─────────────────────────────────────────────────────────────────
    # Replay
    # ─────────────────────────────────────────────────────────────────

    def start_replay(
        self,
        trajectory: list[dict],
        speed_scale: float = REPLAY_DEFAULT_SPEED,
        done_callback: Optional[Callable] = None,
    ):
        if self._replay_thread and self._replay_thread.is_alive():
            self.get_logger().warn("Replay already running")
            return False

        self._replay_stop_event.clear()
        with self._lock:
            self._mode = "REPLAY"
            self._executed_buffer.clear()
            self._replay_command_buffer.clear()

        self._log_event("replay_start")
        self._replay_thread = threading.Thread(
            target=self._replay_loop,
            args=(trajectory, speed_scale, done_callback),
            daemon=True,
        )
        self._replay_thread.start()
        return True

    def _replay_loop(self, trajectory: list[dict], speed_scale: float, done_callback: Optional[Callable]):
        self.get_logger().info(f"Replay loop started: {len(trajectory)} waypoints, speed={speed_scale}")
        dt = 1.0 / TEACH_LOG_HZ / speed_scale  # 실제 간격 (속도 배율 적용)

        # ── 그리퍼 재생 전략 ──────────────────────────────────────────────
        # 문제: teach 데이터의 gripper 값은 연속적으로 변하는 소수값(예: 0.069→0.006).
        # 매 waypoint마다 미세한 delta를 GripperCtrl로 보내면 드라이버 deadband 이하라
        # 하드웨어가 전혀 반응하지 않음.
        # 해결: OPEN/CLOSE 상태 전환을 감지 → 정해진 target(GRIPPER_OPEN/CLOSE_RAD)으로
        #       snap 명령. 닫을 때는 최대 힘(3N/m)으로 물체를 확실히 파지.
        _GRIPPER_MID = (GRIPPER_OPEN_RAD + GRIPPER_CLOSE_RAD) / 2.0  # 0.035 rad

        # ── 그리퍼 전환 직전 keyframe 사전 계산 ──────────────────────────
        # 각 OPEN↔CLOSE 전환점 바로 직전 waypoint에서 도착을 확인한 뒤 gripper cmd를 보냄.
        # 전환점마다 대표 1개만 (여러 개 wait은 replay 지연 유발).
        gripper_keyframes: set = set()
        _prev_g_open = None
        for _ki, _wp in enumerate(trajectory):
            _g = _wp.get("gripper")
            if _g is None:
                continue
            _g_open = _g > _GRIPPER_MID
            if _g_open != _prev_g_open and _prev_g_open is not None:
                gripper_keyframes.add(max(0, _ki - 1))
            _prev_g_open = _g_open

        # ── 초기 그리퍼 상태 설정 ──────────────────────────────────────────
        # trajectory 첫 번째 gripper 값으로 initial state 초기화.
        # prev_gripper_is_open = None 상태로 루프 진입하면 첫 waypoint에서
        # "None → CLOSED" 가짜 전환이 감지되어 replay 시작 즉시 그리퍼가 닫힘.
        # 해결: 루프 전에 initial state를 설정하고 그리퍼를 해당 위치로 이동.
        first_gripper = next(
            (wp.get("gripper") for wp in trajectory if wp.get("gripper") is not None), None
        )
        if first_gripper is not None:
            initial_is_open = first_gripper > _GRIPPER_MID
            initial_cmd = GRIPPER_OPEN_RAD if initial_is_open else GRIPPER_CLOSE_RAD
            self.get_logger().info(
                f"[Replay] Initial gripper: {'OPEN' if initial_is_open else 'CLOSE'} "
                f"(raw={first_gripper:.4f}, target={initial_cmd:.3f})"
            )
            threading.Thread(target=self._gripper_move, args=(initial_cmd,), daemon=True).start()
            time.sleep(0.4)  # 그리퍼 초기 이동 대기
            prev_gripper_is_open: Optional[bool] = initial_is_open
            gripper_cmd_val: Optional[float] = initial_cmd
        else:
            prev_gripper_is_open: Optional[bool] = None
            gripper_cmd_val: Optional[float] = None
        gripper_cmd_effort: float = 1.0            # 발행할 effort (N/m)

        cmd_velocity = 100.0 * speed_scale  # MotionCtrl_2 속도% (드라이버 velocity[0] 기준)
        total = len(trajectory)
        try:
            for i, wp in enumerate(trajectory):
                self._replay_progress = i / total if total > 0 else 0.0
                if self._replay_stop_event.is_set():
                    self.get_logger().info("Replay stopped by user")
                    break

                pos = [wp.get(f"q{j+1}", 0.0) for j in range(DOF)]
                gripper = wp.get("gripper")
                t_cmd = time.time_ns()

                # 그리퍼 OPEN/CLOSE 상태 전환 감지
                if gripper is not None:
                    cur_is_open = (gripper > _GRIPPER_MID)
                    if cur_is_open != prev_gripper_is_open:
                        prev_gripper_is_open = cur_is_open
                        gripper_cmd_val = GRIPPER_OPEN_RAD if cur_is_open else GRIPPER_CLOSE_RAD
                        # 닫을 때: 최대 힘(3 N/m) → 물체를 확실히 파지
                        # 열 때: 기본 힘(1 N/m)
                        gripper_cmd_effort = 1.0 if cur_is_open else 3.0
                        self.get_logger().info(
                            f"[Replay] Gripper {'OPEN' if cur_is_open else 'CLOSE'} "
                            f"@ waypoint {i} (raw={gripper:.4f}, "
                            f"target={gripper_cmd_val:.3f}, effort={gripper_cmd_effort}N/m)"
                        )

                self._publish_joint_cmd(pos, velocity=cmd_velocity,
                                        gripper=gripper_cmd_val,
                                        gripper_effort=gripper_cmd_effort)

                cmd_row = {f"q{j+1}": pos[j] for j in range(DOF)}
                cmd_row["gripper"] = gripper_cmd_val
                cmd_row["gripper_effort"] = gripper_cmd_effort
                cmd_row["t_host_ns"] = t_cmd
                cmd_row["waypoint_idx"] = i
                with self._lock:
                    self._replay_command_buffer.append(cmd_row)

                # keyframe에서는 도착 확인 후 잠깐 settle (gripper cmd 직전 정밀 도착)
                if i in gripper_keyframes:
                    reached = self._wait_until_close(pos, tol=0.04, vel_tol=0.1, timeout=3.0)
                    if not reached:
                        self.get_logger().warn(
                            f"[Replay] Keyframe {i}: not converged — gripper cmd will proceed anyway"
                        )
                    time.sleep(0.1)  # gripper 명령 직전 짧은 settle
                else:
                    time.sleep(dt)

        finally:
            self._replay_progress = 0.0
            with self._lock:
                self._mode = "IDLE"
            self._log_event("replay_end")
            self.get_logger().info("Replay loop finished")
            if done_callback:
                done_callback()

    def stop_replay(self) -> tuple[list[dict], list[dict]]:
        """replay 중단 + (executed_buffer, command_buffer) 반환"""
        self._replay_stop_event.set()
        if self._replay_thread:
            self._replay_thread.join(timeout=2.0)
        with self._lock:
            self._mode = "IDLE"
            exec_buf = self._executed_buffer.copy()
            cmd_buf = self._replay_command_buffer.copy()
        self.get_logger().info(f"Replay stopped: {len(exec_buf)} executed samples")
        return exec_buf, cmd_buf

    # ─────────────────────────────────────────────────────────────────
    # Motor enable / disable
    # ─────────────────────────────────────────────────────────────────

    def enable_motors(self):
        """모터 활성화 — position control 복귀."""
        msg = Bool()
        msg.data = True
        self.enable_pub.publish(msg)
        self._motors_enabled = True
        self._log_event("motors_enabled")
        self.get_logger().info("Motors ENABLED")

    def disable_motors(self):
        """모터 비활성화 — torque off, 손으로 자유롭게 이동 가능."""
        msg = Bool()
        msg.data = False
        self.enable_pub.publish(msg)
        self._motors_enabled = False
        self._log_event("motors_disabled")
        self.get_logger().info("Motors DISABLED (freedrive)")

    # ─────────────────────────────────────────────────────────────────
    # Soft stop (Hold position)
    # ─────────────────────────────────────────────────────────────────

    def hold_position(self):
        """
        현재 position을 그대로 유지 명령 (soft stop). 물리적 E-stop 아님.
        모터가 비활성화 상태면 먼저 활성화한 뒤 hold.
        """
        self._replay_stop_event.set()
        # 모터가 꺼진 상태(teaching 중)라면 먼저 활성화
        if not self._motors_enabled:
            self.enable_motors()
            time.sleep(0.5)  # 활성화 안정화 대기
        with self._lock:
            pos = self._latest_position[:DOF]
            self._mode = "HOLD"
        self._publish_joint_cmd(pos, velocity=0.0)
        self._log_event("hold_position")
        self.get_logger().warn("HOLD POSITION commanded (soft stop)")

    # ─────────────────────────────────────────────────────────────────
    # Phone Mouse — joint delta
    # ─────────────────────────────────────────────────────────────────

    # ─────────────────────────────────────────────────────────────────
    # Phone Mouse — joint delta + limit calibration
    # ─────────────────────────────────────────────────────────────────

    def set_pm_joint_limits(self, limits: dict):
        """
        calibration 결과를 반영.
        limits: {"j1": {"min": float, "max": float}, ...}
        """
        new_limits = list(self._pm_joint_limits)
        for i in range(DOF):
            key = f"j{i+1}"
            if key in limits:
                new_limits[i] = (float(limits[key]["min"]), float(limits[key]["max"]))
        self._pm_joint_limits = new_limits
        self.get_logger().info(f"PM joint limits updated: {new_limits}")

    def start_calib(self):
        """ROM calibration 시작 — 모터 OFF, min/max 추적 시작."""
        self._calib_min = [float("inf")]  * DOF
        self._calib_max = [float("-inf")] * DOF
        self._calib_active = True
        self.disable_motors()
        self._log_event("calib_start")
        self.get_logger().info("Calibration started — move arm through full ROM")

    def stop_calib(self) -> dict:
        """ROM calibration 종료 — 모터 ON, 5° 마진 적용한 limits 반환."""
        self._calib_active = False
        self.enable_motors()
        self._log_event("calib_stop")

        MARGIN = 0.087  # 5° in rad

        limits = {}
        for i in range(DOF):
            lo = self._calib_min[i]
            hi = self._calib_max[i]
            if lo == float("inf") or hi == float("-inf"):
                # 이 관절은 안 움직였음 → 기존 기본값 유지
                lo, hi = self._pm_joint_limits[i]
                limits[f"j{i+1}"] = {"min": round(lo, 4), "max": round(hi, 4), "measured": False}
            else:
                limits[f"j{i+1}"] = {
                    "min": round(lo + MARGIN, 4),
                    "max": round(hi - MARGIN, 4),
                    "measured": True,
                }
        self.get_logger().info(f"Calibration result: {limits}")
        return limits

    def apply_joint_delta(self, j1=0.0, j2=0.0, j3=0.0, j4=0.0, j5=0.0, j6=0.0):
        """
        현재 위치에서 delta(rad)만큼 각 관절을 이동.
        그리퍼는 건드리지 않음. Phone Mouse 모드에서 호출.
        _pm_joint_limits 내로 클램프.
        """
        with self._lock:
            pos = list(self._latest_position[:DOF])
            gripper = self._latest_position[DOF] if len(self._latest_position) > DOF else None

        deltas = [j1, j2, j3, j4, j5, j6]
        for i, d in enumerate(deltas):
            lo, hi = self._pm_joint_limits[i]
            pos[i] = max(lo, min(hi, pos[i] + d))

        self._publish_joint_cmd(pos, velocity=10.0, gripper=gripper)

    # ─────────────────────────────────────────────────────────────────
    # Cartesian Jog — Pinocchio IK (ee_twist_cmd)
    # ─────────────────────────────────────────────────────────────────

    _URDF_PATH = (
        "/home/cglab/robotarm/piper_ws/src/Piper_ros/src/piper_description"
        "/urdf/piper_description.urdf"
    )
    _EE_LAMBDA   = 0.05    # DLS damping coefficient
    _EE_MAX_STEP = 0.03    # rad/step clamp per joint
    _EE_Z_MIN    = 0.05    # workspace floor limit (m)
    _EE_COND_WARN = 100    # condition number: scale-down threshold
    _EE_COND_MAX  = 300    # condition number: reject threshold

    def _load_urdf(self):
        """Pinocchio 모델을 URDF에서 로드. 실패하면 _pin_model=None 유지."""
        try:
            model = pin.buildModelFromUrdf(self._URDF_PATH)
            data = model.createData()
            self._pin_model = model
            self._pin_data = data
            self.get_logger().info(
                f"Pinocchio loaded: {model.njoints} joints, nq={model.nq}, ee_id={self._pin_ee_id}"
            )
        except Exception as exc:
            self.get_logger().error(f"Pinocchio URDF load failed: {exc}")

    def _compute_jacobian(self, q6: list) -> Optional[np.ndarray]:
        """
        arm q (6 values, rad) → 6×6 Jacobian (LOCAL_WORLD_ALIGNED frame).
        Pinocchio 없으면 None.
        """
        if self._pin_model is None:
            return None
        q = pin.neutral(self._pin_model)   # nq=8 (6 arm + 2 gripper)
        q[:6] = np.array(q6, dtype=float)
        pin.computeJointJacobians(self._pin_model, self._pin_data, q)
        J_full = pin.getJointJacobian(
            self._pin_model, self._pin_data,
            self._pin_ee_id,
            pin.ReferenceFrame.LOCAL_WORLD_ALIGNED,
        )  # shape (6, 8)
        return J_full[:, :6]  # (6, 6) — arm columns only

    def _get_ee_position(self, q6: list) -> Optional[np.ndarray]:
        """FK → end-effector world position (3,). None if Pinocchio unavailable."""
        if self._pin_model is None:
            return None
        q = pin.neutral(self._pin_model)
        q[:6] = np.array(q6, dtype=float)
        pin.forwardKinematics(self._pin_model, self._pin_data, q)
        return self._pin_data.oMi[self._pin_ee_id].translation.copy()

    def apply_ee_twist(
        self, vx=0.0, vy=0.0, vz=0.0,
        wx=0.0, wy=0.0, wz=0.0, dt=0.05
    ):
        """
        End-effector twist → Damped Least Squares IK → joint delta.
        Pinocchio 없으면 joint-space fallback (vx→j1, vy→j2).
        TEACH_RECORDING 상태에서 controller가 호출.
        """
        with self._lock:
            q6 = list(self._latest_position[:DOF])
            gripper = (
                self._latest_position[DOF]
                if len(self._latest_position) > DOF
                else None
            )

        # z_min 안전: 엔드이펙터가 바닥에 너무 가까우면 하강 차단
        ee_pos = self._get_ee_position(q6)
        if ee_pos is not None and ee_pos[2] < self._EE_Z_MIN and vz < 0:
            vz = 0.0

        J = self._compute_jacobian(q6)
        if J is None:
            # Pinocchio 없음 → 단순 joint jog fallback
            self.apply_joint_delta(j1=vx * dt * 5, j2=vy * dt * 5)
            return

        twist = np.array([vx, vy, vz, wx, wy, wz], dtype=float)
        lam2  = self._EE_LAMBDA ** 2
        A     = J @ J.T + lam2 * np.eye(6)

        cond = np.linalg.cond(J)
        if cond > self._EE_COND_MAX:
            self.get_logger().warn(f"Cartesian jog: singularity cond={cond:.0f} → rejected")
            return
        scale = 1.0 if cond <= self._EE_COND_WARN else self._EE_COND_WARN / cond

        dq = scale * (J.T @ np.linalg.solve(A, twist)) * dt
        dq = np.clip(dq, -self._EE_MAX_STEP, self._EE_MAX_STEP)

        new_q = [
            max(lo, min(hi, q6[i] + float(dq[i])))
            for i, (lo, hi) in enumerate(self._pm_joint_limits)
        ]
        self._publish_joint_cmd(new_q, velocity=10.0, gripper=gripper)

    # ─────────────────────────────────────────────────────────────────
    # Gripper events
    # ─────────────────────────────────────────────────────────────────

    def gripper_set(self, pct: float):
        """그리퍼를 0~100% 범위로 이동.
        pct=0 → CLOSE (0.0 rad), pct=100 → OPEN (GRIPPER_OPEN_RAD).
        """
        pct = max(0.0, min(100.0, float(pct)))
        target_rad = GRIPPER_CLOSE_RAD + (GRIPPER_OPEN_RAD - GRIPPER_CLOSE_RAD) * pct / 100.0
        if pct == 0.0:
            # close와 동일하게 arm 위치 기록
            with self._lock:
                self._gripper_close_arm_pos = self._latest_position[:DOF].copy()
            self._gripper_cmd = 1.0
            self._log_event("gripper_close")
        else:
            self._gripper_cmd = 1.0 - pct / 100.0
            self._log_event(f"gripper_set_{int(pct)}pct")
        self.get_logger().info(f"Gripper SET {pct:.0f}% → {target_rad:.4f} rad")
        threading.Thread(target=self._gripper_move, args=(target_rad,), daemon=True).start()

    def gripper_open(self):
        self._gripper_cmd = 0.0
        self._log_event("gripper_open")
        self.get_logger().info(f"Gripper OPEN → {GRIPPER_OPEN_RAD} rad")
        threading.Thread(
            target=self._gripper_move,
            args=(GRIPPER_OPEN_RAD,),
            daemon=True,
        ).start()

    def gripper_close(self):
        self._gripper_cmd = 1.0
        # 그리퍼를 닫는 순간의 arm 위치 기록 (return_home 시 여기서 물건 내려놓기용)
        with self._lock:
            self._gripper_close_arm_pos = self._latest_position[:DOF].copy()
        self._log_event("gripper_close")
        self.get_logger().info(f"Gripper CLOSE → {GRIPPER_CLOSE_RAD} rad (arm pos recorded)")
        threading.Thread(
            target=self._gripper_move,
            args=(GRIPPER_CLOSE_RAD,),
            daemon=True,
        ).start()

    def get_gripper_close_arm_pos(self) -> Optional[list]:
        """그리퍼를 닫았던 시점의 arm joint 위치 (없으면 None)."""
        return self._gripper_close_arm_pos.copy() if self._gripper_close_arm_pos else None

    def clear_gripper_close_arm_pos(self):
        self._gripper_close_arm_pos = None

    def _gripper_move(self, target_rad: float):
        """그리퍼를 target_rad까지 GRIPPER_STEPS 단계로 나눠 천천히 이동.

        TEACH 모드(freedrive) 중에는 gripper only 제어:
        - 현재 arm 위치로 고정 명령 → enable_motors() → gripper 명령 → disable_motors()
        - arm 급격한 이동 없이 gripper만 작동하도록 arm을 현재 위치에 lock
        """
        with self._lock:
            current = self._latest_position[DOF] if len(self._latest_position) > DOF else 0.0
            pos = self._latest_position[:DOF].copy()
            mode = self._mode

        if mode == "TEACH":
            # freedrive 중: 일시적으로 모터 활성화 → gripper 명령 → 모터 재비활성화
            # 1. 활성화 (arm은 마지막 명령 위치로 돌아가려 하지만 단시간)
            self.enable_motors()
            time.sleep(0.05)
            # 2. 활성화 직후 현재 위치를 arm target으로 덮어씀 → arm jerk 최소화
            with self._lock:
                pos = self._latest_position[:DOF].copy()
                current = self._latest_position[DOF] if len(self._latest_position) > DOF else current
            self._publish_joint_cmd(pos, velocity=5.0, gripper=current)
            time.sleep(0.05)
            # 3. gripper를 목표 위치까지 단계별 이동 (arm은 현 위치 hold)
            for i in range(1, GRIPPER_STEPS + 1):
                intermediate = current + (target_rad - current) * i / GRIPPER_STEPS
                self._publish_joint_cmd(pos, velocity=GRIPPER_VELOCITY, gripper=intermediate)
                time.sleep(GRIPPER_STEP_DELAY)
            # 4. freedrive 복귀
            self.disable_motors()
            self.get_logger().info(
                f"[Gripper/TEACH] → {target_rad:.4f} rad (motors re-disabled)"
            )
            return

        delta = target_rad - current
        for i in range(1, GRIPPER_STEPS + 1):
            intermediate = current + delta * i / GRIPPER_STEPS
            self._publish_joint_cmd(pos, velocity=GRIPPER_VELOCITY, gripper=intermediate)
            time.sleep(GRIPPER_STEP_DELAY)

    # ─────────────────────────────────────────────────────────────────
    # Helpers
    # ─────────────────────────────────────────────────────────────────

    def _publish_joint_cmd(
        self,
        positions: list[float],
        velocity: float = 30.0,
        gripper: Optional[float] = None,
        gripper_effort: float = 1.0,
    ):
        """
        positions: q1..q6 (6 joints).
        gripper: joint7 위치(rad). None이면 7번째 joint 미포함.
        gripper_effort: 그리퍼 힘 (N 단위). driver가 *1000 하여 GripperCtrl로 전달.
                        driver 범위: 0.5~3 N → 500~3000. 기본 1.0 → 1000.
        """
        msg = JointState()
        n = DOF + (1 if gripper is not None else 0)
        msg.name = [f"joint{i+1}" for i in range(n)]
        msg.position = [float(p) for p in positions[:DOF]]
        if gripper is not None:
            msg.position.append(float(gripper))
        msg.velocity = [float(velocity)] * n
        # effort[6] = gripper force. arm joints effort = 0 (unused by driver)
        msg.effort = [0.0] * DOF
        if gripper is not None:
            msg.effort.append(float(gripper_effort))
        self.pub.publish(msg)

    def _log_event(self, event: str):
        self._events.append({"t_host_ns": time.time_ns(), "event": event})

    def get_teach_buffer(self) -> list[dict]:
        with self._lock:
            return self._teach_buffer.copy()

    def get_executed_buffer(self) -> list[dict]:
        with self._lock:
            return self._executed_buffer.copy()

    def get_command_buffer(self) -> list[dict]:
        with self._lock:
            return self._replay_command_buffer.copy()

    def get_events(self) -> list[dict]:
        return self._events.copy()

    def clear_events(self):
        self._events.clear()
