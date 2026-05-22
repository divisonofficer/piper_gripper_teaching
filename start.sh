#!/usr/bin/env bash
# Piper Cowork launcher.
#
# Copy start.env.example to .env and adjust paths for your machine.
# This script intentionally kills only processes it starts.

set -Eeuo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
cd "$SCRIPT_DIR"

if [[ -f "$SCRIPT_DIR/.env" ]]; then
    # shellcheck disable=SC1091
    source "$SCRIPT_DIR/.env"
fi

PIDS=()
CLEANED_UP=0

bool_enabled() {
    case "${1:-}" in
        1|true|TRUE|yes|YES|on|ON) return 0 ;;
        *) return 1 ;;
    esac
}

cleanup() {
    local code=$?
    if [[ "$CLEANED_UP" == "1" ]]; then
        exit "$code"
    fi
    CLEANED_UP=1
    echo ""
    echo "[start.sh] Stopping Piper Cowork..."

    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo "[start.sh] SIGTERM PID $pid"
            kill -TERM "$pid" 2>/dev/null || true
        fi
    done

    sleep 1
    for pid in "${PIDS[@]}"; do
        if kill -0 "$pid" 2>/dev/null; then
            echo "[start.sh] SIGKILL PID $pid"
            kill -KILL "$pid" 2>/dev/null || true
        fi
    done

    echo "[start.sh] Done."
    exit "$code"
}

trap cleanup SIGINT SIGTERM EXIT

# ── User-configurable defaults ────────────────────────────────────────

CAN_PORT="${CAN_PORT:-can1}"
CAN_BITRATE="${CAN_BITRATE:-1000000}"
PIPER_CAN_USB="${PIPER_CAN_USB:-1-2:1.0}"

PIPER_WS_DIR="${PIPER_WS_DIR:-$HOME/robotarm/piper_ws/src/Piper_ros}"
PIPER_ROS_SETUP_FILES="${PIPER_ROS_SETUP_FILES:-$HOME/robotarm/install/setup.bash:$HOME/agilex_ws/install/setup.bash}"
PIPER_ROS_PACKAGE="${PIPER_ROS_PACKAGE:-piper}"
PIPER_ROS_EXECUTABLE="${PIPER_ROS_EXECUTABLE:-piper_single_ctrl}"

PIPER_START_ROS="${PIPER_START_ROS:-1}"
PIPER_ACTIVATE_CAN="${PIPER_ACTIVATE_CAN:-1}"
PIPER_AUTO_ENABLE="${PIPER_AUTO_ENABLE:-true}"
PIPER_GRIPPER_EXIST="${PIPER_GRIPPER_EXIST:-true}"
PIPER_BUILD_FRONTEND="${PIPER_BUILD_FRONTEND:-0}"

FLASK_HOST="${FLASK_HOST:-0.0.0.0}"
FLASK_PORT="${FLASK_PORT:-5002}"
HTTPS_PORT="${HTTPS_PORT:-5003}"
export CAN_PORT CAN_BITRATE FLASK_HOST FLASK_PORT HTTPS_PORT

if [[ -x "$SCRIPT_DIR/.venv/bin/python" ]]; then
    PYTHON_BIN="${PYTHON_BIN:-$SCRIPT_DIR/.venv/bin/python}"
else
    PYTHON_BIN="${PYTHON_BIN:-python3}"
fi

echo "[start.sh] Piper Cowork root: $SCRIPT_DIR"
echo "[start.sh] Backend: http://localhost:${FLASK_PORT}"

# ── Optional frontend build ───────────────────────────────────────────

if bool_enabled "$PIPER_BUILD_FRONTEND"; then
    if command -v npm >/dev/null 2>&1; then
        echo "[start.sh] Building frontend..."
        (cd "$SCRIPT_DIR/frontend" && npm install && npm run build)
    else
        echo "[start.sh] WARNING: npm not found; skipping frontend build"
    fi
elif [[ ! -d "$SCRIPT_DIR/frontend/build" ]]; then
    echo "[start.sh] WARNING: frontend/build not found."
    echo "           Run: cd frontend && npm install && npm run build"
fi

# ── ROS2 environment ─────────────────────────────────────────────────

if bool_enabled "$PIPER_START_ROS"; then
    echo "[start.sh] Sourcing ROS2 setup files..."
    IFS=":" read -r -a setup_files <<< "$PIPER_ROS_SETUP_FILES"
    for setup_file in "${setup_files[@]}"; do
        if [[ -f "$setup_file" ]]; then
            echo "[start.sh]   source $setup_file"
            # shellcheck disable=SC1090
            source "$setup_file"
        else
            echo "[start.sh]   skip missing $setup_file"
        fi
    done

    if ! command -v ros2 >/dev/null 2>&1; then
        echo "[start.sh] ERROR: ros2 command not found."
        echo "           Set PIPER_ROS_SETUP_FILES in .env or run with PIPER_START_ROS=0 for UI/backend only."
        exit 1
    fi
fi

# ── CAN activation ───────────────────────────────────────────────────

if bool_enabled "$PIPER_START_ROS" && bool_enabled "$PIPER_ACTIVATE_CAN"; then
    echo "[start.sh] Activating CAN interface (${CAN_PORT}, ${CAN_BITRATE})..."
    if [[ -x "$PIPER_WS_DIR/can_activate.sh" || -f "$PIPER_WS_DIR/can_activate.sh" ]]; then
        (cd "$PIPER_WS_DIR" && bash can_activate.sh "$CAN_PORT" "$CAN_BITRATE" "$PIPER_CAN_USB")
    else
        echo "[start.sh] WARNING: can_activate.sh not found at $PIPER_WS_DIR; skipping CAN activation"
    fi
fi

# ── Piper ROS node ───────────────────────────────────────────────────

if bool_enabled "$PIPER_START_ROS"; then
    echo "[start.sh] Starting ${PIPER_ROS_PACKAGE}/${PIPER_ROS_EXECUTABLE}..."
    ros2 run "$PIPER_ROS_PACKAGE" "$PIPER_ROS_EXECUTABLE" \
        --ros-args \
        -p can_port:="$CAN_PORT" \
        -p auto_enable:="$PIPER_AUTO_ENABLE" \
        -p gripper_exist:="$PIPER_GRIPPER_EXIST" &
    PIPER_PID=$!
    PIDS+=("$PIPER_PID")
    echo "[start.sh] Piper ROS PID: $PIPER_PID"
    sleep 2
fi

# ── Flask app ────────────────────────────────────────────────────────

echo "[start.sh] Starting Flask server..."
"$PYTHON_BIN" app.py &
APP_PID=$!
PIDS+=("$APP_PID")
echo "[start.sh] Flask PID: $APP_PID"

echo ""
echo "══════════════════════════════════════════"
echo "  Piper Cowork"
echo "  UI:      http://localhost:${FLASK_PORT}"
echo "  Mobile:  https://localhost:${HTTPS_PORT}/mobile"
echo "  Ctrl+C to stop"
echo "══════════════════════════════════════════"
echo ""

wait
