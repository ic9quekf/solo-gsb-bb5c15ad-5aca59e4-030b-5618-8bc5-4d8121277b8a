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
    renderTimeline();
    renderEvents();
    resetForm();
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
