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
  editingItem: null,  // 正在挑选树种的条目序号（null = 没在挑）
  pickingHealth: '良好',
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
    // 老记录只有单个树种，读进来就地补成 items，后面各处只管读 items
    state.trees.forEach(normalizeRecord);
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
// 多久问一次「有没有新记录」。这个值直接决定数据库消耗：
// 每问一次都算一次数据库调用，而数据库算力正是资源点的大头
// （实测占九成）。15 秒足够及时，消耗只有 5 秒的三分之一。
const CLOUD_POLL_MS = 15000;

// 明确列出要读的列，故意不写 * —— 库里有几列（比如建库时那个邀请码）
// 没给读权限，用 select('*') 会被数据库直接拒绝。
const CLOUD_COLS = 'id,owner_id,owner_name,lat,lon,species,species_other,several,qty,area,'
  + 'poly,items,height,dbh,health,note,recorder,photo_count,photos,created_at,updated_at';

// 数据库还没加 poly 列时的退路。加了以后会自动用上面那份。
const CLOUD_COLS_OLD = 'id,owner_id,owner_name,lat,lon,species,species_other,several,qty,area,'
  + 'height,dbh,health,note,recorder,photo_count,photos,created_at,updated_at';

// 更老：连 items 也没有（这次改造之前建的库）
const CLOUD_COLS_NO_ITEMS = 'id,owner_id,owner_name,lat,lon,species,species_other,several,qty,area,'
  + 'poly,height,dbh,health,note,recorder,photo_count,photos,created_at,updated_at';

/* ---------------------------------------------------------------
   登记身份

   进站填一次「名字 + 暗号」，之后：
     · 记录归到这个名下（换设备、清缓存也找得回来）
     · 学生只能改删自己名下的记录
     · 老师能改删任何记录，还能管成员名单
     · 没登记的人 = 访客，只能看

   名字是名册里的名字，不是手机号那种实名认证 —— 用途是"分清谁记的"，
   不是证明身份。暗号只存 md5，别人读不到。
   --------------------------------------------------------------- */
const IDENT_KEY = 'tjbpi_ident_v1';

// role: 'teacher' | 'student' | 'guest'（没登记）
const ident = { name: '', pin: '', role: 'guest', ready: false };

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

/** 角色的中文说法，给界面和提示用 */
const ROLE_TEXT = { teacher: '老师', student: '学生', guest: '访客' };

/** 退出登记 —— 变回访客，只能看 */
function forgetIdent() {
  ident.name = ''; ident.pin = ''; ident.role = 'guest'; ident.ready = false;
  localStorage.removeItem(IDENT_KEY);
  updateMeButton();
  applyRoleUI();
}

/** 向服务器核对身份。不在名册里、暗号不对，都算没通过 */
async function cloudWhoAmI(name, pin) {
  const r = await cloud.db.rpc('who_am_i', { p_name: name, p_pin: pin });
  if (r && r.error) return { ok: false, reason: 'error', msg: r.error.message };
  const d = r && r.data;
  const o = Array.isArray(d) ? d[0] : d;
  if (!o) return { ok: false, reason: 'empty' };
  return {
    ok: !!o.ok,
    reason: o.reason || '',
    role: o.role || (o.teacher ? 'teacher' : 'student'),
    created: !!o.created,
  };
}

/* ---------------------------------------------------------------
   三级权限

     teacher  赵老师 —— 能改删任何记录，还能管成员名单
     student  名册里的学生 —— 能添加，能改删自己名下的
     guest    没登记的人 —— 只能看

   名册在数据库的 owners 表里，只有老师能加人。
   没在名册里的人进不来，所以「不认识的人」自然是访客。
   --------------------------------------------------------------- */

/** 这一条能不能改？访客一律只读 */
function canEdit(t) {
  if (!canWrite()) return false;    // 访客：什么都不能改，本机残留的也不行
  if (!t) return true;              // 正在新建
  if (!t._cloud) return true;       // 还在本机、没归属
  if (ident.role === 'teacher') return true;
  return t.ownerName === ident.name;
}

/** 这一条能不能删？和能不能改一致 */
function canDelete(t) {
  return canEdit(t);
}

function isTeacher() { return ident.role === 'teacher'; }

/** 取成员名单。走服务器函数，函数里先核对"你是老师"——
   owners 表本身不给公开读，不然知道网址的人就能看到全部学生姓名。 */
async function cloudListMembers() {
  const r = await cloud.db.rpc('list_members', {
    p_name: ident.name, p_pin: ident.pin,
  });
  if (r && r.error) return { ok: false, msg: r.error.message, list: [] };
  const d = Array.isArray(r.data) ? r.data[0] : r.data;
  if (!d) return { ok: false, msg: '', list: [] };
  if (!d.ok) {
    const why = d.reason === 'not_teacher' ? '只有老师能看成员名单' : '身份已失效，请重新登记';
    return { ok: false, msg: why, list: [] };
  }
  return { ok: true, list: d.list || [] };
}

/** 老师：加人 / 改角色 / 重置暗号，都走数据库函数核对身份 */
async function cloudMemberOp(op, name, extra) {
  const r = await cloud.db.rpc('manage_member', {
    p_name: ident.name, p_pin: ident.pin,
    p_op: op, p_target: name, p_arg: extra == null ? null : String(extra),
  });
  if (r && r.error) return { ok: false, msg: r.error.message };
  const d = Array.isArray(r.data) ? r.data[0] : r.data;
  return d || { ok: false, reason: 'empty' };
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
      ? '暗号不对，再试一次'
      : r.reason === 'not_member'
        ? '这个名字不在成员名单里。让赵老师先在「成员」里把你加上'
        : '没连上服务器，稍后再试';
    return false;
  }

  ident.name = name;
  ident.pin = pin;
  ident.role = r.role || 'guest';
  ident.ready = true;
  saveIdent(name, pin);
  hideIdentGate();
  updateMeButton();
  applyRoleUI();

  // 记录人跟着身份走，省得每棵树都填一遍
  if ($('f-recorder')) $('f-recorder').value = name;
  renderTrees();
  updateModeBar();
  toast(`欢迎回来，${name}（${ROLE_TEXT[ident.role] || ''}）`);
  return true;
}

/* ---------------------------------------------------------------
   界面跟着角色变

    访客看不到「＋ 记录」「成员」这些用不上的东西，
    免得点进去了才发现没权限。
   --------------------------------------------------------------- */
function updateMeButton() {
  const el = $('me-text');
  if (!el) return;
  el.textContent = ident.ready ? `${ident.name}·${ROLE_TEXT[ident.role] || ''}` : '登记';
  const b = $('btn-me');
  if (b) b.title = ident.ready
    ? `当前身份：${ident.name}（${ROLE_TEXT[ident.role]}）。点一下可以换人`
    : '登记名字和暗号';
}

function applyRoleUI() {
  const teacher = isTeacher();
  // 成员管理只有老师能进
  if ($('btn-members')) $('btn-members').classList.toggle('hidden', !teacher);
  // 访客不能记录
  const canRecord = canWrite();
  if ($('fab-add')) $('fab-add').classList.toggle('hidden', !canRecord);
}

/** 现在这个人能不能往地图里写东西 */
function canWrite() {
  if (!cloud.enabled) return true;     // 局域网/纯本地模式：没有名册这一说
  return ident.ready && (ident.role === 'student' || ident.role === 'teacher');
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
  hasItems: false,   // 数据库有没有 items 列（一处多树种）
};

/** 云端的一行 → 页面里用的记录 */
function rowToTree(r) {
  return normalizeRecord({
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
    items: Array.isArray(r.items) ? r.items : null,
    health: r.health || '',
    note: r.note || '',
    recorder: r.recorder || '',
    // 照片存的是云上的文件编号，显示时才换成访问地址
    photos: Array.isArray(r.photos) ? r.photos : [],
    created: r.created_at,
    updated: r.updated_at,
    _cloud: true,
    ownerId: r.owner_id || null,
    ownerName: r.owner_name || '',
  });
}

/** 能写进数据库的字段。故意不含 id 和 created_at —— 这两列数据库不给改，
    带上它们整条更新都会被拒（实测过） */
function treeFields(t) {
  const first = itemsOf(t)[0] || {};
  const f = {
    lat: t.lat, lon: t.lon,
    // 老列留着：第 1 条镜像一份，旧客户端和旧导出还认这些字段
    species: first.species || 'unknown',
    species_other: first.speciesOther || '',
    several: !!first.several,
    qty: first.count ?? null,
    area: first.area ?? null,
    poly: Array.isArray(t.poly) ? t.poly : [],
    height: first.height ?? null,
    dbh: first.dbh ?? null,
    items: itemsOf(t),
    health: t.health || '',
    note: t.note || '',
    recorder: t.recorder || '',
    photo_count: (t.photos || []).length,
    // 只把云上的文件编号入库；本机 dataURL 太大，留在手机里
    photos: (t.photos || []).filter((p) => !String(p).startsWith('data:')),
    updated_at: t.updated,
  };
  // 数据库还没加这一列时不发它 —— 带上不存在的列，整条写入都会失败
  if (!(cloud.cols || '').includes('poly')) delete f.poly;
  if (!(cloud.cols || '').includes('items')) delete f.items;
  return f;
}

/** 这一条能不能安全地上传？
    数据库还没有 items 列时，多种植物的记录会被压成只剩第 1 种 ——
    上传等于把数据弄丢，所以这种记录先只留本机。 */
function canUploadSafely(t) {
  if (!cloud.hasItems && itemsOf(t).length > 1) return false;
  return true;
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

    // 数据库有没有「范围」「多树种」这两列？老库没有。
    // 不做这一步的话，列清单里带上不存在的列会让整条查询失败，
    // 页面上一棵树都显示不出来。
    const probePoly = await db.from('trees').select('poly').limit(1);
    const probeItems = probePoly.error ? { error: true } : await db.from('trees').select('items').limit(1);
    cloud.cols = probePoly.error ? CLOUD_COLS_OLD
      : (probeItems.error ? CLOUD_COLS_NO_ITEMS : CLOUD_COLS);
    if (probePoly.error) console.warn('数据库还没有 poly 列，先按旧结构跑（范围功能不显示）');
    if (!probeItems.error) cloud.hasItems = true;
    else console.warn('数据库还没有 items 列：一处多树种暂存本机，跑一次 SQL 后自动生效');

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
    if (old) t.photos = mergePhotos(old.photos, t.photos);
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
      if (i >= 0) t.photos = mergePhotos(state.trees[i].photos, t.photos);
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

/** 上传一条。返回 'ok' / 'denied'（被数据库挡住）/ 'error'（网络问题）
    / 'blocked'（数据库还没支持一处多树种，暂不上传） */
async function cloudSave(t) {
  // 数据库还没有 items 列时，一条记录里的多个树种会被压成只剩第 1 种。
  // 与其把数据弄丢，不如先只留本机，等跑过 SQL 再传。
  if (!canUploadSafely(t)) return 'blocked';
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
/* ---------------------------------------------------------------
   照片

   只存「文件编号」，真正显示时才去换访问地址。
   换来的地址缓存起来反复用 —— 每次重新换地址都会变，一变浏览器
   就当新图重新下载，白白花流量。
   --------------------------------------------------------------- */
const PHOTO_URLS_KEY = 'tjbpi_photo_urls_v1';
let photoUrls = {};
try { photoUrls = JSON.parse(localStorage.getItem(PHOTO_URLS_KEY) || '{}') || {}; } catch (e) { photoUrls = {}; }

function rememberPhotoUrl(id, url) {
  if (!id || !url) return;
  photoUrls[id] = url;
  try { localStorage.setItem(PHOTO_URLS_KEY, JSON.stringify(photoUrls)); } catch (e) {}
}

/** 合并本机和云端的照片：云端的为准，本机还没传上去的补在后面 */
function mergePhotos(local, remote) {
  const out = (remote || []).filter(Boolean).slice(0, 3);
  for (const p of (local || [])) {
    if (String(p).startsWith('data:') && out.length < 3) out.push(p);
  }
  return out;
}

/** 把一条记录的 photos 变成能直接显示的地址（本机 dataURL 原样返回） */
async function photoSrcs(list) {
  const arr = list || [];
  const need = arr.filter((p) => !String(p).startsWith('data:') && !photoUrls[p]);
  if (need.length && cloud.enabled) {
    try {
      const r = await cloud.app.getTempFileURL({ fileList: need });
      for (const it of (r.fileList || [])) {
        rememberPhotoUrl(it.fileID || it.fileid, it.tempFileURL || it.download_url);
      }
    } catch (e) { /* 换不到就先不显示，下次再说 */ }
  }
  return arr.map((p) => (String(p).startsWith('data:') ? p : (photoUrls[p] || '')));
}

/** 把还没上云的照片传上去，成功后把本机 dataURL 换成文件编号 */
async function uploadTreePhotos(t) {
  if (!cloud.enabled || !cloud.app) return false;
  const list = t.photos || [];
  let changed = false;
  for (let i = 0; i < list.length; i++) {
    if (!String(list[i]).startsWith('data:')) continue;
    try {
      const blob = await (await fetch(list[i])).blob();
      const f = new File([blob], 'p.jpg', { type: 'image/jpeg' });
      const r = await cloud.app.uploadFile({ cloudPath: `photos/${t.id}/${i}.jpg`, fileContent: f });
      const fid = r.fileID || (r.data && r.data.fileID);
      if (!fid) continue;
      rememberPhotoUrl(fid, r.download_url || (r.data && r.data.download_url));
      list[i] = fid;
      changed = true;
    } catch (e) { /* 这张没传上就先留着本机副本，下次再传 */ }
  }
  if (changed) { t.photos = list; saveTrees(); }
  return changed;
}

/** 删除一条记录留在云上的照片 */
async function deleteTreePhotos(t) {
  if (!cloud.enabled || !cloud.app) return;
  const ids = (t.photos || []).filter((p) => !String(p).startsWith('data:'));
  if (!ids.length) return;
  try { await cloud.app.deleteFile({ fileList: ids }); } catch (e) {}
}

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
/** 有些照片当时没传上去（比如信号不好），开机时补传一次 */
async function retryPendingPhotos() {
  if (!cloud.enabled || !ident.ready) return;
  const need = state.trees.filter((t) => t._cloud && (t.photos || []).some((p) => String(p).startsWith('data:')));
  if (!need.length) return;
  let done = 0;
  for (const t of need) {
    if (await uploadTreePhotos(t)) { await cloudSave(t); done++; }
  }
  if (done) { renderTrees(); toast(`补传了 ${done} 条的照片`); }
}

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

  // campus.json 跟着 app.js 一起改版本号：
  // 它不经过 index.html，不加 ?v= 的话手机（尤其微信）会一直读缓存的旧底图，
  // 改了建筑名也看不见
  campusData = await fetch('campus.json?v=37').then((r) => r.json());

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
        html: `<span class="poi-text"><span class="poi-dot"></span>${escapeHtml(p.name)}</span>`,
        // iconSize 给 null：给 [0,0] 的话 Leaflet 会写成内联的 0×0，
        // 底色就只剩一小条、文字溢出在框外，看着像没有底色。
        // 给 null 它就不设宽度，容器自然跟着文字撑开。
        iconSize: null, iconAnchor: [0, 0],
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
        className: 'bld-label', html: `<span class="lbl-text">${escapeHtml(ft.properties.name)}</span>`,
        // 同上：iconSize 用 null，底色才会跟着文字撑开
        iconSize: null, iconAnchor: [0, 0],
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

/* ---------------------------------------------------------------
   一处多树种

   原来一条记录只能挂一个树种。实际上一处常常是好几种混在一起
   （树下有麦冬、旁边一丛竹），所以每条记录带一个 items 数组，
   每种植物各填各的数量／树高／胸径／面积。

   顶层的 species/count/area/... 保留成第 1 条的镜像：
   数据库老列、旧版客户端和以前导出的 CSV 都还认这些字段。
   --------------------------------------------------------------- */

const ITEM_KEYS = ['species', 'speciesOther', 'several', 'count', 'area', 'height', 'dbh'];

/** 把一条来的植物条目补成完整形状 */
function normItem(it) {
  const o = it && typeof it === 'object' ? it : {};
  return {
    species: o.species || 'unknown',
    speciesOther: o.speciesOther || '',
    several: !!o.several,
    count: o.count ?? null,
    area: o.area ?? null,
    height: o.height ?? null,
    dbh: o.dbh ?? null,
  };
}

/** 老记录（单树种）折成一条。

    注意只对「确实记了树种」的记录这么干 —— 正在新建的空记录
    species 是空的，不能凭空补出一条「暂不确定」。 */
function itemsFromLegacy(t) {
  if (!t || !t.species) return [];
  return [normItem({
    species: t.species, speciesOther: t.speciesOther, several: t.several,
    count: t.count, area: t.area, height: t.height, dbh: t.dbh,
  })];
}

/** 读一条记录里的植物。没有 items 的老数据就地补上 */
function itemsOf(t) {
  if (!t) return [];
  if (!Array.isArray(t.items) || !t.items.length) t.items = itemsFromLegacy(t);
  return t.items;
}

/** 顶层字段跟上第 1 条 —— 数据库老列和旧导出格式靠它们 */
function mirrorFirstItem(t) {
  const it = itemsOf(t)[0];
  if (!it) return t;
  for (const k of ITEM_KEYS) t[k] = it[k];
  return t;
}

/** 数据从哪来（本地/云端/导入）都先过一遍这里 */
function normalizeRecord(t) {
  if (!t || typeof t !== 'object') return t;
  t.items = itemsOf(t).map(normItem).filter((it) => it.species);
  if (!t.items.length) t.items = itemsFromLegacy(t);
  // 一条也没记的时候别留个空 species，不然会被当成"记过但没选种"
  if (!t.items.length && !t.species) t.species = null;
  return mirrorFirstItem(t);
}

function itemSpecies(it) {
  return speciesById(it && it.species);
}

/** 条目属于哪一类（跟着它的树种走） */
function itemCategory(it) {
  const sp = itemSpecies(it);
  return CATEGORY[sp.role] ? sp.role : '待定';
}

/** 条目的显示名：选了「其他」或「暂不确定」时，用填进去的名称 */
function itemLabel(it) {
  const sp = itemSpecies(it);
  if (it.speciesOther && (it.species === 'unknown' || sp.isOther)) return it.speciesOther;
  return sp.name;
}

/** 条目的【该记的量】带单位显示：草本看面积，其余看株数/丛数 */
function itemAmountText(it) {
  const cfg = CATEGORY[itemCategory(it)];
  if (!cfg.count) {
    return it.several ? '面积未测' : (it.area ? `${it.area} m²` : '面积未测');
  }
  return it.several ? '若干' : `${it.count || 1} ${cfg.unit}`;
}

/** 条目的助记串：「银杏 3 株」「麦冬 15 m²」 */
function itemText(it) {
  return `${itemLabel(it)} ${itemAmountText(it)}`;
}

/** 一条记录里都有哪些种，超过两个就缩写 */
function joinItems(t, fn) {
  const list = itemsOf(t).map(fn);
  if (list.length <= 2) return list.join(' + ');
  return `${list.slice(0, 2).join(' + ')} 等${list.length}种`;
}

/** 记录的显示名（几种就都列出来） */
function speciesLabel(t) {
  return joinItems(t, itemLabel);
}

/** 这条记录属于哪一类（混种时按第 1 条，只用来取图标颜色） */
function categoryOf(t) {
  return itemCategory(itemsOf(t)[0] || {});
}

/** 该记的量：混种时依次列出 */
function amountText(t) {
  return joinItems(t, itemAmountText);
}

/** 地图角标：短，只标"这一处有多株"或"数不清" */
function pinBadge(t) {
  const items = itemsOf(t);
  const cam = (t.photos && t.photos.length && $('ly-photos') && $('ly-photos').checked)
    ? `<div class="pin-cam">📷</div>` : '';
  if (items.length > 1) return `<div class="pin-count multi">${items.length}种</div>` + cam;
  const it = items[0] || {};
  const cfg = CATEGORY[itemCategory(it)];
  if (it.several) return `<div class="pin-count several">${cfg.count ? '若干' : '未测'}</div>` + cam;
  if (cfg.count && it.count > 1) return `<div class="pin-count">${it.count}</div>` + cam;
  return cam;
}

/** 按类别合计（株、丛、m² 分开加）。混种的每种各算各的 */
function summarize(list) {
  const sums = {}, several = {};
  for (const k of Object.keys(CATEGORY)) { sums[k] = 0; several[k] = 0; }
  for (const t of list) {
    for (const it of itemsOf(t)) {
      const c = itemCategory(it);
      if (it.several) { several[c] += 1; continue; }
      sums[c] += CATEGORY[c].count ? (it.count || 1) : (it.area || 0);
    }
  }
  return { sums, several };
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

function renderTrees() {
  treeLayer.clearLayers();
  photoLayer.clearLayers();

  const showPhotos = $('ly-photos').checked;

  for (const t of state.trees) {
    const sp = speciesById(itemsOf(t)[0] && itemsOf(t)[0].species);
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

    // 照片不在这里加载 —— 地图上可能有上百条记录，每张图都拉下来太费流量。
    // 只显示一个相机角标，真正点开这条记录时才去取图。
  }

  $('list-count').textContent = state.trees.length;
  updateModeBar();
  invalidateTrees3D();    // 数据变了，三维下次同步时重建
  syncTrees3D();          // 三维开着的话立刻同步
}

/* 底部这条只用来说「现在是什么模式、记了多少、有没有没传上去的」。
   分类明细在「统计」面板里，这里重复一遍会让它在手机上折成好几行、
   把地图挡掉一大块。 */
function updateModeBar() {
  const n = state.trees.length;
  const cnt = n ? ` · ${n} 条` : '';

  if (cloud.enabled) {
    const pendingN = state.trees.filter((t) => !t._cloud && !t._localOnly).length;
    const pending = pendingN
      ? ` · <span class="mb-warn">${pendingN} 条待上传</span>` : '';
    // 访客说明白为什么点不动，不然会以为是坏了
    const who = ident.ready
      ? ` · ${ident.name}（${ROLE_TEXT[ident.role] || ''}）`
      : ' · 访客（只能看 · 点右上角登记）';
    $('mode-text').innerHTML = `☁️ 云端协作${who}${cnt}${pending}`;
    return;
  }

  if (collab.enabled) {
    const who = collab.online > 1 ? ` · ${collab.online} 人在线` : '';
    // 局域网地址一直显示，老师任何时候都能看到该发什么给学生
    const share = serverInfo.lan
      ? ` · <span id="lan-addr" title="点一下复制，发给学生">📱 ${escapeHtml(serverInfo.lan)}</span>`
      : '';
    $('mode-text').innerHTML = `🟢 实时协作${who}${cnt}${share}`;
    bindLanAddr();
    return;
  }

  $('mode-text').textContent = n
    ? `已记 ${n} 条 · 点地图上的位置继续添加`
    : '点地图上的位置，即可记录一处植物';
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
    因为草稿一直是空的，恢复时会把表单覆盖成空。

    每种的数量/规格输入框都挂在各自的卡片上，改的是草稿里的条目本身，
    所以这里只需要收位置和备注这类整条共用的字段。 */
function syncDraftFromForm() {
  const d = state.draft;
  if (!d) return;
  d.health = state.pickingHealth;
  d.note = $('f-note').value;
  d.recorder = $('f-recorder').value.trim();
  d.photos = [...state.pendingPhotos];

  const num = (id) => {
    const v = parseFloat($(id).value);
    return isNaN(v) ? null : v;
  };
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
  // 面积按圈出来的算，但每个条目里还能改 —— 草木不一定铺满整个圈。
  // 记下这个数，之后往这一处加草本时直接带进去。
  state.draft.drawnArea = Math.round(polyAreaM2(poly) * 10) / 10;
  // 已经有草本条目的，把面积跟着更新；没填过的才算，避免盖掉手填的数
  for (const it of itemsOf(state.draft)) {
    if (CATEGORY[itemCategory(it)].count) continue;
    if (it.area == null || it.area === state.draft._lastDrawnArea) {
      it.area = state.draft.drawnArea;
    }
  }
  state.draft._lastDrawnArea = state.draft.drawnArea;
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
    ? { ...existing, items: itemsOf(existing).map((x) => ({ ...x })) }
    : { id: uid(), lat, lon, items: [], poly: [], health: '良好', note: '',
        recorder: ident.name || localStorage.getItem(RECORDER_KEY) || '',
        photos: [], created: Date.now() };

  showSheetFrame();
}

function closeSheet(keepDraft) {
  $('sheet-mask').classList.add('hidden');
  $('sheet').classList.add('hidden');
  if (!keepDraft) {
    state.selectedId = null;
    state.draft = null;
    state.pendingPhotos = [];
    state.editingItem = null;
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
  state.pickingHealth = d.health || '良好';

  const editable = canEdit(existing);
  $('sheet-title').textContent = existing
    ? (editable ? '编辑这一处' : (existing.recorder ? `${existing.recorder} 记的（只能看）` : '别人记的（只能看）'))
    : '添加一处植物';
  // 别人的记录不给删/不给存 —— 数据库本来也会拒，先收起来免得白点
  $('btn-delete').classList.toggle('hidden', !existing || !editable);
  $('btn-save').classList.toggle('hidden', !editable);
  $('btn-add-species').classList.toggle('hidden', !editable);
  $('f-lat').value = d.lat.toFixed(6);
  $('f-lon').value = d.lon.toFixed(6);
  $('f-note').value = d.note || '';
  $('f-recorder').value = d.recorder || '';

  // 不给改的记录只读展示，别让人白填半天
  $('sheet').classList.toggle('readonly', !editable);

  renderItemsUI();
  renderHealthChips();
  renderPhotoPreview();
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

/* 树种网格：按植物名录分四大类，每类可折叠，带搜索。
   只有在「添加一种植物」展开时才用得上。 */
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
      const on = state.pickingSpecies === sp.id ? ' active' : '';
      html += `<button type="button" class="sp-item${extra}${on}" data-sp="${sp.id}">
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
    el.addEventListener('click', () => pickSpecies(el.dataset.sp));
  });

  // 「其他」和「暂不确定」都要填名称
  const sp = state.species.find((s) => s.id === state.pickingSpecies);
  const needText = state.pickingSpecies === 'unknown' || (sp && sp.isOther);
  $('f-species-other').classList.toggle('hidden', !needText);
  $('btn-sp-confirm').classList.toggle('hidden', !needText);
}

/* ---------------------------------------------------------------
   「这一处有哪几种」
   --------------------------------------------------------------- */

function openSpeciesPicker() {
  state.editingItem = -1;               // -1 = 正在加一种新的
  state.pickingSpecies = null;
  state.spSearch = '';
  if ($('f-species-search')) $('f-species-search').value = '';
  if ($('f-species-other')) $('f-species-other').value = '';
  // 名称框和确认键先收起，选了「其他」那类才露出来
  $('f-species-other').classList.add('hidden');
  $('btn-sp-confirm').classList.add('hidden');
  $('sp-picker').classList.remove('hidden');
  $('btn-add-species').classList.add('hidden');
  renderSpeciesGrid();
  $('f-species-search').focus();
}

function closeSpeciesPicker() {
  state.editingItem = null;
  $('sp-picker').classList.add('hidden');
  $('btn-add-species').classList.remove('hidden');
}

/** 点了树种卡片。
    普通树种直接加；「其他」「暂不确定」得先问名称 ——
    所以这两类只记住选择、把名称框露出来，等填完点「添加这种」再加。 */
function pickSpecies(spId) {
  const sp = speciesById(spId);
  const needText = spId === 'unknown' || sp.isOther;
  state.pickingSpecies = spId;

  if (!needText) {
    // 改选了普通树种：把上一步「其他」留下的名称框和确认键收起来，
    // 免得下次打开选择器时残留
    $('f-species-other').classList.add('hidden');
    $('btn-sp-confirm').classList.add('hidden');
    if ($('f-species-other')) $('f-species-other').value = '';
    addSpeciesToDraft(spId, '');
    return;
  }
  renderSpeciesGrid();                       // 让选中的那张卡片亮起来
  $('f-species-other').classList.remove('hidden');
  $('btn-sp-confirm').classList.remove('hidden');
  $('f-species-other').focus();
}

/** 名称填好后确认添加 */
function confirmSpeciesName() {
  const spId = state.pickingSpecies;
  if (!spId) return;
  const other = ($('f-species-other').value || '').trim();
  if (!other) { toast('请写清名称', true); $('f-species-other').focus(); return; }
  addSpeciesToDraft(spId, other);
}

/** 加进草稿（同名同类的不重复加）。other 是「其他」那类填的名称 */
function addSpeciesToDraft(spId, otherText) {
  const sp = speciesById(spId);
  const needText = spId === 'unknown' || sp.isOther;
  const other = needText ? (otherText || '').trim() : '';
  if (needText && !other) {
    toast('选了「其他」或「暂不确定」就要写清名称', true);
    $('f-species-other').focus();
    return;
  }
  const items = itemsOf(state.draft);
  const same = items.findIndex((it) =>
    it.species === spId && (it.speciesOther || '') === (needText ? other : ''));
  if (same >= 0) {
    toast(`${itemLabel(items[same])} 已经在列表里了`, true);
    closeSpeciesPicker();
    renderItemsUI();
    return;
  }
  const cfg = CATEGORY[sp.role] || CATEGORY['待定'];
  items.push(normItem({
    species: spId,
    speciesOther: needText ? other : '',
    count: cfg.count ? 1 : null,
    // 圈过范围的，面积先按圈出来的填上，还能改
    area: !cfg.count ? (state.draft.drawnArea ?? null) : null,
  }));
  state.draft.items = items;
  closeSpeciesPicker();
  renderItemsUI();
}

function removeSpeciesFromDraft(i) {
  const items = itemsOf(state.draft);
  if (items.length <= 1) return toast('至少留一种', true);
  items.splice(i, 1);
  state.draft.items = items;
  renderItemsUI();
}

/** 一处有哪几种：每种一张卡片，各填各的数量/规格 */
function renderItemsUI() {
  const items = itemsOf(state.draft || {});
  const box = $('sp-list');
  const editable = !$('sheet').classList.contains('readonly');

  if (!items.length) {
    box.innerHTML = `<p class="sp-empty">还没有选种类 —— 点下面的「＋ 添加一种植物」</p>`;
    $('sp-hint').textContent = '同一处有几种就加几种，每种单独填数量。';
    return;
  }

  box.innerHTML = items.map((it, i) => {
    const sp = itemSpecies(it);
    const cfg = CATEGORY[itemCategory(it)];
    const isArea = !cfg.count;
    return `<div class="sp-card" data-i="${i}">
      <div class="spc-head">
        <span class="spc-icon" style="background:${sp.color}22">${sp.icon}</span>
        <span class="spc-name">${escapeHtml(itemLabel(it))}
          <span class="spc-role">${cfg.short}</span></span>
        ${items.length > 1 && editable
          ? `<button type="button" class="spc-del" data-act="del" title="去掉这一种">✕</button>` : ''}
      </div>
      <div class="spc-amount">
        <span class="spc-label">${cfg.name}</span>
        <div class="count-row">
          <div class="stepper${it.several ? ' off' : ''}${isArea ? ' hidden' : ''}">
            <button type="button" class="step" data-step="-1">−</button>
            <input class="f-count" type="number" min="1" max="9999"
                   value="${it.count || 1}" ${editable ? '' : 'disabled'}>
            <button type="button" class="step" data-step="1">＋</button>
          </div>
          <div class="area-row${isArea ? '' : ' hidden'}">
            <input class="f-area" type="number" step="0.5" min="0" placeholder="面积"
                   value="${it.area ?? ''}" ${editable ? '' : 'disabled'}>
            <span class="unit">m²</span>
          </div>
          <button type="button" class="chip several${it.several ? ' active' : ''}"
                  data-act="several" ${editable ? '' : 'disabled'}>${isArea ? '未测' : '若干'}</button>
        </div>
      </div>
      <div class="spc-spec row2${cfg.spec ? '' : ' hidden'}">
        <div>
          <label>树高（米）</label>
          <input class="f-height" type="number" step="0.5" min="0" placeholder="选填"
                 value="${it.height ?? ''}" ${editable ? '' : 'disabled'}>
        </div>
        <div>
          <label>胸径（厘米）</label>
          <input class="f-dbh" type="number" step="1" min="0" placeholder="选填"
                 value="${it.dbh ?? ''}" ${editable ? '' : 'disabled'}>
        </div>
      </div>
    </div>`;
  }).join('');

  box.querySelectorAll('.sp-card').forEach((card) => {
    const i = Number(card.dataset.i);
    const it = () => itemsOf(state.draft)[i];

    const numVal = (sel) => {
      const v = parseFloat(card.querySelector(sel).value);
      return isNaN(v) ? null : v;
    };

    card.querySelectorAll('.f-count, .f-area, .f-height, .f-dbh').forEach((inp) => {
      inp.addEventListener('input', () => {
        const it0 = it(); if (!it0) return;
        if (inp.classList.contains('f-count')) it0.count = Math.max(1, parseInt(inp.value, 10) || 1);
        if (inp.classList.contains('f-area')) it0.area = numVal('.f-area');
        if (inp.classList.contains('f-height')) it0.height = numVal('.f-height');
        if (inp.classList.contains('f-dbh')) it0.dbh = numVal('.f-dbh');
      });
    });

    card.querySelectorAll('.step').forEach((btn) => {
      btn.addEventListener('click', () => {
        const it0 = it(); if (!it0) return;
        const v = Math.max(1, (it0.count || 1) + Number(btn.dataset.step));
        it0.count = v;
        it0.several = false;                  // 手动调数就说明知道数量
        renderItemsUI();
      });
    });

    const severalBtn = card.querySelector('[data-act=several]');
    if (severalBtn) severalBtn.addEventListener('click', () => {
      const it0 = it(); if (!it0) return;
      it0.several = !it0.several;
      renderItemsUI();
    });

    const delBtn = card.querySelector('[data-act=del]');
    if (delBtn) delBtn.addEventListener('click', () => removeSpeciesFromDraft(i));
  });

  $('sp-hint').textContent = items.length > 1
    ? `这一处记了 ${items.length} 种，各自的数量分别填在上面。`
    : CATEGORY[itemCategory(items[0])].hint;
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

/* ---------------------------------------------------------------
   看大图
   --------------------------------------------------------------- */
const photoView = { list: [], i: 0 };

/** 打开大图。list 是能直接显示的地址数组，i 是从哪张开始 */
function openPhotoView(list, i) {
  const ok = (list || []).filter(Boolean);
  if (!ok.length) return;
  photoView.list = ok;
  photoView.i = Math.max(0, Math.min(i || 0, ok.length - 1));
  paintPhotoView();
  $('photo-view').classList.remove('hidden');
}

function paintPhotoView() {
  const v = $('photo-view');
  const n = photoView.list.length;
  $('pv-img').src = photoView.list[photoView.i];
  v.classList.toggle('single', n <= 1);
  $('pv-cap').textContent = n > 1 ? `${photoView.i + 1} / ${n}` : '';
}

function stepPhotoView(d) {
  const n = photoView.list.length;
  if (n <= 1) return;
  photoView.i = (photoView.i + d + n) % n;
  paintPhotoView();
}

function closePhotoView() {
  $('photo-view').classList.add('hidden');
  $('pv-img').src = '';      // 断开引用，别让大图一直占内存
  photoView.list = [];
}

async function renderPhotoPreview() {
  const box = $('photo-preview');
  const srcs = await photoSrcs(state.pendingPhotos);
  box.innerHTML = state.pendingPhotos.map((p, i) =>
    `<div class="photo-thumb">${
      srcs[i] ? `<img src="${srcs[i]}" alt="">` : '<span class="photo-loading">…</span>'
    }<button type="button" data-i="${i}">✕</button></div>`
  ).join('');
  // 点图看大图（点右上角的 ✕ 是删除，别混在一起）
  box.querySelectorAll('img').forEach((el, i) => {
    el.addEventListener('click', () => openPhotoView(srcs, i));
  });
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

/* 保存：这一处有哪几种就存哪几种，每种各存各的字段 */
async function saveSheet() {
  // 访客只能看。登记框只是一个盖住屏幕的浮层，万一被绕过，
  // 也会存出「没有归属」的记录（谁都没法改），所以这里再硬挡一次。
  if (!canWrite()) {
    if (cloud.enabled && !ident.ready) showIdentGate('先登记名字和暗号，才能往地图里记');
    else toast('访客只能看，不能记录', true);
    return;
  }
  const items = itemsOf(state.draft || {}).map(normItem).filter((it) => it.species);
  if (!items.length) {
    toast('请添加至少一种植物（不认识就选「暂不确定」）', true);
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

  const recorder = $('f-recorder').value.trim();
  // 记录人是必填：后面要按人统计、要判断这条是谁记的，
  // 空着的话老师和学生自己都分不清哪条是谁的。
  if (!recorder) {
    toast('请填记录人（写你的名字或小组名）', true);
    $('f-recorder').focus();
    return;
  }
  // 每种都要填够：写了「其他」要有名称，草本要有面积或标未测
  for (const it of items) {
    const sp = itemSpecies(it);
    const cfg = CATEGORY[itemCategory(it)];
    if ((it.species === 'unknown' || sp.isOther) && !(it.speciesOther || '').trim()) {
      toast('有树种还没写名称（选了「其他」或「暂不确定」）', true);
      return;
    }
    if (!cfg.count && !it.several && !(it.area >= 0)) {
      toast(`${itemLabel(it)} 还没填面积 —— 填一个数，或点「未测」`, true);
      return;
    }
  }

  const prev = state.trees.find((t) => t.id === state.draft.id);

  const rec = normalizeRecord({
    id: state.draft.id,
    lat, lon,
    items,
    // 圈出的范围（草本是主要用途，其他类别也可以用来看成片范围）
    poly: Array.isArray(state.draft.poly) ? state.draft.poly : [],
    health: state.pickingHealth,
    note: $('f-note').value.trim(),
    recorder,
    photos: state.pendingPhotos,
    created: state.draft.created || Date.now(),
    updated: Date.now(),
    // 这个标记必须继承下来：丢了的话，改一条已上传的记录会被当成新记录再插一份
    _cloud: prev ? prev._cloud : false,
  });
  // 一条记录里只有第 1 种时，顶层镜像才有意义；多种时别留个误导性的面积
  if (items.length > 1) rec.area = null;

  if (recorder) localStorage.setItem(RECORDER_KEY, recorder);

  const idx = state.trees.findIndex((t) => t.id === rec.id);
  if (idx >= 0) state.trees[idx] = rec;
  else state.trees.push(rec);
  const ok = saveTrees();

  if (cloud.enabled) {
    toast(idx >= 0 ? '已更新' : '已记录 ✓');
    closeSheet();
    // 先把照片传上去再存记录：传完别人打开就能看到。
    // 传失败的那几张会留本机副本，下次保存时自动重试。
    if ((rec.photos || []).some((p) => String(p).startsWith('data:'))) {
      toast('正在上传照片…');
      await uploadTreePhotos(rec);
    }
    renderTrees();
    cloudSave(rec).then((res) => {
      if (res === 'ok') return;
      // 没传上去：标记成本机记录，避免让人以为别人也看得到
      const cur = state.trees.find((x) => x.id === rec.id);
      if (cur) cur._cloud = false;
      saveTrees();
      renderTrees();
      toast(res === 'blocked'
        ? '这条先存本机：数据库还没支持"一处多树种"，跑一次 SQL 后会自动补传'
        : (res === 'denied'
          ? '这条只存在本机：服务器没接受'
          : '网络不通，先存在本机，稍后自动补传'), true);
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
  const target = state.trees.find((t) => t.id === state.selectedId);
  if (target && !canDelete(target)) {
    toast(ident.role === 'teacher' ? '删不了' : '这条不是在你名下，改不了', true);
    return;
  }
  if (!confirm('确定删除这条记录吗？')) return;
  const id = state.selectedId;
  const gone = state.trees.find((t) => t.id === id);
  const wasCloud = !!(gone && gone._cloud);
  state.trees = state.trees.filter((t) => t.id !== id);
  saveTrees();
  if (cloud.enabled && wasCloud) {
    cloudDelete(id).then((okk) => {
      // 记录删掉了，云上的照片也一并清掉，免得白占空间
      if (okk) deleteTreePhotos(gone);
      else toast('云端删除失败，可能这条不是你记的', true);
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

/** 两条记录有没有共同的树种（「暂不确定」算万能匹配） */
function sharesSpecies(a, b) {
  return itemsOf(a).some((x) => itemsOf(b).some((y) =>
    x.species === y.species || x.species === 'unknown' || y.species === 'unknown'));
}

/** 在 pool 里找与 rec 可能是同一处的记录，返回 {twin, dist, sizeDiffers} 或 null */
function findTwin(rec, pool) {
  let best = null, bestD = Infinity;
  for (const t of pool) {
    const d = distanceM(rec, t);
    if (d > DUP_RADIUS_M) continue;
    // 一个树种都搭不上（乔木 vs 草本、银杏 vs 圆柏）就是两处，不算重复
    if (!sharesSpecies(t, rec)) continue;
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

/** 把 inc 的信息并进 base（同一处，取更全的信息）。
    两条都可能是多树种：按种名逐个对齐，缺的补进来。 */
function mergeInto(base, inc) {
  const key = (it) => `${itemLabel(it)}|${itemCategory(it)}`;
  const baseItems = itemsOf(base);
  for (const src of itemsOf(inc)) {
    const hit = baseItems.find((x) => key(x) === key(src));
    if (!hit) { baseItems.push({ ...src }); continue; }
    const cfg = CATEGORY[itemCategory(hit)];
    // 只要有一边是「若干/未测」，结果就是它（知道数的那边不会更少）
    if (hit.several || src.several) hit.several = true;
    else if (cfg.count) hit.count = Math.max(hit.count || 1, src.count || 1);
    else hit.area = Math.max(hit.area || 0, src.area || 0);
    if (hit.height == null) hit.height = src.height ?? null;
    if (hit.dbh == null) hit.dbh = src.dbh ?? null;
  }
  base.items = baseItems;
  base.photos = [...new Set([...(base.photos || []), ...(inc.photos || [])])].slice(0, 3);
  if (inc.note && inc.note !== base.note) {
    base.note = base.note ? `${base.note} / ${inc.note}` : inc.note;
  }
  const names = [...new Set([base.recorder, inc.recorder].filter(Boolean))];
  if (names.length) base.recorder = names.join('+');
  base.updated = Date.now();
  mirrorFirstItem(base);
  return base;
}

function treeLabel(t) {
  const items = itemsOf(t);
  const sp = speciesById(items[0] && items[0].species);
  const bits = items.map(itemAmountText);
  const first = items[0] || {};
  if (first.height) bits.push(`高${first.height}m`);
  if (first.dbh) bits.push(`胸径${first.dbh}cm`);
  // 类别不同的两条记录放在一起比较时，标出类别免得看不出差别
  bits.push(CATEGORY[itemCategory(first)].short);
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
  out.forEach(normalizeRecord);
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
  // CSV 是一处几种就几行、共用一个记录ID。先按 ID 合并回一条多树种记录，
  // 不能让同一处的几行各占一条（自己导出的表再导回来必须还是原样）。
  const byRecId = new Map();
  const merged = [];
  for (const t of incoming) {
    if (!t || typeof t.lat !== 'number' || typeof t.lon !== 'number') continue;
    if (!t.id) t.id = uid();
    // 老备份只有单个树种，补成 items，后面各处只管读 items
    normalizeRecord(t);
    const group = byRecId.get(t.id);
    if (group) {
      // 同一处的另一行：把树种并进来，地名/备注取先有的那个
      for (const it of itemsOf(t)) {
        const dup = itemsOf(group).some((x) =>
          x.species === it.species && (x.speciesOther || '') === (it.speciesOther || ''));
        if (!dup) itemsOf(group).push(it);
      }
      mirrorFirstItem(group);
      continue;
    }
    byRecId.set(t.id, t);
    merged.push(t);
  }

  for (const t of merged) {
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
      const hay = itemsOf(t).map((it) => `${itemLabel(it)}${it.speciesOther || ''}`).join(' ');
      return (hay + (t.note || '') + (t.recorder || ''))
        .toLowerCase().includes(q);
    });
  }

  if (state.sort === 'species') {
    rows.sort((a, b) => speciesLabel(a).localeCompare(speciesLabel(b)));
  } else if (state.sort === 'count') {
    // 株、丛、m² 单位不同，排序时按各类的量纲各自归一，避免"草本 50m²"压过"乔木 30 株"
    const rank = (t) => itemsOf(t).reduce((s, it) => {
      const c = CATEGORY[itemCategory(it)];
      return s + (c.count ? (it.count || 1) : (it.area || 0) / 10);
    }, 0);
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
    const items = itemsOf(t);
    const sp = speciesById(items[0] && items[0].species);
    const bits = [];
    if (t.note) bits.push(t.note);
    if (t.health && t.health !== '良好') bits.push(t.health);
    if (t.recorder) bits.push(t.recorder);
    bits.push(fmtTime(t.created));

    // 同样不加载图片，只标个数量；点开这条才看图
    const thumb = t.photos && t.photos.length
      ? `<span class="tr-cam">📷 ${t.photos.length}</span>` : '';

    // 一处几种：每种一行，各带各的数量
    const cnum = items.map((it) => `<span class="tr-count${
      it.several ? ' several' : ''}">${escapeHtml(itemAmountText(it))}</span>`).join('');

    const name = items.length > 1
      ? `${items.map(itemLabel).map(escapeHtml).join(' · ')}`
      : escapeHtml(speciesLabel(t));

    return `<div class="tree-row" data-id="${t.id}">
      <div class="tr-icon" style="background:${sp.color}22">${sp.icon}</div>
      <div class="tr-main">
        <p class="tr-name">${name}${cnum}</p>
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
    // 一处多树种：按条目拆开统计，同一处里的两种各算各的
    const rows = [];
    for (const t of state.trees) {
      for (const it of itemsOf(t)) if (itemCategory(it) === k) rows.push(it);
    }
    if (!rows.length) continue;

    const byName = {};
    for (const it of rows) {
      const nm = itemLabel(it);
      const sp = itemSpecies(it);
      byName[nm] = byName[nm] || { icon: sp.icon, color: sp.color, value: 0, several: 0 };
      if (it.several) byName[nm].several += 1;
      else byName[nm].value += cfg.count ? (it.count || 1) : (it.area || 0);
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

/* 打包成 zip 用。照片本身已经是 JPEG（存之前压过了），再压一遍没意义，
   所以全部用「不压缩」方式存 —— 代码短，而且不会拖慢导出。
   标准 zip 格式：每份文件一条「本地头 + 数据」，最后接一份「中央目录」。 */
function crc32(bytes) {
  let c, table = crc32._t;
  if (!table) {
    table = crc32._t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c >>> 0;
    }
  }
  let crc = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) crc = table[(crc ^ bytes[i]) & 0xFF] ^ (crc >>> 8);
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

/** files: [{ name: 'a/b.jpg', data: Uint8Array }] → Blob（一个 zip） */
function makeZip(files) {
  const enc = new TextEncoder();
  const parts = [];          // 待拼的字节块
  const central = [];        // 中央目录条目
  let offset = 0;

  const u16 = (n) => [n & 0xFF, (n >> 8) & 0xFF];
  const u32 = (n) => [n & 0xFF, (n >> 8) & 0xFF, (n >> 16) & 0xFF, (n >>> 24) & 0xFF];

  for (const f of files) {
    const nameBytes = enc.encode(f.name);
    const crc = crc32(f.data);
    const size = f.data.length;

    // 本地文件头
    const head = [
      ...u32(0x04034b50), ...u16(20), ...u16(0x0800),   // 0x0800 = 文件名按 UTF-8
      ...u16(0), ...u16(0), ...u16(0),                   // 时间日期（不填）
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0),
    ];
    parts.push(new Uint8Array(head), nameBytes, f.data);

    central.push([
      ...u32(0x02014b50), ...u16(20), ...u16(20), ...u16(0x0800),
      ...u16(0), ...u16(0), ...u16(0),
      ...u32(crc), ...u32(size), ...u32(size),
      ...u16(nameBytes.length), ...u16(0), ...u16(0),
      ...u16(0), ...u16(0), ...u32(0), ...u32(offset),
      ...nameBytes,
    ]);
    offset += head.length + nameBytes.length + size;
  }

  const centralStart = offset;
  let centralSize = 0;
  for (const c of central) { parts.push(new Uint8Array(c)); centralSize += c.length; }

  parts.push(new Uint8Array([
    ...u32(0x06054b50), ...u16(0), ...u16(0),
    ...u16(files.length), ...u16(files.length),
    ...u32(centralSize), ...u32(centralStart), ...u16(0),
  ]));

  return new Blob(parts, { type: 'application/zip' });
}

/** 导出：记录表 + 照片文件，一起打包成 zip */
async function exportWithPhotos() {
  if (!state.trees.length) return toast('还没有数据可导出', true);
  const withPhoto = state.trees.filter((t) => t.photos && t.photos.length);
  if (!withPhoto.length) return toast('现在还没有照片可导出', true);

  const btn = $('btn-export-zip');
  const label = btn.textContent;
  btn.disabled = true;

  try {
    // 1) 先把每条记录的照片地址换成能下载的链接
    const all = [];
    for (const t of withPhoto) for (const p of t.photos) if (!all.includes(p)) all.push(p);
    let done = 0;
    for (const p of all) {
      btn.textContent = `取照片… ${++done}/${all.length}`;
      await photoSrcs([p]);
    }

    // 2) 逐张下载。文件名带记录 ID，能对回表里的行
    const files = [];
    const manifest = [];   // 清单：哪个记录对应哪几张图
    for (const t of withPhoto) {
      const names = [];
      const srcs = await photoSrcs(t.photos);
      for (let i = 0; i < srcs.length; i++) {
        if (!srcs[i]) continue;
        btn.textContent = `下载… ${files.length + 1}`;
        try {
          const blob = await (await fetch(srcs[i])).blob();
          const buf = new Uint8Array(await blob.arrayBuffer());
          const nm = `photos/${t.id}_${i + 1}.jpg`;
          files.push({ name: nm, data: buf });
          names.push(nm);
        } catch (e) { /* 这一张取不到就跳过，别整个导出失败 */ }
      }
      if (names.length) {
        const items = itemsOf(t);
        manifest.push({
          记录ID: t.id,
          种名: items.map(itemLabel).join(' · '),
          记录人: t.recorder || '',
          时间: fmtTime(t.created),
          纬度: t.lat, 经度: t.lon,
          照片: names.map((n) => n.replace('photos/', '')).join(' '),
        });
      }
    }

    if (!files.length) { toast('照片都没取到，检查一下网络', true); return; }

    // 3) 清单 + 记录表 + 照片，一起打包
    btn.textContent = '打包中…';
    const csv = manifest.map((r) => {
      const head = Object.keys(r);
      return head.map((h) => {
        const s = String(r[h]);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      }).join(',');
    });
    const csvText = '\ufeff' + [Object.keys(manifest[0]).join(','), ...csv].join('\r\n');

    const doc = {
      project: '天津滨海职业学院校园树木地图',
      exported: new Date().toISOString(),
      count: state.trees.length,
      trees: state.trees,
    };

    const zip = makeZip([
      { name: 'photos-list.csv', data: new TextEncoder().encode(csvText) },
      { name: 'records.json', data: new TextEncoder().encode(JSON.stringify(doc, null, 1)) },
      ...files,
    ]);

    const who = [...new Set(state.trees.map((t) => t.recorder).filter(Boolean))].join('+');
    downloadBlob(zip, `校园植物_含照片${who ? '_' + who : ''}_${exportStamp()}.zip`);
    toast(`已导出 ${files.length} 张照片`);
  } finally {
    btn.disabled = false;
    btn.textContent = label;
  }
}

/* 导出的表头照着学校《校园植物名录》的列来 ——
   这份 CSV 是要交给学校的，列名对得上才好并进总表。
   四类记的东西不同，所以要分开列（株数 / 丛数 / 面积）。

   一处记了几种就出几行，行首是同一个「记录ID」——
   交给学校的台账每种一行，清点的时候也还看得出是同一处。 */
function exportCSV() {
  if (!state.trees.length) return toast('还没有数据可导出', true);
  const head = ['记录ID', '类别', '种名', '其他名称', '纬度', '经度',
                '株数', '丛数', '面积(m2)', '实测面积(m2)', '范围顶点数', '范围坐标',
                '树高(m)', '胸径(cm)', '生长状况', '备注', '记录人', '记录时间', '照片数'];
  const lines = [head.join(',')];

  for (const t of state.trees) {
    const poly = Array.isArray(t.poly) ? t.poly : [];
    // 圈过范围的，把实测面积和边界坐标一并导出，别人好复核
    const drawn = poly.length >= 3 ? Math.round(polyAreaM2(poly) * 10) / 10 : '';
    const wkt = poly.length >= 3
      ? poly.map((p) => `${p[1].toFixed(6)} ${p[0].toFixed(6)}`).join('; ')
      : '';
    // 范围是整处共用的，只挂在第一行上，免得同一个圈重复好几遍
    let first = true;

    for (const it of itemsOf(t)) {
      const k = itemCategory(it);
      const cnt = it.several ? '若干' : (it.count || 1);
      const row = [
        t.id, CATEGORY[k].short, itemLabel(it), it.speciesOther || '',
        t.lat.toFixed(6), t.lon.toFixed(6),
        // 株数 / 丛数：只有对应的类别才填，「若干」写成字
        (k === '乔木' || k === '灌木或藤木' || k === '待定') ? cnt : '',
        k === '竹类' ? cnt : '',
        k === '草本' ? (it.several ? '未测' : (it.area ?? '')) : '',
        first ? drawn : '',
        first && poly.length >= 3 ? poly.length : '',
        first ? wkt : '',
        k === '乔木' ? (it.height ?? '') : '',
        k === '乔木' ? (it.dbh ?? '') : '',
        t.health || '',
        t.note || '', t.recorder || '', fmtTime(t.created), (t.photos || []).length,
      ].map((v) => {
        const s = String(v);
        return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
      });
      lines.push(row.join(','));
      first = false;
    }
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
  downloadBlob(new Blob([content], { type: mime }), name);
}

function downloadBlob(blob, name) {
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
        normalizeRecord(t);
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
  ['sheet', 'list-panel', 'stats-panel', 'help-panel', 'members-panel'].forEach((id) => $(id).classList.add('hidden'));
  ['sheet-mask', 'list-mask', 'stats-mask', 'help-mask', 'members-mask'].forEach((id) => $(id).classList.add('hidden'));
  state.selectedId = null;
}

function openPanel(name) {
  closeAllSheets();
  const map_ = { list: ['list-panel', 'list-mask'], stats: ['stats-panel', 'stats-mask'],
                 help: ['help-panel', 'help-mask'], members: ['members-panel', 'members-mask'] };
  const [panel, mask] = map_[name];
  $(panel).classList.remove('hidden');
  $(mask).classList.remove('hidden');
  if (name === 'list') renderList();
  if (name === 'stats') renderStats();
  if (name === 'members') renderMembers();
}

/* ---------------------------------------------------------------
   成员管理（只有老师能进）

   名册就是数据库的 owners 表：在里面 = 学生级，is_teacher = 老师级，
   不在里面 = 访客。加人、改角色、重置暗号都交给数据库函数核对身份，
   前端只是把这几个动作摆出来。
   --------------------------------------------------------------- */
async function renderMembers() {
  const body = $('members-body');
  if (!isTeacher()) {
    body.innerHTML = '<p class="mem-empty">只有老师能管理成员。</p>';
    return;
  }
  body.innerHTML = '<p class="mem-empty">正在读取名单…</p>';
  const r = await cloudListMembers();
  if (!r.ok) {
    body.innerHTML = `<p class="mem-empty">读不到名单：${escapeHtml(r.msg || '')}
      <br>多半是数据库还没加这一段的权限，让维护的人跑一次 SQL。</p>`;
    return;
  }
  $('members-count').textContent = r.list.length;

  // 老师排前面，其余按加入时间
  const list = [...r.list].sort((a, b) =>
    (a.role === 'teacher' ? 0 : 1) - (b.role === 'teacher' ? 0 : 1)
    || (a.created_at || 0) - (b.created_at || 0));

  body.innerHTML = list.map((m) => {
    const me = m.name === ident.name;
    const teacher = m.role === 'teacher';
    const n = state.trees.filter((t) => t.ownerName === m.name).length;
    return `<div class="mem-row" data-name="${escapeHtml(m.name)}">
      <div class="mem-main">
        <p class="mem-name">${escapeHtml(m.name)}
          <span class="mem-role${teacher ? ' teacher' : ''}">${teacher ? '老师' : '学生'}</span>
          ${me ? '<span class="mem-me">你</span>' : ''}</p>
        <p class="mem-sub">记了 ${n} 条</p>
      </div>
      <button type="button" class="mem-btn" data-act="reset">改暗号</button>
      <button type="button" class="mem-btn ${teacher ? '' : 'warn'}"
              data-act="role" data-to="${teacher ? 'student' : 'teacher'}"
              ${me ? 'disabled title="不能改自己"' : ''}>${teacher ? '降为学生' : '升为老师'}</button>
      <button type="button" class="mem-btn danger" data-act="del"
              ${me ? 'disabled title="不能删自己"' : ''}>移除</button>
    </div>`;
  }).join('');

  body.querySelectorAll('.mem-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const name = btn.closest('.mem-row').dataset.name;
      const act = btn.dataset.act;
      if (act === 'reset') {
        const pin = prompt(`给「${name}」设一个新暗号（4 位以上）：`);
        if (pin == null) return;
        if (pin.trim().length < 4) return toast('暗号至少 4 位', true);
        const res = await cloudMemberOp('set_pin', name, pin.trim());
        toast(res.ok ? `${name} 的暗号改好了，告诉他新暗号` : `没改成：${res.reason || res.msg || ''}`, !res.ok);
      } else if (act === 'role') {
        const to = btn.dataset.to;
        if (!confirm(`把「${name}」改成${to === 'teacher' ? '老师' : '学生'}？`)) return;
        const res = await cloudMemberOp('set_role', name, to);
        toast(res.ok ? '改好了' : `没改成：${res.reason || res.msg || ''}`, !res.ok);
      } else {
        if (!confirm(`把「${name}」从名单里移除？\n\n他之后会变成访客，只能看；`
          + `已经记下的数据不受影响。`)) return;
        const res = await cloudMemberOp('remove', name);
        toast(res.ok ? '已移除' : `没移除：${res.reason || res.msg || ''}`, !res.ok);
      }
      renderMembers();
      applyRoleUI();
    });
  });
}

/** 老师在面板里加一个人 */
async function addMember() {
  if (!isTeacher()) return;
  const name = $('mem-name').value.trim();
  const pin = $('mem-pin').value.trim();
  if (!name) return toast('请填姓名', true);
  if (pin.length < 4) return toast('初始暗号至少 4 位', true);
  const res = await cloudMemberOp('add', name, pin);
  if (!res.ok) {
    const why = res.reason === 'exists' ? '这个名字已经在名单里了'
      : res.reason === 'not_teacher' ? '只有老师能加人'
      : (res.msg || res.reason || '');
    return toast('没加成：' + why, true);
  }
  $('mem-name').value = '';
  $('mem-pin').value = '';
  toast(`已把 ${name} 加入名单，把暗号告诉他`);
  renderMembers();
  applyRoleUI();
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

  // 添加一种植物 / 取消
  $('btn-add-species').addEventListener('click', openSpeciesPicker);
  $('btn-sp-confirm').addEventListener('click', confirmSpeciesName);
  $('f-species-other').addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); confirmSpeciesName(); }
  });
  $('btn-sp-cancel').addEventListener('click', closeSpeciesPicker);

  // 树种搜索：输入即筛选，不折叠
  $('f-species-search').addEventListener('input', (e) => {
    state.spSearch = e.target.value;
    renderSpeciesGrid();
  });

  $('btn-photo').addEventListener('click', () => $('f-photo').click());
  $('f-photo').addEventListener('change', async (e) => {
    // 支持一次选多张（相册里挑）
    for (const f of Array.from(e.target.files || [])) await addPhoto(f);
    e.target.value = '';   // 清空，否则同一张图第二次选不触发
  });

  // 看大图
  $('pv-close').addEventListener('click', closePhotoView);
  $('pv-prev').addEventListener('click', (e) => { e.stopPropagation(); stepPhotoView(-1); });
  $('pv-next').addEventListener('click', (e) => { e.stopPropagation(); stepPhotoView(1); });
  $('photo-view').addEventListener('click', (e) => {
    // 点图以外的地方关掉；点图本身往下一张
    if (e.target.id === 'pv-img') stepPhotoView(1);
    else closePhotoView();
  });
  document.addEventListener('keydown', (e) => {
    if ($('photo-view').classList.contains('hidden')) return;
    if (e.key === 'Escape') closePhotoView();
    else if (e.key === 'ArrowLeft') stepPhotoView(-1);
    else if (e.key === 'ArrowRight') stepPhotoView(1);
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
  $('btn-members').addEventListener('click', () => openPanel('members'));
  $('members-close').addEventListener('click', closeAllSheets);
  $('members-mask').addEventListener('click', closeAllSheets);
  $('mem-add-btn').addEventListener('click', addMember);
  $('mem-pin').addEventListener('keydown', (e) => { if (e.key === 'Enter') addMember(); });

  // 换人 / 退出：点顶部那个人名
  $('btn-me').addEventListener('click', () => {
    if (!ident.ready) return showIdentGate();
    const who = `${ident.name}（${ROLE_TEXT[ident.role]}）`;
    if (confirm(`当前身份：${who}\n\n点「确定」重新登记（换个人用这台设备），`
      + `点「取消」保持不动。\n\n（重新登记后，本地还没上传的记录仍会保留）`)) {
      forgetIdent();
      showIdentGate('请填你的名字和暗号');
    }
  });

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
  $('btn-export-zip').addEventListener('click', exportWithPhotos);
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
  // 和 campus.json 同理：不加 ?v= 的话，改了名录（比如新增树种）
  // 学生手机上会一直读缓存的旧版本
  state.species = await fetch('species.json?v=37').then((r) => r.json());
  loadTrees();
  bind();
  await initMap();
  renderTrees();

  // 依次尝试：云端 → 局域网服务器 → 纯本地
  const okCloud = await initCloud();
  if (okCloud) {
    renderTrees();
    updateModeBar();

    // 已经登记过的，直接核对一次；没登记过的，就是访客
    const saved = loadIdent();
    if (saved) {
      const r = await cloudWhoAmI(saved.name, saved.pin);
      if (r.ok) {
        ident.name = saved.name;
        ident.pin = saved.pin;
        ident.role = r.role || 'guest';
        ident.ready = true;
        if ($('f-recorder') && !$('f-recorder').value) $('f-recorder').value = saved.name;
        renderTrees();
        updateModeBar();
        retryPendingPhotos();     // 有照片没传上去的，补一次
      } else {
        // 暗号变了、或者已经被移出名单 —— 按访客处理，不挡住看地图
        localStorage.removeItem(IDENT_KEY);
        toast(r.reason === 'not_member'
          ? '你不在成员名单里，现在是访客：可以看，不能记录'
          : '上次的登记失效了，点右上角的人名重新登记', true);
      }
    } else {
      // 不弹登记框：访客也能先看地图。想记录时再点右上角登记。
      toast('访客模式：可以看。想记录就点右上角「登记」');
    }
    updateMeButton();
    applyRoleUI();
  } else {
    const ok = await initCollab();
    if (!ok) updateModeBar();
    updateMeButton();
    applyRoleUI();
  }
})();
