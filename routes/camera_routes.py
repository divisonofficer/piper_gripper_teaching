from flask import Blueprint, abort, jsonify, request

from camera_manifest import load_manifest, update_manifest_edits


bp = Blueprint("cameras", __name__, url_prefix="/api/cameras")


@bp.get("/manifest")
def get_manifest():
    return jsonify(load_manifest())


@bp.put("/manifest")
def put_manifest():
    data = request.get_json(silent=True) or {}
    try:
        return jsonify(update_manifest_edits(data))
    except (OSError, ValueError):
        return abort(400)
