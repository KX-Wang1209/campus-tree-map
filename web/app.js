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
  pickingSeveral: false,   // 数量选「若干」
  spSearch: '',            // 树种搜索词
  spCollapsed: new Set(['灌木或藤木', '草本', '竹类']),  // 默认折起的组
  choosingOnMap: false,
  drawingRange: false,     // 正在地图上圈范围
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

let map, campusLayer, boundaryLayer, treeLayer, labelLayer, poiLayer, photoLayer, meMarker;
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
   云端协作（腾讯云开发 CloudBase）

   网页传到云上之后，学生用手机打开同一个网址就能一起记录，
   不再要求同一个局域网，也不用老师一直开着电脑。
   三种模式按优先级自动选：云端 → 局域网服务器 → 纯本地。
   --------------------------------------------------------------- */
const CLOUD_ENV = 'campus-tree-map-d9fro6lv4b0094f8';
const CLOUD_REGION = 'ap-shanghai';
const CLOUD_POLL_MS = 5000;

// 明确列出要读的列，故意不写 * —— 库里有几列（比如建库时那个邀请码）
// 没给读权限，用 select('*') 会被数据库直接拒绝。
const CLOUD_COLS = 'id,owner_id,owner_name,lat,lon,species,species_other,several,qty,area,'
  + 'poly,height,dbh,health,note,recorder,photo_count,photos,created_at,updated_at';

// 数据库还没加 poly 列时的退路。加了以后会自动用上面那份。
const CLOUD_COLS_OLD = 'id,owner_id,owner_name,lat,lon,species,species_other,several,qty,area,'
  + 'height,dbh,health,note,recorder,photo_count,photos,created_at,updated_at';

/* ---------------------------------------------------------------
   实名登记

   进站填一次「名字 + 暗号」，之后：
     · 记录归到这个名下（换设备、清缓存也找得回来）
     · 只能改删自己名下和本机还没上传的记录
     · 老师（在库里标记过）能改删任何记录

   名字是自己填的，不是手机号那种实名认证 —— 用途是"分清谁记的"，
   不是证明身份。暗号只存 md5，别人读不到。
   --------------------------------------------------------------- */
const IDENT_KEY = 'tjbpi_ident_v1';

const ident = { name: '', pin: '', teacher: false, ready: false };

function loadIdent() {
  try {
    const s = localStorage.getItem(IDENT_KEY);
    if (!s) return null;
    const o = JSON.parse(s);
    return o && o.name && o.pin ? o : null;
  } catch (e) { return null; }
}

function saveIdent(name, pin) {
  localStorage.setItem(IDENT_KEY, JSON.stringify({ name, pin }));
}

/** 向服务器核对身份。名字没登记过就当场登记，登记过就要对暗号 */
async function cloudWhoAmI(name, pin) {
  const r = await cloud.db.rpc('who_am_i', { p_name: name, p_pin: pin });
  if (r && r.error) return { ok: false, reason: 'error', msg: r.error.message };
  const d = r && r.data;
  const o = Array.isArray(d) ? d[0] : d;
  if (!o) return { ok: false, reason: 'empty' };
  return { ok: !!o.ok, reason: o.reason || '', teacher: !!o.teacher, created: !!o.created };
}

/** 这条能不能改？云端的只有自己的（或老师）能改 */
function canEdit(t) {
  if (!t) return true;            // 正在新建
  if (!t._cloud) return true;     // 还在本机
  if (ident.teacher) return true; // 老师能管所有
  return t.ownerName === ident.name;
}

/** 弹出"你是谁"，挡住后面的操作 */
function showIdentGate(msg) {
  $('ident-mask').classList.remove('hidden');
  $('ident-panel').classList.remove('hidden');
  $('id-msg').textContent = msg || '';
  $('id-name').value = ident.name || '';
  $('id-pin').value = '';
  setTimeout(() => $('id-pin').focus(), 100);
}

function hideIdentGate() {
  $('ident-mask').classList.add('hidden');
  $('ident-panel').classList.add('hidden');
}

/** 提交登记。成功返回 true */
async function submitIdent() {
  const name = $('id-name').value.trim();
  const pin = $('id-pin').value.trim();
  const msg = $('id-msg');

  if (!name) { msg.textContent = '请填名字'; return false; }
  if (pin.length < 4) { msg.textContent = '暗号至少 4 位（数字或字母都行）'; return false; }

  msg.textContent = '正在核对…';
  const r = await cloudWhoAmI(name, pin);
  if (!r.ok) {
    msg.textContent = r.reason === 'wrong_pin'
      ? '这个名字已经有人用了，暗号不对。换个暗号，或把名字改一下（比如加个姓）'
      : '没连上服务器，稍后再试';
    return false;
  }

  ident.name = name;
  ident.pin = pin;
  ident.teacher = !!r.teacher;
  ident.ready = true;
  saveIdent(name, pin);
  hideIdentGate();

  // 记录人跟着身份走，省得每棵树都填一遍
  if ($('f-recorder')) $('f-recorder').value = name;
  renderTrees();
  updateModeBar();
  toast(r.created ? `欢迎，${name}` : `欢迎回来，${name}`);
  return true;
}

const cloud = {
  enabled: false,
  app: null,
  db: null,
  me: null,          // 我的云端身份 id
  version: null,     // 上次看到的云端数据版本号
  lastMax: 0,        // 已经同步到的最大时间戳
  timer: null,
  busy: false,
};

/** 云端的一行 → 页面里用的记录 */
function rowToTree(r) {
  return {
    id: r.id,
    lat: r.lat, lon: r.lon,
    species: r.species,
    speciesOther: r.species_other || '',
    several: !!r.several,
    count: r.qty,
    area: r.area,
    poly: Array.isArray(r.poly) ? r.poly : [],
    height: r.height,
    dbh: r.dbh,
    health: r.health || '',
    note: r.note || '',
    recorder: r.recorder || '',
    photos: [],            // 照片暂不上云，各人留在自己手机里
    created: r.created_at,
    updated: r.updated_at,
    _cloud: true,
    ownerId: r.owner_id || null,
    ownerName: r.owner_name || '',
  };
}

/** 能写进数据库的字段。故意不含 id 和 created_at —— 这两列数据库不给改，
    带上它们整条更新都会被拒（实测过） */
function treeFields(t) {
  const f = {
    lat: t.lat, lon: t.lon,
    species: t.species,
    species_other: t.speciesOther || '',
    several: !!t.several,
    qty: t.count ?? null,
    area: t.area ?? null,
    poly: Array.isArray(t.poly) ? t.poly : [],
    height: t.height ?? null,
    dbh: t.dbh ?? null,
    health: t.health || '',
    note: t.note || '',
    recorder: t.recorder || '',
    photo_count: (t.photos || []).length,
    photos: [],
    updated_at: t.updated,
  };
  // 数据库还没加这一列时不发它 —— 带上不存在的列，整条写入都会失败
  if (!(cloud.cols || '').includes('poly')) delete f.poly;
  return f;
}

/** 用到的整行（含 id / created_at / 归属人） */
function treeToInsert(t) {
  // project 是建库时留下的列（早先用来存采集邀请码），现在不用了，
  // 但那一列当初建成了"必填"，不给值插不进去。所以照旧塞个空串。
  return { id: t.id, ...treeFields(t), owner_name: ident.name, project: '', created_at: t.created };
}

/** 连云端。连不上就返回 false，交给后面的模式 */
async function initCloud() {
  if (typeof window.cloudbase === 'undefined') return false;
  try {
    const app = window.cloudbase.init({ env: CLOUD_ENV, region: CLOUD_REGION });
    const auth = await app.auth.signInAnonymously();
    if (auth && auth.error) return false;

    const db = app.rdb();
    const probe = await db.from('sync_state').select('version').limit(1);
    if (probe.error) return false;

    // 数据库有没有「范围」那一列？老库没有。
    // 不做这一步的话，列清单里带上不存在的列会让整条查询失败，
    // 页面上一棵树都显示不出来。
    const probePoly = await db.from('trees').select('poly').limit(1);
    cloud.cols = probePoly.error ? CLOUD_COLS_OLD : CLOUD_COLS;
    if (probePoly.error) console.warn('数据库还没有 poly 列，先按旧结构跑（范围功能不显示）');

    cloud.app = app;
    cloud.db = db;
    cloud.enabled = true;
    cloud.version = probe.data && probe.data[0] ? probe.data[0].version : 0;

    try {
      const sess = await app.auth.getSession();
      const tok = sess && sess.data && sess.data.session ? sess.data.session.access_token : null;
      if (tok) {
        cloud.me = JSON.parse(atob(tok.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'))).sub;
      }
    } catch (e) { /* 拿不到身份也不影响记录 */ }

    await pullAll();
    migrateLocalToCloud();
    cloud.timer = setInterval(pollCloud, CLOUD_POLL_MS);
    return true;
  } catch (e) {
    console.warn('云端连不上，改用其它模式', e);
    return false;
  }
}

/** 全量拉取。分页取，避免一次要太多被服务端截断 */
async function pullAll() {
  let cursor = 0, all = [], guard = 0;
  while (guard++ < 40) {
    const r = await cloud.db.from('trees').select(cloud.cols || CLOUD_COLS)
      .gt('updated_at', cursor).order('updated_at', { ascending: true }).limit(500);
    if (r.error) { console.warn('拉取失败', r.error); break; }
    const rows = r.data || [];
    all = all.concat(rows);
    if (rows.length < 500) break;
    cursor = rows[rows.length - 1].updated_at;
  }

  const cloudIds = new Set(all.map((r) => r.id));
  // 云端已经没有的（别人删了），本地也去掉；本地独有的先留着
  const byId = new Map(state.trees.filter((t) => !t._cloud || cloudIds.has(t.id)).map((t) => [t.id, t]));
  for (const r of all) {
    const t = rowToTree(r);
    const old = byId.get(t.id);
    if (old && (old.photos || []).length) t.photos = old.photos;   // 本机拍的照片留着
    byId.set(t.id, t);
  }
  state.trees = [...byId.values()];
  cloud.lastMax = all.length ? Math.max(...all.map((r) => r.updated_at || 0)) : 0;
  saveTrees();
}

/** 每隔几秒问一下"有没有新数据"，变了才去拉 */
async function pollCloud() {
  if (!cloud.enabled || cloud.busy || document.hidden) return;
  cloud.busy = true;
  try {
    const v = await cloud.db.from('sync_state').select('version').limit(1);
    const ver = v.data && v.data[0] ? v.data[0].version : null;
    if (ver === null || ver === cloud.version) return;
    cloud.version = ver;

    // 往前多留 2 分钟，免得个别手机时钟慢漏掉记录
    const since = Math.max(0, cloud.lastMax - 120000);
    const r = await cloud.db.from('trees').select(cloud.cols || CLOUD_COLS)
      .gt('updated_at', since).order('updated_at', { ascending: true }).limit(500);
    if (r.error) return;

    for (const row of (r.data || [])) {
      const t = rowToTree(row);
      const i = state.trees.findIndex((x) => x.id === t.id);
      if (i >= 0 && (state.trees[i].photos || []).length) t.photos = state.trees[i].photos;
      if (i >= 0) state.trees[i] = t; else state.trees.push(t);
      cloud.lastMax = Math.max(cloud.lastMax, row.updated_at || 0);
    }
    saveTrees();
    renderTrees();
    const lp = $('list-panel');
    if (lp && !lp.classList.contains('hidden')) renderList();
  } catch (e) {
    /* 网络抖一下很正常，下一轮再试 */
  } finally {
    cloud.busy = false;
  }
}

/** 上传一条。返回 'ok' / 'denied'（被数据库挡住）/ 'error'（网络问题） */
async function cloudSave(t) {
  const isNew = !t._cloud;

  // 新增直接写；改动走函数，函数里核对名字和暗号。
  if (isNew) {
    const r = await cloud.db.from('trees').insert(treeToInsert(t)).select('id');
    if (!r.error) {
      const n = Array.isArray(r.data) ? r.data.length : 1;
      if (n > 0) { t._cloud = true; t.ownerName = ident.name; delete t._localOnly; return 'ok'; }
    }
    const msg = (r.error && r.error.message) || '';
    if (/row-level security|violates row-level/i.test(msg)) {
      // 正常不该走到这里。真出现了多半是数据库的写入策略还是旧版
      // （早先要求带采集邀请码），让老师跑一次 SQL 就好。
      toast('上传被拒：数据库权限还是旧版，请老师执行一次 SQL', true);
      return 'denied';
    }
    if (/duplicate key/i.test(msg)) {
      t.id = uid();
      t._cloud = false;
      return cloudSave(t);
    }
    return 'error';
  }

  // 改一条：交给数据库函数，函数里核对身份，顺便挡住"改别人的"
  const r = await cloud.db.rpc('amend_tree', {
    p_name: ident.name, p_pin: ident.pin, p_id: t.id,
    p_patch: treeFields(t),
  });
  const d = r && !r.error ? (Array.isArray(r.data) ? r.data[0] : r.data) : null;
  if (d && d.ok) { t._cloud = true; return 'ok'; }

  const reason = d ? d.reason : 'error';
  if (reason === 'not_yours') {
    t._localOnly = true;
    toast('这条不是在你名下，改不了', true);
    return 'denied';
  }
  if (reason === 'bad_ident') {
    ident.ready = false;
    toast('身份过期了，请重新登记', true);
    showIdentGate();
    return 'denied';
  }
  return 'error';
}

/** 删云端一条。走函数，函数里核对身份 */
async function cloudDelete(id) {
  const r = await cloud.db.rpc('erase_tree', {
    p_name: ident.name, p_pin: ident.pin, p_id: id,
  });
  if (r && r.error) return false;
  const d = Array.isArray(r.data) ? r.data[0] : r.data;
  if (d && d.ok) return true;
  if (d && d.reason === 'bad_ident') { ident.ready = false; showIdentGate(); }
  return false;
}

/** 把以前存在本机、还没上云的记录补传上去 */
async function migrateLocalToCloud() {
  const locals = state.trees.filter((t) => !t._cloud && !t._localOnly);
  let n = 0;
  for (const t of locals) {
    const res = await cloudSave(t);
    if (res === 'ok') n++;
  }
  if (n) { renderTrees(); toast(`已把本机 ${n} 条记录传到云端`); }
}

/* ---------------------------------------------------------------
   地图初始化
   --------------------------------------------------------------- */
async function initMap() {
  const bounds = await fetch('bounds.json').then((r) => r.json());
  const center = bounds.center;

  // zoomSnap: 0 让 fitBounds 能落在小数级别，不然只能 18 或 17，会浪费空间
  map = L.map('map', {
    center, zoom: 18, minZoom: 16, maxZoom: 20,
    zoomSnap: 0, zoomDelta: 0.5,
    zoomControl: false, attributionControl: false,
    maxBounds: [[bounds.south - 0.004, bounds.west - 0.004],
                [bounds.north + 0.004, bounds.east + 0.004]],
    maxBoundsViscosity: 0.8,
  });

  // 本地瓦片底图（完全离线可用，校园里没信号也能看）
  // minNativeZoom: 手机上屏幕窄，为了装下整个校园可能缩到 17 以下；
  // 这时把 z17 的瓦片放大显示，不会变空白（否则会露出灰底）
  L.tileLayer('tiles/{z}/{x}_{y}.jpg', {
    minZoom: 15, maxZoom: 20,
    minNativeZoom: 17, maxNativeZoom: 19,
    tileSize: 256, keepBuffer: 4,
  }).addTo(map);

  L.control.zoom({ position: 'bottomright' }).addTo(map);

  campusData = await fetch('campus.json').then((r) => r.json());

  buildBaseLayers();
  treeLayer = L.layerGroup().addTo(map);
  photoLayer = L.layerGroup().addTo(map);

  fitToCampus();          // 把视野对准校园，别让四周的校外占太多

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
  const bld = [], roads = [], sports = [], water = [], labels = [], pois = [];

  for (const ft of campusData.features) {
    const p = ft.properties, g = ft.geometry;
    if (p.kind === 'building') bld.push(ft);
    else if (p.kind === 'highway') roads.push(ft);
    else if (p.kind === 'leisure') {
      if (p.sub === 'pitch' || p.sub === 'track' || p.sub === 'bleachers') sports.push(ft);
    } else if (p.kind === 'natural' && p.sub === 'water') water.push(ft);
    else if (p.kind === 'poi') pois.push(ft);

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

  // 规划图上的点位标注（校门、独立建筑）。
  // 用单个定位点显示，比 Polygon 上的文字更灵活，也不会和楼名挤在一起。
  poiLayer = L.layerGroup();
  for (const ft of pois) {
    const [lon, lat] = ft.geometry.coordinates;
    const p = ft.properties;
    L.marker([lat, lon], {
      icon: L.divIcon({
        className: 'poi-label',
        html: `<span class="poi-dot"></span>${escapeHtml(p.name)}`,
        iconSize: [0, 0], iconAnchor: [0, 0],
      }),
      interactive: !!p.note,
    }).bindTooltip(
      p.note ? `<b>${escapeHtml(p.name)}</b><br><span style="font-size:11px;opacity:.75">${escapeHtml(p.note)}</span>` : escapeHtml(p.name),
      { sticky: true },
    ).addTo(poiLayer);
  }
  poiLayer.addTo(map);

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
    sports: sportLayer, water: waterLayer, pois: poiLayer, labels: labelLayer,
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

/** 记录的显示名：选了「其他」或「暂不确定」时，用填进去的名称 */
function speciesLabel(t) {
  const sp = speciesById(t.species);
  if (t.speciesOther && (t.species === 'unknown' || sp.isOther)) return t.speciesOther;
  return sp.name;
}

/* ---------------------------------------------------------------
   四类植物各记各的

   字段照着学校《校园植物名录》的列来：
     乔木        —— 胸径、树高、株数
     灌木或藤木  —— 株数
     草本        —— 面积
     竹类        —— 株数（丛数）

   注意单位：株、丛、平方米是三种东西，统计时分开算，
   不能加在一起（加出来的数没有意义）。
   --------------------------------------------------------------- */
const CATEGORY = {
  '乔木':       { unit: '株', spec: true,  count: true,  name: '株数',
                  short: '乔木', hint: '同一片连续的同种树可以合并记一条，填总株数' },
  '灌木或藤木': { unit: '株', spec: false, count: true,  name: '株数',
                  short: '灌木', hint: '成片的绿篱、地被可以合并记一条，填总株数' },
  '草本':       { unit: 'm²', spec: false, count: false, name: '面积（平方米）',
                  short: '草本', hint: '填这一片草本的面积，估个大概即可' },
  '竹类':       { unit: '丛', spec: false, count: true,  name: '丛数',
                  short: '竹类', hint: '按丛数记，一丛算一处' },
  // 树种还没认出来时，字段都放开，免得信息记不下
  '待定':       { unit: '株', spec: true,  count: true,  name: '株数',
                  short: '未定', hint: '同一片连续的同种植物可以合并记一条' },
};

/** 这条记录属于哪一类（跟着所选树种走） */
function categoryOf(t) {
  const sp = speciesById(t.species);
  return CATEGORY[sp.role] ? sp.role : '待定';
}

/**【该记的量】带单位显示：草本看面积，其余看株数/丛数 */
function amountText(t) {
  const cfg = CATEGORY[categoryOf(t)];
  if (!cfg.count) {
    return t.several ? '面积未测' : (t.area ? `${t.area} m²` : '面积未测');
  }
  return t.several ? '若干' : `${t.count || 1} ${cfg.unit}`;
}

/** 地图角标：短，只标"这一处有多株"或"数不清" */
function pinBadge(t) {
  const cfg = CATEGORY[categoryOf(t)];
  if (t.several) return `<div class="pin-count several">${cfg.count ? '若干' : '未测'}</div>`;
  if (cfg.count && t.count > 1) return `<div class="pin-count">${t.count}</div>`;
  return '';
}

/** 按类别合计（株、丛、m² 分开加） */
function summarize(list) {
  const sums = {}, several = {};
  for (const k of Object.keys(CATEGORY)) { sums[k] = 0; several[k] = 0; }
  for (const t of list) {
    const c = categoryOf(t);
    if (t.several) { several[c] += 1; continue; }
    sums[c] += CATEGORY[c].count ? (t.count || 1) : (t.area || 0);
  }
  return { sums, several };
}

/** 一行文字概括各类合计，只列有数据的 */
function summaryLine(list) {
  const { sums, several } = summarize(list);
  const parts = [];
  for (const k of ['乔木', '灌木或藤木', '草本', '竹类', '待定']) {
    const v = sums[k], n = several[k];
    if (!v && !n) continue;
    const cfg = CATEGORY[k];
    let s = cfg.count ? `${v} ${cfg.unit}` : `${v} m²`;
    if (n) s += ` + ${n} 处${cfg.count ? '若干' : '未测'}`;
    parts.push(`${cfg.short} ${s}`);
  }
  return parts.join(' · ');
}

function renderTrees() {
  treeLayer.clearLayers();
  photoLayer.clearLayers();

  const showPhotos = $('ly-photos').checked;

  for (const t of state.trees) {
    const sp = speciesById(t.species);
    const badge = pinBadge(t);
    const tip = `<b>${escapeHtml(speciesLabel(t))}</b> · ${escapeHtml(amountText(t))}`
      + (t.note ? `<br><span style="font-size:11px">${escapeHtml(t.note)}</span>` : '');

    // 点了标记，是记一株新的还是打开这一条？
    // 「正在选点」时应当在这个位置记一株新的 —— 两株树挨得近时（小苗紧挨大树），
    // 标记的点击范围有几十米，学生根本点不到空地。
    const onClick = (e) => {
      L.DomEvent.stopPropagation(e);
      if (state.drawingRange) { addDrawPoint(e.latlng); return; }
      if (state.choosingOnMap) {
        state.choosingOnMap = false;
        // 用实际点击的位置，不是标记中心：挨着记的时候，差这几米正好把两株分开
        const ll = e.originalEvent ? map.mouseEventToLatLng(e.originalEvent) : e.latlng;
        if (state.repickingPoint && state.draft) {
          state.repickingPoint = false;
          state.draft.lat = ll.lat;
          state.draft.lon = ll.lng;
          showSheetFrame();
          return;
        }
        openSheet(ll.lat, ll.lng, null);
        return;
      }
      openSheet(t.lat, t.lon, t.id);
    };

    // 圈过范围的先画那块地，再在中心放标记
    if (Array.isArray(t.poly) && t.poly.length >= 3) {
      const poly = L.polygon(t.poly, {
        color: sp.color, weight: 2,
        fillColor: sp.color, fillOpacity: 0.28,
        className: t.id === state.selectedId ? 'range-selected' : '',
      }).addTo(treeLayer);
      poly.bindTooltip(tip, { sticky: true });
      poly.on('click', onClick);
    }

    const pin = L.marker([t.lat, t.lon], {
      icon: L.divIcon({
        className: 'tree-pin' + (t.id === state.selectedId ? ' selected' : ''),
        html: `<div class="pin-dot" style="background:${sp.color}">
                 <span>${sp.icon}</span>
               </div>${badge}`,
        iconSize: [26, 26], iconAnchor: [13, 26],
      }),
      riseOnHover: true,
    });
    pin.bindTooltip(tip, { direction: 'top', offset: [0, -24] });
    pin.on('click', onClick);
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
  const line = summaryLine(state.trees);
  const stat = state.trees.length ? `已记 ${state.trees.length} 条 · ${line}` : '';
  if (cloud.enabled) {
    // 云端模式：网页发出去，学生用谁的网都行
    const pendingN = state.trees.filter((t) => !t._cloud && !t._localOnly).length;
    const pending = pendingN ? ` · <span style="color:#e65100">${pendingN} 条待上传</span>` : '';
    $('mode-text').innerHTML = `☁️ 云端协作中${stat ? ' · ' + stat : ''}${pending}`;
    return;
  }
  if (collab.enabled) {
    const who = collab.online > 1 ? ` · ${collab.online} 人在线` : '';
    // 局域网地址一直显示，老师任何时候都能看到该发什么给学生
    const share = serverInfo.lan
      ? ` · <span id="lan-addr" title="点一下复制，发给学生">📱 ${escapeHtml(serverInfo.lan)}</span>`
      : '';
    $('mode-text').innerHTML = `🟢 实时协作中${who}${stat ? ' · ' + stat : ''}${share}`;
    bindLanAddr();
    return;
  }
  $('mode-text').textContent = stat || '点地图上的位置，即可记录一处植物';
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
  if (state.drawingRange) { addDrawPoint(e.latlng); return; }
  if (!state.choosingOnMap) return;
  state.choosingOnMap = false;

  // 「重选位置」只是挪地方，草稿里已经填好的东西要留着
  if (state.repickingPoint && state.draft) {
    state.repickingPoint = false;
    state.draft.lat = e.latlng.lat;
    state.draft.lon = e.latlng.lng;
    showSheetFrame();
    return;
  }
  openSheet(e.latlng.lat, e.latlng.lng, null);
}

/* ---------------------------------------------------------------
   视野：把校园框进屏幕

   校园是东西长、南北窄（1003 × 695 米），屏幕大多更扁，
   所以一般是"高度"受限 —— 按高度贴满时，左右会多出一些，
   这是几何上避不开的。

   这里不用 Leaflet 的 getBoundsZoom：它把 padding 当成额外尺寸
   加到边界上，算出来会明显偏松（实测多留了约 380 米高度）。
   自己按"米/像素"反解，结果可控也能解释。
   --------------------------------------------------------------- */
function fitToCampus() {
  const ring = campusData.boundary.coordinates[0];
  const lons = ring.map((c) => c[0]);
  const lats = ring.map((c) => c[1]);
  const west = Math.min(...lons), east = Math.max(...lons);
  const south = Math.min(...lats), north = Math.max(...lats);
  const clat = (south + north) / 2;

  const el = document.getElementById('map');
  const w = el.clientWidth, h = el.clientHeight;
  if (!w || !h) return;

  // 界面占位（像素），按实测：地图区域本身已避开顶部栏，
  // 左上「图层」按钮占竖向 55px 左右；底部状态条和加号是居中的，
  // 所以只吃高度、不吃左右边缘。
  const PAD = { left: 16, right: 16, top: 55, bottom: 72 };
  const availW = Math.max(200, w - PAD.left - PAD.right);
  const availH = Math.max(200, h - PAD.top - PAD.bottom);

  // 校园的实地尺寸
  const campusW = (east - west) * 111320 * Math.cos(clat * Math.PI / 180);
  const campusH = (north - south) * 110574;

  // 两个方向各算所需的"米/像素"，取较大的那个才能保证装得下
  const mpp = Math.max(campusW / availW, campusH / availH);
  // Web Mercator 局部各向同性：m/px = 156543.03 * cos(lat) / 2^zoom
  const zoom = Math.log2(156543.03392 * Math.cos(clat * Math.PI / 180) / mpp);

  map.setView([clat, (west + east) / 2], zoom, { animate: false });
}

/* 进入"在地图上点选位置"状态。

   三维视图下 2D 地图是隐藏的，点不中 —— 先切回平面。
   否则学生点半天没反应（「记录身边的树」没定位到时会走到这里）。 */
function startPickingOnMap() {
  if ($('map3d').style.display !== 'none') setView('2d');
  state.choosingOnMap = true;
  toast('请在地图上点选这棵树的位置');
}

/* ---------------------------------------------------------------
   圈范围

   草本按面积记，竹丛、成片灌木也有个铺开的地界。只标一个点的话，
   谁也看不出那片到底铺到哪儿。所以允许在地图上点几个点围出边界，
   面积自动算好填进去。

   顶点存在记录里的 poly 字段（[[lat, lon], ...]），
   定位点用这个多边形的中心。
   --------------------------------------------------------------- */
let drawPoints = [];      // 画到一半的顶点
let drawLayer = null;     // 画到一半的图形

/** 多边形面积（平方米）。把经纬度按当地比例折成米，再用鞋带公式 */
function polyAreaM2(poly) {
  if (!Array.isArray(poly) || poly.length < 3) return 0;
  const lat0 = poly.reduce((s, p) => s + p[0], 0) / poly.length;
  const kx = 111320 * Math.cos(lat0 * Math.PI / 180);   // 这一纬度上 1 经度 ≈ 多少米
  const ky = 110574;                                    // 1 纬度 ≈ 多少米
  let a = 0;
  for (let i = 0; i < poly.length; i++) {
    const p1 = poly[i];
    const p2 = poly[(i + 1) % poly.length];
    a += (p1[1] * kx) * (p2[0] * ky) - (p2[1] * kx) * (p1[0] * ky);
  }
  return Math.abs(a / 2);
}

/** 多边形的中心，用作记录的定位点 */
function polyCenter(poly) {
  const n = poly.length || 1;
  let la = 0, lo = 0;
  for (const p of poly) { la += p[0] / n; lo += p[1] / n; }
  return [la, lo];
}

/** 把表单里现在填着的东西收进草稿。

    「圈范围」和「重选位置」都要暂时收起面板让出屏幕，回来时靠草稿恢复。
    不先把表单收起来的话，选了树种、填了数量再回来看就全没了 ——
    因为草稿一直是空的，恢复时会把表单覆盖成空。 */
function syncDraftFromForm() {
  const d = state.draft;
  if (!d) return;
  d.species = state.pickingSpecies;
  d.speciesOther = $('f-species-other').value.trim();
  d.several = state.pickingSeveral;
  d.health = state.pickingHealth;
  d.note = $('f-note').value;
  d.recorder = $('f-recorder').value.trim();
  d.photos = [...state.pendingPhotos];

  const num = (id) => {
    const v = parseFloat($(id).value);
    return isNaN(v) ? null : v;
  };
  const cnt = num('f-count');
  d.count = cnt == null ? 1 : cnt;
  d.area = num('f-area');
  d.height = num('f-height');
  d.dbh = num('f-dbh');

  const la = num('f-lat');
  const lo = num('f-lon');
  if (la != null && lo != null) { d.lat = la; d.lon = lo; }
}

function startDrawRange() {
  if ($('map3d').style.display !== 'none') setView('2d');
  syncDraftFromForm();              // 先把已填的收好，回来才不丢
  drawPoints = ((state.draft && state.draft.poly) || []).map((p) => [p[0], p[1]]);
  closeSheet(true);                 // 收起面板让出屏幕，草稿留着
  state.drawingRange = true;
  if (!drawLayer) drawLayer = L.layerGroup().addTo(map);
  $('draw-bar').classList.remove('hidden');
  redrawDraw();
  toast(drawPoints.length ? '接着点，或直接点「完成」' : '在地图上依次点几个点，围出这片植物的边界');
}

function redrawDraw() {
  if (!drawLayer) return;
  drawLayer.clearLayers();
  if (drawPoints.length) {
    if (drawPoints.length >= 3) {
      L.polygon(drawPoints, {
        color: '#1b5e20', weight: 2, fillColor: '#66bb6a', fillOpacity: 0.32,
      }).addTo(drawLayer);
    } else {
      L.polyline(drawPoints, { color: '#1b5e20', weight: 2, dashArray: '6,5' }).addTo(drawLayer);
    }
    drawPoints.forEach((p, i) => {
      L.circleMarker(p, {
        radius: i === 0 ? 7 : 5, color: '#fff', weight: 2,
        fillColor: i === 0 ? '#1b5e20' : '#2e7d32', fillOpacity: 1,
      }).addTo(drawLayer);
    });
  }

  const n = drawPoints.length;
  const a = polyAreaM2(drawPoints);
  $('draw-info').textContent = n < 3
    ? `已点 ${n} 个点（至少 3 个才能围成范围）`
    : `${n} 个点 · 约 ${a < 10000 ? a.toFixed(0) + ' 平方米' : (a / 10000).toFixed(2) + ' 公顷'}`;
  $('draw-done').disabled = n < 3;
}

function addDrawPoint(latlng) {
  drawPoints.push([latlng.lat, latlng.lng]);
  redrawDraw();
}

function endDraw() {
  state.drawingRange = false;
  $('draw-bar').classList.add('hidden');
  if (drawLayer) { map.removeLayer(drawLayer); drawLayer = null; }
  drawPoints = [];
}

function finishDrawRange() {
  if (drawPoints.length < 3) return;
  const poly = drawPoints.map((p) => [p[0], p[1]]);
  const c = polyCenter(poly);
  state.draft.poly = poly;
  state.draft.lat = c[0];
  state.draft.lon = c[1];
  // 面积按圈出来的算，但表单里还能改 —— 草木不一定铺满整个圈
  state.draft.area = Math.round(polyAreaM2(poly) * 10) / 10;
  endDraw();
  showSheetFrame();
  toast('范围记下了，面积按圈出的算好了，可以改');
}

function cancelDrawRange() {
  endDraw();
  showSheetFrame();
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
        several: false, area: null, poly: [], health: '良好', note: '',
        recorder: ident.name || localStorage.getItem(RECORDER_KEY) || '',
        photos: [], created: Date.now() };

  showSheetFrame();
}

/** 把草稿里的数量/规格回填到表单（换树种后会再调一次） */
function loadDraftValues() {
  if (!state.draft) return;
  $('f-count').value = state.draft.count || 1;
  $('f-area').value = state.draft.area ?? '';
  $('f-height').value = state.draft.height ?? '';
  $('f-dbh').value = state.draft.dbh ?? '';
}

function closeSheet(keepDraft) {
  $('sheet-mask').classList.add('hidden');
  $('sheet').classList.add('hidden');
  if (!keepDraft) {
    state.selectedId = null;
    state.draft = null;
    state.pendingPhotos = [];
  }
  renderTrees();
}

/** 按 state.draft 把面板填好并显示。
    和 openSheet 分开，是因为「圈范围」要暂时收起面板去地图上画，
    画完再按原样弹回来，不能把已经填好的内容弄丢。 */
function showSheetFrame() {
  const d = state.draft;
  if (!d) return;
  const existing = state.selectedId
    ? state.trees.find((t) => t.id === state.selectedId) : null;

  state.pendingPhotos = [...(d.photos || [])];
  state.pickingSpecies = d.species;
  state.pickingHealth = d.health || '良好';
  state.pickingSeveral = !!d.several;
  state.spSearch = '';
  if ($('f-species-search')) $('f-species-search').value = '';

  const editable = canEdit(existing);
  $('sheet-title').textContent = existing
    ? (editable ? '编辑这一处' : (existing.recorder ? `${existing.recorder} 记的（只能看）` : '别人记的（只能看）'))
    : '添加一处植物';
  // 别人的记录不给删/不给存 —— 数据库本来也会拒，先收起来免得白点
  $('btn-delete').classList.toggle('hidden', !existing || !editable);
  $('btn-save').classList.toggle('hidden', !editable);
  $('f-lat').value = d.lat.toFixed(6);
  $('f-lon').value = d.lon.toFixed(6);
  $('f-species-other').value = d.speciesOther || '';
  $('f-note').value = d.note || '';
  $('f-recorder').value = d.recorder || '';

  loadDraftValues();
  renderSpeciesGrid();
  renderHealthChips();
  renderPhotoPreview();
  renderCountUI();
  renderRangeUI();
  updateLocHint();

  $('sheet-mask').classList.remove('hidden');
  $('sheet').classList.remove('hidden');
  $('sheet').scrollTop = 0;
}

/** 显示已圈范围的情况 */
function renderRangeUI() {
  const poly = (state.draft && state.draft.poly) || [];
  const el = $('range-hint');
  if (!el) return;
  if (poly.length >= 3) {
    const a = polyAreaM2(poly);
    el.textContent = `已圈出范围：${a < 10000 ? a.toFixed(0) + ' 平方米' : (a / 10000).toFixed(2) + ' 公顷'}`
      + `（${poly.length} 个顶点）。点「圈范围」可以重画。`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
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
/* 树种网格：按植物名录分四大类，每类可折叠，带搜索 */
const SPECIES_ORDER = ['乔木', '灌木或藤木', '草本', '竹类', '待定'];

function renderSpeciesGrid() {
  const grid = $('species-grid');

  // 按固定顺序分组（名录的顺序，不靠对象键序）
  const groups = new Map();
  for (const role of SPECIES_ORDER) groups.set(role, []);
  for (const sp of state.species) {
    if (!groups.has(sp.role)) groups.set(sp.role, []);
    groups.get(sp.role).push(sp);
  }

  const q = (state.spSearch || '').trim().toLowerCase();
  let html = '';
  for (const [role, list] of groups) {
    if (!list.length) continue;
    // 搜索时忽略折叠，直接展开命中的组
    const hit = q ? list.filter((sp) => sp.name.toLowerCase().includes(q)) : list;
    if (q && !hit.length) continue;

    const isCollapsed = !q && state.spCollapsed.has(role);
    html += `<div class="sp-group-title${isCollapsed ? ' collapsed' : ''}" data-role="${escapeHtml(role)}">
      <span>${escapeHtml(role)} <span class="sp-cnt">${list.length}</span></span>
      <span class="sp-caret">▼</span></div>`;
    html += `<div class="sp-group${isCollapsed ? ' hidden' : ''}" data-group="${escapeHtml(role)}">`;
    for (const sp of hit) {
      const extra = sp.isOther ? ' sp-other' : '';
      html += `<button type="button" class="sp-item${state.pickingSpecies === sp.id ? ' active' : ''}${extra}"
                 data-sp="${sp.id}">
                 <span class="sp-icon">${sp.icon}</span>
                 <span class="sp-name">${escapeHtml(sp.name)}</span>
               </button>`;
    }
    html += `</div>`;
  }
  grid.innerHTML = html;

  grid.querySelectorAll('.sp-group-title').forEach((el) => {
    el.addEventListener('click', () => {
      const role = el.dataset.role;
      if (state.spCollapsed.has(role)) state.spCollapsed.delete(role);
      else state.spCollapsed.add(role);
      renderSpeciesGrid();
    });
  });
  grid.querySelectorAll('.sp-item').forEach((el) => {
    el.addEventListener('click', () => {
      const changed = state.pickingSpecies !== el.dataset.sp;
      state.pickingSpecies = el.dataset.sp;
      renderSpeciesGrid();
      // 换了树种就换字段（乔木才有树高胸径；草本是面积）
      if (changed) {
        const cfg = CATEGORY[speciesById(state.pickingSpecies).role] || CATEGORY['待定'];
        if (!cfg.count) state.pickingSeveral = false;   // 面积没有「若干」
        loadDraftValues();
        renderCountUI();
      }
    });
  });

  // 「其他」和「暂不确定」都要填名称
  const sp = state.species.find((s) => s.id === state.pickingSpecies);
  const needText = state.pickingSpecies === 'unknown' || (sp && sp.isOther);
  $('f-species-other').classList.toggle('hidden', !needText);
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

/* 表单跟着树种类别变：
     乔木        → 株数 + 树高 + 胸径
     灌木或藤木  → 只要株数
     草本        → 换成面积
     竹类        → 丛数
   还没选树种时全放开，免得学生还没选就看不到字段。 */
function renderCountUI() {
  const sp = speciesById(state.pickingSpecies);
  const cfg = CATEGORY[sp.role] || CATEGORY['待定'];
  const isArea = !cfg.count;          // 草本：按面积记

  $('amount-label').textContent = cfg.name;
  $('count-stepper').classList.toggle('hidden', isArea);
  $('area-row').classList.toggle('hidden', !isArea);
  $('field-spec').classList.toggle('hidden', !cfg.spec);

  const on = state.pickingSeveral;
  $('count-stepper').classList.toggle('off', on);
  $('btn-several').classList.toggle('active', on);
  // 草本不叫「若干」，叫「未测」更贴切
  $('btn-several').textContent = isArea ? '未测' : '若干';

  $('count-hint').textContent = on
    ? (isArea ? '记作「未测」—— 统计时不并进总面积'
              : '记作「若干」—— 统计时不并进具体数量')
    : cfg.hint;
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

/* 保存：只存这一类该记的字段
     （乔木存胸径/树高/株数，灌木只存株数，草本存面积，竹类存丛数） */
function saveSheet() {
  if (!state.pickingSpecies) {
    toast('请选择植物种类（不认识就选「暂不确定」）', true);
    return;
  }
  const lat = parseFloat($('f-lat').value);
  const lon = parseFloat($('f-lon').value);
  if (isNaN(lat) || isNaN(lon)) return toast('位置无效，请重新选点', true);

  // 离校园很远时提醒一下：数据存得下，但地图上看不到，
  // 很容易让人以为"记了却没显示"。手机定位偶尔会飘到很远。
  const ring = campusData && campusData.boundary && campusData.boundary.coordinates[0];
  if (ring && ring.length) {
    const clat = ring.reduce((s, c) => s + c[1], 0) / ring.length;
    const clon = ring.reduce((s, c) => s + c[0], 0) / ring.length;
    const far = distanceM({ lat, lon }, { lat: clat, lon: clon });
    if (far > 2000) {
      const km = far >= 10000 ? Math.round(far / 1000) : (far / 1000).toFixed(1);
      const goOn = confirm(
        `这个位置离校园约 ${km} 公里，在地图上找不到它。\n\n`
        + `多半是手机定位不准。可以点「重选位置」，在地图上手动点。\n\n`
        + `还是要记在这里吗？`
      );
      if (!goOn) return;
    }
  }

  const cfg = CATEGORY[speciesById(state.pickingSpecies).role] || CATEGORY['待定'];
  const height = parseFloat($('f-height').value);
  const dbh = parseFloat($('f-dbh').value);
  const area = parseFloat($('f-area').value);
  const other = $('f-species-other').value.trim();
  const recorder = $('f-recorder').value.trim();
  // 记录人是必填：后面要按人统计、要判断这条是谁记的，
  // 空着的话老师和学生自己都分不清哪条是谁的。
  if (!recorder) {
    toast('请填记录人（写你的名字或小组名）', true);
    $('f-recorder').focus();
    return;
  }
  const spPick = state.species.find((s) => s.id === state.pickingSpecies);
  const needText = state.pickingSpecies === 'unknown' || (spPick && spPick.isOther);
  if (needText && !other) {
    toast('请填写名称（选了「其他」就要写清是什么）', true);
    return;
  }
  // 草本没填面积也没标未测，存下来是个空记录，不如当场问清楚
  if (!cfg.count && !state.pickingSeveral && !(area >= 0)) {
    toast('请填面积，或点「未测」', true);
    return;
  }

  const prev = state.trees.find((t) => t.id === state.draft.id);

  const rec = {
    id: state.draft.id,
    lat, lon,
    species: state.pickingSpecies,
    speciesOther: needText ? other : '',
    several: state.pickingSeveral,
    // 株数/丛数：草本不用
    count: cfg.count ? Math.max(1, parseInt($('f-count').value, 10) || 1) : null,
    // 面积：只有草本用
    area: cfg.count ? null : (isNaN(area) ? null : area),
    // 圈出的范围（草本是主要用途，其他类别也可以用来看成片范围）
    poly: Array.isArray(state.draft.poly) ? state.draft.poly : [],
    // 树高/胸径：只有乔木用
    height: cfg.spec && !isNaN(height) ? height : null,
    dbh: cfg.spec && !isNaN(dbh) ? dbh : null,
    health: state.pickingHealth,
    note: $('f-note').value.trim(),
    recorder,
    photos: state.pendingPhotos,
    created: state.draft.created || Date.now(),
    updated: Date.now(),
    // 这个标记必须继承下来：丢了的话，改一条已上传的记录会被当成新记录再插一份
    _cloud: prev ? prev._cloud : false,
  };

  if (recorder) localStorage.setItem(RECORDER_KEY, recorder);

  const idx = state.trees.findIndex((t) => t.id === rec.id);
  if (idx >= 0) state.trees[idx] = rec;
  else state.trees.push(rec);
  const ok = saveTrees();

  if (cloud.enabled) {
    // 云端模式：先在本机显示，再传上去，别人几秒后就能看到
    toast(idx >= 0 ? '已更新' : '已记录 ✓');
    closeSheet();
    renderTrees();
    cloudSave(rec).then((res) => {
      if (res === 'ok') return;
      // 没传上去：标记成本机记录，避免让人以为别人也看得到
      const cur = state.trees.find((x) => x.id === rec.id);
      if (cur) cur._cloud = false;
      saveTrees();
      renderTrees();
      toast(res === 'denied'
        ? '这条只存在本机：服务器没接受'
        : '网络不通，先存在本机，稍后自动补传', true);
    });
    return;
  }

  if (collab.enabled) {
    // 局域网服务器模式：先在本地显示，再推给服务器
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
  const wasCloud = !!state.trees.find((t) => t.id === id)?._cloud;
  state.trees = state.trees.filter((t) => t.id !== id);
  saveTrees();
  if (cloud.enabled && wasCloud) {
    cloudDelete(id).then((okk) => {
      if (!okk) toast('云端删除失败，可能这条不是你记的', true);
    });
  } else {
    pushDelete(id);            // 局域网协作模式下让别人的地图上也消失
  }
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

/** 在 pool 里找与 rec 可能是同一处的记录，返回 {twin, dist, sizeDiffers} 或 null */
function findTwin(rec, pool) {
  let best = null, bestD = Infinity;
  for (const t of pool) {
    const d = distanceM(rec, t);
    if (d > DUP_RADIUS_M) continue;
    // 类别不同（乔木 vs 草本）就是两种东西，不算重复
    if (categoryOf(t) !== categoryOf(rec)) continue;
    // 树种不同且都不是"暂不确定"→ 大概率是紧邻的两处不同的植物，不算重复
    const compatible = t.species === rec.species
      || t.species === 'unknown' || rec.species === 'unknown';
    if (!compatible) continue;
    if (d < bestD) { bestD = d; best = t; }
  }
  return best ? { twin: best, dist: bestD, sizeDiffers: sizeDiffers(best, rec) } : null;
}

/* 同一处可能有两株不同的树（比如一株小苗挨着一株大树）。
   位置分不出来 —— 手机定位本来就差几米，所以要看"大小"：
   树高或胸径差得明显，就更可能是两株，而不是同一株测了两次。

   门槛要拉得比较开：目测树高的误差很大，8 米和 12 米完全可能是
   同一棵树被两个人各估了一次（1.5 倍）。所以要求差到 1.8 倍以上
   —— 小苗和大树那种"一眼就是两株"的程度。

   注意这只是"更像两株"的证据，不是定论：所以只用来调整默认选项，
   最终仍由人确认。 */
function sizeDiffers(a, b) {
  const cmp = (x, y, minGap, minRatio) => {
    if (typeof x !== 'number' || typeof y !== 'number' || x <= 0 || y <= 0) return false;
    const hi = Math.max(x, y), lo = Math.min(x, y);
    return hi - lo >= minGap && hi / lo >= minRatio;
  };
  return cmp(a.height, b.height, 3, 1.8)     // 树高：差 3 米以上且差 1.8 倍以上
      || cmp(a.dbh, b.dbh, 6, 1.6)           // 胸径：差 6 厘米以上且差 1.6 倍以上
      || cmp(a.area, b.area, 20, 2.0);       // 草本面积：差 20 平米且差 2 倍以上
}

/** 把 inc 的信息并进 base（同一处，取更全的信息） */
function mergeInto(base, inc) {
  const cfg = CATEGORY[categoryOf(base)];
  // 只要有一边是「若干/未测」，结果就是它（知道数的那边不会更少）
  if (base.several || inc.several) {
    base.several = true;
  } else if (cfg.count) {
    base.count = Math.max(base.count || 1, inc.count || 1);
  } else {
    base.area = Math.max(base.area || 0, inc.area || 0);
  }
  if (base.height == null) base.height = inc.height ?? null;
  if (base.dbh == null) base.dbh = inc.dbh ?? null;
  base.photos = [...new Set([...(base.photos || []), ...(inc.photos || [])])].slice(0, 3);
  if (inc.note && inc.note !== base.note) {
    base.note = base.note ? `${base.note} / ${inc.note}` : inc.note;
  }
  const names = [...new Set([base.recorder, inc.recorder].filter(Boolean))];
  if (names.length) base.recorder = names.join('+');
  // 树种名称：一边空着就补上（比如 A 只写了「其他」，B 写了具体名）
  if (!base.speciesOther && inc.speciesOther) base.speciesOther = inc.speciesOther;
  base.updated = Date.now();
}

function treeLabel(t) {
  const sp = speciesById(t.species);
  const cfg = CATEGORY[categoryOf(t)];
  const bits = [amountText(t)];
  if (t.height) bits.push(`高${t.height}m`);
  if (t.dbh) bits.push(`胸径${t.dbh}cm`);
  // 类别不同的两条记录放在一起比较时，标出类别免得看不出差别
  bits.push(cfg.short);
  return { icon: sp.icon, color: sp.color, name: speciesLabel(t), meta: bits.join(' · ') };
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

    // 种名：新表头叫「种名」，旧表头叫「树种」，两个都认
    const spName = cell(r, '种名') || cell(r, '树种');
    const sp = state.species.find((s) => s.name === spName || s.id === spName);

    // 数量：新表分「株数」「丛数」「面积(m2)」三列，旧表只有「数量」一列
    const areaRaw = cell(r, '面积(m2)') || cell(r, '面积');
    const cntRaw = cell(r, '株数') || cell(r, '丛数') || cell(r, '数量');
    const several = /若干|数不清|many/i.test(cntRaw)
                 || /未测/.test(areaRaw);
    const cnt = parseInt(cntRaw, 10);
    const area = parseFloat(areaRaw);

    out.push({
      id: cell(r, '记录ID') || uid(),
      lat, lon,
      species: sp ? sp.id : 'unknown',
      speciesOther: sp ? '' : spName,
      several,
      count: several ? 1 : (isNaN(cnt) ? 1 : Math.max(1, cnt)),
      area: isNaN(area) ? null : area,
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
    if (hit) {
      conflicts.push({ incoming: t, twin: hit.twin, dist: hit.dist,
                       sizeDiffers: hit.sizeDiffers });
      taken.add(hit.twin.id);
    } else rest.push(t);
  }

  if (!conflicts.length) {
    state.trees.push(...rest);
    saveTrees(); renderTrees(); renderList();
    toast(`已导入 ${rest.length} 条`);
    return;
  }

  // 大小差得明显时，默认「都保留」——一株小苗挨着一株大树，
  // 合并会把其中一株吃掉，而这是不可逆的。
  mergeCtx = {
    conflicts, rest,
    actions: conflicts.map((c) => (c.sizeDiffers ? 'keep' : 'merge')),
  };
  renderMergeReview();
  $('merge-mask').classList.remove('hidden');
  $('merge-panel').classList.remove('hidden');
}

let mergeCtx = null;

function renderMergeReview() {
  const { conflicts, rest, actions } = mergeCtx;
  $('merge-count').textContent = conflicts.length;
  const nSize = conflicts.filter((c) => c.sizeDiffers).length;
  $('merge-summary').textContent =
    `另有 ${rest.length} 条位置不冲突，将直接导入。` +
    `下面这些和已有记录离得很近（${DUP_RADIUS_M} 米内且树种相同），可能是同一棵树：` +
    (nSize ? `其中 ${nSize} 处大小差得明显，已默认选「都保留」——` +
             `紧挨着的一大一小通常是两株，合并会把其中一株吃掉。` : '');

  $('merge-body').innerHTML = conflicts.map((c, i) => {
    const a = treeLabel(c.twin), b = treeLabel(c.incoming);
    const side = (o, tag) => `
      <div class="cf-side">
        <div class="cf-tag">${tag}</div>
        <div class="cf-name">${o.icon} ${escapeHtml(o.name)}</div>
        <div class="cf-meta">${escapeHtml(o.meta)}</div>
      </div>`;
    return `<div class="conflict" data-i="${i}">
      <div class="cf-dist">相距 ${c.dist.toFixed(1)} 米${
        c.sizeDiffers ? ' · <span class="cf-warn">大小差得明显</span>' : ''}</div>
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
    // 株、丛、m² 单位不同，排序时按各类的量纲各自归一，避免"草本 50m²"压过"乔木 30 株"
    const rank = (t) => {
      const c = categoryOf(t);
      return CATEGORY[c].count ? (t.count || 1) : (t.area || 0) / 10;
    };
    rows.sort((a, b) => rank(b) - rank(a));
  } else {
    rows.sort((a, b) => (b.created || 0) - (a.created || 0));
  }

  const body = $('list-body');
  if (!rows.length) {
    body.innerHTML = `<div class="empty"><span class="em-icon">🌱</span>
      <p>还没有记录</p>
      <p>到校园里，点「＋ 记录身边的植物」开始</p></div>`;
    return;
  }

  body.innerHTML = rows.map((t) => {
    const sp = speciesById(t.species);
    const cfg = CATEGORY[categoryOf(t)];
    const bits = [];
    if (t.note) bits.push(t.note);
    if (t.height) bits.push(`高 ${t.height}m`);
    if (t.dbh) bits.push(`胸径 ${t.dbh}cm`);
    if (t.health && t.health !== '良好') bits.push(t.health);
    if (t.recorder) bits.push(t.recorder);
    bits.push(fmtTime(t.created));

    const thumb = t.photos && t.photos.length
      ? `<img class="tr-thumb" src="${t.photos[0]}" alt="">` : '';

    const cnum = `<span class="tr-count${t.several ? ' several' : ''}">${
      escapeHtml(amountText(t))}</span>`;

    return `<div class="tree-row" data-id="${t.id}">
      <div class="tr-icon" style="background:${sp.color}22">${sp.icon}</div>
      <div class="tr-main">
        <p class="tr-name">${escapeHtml(speciesLabel(t))}${cnum}</p>
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
  const { sums, several } = summarize(state.trees);
  const withPhoto = state.trees.filter((t) => t.photos && t.photos.length).length;
  const hasData = state.trees.length > 0;

  // 按类别分卡片：株数、丛数、面积是三种单位，分开列
  const cards = [];
  for (const k of ['乔木', '灌木或藤木', '草本', '竹类', '待定']) {
    const cfg = CATEGORY[k];
    const v = sums[k], n = several[k];
    if (!v && !n) continue;
    const val = cfg.count ? `${v}` : `${v}`;
    const unit = cfg.count ? cfg.unit : 'm²';
    cards.push(`<div class="stat-card"><span class="sc-num">${val}<span class="sc-unit">${unit}</span></span>
      <span class="sc-label">${cfg.short}${n ? `（另 ${n} 处${cfg.count ? '若干' : '未测'}）` : ''}</span></div>`);
  }
  cards.push(`<div class="stat-card"><span class="sc-num">${state.trees.length}</span>
    <span class="sc-label">记录条数</span></div>`);

  let html = `<div class="stat-cards">${cards.join('')}</div>
  <div class="stat-cards">
    <div class="stat-card"><span class="sc-num">${withPhoto}</span><span class="sc-label">带照片的记录</span></div>
    <div class="stat-card"><span class="sc-num">${
      new Set(state.trees.map(t => speciesLabel(t))).size}</span><span class="sc-label">涉及种类</span></div>
    <div class="stat-card"><span class="sc-num">${
      new Set(state.trees.map(t => t.recorder).filter(Boolean)).size}</span><span class="sc-label">参与记录人</span></div>
  </div>`;

  if (!hasData) {
    html += `<div class="empty"><span class="em-icon">📊</span>
      <p>还没有数据可统计</p><p>先去记录几处吧</p></div>`;
    $('stats-body').innerHTML = html;
    return;
  }

  // 按类别分组列明细：同一类别里的数值单位一致，才能比长短
  for (const k of ['乔木', '灌木或藤木', '草本', '竹类', '待定']) {
    const cfg = CATEGORY[k];
    const rows = state.trees.filter((t) => categoryOf(t) === k);
    if (!rows.length) continue;

    const byName = {};
    for (const t of rows) {
      const nm = speciesLabel(t);
      byName[nm] = byName[nm] || { icon: speciesById(t.species).icon, color: speciesById(t.species).color,
                                   value: 0, several: 0, records: 0 };
      if (t.several) byName[nm].several += 1;
      else byName[nm].value += cfg.count ? (t.count || 1) : (t.area || 0);
      byName[nm].records += 1;
    }
    const sorted = Object.entries(byName).sort((a, b) => b[1].value - a[1].value);
    const maxV = Math.max(1, ...sorted.map(([, v]) => v.value));
    const unit = cfg.count ? cfg.unit : 'm²';

    html += `<div class="bar-section"><h3>${cfg.short}
      <span class="bh-unit">${cfg.count ? `按${cfg.name}` : '按面积'}</span></h3>`;
    for (const [name, info] of sorted) {
      const pct = info.value ? (info.value / maxV * 100).toFixed(1) : (info.several ? 3 : 0);
      const num = info.value && info.several
        ? `${info.value} ${unit} + ${info.several} 处${cfg.count ? '若干' : '未测'}`
        : (info.several ? `${info.several} 处${cfg.count ? '若干' : '未测'}` : `${info.value} ${unit}`);
      html += `<div class="bar-row">
        <div class="bar-head"><span>${info.icon} ${escapeHtml(name)}</span>
          <span class="bh-num">${num}</span></div>
        <div class="bar-track"><div class="bar-fill"
          style="width:${pct}%;background:${info.color}"></div></div>
      </div>`;
    }
    html += `</div>`;
  }

  $('stats-body').innerHTML = html;
}

/* ---------------------------------------------------------------
   导入 / 导出
   --------------------------------------------------------------- */
/* 导出的表头照着学校《校园植物名录》的列来 ——
   这份 CSV 是要交给学校的，列名对得上才好并进总表。
   四类记的东西不同，所以要分开列（株数 / 丛数 / 面积）。 */
function exportCSV() {
  if (!state.trees.length) return toast('还没有数据可导出', true);
  const head = ['记录ID', '类别', '种名', '其他名称', '纬度', '经度',
                '株数', '丛数', '面积(m2)', '实测面积(m2)', '范围顶点数', '范围坐标',
                '树高(m)', '胸径(cm)', '生长状况', '备注', '记录人', '记录时间', '照片数'];
  const lines = [head.join(',')];

  for (const t of state.trees) {
    const k = categoryOf(t);
    const isTree = k === '乔木';
    const isBamboo = k === '竹类';
    const isHerb = k === '草本';
    const poly = Array.isArray(t.poly) ? t.poly : [];
    // 圈过范围的，把实测面积和边界坐标一并导出，别人好复核
    const drawn = poly.length >= 3 ? Math.round(polyAreaM2(poly) * 10) / 10 : '';
    const wkt = poly.length >= 3
      ? poly.map((p) => `${p[1].toFixed(6)} ${p[0].toFixed(6)}`).join('; ')
      : '';
    const row = [
      t.id, CATEGORY[k].short, speciesLabel(t), t.speciesOther || '',
      t.lat.toFixed(6), t.lon.toFixed(6),
      // 株数 / 丛数：只有对应的类别才填，「若干」写成字
      isTree || k === '灌木或藤木' || k === '待定'
        ? (t.several ? '若干' : (t.count || 1)) : '',
      isBamboo ? (t.several ? '若干' : (t.count || 1)) : '',
      isHerb ? (t.several ? '未测' : (t.area ?? '')) : '',
      drawn, poly.length >= 3 ? poly.length : '', wkt,
      isTree ? (t.height ?? '') : '',
      isTree ? (t.dbh ?? '') : '',
      t.health || '',
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
    `校园植物记录${who ? '_' + who : ''}_${exportStamp()}.csv`, 'text/csv;charset=utf-8');
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
    // 保留草稿：只是换个位置，已经填好的树种、数量、备注不能丢
    syncDraftFromForm();
    state.repickingPoint = true;
    $('sheet-mask').classList.add('hidden');
    $('sheet').classList.add('hidden');
    startPickingOnMap();
  });

  // 圈范围
  $('btn-range').addEventListener('click', startDrawRange);
  $('draw-done').addEventListener('click', finishDrawRange);
  $('draw-cancel').addEventListener('click', cancelDrawRange);
  $('draw-undo').addEventListener('click', () => { drawPoints.pop(); redrawDraw(); });

  $('f-lat').addEventListener('input', updateLocHint);
  $('f-lon').addEventListener('input', updateLocHint);

  $('f-count').addEventListener('change', (e) => {
    e.target.value = Math.max(1, parseInt(e.target.value, 10) || 1);
  });
  document.querySelectorAll('.stepper .step').forEach((el) => {
    el.addEventListener('click', () => {
      const inp = $('f-count');
      inp.value = Math.max(1, (parseInt(inp.value, 10) || 1) + Number(el.dataset.step));
      // 手动调数字就说明知道数量，自动退出「若干」
      if (state.pickingSeveral) { state.pickingSeveral = false; renderCountUI(); }
    });
  });
  // 「若干」：再点一下取消
  $('btn-several').addEventListener('click', () => {
    state.pickingSeveral = !state.pickingSeveral;
    renderCountUI();
  });

  // 树种搜索：输入即筛选，不折叠
  $('f-species-search').addEventListener('input', (e) => {
    state.spSearch = e.target.value;
    renderSpeciesGrid();
  });

  $('btn-photo').addEventListener('click', () => $('f-photo').click());
  $('f-photo').addEventListener('change', (e) => {
    addPhoto(e.target.files[0]);
    e.target.value = '';
  });

  // 底部加树：优先用 GPS
  $('fab-add').addEventListener('click', () => {
    if (window._myLatLng) {
      // 三维视图下也要先切回平面，否则定位点落在看不见的地图上
      if ($('map3d').style.display !== 'none') setView('2d');
      openSheet(window._myLatLng.lat, window._myLatLng.lng, null);
      map.setView(window._myLatLng, Math.max(map.getZoom(), 19));
    } else {
      startPickingOnMap();
      toast('正在定位…请在地图上点选位置，或稍候重试');
    }
  });

  // 登记身份
  $('btn-ident').addEventListener('click', submitIdent);
  $('id-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') submitIdent(); });

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
  // 建筑名称和规划图点位合并到一个开关，避免图层面板太挤
  $('ly-labels').addEventListener('change', (e) => {
    const on = e.target.checked;
    if (on) { labelLayer.addTo(map); poiLayer.addTo(map); }
    else { map.removeLayer(labelLayer); map.removeLayer(poiLayer); }
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

  // 依次尝试：云端 → 局域网服务器 → 纯本地
  const okCloud = await initCloud();
  if (okCloud) {
    renderTrees();
    updateModeBar();

    // 已经登记过的，直接核对一次；没登记过的，弹出来让填
    const saved = loadIdent();
    if (saved) {
      const r = await cloudWhoAmI(saved.name, saved.pin);
      if (r.ok) {
        ident.name = saved.name;
        ident.pin = saved.pin;
        ident.teacher = !!r.teacher;
        ident.ready = true;
        if ($('f-recorder') && !$('f-recorder').value) $('f-recorder').value = saved.name;
        renderTrees();
        updateModeBar();
      } else {
        localStorage.removeItem(IDENT_KEY);
        showIdentGate('之前登记的暗号对不上了，重新填一下');
      }
    } else {
      showIdentGate();
    }
  } else {
    const ok = await initCollab();
    if (!ok) updateModeBar();
  }
})();
