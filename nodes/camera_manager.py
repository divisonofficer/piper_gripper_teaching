"""
CameraManager
--------------
RealSense 1대 + USB 웹캠 최대 2대를 통합 관리.

핵심 설계:
  - 카메라 3대 중 1대라도 연결되면 시스템 동작
  - 각 카메라 연결 실패는 graceful — 나머지 카메라는 정상 동작
  - 동일한 인터페이스: get_status(), get_jpeg_bytes(cam_id), start/stop_recording()
  - stream_ids: 'realsense', 'webcam_0', 'webcam_1'

사용:
    mgr = CameraManager()
    ok = mgr.connect()          # 1대라도 연결되면 True
    mgr.start_all_recording(ep_dir)
    buffers = mgr.stop_all_recording()  # dict: cam_id → [frame_dict, ...]
    mgr.disconnect()
"""

import threading
import time
from typing import Optional

import sys, os
sys.path.insert(0, os.path.join(os.path.dirname(__file__), ".."))

from nodes.realsense_node import RealsenseCapture
from nodes.webcam_node import WebcamCapture, discover_webcams

# C270만 쓰고 싶으면 "C270" / None이면 모든 USB 카메라
WEBCAM_NAME_FILTER: Optional[str] = "C270"
WEBCAM_MAX_COUNT: int = 2


class CameraManager:
    """
    모든 카메라의 라이프사이클을 관리.

    Attributes:
        realsense:  RealsenseCapture | None
        webcams:    list[WebcamCapture]  (0-2개)
    """

    def __init__(self):
        self.realsense: Optional[RealsenseCapture] = None
        self.webcams: list[WebcamCapture] = []
        self._connected = False
        self._lock = threading.Lock()

    # ─────────────────────────────────────────────────────────────────
    # Connection lifecycle
    # ─────────────────────────────────────────────────────────────────

    def connect(self) -> bool:
        """
        모든 카메라 연결 시도. 1대라도 성공하면 True 반환.
        실패한 카메라는 조용히 skip.
        """
        any_ok = False

        # ── RealSense ─────────────────────────────────────────────────
        rs = RealsenseCapture()
        ok = rs.start_stream()
        if ok:
            self.realsense = rs
            any_ok = True
            print("[CameraManager] RealSense: connected")
        else:
            # mock 모드로 동작 중 → 실제 하드웨어 없음
            rs.stop_stream()
            self.realsense = None
            print("[CameraManager] RealSense: not available")

        # ── USB Webcams (C270 자동 탐색) ───────────────────────────────
        devices = discover_webcams(name_filter=WEBCAM_NAME_FILTER, max_cameras=WEBCAM_MAX_COUNT)
        print(f"[CameraManager] Webcams discovered: {devices}")

        for i, dev_path in enumerate(devices):
            wc = WebcamCapture(device_path=dev_path, name=f"webcam_{i}")
            ok = wc.start_stream()
            if ok:
                self.webcams.append(wc)
                any_ok = True
            else:
                print(f"[CameraManager] webcam_{i} ({dev_path}): failed, skipping")

        self._connected = any_ok
        return any_ok

    def disconnect(self):
        if self.realsense:
            self.realsense.stop_stream()
            self.realsense = None
        for wc in self.webcams:
            wc.stop_stream()
        self.webcams = []
        self._connected = False

    # ─────────────────────────────────────────────────────────────────
    # Recording
    # ─────────────────────────────────────────────────────────────────

    def start_all_recording(self, episode_dir: str):
        """모든 연결된 카메라 동시 녹화 시작."""
        if self.realsense:
            self.realsense.start_recording(episode_dir)
        for wc in self.webcams:
            wc.start_recording(episode_dir)

    def stop_all_recording(self) -> dict:
        """
        모든 카메라 녹화 종료.
        Returns: {'realsense': [...], 'webcam_0': [...], ...}
        각 값은 camera_frames buffer (list[dict]).
        """
        buffers: dict = {}
        if self.realsense:
            buffers["realsense"] = self.realsense.stop_recording()
        for wc in self.webcams:
            buffers[wc.name] = wc.stop_recording()
        return buffers

    # ─────────────────────────────────────────────────────────────────
    # Live MJPEG (per camera)
    # ─────────────────────────────────────────────────────────────────

    def get_jpeg_bytes(self, cam_id: str = "primary", quality: int = 70) -> Optional[bytes]:
        """
        cam_id: 'primary' | 'realsense' | 'realsense_depth' | 'webcam_0' | 'webcam_1'
        'primary': realsense 우선, 없으면 첫 번째 webcam
        """
        if cam_id == "primary":
            if self.realsense:
                return self.realsense.get_jpeg_bytes(quality)
            if self.webcams:
                return self.webcams[0].get_jpeg_bytes(quality)
            return None

        if cam_id == "realsense":
            return self.realsense.get_jpeg_bytes(quality) if self.realsense else None

        if cam_id == "realsense_depth":
            return self.realsense.get_depth_jpeg_bytes(quality) if self.realsense else None

        for wc in self.webcams:
            if wc.name == cam_id:
                return wc.get_jpeg_bytes(quality)
        return None

    # ─────────────────────────────────────────────────────────────────
    # Status
    # ─────────────────────────────────────────────────────────────────

    def get_status(self) -> dict:
        """전체 카메라 상태 dict. 프론트엔드 camera_state 이벤트용."""
        cameras: dict = {}

        if self.realsense:
            cameras["realsense"] = self.realsense.get_status()
        else:
            cameras["realsense"] = {"available": False, "name": "realsense"}

        for i in range(WEBCAM_MAX_COUNT):
            key = f"webcam_{i}"
            matching = [wc for wc in self.webcams if wc.name == key]
            if matching:
                cameras[key] = matching[0].get_status()
            else:
                cameras[key] = {"available": False, "name": key, "device": "—"}

        # 편의: 하나라도 연결되어 있으면 connected=True
        any_connected = any(v.get("available", False) for v in cameras.values())
        return {
            "connected": any_connected,
            "cameras": cameras,
        }

    @property
    def any_available(self) -> bool:
        """녹화/스트리밍 가능한 카메라가 1대 이상인지."""
        if self.realsense and self.realsense._available:
            return True
        return any(wc._available for wc in self.webcams)

    # ─────────────────────────────────────────────────────────────────
    # Backward-compat shim (controller가 단일 RealsenseCapture 처럼 쓰는 곳)
    # ─────────────────────────────────────────────────────────────────

    def start_stream(self):
        """connect()의 별칭 — 기존 코드 호환."""
        return self.connect()

    def start_recording(self, episode_dir: str):
        self.start_all_recording(episode_dir)

    def stop_recording(self) -> dict:
        return self.stop_all_recording()
