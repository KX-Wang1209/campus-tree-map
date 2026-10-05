/* ===================================================================
   天津滨海职业学院 · 校园树木地图 —— 应用逻辑

   设计要点：
   1. 学生用手机实地采集，所以优先用 GPS 定位，"加树"一步到位。
   2. 完全离线可用：底图瓦片、树种库都在本地；记录存 localStorage。
   3. 一次演示用途，所以不做后端；数据靠导出 CSV / 备份 JSON 流通。
   =================================================================== */

const STORE_KEY = 'tjbpi_trees_v1';
const RECORDER_KEY = 'tjbpi_recorder';

const state = {
  trees: [],          // 全部树木记录
  species: [],        // 树种库
  selectedId: null,   // 当前编辑的记录 id
  draft: null,        // 正在编辑（尚未保存）的数据
  pendingPhotos: [],  // 正在编辑的照片 dataURL 列表
  pickingSpecies: null,
  pickingHealth: '良好',
  choosingOnMap: false,
  sort: 'time',
  search: '',
};

const HEALTH_OPTIONS = ['良好', '一般', '较差', '枯死'];

/* ---------------------------------------------------------------
   协作模式

   用 server.py 打开时（网址是 http://.../，不是本地文件），自动进入
   协作模式：记录直接存服务器，别人几秒内就能看到，不用再收文件合并。
   如果服务器没开或探测失败，自动退回本地模式，功能照常可用。
   --------------------------------------------------------------- */
const collab = {
  enabled: false,     // 是否连上了协作服务器
  online: 0,          // 在线人数
  es: null,           // EventSource（服务器推送）
  pending: [],        // 服务器没连上时，暂存在本地、等连上再补传的记录
};

// 打包版启动时没有命令行窗口，用这个把"发给学生的地址"显示在页面上
const serverInfo = { lan: null, dataDir: null };

let map, campusLayer, boundaryLayer, treeLayer, labelLayer, photoLayer, meMarker;
let campusData = null;

/* ---------------------------------------------------------------
   工具
   --------------------------------------------------------------- */
const $ = (id) => document.getElementById(id);

function toast(msg, isErr = false) {
  const t = $('toast');
  t.textContent = msg;
  t.className = 'toast' + (isErr ? ' err' : '');
  clearTimeout(t._timer);
  t._timer = setTimeout(() => t.classList.add('hidden'), 2400);
}

function uid() {
  return 't' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}

function fmtTime(ts) {
  const d = new Date(ts);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/* ---------------------------------------------------------------
   本地存储
   --------------------------------------------------------------- */
function loadTrees() {
  try {
    const raw = localStorage.getItem(STORE_KEY);
    state.trees = raw ? JSON.parse(raw) : [];
    if (!Array.isArray(state.trees)) state.trees = [];
  } catch (e) {
    console.error('读取本地数据失败', e);
    state.trees = [];
  }
}

function saveTrees() {
  try {
    localStorage.setItem(STORE_KEY, JSON.stringify(state.trees));
    return true;
  } catch (e) {
    // 照片太多会超配额
    console.error('保存失败', e);
    toast('保存失败：本地存储已满，请先导出备份并删除部分照片', true);
    return false;
  }
}

/* ---------------------------------------------------------------
   协作服务器通信

   用 server.py 或打包版启动时自动进入协作模式：记录直接存服务器，
   别人几秒内就能看到，不用再收文件手工合并。
   服务器没开/探测失败就退回本地模式，功能照常，不影响使用。
   --------------------------------------------------------------- */
async function api(path, options) {
  const r = await fetch(path, options);
  if (!r.ok) throw new Error(`HTTP ${r.status}`);
  return r.json();
}

/** 启动时探测服务器；连上就拉全量数据并订阅推送 */
async function initCollab() {
  if (location.protocol === 'file:') return false;   // 本地文件打开，不可能有服务器
  try {
    const snap = await api('api/snapshot');
    if (!snap || !snap.server) return false;

    collab.enabled = true;
    state.trees = snap.trees || [];
    saveTrees();                 // 本地留一份，断网时还能看
    connectEvents();
    flushPending();              // 补传之前没送上去的
    loadServerInfo();            // 把"发给学生的地址"显示出来
    updateModeBar();
    renderTrees();
    return true;
  } catch (e) {
    return false;                // 服务器没开 → 安静退回本地模式
  }
}

/** 打包版双击启动时没有命令行窗口，把局域网地址显示在页面下方 */
async function loadServerInfo() {
  try {
    const info = await api('api/info');
    if (info && info.lan && !/127\.0\.0\.1/.test(info.lan)) {
      serverInfo.lan = info.lan;
    }
    if (info && info.dataDir) serverInfo.dataDir = info.dataDir;
  } catch (e) {
    // 老版本 server.py 没这个接口，忽略即可
  }
}

/** 订阅服务器推送：别人记的树自动出现在自己地图上 */
function connectEvents() {
  if (collab.es) collab.es.close();
  const es = new EventSource('api/events');
  collab.es = es;

  es.onopen = () => { collab.online = Math.max(collab.online, 1); updateModeBar(); };

  es.onmessage = (ev) => {
    let msg;
    try { msg = JSON.parse(ev.data); } catch (e) { return; }
    if (msg.type === 'upsert' && msg.tree) {
      upsertLocal(msg.tree);
      renderTrees();
      if (msg.tree.recorder) toast(`${msg.tree.recorder} 记了一棵树`);
    } else if (msg.type === 'bulk' && Array.isArray(msg.trees)) {
      msg.trees.forEach(upsertLocal);
      renderTrees();
    } else if (msg.type === 'delete' && msg.id) {
      state.trees = state.trees.filter((t) => t.id !== msg.id);
      saveTrees();
      renderTrees();
    }
    const lp = $('list-panel');
    if (lp && !lp.classList.contains('hidden')) renderList();
  };

  // 断线时更新界面状态；EventSource 自己会重连
  es.onerror = () => {
    if (collab.enabled) { collab.online = 0; updateModeBar(); }
  };
}

function upsertLocal(rec) {
  const i = state.trees.findIndex((t) => t.id === rec.id);
  if (i >= 0) state.trees[i] = rec; else state.trees.push(rec);
  saveTrees();
}

/** 把一条记录送到服务器；失败则暂存，等连上补传 */
async function pushTree(rec) {
  if (!collab.enabled) return false;
  try {
    const res = await api('api/trees', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tree: rec }),
    });
    if (res && res.tree) {
      // 服务器可能因为 id 撞车换了新 id，本地要跟着改，否则下次编辑会对不上
      if (res.renamed) {
        state.trees = state.trees.filter((t) => t.id !== rec.id);
      }
      upsertLocal(res.tree);
      return true;
    }
  } catch (e) {
    queuePending(rec);
  }
  return false;
}

async function pushDelete(id) {
  if (!collab.enabled) return;
  try {
    await api('api/trees/' + encodeURIComponent(id), { method: 'DELETE' });
  } catch (e) {
    queuePending({ id, _deleted: true });
  }
}

function queuePending(rec) {
  const i = collab.pending.findIndex((x) => x.id === rec.id);
  if (i >= 0) collab.pending[i] = rec; else collab.pending.push(rec);
}

async function flushPending() {
  if (!collab.enabled || !collab.pending.length) return;
  const items = collab.pending.slice();
  const alive = [];
  for (const it of items) {
    try {
      if (it._deleted) {
        await api('api/trees/' + encodeURIComponent(it.id), { method: 'DELETE' });
      } else {
        await api('api/trees', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ tree: it }),
        });
      }
    } catch (e) { alive.push(it); }
  }
  collab.pending = alive;
  if (items.length && !alive.length) toast(`已补传 ${items.length} 条`);
}

/* ---------------------------------------------------------------
   地图初始化
   --------------------------------------------------------------- */
async function initMap() {
  const bounds = await fetch('bounds.json').then((r) => r.json());
  const center = bounds.center;

  map = L.map('map', {
    center, zoom: 18, minZoom: 16, maxZoom: 20,
    zoomControl: false, attributionControl: false,
    maxBounds: [[bounds.south - 0.004, bounds.west - 0.004],
                [bounds.north + 0.004, bounds.east + 0.004]],
    maxBoundsViscosity: 0.8,
  });

  // 本地瓦片底图（完全离线可用，校园里没信号也能看）
  L.tileLayer('tiles/{z}/{x}_{y}.jpg', {
    minZoom: 17, maxZoom: 20, maxNativeZoom: 19,
    tileSize: 256, keepBuffer: 4,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  campusData = await fetch('campus.json').then((r) => r.json());

  buildBaseLayers();
  treeLayer = L.layerGroup().addTo(map);
  photoLayer = L.layerGroup().addTo(map);

  map.on('click', onMapClick);

  // 定位
  map.locate({ setView: false, watch: true, enableHighAccuracy: true });
  map.on('locationfound', (e) => {
    if (!meMarker) {
      meMarker = L.circleMarker(e.latlng, {
        radius: 8, color: '#fff', weight: 3,
        fillColor: '#1976d2', fillOpacity: 1,
      }).addTo(map);
      meMarker.bindTooltip('你在这里', { permanent: false });
    } else {
      meMarker.setLatLng(e.latlng);
    }
    window._myLatLng = e.latlng;
    if (state.choosingOnMap) {
      // 采集模式下用当前位置
      state.choosingOnMap = false;
      openSheet(e.latlng.lat, e.latlng.lng, null);
    }
  });
  map.on('locationerror', () => { window._myLatLng = null; });

  renderTrees();
}

/* 底图图层：建筑、道路、运动场地、水体、边界、名称 */
function buildBaseLayers() {
  const bld = [], roads = [], sports = [], water = [], labels = [];

  for (const ft of campusData.features) {
    const p = ft.properties, g = ft.geometry;
    if (p.kind === 'building') bld.push(ft);
    else if (p.kind === 'highway') roads.push(ft);
    else if (p.kind === 'leisure') {
      if (p.sub === 'pitch' || p.sub === 'track' || p.sub === 'bleachers') sports.push(ft);
    } else if (p.kind === 'natural' && p.sub === 'water') water.push(ft);

    if (p.kind === 'building' && p.name) labels.push(ft);
  }

  // 建筑：淡橙色填充，便于与树木区分
  const buildingLayer = L.geoJSON({ type: 'FeatureCollection', features: bld }, {
    style: { color: '#e65100', weight: 1.6, fillColor: '#ffcc80', fillOpacity: 0.30 },
    onEachFeature: (f, layer) => {
      const p = f.properties;
      const h = p.height_m ? ` · 约 ${p.height_m} 米(${p.levels || '?'}层)` : '';
      const basis = p.height_basis ? `<br><span style="font-size:11px;opacity:.7">${escapeHtml(p.height_basis)}</span>` : '';
      layer.bindTooltip(`<b>${escapeHtml(p.name || '建筑')}</b>${h}${basis}`, { sticky: true });
    },
  }).addTo(map);

  const roadLayer = L.geoJSON({ type: 'FeatureCollection', features: roads }, {
    style: { color: '#8d6e63', weight: 2.4, opacity: 0.55, dashArray: null },
  }).addTo(map);

  const sportLayer = L.geoJSON({ type: 'FeatureCollection', features: sports }, {
    // 只描边不填充：卫星影像上球场本来就是彩色的，填充会盖住且易与水体混淆
    style: { color: '#1e88e5', weight: 1.7, fill: false, opacity: 0.85 },
    onEachFeature: (f, layer) => {
      if (f.properties.name) layer.bindTooltip(escapeHtml(f.properties.name), { sticky: true });
    },
  }).addTo(map);

  const waterLayer = L.geoJSON({ type: 'FeatureCollection', features: water }, {
    style: { color: '#0277bd', weight: 1.5, fillColor: '#29b6f6', fillOpacity: 0.30 },
  }).addTo(map);

  boundaryLayer = L.geoJSON(campusData.boundary, {
    style: { color: '#00e5ff', weight: 2.6, fill: false, opacity: 0.9 },
  }).addTo(map);

  labelLayer = L.layerGroup();
  for (const ft of labels) {
    const c = polygonCentroid(ft.geometry);
    if (!c) continue;
    L.marker(c, {
      icon: L.divIcon({
        className: 'bld-label', html: escapeHtml(ft.properties.name.replace('学生公寓', '公寓')),
        iconSize: [0, 0], iconAnchor: [0, 0],
      }),
      interactive: false,
    }).addTo(labelLayer);
  }
  labelLayer.addTo(map);

  // 保存引用以便图层开关
  window._baseLayers = {
    buildings: buildingLayer, roads: roadLayer,
    sports: sportLayer, water: waterLayer,
  };
}

function polygonCentroid(geom) {
  let pts = [];
  if (geom.type === 'Polygon') pts = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') pts = geom.coordinates[0][0];
  else return null;
  let x = 0, y = 0;
  for (const c of pts) { x += c[0]; y += c[1]; }
  return [y / pts.length, x / pts.length];
}

/* ---------------------------------------------------------------
   树木渲染
   --------------------------------------------------------------- */
function speciesById(id) {
  return state.species.find((s) => s.id === id) ||
         { name: '未记录', icon: '🌳', color: '#9e9e9e', id: 'unknown' };
}

function renderTrees() {
  treeLayer.clearLayers();
  photoLayer.clearLayers();

  const showPhotos = $('ly-photos').checked;

  for (const t of state.trees) {
    const sp = speciesById(t.species);
    const pin = L.marker([t.lat, t.lon], {
      icon: L.divIcon({
        className: 'tree-pin' + (t.id === state.selectedId ? ' selected' : ''),
        html: `<div class="pin-dot" style="background:${sp.color}">
                 <span>${sp.icon}</span>
               </div>${t.count > 1 ? `<div class="pin-count">${t.count}</div>` : ''}`,
        iconSize: [26, 26], iconAnchor: [13, 26],
      }),
      riseOnHover: true,
    });
    pin.bindTooltip(
      `<b>${escapeHtml(sp.name)}</b>${t.count > 1 ? ` × ${t.count}` : ''}` +
      (t.note ? `<br><span style="font-size:11px">${escapeHtml(t.note)}</span>` : ''),
      { direction: 'top', offset: [0, -24] }
    );
    pin.on('click', (e) => {
      L.DomEvent.stopPropagation(e);
      openSheet(t.lat, t.lon, t.id);
    });
    pin.addTo(treeLayer);

    if (showPhotos && t.photos && t.photos.length) {
      L.marker([t.lat, t.lon], {
        icon: L.divIcon({
          className: 'photo-bubble',
          html: `<img src="${t.photos[0]}" alt="">`,
          iconSize: [76, 76], iconAnchor: [38, 108],
        }),
        interactive: false,
      }).addTo(photoLayer);
    }
  }

  $('list-count').textContent = state.trees.length;
  updateModeBar();
  invalidateTrees3D();    // 数据变了，三维下次同步时重建
  syncTrees3D();          // 三维开着的话立刻同步
}

function updateModeBar() {
  const total = state.trees.reduce((s, t) => s + (t.count || 1), 0);
  if (collab.enabled) {
    const who = collab.online > 1 ? ` · ${collab.online} 人在线` : '';
    const stat = state.trees.length
      ? `已记 ${state.trees.length} 条 / 共 ${total} 棵`
      : '点地图添加第一棵树';
    // 局域网地址一直显示，老师任何时候都能看到该发什么给学生
    const share = serverInfo.lan
      ? ` · <span id="lan-addr" title="点一下复制，发给学生">📱 ${escapeHtml(serverInfo.lan)}</span>`
      : '';
    $('mode-text').innerHTML = `🟢 实时协作中${who} · ${stat}${share}`;
    bindLanAddr();
    return;
  }
  $('mode-text').textContent = state.trees.length
    ? `已记录 ${state.trees.length} 条 · 共 ${total} 棵`
    : '点地图上的树的位置，即可添加一棵树';
}

/** 让状态栏里的局域网地址可以点一下就复制 */
function bindLanAddr() {
  const el = $('lan-addr');
  if (!el || el._bound) return;
  el._bound = true;
  el.style.cursor = 'pointer';
  el.style.textDecoration = 'underline dotted';
  el.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(serverInfo.lan);
      toast('地址已复制，发到班级群里即可');
    } catch (e) {
      // 非 https 或旧浏览器拿不到剪贴板权限，退回到手动复制
      toast('请手动复制：' + serverInfo.lan);
    }
  });
}

/* ---------------------------------------------------------------
   地图点击：选点
   --------------------------------------------------------------- */
let clickTimer = null;
function onMapClick(e) {
  if (!state.choosingOnMap) return;
  state.choosingOnMap = false;
  openSheet(e.latlng.lat, e.latlng.lng, null);
}

/* ---------------------------------------------------------------
   编辑抽屉
   --------------------------------------------------------------- */
function openSheet(lat, lon, id) {
  state.selectedId = id;
  const existing = id ? state.trees.find((t) => t.id === id) : null;

  state.draft = existing
    ? { ...existing }
    : { id: uid(), lat, lon, species: null, count: 1, height: null, dbh: null,
        health: '良好', note: '', recorder: localStorage.getItem(RECORDER_KEY) || '',
        photos: [], created: Date.now() };

  state.pendingPhotos = [...(state.draft.photos || [])];
  state.pickingSpecies = state.draft.species;
  state.pickingHealth = state.draft.health || '良好';

  $('sheet-title').textContent = existing ? '编辑这棵树' : '添加一棵树';
  $('btn-delete').classList.toggle('hidden', !existing);
  $('f-lat').value = lat.toFixed(6);
  $('f-lon').value = lon.toFixed(6);
  $('f-count').value = state.draft.count || 1;
  $('f-height').value = state.draft.height ?? '';
  $('f-dbh').value = state.draft.dbh ?? '';
  $('f-note').value = state.draft.note || '';
  $('f-recorder').value = state.draft.recorder || '';

  renderSpeciesGrid();
  renderHealthChips();
  renderPhotoPreview();
  updateLocHint();

  $('sheet-mask').classList.remove('hidden');
  $('sheet').classList.remove('hidden');
  $('sheet').scrollTop = 0;
}

function closeSheet() {
  $('sheet-mask').classList.add('hidden');
  $('sheet').classList.add('hidden');
  state.selectedId = null;
  state.draft = null;
  state.pendingPhotos = [];
  renderTrees();
}

function updateLocHint() {
  const my = window._myLatLng;
  const lat = parseFloat($('f-lat').value);
  const lon = parseFloat($('f-lon').value);
  let txt = '在地图上点选位置，或直接输入坐标';
  if (!isNaN(lat) && !isNaN(lon) && my) {
    const d = map.distance([lat, lon], my);
    txt = d < 12
      ? `📍 就在你当前位置附近（相差约 ${d.toFixed(0)} 米）`
      : `距你当前位置约 ${d < 1000 ? d.toFixed(0) + ' 米' : (d / 1000).toFixed(2) + ' 公里'}`;
  }
  $('loc-hint').textContent = txt;
}

/* 树种网格：按用途分组 */
function renderSpeciesGrid() {
  const grid = $('species-grid');
  const groups = {};
  for (const sp of state.species) {
    (groups[sp.role] = groups[sp.role] || []).push(sp);
  }
  let html = '';
  for (const [role, list] of Object.entries(groups)) {
    html += `<div class="sp-group-title">${escapeHtml(role)}</div>`;
    for (const sp of list) {
      html += `<button type="button" class="sp-item${state.pickingSpecies === sp.id ? ' active' : ''}"
                 data-sp="${sp.id}">
                 <span class="sp-icon">${sp.icon}</span>
                 <span class="sp-name">${escapeHtml(sp.name)}</span>
               </button>`;
    }
  }
  grid.innerHTML = html;
  grid.querySelectorAll('.sp-item').forEach((el) => {
    el.addEventListener('click', () => {
      state.pickingSpecies = el.dataset.sp;
      renderSpeciesGrid();
    });
  });
  $('f-species-other').classList.toggle('hidden', state.pickingSpecies !== 'unknown');
}

function renderHealthChips() {
  const box = $('f-health');
  box.innerHTML = HEALTH_OPTIONS.map((h) =>
    `<button type="button" class="chip${state.pickingHealth === h ? ' active' : ''}" data-h="${h}">${h}</button>`
  ).join('');
  box.querySelectorAll('.chip').forEach((el) => {
    el.addEventListener('click', () => {
      state.pickingHealth = el.dataset.h;
      renderHealthChips();
    });
  });
}

function renderPhotoPreview() {
  const box = $('photo-preview');
  box.innerHTML = state.pendingPhotos.map((p, i) =>
    `<div class="photo-thumb"><img src="${p}" alt=""><button type="button" data-i="${i}">✕</button></div>`
  ).join('');
  box.querySelectorAll('button').forEach((el) => {
    el.addEventListener('click', () => {
      state.pendingPhotos.splice(Number(el.dataset.i), 1);
      renderPhotoPreview();
    });
  });
}

/* 照片压缩后存为 dataURL —— 手机原图太大会撑爆本地存储 */
async function addPhoto(file) {
  if (!file) return;
  if (state.pendingPhotos.length >= 3) return toast('最多 3 张照片', true);
  try {
    const dataUrl = await compressImage(file, 900, 0.72);
    state.pendingPhotos.push(dataUrl);
    renderPhotoPreview();
  } catch (e) {
    toast('照片处理失败', true);
  }
}

function compressImage(file, maxSide, quality) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = reject;
    reader.onload = () => {
      const img = new Image();
      img.onerror = reject;
      img.onload = () => {
        let { width: w, height: h } = img;
        const scale = Math.min(1, maxSide / Math.max(w, h));
        w = Math.round(w * scale); h = Math.round(h * scale);
        const cv = document.createElement('canvas');
        cv.width = w; cv.height = h;
        cv.getContext('2d').drawImage(img, 0, 0, w, h);
        resolve(cv.toDataURL('image/jpeg', quality));
      };
      img.src = reader.result;
    };
    reader.readAsDataURL(file);
  });
}

/* 保存 */
function saveSheet() {
  if (!state.pickingSpecies) {
    toast('请选择树种（不认识就选「暂不确定」）', true);
    return;
  }
  const lat = parseFloat($('f-lat').value);
  const lon = parseFloat($('f-lon').value);
  if (isNaN(lat) || isNaN(lon)) return toast('位置无效，请重新选点', true);

  const count = Math.max(1, parseInt($('f-count').value, 10) || 1);
  const height = parseFloat($('f-height').value);
  const dbh = parseFloat($('f-dbh').value);
  const other = $('f-species-other').value.trim();
  const recorder = $('f-recorder').value.trim();

  const rec = {
    id: state.draft.id,
    lat, lon,
    species: state.pickingSpecies,
    speciesOther: state.pickingSpecies === 'unknown' ? other : '',
    count,
    height: isNaN(height) ? null : height,
    dbh: isNaN(dbh) ? null : dbh,
    health: state.pickingHealth,
    note: $('f-note').value.trim(),
    recorder,
    photos: state.pendingPhotos,
    created: state.draft.created || Date.now(),
    updated: Date.now(),
  };

  if (recorder) localStorage.setItem(RECORDER_KEY, recorder);

  const idx = state.trees.findIndex((t) => t.id === rec.id);
  if (idx >= 0) state.trees[idx] = rec;
  else state.trees.push(rec);
  const ok = saveTrees();

  if (collab.enabled) {
    // 协作模式：先在本地显示，再推给服务器，别人就能看到
    toast(idx >= 0 ? '已更新' : '已记录 ✓');
    closeSheet();
    renderTrees();
    pushTree(rec);
    return;
  }

  if (!ok) return;            // 存不下就不关面板，避免用户以为存上了
  toast(idx >= 0 ? '已更新' : '已记录 ✓');
  closeSheet();
  renderTrees();
}

function deleteTree() {
  if (!state.selectedId) return;
  if (!confirm('确定删除这条记录吗？')) return;
  const id = state.selectedId;
  state.trees = state.trees.filter((t) => t.id !== id);
  saveTrees();
  pushDelete(id);              // 协作模式下让别人的地图上也消失
  toast('已删除');
  closeSheet();
  renderTrees();
}

/* ---------------------------------------------------------------
   多人合并：重复检测

   两个人记录同一棵树，各自的 GPS 会差几米到十几米。所以用
   DUP_RADIUS_M 作为"疑似同一棵树"的判定半径 —— 这只是提示，
   不自动合并，最终由人确认。
   --------------------------------------------------------------- */
const DUP_RADIUS_M = 15;

function distanceM(a, b) {
  const R = 6371000;
  const dLat = (b.lat - a.lat) * Math.PI / 180;
  const dLon = (b.lon - a.lon) * Math.PI / 180;
  const lat = ((a.lat + b.lat) / 2) * Math.PI / 180;
  const x = dLon * Math.cos(lat);
  return Math.sqrt(dLat * dLat + x * x) * R;
}

/** 在 pool 里找与 rec 可能是同一棵树的记录，返回 {twin, dist} 或 null */
function findTwin(rec, pool) {
  let best = null, bestD = Infinity;
  for (const t of pool) {
    const d = distanceM(rec, t);
    if (d > DUP_RADIUS_M) continue;
    // 树种不同且都不是"暂不确定"→ 大概率是紧邻的两棵不同的树，不算重复
    const compatible = t.species === rec.species
      || t.species === 'unknown' || rec.species === 'unknown';
    if (!compatible) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best ? { twin: best, dist: bestD } : null;
}

/** 把 inc 的信息并进 base（同一棵树，取更全的信息） */
function mergeInto(base, inc) {
  base.count = Math.max(base.count || 1, inc.count || 1);
  if (base.height == null) base.height = inc.height ?? null;
  if (base.dbh == null) base.dbh = inc.dbh ?? null;
  base.photos = [...new Set([...(base.photos || []), ...(inc.photos || [])])].slice(0, 3);
  if (inc.note && inc.note !== base.note) {
    base.note = base.note ? `${base.note} / ${inc.note}` : inc.note;
  }
  const names = [...new Set([base.recorder, inc.recorder].filter(Boolean))];
  if (names.length) base.recorder = names.join('+');
  base.updated = Date.now();
}

function treeLabel(t) {
  const sp = speciesById(t.species);
  const nm = t.species === 'unknown' && t.speciesOther ? t.speciesOther : sp.name;
  const bits = [`×${t.count || 1}`];
  if (t.height) bits.push(`高${t.height}m`);
  if (t.dbh) bits.push(`胸径${t.dbh}cm`);
  return { icon: sp.icon, color: sp.color, name: nm, meta: bits.join(' · ') };
}

/* ---------------------------------------------------------------
   CSV 解析（学生可能只交 CSV，也需要能合并回来）
   --------------------------------------------------------------- */
function parseCSV(text) {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);   // 去 BOM
  const rows = [];
  let row = [], field = '', inQ = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQ) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; }
        else inQ = false;
      } else field += c;
    } else if (c === '"') inQ = true;
    else if (c === ',') { row.push(field); field = ''; }
    else if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; }
    else if (c !== '\r') field += c;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

function parseBackup(text) {
  const doc = JSON.parse(text);
  const trees = Array.isArray(doc) ? doc : doc.trees;
  if (!Array.isArray(trees)) throw new Error('文件里没有树木数据');
  return trees;
}

function parseCSVtoTrees(text) {
  const rows = parseCSV(text);
  if (rows.length < 2) throw new Error('CSV 是空的');
  const col = {};
  rows[0].forEach((h, i) => { col[String(h).trim()] = i; });
  if (col['纬度'] === undefined || col['经度'] === undefined) {
    throw new Error('CSV 缺少「纬度」「经度」列');
  }
  const cell = (r, k) => (col[k] === undefined ? '' : String(r[col[k]] ?? '').trim());
  const num = (v) => { const n = parseFloat(v); return isNaN(n) ? null : n; };

  const out = [];
  for (let i = 1; i < rows.length; i++) {
    const r = rows[i];
    if (!r || !r.length) continue;
    const lat = parseFloat(cell(r, '纬度'));
    const lon = parseFloat(cell(r, '经度'));
    if (isNaN(lat) || isNaN(lon)) continue;

    const spName = cell(r, '树种');
    const sp = state.species.find((s) => s.name === spName);
    const cnt = parseInt(cell(r, '数量'), 10);
    out.push({
      id: cell(r, '记录ID') || uid(),
      lat, lon,
      species: sp ? sp.id : 'unknown',
      speciesOther: sp ? '' : spName,
      count: isNaN(cnt) ? 1 : Math.max(1, cnt),
      height: num(cell(r, '树高(m)')),
      dbh: num(cell(r, '胸径(cm)')),
      health: cell(r, '生长状况') || '良好',
      note: cell(r, '备注'),
      recorder: cell(r, '记录人'),
      photos: [],                       // CSV 不含照片
      created: Date.parse(cell(r, '记录时间')) || Date.now(),
    });
  }
  if (!out.length) throw new Error('CSV 里没解析出有效记录');
  return out;
}

/* ---------------------------------------------------------------
   导入：支持 JSON 备份和 CSV，带疑似重复确认
   --------------------------------------------------------------- */
async function importFile(file) {
  let incoming;
  try {
    const text = await file.text();
    incoming = /^\s*[{[]/.test(text) ? parseBackup(text) : parseCSVtoTrees(text);
  } catch (e) {
    toast('导入失败：' + (e.message || '文件格式不对'), true);
    return;
  }

  const fresh = [];
  let dupId = 0;
  for (const t of incoming) {
    if (!t || typeof t.lat !== 'number' || typeof t.lon !== 'number') continue;
    if (!t.id) t.id = uid();
    const clash = state.trees.find((x) => x.id === t.id);
    if (clash) {
      // 同一个 id 未必是同一条：不同人各自生成 id 极小概率会撞上。
      // 位置也几乎相同才算"已经有了"，否则是撞号，换个新 id 导进来。
      if (distanceM(t, clash) < DUP_RADIUS_M) { dupId++; continue; }
      t.id = uid();
    }
    fresh.push(t);
  }

  if (!fresh.length) {
    toast(dupId ? `这 ${dupId} 条已经有了` : '没有可导入的记录');
    return;
  }

  // 协作模式下，导入完直接推到服务器，所有人立刻看到，不用再传文件
  if (collab.enabled) {
    try {
      const res = await api('api/bulk', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ trees: fresh }),
      });
      const snap = await api('api/snapshot');
      state.trees = snap.trees || state.trees;
      saveTrees();
      renderTrees(); renderList();
      toast(`已导入 ${res.count || fresh.length} 条，所有人都能看到`);
      return;
    } catch (e) {
      // 服务器不通就退回本地的逐条合并流程
    }
  }

  // 找出疑似与已有记录重复的
  const taken = new Set();
  const conflicts = [];
  const rest = [];
  for (const t of fresh) {
    const hit = findTwin(t, state.trees.filter((x) => !taken.has(x.id)));
    if (hit) { conflicts.push({ incoming: t, twin: hit.twin, dist: hit.dist }); taken.add(hit.twin.id); }
    else rest.push(t);
  }

  if (!conflicts.length) {
    state.trees.push(...rest);
    saveTrees(); renderTrees(); renderList();
    toast(`已导入 ${rest.length} 条`);
    return;
  }

  mergeCtx = { conflicts, rest, actions: conflicts.map(() => 'merge') };
  renderMergeReview();
  $('merge-mask').classList.remove('hidden');
  $('merge-panel').classList.remove('hidden');
}

let mergeCtx = null;

function renderMergeReview() {
  const { conflicts, rest, actions } = mergeCtx;
  $('merge-count').textContent = conflicts.length;
  $('merge-summary').textContent =
    `另有 ${rest.length} 条位置不冲突，将直接导入。` +
    `下面这些和已有记录离得很近（${DUP_RADIUS_M} 米内且树种相同），可能是同一棵树：`;

  $('merge-body').innerHTML = conflicts.map((c, i) => {
    const a = treeLabel(c.twin), b = treeLabel(c.incoming);
    const side = (o, tag) => `
      <div class="cf-side">
        <div class="cf-tag">${tag}</div>
        <div class="cf-name">${o.icon} ${escapeHtml(o.name)}</div>
        <div class="cf-meta">${escapeHtml(o.meta)}</div>
      </div>`;
    return `<div class="conflict" data-i="${i}">
      <div class="cf-dist">相距 ${c.dist.toFixed(1)} 米</div>
      <div class="cf-pair">
        ${side(a, '已有')}
        ${side(b, '导入')}
      </div>
      <div class="cf-meta-row">
        <span>已有：${escapeHtml(c.twin.recorder || '未署名')}${
          c.twin.note ? ' · ' + escapeHtml(c.twin.note) : ''}</span>
        <span>导入：${escapeHtml(c.incoming.recorder || '未署名')}${
          c.incoming.note ? ' · ' + escapeHtml(c.incoming.note) : ''}</span>
      </div>
      <div class="cf-actions">
        <button type="button" data-act="merge" class="${actions[i] === 'merge' ? 'active' : ''}">合并</button>
        <button type="button" data-act="keep" class="${actions[i] === 'keep' ? 'active' : ''}">都保留</button>
        <button type="button" data-act="drop" class="${actions[i] === 'drop' ? 'active' : ''}">丢弃导入</button>
      </div>
    </div>`;
  }).join('');

  $('merge-body').querySelectorAll('.cf-actions button').forEach((el) => {
    el.addEventListener('click', () => {
      const i = Number(el.closest('.conflict').dataset.i);
      mergeCtx.actions[i] = el.dataset.act;
      renderMergeReview();
    });
  });
}

function applyMerge() {
  const { conflicts, rest, actions } = mergeCtx;
  let merged = 0, kept = 0, dropped = 0;
  conflicts.forEach((c, i) => {
    const act = actions[i];
    if (act === 'merge') { mergeInto(c.twin, c.incoming); merged++; }
    else if (act === 'keep') { state.trees.push(c.incoming); kept++; }
    else dropped++;
  });
  state.trees.push(...rest);
  saveTrees();
  closeMergeReview();
  renderTrees();
  renderList();
  const bits = [`新增 ${rest.length + kept} 条`];
  if (merged) bits.push(`合并 ${merged} 条`);
  if (dropped) bits.push(`丢弃 ${dropped} 条`);
  toast('导入完成：' + bits.join('，'));
}

function closeMergeReview() {
  mergeCtx = null;
  $('merge-mask').classList.add('hidden');
  $('merge-panel').classList.add('hidden');
}

/* ---------------------------------------------------------------
   清单
   --------------------------------------------------------------- */
function renderList() {
  let rows = [...state.trees];

  if (state.search) {
    const q = state.search.toLowerCase();
    rows = rows.filter((t) => {
      const sp = speciesById(t.species);
      return (sp.name + (t.note || '') + (t.recorder || '') + (t.speciesOther || ''))
        .toLowerCase().includes(q);
    });
  }

  if (state.sort === 'species') {
    rows.sort((a, b) => speciesById(a.species).name.localeCompare(speciesById(b.species).name));
  } else if (state.sort === 'count') {
    rows.sort((a, b) => (b.count || 1) - (a.count || 1));
  } else {
    rows.sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  const body = $('list-body');
  if (!rows.length) {
    body.innerHTML = `<div class="empty"><span class="em-icon">🌱</span>
      <p>还没有记录任何树</p>
      <p>到校园里，点「＋ 记录身边的树」开始</p></div>`;
    return;
  }

  body.innerHTML = rows.map((t) => {
    const sp = speciesById(t.species);
    const nm = t.species === 'unknown' && t.speciesOther ? t.speciesOther : sp.name;
    const bits = [];
    if (t.note) bits.push(t.note);
    if (t.height) bits.push(`高 ${t.height}m`);
    if (t.dbh) bits.push(`胸径 ${t.dbh}cm`);
    if (t.health && t.health !== '良好') bits.push(t.health);
    if (t.recorder) bits.push(t.recorder);
    bits.push(fmtTime(t.created));

    const thumb = t.photos && t.photos.length
      ? `<img class="tr-thumb" src="${t.photos[0]}" alt="">` : '';

    return `<div class="tree-row" data-id="${t.id}">
      <div class="tr-icon" style="background:${sp.color}22">${sp.icon}</div>
      <div class="tr-main">
        <p class="tr-name">${escapeHtml(nm)}
          ${t.count > 1 ? `<span class="tr-count">×${t.count}</span>` : ''}</p>
        <p class="tr-sub">${escapeHtml(bits.join(' · '))}</p>
      </div>${thumb}
    </div>`;
  }).join('');

  body.querySelectorAll('.tree-row').forEach((el) => {
    el.addEventListener('click', () => {
      const t = state.trees.find((x) => x.id === el.dataset.id);
      if (!t) return;
      closeAllSheets();
      map.setView([t.lat, t.lon], 19, { animate: true });
      openSheet(t.lat, t.lon, t.id);
    });
  });
}

/* ---------------------------------------------------------------
   统计
   --------------------------------------------------------------- */
function renderStats() {
  const total = state.trees.reduce((s, t) => s + (t.count || 1), 0);
  const bySpecies = {};
  for (const t of state.trees) {
    const sp = speciesById(t.species);
    const nm = t.species === 'unknown' && t.speciesOther ? t.speciesOther : sp.name;
    const key = nm;
    bySpecies[key] = bySpecies[key] || { count: 0, records: 0, color: sp.color, icon: sp.icon };
    bySpecies[key].count += (t.count || 1);
    bySpecies[key].records += 1;
  }
  const sorted = Object.entries(bySpecies).sort((a, b) => b[1].count - a[1].count);
  const maxCount = sorted.length ? sorted[0][1].count : 1;

  const withPhoto = state.trees.filter((t) => t.photos && t.photos.length).length;

  let html = `<div class="stat-cards">
    <div class="stat-card"><span class="sc-num">${total}</span><span class="sc-label">树木总棵数</span></div>
    <div class="stat-card"><span class="sc-num">${state.trees.length}</span><span class="sc-label">记录条数</span></div>
    <div class="stat-card"><span class="sc-num">${sorted.length}</span><span class="sc-label">树种数</span></div>
  </div>
  <div class="stat-cards">
    <div class="stat-card"><span class="sc-num">${withPhoto}</span><span class="sc-label">带照片的记录</span></div>
    <div class="stat-card"><span class="sc-num">${total > 0 ? (total / state.trees.length).toFixed(1) : '—'}</span><span class="sc-label">平均每处棵数</span></div>
    <div class="stat-card"><span class="sc-num">${new Set(state.trees.map(t => t.recorder).filter(Boolean)).size}</span><span class="sc-label">参与记录人</span></div>
  </div>`;

  if (sorted.length) {
    html += `<div class="bar-section"><h3>树种构成</h3>`;
    for (const [name, info] of sorted) {
      const pct = (info.count / maxCount * 100).toFixed(1);
      html += `<div class="bar-row">
        <div class="bar-head"><span>${info.icon} ${escapeHtml(name)}</span>
          <span class="bh-num">${info.count} 棵</span></div>
        <div class="bar-track"><div class="bar-fill"
          style="width:${pct}%;background:${info.color}"></div></div>
      </div>`;
    }
    html += `</div>`;
  } else {
    html += `<div class="empty"><span class="em-icon">📊</span>
      <p>还没有数据可统计</p><p>先去记录几棵树吧</p></div>`;
  }

  $('stats-body').innerHTML = html;
}

/* ---------------------------------------------------------------
   导入 / 导出
   --------------------------------------------------------------- */
function exportCSV() {
  if (!state.trees.length) return toast('还没有数据可导出', true);
  const head = ['记录ID','树种','其他名称','纬度','经度','数量','树高(m)','胸径(cm)',
                '生长状况','备注','记录人','记录时间','照片数'];
  const lines = [head.join(',')];
  for (const t of state.trees) {
    const sp = speciesById(t.species);
    const row = [
      t.id, sp.name, t.speciesOther || '', t.lat.toFixed(6), t.lon.toFixed(6),
      t.count || 1, t.height ?? '', t.dbh ?? '', t.health || '',
      t.note || '', t.recorder || '', fmtTime(t.created), (t.photos || []).length,
    ].map((v) => {
      const s = String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    });
    lines.push(row.join(','));
  }
  const who = [...new Set(state.trees.map((t) => t.recorder).filter(Boolean))].join('+');
  // 加 BOM 让 Excel 正确识别中文
  downloadFile('\ufeff' + lines.join('\r\n'),
    `校园树木记录${who ? '_' + who : ''}_${exportStamp()}.csv`, 'text/csv;charset=utf-8');
  toast('已导出 CSV');
}

function exportJSON() {
  if (!state.trees.length) return toast('还没有数据可备份', true);
  const doc = {
    project: '天津滨海职业学院校园树木地图',
    exported: new Date().toISOString(),
    count: state.trees.length,
    trees: state.trees,
  };
  // 文件名带上记录人，多人交上来的文件才不会互相覆盖
  const who = [...new Set(state.trees.map((t) => t.recorder).filter(Boolean))].join('+');
  const name = `校园树木备份${who ? '_' + who : ''}_${exportStamp()}.json`;
  downloadFile(JSON.stringify(doc, null, 1), name, 'application/json');
  toast('已备份 JSON（含照片）');
}

function exportStamp() {
  const d = new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}_${p(d.getHours())}${p(d.getMinutes())}`;
}

function downloadFile(content, name, mime) {
  const blob = new Blob([content], { type: mime });
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

function importJSON(file) {
  const reader = new FileReader();
  reader.onload = () => {
    try {
      const doc = JSON.parse(reader.result);
      const trees = Array.isArray(doc) ? doc : doc.trees;
      if (!Array.isArray(trees)) throw new Error('格式不对');
      let added = 0;
      for (const t of trees) {
        if (!t || typeof t.lat !== 'number' || typeof t.lon !== 'number') continue;
        if (!t.id) t.id = uid();
        if (!state.trees.some((x) => x.id === t.id)) {
          state.trees.push(t);
          added++;
        }
      }
      saveTrees();
      renderTrees();
      renderList();
      toast(added ? `导入 ${added} 条` : '没有新记录（可能已存在）');
    } catch (e) {
      toast('导入失败：文件格式不对', true);
    }
  };
  reader.readAsText(file);
}

/* ---------------------------------------------------------------
   面板开关
   --------------------------------------------------------------- */
function closeAllSheets() {
  ['sheet', 'list-panel', 'stats-panel', 'help-panel'].forEach((id) => $(id).classList.add('hidden'));
  ['sheet-mask', 'list-mask', 'stats-mask', 'help-mask'].forEach((id) => $(id).classList.add('hidden'));
  state.selectedId = null;
  state.pickingSpecies = state.pickingSpecies;
}

function openPanel(name) {
  closeAllSheets();
  const map_ = { list: ['list-panel', 'list-mask'], stats: ['stats-panel', 'stats-mask'],
                 help: ['help-panel', 'help-mask'] };
  const [panel, mask] = map_[name];
  $(panel).classList.remove('hidden');
  $(mask).classList.remove('hidden');
  if (name === 'list') renderList();
  if (name === 'stats') renderStats();
}

/* ---------------------------------------------------------------
   绑定
   --------------------------------------------------------------- */
function bind() {
  $('sheet-close').addEventListener('click', closeSheet);
  $('sheet-mask').addEventListener('click', closeSheet);
  $('btn-save').addEventListener('click', saveSheet);
  $('btn-delete').addEventListener('click', deleteTree);

  $('btn-pick').addEventListener('click', () => {
    state.choosingOnMap = true;
    $('sheet-mask').classList.add('hidden');
    $('sheet').classList.add('hidden');
    toast('请在地图上点选这棵树的位置');
  });

  $('f-lat').addEventListener('input', updateLocHint);
  $('f-lon').addEventListener('input', updateLocHint);

  $('f-count').addEventListener('change', (e) => {
    e.target.value = Math.max(1, parseInt(e.target.value, 10) || 1);
  });
  document.querySelectorAll('.stepper .step').forEach((el) => {
    el.addEventListener('click', () => {
      const inp = $('f-count');
      inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + Number(el.dataset.step));
    });
  });

  $('btn-photo').addEventListener('click', () => $('f-photo').click());
  $('f-photo').addEventListener('change', (e) => {
    addPhoto(e.target.files[0]);
    e.target.value = '';
  });

  // 底部加树：优先用 GPS
  $('fab-add').addEventListener('click', () => {
    if (window._myLatLng) {
      openSheet(window._myLatLng.lat, window._myLatLng.lng, null);
      map.setView(window._myLatLng, Math.max(map.getZoom(), 19));
    } else {
      state.choosingOnMap = true;
      toast('正在定位…请在地图上点选位置，或稍候重试');
    }
  });

  $('btn-list').addEventListener('click', () => openPanel('list'));
  $('btn-stats').addEventListener('click', () => openPanel('stats'));
  $('btn-help').addEventListener('click', () => openPanel('help'));
  $('list-close').addEventListener('click', closeAllSheets);
  $('stats-close').addEventListener('click', closeAllSheets);
  $('help-close').addEventListener('click', closeAllSheets);
  $('list-mask').addEventListener('click', closeAllSheets);
  $('stats-mask').addEventListener('click', closeAllSheets);
  $('help-mask').addEventListener('click', closeAllSheets);

  $('list-search').addEventListener('input', (e) => { state.search = e.target.value; renderList(); });
  $('list-sort').addEventListener('change', (e) => { state.sort = e.target.value; renderList(); });

  $('btn-export-csv').addEventListener('click', exportCSV);
  $('btn-export-json').addEventListener('click', exportJSON);
  $('btn-import').addEventListener('click', () => $('file-import').click());
  $('file-import').addEventListener('change', (e) => {
    if (e.target.files[0]) importFile(e.target.files[0]);
    e.target.value = '';
  });

  // 合并确认
  $('merge-close').addEventListener('click', closeMergeReview);
  $('merge-cancel').addEventListener('click', closeMergeReview);
  $('merge-mask').addEventListener('click', closeMergeReview);
  $('merge-apply').addEventListener('click', applyMerge);
  $('merge-all').addEventListener('click', () => {
    mergeCtx.actions = mergeCtx.actions.map(() => 'merge');
    renderMergeReview();
  });

  $('layer-toggle').addEventListener('click', () => {
    $('layer-panel').classList.toggle('collapsed');
  });

  // 2D / 3D 切换
  document.querySelectorAll('.view-btn').forEach((btn) => {
    btn.addEventListener('click', () => setView(btn.dataset.view));
  });

  // 三维专用：自动环绕 / 树种筛选
  $('btn-orbit').addEventListener('click', toggleOrbit);
  $('btn-filter').addEventListener('click', () => {
    openFilterPanel();
    $('btn-filter').classList.toggle('active',
      !$('filter-panel').classList.contains('hidden'));
  });
  $('filter-all').addEventListener('click', clearSpeciesFilter);

  // 图层开关：整组切换
  const layerMap = {
    'ly-buildings': 'buildings',
    'ly-roads': 'roads',
    'ly-sports': 'sports',
    'ly-water': 'water',
  };
  for (const [id, key] of Object.entries(layerMap)) {
    $(id).addEventListener('change', (e) => {
      const layer = window._baseLayers[key];
      if (e.target.checked) layer.addTo(map); else map.removeLayer(layer);
      set3DLayerVisible(id, e.target.checked);
    });
  }
  $('ly-boundary').addEventListener('change', (e) => {
    e.target.checked ? boundaryLayer.addTo(map) : map.removeLayer(boundaryLayer);
    set3DLayerVisible('ly-boundary', e.target.checked);
  });
  $('ly-labels').addEventListener('change', (e) => {
    e.target.checked ? labelLayer.addTo(map) : map.removeLayer(labelLayer);
  });
  $('ly-trees').addEventListener('change', (e) => {
    e.target.checked ? treeLayer.addTo(map) : map.removeLayer(treeLayer);
    set3DLayerVisible('ly-trees', e.target.checked);
  });
  $('ly-photos').addEventListener('change', () => renderTrees());

  // 键盘
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') { closeSheet(); closeAllSheets(); }
  });
}

/* ---------------------------------------------------------------
   启动
   --------------------------------------------------------------- */
(async function main() {
  state.species = await fetch('species.json').then((r) => r.json());
  loadTrees();
  bind();
  await initMap();
  renderTrees();

  // 尝试连协作服务器；连不上就静默停留在本地模式
  const ok = await initCollab();
  if (!ok) updateModeBar();
})();
