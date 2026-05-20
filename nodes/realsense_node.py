"""
RealsenseCapture
-----------------
pyrealsense2를 직접 사용하는 standalone RealSense 캡처 모듈.
기존 clientapp의 CameraRS에 의존하지 않음.

핵심 설계 원칙:
  - frame callback에서 디스크 I/O 금지 → in-memory queue에만 push
  - 별도 writer thread가 queue → disk 저장
  - 저장 상태(captured/written/dropped/queue_len)를 실시간 추적

사용:
    cap = RealsenseCapture()
    cap.start_stream()                 # 스트림 시작 (항상)
    cap.start_recording(episode_dir)   # 녹화 시작
    cam_buffer = cap.stop_recording()  # 녹화 중단 → camera_frames buffer 반환
    cap.get_jpeg_bytes()               # MJPEG 스트리밍용
"""

import os
import queue
import threading
import time
from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np

import sys
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))
from config import REALSENSE_FPS, REALSENSE_RESOLUTION, REALSENSE_ENABLE_DEPTH, COLOR_SAVE_JPEG_QUALITY

try:
    import pyrealsense2 as rs
    _RS_AVAILABLE = True
except ImportError:
    rs = None
    _RS_AVAILABLE = False

WRITER_QUEUE_MAX = 300          # 약 10초 분량 @30fps
RECONNECT_ERROR_THRESHOLD = 5  # 연속 에러 N회 → reconnect 시도
RECONNECT_DELAY_S = 2.0        # pipeline stop 후 USB re-enumeration 대기


@dataclass
class RSFrame:
    rgb: Optional[np.ndarray]       # (H, W, 3) BGR
    depth: Optional[np.ndarray]     # (H, W) uint16
    t_sensor_ms: float              # RealSense 내부 타임스탬프 (ms)


class RealsenseCapture:

    def __init__(self):
        self._available = _RS_AVAILABLE
        self._width, self._height = REALSENSE_RESOLUTION
        self._fps = REALSENSE_FPS

        # ── pipeline ─────────────────────────────────────────────────
        self._pipeline: Optional[object] = None
        self._streaming = False
        self._stream_thread: Optional[threading.Thread] = None
        self._stream_stop = threading.Event()

        # ── live frame (viewer용) ─────────────────────────────────────
        self._latest_frame: Optional[RSFrame] = None
        self._frame_lock = threading.Lock()
        self._live_fps = 0.0
        self._live_count = 0
        self._live_hz_t = time.time()

        # ── recording state ───────────────────────────────────────────
        self._recording = False
        self._episode_dir: Optional[str] = None
        self._frames_dir: Optional[str] = None

        # ── writer queue ──────────────────────────────────────────────
        self._write_queue: queue.Queue = queue.Queue(maxsize=WRITER_QUEUE_MAX)
        self._writer_thread: Optional[threading.Thread] = None
        self._writer_stop = threading.Event()

        # ── stats ─────────────────────────────────────────────────────
        self._captured_count = 0
        self._written_count = 0
        self._dropped_count = 0
        self._camera_frames_buffer: list[dict] = []

    # ─────────────────────────────────────────────────────────────────
    # Stream lifecycle
    # ─────────────────────────────────────────────────────────────────

    def start_stream(self) -> bool:
        if self._streaming:
            return True

        if not self._available:
            print("[RealsenseCapture] pyrealsense2 not available → mock mode")
            self._start_mock_stream()
            return False

        try:
            self._pipeline = rs.pipeline()
            cfg = rs.config()
            cfg.enable_stream(rs.stream.color, self._width, self._height, rs.format.bgr8, self._fps)
            if REALSENSE_ENABLE_DEPTH:
                # depth는 1280x720에서 10fps를 지원하지 않음 (5/15/30fps만 가능)
                # color fps보다 크거나 같은 가장 가까운 지원 fps 사용
                depth_fps = self._nearest_supported_depth_fps(self._fps)
                cfg.enable_stream(rs.stream.depth, self._width, self._height, rs.format.z16, depth_fps)
                print(f"[RealsenseCapture] color={self._fps}fps, depth={depth_fps}fps")
            self._pipeline.start(cfg)
            self._streaming = True
            self._stream_stop.clear()
            self._stream_thread = threading.Thread(target=self._stream_loop, daemon=True)
            self._stream_thread.start()
            print("[RealsenseCapture] RealSense pipeline started")
            return True
        except Exception as e:
            print(f"[RealsenseCapture] Failed to start pipeline: {e} → mock mode")
            self._available = False
            self._start_mock_stream()
            return False

    def _nearest_supported_depth_fps(self, color_fps: int) -> int:
        """1280x720 depth에서 지원하는 fps 중 color_fps 이상의 최솟값 반환."""
        supported = [5, 15, 30]   # D456 1280x720 depth 지원 fps
        for fps in supported:
            if fps >= color_fps:
                return fps
        return supported[-1]  # 30fps fallback

    def stop_stream(self):
        self._stream_stop.set()
        if self._stream_thread:
            self._stream_thread.join(timeout=3.0)
        if self._pipeline:
            try:
                self._pipeline.stop()
            except Exception:
                pass
        self._streaming = False
        print("[RealsenseCapture] Stream stopped")

    def _stream_loop(self):
        consecutive_errors = 0
        while not self._stream_stop.is_set():
            try:
                frames = self._pipeline.wait_for_frames(timeout_ms=1000)
                consecutive_errors = 0
            except Exception as e:
                consecutive_errors += 1
                print(f"[RealsenseCapture] wait_for_frames error: {e} ({consecutive_errors}/{RECONNECT_ERROR_THRESHOLD})")
                if consecutive_errors >= RECONNECT_ERROR_THRESHOLD:
                    print("[RealsenseCapture] Consecutive errors exceeded threshold — reconnecting")
                    if self._reconnect():
                        consecutive_errors = 0
                    else:
                        time.sleep(RECONNECT_DELAY_S)
                else:
                    time.sleep(0.05)
                continue

            t_sensor_ms = frames.get_timestamp()

            color_frame = frames.get_color_frame()
            rgb = np.asanyarray(color_frame.get_data()).copy() if color_frame else None

            depth = None
            if REALSENSE_ENABLE_DEPTH:
                depth_frame = frames.get_depth_frame()
                depth = np.asanyarray(depth_frame.get_data()).copy() if depth_frame else None

            self._process_frame(RSFrame(rgb=rgb, depth=depth, t_sensor_ms=t_sensor_ms))

    def _reconnect(self) -> bool:
        """pipeline 재시작. _stream_loop 내부에서만 호출."""
        print("[RealsenseCapture] Stopping pipeline...")
        try:
            self._pipeline.stop()
        except Exception:
            pass

        time.sleep(RECONNECT_DELAY_S)

        try:
            self._pipeline = rs.pipeline()
            cfg = rs.config()
            cfg.enable_stream(rs.stream.color, self._width, self._height, rs.format.bgr8, self._fps)
            if REALSENSE_ENABLE_DEPTH:
                depth_fps = self._nearest_supported_depth_fps(self._fps)
                cfg.enable_stream(rs.stream.depth, self._width, self._height, rs.format.z16, depth_fps)
            self._pipeline.start(cfg)
            print("[RealsenseCapture] Reconnected successfully")
            return True
        except Exception as e:
            print(f"[RealsenseCapture] Reconnect failed: {e}")
            return False

    def _start_mock_stream(self):
        """RealSense 없을 때 테스트용 mock 프레임"""
        self._streaming = True

        def _mock():
            idx = 0
            while not self._stream_stop.is_set():
                frame = np.zeros((self._height, self._width, 3), dtype=np.uint8)
                cv2.putText(frame, f"MOCK {idx:06d}", (50, self._height // 2),
                            cv2.FONT_HERSHEY_SIMPLEX, 2, (0, 255, 0), 3)
                depth = np.zeros((self._height, self._width), dtype=np.uint16)
                self._process_frame(RSFrame(rgb=frame, depth=depth, t_sensor_ms=time.time() * 1000))
                idx += 1
                time.sleep(1.0 / self._fps)

        self._stream_stop.clear()
        self._stream_thread = threading.Thread(target=_mock, daemon=True)
        self._stream_thread.start()

    # ─────────────────────────────────────────────────────────────────
    # Frame processing
    # ─────────────────────────────────────────────────────────────────

    def _process_frame(self, frame: RSFrame):
        t_host_ns = time.time_ns()

        # 라이브 최신 프레임 업데이트
        with self._frame_lock:
            self._latest_frame = frame
            self._live_count += 1
            now = time.time()
            if now - self._live_hz_t >= 1.0:
                self._live_fps = self._live_count / (now - self._live_hz_t)
                self._live_count = 0
                self._live_hz_t = now

        # 녹화 중이면 queue에 push
        if self._recording:
            entry = (t_host_ns, frame, self._captured_count)
            try:
                self._write_queue.put_nowait(entry)
                self._captured_count += 1
            except queue.Full:
                self._dropped_count += 1

    # ─────────────────────────────────────────────────────────────────
    # Recording
    # ─────────────────────────────────────────────────────────────────

    def start_recording(self, episode_dir: str):
        self._episode_dir = episode_dir
        self._frames_dir = os.path.join(episode_dir, "frames")
        os.makedirs(self._frames_dir, exist_ok=True)

        self._captured_count = 0
        self._written_count = 0
        self._dropped_count = 0
        self._camera_frames_buffer = []

        # queue 비우기
        while not self._write_queue.empty():
            try:
                self._write_queue.get_nowait()
            except queue.Empty:
                break

        self._writer_stop.clear()
        self._writer_thread = threading.Thread(target=self._write_loop, daemon=True)
        self._writer_thread.start()

        self._recording = True
        print(f"[RealsenseCapture] Recording started → {self._frames_dir}")

    def stop_recording(self) -> list[dict]:
        self._recording = False
        self._writer_stop.set()
        if self._writer_thread:
            self._writer_thread.join(timeout=15.0)
        print(f"[RealsenseCapture] Recording stopped: "
              f"captured={self._captured_count}, written={self._written_count}, "
              f"dropped={self._dropped_count}")
        return self._camera_frames_buffer.copy()

    def _write_loop(self):
        while not (self._writer_stop.is_set() and self._write_queue.empty()):
            try:
                t_host_ns, frame, frame_idx = self._write_queue.get(timeout=0.1)
            except queue.Empty:
                continue

            color_rel = os.path.join("frames", f"color_{frame_idx:06d}.jpg")
            depth_rel = os.path.join("frames", f"depth_{frame_idx:06d}.png")

            if frame.rgb is not None:
                cv2.imwrite(
                    os.path.join(self._frames_dir, f"color_{frame_idx:06d}.jpg"),
                    frame.rgb,
                    [cv2.IMWRITE_JPEG_QUALITY, COLOR_SAVE_JPEG_QUALITY],
                )
            if frame.depth is not None and REALSENSE_ENABLE_DEPTH:
                # uint16 PNG: 손실 없이 raw depth 보존, NPY 대비 ~2배 압축
                cv2.imwrite(
                    os.path.join(self._frames_dir, f"depth_{frame_idx:06d}.png"),
                    frame.depth,
                )

            self._camera_frames_buffer.append({
                "frame_idx": frame_idx,
                "t_host_ns": t_host_ns,
                "t_sensor_ms": round(frame.t_sensor_ms, 3),
                "color_path": color_rel,
                "depth_path": depth_rel if REALSENSE_ENABLE_DEPTH else "",
            })
            self._written_count += 1

    # ─────────────────────────────────────────────────────────────────
    # Live view
    # ─────────────────────────────────────────────────────────────────

    def get_latest_frame(self) -> Optional[RSFrame]:
        with self._frame_lock:
            return self._latest_frame

    def get_jpeg_bytes(self, quality: int = 70) -> Optional[bytes]:
        frame = self.get_latest_frame()
        if frame is None or frame.rgb is None:
            return None
        ok, buf = cv2.imencode(".jpg", frame.rgb, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return bytes(buf) if ok else None

    def get_depth_jpeg_bytes(self, quality: int = 70) -> Optional[bytes]:
        """Depth map → jet colormap → JPEG (시각화용)."""
        frame = self.get_latest_frame()
        if frame is None or frame.depth is None:
            return None
        d = frame.depth.astype(np.float32)
        # 0~8000mm 범위 정규화 (0=무효 픽셀 처리)
        valid = d[d > 0]
        if valid.size == 0:
            return None
        d_norm = np.clip(d / 8000.0, 0.0, 1.0)
        d_u8 = (d_norm * 255).astype(np.uint8)
        colored = cv2.applyColorMap(d_u8, cv2.COLORMAP_JET)
        # 무효 픽셀(원래 0) → 검정
        colored[d == 0] = 0
        ok, buf = cv2.imencode(".jpg", colored, [cv2.IMWRITE_JPEG_QUALITY, quality])
        return bytes(buf) if ok else None

    # ─────────────────────────────────────────────────────────────────
    # Status
    # ─────────────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        return {
            "available": self._available,
            "streaming": self._streaming,
            "recording": self._recording,
            "fps": round(self._live_fps, 1),
            "captured_frames": self._captured_count,
            "written_frames": self._written_count,
            "dropped_frames": self._dropped_count,
            "queue_len": self._write_queue.qsize(),
        }
