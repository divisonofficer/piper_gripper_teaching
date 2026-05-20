#!/bin/bash
# ──────────────────────────────────────────────────────────────────────
# Piper Cowork 시작 스크립트
# ──────────────────────────────────────────────────────────────────────

SCRIPT_DIR="$(cd "$(dirname "$0")" && pwd)"
PIPER_WS_DIR="$HOME/robotarm/piper_ws/src/Piper_ros"

PIDS=()

cleanup() {
    echo ""
    echo "[start.sh] Stopping all processes..."

    # 명시적으로 추적한 PID 종료
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo "[start.sh] Killing PID $pid"
            kill -SIGTERM "$pid" 2>/dev/null
        fi
    done

    # 혹시 남은 piper_single_ctrl / python3 app.py 정리
    pkill -f "piper_single_ctrl" 2>/dev/null || true
    pkill -f "piper_cowork/app.py" 2>/dev/null || true

    # 자식 프로세스 종료 대기 (최대 5초)
    sleep 1
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo "[start.sh] Force killing PID $pid"
            kill -SIGKILL "$pid" 2>/dev/null
        fi
    done

    echo "[start.sh] Done."
    exit 0
}

trap cleanup SIGINT SIGTERM EXIT

# ── 1. ROS2 환경 ─────────────────────────────────────────────────────
echo "[start.sh] Sourcing ROS2 environments..."
source "$HOME/robotarm/install/setup.bash"
source "$HOME/agilex_ws/install/setup.bash"

# ── 2. CAN 활성화 (Piper: can1, 1Mbps) ──────────────────────────────
echo "[start.sh] Activating CAN interface (can1, 1Mbps)..."
if [ -d "$PIPER_WS_DIR" ]; then
    pushd "$PIPER_WS_DIR" > /dev/null
    bash can_activate.sh can1 1000000 1-2:1.0
    popd > /dev/null
else
    echo "[start.sh] WARNING: $PIPER_WS_DIR not found, skipping CAN activation"
fi

# ── 3. piper_single_ctrl ROS2 노드 ───────────────────────────────────
echo "[start.sh] Starting piper_single_ctrl..."
ros2 run piper piper_single_ctrl \
    --ros-args \
    -p can_port:=can1 \
    -p auto_enable:=true \
    -p gripper_exist:=true &
PIPER_PID=$!
PIDS+=($PIPER_PID)
echo "[start.sh] piper_single_ctrl PID: $PIPER_PID"

sleep 2

# ── 4. Flask 앱 ──────────────────────────────────────────────────────
echo "[start.sh] Starting Flask server (port 5002)..."
cd "$SCRIPT_DIR"
python3 app.py &
APP_PID=$!
PIDS+=($APP_PID)
echo "[start.sh] Flask PID: $APP_PID"

echo ""
echo "══════════════════════════════════════════"
echo "  http://localhost:5002"
echo "  Ctrl+C to stop"
echo "══════════════════════════════════════════"
echo ""

wait
