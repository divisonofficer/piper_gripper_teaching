// 상태 기계 상태값
export type AppMode =
  | "IDLE"
  | "CONNECTING"
  | "READY"
  | "CALIBRATING"
  | "TEACH_READY"
  | "TEACH_RECORDING"
  | "TRAJECTORY_CHECK"
  | "RETURN_HOME"
  | "REPLAY_READY"
  | "REPLAY_RECORDING"
  | "PROCESSING"
  | "REVIEW"
  | "SAVED"
  | "DISCARDED";

export type SaveStepStatus = "waiting" | "running" | "ok" | "failed";

export interface SaveStep {
  key: string;
  label: string;
  status: SaveStepStatus;
  detail: string;
}

export interface SaveProgressPayload {
  step: string;
  status: "running" | "ok" | "failed";
  detail: string;
}

// SocketIO 서버→클라이언트 이벤트
export interface ModeChangePayload {
  mode: AppMode;
  next_action: string;
  available_actions: string[];
  trajectory_summary?: TrajectoryCheck;
}

export interface RobotState {
  connected: boolean;
  position?: number[];     // q1..q6 (rad)
  gripper?: number;
  velocity?: number[];
  is_moving?: boolean;
  mode?: string;
  hz?: number;
  replay_progress?: number;  // 0.0~1.0 재생 진행률 (REPLAY_RECORDING 중)
  joint_limits?: { min: number[]; max: number[] };  // ROM 캘리브레이션 결과
}

export interface SingleCameraState {
  name?: string;
  device?: string;
  available: boolean;
  streaming?: boolean;
  recording?: boolean;
  fps?: number;
  resolution?: string;
  captured_frames?: number;
  written_frames?: number;
  dropped_frames?: number;
  queue_len?: number;
}

export interface CameraState {
  // multi-camera (new)
  connected?: boolean;
  cameras?: Record<string, SingleCameraState>;
  // legacy single-camera fields (backward compat)
  available?: boolean;
  streaming?: boolean;
  recording?: boolean;
  fps?: number;
  captured_frames?: number;
  written_frames?: number;
  dropped_frames?: number;
  queue_len?: number;
}

export interface LoggerState {
  episode_id?: string;
  disk_free_gb?: number;
  teach_samples?: number;
  exec_samples?: number;
  cam_frames?: number;
}

export interface EventLog {
  t: number;
  message: string;
}

export interface TrajectoryCheck {
  ok: boolean;
  duration_s?: number;
  samples?: number;
  max_joint_velocity_rad_s?: number;
  velocity_limit_ok?: boolean;
  max_waypoint_delta_rad?: number;
  waypoint_delta_ok?: boolean;
  gripper_events?: number;
  reason?: string;
  speed_scale?: number;
}

export interface EpisodeTake {
  take: string;          // "take_001", "take_002", ...
  has_video: boolean;
  has_teach: boolean;
  has_webcam_0?: boolean;
  has_webcam_1?: boolean;
  size_mb?: number;
}

export interface Episode {
  episode_id: string;
  task: string;
  created_at: string;
  success: boolean | null;
  takes: EpisodeTake[];
  takes_count: number;
  size_mb?: number;
  has_postprocess?: boolean;  // 마지막 take에 활성화된 postprocess 편집이 있는지
  // 구버전 호환
  stats?: Record<string, number>;
  checklist?: Record<string, boolean>;
}

export interface JointSample {
  t: number;      // seconds from start of recording
  q: number[];    // [q1..q6] in radians
  gripper: number;
}

export interface TakeJointsData {
  teach: JointSample[];
  executed: JointSample[];
  command: JointSample[];
}

export interface EESample {
  t: number;                           // seconds from start
  gripper: number;
  ee: [number, number, number];        // [x, y, z] in meters (base_link frame)
  links: [number, number, number][];   // [6] link1..link6 positions in meters
}

export interface TakeTrajectoryData {
  teach: EESample[];
  executed: EESample[];
  command: EESample[];
}

export interface TrimMeta {
  enabled: boolean;
  cut_t: number | null;   // gripper open 시각 (null = 자동 감지)
  margin: number;          // gripper open 이후 추가 유지 시간(초)
}

export interface MaskMeta {
  enabled: boolean;
  polygon: [number, number][];  // normalized 0-1 좌표 (keep 영역 폴리곤)
  fill: "black" | "frame_capture";
  capture_t?: number;  // frame_capture 타입: 캡쳐 기준 시각(초)
}

export interface EditMeta {
  trim: TrimMeta;
  mask: MaskMeta;
}

export interface MaskLibraryEntry {
  id: string;
  name: string;
  polygon: [number, number][];
  created_at: string;
  source_episode?: string;
  source_take?: string;
}
