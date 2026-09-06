'use strict';

/* ============================================================
 * 商品条码管理 —— 渲染层逻辑
 * ============================================================ */

const $ = (id) => document.getElementById(id);

let products = [];
let dataDir = '';
let selectedId = null;   // 当前编辑的商品 id（null = 新增）
let searchText = '';

/* ---------------- 条码工具 ---------------- */

// 各类型位数规则（JsBarcode 需要去掉校验位的数据位）
const BARCODE_RULES = {
  EAN13: { name: 'EAN-13', dataDigits: 12, fullDigits: 13 },
  UPC: { name: 'UPC-A', dataDigits: 11, fullDigits: 12 },
  ITF14: { name: 'ITF-14', dataDigits: 13, fullDigits: 14 },
  CODE128: { name: 'Code 128' },
  CODE39: { name: 'Code 39' },
};

// EAN 系校验位算法（EAN13/UPC-A/ITF14 通用）：对 dataDigits 位数据从右往左 权重 3,1,3,1...
function eanChecksum(digits) {
  let sum = 0;
  let w = 3;
  for (let i = digits.length - 1; i >= 0; i--) {
    sum += Number(digits[i]) * w;
    w = w === 3 ? 1 : 3;
  }
  return (10 - (sum % 10)) % 10;
}

// 中文预校验 + 规范化：返回 { ok, value?(传给 JsBarcode 的数据位), full?(完整条码含校验位), error? }
function normalizeBarcode(type, raw) {
  const rule = BARCODE_RULES[type];
  const input = String(raw == null ? '' : raw).trim();
  if (!input) return { ok: false, error: '请填写条码内容或 SKU' };

  if (!rule.dataDigits) {
    // Code128 / Code39：无固定位数
    if (type === 'CODE39' && !/^[A-Za-z0-9\-\.\ \/\+\$%]+$/.test(input)) {
      return { ok: false, error: 'Code 39 只支持字母、数字及部分符号' };
    }
    return { ok: true, value: input, full: input };
  }

  if (!/^\d+$/.test(input)) {
    return { ok: false, error: rule.name + ' 只能包含数字（当前有字母/符号）' };
  }
  if (input.length === rule.dataDigits) {
    // 缺校验位：自动补全
    return { ok: true, value: input, full: input + eanChecksum(input) };
  }
  if (input.length === rule.fullDigits) {
    // 带校验位的完整码：验证末位
    const data = input.slice(0, rule.dataDigits);
    const expect = eanChecksum(data);
    if (Number(input[rule.dataDigits]) === expect) {
      return { ok: true, value: data, full: input };
    }
    return { ok: false, error: rule.name + ' 校验位不正确（末位应为 ' + expect + '）' };
  }
  return { ok: false, error: rule.name + ' 需要 ' + rule.dataDigits + ' 位数字（可输入完整 ' + rule.fullDigits + ' 位）' };
}

// 返回 { ok, canvas?, error?, value?, full? }；value=数据位，full=完整条码（含校验位）
function buildBarcode(type, value) {
  const norm = normalizeBarcode(type, value);
  if (!norm.ok) return { ok: false, error: norm.error };
  const canvas = document.createElement('canvas');
  try {
    JsBarcode(canvas, norm.value, {
      format: type,
      displayValue: true, // 主界面预览保留数字
      width: 8,
      height: 180,
      margin: 4,
      font: '40px Microsoft YaHei',
      textMargin: 6,
    });
  } catch (e) {
    const msg = typeof e === 'string' ? e : (e && e.message) || '未知错误';
    return { ok: false, error: '条码生成失败：' + msg };
  }
  return { ok: true, canvas, value: norm.value, full: norm.full };
}

// 生成条码矢量图（SVG dataURL，任意尺寸打印都锐利；数字由 HTML 渲染）
function barcodeSvgString(type, value) {
  const norm = normalizeBarcode(type, value);
  if (!norm.ok) return '';
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  try {
    JsBarcode(svg, norm.value, {
      format: type,
      displayValue: false,
      width: 2,
      height: 60,
      margin: 2,
    });
  } catch (e) {
    return '';
  }
  const xml = new XMLSerializer().serializeToString(svg);
  return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(xml);
}

/* ---------------- 非阻塞提示（替代 alert / confirm） ---------------- */

function showToast(msg, type) {
  const box = $('toastBox');
  const el = document.createElement('div');
  el.className = 'toast' + (type ? ' ' + type : '');
  el.textContent = msg;
  box.appendChild(el);
  setTimeout(() => {
    el.classList.add('fade-out');
    setTimeout(() => el.remove(), 350);
  }, 3200);
}

// 返回 Promise<boolean>：true=用户点确定
function confirmDialog(text, title) {
  return new Promise((resolve) => {
    $('confirmText').textContent = text;
    if (title) $('confirmTitle').textContent = title;
    const mask = $('confirmModal');
    const okBtn = $('btnConfirmOk');
    mask.classList.remove('hidden');
    okBtn.focus();
    const cleanup = () => {
      mask.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      $('btnConfirmCancel').removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
    };
    const onOk = () => { cleanup(); resolve(true); };
    const onCancel = () => { cleanup(); resolve(false); };
    const onMask = (e) => { if (e.target === mask) { cleanup(); resolve(false); } };
    okBtn.addEventListener('click', onOk);
    $('btnConfirmCancel').addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
  });
}

/* ---------------- 状态与列表 ---------------- */

let filterCategory = '';   // 分类筛选值（'' = 全部）
let sortMode = 'default';  // 排序：default/name/priceAsc/priceDesc/updated
let lastCatsKey = null;    // 分类下拉自重建检测（商品分类集合变化才重建）

function filteredProducts() {
  let list = products;
  const q = searchText.trim().toLowerCase();
  if (q) {
    list = list.filter((p) =>
      (p.name || '').toLowerCase().includes(q) ||
      (p.sku || '').toLowerCase().includes(q) ||
      (p.barcode || '').toLowerCase().includes(q)
    );
  }
  if (filterCategory) {
    list = list.filter((p) => (p.category || '').trim() === filterCategory);
  }
  list = [...list];
  if (sortMode === 'name') list.sort((a, b) => String(a.name || '').localeCompare(String(b.name || ''), 'zh-CN'));
  else if (sortMode === 'priceAsc') list.sort((a, b) => (Number(a.price) || 0) - (Number(b.price) || 0));
  else if (sortMode === 'priceDesc') list.sort((a, b) => (Number(b.price) || 0) - (Number(a.price) || 0));
  else if (sortMode === 'updated') list.sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
  return list;
}

// 分类筛选下拉（在 refreshCategoryDatalist 时一并刷新）
function buildCategoryFilter() {
  const sel = $('categoryFilter');
  if (!sel) return;
  const cats = Array.from(new Set(products.map((p) => (p.category || '').trim()).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b, 'zh-CN'));
  sel.innerHTML = '';
  const optAll = document.createElement('option');
  optAll.value = '';
  optAll.textContent = '全部分类';
  sel.appendChild(optAll);
  for (const c of cats) {
    const opt = document.createElement('option');
    opt.value = c;
    opt.textContent = c;
    sel.appendChild(opt);
  }
  if (filterCategory && cats.includes(filterCategory)) sel.value = filterCategory;
  else { filterCategory = ''; sel.value = ''; }
}

function renderList() {
  // 分类集合变化时自动重建筛选下拉（表单/恢复/导入等任何来源的商品变动都覆盖）
  const catsKey = [...new Set(products.map((p) => (p.category || '').trim()).filter(Boolean))].sort().join('|');
  if (catsKey !== lastCatsKey) {
    lastCatsKey = catsKey;
    buildCategoryFilter();
  }
  const body = $('productBody');
  const list = filteredProducts();
  body.innerHTML = '';

  if (!list.length) {
    body.innerHTML = '<tr class="empty-row"><td colspan="5">暂无商品，点击右上角「＋ 新增商品」开始</td></tr>';
    $('checkAll').checked = false;
    $('listCount').textContent = searchText ? '0 项' : '0 项';
    updateStatusBar();
    return;
  }

  for (const p of list) {
    const tr = document.createElement('tr');
    tr.dataset.id = p.id;
    if (p.id === selectedId) tr.classList.add('selected');
    tr.innerHTML = `
      <td class="col-check"><input type="checkbox" class="row-check" data-id="${p.id}" title="勾选用于打印"></td>
      <td title="${esc(p.name)}">${esc(p.name)}</td>
      <td title="${esc(p.sku || '')}">${esc(p.sku || '')}</td>
      <td class="col-cat" title="${esc(p.category || '')}">${esc(p.category || '')}</td>
      <td class="col-price">${p.price !== '' && p.price != null ? '¥' + Number(p.price).toFixed(2) : ''}</td>`;
    tr.addEventListener('click', (e) => {
      if (e.target.classList.contains('row-check')) return;
      selectProduct(p.id);
    });
    body.appendChild(tr);
  }
  $('listCount').textContent = list.length + ' 项';
  updateStatusBar();
}

function updateStatusBar() {
  $('statusCount').textContent = '共 ' + products.length + ' 个商品';
  if (dataDir) $('statusDataDir').textContent = '数据位置：' + dataDir;
}

/* ---------------- 表单 ---------------- */

function resetForm() {
  selectedId = null;
  $('formTitle').textContent = '新增商品';
  $('productId').textContent = '';
  $('fName').value = '';
  $('fSku').value = '';
  $('fCategory').value = '';
  $('fUnit').value = '';
  $('fPrice').value = '';
  $('fSpec').value = '';
  $('fRemark').value = '';
  $('fBarcodeType').value = 'EAN13';
  $('fBarcode').value = '';
  $('btnDelete').disabled = true;
  updateBarcodePreview();
  clearSelectionHighlight();
  $('saveStatus').textContent = '';
}

function fillForm(p) {
  selectedId = p.id;
  $('formTitle').textContent = '编辑商品';
  $('productId').textContent = 'ID: ' + p.id.slice(0, 8);
  $('fName').value = p.name || '';
  $('fSku').value = p.sku || '';
  $('fCategory').value = p.category || '';
  $('fUnit').value = p.unit || '';
  $('fPrice').value = p.price;
  $('fSpec').value = p.spec || '';
  $('fRemark').value = p.remark || '';
  $('fBarcodeType').value = p.barcodeType || 'EAN13';
  $('fBarcode').value = p.barcode || '';
  $('btnDelete').disabled = false;
  updateBarcodePreview();
  $('saveStatus').textContent = '';
}

function selectProduct(id) {
  const p = products.find((x) => x.id === id);
  if (!p) return;
  fillForm(p);
  renderList(); // 刷新选中高亮
}

function clearSelectionHighlight() {
  document.querySelectorAll('#productBody tr.selected').forEach((tr) => tr.classList.remove('selected'));
}

// 当前表单的条码内容：显式输入优先，否则回退到 SKU
function currentBarcodeValue() {
  const raw = $('fBarcode').value.trim();
  if (raw) return raw;
  return $('fSku').value.trim();
}

function updateBarcodePreview() {
  const type = $('fBarcodeType').value;
  const value = currentBarcodeValue();
  const status = $('barcodeStatus');
  const canvasBox = $('barcodeCanvas');
  const textHint = $('barcodePreviewText');

  const ctx = canvasBox.getContext('2d');
  ctx.clearRect(0, 0, canvasBox.width, canvasBox.height);
  canvasBox.style.display = 'none';
  textHint.style.display = 'block';

  if (!value) {
    status.textContent = '输入条码内容或 SKU 后实时预览';
    status.className = 'barcode-status';
    return;
  }

  const r = buildBarcode(type, value);
  if (!r.ok) {
    status.textContent = '⚠ ' + r.error;
    status.className = 'barcode-status err';
    return;
  }
  canvasBox.width = r.canvas.width;
  canvasBox.height = r.canvas.height;
  ctx.drawImage(r.canvas, 0, 0);
  canvasBox.style.display = 'block';
  textHint.style.display = 'none';
  const code = r.full || r.value;
  status.textContent = '✓ 条码有效（完整编码 ' + code + '）';
  status.className = 'barcode-status ok';
}

/* ---------------- 保存 / 删除 ---------------- */

function readForm() {
  const name = $('fName').value.trim();
  const priceRaw = $('fPrice').value.trim();
  const barcodeType = $('fBarcodeType').value;
  const barcode = currentBarcodeValue();

  if (!name) return { error: '请填写商品名称' };
  if (!barcode) return { error: '请填写条码内容或 SKU（条码可自动使用 SKU）' };

  const price = priceRaw === '' ? '' : Number(priceRaw);
  if (price !== '' && (isNaN(price) || price < 0)) return { error: '价格格式不正确' };

  // 校验条码有效性（EAN 系自动补/校验校验位）
  const r = buildBarcode(barcodeType, barcode);
  if (!r.ok) return { error: '条码无效：' + r.error };

  const p = {
    id: selectedId || undefined,
    name,
    sku: $('fSku').value.trim(),
    category: $('fCategory').value.trim(),
    unit: $('fUnit').value.trim(),
    price,
    spec: $('fSpec').value.trim(),
    barcodeType,
    barcode: r.full || r.value, // 保存完整编码（含校验位）
    remark: $('fRemark').value.trim(),
  };
  return { p };
}

async function saveProduct() {
  const res = readForm();
  if (res.error) {
    $('saveStatus').textContent = '⚠ ' + res.error;
    $('saveStatus').style.color = '#dc2626';
    return;
  }
  const out = await window.api.saveProduct(res.p);
  if (out.ok) {
    products = out.products;
    selectedId = res.p.id;
    renderList();
    const saved = products.find((x) => x.id === selectedId);
    if (saved) fillForm(saved);
    $('saveStatus').textContent = '✓ 已保存';
    $('saveStatus').style.color = '#16a34a';
  } else {
    $('saveStatus').textContent = '⚠ 保存失败';
    $('saveStatus').style.color = '#dc2626';
  }
}

async function deleteProduct() {
  if (!selectedId) return;
  const p = products.find((x) => x.id === selectedId);
  const ok = await confirmDialog('确定删除商品「' + (p ? p.name : '') + '」吗？此操作不可撤销。', '删除确认');
  if (!ok) return;
  const out = await window.api.deleteProduct(selectedId);
  if (out.ok) {
    products = out.products;
    resetForm();
    renderList();
    showToast('已删除', 'success');
  }
}

/* ---------------- 分类联想 ---------------- */

function refreshCategoryDatalist() {
  const set = new Set(products.map((p) => p.category).filter(Boolean));
  $('categoryList').innerHTML = [...set].map((c) => `<option value="${esc(c)}">`).join('');
  buildCategoryFilter();
}

/* ---------------- 打印 ---------------- */

function getCheckedProducts() {
  const ids = [...document.querySelectorAll('.row-check:checked')].map((cb) => cb.dataset.id);
  return products.filter((p) => ids.includes(p.id));
}

function preparePrintPayload(list) {
  const payload = [];
  const failed = [];
  for (const p of list) {
    try {
      const barcode = p.barcode || '';
      const norm = normalizeBarcode(p.barcodeType || 'EAN13', barcode);
      payload.push({
        ...p,
        barcodeSvg: barcodeSvgString(p.barcodeType || 'EAN13', barcode),
        barcodeText: norm.ok ? norm.full : barcode,
      });
    } catch (e) {
      failed.push(p.name);
    }
  }
  return { payload, failed };
}

function openPrintModal(list) {
  if (!list.length) {
    showToast('请先勾选要打印的商品', 'warn');
    return;
  }
  const { payload, failed } = preparePrintPayload(list);
  if (!payload.length) {
    showToast('所选商品都无法生成条码，无法打印', 'error');
    return;
  }
  if (failed.length) {
    showToast('以下商品条码无效，已跳过：\n' + failed.join('\n'), 'warn');
  }
  $('printModal').dataset.payload = JSON.stringify(payload);
  openDesigner(payload);
}

async function doPrint() {
  const modal = $('printModal');
  const payload = JSON.parse(modal.dataset.payload || '[]');
  const opts = {
    settings: designerSettings,
    printOptions: currentPrintOptions(),
  };
  modal.classList.add('hidden');
  // 打印后把当前设置自动回存到当前预设，下次打开打印界面直接沿用
  printPresets[activePreset] = deepCopy(designerSettings);
  await persistPresets().catch(() => {});
  // 同步保存打印设备选项（打印机/方向/份数/静默）
  window.api.savePrintOptions(currentPrintOptions()).catch(() => {});
  try {
    const res = await window.api.printLabels(payload, opts);
    if (res && res.ok) {
      const opt = currentPrintOptions();
      const found = printerList.find((p) => p.deviceName === opt.deviceName);
      const name = found ? (found.displayName || found.deviceName) : (opt.deviceName || '系统默认打印机');
      showToast(`已发送到「${name}」× ${opt.copies} 份`, 'success');
      // 记录打印历史（含完整打印载荷，供一键原样重打）
      window.api.savePrintHistory({
        time: new Date().toISOString(),
        count: payload.length,
        names: payload.slice(0, 5).map((p) => p.name || p.sku || '未命名'),
        copies: opt.copies,
        deviceName: opt.deviceName,
        landscape: opt.landscape,
        payload,
        settings: deepCopy(designerSettings),
        printOptions: opt,
      }).catch(() => {});
    } else if (res && !res.ok) {
      if (res.reason === '用户取消') showToast('打印已取消');
      else if (res.error) showToast('打印失败：' + res.error, 'error');
      else if (res.reason) showToast('打印失败：' + res.reason, 'error');
    }
  } catch (e) {
    showToast('打印出错：' + (e && e.message ? e.message : e), 'error');
  } finally {
    modal.classList.add('hidden');
    $('printModal').dataset.payload = '';
  }
}

/* ---------------- 导出 PDF ---------------- */

async function doExportPdf() {
  if (!designerSettings) return;
  const payload = JSON.parse($('printModal').dataset.payload || '[]');
  if (!payload.length) { showToast('没有可导出的商品', 'warn'); return; }
  $('btnExportPdf').disabled = true;
  try {
    const res = await window.api.exportPdf({
      products: payload,
      opts: { settings: designerSettings, printOptions: currentPrintOptions() },
    });
    if (res && res.ok) showToast('已导出：\n' + res.path, 'success');
    else if (res && !res.canceled && res.error) showToast('导出失败：' + res.error, 'error');
  } catch (e) {
    showToast('导出出错：' + (e && e.message ? e.message : e), 'error');
  } finally {
    $('btnExportPdf').disabled = false;
  }
}

/* ---------------- 打印历史 / 一键重打 ---------------- */

let historyCache = [];

async function openHistoryModal() {
  const res = await window.api.getPrintHistory();
  historyCache = (res && res.history) || [];
  renderHistoryList();
  $('historyModal').classList.remove('hidden');
}

function renderHistoryList() {
  const box = $('historyList');
  box.innerHTML = '';
  if (!historyCache.length) {
    box.innerHTML = '<p class="history-empty">还没有打印记录</p>';
    return;
  }
  historyCache.forEach((h, i) => {
    const item = document.createElement('div');
    item.className = 'history-item';
    const t = new Date(h.time);
    const timeStr = isNaN(t) ? String(h.time) : t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    const names = h.names || [];
    const summary = names.length > 3
      ? names.slice(0, 3).join('、') + ` 等 ${h.count} 个`
      : names.join('、');
    const dev = h.deviceName || '系统默认打印机';
    item.innerHTML = `
      <div class="history-info">
        <div class="history-line1"><span class="history-time">${esc(timeStr)}</span><span class="history-meta">${esc(dev)}${h.landscape ? ' · 横向' : ''} × ${Number(h.copies) || 1} 份</span></div>
        <div class="history-desc" title="${esc(summary)}">${esc(summary)}</div>
      </div>
      <button type="button" class="mini-btn" data-reprint="${i}">🖨 重打</button>`;
    box.appendChild(item);
  });
}

async function reprintHistory(idx) {
  const h = historyCache[idx];
  if (!h || !Array.isArray(h.payload) || !h.payload.length) {
    showToast('该记录缺少打印内容，无法重打', 'warn');
    return;
  }
  const copies = Math.max(1, Math.round(Number(h.copies) || 1));
  try {
    const res = await window.api.printLabels(h.payload, {
      settings: h.settings,
      printOptions: { ...(h.printOptions || {}), copies },
    });
    if (res && res.ok) showToast('已重打 × ' + copies + ' 份', 'success');
    else if (res && res.reason === '用户取消') showToast('打印已取消');
    else if (res && res.error) showToast('重打失败：' + res.error, 'error');
    else if (res && res.reason) showToast('重打失败：' + res.reason, 'error');
  } catch (e) {
    showToast('重打出错：' + (e && e.message ? e.message : e), 'error');
  }
}

/* ---------------- 打印设计器 ---------------- */

const MM_TO_PX = 3.7795;       // 1mm ≈ 3.7795px（96dpi）
const MAX_PREVIEW_SCALE = 3;   // 预览最大放大倍数（小标签放大用）
let currentPreviewScale = 3;   // 当前实际缩放倍数（自适应，拖拽换算也用它）
let designerSettings = null;   // 当前设计器设置（normalize 后）
let designerProducts = [];     // 当前待打印商品（含 barcodeSvg）
let selectedElement = null;    // 主选中元素 key（兼容单选逻辑/测试）
let selectedKeys = [];         // 多选集合（selectedKeys[0] === selectedElement）
let sampleIdx = 0;             // 预览样板商品下标
let snapHeights = {};          // 预览实测元素高度（mm，缩字后真实值），吸附/对齐用
let curLabelW = 60;            // 当前编辑画布（单个标签）尺寸 mm，吸附与边界 clamp 用
let curLabelH = 40;
let dragging = null;           // 拖拽状态 { key, keys, origs, multi, startPX, startPY }
let marquee = null;            // 框选状态 { p0, rect, box, additive, base }
let printPresets = {};         // 打印预设：{ 预设名: settings }（内存态）
let activePreset = '默认';     // 当前选中的预设名
let clipboardCustom = null;    // 复制的自定义元素数组（Ctrl+C/V 用）
let undoStack = [];            // 撤销栈（designerSettings 快照，上限 50）
let redoStack = [];
let focusSnap = null;          // 输入框聚焦期间的首改快照（整段编辑合并为一步撤销）
let lastUndoTag = null;        // 连续同类操作合并标记（如方向键微调）
let lastUndoTime = 0;
let autoSaveTimer = null;      // 自动保存防抖
let resizeTimer = null;        // 窗口缩放防抖
let manualZoom = null;         // Ctrl+滚轮手动缩放倍数（null = 自适应）

const deepCopy = (o) => JSON.parse(JSON.stringify(o));

const ELEMENT_LABELS = {
  name: { name: '商品名称', hint: '商品名称' },
  price: { name: '价格', hint: '¥12.50' },
  sku: { name: 'SKU / 货号', hint: 'SKU-0001' },
  barcode: { name: '条形码', hint: '条码' },
};

const ELEMENT_FIELDS = {
  name:    ['x', 'y', 'w', 'fontSize', 'align', 'bold', 'rot', 'vertical'],
  price:   ['x', 'y', 'w', 'fontSize', 'align', 'bold', 'rot', 'vertical'],
  sku:     ['x', 'y', 'w', 'fontSize', 'align', 'bold', 'rot', 'vertical'],
  barcode: ['x', 'y', 'w', 'h', 'fontSize', 'align', 'rot'],
};

// 自定义元素可编辑字段（name 元素名称、text 文本、color 颜色走特殊控件）
const CUSTOM_FIELDS = ['name', 'text', 'x', 'y', 'w', 'fontSize', 'align', 'bold', 'color', 'rot', 'vertical'];

const FIELD_LABELS = {
  x: 'X 位置', y: 'Y 位置', w: '宽度', h: '高度',
  fontSize: '字号', align: '对齐', bold: '加粗',
  text: '文本内容', color: '颜色', name: '元素名称', rot: '旋转', vertical: '排列',
};

// 根据 key 取元素：'custom:<id>' → 自定义元素；其他 → 固定元素
function elementByKey(key) {
  if (key && key.startsWith('custom:')) {
    const id = key.slice(7);
    return (designerSettings.custom || []).find((c) => c.id === id);
  }
  return designerSettings ? designerSettings.elements[key] : null;
}

/* ---------------- 撤销 / 重做 ---------------- */

const UNDO_LIMIT = 50;
const round10 = (v) => Math.round(v * 10) / 10;

function snapshotSettings() { return deepCopy(designerSettings); }

// tag + coalesceMs：同类连续操作（如方向键微调）在时限内合并为一步
function pushUndo(tag, coalesceMs) {
  if (!designerSettings) return;
  const t = Date.now();
  if (tag && tag === lastUndoTag && t - lastUndoTime < (coalesceMs || 0)) {
    lastUndoTime = t;
    return;
  }
  lastUndoTag = tag || null;
  lastUndoTime = t;
  undoStack.push(snapshotSettings());
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
}

// 输入框聚焦时记下快照，首次输入时入栈 → 整段编辑算一步撤销
function armFocusSnap() {
  if (designerSettings) focusSnap = deepCopy(designerSettings);
}
function consumeFocusSnap() {
  if (!focusSnap) return;
  undoStack.push(focusSnap);
  if (undoStack.length > UNDO_LIMIT) undoStack.shift();
  redoStack.length = 0;
  lastUndoTag = null;
  focusSnap = null;
}

function resetUndo() {
  undoStack = [];
  redoStack = [];
  focusSnap = null;
  lastUndoTag = null;
}

function applySnapshot(snap) {
  designerSettings = LabelRender.normalizeSettings(snap);
  if (selectedElement && !elementByKey(selectedElement)) selectedElement = null;
  selectedKeys = selectedKeys.filter((k) => elementByKey(k));
  if (!selectedKeys.length && selectedElement) selectedKeys = [selectedElement];
  $('printSize').value = designerSettings.labelSize;
  buildElementPanel();
  renderPreview();
  scheduleAutoSave();
}

function doUndo() {
  if (!designerSettings || dragging || marquee) return;
  if (!undoStack.length) { showToast('没有可撤销的操作', 'warn'); return; }
  redoStack.push(snapshotSettings());
  applySnapshot(undoStack.pop());
}

function doRedo() {
  if (!designerSettings || dragging || marquee) return;
  if (!redoStack.length) { showToast('没有可重做的操作', 'warn'); return; }
  undoStack.push(snapshotSettings());
  applySnapshot(redoStack.pop());
}

// 撤销/重做按钮的可用状态（无步可退/进时置灰）
function updateUndoRedoButtons() {
  const u = $('btnUndo'), r = $('btnRedo');
  if (u) u.disabled = !undoStack.length;
  if (r) r.disabled = !redoStack.length;
}

/* ---------------- 自动保存（防抖写回当前预设，关闭设计器不丢改动） ---------------- */

function scheduleAutoSave() {
  if (!designerSettings) return;
  if (autoSaveTimer) clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    autoSaveTimer = null;
    flushAutoSave();
  }, 600);
}

function flushAutoSave() {
  if (!designerSettings) return;
  if (autoSaveTimer) { clearTimeout(autoSaveTimer); autoSaveTimer = null; }
  printPresets[activePreset] = deepCopy(designerSettings);
  persistPresets().catch(() => {});
}

/* ---------------- 多选 ---------------- */

function setSelection(keys) {
  selectedKeys = (keys || []).filter((k) => elementByKey(k));
  selectedElement = selectedKeys.length ? selectedKeys[0] : null;
  updateSelectionToolbar();
}

function toggleSelect(key) {
  if (!key) return;
  if (selectedKeys.includes(key)) setSelection(selectedKeys.filter((k) => k !== key));
  else setSelection([...selectedKeys, key]);
  buildElementPanel();
  renderPreview();
}

function selectAllVisible() {
  if (!designerSettings) return;
  const keys = [];
  for (const k of LabelRender.ELEMENT_KEYS) {
    if (designerSettings.elements[k].visible) keys.push(k);
  }
  for (const c of designerSettings.custom || []) {
    if (c.visible) keys.push('custom:' + c.id);
  }
  setSelection(keys);
  buildElementPanel();
  renderPreview();
  if (keys.length) showToast('已全选 ' + keys.length + ' 个元素', 'success');
}

function updateSelectionToolbar() {
  const bar = $('selectionToolbar');
  if (!bar) return;
  bar.classList.toggle('hidden', selectedKeys.length < 2);
  const label = bar.querySelector('.sel-count');
  if (label) label.textContent = '已选 ' + selectedKeys.length + ' 个';
}

// 布局类批量操作（对齐/分布/粘贴/删除）后的统一收尾
function afterLayoutChange() {
  clampAll();
  buildElementPanel();
  renderPreview();
  scheduleAutoSave();
}

// 把所有元素夹回标签边界内（旋转元素按视觉包围盒计算；此前元素可被拖出右/下边界后"看不见"）
function clampAll() {
  const clampEl = (key, el) => {
    if (!el) return;
    const c = clampVisual(el, key, el.x, el.y);
    el.x = c.x;
    el.y = c.y;
  };
  if (!designerSettings) return;
  for (const k of LabelRender.ELEMENT_KEYS) clampEl(k, designerSettings.elements[k]);
  for (const c of designerSettings.custom || []) clampEl('custom:' + c.id, c);
}

/* ---------------- 批量对齐 / 等距分布 ---------------- */

function selectionEdges() {
  return selectedKeys
    .map((k) => ({ key: k, el: elementByKey(k), e: elementEdges(elementByKey(k), k) }))
    .filter((x) => x.el);
}

function alignSelection(mode) {
  const items = selectionEdges();
  if (items.length < 2) return;
  pushUndo();
  const l = Math.min(...items.map((i) => i.e.left));
  const r = Math.max(...items.map((i) => i.e.right));
  const t = Math.min(...items.map((i) => i.e.top));
  const b = Math.max(...items.map((i) => i.e.bottom));
  const cx = (l + r) / 2, cy = (t + b) / 2;
  for (const it of items) {
    if (mode === 'left') it.el.x = round10(l - it.e.vx);
    else if (mode === 'centerX') it.el.x = round10(cx - it.e.vw / 2 - it.e.vx);
    else if (mode === 'right') it.el.x = round10(r - it.e.vw - it.e.vx);
    else if (mode === 'top') it.el.y = round10(t - it.e.vy);
    else if (mode === 'centerY') it.el.y = round10(cy - it.e.vh / 2 - it.e.vy);
    else if (mode === 'bottom') it.el.y = round10(b - it.e.vh - it.e.vy);
  }
  afterLayoutChange();
}

function distributeSelection(axis) {
  const items = selectionEdges();
  if (items.length < 3) { showToast('等距分布至少需要选中 3 个元素', 'warn'); return; }
  pushUndo();
  if (axis === 'x') {
    items.sort((a, b) => a.e.left - b.e.left);
    const span = items[items.length - 1].e.right - items[0].e.left;
    const totalW = items.reduce((s, i) => s + i.e.vw, 0);
    const gap = (span - totalW) / (items.length - 1);
    let cur = items[0].e.left;
    for (const it of items) { it.el.x = round10(cur - it.e.vx); cur += it.e.vw + gap; }
  } else {
    items.sort((a, b) => a.e.top - b.e.top);
    const span = items[items.length - 1].e.bottom - items[0].e.top;
    const totalH = items.reduce((s, i) => s + i.e.vh, 0);
    const gap = (span - totalH) / (items.length - 1);
    let cur = items[0].e.top;
    for (const it of items) { it.el.y = round10(cur - it.e.vy); cur += it.e.vh + gap; }
  }
  afterLayoutChange();
}


async function openDesigner(products) {
  designerProducts = products;
  sampleIdx = 0;
  manualZoom = null;
  setSelection(['name']); // 默认展开第一个元素参数
  resetUndo();
  const saved = await window.api.getPrintSettings();
  // 载入预设集合：{ 预设名: settings } + 上次活动的预设名
  printPresets = (saved && saved.presets && typeof saved.presets === 'object') ? saved.presets : {};
  activePreset = (saved && saved.active) ? saved.active : '默认';
  if (!printPresets[activePreset]) {
    // 预设不存在（首次使用 / active 已被删除）→ 取第一个，否则建一个默认预设
    const names = Object.keys(printPresets);
    if (names.length) activePreset = names[0];
    else printPresets['默认'] = null;
  }
  if (printPresets[activePreset]) {
    designerSettings = LabelRender.normalizeSettings(printPresets[activePreset]);
  } else {
    designerSettings = LabelRender.normalizeSettings({ labelSize: '60x40' });
  }
  // 尺寸下拉同步到当前预设
  $('printSize').value = designerSettings.labelSize;
  // 打印选项：先载全局记忆，再让当前预设记忆的选项（若有）覆盖
  await loadPrinterOptions();
  applyPresetPrintOptions();
  buildPresetSelect();
  buildElementPanel();
  // 先显示弹窗再渲染预览：隐藏状态下读不到面板尺寸，自适应缩放会错（首次打开缩放变 0.4 的老问题）
  $('printModal').classList.remove('hidden');
  renderPreview();
}

// ---------------- 打印选项（打印机/方向/份数/静默） ----------------

let printerList = [];       // 系统打印机列表缓存
let printerOptions = {};    // 从磁盘加载的打印选项

async function loadPrinterOptions() {
  printerOptions = (await window.api.getPrintOptions()).options || {};
  // 打印机下拉：选项 = 系统打印机 + 「系统默认」
  const res = await window.api.getPrinters();
  printerList = res.printers || [];
  const sel = $('optPrinter');
  sel.innerHTML = '';
  const opts = [{ value: '', label: '（系统默认打印机）' }];
  for (const p of printerList) {
    const dn = p.deviceName || '';
    if (!dn) continue; // 无 deviceName 的打印机项不可用，跳过（避免写入 "undefined"）
    opts.push({ value: dn, label: p.displayName || dn });
  }
  for (const o of opts) {
    const opt = document.createElement('option');
    opt.value = o.value;
    opt.textContent = o.label;
    sel.appendChild(opt);
  }
  // 应用保存过的值：上次打印机仍在列表则选中，否则回退系统默认
  const saved = printerOptions.deviceName || '';
  if (saved && printerList.some((p) => p.deviceName === saved)) {
    sel.value = saved;
  } else {
    const def = printerList.find((p) => p.isDefault);
    sel.value = def ? def.deviceName : '';
  }
  $('optLandscape').value = printerOptions.landscape ? '1' : '0';
  $('optCopies').value = Math.max(1, Math.round(Number(printerOptions.copies) || 1));
  $('optSilent').checked = printerOptions.silent === false ? false : true;
}

function currentPrintOptions() {
  const clampOff = (v) => {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.max(-20, Math.min(20, Math.round(n * 10) / 10));
  };
  return {
    deviceName: $('optPrinter').value || '',
    landscape: $('optLandscape').value === '1',
    copies: Math.max(1, Math.round(Number($('optCopies').value) || 1)),
    silent: $('optSilent').checked,
    offsetX: clampOff($('optOffX').value),
    offsetY: clampOff($('optOffY').value),
  };
}

// 当前预设记忆了打印选项则覆盖控件（旧预设没记忆 → 沿用全局"上次使用"）
function applyPresetPrintOptions() {
  const po = designerSettings && designerSettings.printOptions;
  if (!po) return;
  if (po.deviceName && printerList.some((p) => p.deviceName === po.deviceName)) {
    $('optPrinter').value = po.deviceName;
  }
  $('optLandscape').value = po.landscape ? '1' : '0';
  $('optCopies').value = Math.max(1, Math.round(Number(po.copies) || 1));
  $('optSilent').checked = po.silent !== false;
  $('optOffX').value = Number(po.offsetX) || 0;
  $('optOffY').value = Number(po.offsetY) || 0;
}

function savePrinterOptionsNow() {
  const opts = currentPrintOptions();
  window.api.savePrintOptions(opts).catch(() => {}); // 全局记忆（兼容/回退用）
  if (designerSettings) {
    designerSettings.printOptions = opts; // 随当前预设一起记忆
    scheduleAutoSave();
  }
}

// 预设下拉渲染
function buildPresetSelect() {
  const sel = $('presetSelect');
  sel.innerHTML = '';
  const names = Object.keys(printPresets);
  for (const name of names) {
    const opt = document.createElement('option');
    opt.value = name;
    opt.textContent = name;
    sel.appendChild(opt);
  }
  sel.value = activePreset;
  $('presetCount').textContent = names.length ? names.length + ' 套' : '';
}

// 保存当前预设集合到磁盘（主进程持久化）
function persistPresets() {
  return window.api.savePrintSettings({ active: activePreset, presets: printPresets });
}

// 把当前设计器设置写回当前预设并落盘
async function saveToActivePreset() {
  printPresets[activePreset] = deepCopy(designerSettings);
  await persistPresets();
  buildPresetSelect();
  showToast('预设「' + activePreset + '」已保存', 'success');
}

// 另存为新预设（弹输入框）
async function saveAsPreset() {
  const name = await promptDialog('请输入新预设名称', '');
  if (name == null) return; // 取消
  const trimmed = name.trim();
  if (!trimmed) { showToast('预设名称不能为空', 'warn'); return; }
  if (printPresets[trimmed]) {
    const ok = await confirmDialog('已存在预设「' + trimmed + '」，确定覆盖吗？', '覆盖预设');
    if (!ok) return;
  }
  printPresets[trimmed] = deepCopy(designerSettings);
  activePreset = trimmed;
  await persistPresets();
  buildPresetSelect();
  showToast('已保存为新预设「' + trimmed + '」', 'success');
}

// 新建空白预设：沿用当前位置参数，但所有元素（含自定义）全部取消勾选，从零开始排
async function saveAsBlankPreset() {
  const name = await promptDialog('请输入空白预设名称', '');
  if (name == null) return; // 取消
  const trimmed = name.trim();
  if (!trimmed) { showToast('预设名称不能为空', 'warn'); return; }
  if (printPresets[trimmed]) {
    const ok = await confirmDialog('已存在预设「' + trimmed + '」，确定覆盖吗？', '覆盖预设');
    if (!ok) return;
  }
  flushAutoSave(); // 当前调整先写回原预设
  const blank = deepCopy(designerSettings);
  for (const k of LabelRender.ELEMENT_KEYS) blank.elements[k].visible = false;
  blank.custom = (blank.custom || []).map((c) => ({ ...c, visible: false }));
  printPresets[trimmed] = blank;
  activePreset = trimmed;
  designerSettings = LabelRender.normalizeSettings(blank);
  $('printSize').value = designerSettings.labelSize;
  applyPresetPrintOptions();
  resetUndo();
  await persistPresets();
  buildPresetSelect();
  buildElementPanel();
  renderPreview();
  showToast('已创建空白预设「' + trimmed + '」，所有元素已取消勾选', 'success');
}

// 删除当前预设
async function deletePreset() {
  const names = Object.keys(printPresets);
  if (names.length <= 1) {
    showToast('至少保留一个预设', 'warn');
    return;
  }
  const toDelete = activePreset;
  const ok = await confirmDialog('确定删除预设「' + toDelete + '」吗？', '删除预设');
  if (!ok) return;
  delete printPresets[toDelete];
  activePreset = Object.keys(printPresets)[0];
  designerSettings = LabelRender.normalizeSettings(printPresets[activePreset]);
  $('printSize').value = designerSettings.labelSize;
  applyPresetPrintOptions();
  resetUndo();
  await persistPresets();
  buildPresetSelect();
  buildElementPanel();
  renderPreview();
  showToast('已删除预设「' + toDelete + '」', 'success');
}

// 输入弹层：返回 Promise<string|null>（null=取消）
function promptDialog(title, defaultValue) {
  return new Promise((resolve) => {
    $('promptTitle').textContent = title;
    const input = $('promptInput');
    input.value = defaultValue || '';
    const mask = $('promptModal');
    mask.classList.remove('hidden');
    input.focus();
    input.select();
    const cleanup = () => {
      mask.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      $('btnPromptCancel').removeEventListener('click', onCancel);
      mask.removeEventListener('click', onMask);
      input.removeEventListener('keydown', onKey);
    };
    const onOk = () => { cleanup(); resolve(input.value); };
    const onCancel = () => { cleanup(); resolve(null); };
    const onMask = (e) => { if (e.target === mask) { cleanup(); resolve(null); } };
    const onKey = (e) => {
      if (e.key === 'Enter') onOk();
      else if (e.key === 'Escape') onCancel();
    };
    const okBtn = $('btnPromptOk');
    okBtn.addEventListener('click', onOk);
    $('btnPromptCancel').addEventListener('click', onCancel);
    mask.addEventListener('click', onMask);
    input.addEventListener('keydown', onKey);
  });
}

function buildElementPanel() {
  const list = $('elementList');
  list.innerHTML = '';
  // 固定元素卡片
  for (const key of LabelRender.ELEMENT_KEYS) {
    const info = ELEMENT_LABELS[key];
    const el = designerSettings.elements[key];
    list.appendChild(buildFixedCard(key, info.name, el, ELEMENT_FIELDS[key]));
  }
  // 自定义元素卡片
  designerSettings.custom.forEach((c, i) => {
    list.appendChild(buildCustomCard(c, i));
  });
}

function buildFixedCard(key, title, el, fields) {
  const card = document.createElement('div');
  card.className = 'element-card' + (selectedKeys.includes(key) ? ' active' : '');
  card.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'element-card-head';
  head.innerHTML = `<span>${title}</span>
    <label class="el-visible" title="显示/隐藏"><input type="checkbox" ${el.visible ? 'checked' : ''}> 显示</label>`;
  head.querySelector('input').addEventListener('change', (e) => {
    pushUndo();
    designerSettings.elements[key].visible = e.target.checked;
    renderPreview();
    scheduleAutoSave();
  });
  head.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    setSelection([key]);
    buildElementPanel();
    renderPreview();
  });
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'element-card-body' + (selectedElement === key ? '' : ' hidden');
  for (const field of fields) {
    body.appendChild(buildFieldControl(key, field, () => designerSettings.elements[key]));
  }
  card.appendChild(body);
  return card;
}

// 卡片标题实时更新（改名/改文本时只改标题，不重建面板，避免输入框失焦）
function updateCustomCardTitle(key, title) {
  const card = document.querySelector(`.element-card[data-key="${CSS.escape(key)}"]`);
  if (!card) return;
  const span = card.querySelector('.element-card-head span');
  if (span) span.textContent = '✏️ ' + (title || '自定义');
}

function buildCustomCard(c, idx) {
  const key = 'custom:' + c.id;
  const card = document.createElement('div');
  card.className = 'element-card element-card-custom' + (selectedKeys.includes(key) ? ' active' : '');
  card.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'element-card-head';
  const cardTitle = (c.name && c.name.trim()) ? c.name : `自定义 ${idx + 1}`;
  head.innerHTML = `<span>✏️ ${LabelRender.esc(cardTitle)}</span>
    <label class="el-visible" title="显示/隐藏"><input type="checkbox" ${c.visible ? 'checked' : ''}> 显示</label>`;
  head.querySelector('input').addEventListener('change', (e) => {
    pushUndo();
    c.visible = e.target.checked;
    renderPreview();
    scheduleAutoSave();
  });
  // 复制按钮：向下复制一个相同元素
  const dupBtn = document.createElement('button');
  dupBtn.type = 'button';
  dupBtn.className = 'mini-btn';
  dupBtn.title = '向下复制一个相同元素';
  dupBtn.textContent = '⧉ 复制';
  dupBtn.addEventListener('click', (e) => {
    e.stopPropagation();
    duplicateCustomElement(c.id);
  });
  // 删除按钮
  const delBtn = document.createElement('button');
  delBtn.type = 'button';
  delBtn.className = 'mini-btn mini-danger';
  delBtn.title = '删除此元素';
  delBtn.textContent = '🗑';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    const ok = await confirmDialog('确定删除该自定义元素吗？', '删除元素');
    if (!ok) return;
    removeCustomElement(c.id);
  });
  head.appendChild(dupBtn);
  head.appendChild(delBtn);

  head.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT' || e.target.tagName === 'BUTTON') return;
    setSelection([key]);
    buildElementPanel();
    renderPreview();
  });
  card.appendChild(head);

  const body = document.createElement('div');
  body.className = 'element-card-body' + (selectedElement === key ? '' : ' hidden');
  for (const field of CUSTOM_FIELDS) {
    body.appendChild(buildFieldControl(key, field, () => elementByKey(key)));
  }
  card.appendChild(body);
  return card;
}

// 生成单个参数控件（数字 / 对齐 / 加粗 / 文本 / 颜色）
// 撤销策略：聚焦时记快照，首次输入时入栈 → 整段编辑算一步；改动后防抖自动保存
function buildFieldControl(key, field, getEl) {
  const lab = document.createElement('label');
  lab.innerHTML = `<span>${FIELD_LABELS[field]}</span>`;
  const apply = (mutate) => {
    consumeFocusSnap();
    mutate();
    renderPreview();
    scheduleAutoSave();
  };
  const bindFocus = (inp) => {
    inp.addEventListener('focus', armFocusSnap);
  };
  if (field === 'align') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="left">左</option><option value="center">中</option><option value="right">右</option>';
    sel.value = getEl().align || 'left';
    bindFocus(sel);
    sel.addEventListener('change', () => {
      apply(() => { getEl().align = sel.value; });
    });
    lab.appendChild(sel);
  } else if (field === 'bold') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="0">否</option><option value="1">是</option>';
    sel.value = getEl().bold ? '1' : '0';
    bindFocus(sel);
    sel.addEventListener('change', () => {
      apply(() => { getEl().bold = sel.value === '1'; });
    });
    lab.appendChild(sel);
  } else if (field === 'rot') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="0">0°</option><option value="90">90°</option><option value="180">180°</option><option value="270">270°</option>';
    sel.value = String(getEl().rot || 0);
    bindFocus(sel);
    sel.addEventListener('change', () => {
      apply(() => { getEl().rot = LabelRender.normalizeRot(sel.value); });
    });
    lab.appendChild(sel);
  } else if (field === 'vertical') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="0">横排</option><option value="1">竖排</option>';
    sel.value = getEl().vertical ? '1' : '0';
    sel.title = '竖排：每个字直立、从上往下排列';
    bindFocus(sel);
    sel.addEventListener('change', () => {
      apply(() => { getEl().vertical = sel.value === '1'; });
    });
    lab.appendChild(sel);
  } else if (field === 'name') {
    // 元素名称：默认自动取文本前 5 字；用户手动修改后锁定（不再随文本变化）
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 20;
    inp.placeholder = '文本前5字';
    inp.title = '默认取文本内容前 5 个字；手动修改后以此名称为准，不再随文本变化';
    inp.value = getEl().name || '';
    bindFocus(inp);
    inp.addEventListener('input', () => {
      apply(() => {
        const el = getEl();
        el.name = inp.value;
        el.nameLocked = true;
      });
      updateCustomCardTitle(key, inp.value);
    });
    lab.appendChild(inp);
  } else if (field === 'text') {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 60;
    inp.value = getEl().text || '';
    bindFocus(inp);
    inp.addEventListener('input', () => {
      apply(() => {
        const el = getEl();
        el.text = inp.value;
        // 名称未手动改过时，自动跟随文本前 5 字（不足不补，超过截 5 字）
        if (!el.nameLocked) {
          el.name = el.text.slice(0, 5);
          updateCustomCardTitle(key, el.name);
        }
      });
    });
    lab.appendChild(inp);
  } else if (field === 'color') {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = getEl().color || '#000000';
    bindFocus(inp);
    inp.addEventListener('input', () => {
      apply(() => { getEl().color = inp.value; });
    });
    lab.appendChild(inp);
  } else {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.1';
    inp.min = '0';
    inp.value = getEl()[field];
    bindFocus(inp);
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v) && v >= 0) {
        apply(() => { getEl()[field] = Math.round(v * 10) / 10; });
      }
    });
    lab.appendChild(inp);
  }
  return lab;
}

// 添加一个自定义文本元素（默认放在标签中下部）
function addCustomElement() {
  const c = LabelRender.normalizeCustomElement({
    text: '自定义文本',
    x: 5,
    y: 20,
    w: designerSettings.labelSize === 'a4' ? 50 : Math.min(50, designerSettings.elements.name.w || 50),
    fontSize: 3,
  });
  pushUndo();
  designerSettings.custom.push(c);
  setSelection(['custom:' + c.id]);
  afterLayoutChange();
  showToast('已添加自定义文本，可在预览中拖动', 'success');
}

// 向下复制出一个相同元素（新元素 Y 偏移 +6mm，避免重叠）
function duplicateCustomElement(id) {
  const src = designerSettings.custom.find((c) => c.id === id);
  if (!src) return;
  const copy = LabelRender.normalizeCustomElement(deepCopy(src));
  copy.id = LabelRender.newCustomId(); // 复制必须换新 id，否则与原件冲突
  copy.y = Math.round((src.y + 6) * 10) / 10;
  pushUndo();
  designerSettings.custom.push(copy);
  setSelection(['custom:' + copy.id]);
  afterLayoutChange();
}

function removeCustomElement(id) {
  pushUndo();
  const key = 'custom:' + id;
  designerSettings.custom = designerSettings.custom.filter((c) => c.id !== id);
  const next = selectedKeys.filter((k) => k !== key);
  if (!next.length) next.push('name');
  setSelection(next);
  afterLayoutChange();
}

// 预览用单位：mm → px（自适应缩放）
function unitMM(v) { return Math.round(v * MM_TO_PX * currentPreviewScale) + 'px'; }

// 预览中元素的实际 px 尺寸（用于拖拽换算）
function mmToPx(v) { return v * MM_TO_PX * currentPreviewScale; }

// ---------------- 对齐吸附与参考线 ----------------
// 吸附取舍原则（参考 dlabel/Figma）：阈值跟手不跟 mm、每轴只取一个最近候选、
// 参照目标克制（其它元素边缘 + 标签边/中心线共 5 个），多选拖动完全关闭吸附。

// 吸附阈值（mm）：按屏幕 6px 换算并夹在 [0.3, 1.5]，缩放大小不同手感一致
function snapThresholdMM() {
  const px = 6 / (MM_TO_PX * currentPreviewScale);
  return Math.max(0.3, Math.min(1.5, Math.round(px * 100) / 100));
}

// 数值夹回 [0, max]（元素不允许拖出标签右/下边界；上限向下取整保证旋转元素视觉盒也不越界）
function clampAxis(v, max) {
  const hi = Math.max(0, Math.floor(max * 10) / 10);
  return Math.max(0, Math.min(round10(v), hi));
}

// 元素关键边缘（mm 坐标系）；文本元素优先用预览实测高度（缩字后真实值）
// 旋转元素（0/90/180/270）返回"视觉包围盒"：旋转绕中心，vw/vh 为视觉宽高，vx/vy 为视觉盒原点相对元素盒原点的偏移
function elementEdges(el, key) {
  const w = el.w || 0;
  const measured = key ? snapHeights[key] : null;
  const h = el.h || measured || (el.fontSize || 0) * 1.15;
  const rot = el.rot || 0;
  const swapped = rot === 90 || rot === 270;
  const vw = swapped ? h : w;
  const vh = swapped ? w : h;
  const vx = (vw - w) / 2;
  const vy = (vh - h) / 2;
  const left = el.x + vx;
  const top = el.y + vy;
  return {
    left, centerX: left + vw / 2, right: left + vw,
    top, centerY: top + vh / 2, bottom: top + vh,
    w, h, vw, vh, vx, vy,
  };
}

// 视觉包围盒不越界的元素盒原点上限（x 方向传 e，y 方向同理）
function clampVisual(el, key, nx, ny) {
  const e = elementEdges({ ...el, x: nx, y: ny }, key);
  return {
    x: clampAxis(nx, curLabelW - e.vw - e.vx),
    y: clampAxis(ny, curLabelH - e.vh - e.vy),
  };
}

// 收集其他可见元素的边缘候选（排除当前拖动的元素）
function collectSnapCandidates(excludeKey) {
  const xs = [];
  const ys = [];
  const addEl = (key, el) => {
    if (!el || !el.visible) return;
    const e = elementEdges(el, key);
    xs.push(e.left, e.centerX, e.right);
    ys.push(e.top, e.centerY, e.bottom);
  };
  for (const k of LabelRender.ELEMENT_KEYS) {
    if (k !== excludeKey) addEl(k, designerSettings.elements[k]);
  }
  for (const c of designerSettings.custom || []) {
    if ('custom:' + c.id !== excludeKey) addEl('custom:' + c.id, c);
  }
  return { xs, ys };
}

// 在当前候选集中找与 val 差值 ≤ 阈值的最佳吸附目标，返回 { delta, snapTo } 或 null
function bestSnap(val, candidates, dist) {
  let best = null;
  for (const c of candidates) {
    const d = c - val;
    if (Math.abs(d) <= dist && (!best || Math.abs(d) < Math.abs(best.delta))) {
      best = { delta: d, snapTo: c };
    }
  }
  return best;
}

// 计算拖拽吸附：返回 { tx, ty, gx, gy }（gx/gy 为参考线位置，null 表示不显示）
function computeSnap(key, el, tx, ty) {
  const cand = collectSnapCandidates(key);
  // 标签本体参照：左边缘/水平中心线、顶边/垂直中心线/底边
  // （x 不含标签右边缘——被拖元素右边缘不吸附，右对齐用左边缘去吸别人的右边缘）
  cand.xs.push(0, curLabelW / 2);
  cand.ys.push(0, curLabelH / 2, curLabelH);
  const dist = snapThresholdMM();
  const e = elementEdges({ ...el, x: tx, y: ty }, key);
  let gx = null, gy = null;
  // 水平（X）方向：左边缘 / 中心线（被拖动元素的右边缘不参与吸附，避免右端被吸走）
  const xCand = [
    { offset: 0, val: e.left },
    { offset: e.w / 2, val: e.centerX },
  ];
  let bestX = null;
  for (const c of xCand) {
    const s = bestSnap(c.val, cand.xs, dist);
    if (s && (!bestX || Math.abs(s.delta) < Math.abs(bestX.snap.delta))) bestX = { offset: c.offset, snap: s };
  }
  if (bestX) { tx = clampAxis(tx + bestX.snap.delta, curLabelW - e.vw - e.vx); gx = bestX.snap.snapTo; }
  else { tx = clampAxis(tx, curLabelW - e.vw - e.vx); }
  // 垂直（Y）方向
  const yCand = [
    { offset: 0, val: e.top },
    { offset: e.h / 2, val: e.centerY },
    { offset: e.h, val: e.bottom },
  ];
  let bestY = null;
  for (const c of yCand) {
    const s = bestSnap(c.val, cand.ys, dist);
    if (s && (!bestY || Math.abs(s.delta) < Math.abs(bestY.snap.delta))) bestY = { offset: c.offset, snap: s };
  }
  if (bestY) { ty = clampAxis(ty + bestY.snap.delta, curLabelH - e.vh - e.vy); gy = bestY.snap.snapTo; }
  else { ty = clampAxis(ty, curLabelH - e.vh - e.vy); }
  return { tx, ty, gx, gy };
}

// 编辑画布：非 A4 = 标签本体；A4 = 纸上第一个可编辑的 60×40 标签格
function getCanvasEl() {
  const labelEl = $('previewLabel');
  if (!labelEl) return null;
  if (labelEl.classList.contains('el-canvas')) return labelEl;
  return labelEl.querySelector('.el-canvas') || labelEl;
}

// 显示对齐参考线（gx/gy 为画布内 mm 坐标，null 不显示该方向；挂到画布坐标系内，跟随旋转）
function showGuides(gx, gy) {
  const canvas = getCanvasEl();
  if (!canvas) return;
  canvas.querySelectorAll('.guide-v, .guide-h').forEach((n) => n.remove());
  if (gx != null) {
    const d = document.createElement('div');
    d.className = 'guide-v';
    d.style.left = unitMM(gx);
    canvas.appendChild(d);
  }
  if (gy != null) {
    const d = document.createElement('div');
    d.className = 'guide-h';
    d.style.top = unitMM(gy);
    canvas.appendChild(d);
  }
}

function clearGuides() {
  const canvas = getCanvasEl();
  if (!canvas) return;
  canvas.querySelectorAll('.guide-v, .guide-h').forEach((n) => n.remove());
}

// 生成单个标签内容的 HTML（预览用，带 data-key 供交互）；rotStyle/verticalStyle 与打印端同规则
function rotStyle(el) {
  return el.rot ? `transform-origin:center;transform:rotate(${el.rot}deg);` : '';
}

function verticalStyle(el) {
  return el.vertical ? 'writing-mode:vertical-lr;text-orientation:upright;' : '';
}

function buildLabelBody(sample) {
  const el = designerSettings.elements;
  const body = [];
  if (el.name.visible && sample.name) {
    body.push(`<div class="el el-name" data-key="name" style="left:${unitMM(el.name.x)};top:${unitMM(el.name.y)};width:${unitMM(el.name.w)};font-size:${unitMM(el.name.fontSize)};text-align:${el.name.align};font-weight:${el.name.bold ? 'bold' : 'normal'};color:${el.name.color};${rotStyle(el.name)}${verticalStyle(el.name)}">${LabelRender.esc(sample.name)}</div>`);
  }
  if (el.price.visible && sample.price !== '' && sample.price != null) {
    body.push(`<div class="el el-price" data-key="price" style="left:${unitMM(el.price.x)};top:${unitMM(el.price.y)};width:${unitMM(el.price.w)};font-size:${unitMM(el.price.fontSize)};text-align:${el.price.align};font-weight:${el.price.bold ? 'bold' : 'normal'};color:${el.price.color};${rotStyle(el.price)}${verticalStyle(el.price)}">¥${Number(sample.price).toFixed(2)}</div>`);
  }
  if (el.sku.visible && sample.sku) {
    body.push(`<div class="el el-sku" data-key="sku" style="left:${unitMM(el.sku.x)};top:${unitMM(el.sku.y)};width:${unitMM(el.sku.w)};font-size:${unitMM(el.sku.fontSize)};text-align:${el.sku.align};font-weight:${el.sku.bold ? 'bold' : 'normal'};color:${el.sku.color};${rotStyle(el.sku)}${verticalStyle(el.sku)}">${LabelRender.esc(sample.sku)}</div>`);
  }
  if (el.barcode.visible && sample.barcodeSvg) {
    body.push(`<img class="el el-barcode" data-key="barcode" src="${sample.barcodeSvg}" alt="barcode" style="left:${unitMM(el.barcode.x)};top:${unitMM(el.barcode.y)};width:${unitMM(el.barcode.w)};height:${unitMM(el.barcode.h)};${rotStyle(el.barcode)}">`);
    if (sample.barcodeText && el.barcode.fontSize > 0) {
      body.push(`<div class="el el-barcode-text" data-key="barcode" style="left:${unitMM(el.barcode.x)};top:${unitMM(el.barcode.y + el.barcode.h)};width:${unitMM(el.barcode.w)};font-size:${unitMM(el.barcode.fontSize)};text-align:${el.barcode.align};${rotStyle({ rot: el.barcode.rot })}">${LabelRender.esc(sample.barcodeText)}</div>`);
    }
  }
  // 自定义元素
  (designerSettings.custom || []).forEach((c) => {
    if (!c.visible) return;
    body.push(`<div class="el el-custom" data-key="custom:${c.id}" style="left:${unitMM(c.x)};top:${unitMM(c.y)};width:${unitMM(c.w)};font-size:${unitMM(c.fontSize)};text-align:${c.align};font-weight:${c.bold ? 'bold' : 'normal'};color:${c.color};${rotStyle(c)}${verticalStyle(c)}">${LabelRender.esc(c.text)}</div>`);
  });
  return body.join('\n');
}

// 文本溢出自动缩字 + 实测高度（吸附/对齐用），与打印端内嵌脚本同规则
function fitAndMeasure(measureScope) {
  snapHeights = {};
  const px1 = MM_TO_PX * currentPreviewScale;
  document.querySelectorAll('#previewLabel .el').forEach((node) => {
    if (node.tagName === 'IMG') return;
    let mm = parseFloat(node.style.fontSize) / px1;
    if (isFinite(mm)) {
      let guard = 0;
      while (node.scrollWidth > node.clientWidth + 1 && mm > 1.2 && guard++ < 60) {
        mm = Math.round((mm - 0.2) * 10) / 10;
        node.style.fontSize = unitMM(mm);
      }
    }
    const key = node.dataset.key;
    if (measureScope && measureScope.contains(node) && key && key !== 'barcode') {
      // 条码下方的数字行不计入条码本体高度（条码有固定 h）
      snapHeights[key] = Math.round((node.offsetHeight / px1) * 100) / 100;
    }
  });
}

// 样板商品切换（预览区 ‹ x/N ›）
function updateSampleNav() {
  const nav = $('sampleNav');
  if (!nav) return;
  const n = designerProducts.length;
  nav.classList.toggle('hidden', n <= 1);
  $('sampleIdxText').textContent = n ? `${Math.min(sampleIdx + 1, n)} / ${n}` : '0 / 0';
  $('btnSamplePrev').disabled = sampleIdx <= 0;
  $('btnSampleNext').disabled = sampleIdx >= n - 1;
}

function renderPreview() {
  const stage = $('previewStage');
  const labelEl = $('previewLabel');
  const cfg = LabelRender.SIZE_CFG[designerSettings.labelSize];
  const isA4 = designerSettings.labelSize === 'a4';
  const landscape = $('optLandscape') && $('optLandscape').value === '1';
  // 编辑画布 = 单个标签（A4 时是纸上的 60×40 标签格）
  curLabelW = isA4 ? LabelRender.A4_LABEL_W : cfg.w;
  curLabelH = isA4 ? LabelRender.A4_LABEL_H : cfg.h;
  // 纸面尺寸：A4 显示整张纸，横向时纸面横放（内容不旋转，与打印一致）
  const sheetW = isA4 ? (landscape ? cfg.h : cfg.w) : curLabelW;
  const sheetH = isA4 ? (landscape ? cfg.w : cfg.h) : curLabelH;

  // 自适应缩放：完整显示纸面，小标签放大、大纸面缩小
  const rightPane = document.querySelector('.designer-right');
  const availW = (rightPane ? rightPane.clientWidth : 700) - 50;
  const availH = (rightPane ? rightPane.clientHeight : 560) - 70;
  const scaleByW = availW / (sheetW * MM_TO_PX);
  const scaleByH = availH / (sheetH * MM_TO_PX);
  const autoScale = Math.max(0.4, Math.min(MAX_PREVIEW_SCALE, scaleByW, scaleByH));
  // Ctrl+滚轮手动缩放优先（范围 0.4~4 倍），未手动调整时用自适应值
  currentPreviewScale = manualZoom != null ? Math.max(0.4, Math.min(4, manualZoom)) : autoScale;

  stage.style.width = mmToPx(sheetW) + 'px';
  stage.style.height = mmToPx(sheetH) + 'px';

  // 预览商品：用当前样板（可切换），验证不同长度名称的排版
  const sample = designerProducts[Math.min(sampleIdx, Math.max(0, designerProducts.length - 1))] || { name: '商品名称', sku: 'SKU-0001', price: 12.5, barcodeSvg: '' };

  if (isA4) {
    // 整张纸 + 标签切线网格；第一个标签可编辑，其余为静态克隆（所见即所得）
    const cols = landscape ? 4 : 3;
    const rows = landscape ? 4 : 6;
    labelEl.className = 'preview-label a4-sheet';
    labelEl.style.position = 'absolute';
    labelEl.style.left = '0';
    labelEl.style.top = '0';
    labelEl.style.width = mmToPx(sheetW) + 'px';
    labelEl.style.height = mmToPx(sheetH) + 'px';
    labelEl.style.transform = 'none';
    const tileCss = `width:${unitMM(curLabelW)};height:${unitMM(curLabelH)};`;
    const tiles = [];
    for (let i = 0, n = cols * rows; i < n; i++) {
      tiles.push(i === 0
        ? `<div class="a4-tile el-canvas" style="${tileCss}">${buildLabelBody(sample)}</div>`
        : `<div class="a4-tile a4-static" style="${tileCss}">${LabelRender.renderLabelHTML(sample, designerSettings.elements, designerSettings.custom, unitMM)}</div>`);
    }
    labelEl.innerHTML = `<div class="a4-grid" style="grid-template-columns:repeat(${cols},${unitMM(curLabelW)});gap:${unitMM(5)};padding:${unitMM(8)};">${tiles.join('')}</div>`;
  } else {
    // 热敏标签：画布即标签本体，横向时整体旋转 90°（与真实打印方向一致）
    labelEl.className = 'preview-label el-canvas';
    labelEl.style.position = 'absolute';
    labelEl.style.left = '50%';
    labelEl.style.top = '50%';
    labelEl.style.width = mmToPx(curLabelW) + 'px';
    labelEl.style.height = mmToPx(curLabelH) + 'px';
    labelEl.style.transform = landscape
      ? 'translate(-50%, -50%) rotate(90deg)'
      : 'translate(-50%, -50%)';
    labelEl.innerHTML = buildLabelBody(sample);
  }

  // 文本缩字（含静态克隆保持一致）+ 画布内实测高度
  fitAndMeasure(getCanvasEl());

  // 事件：拖拽 + 选中
  const canvas = getCanvasEl();
  canvas.querySelectorAll('.el').forEach((node) => {
    const key = node.dataset.key;
    if (selectedKeys.includes(key)) node.classList.add('selected');
    node.addEventListener('mousedown', (e) => startDrag(e, key, node));
  });
  // 画布空白处按下 → 框选（onmousedown 覆盖式绑定，避免重绘后重复叠加）
  canvas.onmousedown = startMarquee;

  const cfgInfo = LabelRender.SIZE_CFG[designerSettings.labelSize];
  $('previewMeta').textContent = `标签 ${cfgInfo.label} · 方向 ${landscape ? '横向' : '纵向'} · 预览缩放 ${Math.round(currentPreviewScale * 100) / 100} 倍${manualZoom != null ? '（Ctrl+滚轮可调，切尺寸/方向恢复自适应）' : ' · Ctrl+滚轮缩放'} · 拖动元素调整位置`;
  updateSampleNav();
  updateSelectionToolbar();
  updateUndoRedoButtons();
  clearGuides();
}

function startDrag(e, key, node) {
  e.preventDefault();
  e.stopPropagation();
  if (!designerSettings) return;
  // Ctrl/⌘ + 点选：切换多选，不进入拖动
  if (e.ctrlKey || e.metaKey) {
    toggleSelect(key);
    return;
  }
  if (!selectedKeys.includes(key)) {
    setSelection([key]);
    buildElementPanel();
    renderPreview();
  }
  // 重新获取节点（renderPreview 重建了 DOM）
  const canvas = getCanvasEl();
  const fresh = canvas.querySelector(`.el[data-key="${CSS.escape(key)}"]`);
  if (!fresh) return;
  if (!elementByKey(key)) return;
  const multi = selectedKeys.length > 1;
  const movingKeys = multi ? selectedKeys.slice() : [key];
  const origs = {};
  for (const k of movingKeys) {
    const el = elementByKey(k);
    if (el) origs[k] = { x: el.x, y: el.y };
  }
  dragging = { key, keys: movingKeys, origs, multi, startPX: e.clientX, startPY: e.clientY };
  document.body.style.cursor = 'move';
  clearGuides();
  let undoArmed = true; // 首次实际移动才记一步撤销（单击不算）
  const onMove = (ev) => {
    if (!dragging) return;
    const lscape = $('optLandscape') && $('optLandscape').value === '1';
    // 屏幕位移 → 内容坐标位移（横向时标签旋转 90°，方向需换算）
    const sxMM = (ev.clientX - dragging.startPX) / mmToPx(1);
    const syMM = (ev.clientY - dragging.startPY) / mmToPx(1);
    const dxMM = lscape ? -syMM : sxMM;
    const dyMM = lscape ? sxMM : syMM;
    if (undoArmed) { pushUndo(); undoArmed = false; }
    const live = getCanvasEl();
    if (dragging.multi) {
      // 多选整体平移：不做吸附（保持流畅），只夹边界
      for (const k of dragging.keys) {
        const el = elementByKey(k);
        const o = dragging.origs[k];
        if (!el || !o) continue;
        const c = clampVisual(el, k, o.x + dxMM, o.y + dyMM);
        el.x = c.x;
        el.y = c.y;
        const node2 = live.querySelector(`.el[data-key="${CSS.escape(k)}"]`);
        if (node2) {
          node2.style.left = unitMM(el.x);
          node2.style.top = unitMM(el.y);
        }
      }
      syncElementInputs(dragging.key);
      return;
    }
    const el = elementByKey(dragging.key);
    const o = dragging.origs[dragging.key];
    if (!el || !o) return;
    const raw = clampVisual(el, dragging.key, o.x + dxMM, o.y + dyMM);
    // 对齐吸附 + 参考线
    const snap = computeSnap(dragging.key, el, raw.x, raw.y);
    el.x = snap.tx;
    el.y = snap.ty;
    // 只更新被拖节点位置，不全量重绘（拖动流畅）
    const node2 = live.querySelector(`.el[data-key="${CSS.escape(dragging.key)}"]`);
    if (node2) {
      node2.style.left = unitMM(el.x);
      node2.style.top = unitMM(el.y);
    }
    syncElementInputs(dragging.key);
    showGuides(snap.gx, snap.gy);
  };
  const onUp = () => {
    dragging = null;
    document.body.style.cursor = '';
    clearGuides();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    // 松手后全量重绘一次（重测高度、同步选中框）并自动保存
    afterLayoutChange();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 画布空白处拖拽框选（横向旋转时做屏幕→标签坐标反变换）
function startMarquee(e) {
  if (!designerSettings || dragging || e.button !== 0) return;
  if (e.target.closest('.el')) return;
  e.preventDefault();
  const canvas = getCanvasEl();
  if (!canvas) return;
  const rect = canvas.getBoundingClientRect();
  const px1 = mmToPx(1);
  const toLabel = (cx, cy) => {
    const lscape = $('optLandscape') && $('optLandscape').value === '1';
    if (lscape) {
      // 标签旋转 90°：绕画布中心逆变换（标签 +x 轴指向屏幕下方）
      const cxm = rect.left + rect.width / 2;
      const cym = rect.top + rect.height / 2;
      return { x: curLabelW / 2 + (cy - cym) / px1, y: curLabelH / 2 - (cx - cxm) / px1 };
    }
    return { x: (cx - rect.left) / px1, y: (cy - rect.top) / px1 };
  };
  const p0 = toLabel(e.clientX, e.clientY);
  const additive = e.ctrlKey || e.metaKey;
  const base = additive ? selectedKeys.slice() : [];
  const box = document.createElement('div');
  box.className = 'marquee-box';
  canvas.appendChild(box);
  marquee = { p0, box };
  const onMove = (ev) => {
    if (!marquee) return;
    const p1 = toLabel(ev.clientX, ev.clientY);
    const l = Math.min(p0.x, p1.x), r = Math.max(p0.x, p1.x);
    const t = Math.min(p0.y, p1.y), b = Math.max(p0.y, p1.y);
    marquee.rect = { l, r, t, b };
    box.style.left = unitMM(l);
    box.style.top = unitMM(t);
    box.style.width = unitMM(r - l);
    box.style.height = unitMM(b - t);
  };
  const onUp = () => {
    if (!marquee) return;
    const sel = marquee.rect;
    marquee = null;
    box.remove();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    if (!sel) {
      // 单击空白：退出多选（保留主选中）
      setSelection(selectedElement ? [selectedElement] : []);
      buildElementPanel();
      renderPreview();
      return;
    }
    const hits = [];
    const hitTest = (key, el) => {
      if (!el || !el.visible) return;
      const ed = elementEdges(el, key);
      if (ed.right >= sel.l && ed.left <= sel.r && ed.bottom >= sel.t && ed.top <= sel.b) hits.push(key);
    };
    for (const k of LabelRender.ELEMENT_KEYS) hitTest(k, designerSettings.elements[k]);
    for (const c of designerSettings.custom || []) hitTest('custom:' + c.id, c);
    setSelection(additive ? Array.from(new Set([...base, ...hits])) : hits);
    buildElementPanel();
    renderPreview();
  };
  document.addEventListener('mousemove', onMove);
  document.addEventListener('mouseup', onUp);
}

// 拖拽后同步左侧输入框数值
function syncElementInputs(key) {
  const card = document.querySelector(`.element-card[data-key="${CSS.escape(key)}"]`);
  if (!card) return;
  const el = elementByKey(key);
  if (!el) return;
  const fields = key.startsWith('custom:') ? CUSTOM_FIELDS : ELEMENT_FIELDS[key];
  const inputs = card.querySelectorAll('input[type=number]');
  const fieldOrder = fields.filter((f) => f !== 'align' && f !== 'bold' && f !== 'text' && f !== 'color' && f !== 'name' && f !== 'rot' && f !== 'vertical');
  inputs.forEach((inp, i) => {
    const f = fieldOrder[i];
    if (f) inp.value = el[f];
  });
}

/* ---------------- 备份 / 恢复 ---------------- */

async function doBackup() {
  const res = await window.api.backupData();
  if (res.ok) showToast('备份成功：\n' + res.path, 'success');
  else if (!res.canceled) showToast('备份失败', 'error');
}

async function doRestore() {
  const ok = await confirmDialog('恢复数据将覆盖当前全部商品，确定继续吗？', '恢复确认');
  if (!ok) return;
  const res = await window.api.restoreData();
  if (res.ok) {
    products = res.products;
    resetForm();
    refreshCategoryDatalist();
    renderList();
    showToast('恢复成功，共 ' + products.length + ' 个商品', 'success');
  } else if (res.error) {
    showToast('恢复失败：' + res.error, 'error');
  }
}

/* ---------------- 工具 ---------------- */

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/* ---------------- 事件绑定 ---------------- */

function bindEvents() {
  $('btnNew').addEventListener('click', () => {
    resetForm();
    $('fName').focus();
  });

  $('btnSave').addEventListener('click', saveProduct);
  $('btnDelete').addEventListener('click', deleteProduct);

  $('searchInput').addEventListener('input', (e) => {
    searchText = e.target.value;
    renderList();
  });

  $('checkAll').addEventListener('change', (e) => {
    document.querySelectorAll('.row-check').forEach((cb) => { cb.checked = e.target.checked; });
  });

  $('btnPrintSelected').addEventListener('click', () => {
    const list = getCheckedProducts();
    openPrintModal(list);
  });

  $('btnPrintAll').addEventListener('click', () => {
    openPrintModal([...filteredProducts()]);
  });

  $('btnPrintCancel').addEventListener('click', () => {
    flushAutoSave(); // 关闭设计器前把未落盘的调整写回预设
    $('printModal').classList.add('hidden');
  });
  $('btnPrintConfirm').addEventListener('click', doPrint);

  // 对齐 / 分布工具栏（多选 ≥2 时出现）
  $('selectionToolbar').addEventListener('click', (e) => {
    const btn = e.target.closest('button');
    if (!btn || !designerSettings) return;
    if (btn.dataset.align) alignSelection(btn.dataset.align);
    else if (btn.dataset.distribute) distributeSelection(btn.dataset.distribute);
  });

  // 预览样板商品切换
  $('btnSamplePrev').addEventListener('click', () => {
    if (sampleIdx > 0) { sampleIdx--; renderPreview(); }
  });
  $('btnSampleNext').addEventListener('click', () => {
    if (sampleIdx < designerProducts.length - 1) { sampleIdx++; renderPreview(); }
  });

  // 窗口缩放后重算预览缩放（防抖）
  window.addEventListener('resize', () => {
    if ($('printModal').classList.contains('hidden')) return;
    if (resizeTimer) clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => { if (designerSettings) renderPreview(); }, 200);
  });

  // 打印预设
  $('presetSelect').addEventListener('change', async (e) => {
    if (!designerSettings) return;
    const name = e.target.value;
    if (!printPresets[name]) return;
    flushAutoSave(); // 先把当前调整写回原预设再切换，不丢改动
    activePreset = name;
    designerSettings = LabelRender.normalizeSettings(printPresets[name]);
    $('printSize').value = designerSettings.labelSize;
    applyPresetPrintOptions();
    resetUndo();
    buildElementPanel();
    renderPreview();
  });
  $('btnPresetSave').addEventListener('click', saveToActivePreset);
  $('btnPresetNew').addEventListener('click', saveAsPreset);
  $('btnPresetBlank').addEventListener('click', saveAsBlankPreset);
  $('btnPresetDelete').addEventListener('click', deletePreset);

  // 撤销 / 重做按钮（与 Ctrl+Z / Ctrl+Y 等效）
  $('btnUndo').addEventListener('click', doUndo);
  $('btnRedo').addEventListener('click', doRedo);

  // 自定义元素
  $('btnAddCustom').addEventListener('click', addCustomElement);

  // 打印选项（打印机/方向/份数/静默）变更即保存
  $('optPrinter').addEventListener('change', savePrinterOptionsNow);
  $('optLandscape').addEventListener('change', () => {
    savePrinterOptionsNow();
    manualZoom = null; // 方向切换重置为自适应缩放
    if (designerSettings) renderPreview();
  });
  $('optCopies').addEventListener('input', savePrinterOptionsNow);
  $('optSilent').addEventListener('change', savePrinterOptionsNow);
  $('optOffX').addEventListener('input', savePrinterOptionsNow);
  $('optOffY').addEventListener('input', savePrinterOptionsNow);

  // Ctrl+滚轮手动缩放预览（不按 Ctrl 保留默认滚动）
  document.querySelector('.designer-right').addEventListener('wheel', (e) => {
    if (!e.ctrlKey || !designerSettings || $('printModal').classList.contains('hidden')) return;
    e.preventDefault();
    const factor = e.deltaY < 0 ? 1.1 : 0.9;
    manualZoom = Math.max(0.4, Math.min(4, (manualZoom || currentPreviewScale) * factor));
    renderPreview();
  }, { passive: false });

  // 关窗瞬间把防抖中未落盘的设置同步写盘（invoke 会在卸载时被打断，用 send）
  window.addEventListener('beforeunload', () => {
    if (designerSettings && activePreset) {
      printPresets[activePreset] = deepCopy(designerSettings);
      try { window.api.savePrintSettingsSync({ active: activePreset, presets: printPresets }); } catch (_) { /* ignore */ }
    }
  });

  // 分类筛选 / 排序（切换后把选中值写入状态再刷新列表）
  $('categoryFilter').addEventListener('change', (e) => {
    filterCategory = e.target.value;
    renderList();
  });
  $('sortSelect').addEventListener('change', (e) => {
    sortMode = e.target.value;
    renderList();
  });

  // 导出 PDF
  $('btnExportPdf').addEventListener('click', doExportPdf);

  // 打印历史
  $('btnHistory').addEventListener('click', openHistoryModal);
  $('btnHistoryClose').addEventListener('click', () => $('historyModal').classList.add('hidden'));
  $('historyModal').addEventListener('click', (e) => {
    if (e.target === $('historyModal')) $('historyModal').classList.add('hidden');
  });
  $('historyList').addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-reprint]');
    if (!btn) return;
    const idx = Number(btn.dataset.reprint);
    reprintHistory(idx);
  });

  $('printSize').addEventListener('change', (e) => {
    if (!designerSettings) return;
    pushUndo();
    manualZoom = null; // 尺寸切换重置为自适应缩放
    designerSettings = LabelRender.normalizeSettings({
      labelSize: e.target.value,
      custom: designerSettings.custom,
      printOptions: designerSettings.printOptions,
    });
    $('printSize').value = designerSettings.labelSize;
    buildElementPanel();
    renderPreview();
    scheduleAutoSave();
  });

  $('btnResetLayout').addEventListener('click', () => {
    if (!designerSettings) return;
    pushUndo();
    manualZoom = null;
    designerSettings = LabelRender.normalizeSettings({
      labelSize: designerSettings.labelSize,
      custom: designerSettings.custom,
      printOptions: designerSettings.printOptions,
    });
    buildElementPanel();
    renderPreview();
    scheduleAutoSave();
    showToast('已恢复默认布局', 'success');
  });

  // 键盘：方向键微调（可多选）、Ctrl+Z/Y 撤销重做、Ctrl+A 全选、Ctrl+C/V 复制粘贴、
  // Delete 删除自定义元素、Esc 退出多选（输入框内交给系统原生行为）
  document.addEventListener('keydown', (e) => {
    if ($('printModal').classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    const mod = e.ctrlKey || e.metaKey;

    if (mod && !e.shiftKey && (e.key === 'z' || e.key === 'Z')) {
      e.preventDefault();
      doUndo();
      return;
    }
    if (mod && (e.key === 'y' || e.key === 'Y' || (e.shiftKey && (e.key === 'z' || e.key === 'Z')))) {
      e.preventDefault();
      doRedo();
      return;
    }
    if (mod && (e.key === 'a' || e.key === 'A')) {
      e.preventDefault();
      selectAllVisible();
      return;
    }
    if (e.key === 'Escape' && selectedKeys.length > 1) {
      setSelection(selectedElement ? [selectedElement] : []);
      buildElementPanel();
      renderPreview();
      e.preventDefault();
      return;
    }
    if (!selectedElement) return;

    const step = e.shiftKey ? 2 : 0.5;
    const moves = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      pushUndo('nudge', 700); // 连续微调合并为一步撤销
      for (const k of selectedKeys) {
        const el = elementByKey(k);
        if (!el) continue;
        const c = clampVisual(el, k, el.x + moves[e.key][0], el.y + moves[e.key][1]);
        el.x = c.x;
        el.y = c.y;
      }
      renderPreview();
      syncElementInputs(selectedElement);
      scheduleAutoSave();
      return;
    }
    if (mod && (e.key === 'c' || e.key === 'C')) {
      const picked = selectedKeys
        .filter((k) => k.startsWith('custom:'))
        .map((k) => elementByKey(k))
        .filter(Boolean)
        .map(deepCopy);
      if (!picked.length) {
        showToast('固定元素不支持复制，只能复制自定义文本元素', 'warn');
        return;
      }
      clipboardCustom = picked;
      showToast(picked.length > 1 ? `已复制 ${picked.length} 个元素` : '已复制元素', 'success');
      e.preventDefault();
      return;
    }
    if (mod && (e.key === 'v' || e.key === 'V')) {
      if (!clipboardCustom || !clipboardCustom.length) { showToast('没有可粘贴的元素', 'warn'); return; }
      pushUndo();
      const pasted = [];
      for (const src of clipboardCustom) {
        const copy = LabelRender.normalizeCustomElement(deepCopy(src));
        copy.id = LabelRender.newCustomId();
        copy.y = Math.round((copy.y + 6) * 10) / 10; // 粘贴副本向下偏移，避免重叠
        designerSettings.custom.push(copy);
        pasted.push('custom:' + copy.id);
      }
      setSelection(pasted);
      afterLayoutChange();
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' || e.key === 'Backspace') {
      const customKeys = selectedKeys.filter((k) => k.startsWith('custom:'));
      const fixedCount = selectedKeys.length - customKeys.length;
      if (!customKeys.length) {
        if (fixedCount > 0) showToast('固定元素只能隐藏，不能删除（用卡片上的"显示"开关）', 'warn');
        return;
      }
      (async () => {
        let ok = true;
        if (customKeys.length > 1) {
          ok = await confirmDialog(`确定删除选中的 ${customKeys.length} 个自定义元素吗？`, '删除元素');
          if (!ok) return;
        }
        pushUndo();
        const ids = new Set(customKeys.map((k) => k.slice(7)));
        designerSettings.custom = designerSettings.custom.filter((c) => !ids.has(c.id));
        setSelection(selectedKeys.filter((k) => !k.startsWith('custom:') || !ids.has(k.slice(7))));
        afterLayoutChange();
        if (fixedCount > 0) showToast('固定元素只能隐藏，未删除', 'warn');
      })();
      e.preventDefault();
    }
  });

  $('btnBackup').addEventListener('click', doBackup);
  $('btnRestore').addEventListener('click', doRestore);
  $('btnOpenFolder').addEventListener('click', () => window.api.openDataFolder());

  ['fName', 'fSku', 'fBarcode', 'fBarcodeType'].forEach((id) => {
    $(id).addEventListener('input', updateBarcodePreview);
    $(id).addEventListener('change', updateBarcodePreview);
  });
}

/* ---------------- 启动 ---------------- */

(async function init() {
  bindEvents();
  const data = await window.api.loadData();
  products = data.products || [];
  dataDir = data.dataDir || '';
  resetForm();
  refreshCategoryDatalist();
  renderList();
})();
