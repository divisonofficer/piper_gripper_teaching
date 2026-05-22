import os


def _env_int(name: str, default: int) -> int:
    try:
        return int(os.getenv(name, str(default)))
    except ValueError:
        return default

# CAN / ROS2
CAN_PORT = os.getenv("CAN_PORT", "can1")
CAN_BITRATE = _env_int("CAN_BITRATE", 1000000)
ROS_PIPER_JOINT_STATE_TOPIC = "/joint_states_single"
ROS_PIPER_JOINT_CTRL_TOPIC = "/joint_ctrl_single"

# RealSense
REALSENSE_FPS = 10
REALSENSE_RESOLUTION = (1280, 720)
REALSENSE_ENABLE_DEPTH = True
COLOR_SAVE_JPEG_QUALITY = 85   # JPEG 품질 (0~100). PNG 대비 ~5배 압축

# Teach / Replay
TEACH_LOG_HZ = 50          # joint state 기록 주기 (Hz)
REPLAY_DEFAULT_SPEED = 0.3  # 첫 replay 속도 배율
REPLAY_SMOOTHING_WINDOW = 11  # Savitzky-Golay window (홀수)
REPLAY_SMOOTHING_POLYORDER = 3

# Safety
MAX_JOINT_VELOCITY_RAD_S = 1.5   # replay 궤적 검사 임계값
MAX_WAYPOINT_DELTA_RAD = 0.5     # 연속 waypoint 간 최대 각도 차이
HOME_APPROACH_SPEED = 0.2        # home → trajectory[0] 이동 속도 배율
HOME_VELOCITY = 30               # go_home() 속도 (MotionCtrl_2 % — 드라이버 velocity[0] 기준)
HOME_WAIT_S = 8.0                # home 명령 후 완료 대기 시간 (초)

# Gripper (joint7)
GRIPPER_OPEN_RAD = 0.07          # 그리퍼 열림 위치 (rad)
GRIPPER_CLOSE_RAD = 0.0          # 그리퍼 닫힘 위치 (rad)
GRIPPER_VELOCITY = 5.0           # 그리퍼 이동 속도 (arm MotionCtrl % — 그리퍼 자체 속도는 GRIPPER_STEPS로 제어)
GRIPPER_STEPS = 8                # 그리퍼 이동 단계 수 (클수록 느림)
GRIPPER_STEP_DELAY = 0.08        # 각 단계 간 대기 시간 (초)

# Safe return waypoint sequence (물리 로봇에서 실측 후 기입)
# 자동 home 복귀(retake_teach / add_take)는 이 waypoint 목록이 정의된 경우에만 허용.
# None이면 자동 이동을 거부하고 사용자가 수동으로 로봇을 초기화해야 함.
#
# 각 waypoint = [q1, q2, q3, q4, q5, q6] (rad).
# 순서대로 이동하며, 각 waypoint 도착 실패 시 그 자리에서 abort (다음 waypoint 진행 안 함).
# 최소 2개 권장: [clearance_pose, ready_pose]
# 예:
# SAFE_RETURN_WAYPOINTS = [
#     [0.0,  0.6, -0.8, 0.0,  0.8, 0.0],   # clearance: EE를 충분히 위로 올림
#     [0.0,  0.3, -0.5, 0.0,  0.8, 0.0],   # ready: 작업 대기 자세
# ]
SAFE_RETURN_WAYPOINTS = None

# Dataset
DATASET_PATH = os.getenv("DATASET_PATH", os.path.join(os.path.dirname(__file__), "dataset"))
JOINT_LIMITS_FILE = os.path.join(DATASET_PATH, "joint_limits.json")

# Postprocess defaults
POSTPROCESS_DEFAULT_MASK_FILL_COLOR = "#000000"

# Flask
FLASK_PORT = _env_int("FLASK_PORT", 5002)
HTTPS_PORT = _env_int("HTTPS_PORT", 5003)
FLASK_HOST = os.getenv("FLASK_HOST", "0.0.0.0")
FLASK_DEBUG = os.getenv("FLASK_DEBUG", "0").lower() in {"1", "true", "yes", "on"}
