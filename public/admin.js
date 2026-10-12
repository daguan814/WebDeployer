const $ = (id) => document.getElementById(id);
const CONCURRENCY = 4;
const SKIP_NAME = /^(\.DS_Store|Thumbs\.db|desktop\.ini)$/i;

const absoluteUrl = (path) => new URL(path, location.origin).href;

const state = {
  authed: false,
  sites: [],
  pending: null, // { files, totalBytes, folderName }
  uploading: false,
  updateTarget: null,
};

/* ------------------------------- 小工具 ------------------------------- */

function escapeHtml(text) {
  return String(text ?? '').replace(
    /[&<>"']/g,
    (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function formatSize(bytes) {
  if (!bytes) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(units.length - 1, Math.floor(Math.log(bytes) / Math.log(1024)));
  const value = bytes / 1024 ** i;
  return `${value >= 10 || i === 0 ? Math.round(value) : value.toFixed(1)} ${units[i]}`;
}

function formatTime(ms) {
  const d = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

function formatDuration(ms) {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return m ? `${m} 分 ${s} 秒` : `${s} 秒`;
}

function toast(message, type = '') {
  const node = document.createElement('div');
  node.className = `toast ${type}`;
  node.textContent = message;
  $('toasts').appendChild(node);
  setTimeout(() => node.remove(), 4200);
}

async function api(path, options = {}) {
  const res = await fetch(path, {
    credentials: 'same-origin',
    headers: options.body ? { 'Content-Type': 'application/json' } : undefined,
    ...options,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  const text = await res.text();
  let data = {};
  try {
    data = text ? JSON.parse(text) : {};
  } catch {
    data = { error: text };
  }
  if (!res.ok) {
    const err = new Error(data.error || `请求失败（${res.status}）`);
    err.status = res.status;
    err.data = data;
    throw err;
  }
  return data;
}

/* -------------------------------- 登录 -------------------------------- */

let lockTimer = null;

function showLock(retryAfterMs, message) {
  const btn = $('loginBtn');
  const input = $('password');
  const error = $('loginError');
  if (lockTimer) clearInterval(lockTimer);

  btn.disabled = true;
  input.disabled = true;
  let left = retryAfterMs;
  const paint = () => {
    error.hidden = false;
    error.textContent = `${message}，请在 ${formatDuration(left)} 后重试`;
    if (left <= 0) {
      clearInterval(lockTimer);
      lockTimer = null;
      btn.disabled = false;
      input.disabled = false;
      error.hidden = true;
    }
    left -= 1000;
  };
  paint();
  lockTimer = setInterval(paint, 1000);
}

async function refreshSession() {
  try {
    const data = await api('/api/session');
    state.authed = data.authed;
    if (data.authed) {
      showApp();
      await loadSites();
    } else {
      $('login').hidden = false;
      $('app').hidden = true;
      if (data.lock?.locked) showLock(data.lock.retryAfterMs, '登录已锁定');
      if (data.passwordSet === false) {
        $('loginError').hidden = false;
        $('loginError').textContent = '后台密码还没设置，请在服务器上运行 npm run set-password';
      }
    }
  } catch (err) {
    toast(err.message, 'err');
  }
}

$('loginForm').addEventListener('submit', async (event) => {
  event.preventDefault();
  const btn = $('loginBtn');
  const error = $('loginError');
  btn.disabled = true;
  error.hidden = true;
  try {
    await api('/api/login', { method: 'POST', body: { password: $('password').value } });
    $('password').value = '';
    state.authed = true;
    showApp();
    await loadSites();
  } catch (err) {
    if (err.data?.locked) {
      showLock(err.data.retryAfterMs || 0, '密码错误次数过多，已锁定');
    } else {
      error.hidden = false;
      error.textContent =
        err.data?.remaining !== undefined && err.data.remaining !== null
          ? `${err.message}，还可以试 ${err.data.remaining} 次`
          : err.message;
      btn.disabled = false;
    }
  }
});

$('logoutBtn').addEventListener('click', async () => {
  await api('/api/logout', { method: 'POST' });
  state.authed = false;
  state.sites = [];
  $('app').hidden = true;
  $('login').hidden = false;
  resetLoginForm();
  $('password').focus();
});

function showApp() {
  $('login').hidden = true;
  $('app').hidden = false;
  resetLoginForm();
}

function resetLoginForm() {
  const btn = $('loginBtn');
  btn.disabled = false;
  $('password').disabled = false;
  $('password').value = '';
  $('loginError').hidden = true;
}

/* ------------------------------ 站点列表 ------------------------------ */

async function loadSites() {
  const data = await api('/api/sites');
  state.sites = data.sites || [];
  renderSites();
  renderStats();
  renderTargetOptions();
}

function renderStats() {
  const total = state.sites.reduce((a, s) => a + (s.sizeBytes || 0), 0);
  $('stats').textContent = state.sites.length
    ? `${state.sites.length} 个站点 · 共 ${formatSize(total)}`
    : '';
}

function renderTargetOptions() {
  const select = $('pendingTarget');
  const current = select.value;
  select.innerHTML =
    '<option value="__new__">新建站点</option>' +
    state.sites
      .map((s) => `<option value="${escapeHtml(s.slug)}">更新到「${escapeHtml(s.name)}」</option>`)
      .join('');
  if ([...select.options].some((o) => o.value === current)) select.value = current;
  syncPendingFields();
}

function renderSites() {
  const list = $('siteList');
  $('sitesCount').textContent = state.sites.length ? `共 ${state.sites.length} 个` : '';
  $('emptyState').hidden = state.sites.length > 0;

  list.innerHTML = state.sites.map(siteCardHtml).join('');
  for (const card of list.querySelectorAll('.site-card')) {
    bindCard(card);
  }
  linkifyPaths();
}

function siteCardHtml(site) {
  // 只有一个文件的站点，复制按钮给的就是那个文件的直链，不用再展开列表
  const singleFile = site.fileCount === 1;
  const readableUrl = (() => {
    try {
      return decodeURIComponent(site.url);
    } catch {
      return site.url;
    }
  })();
  const warnings = (site.warnings || [])
    .map((w) => `<div class="warn">⚠ ${escapeHtml(w.message)}</div>`)
    .join('');
  const candidates = site.candidates || [];
  const entryRow =
    candidates.length > 1
      ? `<div class="entry-row">首页文件
           <select data-action="entry">
             ${candidates
               .map(
                 (c) =>
                   `<option value="${escapeHtml(c)}" ${c === site.entry ? 'selected' : ''}>${escapeHtml(c)}</option>`,
               )
               .join('')}
           </select>
         </div>`
      : '';
  const releases = (site.releases || [])
    .map(
      (r) => `<div class="release-row">
        <span>${escapeHtml(formatTime(r.createdAt))}</span>
        <span>${formatSize(r.sizeBytes)} · ${r.fileCount} 个文件</span>
        ${r.current ? '<span class="tag">当前</span>' : `<button class="ghost" data-action="rollback" data-version="${escapeHtml(r.version)}">切到这一版</button>`}
      </div>`,
    )
    .join('');

  return `<article class="site-card" data-slug="${escapeHtml(site.slug)}">
    <div class="site-top">
      <div>
        <div class="site-name">${escapeHtml(site.name)}</div>
        <a class="site-path" data-action="open" href="${escapeHtml(site.url)}" target="_blank" rel="noopener">${escapeHtml(readableUrl)}</a>
      </div>
      <div class="site-actions">
        <button class="ghost" data-action="open">打开</button>
        <button class="ghost" data-action="copy" title="${singleFile ? '文件直链，别人点开就是文件本身' : '站点目录地址，别人点开是文件列表'}">${singleFile ? '复制文件链接' : '复制链接'}</button>
        <button class="ghost" data-action="toggle-files">文件直链</button>
        <button class="ghost" data-action="update">更新</button>
        <button class="ghost" data-action="toggle-releases">版本</button>
        <button class="ghost danger" data-action="delete">删除</button>
      </div>
    </div>
    <div class="site-meta">
      <span>${formatSize(site.sizeBytes)}</span>
      <span>${site.fileCount} 个文件</span>
      <span>${escapeHtml(site.entry || '未识别首页')}</span>
      <span>更新于 ${escapeHtml(formatTime(site.updatedAt))}</span>
    </div>
    ${warnings}
    ${entryRow}
    <div class="files" hidden></div>
    <div class="releases" hidden>${releases}</div>
  </article>`;
}

function linkifyPaths() {
  // 卡片上的路径链接需要带上当前来源，转成绝对地址方便复制
  for (const a of document.querySelectorAll('.site-path')) {
    a.dataset.absolute = new URL(a.getAttribute('href'), location.origin).href;
  }
}

function bindCard(card) {
  const slug = card.dataset.slug;
  const site = state.sites.find((s) => s.slug === slug);

  for (const button of card.querySelectorAll('button[data-action]')) {
    button.addEventListener('click', async () => {
      const action = button.dataset.action;
      if (action === 'open') {
        window.open(card.querySelector('.site-path').dataset.absolute, '_blank', 'noopener');
      } else if (action === 'copy') {
        await copySiteLink(card, slug, site);
      } else if (action === 'update') {
        pickFolderFor(slug);
      } else if (action === 'toggle-releases') {
        const box = card.querySelector('.releases');
        box.hidden = !box.hidden;
      } else if (action === 'toggle-files') {
        await toggleFiles(card, slug, button);
      } else if (action === 'rollback') {
        await rollback(slug, button.dataset.version);
      } else if (action === 'delete') {
        await removeSite(slug, site?.name || slug);
      }
    });
  }

  const entrySelect = card.querySelector('select[data-action="entry"]');
  if (entrySelect) {
    entrySelect.addEventListener('change', async () => {
      try {
        await api(`/api/sites/${encodeURIComponent(slug)}`, {
          method: 'PATCH',
          body: { entry: entrySelect.value },
        });
        toast('首页已更新', 'ok');
        await loadSites();
      } catch (err) {
        toast(err.message, 'err');
        await loadSites();
      }
    });
  }

  // 直接拖到卡片上 = 更新这个站点
  card.addEventListener('dragover', (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    card.classList.add('drop-target');
  });
  card.addEventListener('dragleave', () => card.classList.remove('drop-target'));
  card.addEventListener('drop', async (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    event.stopPropagation();
    card.classList.remove('drop-target');
    const roots = rootsFromDataTransfer(event.dataTransfer);
    const { files, totalBytes } = await walkEntries(roots);
    if (!files.length) return toast('这个文件夹里没有可上传的文件', 'err');
    await deploy({ slug, files, totalBytes, mode: 'update' });
  });
}

async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    toast('链接已复制', 'ok');
  } catch {
    toast(text);
  }
}

/**
 * 站点只有一个文件时，复制按钮直接给这个文件的直链；
 * 多文件（或网页站点）还是给目录地址。
 */
async function copySiteLink(card, slug, site) {
  const folderUrl = card.querySelector('.site-path').dataset.absolute;
  if (site?.fileCount !== 1) return copyText(folderUrl);
  try {
    const data = await api(`/api/sites/${encodeURIComponent(slug)}/files`);
    const only = (data.files || [])[0];
    if (only) return copyText(absoluteUrl(only.url));
  } catch {
    // 拿不到文件清单就退回目录地址
  }
  return copyText(folderUrl);
}

/* ------------------------------ 文件直链 / 下载 ------------------------------ */

async function toggleFiles(card, slug, button) {
  const box = card.querySelector('.files');
  if (!box.hidden) {
    box.hidden = true;
    button.textContent = '文件直链';
    return;
  }
  box.hidden = false;
  button.textContent = '收起文件';
  box.innerHTML = '<p class="muted">正在读取文件列表…</p>';
  try {
    const data = await api(`/api/sites/${encodeURIComponent(slug)}/files`);
    box.innerHTML = renderFiles(data);
    bindFileRows(box);
  } catch (err) {
    box.innerHTML = `<p class="muted">${escapeHtml(err.message)}</p>`;
  }
}

function renderFiles(data) {
  const files = data.files || [];
  if (!files.length) return '<p class="muted">这个站点还没有文件。</p>';
  const note = data.truncated
    ? `<p class="muted">文件较多，只列出前 ${files.length} 个（共 ${data.total} 个）。</p>`
    : '';
  return (
    '<div class="file-head">直链可以贴到任何地方；「下载」那个链接会让浏览器直接保存文件。</div>'
    + files.map(fileRowHtml).join('')
    + note
  );
}

function fileRowHtml(file) {
  const href = absoluteUrl(file.url);
  return `<div class="file-row">
    <a class="file-name" href="${escapeHtml(href)}" target="_blank" rel="noopener">${escapeHtml(file.path)}</a>
    <span class="file-size">${formatSize(file.size)}</span>
    <span class="file-acts">
      <button class="ghost" type="button" data-file-copy="${escapeHtml(href)}">复制直链</button>
      <a class="ghost" href="${escapeHtml(absoluteUrl(file.downloadUrl))}">下载</a>
    </span>
  </div>`;
}

function bindFileRows(box) {
  for (const button of box.querySelectorAll('button[data-file-copy]')) {
    button.addEventListener('click', () => copyText(button.dataset.fileCopy));
  }
}

async function rollback(slug, version) {
  if (!confirm(`确定切换到版本 ${version} 吗？`)) return;
  try {
    await api(`/api/sites/${encodeURIComponent(slug)}/rollback`, {
      method: 'POST',
      body: { version },
    });
    toast('已切换版本', 'ok');
    await loadSites();
  } catch (err) {
    toast(err.message, 'err');
  }
}

async function removeSite(slug, name) {
  if (!confirm(`删除「${name}」？线上访问会立刻 404，且无法恢复。`)) return;
  try {
    await api(`/api/sites/${encodeURIComponent(slug)}`, { method: 'DELETE' });
    toast('站点已删除', 'ok');
    await loadSites();
  } catch (err) {
    toast(err.message, 'err');
  }
}

/* ---------------------------- 文件夹读取 ---------------------------- */

const reader = (entry) => {
  const dirReader = entry.createReader();
  return new Promise((resolve, reject) => {
    const all = [];
    const next = () =>
      dirReader.readEntries(
        (batch) => {
          if (!batch.length) return resolve(all);
          all.push(...batch);
          next();
        },
        reject,
      );
    next();
  });
};

const fileOf = (entry) =>
  new Promise((resolve, reject) => entry.file(resolve, reject));

/** 必须在 drop 事件里同步调用，否则浏览器会失效 */
function rootsFromDataTransfer(dataTransfer) {
  const roots = [];
  for (const item of dataTransfer.items || []) {
    if (item.kind !== 'file') continue;
    const entry = item.webkitGetAsEntry?.();
    if (entry) {
      roots.push(entry);
    } else {
      const file = item.getAsFile?.();
      if (file) {
        roots.push({
          isFile: true,
          isDirectory: false,
          name: file.name,
          file: (cb) => cb(file),
        });
      }
    }
  }
  return roots;
}

/** 顶层文件夹本身作为站点根目录，只取它里面的内容 */
async function walkEntries(roots) {
  const files = [];
  let totalBytes = 0;
  let folderName = '';

  const push = (rel, file) => {
    const parts = rel.split('/');
    if (parts.some((p) => SKIP_NAME.test(p) || p.startsWith('._'))) return;
    if (!file.size) return;
    files.push({ rel, file });
    totalBytes += file.size;
  };

  const walk = async (entry, prefix) => {
    if (entry.isFile) {
      const file = await fileOf(entry);
      push(prefix + entry.name, file);
    } else if (entry.isDirectory) {
      for (const child of await reader(entry)) {
        await walk(child, prefix + entry.name + '/');
      }
    }
  };

  if (roots.length === 1 && roots[0].isDirectory) {
    folderName = roots[0].name;
    for (const child of await reader(roots[0])) {
      await walk(child, '');
    }
  } else {
    for (const root of roots) {
      if (root.isDirectory) {
        if (!folderName) folderName = root.name;
        for (const child of await reader(root)) {
          await walk(child, '');
        }
      } else {
        await walk(root, '');
      }
    }
  }

  if (!folderName) folderName = stripExt(files[0]?.rel?.split('/')[0] || '新站点');
  return { files, totalBytes, folderName };
}

/** 单独拖进来一个 报表.pdf 时，站点名不该带上 .pdf */
const stripExt = (name) => name.replace(/\.[^.]+$/, '') || name;

function filesFromFileList(fileList) {
  const files = [];
  let totalBytes = 0;
  let folderName = '';
  for (const file of fileList) {
    const rel = file.webkitRelativePath || file.name;
    const parts = rel.split('/');
    if (parts.some((p) => SKIP_NAME.test(p) || p.startsWith('._'))) continue;
    if (!file.size) continue;
    if (parts.length > 1) folderName ||= parts[0];
    files.push({ rel: parts.slice(1).join('/') || file.name, file });
    totalBytes += file.size;
  }
  return { files, totalBytes, folderName: folderName || stripExt(files[0]?.rel || '新站点') };
}

/* ------------------------------ 拖拽交互 ------------------------------ */

const dropzone = $('dropzone');

for (const type of ['dragenter', 'dragover']) {
  dropzone.addEventListener(type, (event) => {
    if (!event.dataTransfer?.types?.includes('Files')) return;
    event.preventDefault();
    dropzone.classList.add('over');
  });
}

dropzone.addEventListener('dragleave', (event) => {
  if (event.target === dropzone) dropzone.classList.remove('over');
});

dropzone.addEventListener('drop', async (event) => {
  event.preventDefault();
  dropzone.classList.remove('over');
  if (state.uploading) return toast('还在上传中，请稍候', 'err');
  const roots = rootsFromDataTransfer(event.dataTransfer);
  const { files, totalBytes, folderName } = await walkEntries(roots);
  if (!files.length) return toast('这个文件夹里没有可上传的文件', 'err');
  openPending({ files, totalBytes, folderName });
});

// 阻止浏览器默认打开文件
window.addEventListener('dragover', (e) => e.preventDefault());
window.addEventListener('drop', (e) => e.preventDefault());

function slugify(name) {
  return (
    String(name)
      .normalize('NFC')
      .replace(/[\\/:*?"<>|]/g, '-')
      .replace(/\s+/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^[-.\s]+|[-.\s]+$/g, '')
      .slice(0, 60) || 'site'
  );
}

function openPending(pending) {
  state.pending = pending;
  $('pendingName').value = pending.folderName;
  $('pendingSlug').value = slugify(pending.folderName);
  $('pendingTarget').value = '__new__';
  $('pendingPanel').hidden = false;
  syncPendingFields();
  $('pendingPanel').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
}

function syncPendingFields() {
  const isNew = $('pendingTarget').value === '__new__';
  $('pendingName').disabled = !isNew;
  $('pendingSlug').disabled = !isNew;
  const pending = state.pending;
  if (!pending) return;
  $('pendingSummary').textContent = `${pending.files.length} 个文件 · 共 ${formatSize(pending.totalBytes)}`;
}

$('pendingTarget').addEventListener('change', () => {
  const value = $('pendingTarget').value;
  if (value !== '__new__') {
    const site = state.sites.find((s) => s.slug === value);
    if (site) {
      $('pendingName').value = site.name;
      $('pendingSlug').value = site.slug;
    }
  }
  syncPendingFields();
});

$('cancelUpload').addEventListener('click', () => {
  state.pending = null;
  $('pendingPanel').hidden = true;
});

$('startUpload').addEventListener('click', async () => {
  if (!state.pending) return;
  const target = $('pendingTarget').value;
  const isNew = target === '__new__';
  await deploy({
    slug: isNew ? $('pendingSlug').value.trim() : target,
    name: $('pendingName').value.trim(),
    files: state.pending.files,
    totalBytes: state.pending.totalBytes,
    mode: isNew ? 'create' : 'update',
  });
});

/* ------------------------------- 上传流程 ------------------------------ */

let pickerTarget = null;

$('pickBtn').addEventListener('click', () => {
  pickerTarget = null;
  $('folderPicker').click();
});

$('pickFilesBtn').addEventListener('click', () => {
  pickerTarget = null;
  $('filePicker').click();
});

// 散装文件：直接丢进站点根目录，不需要文件夹
$('filePicker').addEventListener('change', (event) => {
  const input = event.target;
  const files = [];
  let totalBytes = 0;
  for (const file of input.files || []) {
    if (SKIP_NAME.test(file.name) || file.name.startsWith('._')) continue;
    if (!file.size) continue;
    files.push({ rel: file.name, file });
    totalBytes += file.size;
  }
  input.value = '';
  if (!files.length) return toast('没有选到文件', 'err');
  if (state.uploading) return toast('还在上传中，请稍候', 'err');
  openPending({ files, totalBytes, folderName: stripExt(files[0].rel) });
});

function pickFolderFor(slug) {
  pickerTarget = slug;
  $('folderPicker').click();
}

$('folderPicker').addEventListener('change', async (event) => {
  const input = event.target;
  const picked = filesFromFileList(input.files || []);
  input.value = '';
  if (!picked.files.length) return toast('没有选到文件', 'err');
  if (state.uploading) return toast('还在上传中，请稍候', 'err');

  if (pickerTarget) {
    await deploy({ slug: pickerTarget, files: picked.files, totalBytes: picked.totalBytes, mode: 'update' });
    pickerTarget = null;
  } else {
    openPending(picked);
  }
});

function putFile(slug, version, item, onDelta) {
  return new Promise((resolve, reject) => {
    const xhr = new XMLHttpRequest();
    const url = `/api/sites/${encodeURIComponent(slug)}/releases/${version}/files?path=${encodeURIComponent(item.rel)}`;
    xhr.open('PUT', url);
    let last = 0;
    xhr.upload.onprogress = (event) => {
      if (!event.lengthComputable) return;
      onDelta(event.loaded - last);
      last = event.loaded;
    };
    xhr.onload = () => {
      if (xhr.status >= 200 && xhr.status < 300) return resolve();
      let message = `上传失败（${xhr.status}）`;
      try {
        message = JSON.parse(xhr.responseText).error || message;
      } catch {}
      reject(new Error(`${item.rel}：${message}`));
    };
    xhr.onerror = () => reject(new Error(`${item.rel}：网络中断`));
    xhr.send(item.file);
  });
}

async function deploy({ slug, name, files, totalBytes, mode }) {
  if (state.uploading) return toast('还在上传中，请稍候', 'err');
  state.uploading = true;
  window.onbeforeunload = () => '正在上传，离开会中断';

  const createdSite = mode === 'create';
  let version = null;
  const started = Date.now();
  let uploaded = 0;
  let lastTick = started;
  let lastBytes = 0;
  let speed = 0;

  $('pendingPanel').hidden = true;
  $('progressPanel').hidden = false;
  $('progressTitle').textContent = mode === 'create' ? `正在发布「${name}」` : `正在更新「${slug}」`;
  $('progressBar').style.width = '0%';
  $('progressText').textContent = `0% · 共 ${formatSize(totalBytes)}`;
  $('progressFile').textContent = '';
  $('startUpload').disabled = true;

  const tick = () => {
    const now = Date.now();
    const deltaMs = now - lastTick;
    if (deltaMs > 400) {
      speed = ((uploaded - lastBytes) / deltaMs) * 1000;
      lastTick = now;
      lastBytes = uploaded;
    }
    const percent = totalBytes ? Math.min(100, (uploaded / totalBytes) * 100) : 0;
    $('progressBar').style.width = `${percent}%`;
    const remaining = speed > 0 ? ((totalBytes - uploaded) / speed) * 1000 : 0;
    $('progressText').textContent =
      `${percent.toFixed(0)}% · ${formatSize(uploaded)} / ${formatSize(totalBytes)}` +
      (speed > 0 ? ` · ${formatSize(speed)}/s · 约剩 ${formatDuration(remaining)}` : '');
  };
  const ticker = setInterval(tick, 400);

  try {
    if (mode === 'create') {
      await api('/api/sites', { method: 'POST', body: { slug, name: name || slug } });
    }
    const begin = await api(`/api/sites/${encodeURIComponent(slug)}/releases`, { method: 'POST' });
    version = begin.version;

    const queue = files.slice();
    const workers = Array.from({ length: Math.min(CONCURRENCY, queue.length) }, async () => {
      while (queue.length) {
        const item = queue.shift();
        $('progressFile').textContent = item.rel;
        await putFile(slug, version, item, (delta) => {
          uploaded += delta;
        });
      }
    });
    await Promise.all(workers);

    uploaded = totalBytes;
    tick();
    $('progressFile').textContent = '正在扫描首页…';

    const result = await api(
      `/api/sites/${encodeURIComponent(slug)}/releases/${version}/commit`,
      { method: 'POST' },
    );

    const seconds = ((Date.now() - started) / 1000).toFixed(1);
    toast(`发布成功 · ${result.site.url}（${seconds}s）`, 'ok');
    // 只传了一个文件时，直接把它的直链报出来 —— 复制给别人下载就用它
    if (files.length === 1) {
      const rel = files[0].rel;
      const direct = absoluteUrl(
        `/s/${encodeURIComponent(slug)}/${rel.split('/').map(encodeURIComponent).join('/')}`,
      );
      toast(`文件直链：${direct}`, 'ok');
    }
    await loadSites();
  } catch (err) {
    if (version) {
      await api(
        `/api/sites/${encodeURIComponent(slug)}/releases/${version}`,
        { method: 'DELETE' },
      ).catch(() => {});
    }
    if (createdSite) {
      await api(`/api/sites/${encodeURIComponent(slug)}`, { method: 'DELETE' }).catch(() => {});
    }
    toast(err.message, 'err');
  } finally {
    clearInterval(ticker);
    state.uploading = false;
    state.pending = null;
    $('startUpload').disabled = false;
    $('progressPanel').hidden = true;
    window.onbeforeunload = null;
    await loadSites().catch(() => {});
  }
}

/* -------------------------------- 启动 -------------------------------- */

$('password').focus();
refreshSession();
