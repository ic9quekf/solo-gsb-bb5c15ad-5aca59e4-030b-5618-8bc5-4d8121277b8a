"""FastAPI 入口：样本 / 交接事件 CRUD、审计与报告导出。"""
from __future__ import annotations

import os
import re
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Any

from fastapi import Depends, FastAPI, HTTPException, Query
from fastapi.responses import HTMLResponse, PlainTextResponse, Response
from fastapi.staticfiles import StaticFiles
from sqlite3 import Connection

from .audit import build_audit
from .db import get_conn, init_db
from .report import build_html, build_json, build_markdown
from .schemas import EventCreate, SampleCreate


@asynccontextmanager
async def lifespan(_: FastAPI):
    # 启动时建表并写入演示数据（已初始化则跳过）
    init_db()
    yield


app = FastAPI(title="样本交接链路审计", version="1.0.0", lifespan=lifespan)

STATIC_DIR = os.path.join(os.path.dirname(__file__), "static")


@app.get("/api/health")
def health() -> dict[str, str]:
    return {"status": "ok"}


# ---------- 样本 ----------

def _sample_dict(row: Any) -> dict[str, Any]:
    return {
        "id": row["id"],
        "code": row["code"],
        "name": row["name"],
        "description": row["description"],
        "created_at": row["created_at"],
    }


def _fetch_sample(conn: Connection, sample_id: int) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM samples WHERE id = ?", (sample_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="样本不存在")
    return _sample_dict(row)


def _fetch_events(conn: Connection, sample_id: int) -> list[dict[str, Any]]:
    rows = conn.execute(
        "SELECT * FROM events WHERE sample_id = ? ORDER BY id", (sample_id,)
    ).fetchall()
    return [
        {
            "id": r["id"],
            "custodian": r["custodian"],
            "start_time": r["start_time"],
            "end_time": r["end_time"],
            "note": r["note"],
            "seq": r["seq"],
        }
        for r in rows
    ]


@app.get("/api/samples")
def list_samples(conn: Connection = Depends(get_conn)) -> list[dict[str, Any]]:
    rows = conn.execute("SELECT * FROM samples ORDER BY created_at DESC, id DESC").fetchall()
    samples = []
    for r in rows:
        count = conn.execute(
            "SELECT COUNT(*) FROM events WHERE sample_id = ?", (r["id"],)
        ).fetchone()[0]
        d = _sample_dict(r)
        d["event_count"] = count
        samples.append(d)
    return samples


@app.post("/api/samples", status_code=201)
def create_sample(payload: SampleCreate, conn: Connection = Depends(get_conn)) -> dict[str, Any]:
    exists = conn.execute("SELECT 1 FROM samples WHERE code = ?", (payload.code,)).fetchone()
    if exists:
        raise HTTPException(status_code=409, detail=f"样本编号 {payload.code} 已存在")
    cur = conn.execute(
        "INSERT INTO samples (code, name, description, created_at) VALUES (?, ?, ?, ?)",
        (payload.code, payload.name, payload.description,
         datetime.now().strftime("%Y-%m-%d %H:%M:%S")),
    )
    conn.commit()
    return _fetch_sample(conn, cur.lastrowid)


@app.get("/api/samples/{sample_id}")
def get_sample(sample_id: int, conn: Connection = Depends(get_conn)) -> dict[str, Any]:
    sample = _fetch_sample(conn, sample_id)
    events = _fetch_events(conn, sample_id)
    audit = build_audit(events)
    return {"sample": sample, "events": events, "audit": audit}


@app.delete("/api/samples/{sample_id}", status_code=204)
def delete_sample(sample_id: int, conn: Connection = Depends(get_conn)) -> Response:
    _fetch_sample(conn, sample_id)
    conn.execute("DELETE FROM samples WHERE id = ?", (sample_id,))
    conn.commit()
    return Response(status_code=204)


# ---------- 交接事件 ----------

@app.post("/api/samples/{sample_id}/events", status_code=201)
def add_event(
    sample_id: int, payload: EventCreate, conn: Connection = Depends(get_conn)
) -> dict[str, Any]:
    _fetch_sample(conn, sample_id)
    seq = conn.execute(
        "SELECT COALESCE(MAX(seq), 0) + 1 FROM events WHERE sample_id = ?", (sample_id,)
    ).fetchone()[0]
    cur = conn.execute(
        "INSERT INTO events (sample_id, custodian, start_time, end_time, note, seq) "
        "VALUES (?, ?, ?, ?, ?, ?)",
        (sample_id, payload.custodian, payload.start_time, payload.end_time, payload.note, seq),
    )
    conn.commit()
    row = conn.execute("SELECT * FROM events WHERE id = ?", (cur.lastrowid,)).fetchone()
    return {"id": row["id"], "seq": row["seq"]}


@app.put("/api/events/{event_id}")
def update_event(event_id: int, payload: EventCreate, conn: Connection = Depends(get_conn)) -> dict[str, Any]:
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="交接事件不存在")
    conn.execute(
        "UPDATE events SET custodian = ?, start_time = ?, end_time = ?, note = ? WHERE id = ?",
        (payload.custodian, payload.start_time, payload.end_time, payload.note, event_id),
    )
    conn.commit()
    return {"id": event_id, "updated": True}


@app.delete("/api/events/{event_id}", status_code=204)
def delete_event(event_id: int, conn: Connection = Depends(get_conn)) -> Response:
    row = conn.execute("SELECT * FROM events WHERE id = ?", (event_id,)).fetchone()
    if row is None:
        raise HTTPException(status_code=404, detail="交接事件不存在")
    conn.execute("DELETE FROM events WHERE id = ?", (event_id,))
    conn.commit()
    return Response(status_code=204)


# ---------- 审计 ----------

@app.get("/api/samples/{sample_id}/audit")
def get_audit(sample_id: int, conn: Connection = Depends(get_conn)) -> dict[str, Any]:
    _fetch_sample(conn, sample_id)
    return build_audit(_fetch_events(conn, sample_id))


# ---------- 报告导出 ----------

def _safe_filename(code: str, ext: str) -> str:
    stem = re.sub(r"[^\w一-鿿-]+", "_", code).strip("_") or "sample"
    return f"audit_report_{stem}.{ext}"


@app.get("/api/samples/{sample_id}/report")
def export_report(
    sample_id: int,
    format: str = Query("markdown", pattern="^(markdown|html|json)$"),
    conn: Connection = Depends(get_conn),
):
    sample = _fetch_sample(conn, sample_id)
    audit = build_audit(_fetch_events(conn, sample_id))

    if format == "markdown":
        body = build_markdown(sample, audit)
        headers = {"Content-Disposition": f'attachment; filename="{_safe_filename(sample["code"], "md")}"'}
        return PlainTextResponse(content=body, media_type="text/markdown; charset=utf-8", headers=headers)
    if format == "html":
        body = build_html(sample, audit)
        headers = {"Content-Disposition": f'attachment; filename="{_safe_filename(sample["code"], "html")}"'}
        return HTMLResponse(content=body, media_type="text/html; charset=utf-8", headers=headers)

    body = build_json(sample, audit)
    headers = {"Content-Disposition": f'attachment; filename="{_safe_filename(sample["code"], "json")}"'}
    return Response(content=body, media_type="application/json; charset=utf-8", headers=headers)


# ---------- 前端静态页（挂在最后，避免吞掉 API 路由） ----------

app.mount("/", StaticFiles(directory=STATIC_DIR, html=True), name="static")
