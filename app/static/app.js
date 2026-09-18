/* 样本交接链路审计 —— 前端逻辑（原生 JS，无框架） */
(() => {
  "use strict";

  const $ = (sel) => document.querySelector(sel);

  const state = {
    samples: [],
    currentId: null,
    data: null, // { sample, events, audit }
    editingId: null,
  };

  // ---------- 工具 ----------

  function toast(msg, isError = false) {
    const el = $("#toast");
    el.textContent = msg;
    el.className = "toast" + (isError ? " error" : "");
    el.hidden = false;
    clearTimeout(toast._t);
    toast._t = setTimeout(() => (el.hidden = true), 2600);
  }

  async function api(path, options = {}) {
    const resp = await fetch(path, {
      headers: { "Content-Type": "application/json" },
      ...options,
    });
    if (resp.status === 204) return null;
    let payload = null;
    try {
      payload = await resp.json();
    } catch (_) {
      /* 非 JSON 响应 */
    }
    if (!resp.ok) {
      throw new Error(extractError(payload) || `请求失败（${resp.status}）`);
    }
    return payload;
  }

  function extractError(payload) {
    if (!payload) return "";
    if (typeof payload.detail === "string") return payload.detail;
    if (Array.isArray(payload.detail)) {
      return payload.detail
        .map((d) => {
          const field = d.loc && d.loc.length > 1 ? d.loc[d.loc.length - 1] : "";
          return field ? `【${field}】${d.msg}` : d.msg;
        })
        .join("；");
    }
    return payload.detail || "";
  }

  const esc = (s) =>
    String(s ?? "").replace(/[&<>"']/g, (c) => ({
      "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[c]);

  // 存储格式 "YYYY-MM-DD HH:MM:SS" -> datetime-local 格式
  const toLocalInput = (s) => (s ? s.replace(" ", "T").slice(0, 19) : "");

  const STATUS_LABEL = { pass: "审计通过", warning: "通过 · 有告警", fail: "审计未通过", empty: "暂无数据" };
  const FINDING_LABEL = {
    gap: "断档", overlap: "重叠", reversed_interval: "起止倒置",
    out_of_order: "逆序录入", bad_time: "时间错误",
  };
  const SIGNOFF_STATUS_LABEL = { active: "已签署", revoked: "已撤销" };

  // ---------- 样本列表 ----------

  async function loadSamples(selectId = null) {
    state.samples = await api("/api/samples");
    const ul = $("#sample-list");
    if (!state.samples.length) {
      ul.innerHTML = `<li class="muted-cell" style="cursor:default">暂无样本，点击右上角新建</li>`;
    } else {
      ul.innerHTML = state.samples
        .map(
          (s) => `
        <li data-id="${s.id}" class="${s.id === state.currentId ? "active" : ""}">
          <div class="s-code">${esc(s.code)}</div>
          <div class="s-name">${esc(s.name)}</div>
          <span class="s-count">${s.event_count} 条交接</span>
        </li>`
        )
        .join("");
    }
    if (selectId) selectSample(selectId);
    else if (state.currentId && !state.samples.some((s) => s.id === state.currentId)) {
      state.currentId = null;
      showEmpty();
    }
  }

  $("#sample-list").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-id]");
    if (li) selectSample(Number(li.dataset.id));
  });

  function showEmpty() {
    $("#detail").hidden = true;
    $("#empty-state").hidden = false;
  }

  async function selectSample(id) {
    try {
      state.currentId = id;
      state.data = await api(`/api/samples/${id}`);
      state.editingId = null;
      renderAll();
      $("#empty-state").hidden = true;
      $("#detail").hidden = false;
      document.querySelectorAll("#sample-list li").forEach((li) =>
        li.classList.toggle("active", Number(li.dataset.id) === id)
      );
    } catch (err) {
      toast(err.message, true);
    }
  }

  // ---------- 渲染 ----------

  function renderAll() {
    renderSample();
    renderAudit();
    renderSignoffs();
    renderTimeline();
    renderEvents();
    resetForm();
    resetSignoffForm();
  }

  function renderSample() {
    const { sample } = state.data;
    $("#d-code").textContent = sample.code;
    $("#d-name").textContent = sample.name;
    $("#d-desc").textContent = sample.description || "（无描述）";
  }

  function renderAudit() {
    const { audit } = state.data;
    const badge = $("#audit-badge");
    badge.textContent = STATUS_LABEL[audit.status] || audit.status;
    badge.className = `badge badge-${audit.status}`;
    $("#audit-conclusion").textContent = audit.conclusion;

    const s = audit.summary;
    const stat = (num, lbl, cls = "") =>
      `<div class="stat ${cls}"><div class="num">${num}</div><div class="lbl">${lbl}</div></div>`;
    $("#audit-stats").innerHTML = [
      stat(s.total, "交接记录"),
      stat(s.gaps, "断档", s.gaps ? "bad" : ""),
      stat(s.overlaps, "重叠", s.overlaps ? "bad" : ""),
      stat(s.reversed, "起止倒置", s.reversed ? "bad" : ""),
      stat(s.out_of_order, "逆序录入", s.out_of_order ? "warn" : ""),
      stat(s.open_holds, "未归还", s.open_holds ? "warn" : ""),
    ].join("");

    const fl = $("#findings");
    if (!audit.findings.length) {
      fl.innerHTML = `<li class="muted-item">✓ 未发现断档、重叠或逆序问题。</li>`;
    } else {
      fl.innerHTML = audit.findings
        .map(
          (f, i) => `
        <li class="finding-${f.code}" data-ids="${(f.event_ids || []).join(",")}">
          <span class="tag">${FINDING_LABEL[f.code] || f.code}</span>
          <span>${esc(f.message)}</span>
        </li>`
        )
        .join("");
    }
  }

  function renderTimeline() {
    const tl = state.data.audit.timeline;
    const wrap = $("#timeline");
    if (!tl.bars.length) {
      wrap.innerHTML = `<div class="tl-empty">暂无交接事件，登记后将在此显示时间线。</div>`;
      return;
    }

    // 泳道
    const lanes = [];
    for (let i = 0; i < tl.lanes; i++) {
      lanes.push(`<div class="tl-lane"></div>`);
    }

    // 冲突区域贯穿所有泳道
    const zones = tl.zones
      .map(
        (z) => `
      <div class="tl-zone ${z.kind}" style="left:${z.left}%;width:${z.width}%"
           title="${z.kind === "gap" ? "保管断档" : "交接重叠"}：${esc(z.from)} ~ ${esc(z.to)}">
        ${z.kind === "gap" ? "断档" : "重叠"}
      </div>`
      )
      .join("");

    // 事件条
    const bars = tl.bars
      .map((b) => {
        const cls = ["tl-bar"];
        if (b.conflict) cls.push("conflict");
        if (b.open) cls.push("open");
        const tip = `${b.custodian}\n${b.start_label} ~ ${b.end_label}${
          b.conflict ? "\n⚠ 该事件涉及审计冲突" : ""
        }`;
        return `
        <div class="${cls.join(" ")}" data-eid="${b.id}"
             style="left:${b.left}%;width:${b.width}%;top:${b.lane * 42 + 6}px"
             title="${esc(tip)}">
          <span class="bar-id">#${b.id}</span>${esc(b.custodian)}${b.open ? " ◷" : ""}
        </div>`;
      })
      .join("");

    const ticks = tl.ticks
      .map((t) => `<span class="tl-tick" style="left:${t.left}%">${esc(t.label)}</span>`)
      .join("");

    wrap.innerHTML = `
      <div class="tl-scroll">
        <div class="tl-lanes" style="height:${tl.lanes * 42}px">
          <div class="tl-zones">${zones}</div>
          ${bars}
          ${lanes.join("")}
        </div>
        <div class="tl-axis">${ticks}</div>
        <div class="tl-range">时间范围：${esc(tl.start)} ~ ${esc(tl.end)}（仍在保管的事件以斜纹延伸显示）</div>
      </div>`;
  }

  function renderEvents() {
    const { audit } = state.data;
    const tbody = $("#event-tbody");
    if (!audit.events.length) {
      tbody.innerHTML = `<tr><td colspan="8" class="muted-cell" style="text-align:center;padding:22px">暂无交接事件</td></tr>`;
      return;
    }
    tbody.innerHTML = audit.events
      .map((e, idx) => {
        const end = e.open
          ? `<span class="open-tag">仍在保管</span><div class="muted-cell">自 ${esc(e.start_time)} 起</div>`
          : esc(e.end_time);
        return `
        <tr class="${e.has_conflict ? "row-conflict" : ""}" data-eid="${e.id}">
          <td class="col-ord">${idx + 1}</td>
          <td class="col-seq">${e.seq}</td>
          <td>${e.has_conflict ? '<span class="conflict-flag">⚠</span>' : ""}${esc(e.custodian)}</td>
          <td>${esc(e.start_time)}</td>
          <td>${end}</td>
          <td>${esc(e.duration)}</td>
          <td>${esc(e.note || "—")}</td>
          <td>
            <button class="link-btn btn-edit" data-act="edit" data-id="${e.id}">编辑</button>
            <button class="link-btn btn-del" data-act="delete" data-id="${e.id}">删除</button>
          </td>
        </tr>`;
      })
      .join("");
  }

  // 点击审计发现 -> 高亮相关事件条与表格行
  $("#findings").addEventListener("click", (e) => {
    const li = e.target.closest("li[data-ids]");
    if (!li) return;
    const ids = li.dataset.ids.split(",").filter(Boolean).map(Number);
    ids.forEach((id) => {
      document.querySelectorAll(`[data-eid="${id}"]`).forEach((el) => {
        el.style.outline = "2px solid #f59e0b";
        setTimeout(() => (el.style.outline = ""), 1800);
      });
    });
  });

  // ---------- 结论签署 ----------

  function renderSignoffs() {
    const signoffs = state.data.signoffs || [];
    const active = signoffs.find((s) => s.status === "active");

    const badge = $("#signoff-status");
    if (active) {
      badge.textContent = `已签署 · ${active.signer}`;
      badge.className = "badge badge-pass";
    } else if (signoffs.length) {
      badge.textContent = "最近签署已撤销";
      badge.className = "badge badge-warning";
    } else {
      badge.textContent = "未签署";
      badge.className = "badge badge-empty";
    }

    const tbody = $("#signoff-tbody");
    if (!signoffs.length) {
      tbody.innerHTML = `<tr><td colspan="7" class="muted-cell" style="text-align:center;padding:18px">暂无签署记录，提交签署后将生成不可变快照</td></tr>`;
      return;
    }
    tbody.innerHTML = signoffs
      .map((so, idx) => {
        const stCls = so.status === "active" ? "signoff-active" : "signoff-revoked";
        const snapLabel = STATUS_LABEL[so.audit_status] || so.audit_status || "—";
        const revokeInfo =
          so.status === "revoked"
            ? `<div class="muted-cell">撤销于 ${esc(so.revoked_at || "")}<br>${esc(so.revoke_reason || "")}</div>`
            : "";
        return `
        <tr class="${so.status === "revoked" ? "row-revoked" : ""}">
          <td class="col-ord">${signoffs.length - idx}</td>
          <td>${esc(so.signer)}</td>
          <td>${esc(so.signed_at)}</td>
          <td><span class="badge badge-${esc(so.audit_status || "empty")}">${esc(snapLabel)}</span>
            <div class="muted-cell">${so.event_count} 条事件 · ${so.findings_count} 项发现</div></td>
          <td><span class="signoff-tag ${stCls}">${SIGNOFF_STATUS_LABEL[so.status] || so.status}</span>${revokeInfo}</td>
          <td>${esc(so.remark || "—")}</td>
          <td>
            <button class="link-btn btn-edit" data-so="view" data-id="${so.id}">查看快照</button>
            ${so.status === "active" ? `<button class="link-btn btn-del" data-so="revoke" data-id="${so.id}">撤销</button>` : ""}
          </td>
        </tr>`;
      })
      .join("");
  }

  // 提交签署：默认签署时间为当前时间
  function resetSignoffForm() {
    $("#signoff-form").reset();
    const now = new Date(Date.now() - new Date().getTimezoneOffset() * 60000);
    $("#so-signed-at").value = now.toISOString().slice(0, 19);
  }

  $("#signoff-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      signer: $("#so-signer").value.trim(),
      signed_at: $("#so-signed-at").value || null,
      remark: $("#so-remark").value.trim(),
    };
    if (!payload.signer) {
      toast("请填写签署人", true);
      return;
    }
    try {
      await api(`/api/samples/${state.currentId}/signoffs`, {
        method: "POST",
        body: JSON.stringify(payload),
      });
      toast("签署已提交，快照已保存");
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // 快照详情 / 撤销
  const signoffModal = $("#signoff-modal");
  const revokeModal = $("#revoke-modal");
  let revokingId = null;

  $("#signoff-tbody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-so]");
    if (!btn) return;
    const id = Number(btn.dataset.id);

    if (btn.dataset.so === "view") {
      try {
        const detail = await api(`/api/signoffs/${id}`);
        renderSignoffDetail(detail);
        signoffModal.hidden = false;
      } catch (err) {
        toast(err.message, true);
      }
      return;
    }

    if (btn.dataset.so === "revoke") {
      revokingId = id;
      $("#revoke-form").reset();
      revokeModal.hidden = false;
      $("#revoke-reason").focus();
    }
  });

  function renderSignoffDetail(d) {
    const snap = d.snapshot || {};
    const sample = snap.sample || {};
    const audit = snap.audit || {};
    const events = (audit.events || []);
    const summary = audit.summary || {};
    const revoked =
      d.status === "revoked"
        ? `<div class="revoke-banner">已于 ${esc(d.revoked_at || "")} 撤销：${esc(d.revoke_reason || "")}</div>`
        : "";
    const findings = (audit.findings || [])
      .map(
        (f) => `<li class="finding-${esc(f.code)}">
          <span class="tag">${FINDING_LABEL[f.code] || esc(f.code)}</span><span>${esc(f.message)}</span>
        </li>`
      )
      .join("");
    const rows = events
      .map(
        (ev, i) => `<tr class="${ev.has_conflict ? "row-conflict" : ""}">
          <td class="col-ord">${i + 1}</td><td class="col-seq">${ev.seq}</td>
          <td>${esc(ev.custodian)}</td><td>${esc(ev.start_time)}</td>
          <td>${ev.open ? '<span class="open-tag">仍在保管</span>' : esc(ev.end_time)}</td>
          <td>${esc(ev.duration)}</td><td>${esc(ev.note || "—")}</td>
        </tr>`
      )
      .join("");

    $("#signoff-detail").innerHTML = `
      ${revoked}
      <div class="signoff-meta">
        <span class="signoff-tag ${d.status === "active" ? "signoff-active" : "signoff-revoked"}">${SIGNOFF_STATUS_LABEL[d.status] || d.status}</span>
        <span>签署人：<b>${esc(d.signer)}</b></span>
        <span>签署时间：${esc(d.signed_at)}</span>
        <span>备注：${esc(d.remark || "—")}</span>
      </div>
      <div class="signoff-meta">
        <span>样本：<b>${esc(sample.code || "")}</b> ${esc(sample.name || "")}</span>
        <span>快照事件数：${summary.total ?? events.length}</span>
        <span>断档 ${summary.gaps ?? 0} · 重叠 ${summary.overlaps ?? 0} · 逆序 ${summary.out_of_order ?? 0}</span>
      </div>
      <p class="conclusion"><span class="badge badge-${esc(audit.status || "empty")}">${STATUS_LABEL[audit.status] || "—"}</span>
        ${esc(audit.conclusion || "")}</p>
      ${findings ? `<ul class="findings">${findings}</ul>` : '<p class="muted-cell">✓ 快照时未发现断档、重叠或逆序问题。</p>'}
      <div class="table-wrap">
        <table class="event-table">
          <thead><tr><th>排序#</th><th>录入序</th><th>经手人</th><th>起始时间</th><th>结束时间</th><th>时长</th><th>备注</th></tr></thead>
          <tbody>${rows || '<tr><td colspan="7" class="muted-cell" style="text-align:center">快照中无交接事件</td></tr>'}</tbody>
        </table>
      </div>
      <p class="muted-cell" style="margin-top:10px">该快照为签署时刻的不可变记录，后续事件变更不影响此内容。</p>`;
  }

  $("#btn-close-signoff").addEventListener("click", () => (signoffModal.hidden = true));
  signoffModal.addEventListener("click", (e) => {
    if (e.target === signoffModal) signoffModal.hidden = true;
  });

  $("#btn-cancel-revoke").addEventListener("click", () => (revokeModal.hidden = true));
  revokeModal.addEventListener("click", (e) => {
    if (e.target === revokeModal) revokeModal.hidden = true;
  });

  $("#revoke-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const reason = $("#revoke-reason").value.trim();
    if (!reason) {
      toast("请填写撤销原因", true);
      return;
    }
    try {
      await api(`/api/signoffs/${revokingId}/revoke`, {
        method: "POST",
        body: JSON.stringify({ reason }),
      });
      revokeModal.hidden = true;
      toast("签署已撤销，快照已保留");
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- 事件增 / 改 / 删 ----------

  function resetForm() {
    $("#event-form").reset();
    $("#f-event-id").value = "";
    state.editingId = null;
    $("#btn-submit-event").textContent = "登记交接事件";
    $("#btn-cancel-edit").hidden = true;
  }

  $("#btn-cancel-edit").addEventListener("click", resetForm);

  $("#event-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      custodian: $("#f-custodian").value.trim(),
      start_time: $("#f-start").value,
      end_time: $("#f-end").value || null,
      note: $("#f-note").value.trim(),
    };
    if (!payload.custodian || !payload.start_time) {
      toast("请填写经手人与起始时间", true);
      return;
    }
    try {
      if (state.editingId) {
        await api(`/api/events/${state.editingId}`, { method: "PUT", body: JSON.stringify(payload) });
        toast("交接事件已更新");
      } else {
        await api(`/api/samples/${state.currentId}/events`, {
          method: "POST",
          body: JSON.stringify(payload),
        });
        toast("交接事件已登记");
      }
      await refresh();
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#event-tbody").addEventListener("click", async (e) => {
    const btn = e.target.closest("button[data-act]");
    if (!btn) return;
    const id = Number(btn.dataset.id);

    if (btn.dataset.act === "edit") {
      const ev = state.data.events.find((x) => x.id === id);
      if (!ev) return;
      state.editingId = id;
      $("#f-event-id").value = id;
      $("#f-custodian").value = ev.custodian;
      $("#f-start").value = toLocalInput(ev.start_time);
      $("#f-end").value = toLocalInput(ev.end_time);
      $("#f-note").value = ev.note || "";
      $("#btn-submit-event").textContent = "保存修改";
      $("#btn-cancel-edit").hidden = false;
      $("#f-custodian").scrollIntoView({ behavior: "smooth", block: "center" });
      $("#f-custodian").focus();
      return;
    }

    if (btn.dataset.act === "delete") {
      if (!confirm("确定删除这条交接事件？删除后将重新审计链路。")) return;
      try {
        await api(`/api/events/${id}`, { method: "DELETE" });
        toast("事件已删除");
        await refresh();
      } catch (err) {
        toast(err.message, true);
      }
    }
  });

  async function refresh() {
    await loadSamples(state.currentId); // 事件数更新
    if (state.currentId) {
      state.data = await api(`/api/samples/${state.currentId}`);
      renderAll();
    }
  }

  // ---------- 样本新建 / 删除 ----------

  const modal = $("#modal-mask");
  $("#btn-new-sample").addEventListener("click", () => {
    $("#sample-form").reset();
    modal.hidden = false;
    $("#s-code").focus();
  });
  $("#btn-cancel-sample").addEventListener("click", () => (modal.hidden = true));
  modal.addEventListener("click", (e) => {
    if (e.target === modal) modal.hidden = true;
  });

  $("#sample-form").addEventListener("submit", async (e) => {
    e.preventDefault();
    const payload = {
      code: $("#s-code").value.trim(),
      name: $("#s-name").value.trim(),
      description: $("#s-desc").value.trim(),
    };
    try {
      const created = await api("/api/samples", { method: "POST", body: JSON.stringify(payload) });
      modal.hidden = true;
      toast("样本已创建");
      await loadSamples(created.id);
    } catch (err) {
      toast(err.message, true);
    }
  });

  $("#btn-delete-sample").addEventListener("click", async () => {
    const { sample } = state.data;
    if (!confirm(`确定删除样本 ${sample.code} 及其全部交接事件？此操作不可恢复。`)) return;
    try {
      await api(`/api/samples/${state.currentId}`, { method: "DELETE" });
      toast("样本已删除");
      state.currentId = null;
      await loadSamples();
      showEmpty();
    } catch (err) {
      toast(err.message, true);
    }
  });

  // ---------- 报告导出 ----------

  document.querySelectorAll("[data-export]").forEach((btn) => {
    btn.addEventListener("click", () => {
      const fmt = btn.dataset.export;
      const url = `/api/samples/${state.currentId}/report?format=${fmt}`;
      const a = document.createElement("a");
      a.href = url;
      a.download = "";
      document.body.appendChild(a);
      a.click();
      a.remove();
    });
  });

  // ---------- 启动 ----------

  (async function init() {
    try {
      await loadSamples();
      if (state.samples.length) await selectSample(state.samples[0].id);
      else showEmpty();
    } catch (err) {
      toast("初始化失败：" + err.message, true);
    }
  })();
})();
