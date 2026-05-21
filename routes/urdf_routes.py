"""
URDF + 메시 파일 서빙 (Piper 로봇 3D 뷰어용)

GET /api/urdf/piper.urdf        — URDF (mesh 경로를 /api/urdf/meshes/... 로 교체)
GET /api/urdf/meshes/<filename> — STL 메시 파일
"""

import os

from flask import Blueprint, Response, send_from_directory, abort

bp = Blueprint("urdf", __name__, url_prefix="/api/urdf")

_URDF_PATH = (
    "/home/cglab/robotarm/piper_ws/src/Piper_ros/src/piper_description"
    "/urdf/piper_description.urdf"
)
_MESH_DIR = (
    "/home/cglab/robotarm/piper_ws/src/Piper_ros/src/piper_description/meshes"
)


@bp.get("/piper.urdf")
def get_urdf():
    if not os.path.exists(_URDF_PATH):
        return abort(404)
    with open(_URDF_PATH) as f:
        content = f.read()
    # package:// 경로는 그대로 유지 — 프론트엔드의 URDFLoader.packages 로 해결
    return Response(content, mimetype="application/xml")


@bp.get("/meshes/<filename>")
def get_mesh(filename: str):
    if not os.path.exists(_MESH_DIR):
        return abort(404)
    return send_from_directory(_MESH_DIR, filename)
