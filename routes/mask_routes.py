"""
마스크 라이브러리 API
  GET    /api/masks               — 전체 목록
  POST   /api/masks               — 새 마스크 저장  body: {name, polygon, source_episode?, source_take?}
  DELETE /api/masks/<mask_id>     — 삭제
"""

import json
import os
import uuid
from datetime import datetime, timezone

from flask import Blueprint, jsonify, request, abort

bp = Blueprint("masks", __name__, url_prefix="/api/masks")

_LIBRARY_PATH: str | None = None


def _lib_path() -> str:
    global _LIBRARY_PATH
    if _LIBRARY_PATH is None:
        from config import DATASET_PATH
        _LIBRARY_PATH = os.path.join(os.path.dirname(DATASET_PATH), "mask_library.json")
    return _LIBRARY_PATH


def _load() -> list[dict]:
    p = _lib_path()
    if not os.path.exists(p):
        return []
    with open(p) as f:
        return json.load(f)


def _save(entries: list[dict]) -> None:
    with open(_lib_path(), "w") as f:
        json.dump(entries, f, indent=2)


@bp.get("")
def list_masks():
    return jsonify(_load())


@bp.post("")
def create_mask():
    data = request.get_json(silent=True) or {}
    polygon = data.get("polygon", [])
    if len(polygon) < 3:
        return abort(400)
    entry = {
        "id":             str(uuid.uuid4())[:8],
        "name":           str(data.get("name", "untitled")),
        "polygon":        polygon,
        "created_at":     datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M"),
        "source_episode": data.get("source_episode"),
        "source_take":    data.get("source_take"),
    }
    entries = _load()
    entries.append(entry)
    _save(entries)
    return jsonify(entry), 201


@bp.delete("/<mask_id>")
def delete_mask(mask_id: str):
    entries = _load()
    new_entries = [e for e in entries if e["id"] != mask_id]
    if len(new_entries) == len(entries):
        return abort(404)
    _save(new_entries)
    return jsonify({"ok": True})
