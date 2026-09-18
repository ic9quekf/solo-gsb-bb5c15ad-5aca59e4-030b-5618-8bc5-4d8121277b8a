"""结论签署流程测试：快照不可变、列表/详情、撤销保留快照、报告集成。"""
from __future__ import annotations

import os
import tempfile

_tmp = tempfile.mkdtemp(prefix="audit-signoff-tests-")
os.environ["AUDIT_DB_PATH"] = os.path.join(_tmp, "test_signoff.db")

import pytest
from fastapi.testclient import TestClient

from app.db import init_db
from app.main import app


@pytest.fixture(scope="module")
def client():
    init_db()
    with TestClient(app) as c:
        yield c


@pytest.fixture()
def sample(client):
    code = "UT-SIGNOFF-001"
    for s in client.get("/api/samples").json():
        if s["code"] == code:
            client.delete(f"/api/samples/{s['id']}")
    resp = client.post(
        "/api/samples",
        json={"code": code, "name": "签署测试样本", "description": "用于签署流程测试"},
    )
    assert resp.status_code == 201
    return resp.json()


def _add_event(client, sid, custodian, start, end=None):
    resp = client.post(
        f"/api/samples/{sid}/events",
        json={"custodian": custodian, "start_time": start, "end_time": end},
    )
    assert resp.status_code == 201
    return resp.json()


def test_signoff_full_lifecycle(client, sample):
    sid = sample["id"]
    _add_event(client, sid, "张三", "2026-09-18 09:00:00", "2026-09-18 10:00:00")
    _add_event(client, sid, "李四", "2026-09-18 10:30:00", "2026-09-18 11:00:00")

    # 提交签署 -> 201，返回摘要
    resp = client.post(
        f"/api/samples/{sid}/signoffs",
        json={"signer": "审计员王敏", "signed_at": "2026-09-18 12:00:00",
              "remark": "已复核，断档属实"},
    )
    assert resp.status_code == 201
    so = resp.json()
    assert so["signer"] == "审计员王敏"
    assert so["status"] == "active"
    assert so["audit_status"] == "fail"  # 存在 30 分钟断档
    assert so["event_count"] == 2
    assert so["gaps"] == 1

    # 列表包含该签署及摘要
    lst = client.get(f"/api/samples/{sid}/signoffs").json()
    assert len(lst) == 1
    assert lst[0]["id"] == so["id"]
    assert lst[0]["audit_conclusion"]

    # 详情包含完整快照（样本 + 事件 + 审计发现）
    detail = client.get(f"/api/signoffs/{so['id']}").json()
    snap = detail["snapshot"]
    assert snap["sample"]["code"] == sample["code"]
    assert len(snap["events"]) == 2
    assert snap["audit"]["summary"]["gaps"] == 1
    assert any(f["code"] == "gap" for f in snap["audit"]["findings"])

    # 后续事件变更不得改写历史快照：修复断档后，快照仍记录旧结论
    _add_event(client, sid, "王五", "2026-09-18 10:00:00", "2026-09-18 10:30:00")
    current = client.get(f"/api/samples/{sid}/audit").json()
    assert current["summary"]["gaps"] == 0  # 当前审计已通过
    again = client.get(f"/api/signoffs/{so['id']}").json()
    assert again["snapshot"]["audit"]["summary"]["gaps"] == 1
    assert len(again["snapshot"]["events"]) == 2

    # 样本详情接口携带签署摘要
    detail_resp = client.get(f"/api/samples/{sid}").json()
    assert len(detail_resp["signoffs"]) == 1
    assert detail_resp["signoffs"][0]["status"] == "active"

    # 撤销：必须填写原因，快照保留
    assert client.post(f"/api/signoffs/{so['id']}/revoke", json={"reason": ""}).status_code == 422
    revoked = client.post(
        f"/api/signoffs/{so['id']}/revoke",
        json={"reason": "签署后补录了遗漏事件，需重新签署"},
    )
    assert revoked.status_code == 200
    body = revoked.json()
    assert body["status"] == "revoked"
    assert body["revoke_reason"] == "签署后补录了遗漏事件，需重新签署"
    assert body["revoked_at"]

    # 重复撤销 -> 409；原快照仍完整保留
    assert (
        client.post(f"/api/signoffs/{so['id']}/revoke", json={"reason": "再次撤销"}).status_code
        == 409
    )
    kept = client.get(f"/api/signoffs/{so['id']}").json()
    assert kept["status"] == "revoked"
    assert kept["snapshot"]["audit"]["summary"]["gaps"] == 1
    assert len(kept["snapshot"]["events"]) == 2

    # 撤销后可重新签署
    resp2 = client.post(f"/api/samples/{sid}/signoffs", json={"signer": "审计员王敏"})
    assert resp2.status_code == 201
    assert resp2.json()["status"] == "active"
    assert resp2.json()["signed_at"]  # 缺省取当前时间
    lst = client.get(f"/api/samples/{sid}/signoffs").json()
    assert {s["status"] for s in lst} == {"active", "revoked"}


def test_signoff_validation_and_not_found(client, sample):
    sid = sample["id"]
    # 签署人必填
    assert client.post(f"/api/samples/{sid}/signoffs", json={"signer": ""}).status_code == 422
    assert client.post(f"/api/samples/{sid}/signoffs", json={}).status_code == 422
    # 签署时间格式校验
    bad_time = client.post(
        f"/api/samples/{sid}/signoffs", json={"signer": "王敏", "signed_at": "昨天"}
    )
    assert bad_time.status_code == 422
    # 样本不存在 / 签署记录不存在
    assert client.post("/api/samples/99999/signoffs", json={"signer": "王敏"}).status_code == 404
    assert client.get(f"/api/samples/{sid}/signoffs").status_code == 200
    assert client.get("/api/signoffs/99999").status_code == 404
    assert (
        client.post("/api/signoffs/99999/revoke", json={"reason": "x"}).status_code == 404
    )


def test_report_includes_signoffs(client, sample):
    sid = sample["id"]
    client.post(
        f"/api/samples/{sid}/signoffs",
        json={"signer": "报告签署人", "remark": "报告导出校验"},
    )

    md = client.get(f"/api/samples/{sid}/report?format=markdown")
    assert md.status_code == 200
    assert "结论签署" in md.text
    assert "报告签署人" in md.text

    html_resp = client.get(f"/api/samples/{sid}/report?format=html")
    assert "结论签署" in html_resp.text
    assert "报告签署人" in html_resp.text

    payload = client.get(f"/api/samples/{sid}/report?format=json").json()
    assert any(s["signer"] == "报告签署人" for s in payload["signoffs"])
