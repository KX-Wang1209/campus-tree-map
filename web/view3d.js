/* ===================================================================
   校园树木地图 —— 三维视图

   用 MapLibre GL（WebGL）渲染。做的是"伪三维"：
   - 建筑按真实层数挤出成体块（高度来自 OSM 类型估算，已在 campus.json 里）
   - 树木用立体标记（按树高决定大小，按树种决定颜色）
   - 可旋转、可倾斜、可放大

   天津是平原（高程 -2~2 米），所以三维不表现地形，只表现建筑和树。
   =================================================================== */

const VIEW3D = {
  map: null,
  ready: false,
  lastTreeSig: null,     // 上次同步的树木数据签名，避免无谓重建
  treeSourceId: null,    // 当前树木数据源的名字
  treeLayers: {},        // 当前树木三个图层的 id
  syncTimer: null,       // 同步防抖
  checkTimer: null,      // 自检定时器
  orbiting: false,       // 是否正在自动环绕
  orbitRaf: null,        // 环绕动画的 requestAnimationFrame 句柄
  speciesFilter: null,   // 树种筛选：null = 全显示，Set = 只看这些
};

// 树木数据源的递增编号。MapLibre 对被删过的源名会记住状态，
// 同名重建不生效，所以每次换新名（详见 rebuildTreeSource）。
let treeSourceSeq = 0;

/* 瓦片源：直接用本地已下载的瓦片，离线也能用 */
const TILE_RANGES = {
  17: { x0: 108363, x1: 108368, y0: 50059, y1: 50063 },
  18: { x0: 216727, x1: 216737, y0: 100118, y1: 100126 },
  19: { x0: 433454, x1: 433474, y0: 200237, y1: 200253 },
};

/* MapLibre 的 raster 源需要给出边界，由瓦片编号反算。
   注意：MapLibre 要的是扁平数组 [西, 南, 东, 北]，
   不是 GeoJSON 那种 [[西,南],[东,北]]。写错了样式会直接加载失败。 */
function tileRangeBounds() {
  const z = 18;
  const r = TILE_RANGES[z];
  const n = 2 ** z;
  const lon = (x) => (x / n) * 360 - 180;
  const lat = (y) => {
    const t = Math.PI * (1 - (2 * y) / n);
    return (Math.atan(Math.sinh(t)) * 180) / Math.PI;
  };
  return [lon(r.x0), lat(r.y1 + 1), lon(r.x1 + 1), lat(r.y0)];
}

/**
 * 等地图样式就绪，然后才 addSource / addLayer。
 *
 * MapLibre 的坑：load 事件只触发一次，如果注册监听时已经触发过，
 * 就永远等不到回调（页面在后台时很常见）。而样式没就绪就调
 * addSource 会直接抛 "Style is not done loading"。
 * 所以这里用轮询判断状态，不依赖事件。
 */
function waitStyleReady(map3, timeoutMs = 15000) {
  if (map3.isStyleLoaded()) return Promise.resolve(true);
  return new Promise((resolve) => {
    const t0 = Date.now();
    const iv = setInterval(() => {
      if (map3.isStyleLoaded()) {
        clearInterval(iv);
        resolve(true);
      } else if (Date.now() - t0 > timeoutMs) {
        clearInterval(iv);
        resolve(false);
      }
    }, 150);
  });
}

/** 初始化三维地图（第一次切过去时才建，省内存） */
async function init3D() {
  if (VIEW3D.ready) return;

  const bounds = await fetch('bounds.json').then((r) => r.json());
  const [clat, clon] = bounds.center;

  const map3 = new maplibregl.Map({
    container: 'map3d',
    center: [clon, clat],
    zoom: 17.2,
    pitch: 55,              // 倾斜角，这个是"三维感"的关键
    bearing: -20,
    maxPitch: 70,
    attributionControl: false,
    style: {
      version: 8,
      // 不配 glyphs：本视图不用 symbol 文字图层。
      // symbol 会去拉远程字体，拉不到时会连带卡住整个数据源的渲染。
      sources: {
        // 本地卫星瓦片
        satellite: {
          type: 'raster',
          tiles: ['tiles/{z}/{x}_{y}.jpg'],
          tileSize: 256,
          minzoom: 17,
          maxzoom: 19,
          bounds: tileRangeBounds(),
        },
        // 在线兜底（本地瓦片范围之外）
        online: {
          type: 'raster',
          tiles: [
            'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
          ],
          tileSize: 256,
          maxzoom: 19,
        },
      },
      layers: [
        { id: 'bg', type: 'background', paint: { 'background-color': '#dfe6da' } },
        { id: 'online', type: 'raster', source: 'online',
          paint: { 'raster-opacity': 1 } },
        { id: 'satellite', type: 'raster', source: 'satellite',
          paint: { 'raster-opacity': 1 } },
      ],
    },
  });

  await waitStyleReady(map3);


  addCampus3D(map3);
  VIEW3D.map = map3;
  VIEW3D.ready = true;
}

/** 把校园数据加成三维图层 */
function addCampus3D(map3) {
  const feats = campusData.features;

  // ---- 建筑体块（挤出） ----
  const buildings = feats.filter((f) => f.properties.kind === 'building');
  map3.addSource('bld', {
    type: 'geojson',
    data: {
      type: 'FeatureCollection',
      features: buildings.map((f) => ({
        type: 'Feature',
        geometry: f.geometry,
        properties: {
          h: f.properties.height_m || 12,
          name: f.properties.name || '建筑',
          basis: f.properties.height_basis || '',
          levels: f.properties.levels || 0,
        },
      })),
    },
  });

  // 建筑本体
  map3.addLayer({
    id: 'bld-3d',
    type: 'fill-extrusion',
    source: 'bld',
    paint: {
      'fill-extrusion-color': '#e8b98a',
      'fill-extrusion-height': ['get', 'h'],
      'fill-extrusion-base': 0,
      'fill-extrusion-opacity': 0.88,
    },
  });

  // 建筑顶面轮廓，让体块边界更清楚
  map3.addLayer({
    id: 'bld-line',
    type: 'line',
    source: 'bld',
    paint: { 'line-color': '#b06a1f', 'line-width': 1, 'line-opacity': 0.55 },
  });

  // ---- 道路 / 场地 / 水体（贴地） ----
  const roads = feats.filter((f) => f.properties.kind === 'highway');
  if (roads.length) {
    map3.addSource('roads', { type: 'geojson', data: { type: 'FeatureCollection', features: roads } });
    map3.addLayer({
      id: 'roads', type: 'line', source: 'roads',
      paint: { 'line-color': '#8d6e63', 'line-width': 1.6, 'line-opacity': 0.5 },
    });
  }

  const sports = feats.filter((f) => f.properties.kind === 'leisure');
  if (sports.length) {
    map3.addSource('sports', { type: 'geojson', data: { type: 'FeatureCollection', features: sports } });
    map3.addLayer({
      id: 'sports', type: 'line', source: 'sports',
      paint: { 'line-color': '#1e88e5', 'line-width': 1.4, 'line-opacity': 0.75 },
    });
  }

  const water = feats.filter((f) => f.properties.kind === 'natural');
  if (water.length) {
    map3.addSource('water', { type: 'geojson', data: { type: 'FeatureCollection', features: water } });
    map3.addLayer({
      id: 'water', type: 'fill', source: 'water',
      paint: { 'fill-color': '#29b6f6', 'fill-opacity': 0.35 },
    });
  }

  // ---- 校园边界 ----
  map3.addSource('boundary', { type: 'geojson', data: campusData.boundary });
  map3.addLayer({
    id: 'boundary', type: 'line', source: 'boundary',
    paint: { 'line-color': '#00e5ff', 'line-width': 2.5, 'line-opacity': 0.9 },
  });

  // ---- 建筑名称 / 点位标注 ----
  // 用 DOM 标记，不用 symbol 文字图层：symbol 需要联网取字体，
  // 取不到时会把整个数据源的渲染一起卡住（详见 rebuildTreeSource 的注释）。
  buildLabelMarkers(map3);

  // ---- 树木 ----
  // 注意：不要在这里建树源。实测发现，在 map 的 load 事件同一批次里
  // addSource + addLayer，那个源会永久不参与渲染（数据和图层都正常，
  // 但 queryRenderedFeatures 恒为 0）。等 load 完之后再建才可靠。
  // 所以树源交给 setView 里的 syncTrees3D() 建。

  // 建筑点击显示高度来源
  map3.on('click', 'bld-3d', (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties;
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div style="font-family:inherit">
           <div style="font-weight:650;font-size:14px">${escapeHtml(p.name)}</div>
           <div style="font-size:12px;color:#5a6b55;margin-top:3px">
             约 ${p.h} 米${p.levels ? `（${p.levels} 层）` : ''}<br>
             <span style="opacity:.75">${escapeHtml(p.basis)}</span>
           </div>
         </div>`
      )
      .addTo(map3);
  });
}

/**
 * 数据变化时更新树木图层。
 *
 * 排查记录（走了不少弯路，记下来）：
 *   真正会让树木图层失效的是【删源】。MapLibre 对被删过的源有记忆，
 *   删过一次之后，同一地图实例上后续建的树源都可能不再渲染
 *   ——数据、图层、可见性全对，queryRenderedFeatures 恒为 0。
 *   setData 本身是安全的（实测正常）。
 *
 * 所以规矩很简单：树源只建一次，之后一律用 setData 更新，永不删源。
 */
function rebuildTreeSource(map3) {
  const sid = VIEW3D.treeSourceId;
  const src = sid ? map3.getSource(sid) : null;

  if (src && src.setData) {
    src.setData(buildTreeFeatureCollection());
    scheduleTreeCheck(map3);
    return;
  }

  // 源不存在（第一次），建一次，并记下这次的数据签名
  const seq = ++treeSourceSeq;
  const newId = `treelayer_${Date.now().toString(36)}_${seq}`;
  map3.addSource(newId, { type: 'geojson', data: buildTreeFeatureCollection() });
  VIEW3D.treeSourceId = newId;
  addTreeLayers(map3, newId, seq);
  // 记下签名，避免紧接着又被 setData 一次
  VIEW3D.lastTreeSig = JSON.stringify(buildTreeFeatureCollection());

  scheduleTreeCheck(map3);
}

/**
 * 建完树图层后自检一次：确认它真的渲染出来了。
 *
 * 为什么需要这个：MapLibre 在初始化流程中建的数据源偶发不参与渲染
 * （数据和图层配置都正常，但画面上没有）。实测同样的代码绝大多数时候正常，
 * 偶尔不生效，属于时序问题。与其赌它，不如建完检查一次，
 * 真没渲染出来就用全新的名字重建。
 *
 * 判断"该不该有树"要先确认树在视野内 —— queryRenderedFeatures 只统计
 * 屏幕内的要素，视野外查不到是正常的，不能当成失败。
 */
function scheduleTreeCheck(map3, attempt = 0) {
  if (attempt > 2) return;                 // 最多自愈两次，避免死循环
  clearTimeout(VIEW3D.checkTimer);
  VIEW3D.checkTimer = setTimeout(() => {
    if (!VIEW3D.ready || !VIEW3D.map) return;
    if (!state.trees.length) return;

    const L = VIEW3D.treeLayers;
    if (!L.canopy || !map3.getLayer(L.canopy)) return;

    // 树在视野内吗？不在就无从判断，直接跳过
    const cv = map3.getCanvas();
    const dpr = window.devicePixelRatio || 1;
    const visible = state.trees.some((t) => {
      const p = map3.project([t.lon, t.lat]);
      const x = p.x / dpr, y = p.y / dpr;
      return x > -30 && x < cv.clientWidth + 30 && y > -30 && y < cv.clientHeight + 30;
    });
    if (!visible) return;

    let n = 0;
    try {
      n = map3.queryRenderedFeatures([[0, 0], [cv.clientWidth, cv.clientHeight]])
        .filter((f) => f.layer.id === L.canopy).length;
    } catch (e) { return; }

    if (n === 0) {
      // 没渲染出来，用全新名字重建
      map3 = VIEW3D.map;
      const seq = ++treeSourceSeq;
      const newId = `treelayer_${Date.now().toString(36)}_${seq}`;
      const oldLayers = VIEW3D.treeLayers || {};
      const oldSource = VIEW3D.treeSourceId;

      map3.addSource(newId, { type: 'geojson', data: buildTreeFeatureCollection() });
      VIEW3D.treeSourceId = newId;
      addTreeLayers(map3, newId, seq);

      // 删掉旧的（先建后删，避免中间空窗）
      ['count', 'canopy', 'shadow'].forEach((k) => {
        const id = oldLayers[k];
        if (id && map3.getLayer(id)) { try { map3.removeLayer(id); } catch (e) {} }
      });
      if (oldSource && oldSource !== newId && map3.getSource(oldSource)) {
        try { map3.removeSource(oldSource); } catch (e) {}
      }

      scheduleTreeCheck(map3, attempt + 1);
    }
  }, 900);
}

/**
 * 重建后校验一次：如果源没渲染出来，等一会重试。最多 2 次，避免死循环。
 */
function verifyTreeRender(map3, attempt = 0) {
  // 故意留空：MapLibre 对被删过的源有记忆，删了再建反而更不可靠，
  // 所以不做自动重试。现在每次都用全新源名，一次到位。
}

/** 三维视图里控制对应图层的显隐 */
function set3DLayerVisible(switchId, on) {
  const map3 = VIEW3D.map;
  if (!map3 || !VIEW3D.ready) return;
  const L = VIEW3D.treeLayers || {};
  const pairs = {
    'ly-buildings': ['bld-3d', 'bld-line'],
    'ly-roads': ['roads'],
    'ly-sports': ['sports'],
    'ly-water': ['water'],
    'ly-boundary': ['boundary'],
    'ly-trees': [L.area, L.canopy, L.count, L.shadow].filter(Boolean),
  };
  for (const lid of pairs[switchId] || []) {
    if (map3.getLayer(lid)) {
      map3.setLayoutProperty(lid, 'visibility', on ? 'visible' : 'none');
    }
  }
  // 名称标记是 DOM 元素，走不到图层的显隐逻辑，单独处理
  if (switchId === 'ly-labels') {
    for (const mk of VIEW3D.labelMarkers || []) {
      mk.getElement().style.display = on ? '' : 'none';
    }
  }
}

/**
 * 建筑名称和点位标注（三维视图）。
 *
 * 用 DOM 标记而不是 symbol 文字图层：symbol 要联网加载字体，
 * 字体取不到时会把整个数据源的渲染一起卡住（这个坑踩过，很费时间）。
 * DOM 标记不依赖字体服务，还能直接复用网页的 CSS。
 */
function buildLabelMarkers(map3) {
  if (VIEW3D.labelMarkers && VIEW3D.labelMarkers.length) return;
  const markers = [];

  const add = (lon, lat, cls, text, tip) => {
    const el = document.createElement('div');
    el.className = cls;
    if (cls === 'poi-label') el.innerHTML = `<span class="poi-dot"></span>${escapeHtml(text)}`;
    else el.textContent = text;
    if (tip) el.title = tip;
    const mk = new maplibregl.Marker({ element: el, anchor: 'center' })
      .setLngLat([lon, lat])
      .addTo(map3);
    markers.push(mk);
  };

  // 建筑名（放在轮廓中心）
  for (const f of campusData.features) {
    const p = f.properties;
    if (p.kind !== 'building' || !p.name) continue;
    const [lon, lat] = polygonCenter(f.geometry);
    if (!lon) continue;
    const h = p.height_m ? `约 ${p.height_m} 米` : '';
    add(lon, lat, 'bld-label-3d', p.name.replace('学生公寓', '公寓'), h);
    // 名称连带高度一起浮在楼上方，用 marker 的 offset 抬高
    markers[markers.length - 1].setOffset([0, -34]);
  }

  // 规划图点位（校门等）
  for (const f of campusData.features) {
    const p = f.properties;
    if (p.kind !== 'poi') continue;
    const [lon, lat] = f.geometry.coordinates;
    add(lon, lat, 'poi-label', p.name, p.note || '');
  }

  VIEW3D.labelMarkers = markers;
  const on = $('ly-labels') ? $('ly-labels').checked : true;
  if (!on) markers.forEach((mk) => { mk.getElement().style.display = 'none'; });
}

/** 取多边形几何的中心点（经纬度） */
function polygonCenter(geom) {
  let pts = null;
  if (geom.type === 'Polygon') pts = geom.coordinates[0];
  else if (geom.type === 'MultiPolygon') pts = geom.coordinates[0][0];
  if (!pts || !pts.length) return [null, null];
  let x = 0, y = 0;
  for (const c of pts) { x += c[0]; y += c[1]; }
  return [x / pts.length, y / pts.length];
}

/** 把当前树木数据转成 GeoJSON（三维视图用） */
function buildTreeFeatureCollection() {
  const feats = [];
  for (const t of state.trees) {
    const sp = speciesById(t.species);
    const cfg = CATEGORY[categoryOf(t)];
    // 有实测树高就用，没有就按默认，让体量感更真实
    const h = t.height || 6;
    // 大灌木、竹丛比乔木矮，尺寸上区分一下，不然三维里全一样高
    const hEff = cfg.spec ? h : (sp.role === '竹类' ? 5 : 2.2);
    const base = {
      id: t.id,
      name: speciesLabel(t),
      rawSpecies: t.species,
      speciesOther: t.speciesOther || '',
      color: sp.color,
      count: t.several ? 0 : (cfg.count ? (t.count || 1) : 0),
      several: !!t.several,
      amount: amountText(t),
      category: cfg.short,
      note: t.note || '',
      height: t.height || null,
      dbh: t.dbh || null,
      recorder: t.recorder || '',
      dim: false,
    };

    // 圈过范围的，画一块地
    if (Array.isArray(t.poly) && t.poly.length >= 3) {
      feats.push({
        type: 'Feature',
        geometry: {
          type: 'Polygon',
          coordinates: [[...t.poly.map((p) => [p[1], p[0]]), [t.poly[0][1], t.poly[0][0]]]],
        },
        properties: { ...base, kind: 'area' },
      });
    }

    feats.push({
      type: 'Feature',
      geometry: { type: 'Point', coordinates: [t.lon, t.lat] },
      properties: {
        ...base,
        kind: 'pin',
        r: Math.max(3, Math.min(9, hEff * 0.55)),   // 树冠半径随体量变
      },
    });
  }
  return { type: 'FeatureCollection', features: feats };
}

/**
 * 把当前树木数据同步到三维视图。
 * 树源只建一次，之后用 setData 更新（原因见 rebuildTreeSource）。
 */
function syncTrees3D() {
  const map3 = VIEW3D.map;
  if (!map3 || !VIEW3D.ready) return;

  const sig = JSON.stringify(buildTreeFeatureCollection());
  if (sig === VIEW3D.lastTreeSig) return;    // 数据没变，什么都不做
  VIEW3D.lastTreeSig = sig;

  // 防抖：短时间内多次调用只执行最后一次
  clearTimeout(VIEW3D.syncTimer);
  VIEW3D.syncTimer = setTimeout(() => {
    if (VIEW3D.ready && VIEW3D.map) {
      rebuildTreeSource(VIEW3D.map);
      if (VIEW3D.speciesFilter) applySpeciesFilter();
    }
  }, 120);
}

/** 强制下次同步时重建（记了树、删了树之后用） */
function invalidateTrees3D() {
  VIEW3D.lastTreeSig = null;
}

/** 绑定树木的点击/悬停事件（图层重建后要重新绑，所以用动态图层名） */
function bindTreeEvents(map3) {
  const L = VIEW3D.treeLayers;
  if (!L || !L.canopy) return;
  if (map3._treeEventsBoundFor === L.canopy) return;   // 这组图层已经绑过了
  map3._treeEventsBoundFor = L.canopy;

  // 点色块和点圆点都给同样的弹窗。
  // 用 e.lngLat（点击处）而不是 f.geometry.coordinates ——
  // 面要素的 coordinates 是嵌套数组，直接传进去弹窗会算错位置。
  const openPopup = (e) => {
    const f = e.features && e.features[0];
    if (!f) return;
    const p = f.properties;
    const bits = [];
    if (p.note) bits.push(p.note);
    if (p.height) bits.push(`高 ${p.height} 米`);
    if (p.dbh) bits.push(`胸径 ${p.dbh} 厘米`);
    if (p.kind === 'area') bits.push('圈过范围');
    if (p.recorder) bits.push(`记录人 ${p.recorder}`);
    new maplibregl.Popup({ closeButton: true, maxWidth: '260px' })
      .setLngLat(e.lngLat)
      .setHTML(
        `<div style="font-family:inherit">
           <div style="font-weight:650;font-size:14px">${escapeHtml(p.name || '植物')}
             <span style="font-weight:500;color:#7a8a75;font-size:12px">${escapeHtml(p.amount || '')}</span></div>
           ${bits.length ? `<div style="font-size:12px;color:#5a6b55;margin-top:3px">${
             escapeHtml(bits.join(' · '))}</div>` : ''}
         </div>`
      )
      .addTo(map3);
  };

  const clickable = [L.canopy, L.area].filter(Boolean);
  map3.on('click', clickable, openPopup);
  map3.on('mouseenter', clickable, () => { map3.getCanvas().style.cursor = 'pointer'; });
  map3.on('mouseleave', clickable, () => { map3.getCanvas().style.cursor = ''; });
}

/** 加树的三个图层。图层名带序号，避免复用被删过的名字（原因见 rebuildTreeSource） */
function addTreeLayers(map3, srcId, seq) {
  srcId = srcId || VIEW3D.treeSourceId;
  seq = seq || ++treeSourceSeq;
  const L = {
    area: `tarea_${seq}`,
    shadow: `tshadow_${seq}`,
    canopy: `tcanopy_${seq}`,
    count: `tcount_${seq}`,
  };
  VIEW3D.treeLayers = L;

  // 圈出的范围：铺一块半透明色块。
  // 必须加在最底下，否则会盖住树冠的圆点。
  // 圆点图层只画点几何，所以色块和圆点可以共用同一个数据源。
  map3.addLayer({
    id: L.area,
    type: 'fill',
    source: srcId,
    filter: ['==', ['get', 'kind'], 'area'],
    paint: {
      'fill-color': ['get', 'color'],
      'fill-opacity': ['case', ['get', 'dim'], 0.08, 0.3],
      'fill-outline-color': ['get', 'color'],
    },
  });

  // 脚下阴影
  map3.addLayer({
    id: L.shadow,
    type: 'circle',
    source: srcId,
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        15, ['*', ['get', 'r'], 1.3],
        19, ['*', ['get', 'r'], 3.6],
      ],
      'circle-color': '#14320f',
      'circle-opacity': 0.28,
      'circle-blur': 0.6,
    },
  });

  // 树冠本体
  map3.addLayer({
    id: L.canopy,
    type: 'circle',
    source: srcId,
    paint: {
      // 被筛选掉的树半径缩到 55%，仍可见但不抢眼
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        15, ['*', ['*', ['get', 'r'], 1.7], ['case', ['get', 'dim'], 0.55, 1.0]],
        17, ['*', ['*', ['get', 'r'], 2.8], ['case', ['get', 'dim'], 0.55, 1.0]],
        19, ['*', ['*', ['get', 'r'], 5.2], ['case', ['get', 'dim'], 0.55, 1.0]],
      ],
      'circle-color': ['get', 'color'],
      'circle-opacity': ['case', ['get', 'dim'], 0.22, 0.96],
      'circle-stroke-width': ['interpolate', ['linear'], ['zoom'], 15, 1.6, 19, 3],
      'circle-stroke-color': '#ffffff',
      'circle-stroke-opacity': ['case', ['get', 'dim'], 0.25, 0.95],
    },
  });

  // 数量角标：用手绘的小圆点标数量，不用 symbol 文字图层。
  // 踩过的坑：symbol 图层要加载远程字体（text-font），字体拉不到时会
  // 连带把整个数据源的渲染卡住 —— 表现为圆点图层也一个都不显示。
  // 数量改用「加大圆点 + 加粗描边」表达，彻底避开字体依赖。
  map3.addLayer({
    id: L.count,
    type: 'circle',
    source: srcId,
    filter: ['>', ['get', 'count'], 1],
    paint: {
      'circle-radius': ['interpolate', ['linear'], ['zoom'],
        15, ['*', ['get', 'r'], 1.7],
        17, ['*', ['get', 'r'], 2.8],
        19, ['*', ['get', 'r'], 5.2],
      ],
      // 多条记录叠一本时加一圈深色描边，区分"这一处有多棵"
      'circle-color': 'rgba(0,0,0,0)',
      'circle-stroke-width': 2.5,
      'circle-stroke-color': '#1c2419',
      'circle-stroke-opacity': ['case', ['get', 'dim'], 0.2, 0.9],
    },
  });

  bindTreeEvents(map3);
  // 图层重建后要把开关状态恢复回去
  const treeOn = $('ly-trees') ? $('ly-trees').checked : true;
  set3DLayerVisible('ly-trees', treeOn);
}
/** 切换 2D / 3D */
async function setView(mode) {
  const is3d = mode === '3d';
  $('map').style.display = is3d ? 'none' : '';
  $('map3d').style.display = is3d ? '' : 'none';
  document.querySelectorAll('.view-btn').forEach((b) => {
    b.classList.toggle('active', b.dataset.view === mode);
  });

  if (is3d) {
    await init3D();
    VIEW3D.map.resize();
    // 等地图彻底 idle（瓦片渲染完、worker 就绪）再建树木图层。
    // 实测：太早建源会让那个源永久不渲染。
    await waitIdle(VIEW3D.map, 4000);
    syncTrees3D();
    // 筛选状态在切回来时要恢复
    if (VIEW3D.speciesFilter) applySpeciesFilter();
    $('tools-3d').classList.remove('hidden');
    $('mode-text').textContent = '拖动旋转 · 右键或双指调整俯仰角';
    setTimeout(() => updateModeBar(), 2600);
  } else {
    // 切回平面时停止旋转并收起三维控件
    stopOrbit();
    $('tools-3d').classList.add('hidden');
    $('filter-panel').classList.add('hidden');
    if (map) map.invalidateSize();
    updateModeBar();
  }
}

/** 等地图空闲（所有瓦片渲染完），带超时兜底 */
function waitIdle(map3, timeoutMs = 4000) {
  return new Promise((resolve) => {
    let done = false;
    const finish = () => { if (!done) { done = true; resolve(); } };
    map3.once('idle', finish);
    setTimeout(finish, timeoutMs);
  });
}

/* ---------------------------------------------------------------
   自动环绕旋转
   汇报展示时用：相机绕着校园慢慢转一圈，不用手拖。

   实现上不用 setInterval 硬转（掉帧时速度会飘），
   而是用 requestAnimationFrame 按时间增量算角度，转速稳定。
   --------------------------------------------------------------- */
const ORBIT_SPEED = 3.6;      // 度/秒，转一圈约 100 秒

function startOrbit() {
  const map3 = VIEW3D.map;
  if (!map3 || VIEW3D.orbiting) return;

  VIEW3D.orbiting = true;
  $('btn-orbit').classList.add('active');

  // 记住开始时的俯仰角：如果当前太平（不能体现三维），自动抬起一点
  if (map3.getPitch() < 35) {
    map3.easeTo({ pitch: 50, duration: 600 });
  }

  let last = performance.now();
  const step = (now) => {
    if (!VIEW3D.orbiting || !VIEW3D.map) return;
    const dt = (now - last) / 1000;
    last = now;
    const b = VIEW3D.map.getBearing() + ORBIT_SPEED * dt;
    VIEW3D.map.setBearing(b % 360);
    VIEW3D.orbitRaf = requestAnimationFrame(step);
  };
  VIEW3D.orbitRaf = requestAnimationFrame(step);
}

function stopOrbit() {
  VIEW3D.orbiting = false;
  if (VIEW3D.orbitRaf) cancelAnimationFrame(VIEW3D.orbitRaf);
  VIEW3D.orbitRaf = null;
  const btn = $('btn-orbit');
  if (btn) btn.classList.remove('active');
}

function toggleOrbit() {
  if (VIEW3D.orbiting) { stopOrbit(); toast('已停止旋转'); }
  else { startOrbit(); toast('开始环绕 · 再点一下停止'); }
}

/* ---------------------------------------------------------------
   按树种筛选
   选中的树种正常显示，未选中的变暗变小但仍可见
   （不直接隐藏，是为了还能看出"这一片整体有多少树"）
   --------------------------------------------------------------- */
function openFilterPanel() {
  const panel = $('filter-panel');
  if (!panel.classList.contains('hidden')) { panel.classList.add('hidden'); return; }

  // 按当前数据里实际出现的树种生成列表
  const groups = {};
  for (const t of state.trees) {
    const sp = speciesById(t.species);
    const cfg = CATEGORY[categoryOf(t)];
    const nm = speciesLabel(t);
    if (!groups[nm]) groups[nm] = { name: nm, color: sp.color, count: 0, several: 0, unit: cfg.unit };
    if (t.several) groups[nm].several += 1;
    else groups[nm].count += cfg.count ? (t.count || 1) : (t.area || 0);
  }
  const list = Object.values(groups).sort((a, b) => b.count - a.count);

  const chosen = VIEW3D.speciesFilter;   // null = 全选
  $('filter-list').innerHTML = list.length ? list.map((g) => {
    const on = !chosen || chosen.has(g.name);
    const num = g.count ? `${g.count} ${g.unit}` : '';
    const add = g.several ? `${g.count ? ' + ' : ''}${g.several} 处未定` : '';
    return `<label class="fp-row">
      <input type="checkbox" data-sp="${escapeHtml(g.name)}" ${on ? 'checked' : ''}>
      <span class="fp-dot" style="background:${g.color}"></span>
      <span class="fp-name">${escapeHtml(g.name)}</span>
      <span class="fp-num">${num}${add}</span>
    </label>`;
  }).join('') : '<p class="fp-hint" style="border:none">还没有记录</p>';

  $('filter-list').querySelectorAll('input').forEach((el) => {
    el.addEventListener('change', () => {
      const all = [...$('filter-list').querySelectorAll('input')];
      const picked = new Set(all.filter((x) => x.checked).map((x) => x.dataset.sp));
      // 全勾上就等于不筛选
      VIEW3D.speciesFilter = picked.size === all.length ? null : picked;
      applySpeciesFilter();
    });
  });

  panel.classList.remove('hidden');
}

/** 把筛选结果应用到三维树木样式 */
function applySpeciesFilter() {
  const map3 = VIEW3D.map;
  const L = VIEW3D.treeLayers || {};
  if (!map3 || !VIEW3D.ready || !L.canopy) return;
  if (!map3.getLayer(L.canopy)) return;

  // 更新数据的 "on" 字段
  const chosen = VIEW3D.speciesFilter;
  const src = map3.getSource(VIEW3D.treeSourceId);
  if (src && src._data) {
    const feats = src._data.features.map((f) => {
      const p = f.properties;
      const nm = p.rawSpecies === 'unknown' && p.speciesOther ? p.speciesOther : p.name;
      p.dim = chosen ? !chosen.has(nm) : false;
      return f;
    });
    src.setData({ type: 'FeatureCollection', features: feats });
  }

  // 变暗变小，但保留可见
  const dimR = ['case', ['get', 'dim'], 0.55, 1.0];

  try {
    map3.setPaintProperty(L.canopy, 'circle-opacity', ['case', ['get', 'dim'], 0.22, 0.96]);
    map3.setPaintProperty(L.canopy, 'circle-radius', ['interpolate', ['linear'], ['zoom'],
      15, ['*', ['*', ['get', 'r'], 1.7], dimR],
      17, ['*', ['*', ['get', 'r'], 2.8], dimR],
      19, ['*', ['*', ['get', 'r'], 5.2], dimR],
    ]);
    map3.setPaintProperty(L.canopy, 'circle-stroke-opacity',
      ['case', ['get', 'dim'], 0.25, 0.95]);
    map3.setPaintProperty(L.shadow, 'circle-opacity',
      ['case', ['get', 'dim'], 0.06, 0.28]);
    map3.setPaintProperty(L.count, 'circle-stroke-opacity',
      ['case', ['get', 'dim'], 0.2, 0.9]);
  } catch (e) { /* 图层可能正在重建，忽略 */ }
}

/** 恢复全部显示 */
function clearSpeciesFilter() {
  VIEW3D.speciesFilter = null;
  $('filter-list').querySelectorAll('input').forEach((el) => { el.checked = true; });
  applySpeciesFilter();
}
