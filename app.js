(() => {
  "use strict";

  // ================================================================== basics
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const S = {
    token: sessionStorage.getItem("il-token") || "",
    cfg: {}, tab: "workloads", namespaces: [],
    deployments: [], configmaps: [], secrets: [], pvcs: [], pvs: [], classes: [],
    nodes: null, nodesAt: 0,
  };
  let refreshTimer = null;

  async function api(path, opts = {}) {
    const headers = Object.assign({}, opts.headers || {});
    if (S.token) headers.Authorization = "Bearer " + S.token;
    if (opts.json !== undefined) { headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(opts.json); }
    const res = await fetch(path, Object.assign({}, opts, { headers }));
    if (res.status === 401) { showLogin(); throw new Error("Sign in required"); }
    const data = await res.json().catch(() => ({}));
    if (!res.ok) {
      const d = data.detail;
      throw new Error(Array.isArray(d) ? d.map((e) => `${e.loc?.slice(-1)[0]}: ${e.msg}`).join("; ") : (d || res.statusText));
    }
    return data;
  }
  const qs = (o) => new URLSearchParams(o).toString();

  function toast(msg, kind = "") {
    const el = document.createElement("div");
    el.className = "toast " + kind; el.textContent = msg;
    $("toasts").appendChild(el);
    setTimeout(() => el.remove(), kind === "error" ? 8000 : 5000);
  }
  function age(sec) {
    if (sec == null) return "";
    if (sec < 3600) return Math.max(1, Math.floor(sec / 60)) + "m";
    if (sec < 86400) return Math.floor(sec / 3600) + "h";
    return Math.floor(sec / 86400) + "d";
  }
  const timeOf = (iso) => iso ? new Date(iso).toLocaleTimeString() : "";
  const nsName = (x) => `<div class="dname">${esc(x.name)}</div><div class="dns">${esc(x.namespace)}</div>`;
  const usedBy = (list) => list && list.length ? `<span class="used">${list.map(esc).join(", ")}</span>` : '<span class="muted">Not used</span>';
  const matches = (x, ...fields) => {
    const q = $("search").value.trim().toLowerCase();
    return !q || fields.some((f) => String(f ?? "").toLowerCase().includes(q));
  };
  const currentNs = () => $("nsSelect").value;
  const canWrite = (ns) => !S.cfg.read_only && !(S.cfg.protected_namespaces || []).includes(ns);
  const ABBR = { ReadWriteOnce: "RWO", ReadOnlyMany: "ROX", ReadWriteMany: "RWX", ReadWriteOncePod: "RWOP" };

  async function busy(btn, label, fn) {
    const old = btn.textContent; btn.disabled = true; btn.textContent = label;
    try { return await fn(); } finally { btn.disabled = false; btn.textContent = old; }
  }
  function typedConfirm(name, message) {
    const v = prompt(`${message}\n\nType ${name} to confirm.`);
    return v !== null && v.trim() === name;
  }

  async function getNodes(force = false) {
    if (!force && S.nodes && Date.now() - S.nodesAt < 30000) return S.nodes;
    S.nodes = (await api("/api/agents")).nodes; S.nodesAt = Date.now();
    return S.nodes;
  }
  const nsOptions = (sel) => S.namespaces.filter(canWrite).map((n) => `<option ${n === sel ? "selected" : ""}>${esc(n)}</option>`).join("");

  // ================================================================== auth
  function showLogin() {
    $("app").hidden = true; $("tabs").hidden = true; $("login").hidden = false; $("signOut").hidden = true;
    stopRefresh(); $("tokenInput").focus();
  }
  $("tokenBtn").onclick = () => { S.token = $("tokenInput").value.trim(); sessionStorage.setItem("il-token", S.token); start(); };
  $("tokenInput").addEventListener("keydown", (e) => { if (e.key === "Enter") $("tokenBtn").click(); });
  $("signOut").onclick = () => { S.token = ""; sessionStorage.removeItem("il-token"); showLogin(); };

  // ================================================================== routing
  const VIEWS = ["workloads", "images", "configmaps", "secrets", "storage", "nodes"];
  function route() {
    const tab = (location.hash || "#workloads").slice(1);
    S.tab = VIEWS.includes(tab) ? tab : "workloads";
    VIEWS.forEach((v) => { $("v-" + v).hidden = v !== S.tab; });
    document.querySelectorAll("#tabs a").forEach((a) => a.setAttribute("aria-current", a.getAttribute("href") === "#" + S.tab ? "page" : "false"));
    $("systemToggle").hidden = !["configmaps", "secrets"].includes(S.tab);
    $("nsSelect").disabled = S.tab === "nodes" || S.tab === "images";
    $("search").value = "";
    refreshView();
  }
  window.addEventListener("hashchange", route);

  function refreshView() {
    const loaders = {
      workloads: loadDeployments, images: loadImages, configmaps: loadConfigMaps, secrets: loadSecrets,
      storage: loadStorage, nodes: () => { loadNodes(); loadJobs(); loadAudit(); },
    };
    loaders[S.tab]();
  }
  function rerender() {
    ({ workloads: renderDeployments, images: renderImages, configmaps: renderConfigMaps, secrets: renderSecrets,
       storage: renderStorage, nodes: () => {} })[S.tab]();
  }

  // ================================================================== generic editor sheet
  const Ed = {
    open(title, sub, bodyHtml, buttons = []) {
      $("edTitle").textContent = title; $("edSub").textContent = sub || "";
      $("edBody").innerHTML = bodyHtml;
      const foot = $("edFoot"); foot.innerHTML = "";
      const left = buttons.filter((b) => b.left), right = buttons.filter((b) => !b.left);
      const mk = (b) => {
        const el = document.createElement("button");
        el.className = "btn " + (b.cls || ""); el.textContent = b.label; if (b.id) el.id = b.id;
        el.onclick = () => b.onClick(el); return el;
      };
      left.forEach((b) => foot.appendChild(mk(b)));
      const sp = document.createElement("div"); sp.className = "spacer"; foot.appendChild(sp);
      foot.appendChild(mk({ label: right.length ? "Cancel" : "Close", onClick: Ed.close }));
      right.forEach((b) => foot.appendChild(mk(b)));
      $("edScrim").classList.add("open"); $("editor").classList.add("open");
      return $("edBody");
    },
    close() { $("edScrim").classList.remove("open"); $("editor").classList.remove("open"); Ed.onClose && Ed.onClose(); Ed.onClose = null; },
    isOpen: () => $("editor").classList.contains("open"),
  };
  $("edClose").onclick = Ed.close; $("edScrim").onclick = Ed.close;

  // ================================================================== workloads
  async function loadNamespaces() {
    S.namespaces = await api("/api/namespaces");
    const sel = $("nsSelect"), keep = sel.value;
    sel.innerHTML = '<option value="">All namespaces</option>' + S.namespaces.map((n) => `<option>${esc(n)}</option>`).join("");
    sel.value = keep;
  }

  async function loadDeployments() {
    try {
      S.deployments = await api("/api/deployments?" + qs({ namespace: currentNs() }));
      $("clusterDot").className = "dot ok"; $("clusterText").textContent = "Connected to cluster";
      renderDeployments();
    } catch (e) {
      $("clusterDot").className = "dot fail"; $("clusterText").textContent = "Cluster unreachable";
      if (e.message !== "Sign in required") toast("Could not load deployments: " + e.message, "error");
    }
  }

  const STATUS_LABEL = { healthy: "Healthy", progressing: "Rolling out", degraded: "Degraded", failed: "Failed", "scaled-down": "Scaled to 0" };
  function renderDeployments() {
    const all = S.deployments;
    const items = all.filter((d) => matches(d, d.name, d.namespace, ...d.containers.map((c) => c.image)));
    const count = (s) => all.filter((d) => d.status === s).length;
    const parts = [`<b>${all.length}</b> deployments`, `<b>${count("healthy")}</b> healthy`];
    if (count("progressing")) parts.push(`<b>${count("progressing")}</b> rolling out`);
    if (count("degraded") + count("failed")) parts.push(`<b>${count("degraded") + count("failed")}</b> need attention`);
    if (count("scaled-down")) parts.push(`<b>${count("scaled-down")}</b> scaled to zero`);
    $("summary").innerHTML = parts.join(", ");

    if (!items.length) {
      $("rows").innerHTML = `<tr><td colspan="6" class="empty">${all.length ? "No deployments match this filter." : "No deployments in this namespace."}</td></tr>`;
      return;
    }
    $("rows").innerHTML = items.map((d, i) => {
      const pct = d.replicas ? Math.round((d.ready / d.replicas) * 100) : 0;
      const imgs = d.containers.map((c) => `<span class="img mono" title="${esc(c.image)}"><span class="cname">${esc(c.name)}:</span> ${esc(c.image)}<span class="policy">${esc(c.pull_policy || "")}</span></span>`).join("");
      const loaded = d.last_loaded.at ? `<div class="loaded">Loaded from tar ${esc(new Date(d.last_loaded.at).toLocaleString())}</div>` : "";
      const w = !d.protected;
      return `<tr>
        <td><div class="dname">${esc(d.name)}</div><div class="dns">${esc(d.namespace)}${d.revision ? ", revision " + esc(d.revision) : ""}</div></td>
        <td><span class="pill s-${d.status}">${STATUS_LABEL[d.status] || d.status}</span></td>
        <td class="reps">${d.ready} / ${d.replicas}<div class="bar"><i style="width:${pct}%"></i></div></td>
        <td>${imgs}${loaded}</td>
        <td>${age(d.age_seconds)}</td>
        <td><div class="actions">
          <button class="btn small" data-manage="${i}">Manage</button>
          ${w ? `<button class="btn small primary" data-update="${i}">Update image</button>` : ""}
        </div></td></tr>`;
    }).join("");
    $("rows").querySelectorAll("[data-update]").forEach((b) => b.onclick = () => openImageForm(items[+b.dataset.update]));
    $("rows").querySelectorAll("[data-manage]").forEach((b) => b.onclick = () => openManage(items[+b.dataset.manage].namespace, items[+b.dataset.manage].name));
  }

  // ================================================================== manage deployment
  const VOL_LABEL = { persistentVolumeClaim: "Claim", hostPath: "Node disk", emptyDir: "Temporary", configMap: "Config map", secret: "Secret", projected: "Projected", nfs: "NFS", csi: "CSI" };

  async function openManage(ns, name) {
    let d;
    try { d = await api(`/api/deployments/${ns}/${name}`); } catch (e) { return toast(e.message, "error"); }
    const w = !d.protected;
    const mountsOf = (vol) => d.containers.flatMap((c) => c.mounts.filter((m) => m.volume === vol).map((m) =>
      `<span class="mono">${esc(d.containers.length > 1 ? c.name + ":" : "")}${esc(m.path)}${m.sub_path ? ` (${esc(m.sub_path)})` : ""}</span>${m.read_only ? ' <span class="muted">read-only</span>' : ""}`)).join("<br>") || '<span class="muted">not mounted</span>';

    const html = `
      ${d.protected ? '<div class="notice">This namespace is protected or the dashboard is read-only. Details are shown, changes are disabled.</div>' : '<div class="notice info">Changes here replace pods one by one using the deployment\'s rollout strategy.</div>'}

      <div class="sec">
        <div class="sec-head"><h3>Replicas</h3><span class="muted">${d.ready} of ${d.replicas} ready</span></div>
        ${w ? `<div style="display:flex;gap:12px;align-items:center;flex-wrap:wrap">
          <div class="stepper"><button data-step="-1" aria-label="Fewer replicas">−</button><input id="mRep" type="number" min="0" max="500" value="${d.replicas}" aria-label="Replicas"><button data-step="1" aria-label="More replicas">+</button></div>
          <button class="btn" id="mScale">Scale</button></div>` : `<div>${d.replicas} replicas</div>`}
        ${d.hpa ? `<div class="notice">Autoscaler <span class="mono">${esc(d.hpa.name)}</span> manages replicas between ${d.hpa.min ?? 1} and ${d.hpa.max}. It will override manual scaling; change the autoscaler limits instead.</div>` : ""}
      </div>

      <div class="sec">
        <div class="sec-head"><h3>Containers</h3></div>
        ${d.containers.map((c) => `
          <div class="subform">
            <div class="sec-head"><strong>${esc(c.name)}</strong>${w ? `<button class="btn small" data-img="${esc(c.name)}">Update image</button>` : ""}</div>
            <div class="mono" style="word-break:break-all">${esc(c.image)}</div>
            <div><div class="muted" style="font-size:13px;margin-bottom:6px">Environment loaded from${c.env_count ? `, plus ${c.env_count} individual variables` : ""}</div>
              <div class="chips">${c.env_from.map((e) => `<span class="chip">${e.kind === "secret" ? "Secret" : "Config map"} ${esc(e.name)}${e.prefix ? ` (prefix ${esc(e.prefix)})` : ""}
                ${w ? `<button title="Stop loading" data-envdel="${esc(c.name)}|${e.kind}|${esc(e.name)}">×</button>` : ""}</span>`).join("") || '<span class="muted" style="font-size:13px">Nothing yet</span>'}</div></div>
            ${w ? `<div class="row3" data-envform="${esc(c.name)}">
              <select class="field" data-k="kind"><option value="configMap">Config map</option><option value="secret">Secret</option></select>
              <select class="field" data-k="name"><option value="">Loading…</option></select>
              <button class="btn" data-envadd="${esc(c.name)}">Load environment</button></div>` : ""}
          </div>`).join("")}
      </div>

      <div class="sec">
        <div class="sec-head"><h3>Storage</h3>${w ? '<button class="btn small" id="mAddVol">Add storage</button>' : ""}</div>
        ${d.pinned_node ? `<div class="notice info">Pods are pinned to node <strong>${esc(d.pinned_node)}</strong> so they keep their local disk.${w ? ' <button class="link" id="mUnpin">Unpin</button>' : ""}</div>` : ""}
        <div id="mVolForm"></div>
        ${d.volumes.length ? `<table class="mini"><tbody>${d.volumes.map((v) => `<tr>
            <td><strong>${esc(v.name)}</strong><div class="muted" style="font-size:13px">${VOL_LABEL[v.type] || esc(v.type)}: ${esc(v.source)}</div></td>
            <td>${mountsOf(v.name)}</td>
            <td style="text-align:right">${w ? `<button class="btn small danger" data-voldel="${esc(v.name)}">Remove</button>` : ""}</td></tr>`).join("")}</tbody></table>`
          : '<div class="muted">No volumes. Data written by the container is lost when the pod is replaced.</div>'}
      </div>

      <div class="sec">
        <div class="sec-head"><h3>Pods</h3></div>
        ${d.pods.length ? `<table class="mini"><tbody>${d.pods.map((p) => `<tr>
          <td class="mono" style="word-break:break-all">${esc(p.name)}</td><td>${esc(p.node || "unscheduled")}</td>
          <td><span class="pill s-${p.reason && p.reason !== "Completed" ? "degraded" : p.ready === p.containers ? "healthy" : "progressing"}">${esc(p.reason || p.phase)}</span></td>
          <td class="muted">${p.restarts} restarts, ${age(p.age_seconds)}</td></tr>`).join("")}</tbody></table>` : '<div class="muted">No pods.</div>'}
      </div>`;

    const body = Ed.open(`${name}`, `Deployment in ${ns}`, html);
    const reload = () => { openManage(ns, name); loadDeployments(); };

    if (!w) return;

    // replicas
    body.querySelectorAll("[data-step]").forEach((b) => b.onclick = () => {
      const i = $("mRep"); i.value = Math.max(0, Math.min(500, (+i.value || 0) + +b.dataset.step));
    });
    $("mScale").onclick = (e) => busy(e.target, "Scaling…", async () => {
      const n = +$("mRep").value;
      if (n === 0 && !confirm(`Scale ${name} to 0? All its pods stop.`)) return;
      try { await api(`/api/deployments/${ns}/${name}/replicas`, { method: "PUT", json: { replicas: n } }); toast(`Scaled ${name} to ${n}`); reload(); }
      catch (err) { toast(err.message, "error"); }
    });

    // images
    body.querySelectorAll("[data-img]").forEach((b) => b.onclick = () => {
      const dep = S.deployments.find((x) => x.namespace === ns && x.name === name);
      if (dep) { Ed.close(); openImageForm(dep, b.dataset.img); }
    });

    // env from
    const [cms, secs] = await Promise.all([
      api("/api/configmaps?" + qs({ namespace: ns })).catch(() => []),
      api("/api/secrets?" + qs({ namespace: ns })).catch(() => []),
    ]);
    body.querySelectorAll("[data-envform]").forEach((f) => {
      const kind = f.querySelector('[data-k="kind"]'), sel = f.querySelector('[data-k="name"]');
      const fill = () => {
        const list = kind.value === "secret" ? secs.filter((s) => !s.system) : cms.filter((c) => !c.system);
        sel.innerHTML = list.length ? list.map((x) => `<option>${esc(x.name)}</option>`).join("") : '<option value="">None in this namespace</option>';
      };
      kind.onchange = fill; fill();
    });
    body.querySelectorAll("[data-envadd]").forEach((b) => b.onclick = () => busy(b, "Saving…", async () => {
      const f = b.closest("[data-envform]");
      const kind = f.querySelector('[data-k="kind"]').value, src = f.querySelector('[data-k="name"]').value;
      if (!src) return toast("Create a config map or secret in this namespace first.", "error");
      try { await api(`/api/deployments/${ns}/${name}/env-from`, { method: "POST", json: { container: b.dataset.envadd, kind, name: src } }); toast(`${b.dataset.envadd} now loads ${src}`); reload(); }
      catch (err) { toast(err.message, "error"); }
    }));
    body.querySelectorAll("[data-envdel]").forEach((b) => b.onclick = async () => {
      const [container, kind, source] = b.dataset.envdel.split("|");
      if (!confirm(`Stop loading environment from ${source} in ${container}?`)) return;
      try { await api(`/api/deployments/${ns}/${name}/env-from?` + qs({ container, kind, source }), { method: "DELETE" }); reload(); }
      catch (err) { toast(err.message, "error"); }
    });

    // storage
    body.querySelectorAll("[data-voldel]").forEach((b) => b.onclick = async () => {
      if (!confirm(`Remove volume ${b.dataset.voldel} from ${name}? The data itself is not deleted.`)) return;
      try { await api(`/api/deployments/${ns}/${name}/volumes/${b.dataset.voldel}`, { method: "DELETE" }); toast("Volume removed"); reload(); }
      catch (err) { toast(err.message, "error"); }
    });
    if ($("mUnpin")) $("mUnpin").onclick = async () => {
      if (!confirm("Unpin pods from this node? Pods on other nodes will not see data stored on this node's disk.")) return;
      try { await api(`/api/deployments/${ns}/${name}/node-pin`, { method: "DELETE" }); reload(); } catch (err) { toast(err.message, "error"); }
    };
    $("mAddVol").onclick = () => renderVolumeForm(d, cms, secs, reload);
  }

  async function renderVolumeForm(d, cms, secs, reload) {
    const ns = d.namespace;
    const [pvcs, classes, nodes] = await Promise.all([
      api("/api/storage/pvcs?" + qs({ namespace: ns })).catch(() => []),
      api("/api/storage/classes").catch(() => []),
      getNodes().catch(() => []),
    ]);
    const box = $("mVolForm");
    box.innerHTML = `<div class="subform">
      <label class="lbl">Type of storage
        <select class="field" id="vType">
          <option value="persistentVolumeClaim">Persistent claim (PVC), survives pod restarts</option>
          <option value="hostPath">Directory on the node's local disk (hostPath)</option>
          <option value="emptyDir">Temporary space, deleted with the pod (emptyDir)</option>
          <option value="configMap">Config map as files</option>
          <option value="secret">Secret as files</option>
        </select></label>
      <div id="vFields" style="display:grid;gap:12px"></div>
      <div class="row3">
        <label class="lbl">Volume name <input class="field" id="vName" placeholder="data"></label>
        <label class="lbl">Container <select class="field" id="vCont">${d.containers.map((c) => `<option>${esc(c.name)}</option>`).join("")}</select></label>
        <label class="lbl">Mount path <input class="field mono" id="vPath" placeholder="/data"></label>
      </div>
      <div class="row2">
        <label class="lbl">Sub path <span class="hint">Optional folder inside the volume</span><input class="field mono" id="vSub"></label>
        <label class="lbl">Access<label class="check" style="margin-top:8px"><input type="checkbox" id="vRO"> Mount read-only</label></label>
      </div>
      <div style="display:flex;gap:10px;justify-content:flex-end"><button class="btn" id="vCancel">Cancel</button><button class="btn primary" id="vSave">Add storage</button></div>
    </div>`;

    const classOpts = `<option value="__default">Cluster default${classes.find((c) => c.default) ? ` (${esc(classes.find((c) => c.default).name)})` : ""}</option>` +
      classes.map((c) => `<option value="${esc(c.name)}">${esc(c.name)}${c.local ? " (local disks)" : ""}</option>`).join("");
    const nodeOpts = (none) => `<option value="">${none}</option>` + nodes.map((n) => `<option>${esc(n.node)}</option>`).join("");

    const fields = {
      persistentVolumeClaim: () => `
        <label class="lbl">Claim <select class="field" id="vClaim">
          ${pvcs.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}, ${esc(p.capacity || p.requested)} ${esc((p.access_modes || []).map((m) => ABBR[m]).join("/"))}, ${esc(p.status)}${p.used_by.length ? `, used by ${esc(p.used_by.join(", "))}` : ""}</option>`).join("")}
          <option value="__new">Create a new claim…</option></select></label>
        <div id="vNewClaim" class="row3" hidden>
          <label class="lbl">Size <input class="field" id="vcSize" value="10Gi"></label>
          <label class="lbl">Class <select class="field" id="vcClass">${classOpts}</select></label>
          <label class="lbl">Access <select class="field" id="vcMode"><option value="ReadWriteOnce">One node (RWO)</option><option value="ReadWriteMany">Many nodes (RWX)</option></select></label>
        </div>`,
      hostPath: () => `
        <div class="row2">
          <label class="lbl">Path on the node <input class="field mono" id="vHost" placeholder="/mnt/data/${esc(d.name)}"></label>
          <label class="lbl">If missing <select class="field" id="vHType"><option value="DirectoryOrCreate">Create directory</option><option value="Directory">Must exist</option><option value="FileOrCreate">Create file</option></select></label>
        </div>
        <label class="lbl">Pin pods to node <span class="hint">Recommended. Data on a node's disk is only visible on that node.</span>
          <select class="field" id="vPin">${nodeOpts("Don't pin")}</select></label>
        <div class="notice">Anyone who can deploy here can read the node's files through this path. Prefer a local persistent volume from the Storage tab for production data.</div>`,
      emptyDir: () => `
        <div class="row2">
          <label class="lbl">Backed by <select class="field" id="vMedium"><option value="">Node disk</option><option value="Memory">Memory (counts toward the memory limit)</option></select></label>
          <label class="lbl">Size limit <input class="field" id="vLimit" placeholder="e.g. 2Gi"></label>
        </div>`,
      configMap: () => `<label class="lbl">Config map <select class="field" id="vSrc">${cms.filter((c) => !c.system).map((c) => `<option>${esc(c.name)}</option>`).join("") || '<option value="">None in this namespace</option>'}</select>
        <span class="hint">Each key becomes a file. Edits reach running pods within about a minute (not with sub path).</span></label>`,
      secret: () => `<label class="lbl">Secret <select class="field" id="vSrc">${secs.filter((s) => !s.system).map((s) => `<option>${esc(s.name)}</option>`).join("") || '<option value="">None in this namespace</option>'}</select>
        <span class="hint">Each key becomes a file.</span></label>`,
    };

    const renderFields = () => {
      const t = $("vType").value;
      $("vFields").innerHTML = fields[t]();
      $("vRO").checked = t === "configMap" || t === "secret";
      if (!$("vName").dataset.touched) $("vName").value = { persistentVolumeClaim: "data", hostPath: "node-disk", emptyDir: "scratch", configMap: "config", secret: "secret-files" }[t];
      if (!$("vPath").dataset.touched) $("vPath").value = { persistentVolumeClaim: "/data", hostPath: "/data", emptyDir: "/tmp/scratch", configMap: "/etc/config", secret: "/etc/secrets" }[t];
      if (t === "persistentVolumeClaim") {
        const claim = $("vClaim");
        const sync = () => { $("vNewClaim").hidden = claim.value !== "__new"; };
        if (!pvcs.length) claim.value = "__new";
        claim.onchange = sync; sync();
      }
    };
    $("vType").onchange = renderFields;
    ["vName", "vPath"].forEach((id) => $(id).addEventListener("input", () => { $(id).dataset.touched = "1"; }));
    renderFields();
    $("vCancel").onclick = () => { box.innerHTML = ""; };
    box.scrollIntoView({ behavior: "smooth", block: "nearest" });

    $("vSave").onclick = (e) => busy(e.target, "Saving…", async () => {
      const t = $("vType").value;
      const volName = $("vName").value.trim();
      const body = {
        name: volName, type: t,
        mounts: [{ container: $("vCont").value, mount_path: $("vPath").value.trim(), sub_path: $("vSub").value.trim(), read_only: $("vRO").checked }],
      };
      try {
        if (t === "persistentVolumeClaim") {
          let claim = $("vClaim").value;
          if (claim === "__new") {
            claim = `${d.name}-${volName}`.slice(0, 63).replace(/-+$/, "");
            const cls = $("vcClass").value;
            await api(`/api/storage/pvcs/${ns}`, { method: "POST", json: {
              name: claim, size: $("vcSize").value.trim(), access_mode: $("vcMode").value,
              storage_class: cls === "__default" ? null : cls } });
            toast(`Created claim ${claim}`);
          }
          body.claim_name = claim;
        } else if (t === "hostPath") {
          Object.assign(body, { path: $("vHost").value.trim() || $("vHost").placeholder, host_path_type: $("vHType").value, pin_node: $("vPin").value });
        } else if (t === "emptyDir") {
          Object.assign(body, { medium: $("vMedium").value, size_limit: $("vLimit").value.trim() });
        } else {
          body.source_name = $("vSrc").value;
          if (!body.source_name) return toast(`Create a ${t === "secret" ? "secret" : "config map"} in ${ns} first.`, "error");
        }
        const res = await api(`/api/deployments/${ns}/${d.name}/volumes`, { method: "POST", json: body });
        toast(`Added ${volName} to ${d.name}`);
        (res.warnings || []).forEach((w) => toast(w, "error"));
        reload();
      } catch (err) { toast(err.message, "error"); }
    });
  }

  // ================================================================== key/value editor (config maps and secrets)
  function kvEditor(host, data, { secret = false, binaryKeys = [], readOnly = false } = {}) {
    const rows = Object.entries(data).map(([k, v]) => ({ key: k, value: v, revealed: !secret }));
    const binary = binaryKeys.map((k) => ({ key: k, keep: true }));
    const render = () => {
      host.innerHTML = `<div class="kv">
        ${rows.map((r, i) => `<div class="kv-row">
          <input class="field mono" data-i="${i}" data-f="key" value="${esc(r.key)}" placeholder="key" ${readOnly ? "disabled" : ""} aria-label="Key">
          ${r.revealed ? `<textarea class="field" data-i="${i}" data-f="value" rows="${Math.min(12, Math.max(1, (r.value.match(/\n/g) || []).length + 1))}" ${readOnly ? "disabled" : ""} aria-label="Value">${esc(r.value)}</textarea>`
            : `<div class="masked"><span>Hidden, ${r.value.length} characters</span><button class="link" data-reveal="${i}">Show</button></div>`}
          ${readOnly ? "<span></span>" : `<button class="icon" data-del="${i}" title="Remove key" aria-label="Remove key">×</button>`}
        </div>`).join("")}
        ${binary.map((b, i) => `<div class="kv-row"><input class="field mono" value="${esc(b.key)}" disabled>
          <div class="masked"><span>${b.keep ? "Binary value, kept as is" : "Will be removed"}</span></div>
          ${readOnly ? "<span></span>" : `<button class="icon" data-bin="${i}" title="${b.keep ? "Remove" : "Keep"}">${b.keep ? "×" : "↺"}</button>`}</div>`).join("")}
        ${!rows.length && !binary.length ? '<div class="muted">No keys yet.</div>' : ""}
        ${readOnly ? "" : `<div style="display:flex;gap:10px;flex-wrap:wrap">
          <button class="btn small" data-add>Add key</button>
          <button class="btn small" data-file>Add key from file</button>
          ${secret && rows.some((r) => !r.revealed) ? '<button class="btn small" data-revealall>Show all values</button>' : ""}
          <input type="file" data-fileinput hidden multiple></div>`}
      </div>`;
      host.querySelectorAll("[data-f]").forEach((el) => el.oninput = () => { rows[+el.dataset.i][el.dataset.f] = el.value; });
      host.querySelectorAll("[data-reveal]").forEach((b) => b.onclick = () => { rows[+b.dataset.reveal].revealed = true; render(); });
      host.querySelectorAll("[data-del]").forEach((b) => b.onclick = () => { rows.splice(+b.dataset.del, 1); render(); });
      host.querySelectorAll("[data-bin]").forEach((b) => b.onclick = () => { binary[+b.dataset.bin].keep = !binary[+b.dataset.bin].keep; render(); });
      const q = (s) => host.querySelector(s);
      if (q("[data-add]")) q("[data-add]").onclick = () => { rows.push({ key: "", value: "", revealed: true }); render(); host.querySelectorAll('[data-f="key"]')[rows.length - 1].focus(); };
      if (q("[data-revealall]")) q("[data-revealall]").onclick = () => { rows.forEach((r) => r.revealed = true); render(); };
      if (q("[data-file]")) {
        q("[data-file]").onclick = () => q("[data-fileinput]").click();
        q("[data-fileinput]").onchange = async (e) => {
          for (const f of e.target.files) {
            if (f.size > 1024 * 1024) { toast(`${f.name} is larger than 1 MiB. Use a volume for large files.`, "error"); continue; }
            const text = await f.text();
            if (text.includes("\uFFFD")) { toast(`${f.name} looks binary. Only text files can be added here.`, "error"); continue; }
            const existing = rows.find((r) => r.key === f.name);
            if (existing) { existing.value = text; existing.revealed = true; } else rows.push({ key: f.name, value: text, revealed: true });
          }
          render();
        };
      }
    };
    render();
    return {
      collect() {
        const data = {};
        for (const r of rows) {
          const k = r.key.trim();
          if (!k) { if (r.value) throw new Error("Every value needs a key."); continue; }
          if (!/^[-._a-zA-Z0-9]+$/.test(k)) throw new Error(`Key "${k}" may only use letters, digits, '-', '_' and '.'.`);
          if (k in data) throw new Error(`Key "${k}" appears twice.`);
          data[k] = r.value;
        }
        return { data, keep_binary: binary.filter((b) => b.keep).map((b) => b.key) };
      },
    };
  }

  function restartOption(usedBy) {
    if (!usedBy || !usedBy.length) return "";
    return `<label class="check"><input type="checkbox" id="edRestart" checked> Restart ${usedBy.length === 1 ? "the deployment" : `${usedBy.length} deployments`} that use it: ${usedBy.map(esc).join(", ")}</label>
      <span class="muted" style="font-size:13px;margin-top:-10px">Environment variables only change when pods restart. Mounted files update on their own, but apps usually read them once at start.</span>`;
  }

  // ================================================================== config maps
  async function loadConfigMaps() {
    try { S.configmaps = await api("/api/configmaps?" + qs({ namespace: currentNs() })); renderConfigMaps(); }
    catch (e) { toast("Could not load config maps: " + e.message, "error"); }
  }
  function renderConfigMaps() {
    const items = S.configmaps.filter((x) => ($("showSystem").checked || !x.system) && matches(x, x.name, x.namespace, ...x.keys));
    $("cmRows").innerHTML = items.length ? items.map((x, i) => `<tr>
      <td>${nsName(x)}</td>
      <td><div class="keys mono" title="${esc(x.keys.join(", "))}">${esc(x.keys.join(", ")) || '<span class="muted">empty</span>'}</div><div class="dns">${x.keys.length} keys${x.immutable ? ", immutable" : ""}</div></td>
      <td>${usedBy(x.used_by)}</td><td>${age(x.age_seconds)}</td>
      <td><div class="actions">
        <button class="btn small" data-cm="${i}">${x.protected || x.immutable || x.system ? "View" : "Edit"}</button>
        ${x.protected || x.system ? "" : `<button class="btn small danger" data-cmdel="${i}">Delete</button>`}
      </div></td></tr>`).join("")
      : `<tr><td colspan="5" class="empty">${S.configmaps.length ? "No config maps match this filter." : "No config maps here. Create one to hold settings or config files for your apps."}</td></tr>`;
    $("cmRows").querySelectorAll("[data-cm]").forEach((b) => b.onclick = () => openConfigMap(items[+b.dataset.cm]));
    $("cmRows").querySelectorAll("[data-cmdel]").forEach((b) => b.onclick = () => deleteObj("configmaps", items[+b.dataset.cmdel], "config map"));
  }

  async function openConfigMap(item) {
    const isNew = !item;
    let cm = { data: {}, binary_keys: [], used_by: [], namespace: currentNs() || "default" };
    if (!isNew) { try { cm = await api(`/api/configmaps/${item.namespace}/${item.name}`); } catch (e) { return toast(e.message, "error"); } }
    const ro = !isNew && (cm.protected || cm.immutable);
    const body = Ed.open(isNew ? "New config map" : cm.name, isNew ? "Settings and config files for your apps" : `Config map in ${cm.namespace}`, `
      ${ro ? `<div class="notice">${cm.immutable ? "This config map is immutable. Create a new one to change it." : "This namespace is protected. Values are shown read-only."}</div>` : ""}
      ${isNew ? `<div class="row2"><label class="lbl">Name <input class="field" id="edName" placeholder="app-settings"></label>
        <label class="lbl">Namespace <select class="field" id="edNs">${nsOptions(cm.namespace)}</select></label></div>` : ""}
      <div id="edKv"></div>
      ${ro ? "" : restartOption(cm.used_by)}`,
      ro ? [] : [{ label: isNew ? "Create config map" : "Save changes", cls: "primary", onClick: save }]);
    const kv = kvEditor(body.querySelector("#edKv"), cm.data, { binaryKeys: cm.binary_keys, readOnly: ro });

    async function save(btn) {
      let payload;
      try { payload = kv.collect(); } catch (e) { return toast(e.message, "error"); }
      await busy(btn, "Saving…", async () => {
        try {
          if (isNew) {
            const ns = $("edNs").value;
            await api(`/api/configmaps/${ns}`, { method: "POST", json: { name: $("edName").value.trim(), data: payload.data } });
            toast(`Created config map ${$("edName").value.trim()}`);
          } else {
            const r = await api(`/api/configmaps/${cm.namespace}/${cm.name}`, { method: "PUT", json: {
              data: payload.data, resource_version: cm.resource_version, restart: !!($("edRestart") && $("edRestart").checked) } });
            toast(r.changed.length ? `Saved ${cm.name}${r.restarted.length ? `, restarting ${r.restarted.join(", ")}` : ""}` : "No changes to save");
          }
          Ed.close(); loadConfigMaps();
        } catch (e) { toast(e.message, "error"); }
      });
    }
  }
  $("newConfigMap").onclick = () => openConfigMap(null);

  async function deleteObj(kind, item, label) {
    const path = `/api/${kind}/${item.namespace}/${item.name}`;
    const warn = item.used_by.length ? `\n\nIt is used by ${item.used_by.join(", ")}. New pods of those deployments will fail to start.` : "";
    if (!typedConfirm(item.name, `Delete ${label} ${item.namespace}/${item.name}?${warn}`)) return;
    try { await api(path + (item.used_by.length ? "?force=true" : ""), { method: "DELETE" }); toast(`Deleted ${item.name}`); refreshView(); }
    catch (e) { toast(e.message, "error"); }
  }

  // ================================================================== secrets
  const SECRET_TYPE = {
    Opaque: "Generic", "kubernetes.io/tls": "TLS certificate", "kubernetes.io/dockerconfigjson": "Registry login",
    "kubernetes.io/basic-auth": "Basic auth", "kubernetes.io/ssh-auth": "SSH key",
    "kubernetes.io/service-account-token": "Service account token", "helm.sh/release.v1": "Helm release",
    "bootstrap.kubernetes.io/token": "Bootstrap token",
  };
  async function loadSecrets() {
    try { S.secrets = await api("/api/secrets?" + qs({ namespace: currentNs() })); renderSecrets(); }
    catch (e) { toast("Could not load secrets: " + e.message, "error"); }
  }
  function renderSecrets() {
    const items = S.secrets.filter((x) => ($("showSystem").checked || !x.system) && matches(x, x.name, x.namespace, x.type, ...x.keys));
    $("secRows").innerHTML = items.length ? items.map((x, i) => `<tr>
      <td>${nsName(x)}</td><td>${esc(SECRET_TYPE[x.type] || x.type)}</td>
      <td><div class="keys mono">${esc(x.keys.join(", "))}</div></td>
      <td>${usedBy(x.used_by)}</td><td>${age(x.age_seconds)}</td>
      <td><div class="actions">
        ${x.system ? '<span class="muted" style="font-size:13px">Managed by the system</span>' :
          `<button class="btn small" data-sec="${i}">${x.protected || !x.editable ? "View" : "Edit"}</button>
           ${x.protected ? "" : `<button class="btn small danger" data-secdel="${i}">Delete</button>`}`}
      </div></td></tr>`).join("")
      : `<tr><td colspan="6" class="empty">${S.secrets.length ? "No secrets match this filter." : "No secrets here. Create one for passwords, API keys, certificates or registry logins."}</td></tr>`;
    $("secRows").querySelectorAll("[data-sec]").forEach((b) => b.onclick = () => openSecret(items[+b.dataset.sec]));
    $("secRows").querySelectorAll("[data-secdel]").forEach((b) => b.onclick = () => deleteObj("secrets", items[+b.dataset.secdel], "secret"));
  }

  async function openSecret(item) {
    if (!item) return newSecret();
    let s;
    try { s = await api(`/api/secrets/${item.namespace}/${item.name}`); } catch (e) { return toast(e.message, "error"); }
    const ro = s.protected || !s.editable;
    const body = Ed.open(s.name, `${SECRET_TYPE[s.type] || s.type} secret in ${s.namespace}`, `
      ${ro ? '<div class="notice">This secret is read-only here.</div>' : '<div class="notice info">Values are hidden until you choose Show. Viewing is recorded in the change log.</div>'}
      <div id="edKv"></div>
      ${ro ? "" : restartOption(s.used_by)}`,
      ro ? [] : [{ label: "Save changes", cls: "primary", onClick: save }]);
    const kv = kvEditor(body.querySelector("#edKv"), s.data, { secret: true, binaryKeys: s.binary_keys, readOnly: ro });

    async function save(btn) {
      let payload;
      try { payload = kv.collect(); } catch (e) { return toast(e.message, "error"); }
      await busy(btn, "Saving…", async () => {
        try {
          const r = await api(`/api/secrets/${s.namespace}/${s.name}`, { method: "PUT", json: {
            ...payload, resource_version: s.resource_version, restart: !!($("edRestart") && $("edRestart").checked) } });
          toast(r.changed.length ? `Saved ${s.name}${r.restarted.length ? `, restarting ${r.restarted.join(", ")}` : ""}` : "No changes to save");
          Ed.close(); loadSecrets();
        } catch (e) { toast(e.message, "error"); }
      });
    }
  }

  function newSecret() {
    const body = Ed.open("New secret", "Passwords, keys, certificates and registry logins", `
      <div class="row2">
        <label class="lbl">Name <input class="field" id="edName" placeholder="app-credentials"></label>
        <label class="lbl">Namespace <select class="field" id="edNs">${nsOptions(currentNs() || "default")}</select></label>
      </div>
      <label class="lbl">Type <select class="field" id="edType">
        <option value="Opaque">Generic (key and value pairs)</option>
        <option value="kubernetes.io/tls">TLS certificate</option>
        <option value="kubernetes.io/dockerconfigjson">Registry login (image pull secret)</option></select></label>
      <div id="edTypeBody" style="display:grid;gap:14px"></div>`,
      [{ label: "Create secret", cls: "primary", onClick: save }]);
    let kv = null;
    const renderType = () => {
      const t = $("edType").value, host = $("edTypeBody");
      kv = null;
      if (t === "Opaque") { host.innerHTML = '<div id="edKv"></div>'; kv = kvEditor(host.querySelector("#edKv"), { "": "" }, {}); }
      else if (t === "kubernetes.io/tls") {
        host.innerHTML = `
          <label class="lbl">Certificate (tls.crt) <span class="hint">PEM, including the chain if you have one</span><textarea class="field mono" id="tCrt" rows="6" placeholder="-----BEGIN CERTIFICATE-----"></textarea></label>
          <label class="lbl">Private key (tls.key)<textarea class="field mono" id="tKey" rows="6" placeholder="-----BEGIN PRIVATE KEY-----"></textarea></label>
          <div><button class="btn small" id="tLoad">Load from files</button><input type="file" id="tFiles" multiple hidden></div>`;
        $("tLoad").onclick = () => $("tFiles").click();
        $("tFiles").onchange = async (e) => {
          for (const f of e.target.files) {
            const text = await f.text();
            if (/PRIVATE KEY/.test(text)) $("tKey").value = text; else if (/CERTIFICATE/.test(text)) $("tCrt").value = text;
            else toast(`${f.name} is not a PEM certificate or key.`, "error");
          }
        };
      } else {
        host.innerHTML = `
          <label class="lbl">Registry server <input class="field mono" id="rServer" placeholder="registry.example.com"></label>
          <div class="row2"><label class="lbl">Username <input class="field" id="rUser" autocomplete="off"></label>
            <label class="lbl">Password or token <input class="field" id="rPass" type="password" autocomplete="new-password"></label></div>
          <label class="lbl">Email <span class="hint">Optional</span><input class="field" id="rEmail"></label>
          <div class="notice info">To use it, add it to the deployment's <span class="mono">imagePullSecrets</span>, or to the namespace's default service account.</div>`;
      }
    };
    $("edType").onchange = renderType; renderType();

    async function save(btn) {
      const t = $("edType").value;
      const json = { name: $("edName").value.trim(), type: t, data: {} };
      try {
        if (t === "Opaque") json.data = kv.collect().data;
        else if (t === "kubernetes.io/tls") json.data = { "tls.crt": $("tCrt").value.trim() + "\n", "tls.key": $("tKey").value.trim() + "\n" };
        else json.registry = { registry: $("rServer").value.trim(), username: $("rUser").value, password: $("rPass").value, email: $("rEmail").value.trim() };
        if (t === "kubernetes.io/tls" && (!$("tCrt").value.trim() || !$("tKey").value.trim())) throw new Error("Add both the certificate and the private key.");
        if (json.registry && (!json.registry.registry || !json.registry.username || !json.registry.password)) throw new Error("Enter the registry server, username and password.");
      } catch (e) { return toast(e.message, "error"); }
      await busy(btn, "Creating…", async () => {
        try { await api(`/api/secrets/${$("edNs").value}`, { method: "POST", json }); toast(`Created secret ${json.name}`); Ed.close(); loadSecrets(); }
        catch (e) { toast(e.message, "error"); }
      });
    }
    body.querySelector("#edName").focus();
  }
  $("newSecret").onclick = newSecret;

  // ================================================================== storage
  async function loadStorage() {
    try {
      [S.pvcs, S.pvs, S.classes] = await Promise.all([
        api("/api/storage/pvcs?" + qs({ namespace: currentNs() })), api("/api/storage/pvs"), api("/api/storage/classes")]);
      renderStorage();
    } catch (e) { toast("Could not load storage: " + e.message, "error"); }
  }
  const PVC_STATE = { Bound: "healthy", Pending: "progressing", Lost: "failed" };
  const PV_STATE = { Bound: "healthy", Available: "scaled-down", Released: "progressing", Failed: "failed", Pending: "progressing" };

  function renderStorage() {
    const pvcs = S.pvcs.filter((p) => matches(p, p.name, p.namespace, p.storage_class, p.volume));
    const localWaitNote = (p) => p.status === "Pending" && (S.classes.find((c) => c.name === p.storage_class) || {}).binding_mode === "WaitForFirstConsumer"
      ? '<div class="dns">Binds when a pod uses it</div>' : "";
    $("pvcRows").innerHTML = pvcs.length ? pvcs.map((p, i) => `<tr>
      <td>${nsName(p)}</td>
      <td><span class="pill s-${PVC_STATE[p.status] || "queued"}">${esc(p.status)}</span>${localWaitNote(p)}</td>
      <td>${esc(p.capacity || p.requested)}${p.capacity && p.requested && p.capacity !== p.requested ? `<div class="dns">resizing to ${esc(p.requested)}</div>` : ""}</td>
      <td>${esc(p.access_modes.map((m) => ABBR[m] || m).join(", "))}</td>
      <td>${esc(p.storage_class) || '<span class="muted">none</span>'}${p.volume ? `<div class="dns mono">${esc(p.volume)}</div>` : ""}</td>
      <td>${usedBy(p.used_by)}</td>
      <td><div class="actions">${p.protected ? "" : `
        ${p.expandable ? `<button class="btn small" data-resize="${i}">Resize</button>` : ""}
        <button class="btn small danger" data-pvcdel="${i}">Delete</button>`}</div></td></tr>`).join("")
      : `<tr><td colspan="7" class="empty">${S.pvcs.length ? "No claims match this filter." : "No storage claims here. Create one, then attach it to a deployment."}</td></tr>`;
    $("pvcRows").querySelectorAll("[data-resize]").forEach((b) => b.onclick = () => resizePvc(pvcs[+b.dataset.resize]));
    $("pvcRows").querySelectorAll("[data-pvcdel]").forEach((b) => b.onclick = () => deletePvc(pvcs[+b.dataset.pvcdel]));

    const pvs = S.pvs.filter((p) => matches(p, p.name, p.claim, p.storage_class, p.source.detail, p.source.node));
    const src = (s) => ({ local: "Local disk", hostPath: "Node directory", nfs: "NFS", csi: "CSI" }[s.type] || s.type) +
      `<div class="dns mono">${esc(s.detail)}${s.node ? ` on ${esc(s.node)}` : ""}</div>`;
    $("pvRows").innerHTML = pvs.length ? pvs.map((p, i) => `<tr>
      <td class="dname">${esc(p.name)}</td>
      <td><span class="pill s-${PV_STATE[p.status] || "queued"}">${esc(p.status)}</span></td>
      <td>${esc(p.capacity)}<div class="dns">${esc(p.access_modes.map((m) => ABBR[m] || m).join(", "))}, ${esc(p.reclaim_policy)}</div></td>
      <td>${src(p.source)}</td><td>${esc(p.storage_class) || '<span class="muted">none</span>'}</td>
      <td>${p.claim ? `<span class="mono">${esc(p.claim)}</span>` : '<span class="muted">none</span>'}</td>
      <td><div class="actions">${S.cfg.read_only ? "" : `
        ${p.status === "Released" ? `<button class="btn small" data-release="${i}">Make available</button>` : ""}
        <button class="btn small danger" data-pvdel="${i}">Delete</button>`}</div></td></tr>`).join("")
      : '<tr><td colspan="7" class="empty">No persistent volumes. With a dynamic storage class you may not need any; for local disks, add one per disk.</td></tr>';
    $("pvRows").querySelectorAll("[data-release]").forEach((b) => b.onclick = () => releasePv(pvs[+b.dataset.release]));
    $("pvRows").querySelectorAll("[data-pvdel]").forEach((b) => b.onclick = () => deletePv(pvs[+b.dataset.pvdel]));

    $("scRows").innerHTML = S.classes.length ? S.classes.map((c) => `<tr>
      <td class="dname">${esc(c.name)}${c.default ? ' <span class="pill s-healthy">Default</span>' : ""}</td>
      <td class="mono">${esc(c.provisioner)}</td><td>${c.binding_mode === "WaitForFirstConsumer" ? "When a pod uses it" : "Immediately"}</td>
      <td>${esc(c.reclaim_policy)}</td><td>${c.allow_expansion ? "Yes" : "No"}</td></tr>`).join("")
      : '<tr><td colspan="5" class="empty">No storage classes. Add a local disk class to use disks attached to your nodes.</td></tr>';
    $("newLocalClass").hidden = S.cfg.read_only || S.classes.some((c) => c.local);
  }

  function classOptions(selected) {
    const def = S.classes.find((c) => c.default);
    return `<option value="__default">Cluster default${def ? ` (${esc(def.name)})` : ", none set"}</option>` +
      S.classes.map((c) => `<option value="${esc(c.name)}" ${c.name === selected ? "selected" : ""}>${esc(c.name)}${c.local ? " (local disks)" : ""}</option>`).join("") +
      '<option value="">No class, bind to a specific volume</option>';
  }

  function newPvc() {
    Ed.open("New storage claim", "Request persistent storage for a namespace", `
      <div class="row2">
        <label class="lbl">Name <input class="field" id="pName" placeholder="app-data"></label>
        <label class="lbl">Namespace <select class="field" id="pNs">${nsOptions(currentNs() || "default")}</select></label>
      </div>
      <div class="row2">
        <label class="lbl">Size <input class="field" id="pSize" value="10Gi"><span class="hint">Mi, Gi or Ti, e.g. 500Mi, 20Gi</span></label>
        <label class="lbl">Access <select class="field" id="pMode">
          <option value="ReadWriteOnce">Read-write on one node (RWO)</option>
          <option value="ReadWriteMany">Read-write on many nodes (RWX)</option>
          <option value="ReadOnlyMany">Read-only on many nodes (ROX)</option>
          <option value="ReadWriteOncePod">Read-write by one pod (RWOP)</option></select></label>
      </div>
      <label class="lbl">Storage class <select class="field" id="pClass">${classOptions()}</select></label>
      <label class="lbl" id="pVolWrap" hidden>Volume <select class="field" id="pVol"></select>
        <span class="hint">Only available volumes that are large enough and match the class are listed.</span></label>
      <div class="notice info" id="pHint" hidden></div>`,
      [{ label: "Create claim", cls: "primary", onClick: save }]);

    const sync = () => {
      const cls = $("pClass").value, sc = S.classes.find((c) => c.name === cls);
      const pickVolume = cls === "" || (sc && sc.local);
      $("pVolWrap").hidden = !pickVolume;
      if (pickVolume) {
        const want = cls === "__default" ? null : cls;
        const avail = S.pvs.filter((p) => p.status === "Available" && (want === null || p.storage_class === want));
        $("pVol").innerHTML = (sc && sc.local ? '<option value="">Any matching volume (chosen when a pod starts)</option>' : "") +
          avail.map((p) => `<option value="${esc(p.name)}">${esc(p.name)}, ${esc(p.capacity)}, ${esc(p.source.detail)}${p.source.node ? " on " + esc(p.source.node) : ""}</option>`).join("");
        if (!avail.length && cls === "") $("pVol").innerHTML = '<option value="">No available volumes. Create one first.</option>';
      }
      $("pHint").hidden = !(sc && sc.local);
      $("pHint").textContent = "Local disk claims stay Pending until a pod uses them. Kubernetes then picks a volume on the node where the pod runs.";
    };
    $("pClass").onchange = sync; sync();

    async function save(btn) {
      const cls = $("pClass").value;
      const json = { name: $("pName").value.trim(), size: $("pSize").value.trim(), access_mode: $("pMode").value,
        storage_class: cls === "__default" ? null : cls, volume_name: $("pVolWrap").hidden ? "" : $("pVol").value };
      if (cls === "" && !json.volume_name) return toast("Choose a volume, or pick a storage class.", "error");
      await busy(btn, "Creating…", async () => {
        try { await api(`/api/storage/pvcs/${$("pNs").value}`, { method: "POST", json }); toast(`Created claim ${json.name}`); Ed.close(); loadStorage(); }
        catch (e) { toast(e.message, "error"); }
      });
    }
  }
  $("newPvc").onclick = newPvc;

  async function newPv() {
    const nodes = await getNodes().catch(() => []);
    const localClass = S.classes.find((c) => c.local);
    Ed.open("New persistent volume", "Register a disk or share that claims can use", `
      <label class="lbl">Where the data lives <select class="field" id="vType">
        <option value="local">Local disk on a node (recommended for node disks)</option>
        <option value="hostPath">Directory on a node (hostPath, single-node or test clusters)</option>
        <option value="nfs">NFS share</option></select></label>
      <div class="row2">
        <label class="lbl">Name <input class="field" id="vName" placeholder="node1-ssd1"></label>
        <label class="lbl">Capacity <input class="field" id="vCap" value="100Gi"></label>
      </div>
      <div class="row2" id="vNodeRow">
        <label class="lbl">Node <select class="field" id="vNode"><option value="">Choose a node</option>${nodes.map((n) => `<option>${esc(n.node)}</option>`).join("")}</select></label>
        <label class="lbl">Path <input class="field mono" id="vPath" placeholder="/mnt/disks/ssd1"></label>
      </div>
      <label class="check" id="vDirRow"><input type="checkbox" id="vDir" checked> Create the directory on the node if it is missing</label>
      <label class="lbl" id="vNfsRow" hidden>NFS server <input class="field mono" id="vNfs" placeholder="10.0.0.20"></label>
      <div class="row2">
        <label class="lbl">Storage class <select class="field" id="vClass">
          ${S.classes.map((c) => `<option value="${esc(c.name)}" ${localClass && c.name === localClass.name ? "selected" : ""}>${esc(c.name)}</option>`).join("")}
          <option value="" ${localClass ? "" : "selected"}>No class</option></select></label>
        <label class="lbl">Access <select class="field" id="vMode"><option value="ReadWriteOnce">One node (RWO)</option><option value="ReadWriteMany">Many nodes (RWX)</option><option value="ReadOnlyMany">Read-only, many (ROX)</option></select></label>
      </div>
      <label class="lbl">When its claim is deleted <select class="field" id="vReclaim"><option value="Retain">Keep the data (Retain)</option><option value="Delete">Delete the volume (Delete)</option></select></label>
      <div class="notice info" id="vHint"></div>`,
      [{ label: "Create volume", cls: "primary", onClick: save }]);

    const hints = {
      local: `Use a disk mounted on the node, for example /mnt/disks/ssd1. The node agent can create folders under /mnt/disks or /var/lib/k8s-volumes. Pods using this volume are scheduled onto that node automatically.${localClass ? "" : " Tip: add a local disk class first so claims bind at the right moment."}`,
      hostPath: "The directory is created if missing. Pinning to a node is optional but strongly recommended.",
      nfs: "Every node needs NFS client tools installed (nfs-common or nfs-utils). Use Many nodes (RWX) to share it across replicas.",
    };
    const sync = () => {
      const t = $("vType").value;
      $("vNodeRow").querySelector("label").hidden = t === "nfs";
      $("vNfsRow").hidden = t !== "nfs";
      $("vDirRow").hidden = t !== "local";
      $("vHint").textContent = hints[t];
      $("vPath").placeholder = t === "nfs" ? "/exports/data" : t === "hostPath" ? "/var/lib/app-data" : "/mnt/disks/ssd1";
    };
    $("vType").onchange = sync; sync();

    async function save(btn) {
      const json = { name: $("vName").value.trim(), type: $("vType").value, capacity: $("vCap").value.trim(), path: $("vPath").value.trim(),
        node: $("vType").value === "nfs" ? "" : $("vNode").value, nfs_server: $("vNfs").value.trim(),
        storage_class: $("vClass").value, access_mode: $("vMode").value, reclaim_policy: $("vReclaim").value,
        create_dir: $("vType").value === "local" && $("vDir").checked };
      await busy(btn, "Creating…", async () => {
        try { const r = await api("/api/storage/pvs", { method: "POST", json });
          toast(`Created volume ${json.name}${r.created_dir ? `, and ${json.path} on ${json.node}` : ""}`); Ed.close(); loadStorage(); }
        catch (e) { toast(e.message, "error"); }
      });
    }
  }
  $("newPv").onclick = newPv;

  $("newLocalClass").onclick = () => {
    Ed.open("Add local disk class", "For disks attached directly to nodes", `
      <p style="margin:0">This creates a storage class with no provisioner and delayed binding. You register each disk as a persistent volume, and Kubernetes binds a claim to a disk on the node where its pod is scheduled.</p>
      <label class="lbl">Name <input class="field" id="lcName" value="local-storage"></label>
      <label class="check"><input type="checkbox" id="lcDefault"> Make it the cluster default</label>`,
      [{ label: "Add class", cls: "primary", onClick: (btn) => busy(btn, "Adding…", async () => {
        try { await api("/api/storage/classes/local", { method: "POST", json: { name: $("lcName").value.trim(), make_default: $("lcDefault").checked } });
          toast("Added local disk class"); Ed.close(); loadStorage(); }
        catch (e) { toast(e.message, "error"); }
      }) }]);
  };

  function resizePvc(p) {
    Ed.open(`Resize ${p.name}`, `Claim in ${p.namespace}`, `
      <div class="current">Current size <strong>${esc(p.capacity || p.requested)}</strong>, class ${esc(p.storage_class)}</div>
      <label class="lbl">New size <input class="field" id="rsSize" value="${esc(p.requested)}"><span class="hint">Volumes can only grow. Some drivers finish resizing when the pod restarts.</span></label>`,
      [{ label: "Resize", cls: "primary", onClick: (btn) => busy(btn, "Resizing…", async () => {
        try { await api(`/api/storage/pvcs/${p.namespace}/${p.name}/size`, { method: "PUT", json: { size: $("rsSize").value.trim() } }); toast(`Resizing ${p.name}`); Ed.close(); loadStorage(); }
        catch (e) { toast(e.message, "error"); }
      }) }]);
  }
  async function deletePvc(p) {
    const warn = p.used_by.length ? `It is mounted by ${p.used_by.join(", ")}.` : "";
    if (!typedConfirm(p.name, `Delete claim ${p.namespace}/${p.name}? ${warn}\nWith reclaim policy Delete, the data is destroyed.`)) return;
    try { await api(`/api/storage/pvcs/${p.namespace}/${p.name}${p.used_by.length ? "?force=true" : ""}`, { method: "DELETE" }); toast(`Deleted claim ${p.name}`); loadStorage(); }
    catch (e) { toast(e.message, "error"); }
  }
  async function releasePv(p) {
    if (!confirm(`Make ${p.name} available for new claims? Its existing data is kept and will be visible to the next claim.`)) return;
    try { await api(`/api/storage/pvs/${p.name}/release`, { method: "POST" }); toast(`${p.name} is available`); loadStorage(); }
    catch (e) { toast(e.message, "error"); }
  }
  async function deletePv(p) {
    if (!typedConfirm(p.name, `Delete volume ${p.name}?${p.claim ? `\nIt is bound to ${p.claim}.` : ""}\nFor local and NFS volumes the files on disk are not removed.`)) return;
    try { await api(`/api/storage/pvs/${p.name}${p.status === "Bound" ? "?force=true" : ""}`, { method: "DELETE" }); toast(`Deleted volume ${p.name}`); loadStorage(); }
    catch (e) { toast(e.message, "error"); }
  }

  // ================================================================== images (local registry)
  const regOn = () => !!(S.cfg.registry && S.cfg.registry.enabled);
  const fmtBytes = (n) => n == null ? "" : n < 1048576 ? `${(n / 1024).toFixed(0)} KiB` : n < 1073741824 ? `${(n / 1048576).toFixed(1)} MiB` : `${(n / 1073741824).toFixed(2)} GiB`;
  const fmtDate = (iso) => iso ? new Date(iso).toLocaleString() : "";
  S.repos = []; S.openRepos = new Set(); S.tagCache = {};

  async function getRepos(force = false) {
    if (!regOn()) return [];
    if (force || !S.reposAt || Date.now() - S.reposAt > 15000) {
      S.repos = (await api("/api/registry")).repositories; S.reposAt = Date.now();
    }
    return S.repos;
  }
  async function getTags(repo, force = false) {
    if (force || !S.tagCache[repo]) S.tagCache[repo] = (await api("/api/registry/tags?" + qs({ repo }))).tags;
    return S.tagCache[repo];
  }

  async function loadImages() {
    const on = regOn(), w = on && !S.cfg.read_only;
    $("regOff").hidden = on; $("pushTar").hidden = !w; $("setupNodes").hidden = !w;
    if (!on) {
      $("regInfo").textContent = ""; $("regNodes").hidden = true;
      $("imgRows").innerHTML = '<tr><td colspan="4" class="empty">No local registry is configured.</td></tr>';
      return;
    }
    try {
      await getRepos(true);
      $("regInfo").innerHTML = `Nodes pull these images from <span class="mono">${esc(S.cfg.registry.host)}</span>.`;
      await Promise.all([...S.openRepos].map((r) => getTags(r, true).catch(() => null)));
      renderImages(); checkNodeTrust();
    } catch (e) {
      $("imgRows").innerHTML = `<tr><td colspan="4" class="empty">${esc(e.message)}</td></tr>`;
    }
  }

  async function checkNodeTrust() {
    try {
      const nodes = await getNodes();
      const pending = nodes.filter((n) => n.agent && n.agent.ready && n.agent.registry && n.agent.registry.state !== "ok");
      $("regNodes").hidden = !pending.length;
      $("regNodes").innerHTML = pending.length ? `${pending.length === nodes.length ? "No node" : `${pending.length} of ${nodes.length} nodes`} ${pending.length === 1 ? "is" : "are"} set up to pull from the registry yet (${pending.map((n) => esc(n.node)).join(", ")}). Choose <strong>Set up nodes</strong>, or pods using registry images cannot start there.` : "";
    } catch (e) { /* nodes panel reports its own errors */ }
  }

  function renderImages() {
    if (!regOn()) return;
    const items = S.repos.filter((r) => matches(r, r.name, ...r.tags));
    if (!items.length) {
      $("imgRows").innerHTML = `<tr><td colspan="4" class="empty">${S.repos.length ? "No images match this filter." : "The registry is empty. Choose Push image tar to add your first image."}</td></tr>`;
      return;
    }
    $("imgRows").innerHTML = items.map((r) => {
      const open = S.openRepos.has(r.name);
      const shown = r.tags.slice(-6).reverse();
      const row = `<tr>
        <td><div class="dname mono">${esc(r.name)}</div></td>
        <td><div class="chips">${shown.map((t) => `<span class="chip">${esc(t)}</span>`).join("")}${r.tags.length > shown.length ? `<span class="muted" style="font-size:13px">and ${r.tags.length - shown.length} more</span>` : ""}</div></td>
        <td>${usedBy(r.used_by)}</td>
        <td><div class="actions"><button class="btn small" data-repo="${esc(r.name)}" aria-expanded="${open}">${open ? "Hide tags" : "Show tags"}</button></div></td></tr>`;
      return row + (open ? `<tr class="subrow"><td colspan="4">${renderTagTable(r.name)}</td></tr>` : "");
    }).join("");
    $("imgRows").querySelectorAll("[data-repo]").forEach((b) => b.onclick = async () => {
      const repo = b.dataset.repo;
      if (S.openRepos.has(repo)) { S.openRepos.delete(repo); return renderImages(); }
      S.openRepos.add(repo); renderImages();
      try { await getTags(repo, true); } catch (e) { toast(e.message, "error"); }
      renderImages();
    });
    $("imgRows").querySelectorAll("[data-use]").forEach((b) => b.onclick = () => useImage(b.dataset.use));
    $("imgRows").querySelectorAll("[data-copy]").forEach((b) => b.onclick = () => {
      navigator.clipboard?.writeText(b.dataset.copy).then(() => toast("Copied " + b.dataset.copy), () => toast(b.dataset.copy));
    });
    $("imgRows").querySelectorAll("[data-del]").forEach((b) => b.onclick = () => deleteTag(b.dataset.del, b.dataset.tag));
  }

  function renderTagTable(repo) {
    const tags = S.tagCache[repo];
    if (!tags) return '<div class="muted" style="padding:10px 0">Loading tags…</div>';
    const w = !S.cfg.read_only;
    return `<table class="inner"><thead><tr><th>Tag</th><th>Built</th><th>Size</th><th>Platform</th><th>Used by</th><th></th></tr></thead><tbody>
      ${tags.map((t) => `<tr>
        <td class="mono">${esc(t.tag)}${t.error ? `<div class="loaded" style="color:var(--fail)">${esc(t.error)}</div>` : ""}</td>
        <td>${esc(fmtDate(t.created))}</td><td>${esc(fmtBytes(t.size))}</td>
        <td class="mono" style="font-size:12px">${esc((t.platforms || []).join(", "))}</td>
        <td>${usedBy(t.used_by)}</td>
        <td><div class="actions">
          <button class="btn small" data-copy="${esc(t.image)}">Copy name</button>
          ${w ? `<button class="btn small danger" data-del="${esc(repo)}" data-tag="${esc(t.tag)}">Delete</button>
          <button class="btn small primary" data-use="${esc(t.image)}">Deploy</button>` : ""}
        </div></td></tr>`).join("")}
    </tbody></table>`;
  }

  async function deleteTag(repo, tag) {
    const image = `${S.cfg.registry.host}/${repo}:${tag}`;
    const t = (S.tagCache[repo] || []).find((x) => x.tag === tag) || { used_by: [] };
    const warn = t.used_by.length ? `\n\nIt is used by ${t.used_by.join(", ")}. Pods started on new nodes will fail to pull it.` : "";
    if (!typedConfirm(tag, `Delete ${image} from the registry?\nOther tags pointing at the same build are removed too.${warn}`)) return;
    try {
      await api("/api/registry/tags?" + qs({ repo, tag, force: t.used_by.length ? "true" : "false" }), { method: "DELETE" });
      toast(`Deleted ${image}`); delete S.tagCache[repo]; loadImages();
    } catch (e) { toast(e.message, "error"); }
  }

  // Deploy a registry image into a deployment (Images tab)
  async function useImage(image) {
    const nsList = S.namespaces.filter(canWrite);
    const body = Ed.open("Deploy image", image, `
      <label class="lbl">Namespace <select class="field" id="uNs">${nsList.map((n) => `<option ${n === currentNs() ? "selected" : ""}>${esc(n)}</option>`).join("")}</select></label>
      <label class="lbl">Deployment <select class="field" id="uDep"></select></label>
      <label class="lbl">Container <select class="field" id="uCt"></select></label>
      <div class="current" id="uCur"></div>
      <label class="lbl">Pull policy <select class="field" id="uPolicy">
        <option value="IfNotPresent">IfNotPresent (recommended for unique tags)</option>
        <option value="Always">Always (for tags you overwrite, like latest)</option></select></label>`,
      [{ label: "Deploy image", cls: "primary", id: "uGo", onClick: go }]);
    let deps = [];
    const fillCt = () => {
      const d = deps.find((x) => x.name === $("uDep").value);
      $("uCt").innerHTML = d ? d.containers.map((ct) => `<option>${esc(ct.name)}</option>`).join("") : "";
      showCur();
    };
    const showCur = () => {
      const d = deps.find((x) => x.name === $("uDep").value), ct = d && d.containers.find((x) => x.name === $("uCt").value);
      $("uCur").innerHTML = ct ? `Currently running <span class="mono">${esc(ct.image)}</span>` : "No deployments in this namespace.";
      $("uGo").disabled = !ct;
    };
    const fillDeps = async () => {
      try { deps = await api("/api/deployments?" + qs({ namespace: $("uNs").value })); } catch (e) { deps = []; toast(e.message, "error"); }
      $("uDep").innerHTML = deps.map((d) => `<option>${esc(d.name)}</option>`).join("");
      fillCt();
    };
    body.querySelector("#uNs").onchange = fillDeps;
    body.querySelector("#uDep").onchange = fillCt;
    body.querySelector("#uCt").onchange = showCur;
    await fillDeps();

    async function go(btn) {
      await busy(btn, "Starting…", async () => {
        try {
          const r = await api(`/api/deployments/${encodeURIComponent($("uNs").value)}/${encodeURIComponent($("uDep").value)}/image-ref`,
            { method: "POST", json: { container: $("uCt").value, image, pull_policy: $("uPolicy").value } });
          Ed.close(); openJob(r.job_id);
        } catch (e) { toast(e.message, "error"); }
      });
    }
  }

  // Upload with progress (fetch cannot report upload progress)
  function uploadForm(url, fd, onProgress) {
    return new Promise((resolve, reject) => {
      const xhr = new XMLHttpRequest();
      xhr.open("POST", url);
      if (S.token) xhr.setRequestHeader("Authorization", "Bearer " + S.token);
      xhr.upload.onprogress = (e) => { if (e.lengthComputable) onProgress(e.loaded / e.total * 100); };
      xhr.onload = () => {
        let data = {}; try { data = JSON.parse(xhr.responseText); } catch (_) {}
        if (xhr.status === 200) resolve(data);
        else if (xhr.status === 401) { showLogin(); reject(new Error("Sign in required")); }
        else reject(new Error(data.detail || `Upload failed (HTTP ${xhr.status})`));
      };
      xhr.onerror = () => reject(new Error("Upload failed: network error"));
      xhr.send(fd);
    });
  }

  function pushTar() {
    let file = null;
    const body = Ed.open("Push image tar", `Store images in ${S.cfg.registry.host}`, `
      <div><div class="drop" id="pDrop" tabindex="0" role="button" aria-label="Choose image archive">
        <strong>Drop an image archive here, or click to choose</strong>
        <span>From docker save, podman save or ctr export. An archive with several images pushes all of them.</span></div>
        <input type="file" id="pFile" accept=".tar,.gz,.tgz,application/x-tar,application/gzip" hidden></div>
      <label class="lbl">Image name
        <input class="field mono" id="pName" placeholder="Leave empty to keep the names inside the archive">
        <span class="hint">Only for single-image archives, for example team/billing:2.3.0. The registry address is added for you.</span></label>
      <label class="check"><input type="checkbox" id="pUnique"> Add a unique timestamp tag</label>
      <div class="upload-progress" id="pProg" hidden><span id="pText">Uploading…</span><div class="track"><i id="pBar" style="width:0"></i></div></div>`,
      [{ label: "Push to registry", cls: "primary", id: "pGo", onClick: go }]);
    const drop = body.querySelector("#pDrop"), input = body.querySelector("#pFile");
    $("pGo").disabled = true;
    const pick = (f) => {
      if (!f) return; file = f; drop.className = "drop has";
      drop.innerHTML = `<strong class="mono">${esc(f.name)}</strong><span>${fmtBytes(f.size)}. Click to choose a different file.</span>`;
      $("pGo").disabled = false;
    };
    drop.onclick = () => input.click();
    drop.onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); input.click(); } };
    input.onchange = (e) => pick(e.target.files[0]);
    ["dragenter", "dragover"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.add("over"); }));
    ["dragleave", "drop"].forEach((ev) => drop.addEventListener(ev, (e) => { e.preventDefault(); drop.classList.remove("over"); }));
    drop.addEventListener("drop", (e) => pick(e.dataTransfer.files[0]));

    async function go(btn) {
      const fd = new FormData();
      fd.append("file", file); fd.append("target_image", $("pName").value.trim()); fd.append("unique_tag", $("pUnique").checked ? "true" : "false");
      $("pProg").hidden = false;
      await busy(btn, "Uploading…", async () => {
        try {
          const r = await uploadForm("/api/registry/push", fd, (p) => {
            $("pBar").style.width = p + "%";
            $("pText").textContent = p < 100 ? `Uploading, ${p.toFixed(0)}%` : "Upload complete, starting push…";
          });
          Ed.close(); openJob(r.job_id);
        } catch (e) { toast(e.message, "error"); $("pProg").hidden = true; }
      });
    }
  }
  $("pushTar").onclick = pushTar;

  $("setupNodes").onclick = async () => {
    if (!confirm(`Set up every node to pull from ${S.cfg.registry.host} over plain HTTP?\n\nThe node agents write the registry settings for containerd or CRI-O on each node.`)) return;
    const btn = $("setupNodes");
    await busy(btn, "Setting up…", async () => {
      try {
        const r = await api("/api/registry/configure-nodes", { method: "POST" });
        const label = { ok: "Ready", "action-needed": "One step left", manual: "Manual step", failed: "Failed" };
        const cls = { ok: "healthy", "action-needed": "progressing", manual: "progressing", failed: "failed" };
        Ed.open("Node setup", `Registry ${r.host}`, `<ul class="list">${r.nodes.map((n) => `<li style="align-items:flex-start"><div class="grow">
            <div><strong>${esc(n.node)}</strong> <span class="muted">${esc(n.runtime || "")}</span></div>
            ${n.message ? `<div class="node-msg">${esc(n.message)}</div>` : ""}</div>
            <span class="pill s-${cls[n.state] || "failed"}">${label[n.state] || n.state}</span></li>`).join("")}</ul>`);
        S.nodesAt = 0; checkNodeTrust();
      } catch (e) { toast(e.message, "error"); }
    });
  };

  // ================================================================== nodes, jobs, audit
  async function loadNodes() {
    try {
      const nodes = await getNodes(true);
      const withAgent = nodes.filter((n) => n.agent && n.agent.ready && !n.agent.error).length;
      $("nodeSummary").textContent = `${withAgent} of ${nodes.length} nodes can receive images`;
      $("nodes").innerHTML = nodes.map((n) => {
        const a = n.agent; let dot = "fail", text = "No agent running";
        if (a && a.error) text = "Agent unreachable";
        else if (a && a.ready) { dot = a.busy ? "warn" : "ok"; text = (a.busy ? "Importing, " : "Ready, ") + (a.runtime || "runtime unknown"); }
        else if (a) { dot = "warn"; text = "Agent starting"; }
        if (!n.node_ready) { dot = "fail"; text = "Node not ready"; }
        const reg = a && a.registry && a.registry.host ? a.registry.state : null;
        if (reg && reg !== "unset") text += reg === "ok" ? ", pulls from the local registry" : ", registry not set up";
        return `<li><span class="dot ${dot}"></span><div class="grow"><div>${esc(n.node)}${n.schedulable ? "" : " (cordoned)"}</div><div class="sub">${esc(text)}, ${esc(n.runtime || "")}</div></div></li>`;
      }).join("") || '<li class="sub">No nodes found.</li>';
    } catch (e) { toast("Could not load nodes: " + e.message, "error"); }
  }
  async function loadJobs() {
    try {
      const jobs = await api("/api/jobs");
      if (!jobs.length) return;
      const label = { running: "Running", succeeded: "Done", failed: "Failed" };
      $("jobs").innerHTML = jobs.slice(0, 8).map((j) => `<li><button class="linklike" data-job="${j.id}">
        <div style="display:flex;gap:12px;align-items:center"><div class="grow"><div>${j.deployment ? `${esc(j.namespace)}/${esc(j.deployment)}` : `Push ${esc(j.filename || "")}`}</div>
        <div class="sub mono">${esc(j.target_image || "preparing…")}</div></div>
        <span class="pill s-${j.state}">${label[j.state]}</span></div></button></li>`).join("");
      $("jobs").querySelectorAll("[data-job]").forEach((b) => b.onclick = () => openJob(b.dataset.job));
    } catch (e) {}
  }
  const AUDIT_LABEL = { create: "Created", edit: "Edited", delete: "Deleted", view: "Viewed", scale: "Scaled", restart: "Restarted",
    image: "Image updated", rollback: "Rolled back", "volume-add": "Storage added", "volume-remove": "Storage removed",
    "env-add": "Environment added", "env-remove": "Environment removed", resize: "Resized", release: "Released", unpin: "Unpinned",
    push: "Pushed to registry", "registry-nodes": "Registry set up on nodes" };
  async function loadAudit() {
    try {
      const rows = await api("/api/audit");
      $("audit").innerHTML = rows.length ? rows.slice(0, 100).map((r) => `<li><div class="grow">
        <div><strong>${esc(AUDIT_LABEL[r.action] || r.action)}</strong> <span class="mono">${esc(r.target)}</span></div>
        <div class="sub">${esc(r.detail)}</div></div><span class="muted" style="font-size:13px">${esc(new Date(r.ts).toLocaleString())}</span></li>`).join("")
        : '<li class="sub">No changes yet.</li>';
    } catch (e) {}
  }

  // ================================================================== image update sheet
  let chosenFile = null, current = null, currentJob = null, jobTimer = null;
  function openSheet() { $("scrim").classList.add("open"); $("sheet").classList.add("open"); }
  function closeSheet() { $("scrim").classList.remove("open"); $("sheet").classList.remove("open"); clearInterval(jobTimer); jobTimer = null; current = null; }
  $("sheetClose").onclick = closeSheet; $("scrim").onclick = closeSheet; $("cancelBtn").onclick = closeSheet;
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    if (Ed.isOpen()) Ed.close(); else if ($("sheet").classList.contains("open")) closeSheet();
  });

  function openImageForm(d, container) {
    current = d; chosenFile = null; $("fFile").value = "";
    $("sheetTitle").textContent = "Update image"; $("sheetSub").textContent = `${d.namespace}/${d.name}`;
    $("fContainer").innerHTML = d.containers.map((c) => `<option ${c.name === container ? "selected" : ""}>${esc(c.name)}</option>`).join("");
    $("fTarget").value = ""; $("fUnique").checked = true;
    const on = regOn();
    document.querySelector('#fSource input[value="registry"]').disabled = !on;
    document.querySelector(`#fSource input[value="${on ? "registry" : "upload"}"]`).checked = true;
    $("fDest").querySelector('option[value="registry"]').disabled = !on;
    $("fDest").value = on ? "registry" : "nodes";
    showCurrent(); resetDrop();
    $("formView").hidden = false; $("jobView").hidden = true; $("upProg").hidden = true;
    $("submitBtn").hidden = false; $("cancelBtn").textContent = "Cancel"; $("rollbackBtn").hidden = true;
    syncSource(); openSheet();
    if (on) fillRepos();
  }
  const srcValue = () => document.querySelector('#fSource input:checked').value;
  const currentContainer = () => current && current.containers.find((c) => c.name === $("fContainer").value);

  function showCurrent() {
    const c = currentContainer();
    $("fCurrent").innerHTML = `Currently running <span class="mono">${esc(c.image)}</span>, pull policy ${esc(c.pull_policy)}`;
  }
  $("fContainer").onchange = () => { showCurrent(); if (srcValue() === "registry") fillRepos(); };

  // Registry picker: preselect the repository the container already uses
  async function fillRepos() {
    $("fRepo").innerHTML = "<option>Loading…</option>"; $("fTag").innerHTML = "";
    let repos;
    try { repos = await getRepos(); } catch (e) { toast(e.message, "error"); repos = []; }
    if (!repos.length) {
      $("fRepo").innerHTML = '<option value="">The registry is empty</option>';
      $("fRefPreview").innerHTML = "Push a tar on the Images tab first, or choose Upload a tar file.";
      return syncSubmit();
    }
    const img = currentContainer().image, host = S.cfg.registry.host + "/";
    const usedRepo = img.startsWith(host) ? img.slice(host.length).replace(/:[^:/]+$/, "") : null;
    $("fRepo").innerHTML = repos.map((r) => `<option ${r.name === usedRepo ? "selected" : ""}>${esc(r.name)}</option>`).join("");
    await fillTags();
  }
  async function fillTags() {
    const repo = $("fRepo").value;
    $("fTag").innerHTML = "<option>Loading…</option>";
    try {
      const tags = await getTags(repo, true);
      $("fTag").innerHTML = tags.map((t) => `<option value="${esc(t.tag)}">${esc(t.tag)}${t.created ? `  (${esc(new Date(t.created).toLocaleDateString())})` : ""}</option>`).join("");
    } catch (e) { $("fTag").innerHTML = ""; toast(e.message, "error"); }
    showRef();
  }
  const pickedImage = () => $("fRepo").value && $("fTag").value ? `${S.cfg.registry.host}/${$("fRepo").value}:${$("fTag").value}` : "";
  function showRef() {
    const img = pickedImage(), cur = currentContainer();
    $("fRefPreview").innerHTML = !img ? "Choose a repository and tag."
      : img === cur.image ? `<span class="mono">${esc(img)}</span> is already running. Deploying it again restarts the pods.`
      : `Deploys <span class="mono">${esc(img)}</span>`;
    syncSubmit();
  }
  $("fRepo").onchange = fillTags; $("fTag").onchange = showRef;

  function setPolicies(list) {
    const keep = $("fPolicy").value;
    const text = { IfNotPresent: "IfNotPresent", Always: "Always (re-pull on every start)", Never: "Never (fail if the image is missing)" };
    $("fPolicy").innerHTML = list.map((p) => `<option value="${p}">${text[p]}</option>`).join("");
    $("fPolicy").value = list.includes(keep) ? keep : list[0];
  }
  function syncSource() {
    const src = srcValue(), dest = $("fDest").value, toReg = src === "registry" || dest === "registry";
    $("srcRegistry").hidden = src !== "registry"; $("srcUpload").hidden = src !== "upload";
    setPolicies(toReg ? ["IfNotPresent", "Always"] : ["IfNotPresent", "Never"]);
    $("fDestHint").textContent = dest === "registry"
      ? `Stored in ${S.cfg.registry.host}, so any node, including new ones, can pull it.`
      : "Loaded into containerd or CRI-O on every current node. Nodes added later will not have it.";
    $("fTargetHint").innerHTML = dest === "registry"
      ? `For example <span class="mono">team/api:1.4.2</span>. It is stored under <span class="mono">${esc((S.cfg.registry || {}).host || "")}/</span>.`
      : `For example <span class="mono">registry.local/team/api:1.4.2</span>. The archive is re-tagged to this name on every node.`;
    syncSubmit();
  }
  function syncSubmit() {
    const src = srcValue();
    $("submitBtn").textContent = src === "registry" ? "Deploy image" : $("fDest").value === "registry" ? "Push and deploy" : "Load and deploy";
    $("submitBtn").disabled = src === "registry" ? !pickedImage() : !chosenFile;
  }
  document.querySelectorAll('#fSource input').forEach((r) => r.onchange = () => { syncSource(); if (srcValue() === "registry") fillRepos(); });
  $("fDest").onchange = syncSource;

  function resetDrop() {
    $("drop").className = "drop";
    $("drop").innerHTML = "<strong>Drop an image archive here, or click to choose</strong><span>.tar from docker save, podman save or ctr export. Gzipped .tar.gz works too.</span>";
  }
  function setFile(f) {
    if (!f) return;
    chosenFile = f; $("drop").className = "drop has";
    $("drop").innerHTML = `<strong class="mono">${esc(f.name)}</strong><span>${fmtBytes(f.size)}. Click to choose a different file.</span>`;
    syncSubmit();
  }
  $("drop").onclick = () => $("fFile").click();
  $("drop").onkeydown = (e) => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); $("fFile").click(); } };
  $("fFile").onchange = (e) => setFile(e.target.files[0]);
  ["dragenter", "dragover"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.add("over"); }));
  ["dragleave", "drop"].forEach((ev) => $("drop").addEventListener(ev, (e) => { e.preventDefault(); $("drop").classList.remove("over"); }));
  $("drop").addEventListener("drop", (e) => setFile(e.dataTransfer.files[0]));

  $("submitBtn").onclick = async () => {
    if (!current) return;
    const d = current, base = `/api/deployments/${encodeURIComponent(d.namespace)}/${encodeURIComponent(d.name)}`;
    const btn = $("submitBtn");
    if (srcValue() === "registry") {
      return busy(btn, "Starting…", async () => {
        try {
          const r = await api(base + "/image-ref", { method: "POST", json: { container: $("fContainer").value, image: pickedImage(), pull_policy: $("fPolicy").value } });
          openJob(r.job_id); loadJobs();
        } catch (e) { toast(e.message, "error"); }
      });
    }
    const fd = new FormData();
    fd.append("file", chosenFile); fd.append("container", $("fContainer").value);
    fd.append("target_image", $("fTarget").value.trim()); fd.append("unique_tag", $("fUnique").checked ? "true" : "false");
    fd.append("pull_policy", $("fPolicy").value); fd.append("destination", $("fDest").value);
    $("upProg").hidden = false;
    await busy(btn, "Uploading…", async () => {
      try {
        const r = await uploadForm(base + "/image", fd, (p) => {
          $("upBar").style.width = p + "%";
          $("upText").textContent = p < 100 ? `Uploading to dashboard, ${p.toFixed(0)}%` : "Upload complete, preparing archive…";
        });
        openJob(r.job_id); loadJobs();
      } catch (e) { toast(e.message, "error"); $("upProg").hidden = true; }
    });
  };

  function openJob(id) {
    currentJob = id;
    $("formView").hidden = true; $("jobView").hidden = false; $("submitBtn").hidden = true; $("cancelBtn").textContent = "Close";
    $("log").innerHTML = ""; $("lanes").innerHTML = "";
    openSheet(); clearInterval(jobTimer); pollJob(); jobTimer = setInterval(pollJob, 1500);
  }
  async function pollJob() {
    let j;
    try { j = await api("/api/jobs/" + currentJob); } catch (e) { clearInterval(jobTimer); toast(e.message, "error"); return; }
    const pushOnly = j.mode === "push";
    $("sheetTitle").textContent = pushOnly
      ? (j.state === "running" ? "Pushing to registry" : j.state === "succeeded" ? "Pushed to registry" : "Push failed")
      : (j.state === "running" ? "Updating image" : j.state === "succeeded" ? "Image updated" : "Update failed");
    $("sheetSub").textContent = pushOnly ? j.filename : `${j.namespace}/${j.deployment}, container ${j.container}`;
    const stages = j.stages, idx = stages.findIndex((s) => s[0] === j.stage);
    $("stages").style.gridTemplateColumns = `repeat(${stages.length}, 1fr)`;
    $("stages").innerHTML = stages.map(([, l], i) => {
      let cls = "stage";
      if (i < idx || j.state === "succeeded") cls += " done"; else if (i === idx) cls += j.state === "failed" ? " bad" : " active";
      return `<div class="${cls}">${l}</div>`;
    }).join("");
    $("jobImage").innerHTML = j.target_image
      ? `${j.previous_image ? `<span class="mono">${esc(j.previous_image)}</span><br>to ` : "New image "}<span class="mono">${esc(j.target_image)}</span>`
      : j.filename ? `Reading <span class="mono">${esc(j.filename)}</span>` : "Preparing…";
    $("pushedSec").hidden = !j.pushed.length;
    $("pushed").innerHTML = j.pushed.map((p) => `<li><div class="grow"><div class="mono">${esc(p.image)}</div><div class="sub mono">${esc(p.digest)}</div></div></li>`).join("");
    $("lanesSec").hidden = j.mode !== "nodes";
    const nodes = Object.entries(j.nodes);
    $("lanes").innerHTML = nodes.length ? nodes.map(([n, s]) => {
      const txt = { queued: "Waiting", loading: s.progress >= 100 ? "Importing" : `Sending ${Math.round(s.progress || 0)}%`, loaded: `Loaded in ${s.seconds}s`, failed: "Failed" }[s.state];
      return `<div class="lane ${s.state}"><span class="node" title="${esc(n)}">${esc(n)}</span>
        <div class="track"><i style="width:${s.state === "loaded" || s.state === "failed" ? 100 : (s.progress || 0)}%"></i></div>
        <span class="pill s-${s.state}">${txt}</span>${s.error ? `<div class="lane-err">${esc(s.error)}</div>` : ""}</div>`;
    }).join("") : '<div class="dns">Nodes appear here once the archive is checked.</div>';
    if (j.rollout && j.rollout.desired != null) {
      $("rolloutSec").hidden = false; const r = j.rollout;
      $("rolloutNums").innerHTML = `<span><b>${r.updated}</b>updated</span><span><b>${r.ready}</b>ready</span><span><b>${r.available}</b>available</span><span><b>${r.desired}</b>desired</span>`;
    } else $("rolloutSec").hidden = true;
    const lg = $("log"), atBottom = lg.scrollHeight - lg.scrollTop - lg.clientHeight < 30;
    lg.innerHTML = j.log.map((l) => `<div class="${l.level}"><span class="t">${timeOf(l.ts)}</span>  ${esc(l.msg)}</div>`).join("");
    if (atBottom) lg.scrollTop = lg.scrollHeight;
    $("rollbackBtn").hidden = !(j.state !== "running" && j.previous_image);
    $("rollbackBtn").onclick = async () => {
      if (!confirm(`Roll ${j.container} back to ${j.previous_image}?`)) return;
      try { await api(`/api/jobs/${j.id}/rollback`, { method: "POST" }); toast("Rolled back to " + j.previous_image); loadDeployments(); pollJob(); }
      catch (e) { toast("Roll back failed: " + e.message, "error"); }
    };
    if (j.state !== "running") {
      clearInterval(jobTimer); jobTimer = null; loadJobs(); S.reposAt = 0; S.tagCache = {};
      if (S.tab === "images") loadImages(); else if (!pushOnly) loadDeployments();
      toast(pushOnly ? (j.state === "succeeded" ? `Pushed ${j.pushed.length} image(s) to the registry` : "Push to registry failed")
        : j.state === "succeeded" ? `${j.deployment} is running the new image` : `Update of ${j.deployment} failed`, j.state === "failed" ? "error" : "");
    }
  }

  // ================================================================== lifecycle
  function stopRefresh() { clearInterval(refreshTimer); refreshTimer = null; }
  function startRefresh() {
    stopRefresh();
    if ($("autoRefresh").checked) refreshTimer = setInterval(() => { if (!document.hidden) refreshView(); }, 10000);
  }
  $("nsSelect").onchange = refreshView;
  $("search").oninput = rerender;
  $("showSystem").onchange = rerender;
  $("refreshBtn").onclick = refreshView;
  $("autoRefresh").onchange = startRefresh;

  async function start() {
    try {
      S.cfg = await fetch("/api/config").then((r) => r.json());
      $("version").textContent = "v" + S.cfg.version;
      if (S.cfg.auth_required && !S.token) return showLogin();
      await loadNamespaces();
      $("login").hidden = true; $("app").hidden = false; $("tabs").hidden = false; $("signOut").hidden = !S.cfg.auth_required;
      $("readOnlyNote").hidden = !S.cfg.read_only;
      ["newConfigMap", "newSecret", "newPvc", "newPv"].forEach((id) => { $(id).hidden = S.cfg.read_only; });
      route(); startRefresh();
    } catch (e) {
      if (e.message !== "Sign in required") { $("clusterDot").className = "dot fail"; $("clusterText").textContent = "Dashboard API unreachable"; }
    }
  }
  start();
})();
