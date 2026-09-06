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

// 生成条码图片的 data URL（canvas 渲染 → PNG dataURL，仅供条码竖条，数字由 HTML 渲染）
function barcodeSvgString(type, value) {
  const norm = normalizeBarcode(type, value);
  if (!norm.ok) return '';
  const canvas = document.createElement('canvas');
  JsBarcode(canvas, norm.value, {
    format: type,
    displayValue: false,
    width: 8,
    height: 180,
    margin: 4,
  });
  return canvas.toDataURL('image/png');
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

function filteredProducts() {
  const q = searchText.trim().toLowerCase();
  if (!q) return products;
  return products.filter((p) =>
    (p.name || '').toLowerCase().includes(q) ||
    (p.sku || '').toLowerCase().includes(q) ||
    (p.barcode || '').toLowerCase().includes(q)
  );
}

function renderList() {
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
    if (res && !res.ok && res.error) {
      showToast('打印失败：' + res.error, 'error');
    }
  } catch (e) {
    showToast('打印出错：' + (e && e.message ? e.message : e), 'error');
  } finally {
    modal.classList.add('hidden');
    $('printModal').dataset.payload = '';
  }
}

/* ---------------- 打印设计器 ---------------- */

const MM_TO_PX = 3.7795;       // 1mm ≈ 3.7795px（96dpi）
const MAX_PREVIEW_SCALE = 3;   // 预览最大放大倍数（小标签放大用）
let currentPreviewScale = 3;   // 当前实际缩放倍数（自适应，拖拽换算也用它）
let designerSettings = null;   // 当前设计器设置（normalize 后）
let designerProducts = [];     // 当前待打印商品（含 barcodeSvg）
let selectedElement = null;    // 当前选中的元素 key
let dragging = null;           // 拖拽状态 { key, startX, startY, origX, origY }
let printPresets = {};         // 打印预设：{ 预设名: settings }（内存态）
let activePreset = '默认';     // 当前选中的预设名
let clipboardCustom = null;    // 复制的自定义元素（Ctrl+C/V 用）

const deepCopy = (o) => JSON.parse(JSON.stringify(o));

const ELEMENT_LABELS = {
  name: { name: '商品名称', hint: '商品名称' },
  price: { name: '价格', hint: '¥12.50' },
  sku: { name: 'SKU / 货号', hint: 'SKU-0001' },
  barcode: { name: '条形码', hint: '条码' },
};

const ELEMENT_FIELDS = {
  name:    ['x', 'y', 'w', 'fontSize', 'align', 'bold'],
  price:   ['x', 'y', 'w', 'fontSize', 'align', 'bold'],
  sku:     ['x', 'y', 'w', 'fontSize', 'align', 'bold'],
  barcode: ['x', 'y', 'w', 'h', 'fontSize', 'align'],
};

// 自定义元素可编辑字段（text 文本、color 颜色走特殊控件）
const CUSTOM_FIELDS = ['text', 'x', 'y', 'w', 'fontSize', 'align', 'bold', 'color'];

const FIELD_LABELS = {
  x: 'X 位置', y: 'Y 位置', w: '宽度', h: '高度',
  fontSize: '字号', align: '对齐', bold: '加粗',
  text: '文本内容', color: '颜色',
};

// 根据 key 取元素：'custom:<id>' → 自定义元素；其他 → 固定元素
function elementByKey(key) {
  if (key && key.startsWith('custom:')) {
    const id = key.slice(7);
    return (designerSettings.custom || []).find((c) => c.id === id);
  }
  return designerSettings.elements[key];
}

async function openDesigner(products) {
  designerProducts = products;
  selectedElement = 'name'; // 默认展开第一个元素参数
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
  buildPresetSelect();
  buildElementPanel();
  renderPreview();
  // 打印选项：记住上次打印机/方向/份数
  loadPrinterOptions();
  $('printModal').classList.remove('hidden');
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
  return {
    deviceName: $('optPrinter').value || '',
    landscape: $('optLandscape').value === '1',
    copies: Math.max(1, Math.round(Number($('optCopies').value) || 1)),
    silent: $('optSilent').checked,
  };
}

function savePrinterOptionsNow() {
  window.api.savePrintOptions(currentPrintOptions()).catch(() => {});
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
  card.className = 'element-card' + (selectedElement === key ? ' active' : '');
  card.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'element-card-head';
  head.innerHTML = `<span>${title}</span>
    <label class="el-visible" title="显示/隐藏"><input type="checkbox" ${el.visible ? 'checked' : ''}> 显示</label>`;
  head.querySelector('input').addEventListener('change', (e) => {
    designerSettings.elements[key].visible = e.target.checked;
    renderPreview();
  });
  head.addEventListener('click', (e) => {
    if (e.target.tagName === 'INPUT') return;
    selectedElement = key;
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

function buildCustomCard(c, idx) {
  const key = 'custom:' + c.id;
  const card = document.createElement('div');
  card.className = 'element-card element-card-custom' + (selectedElement === key ? ' active' : '');
  card.dataset.key = key;

  const head = document.createElement('div');
  head.className = 'element-card-head';
  head.innerHTML = `<span>✏️ 自定义 ${idx + 1}</span>
    <label class="el-visible" title="显示/隐藏"><input type="checkbox" ${c.visible ? 'checked' : ''}> 显示</label>`;
  head.querySelector('input').addEventListener('change', (e) => {
    c.visible = e.target.checked;
    renderPreview();
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
    selectedElement = key;
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
function buildFieldControl(key, field, getEl) {
  const lab = document.createElement('label');
  lab.innerHTML = `<span>${FIELD_LABELS[field]}</span>`;
  if (field === 'align') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="left">左</option><option value="center">中</option><option value="right">右</option>';
    sel.value = getEl().align || 'left';
    sel.addEventListener('change', () => {
      getEl().align = sel.value;
      renderPreview();
    });
    lab.appendChild(sel);
  } else if (field === 'bold') {
    const sel = document.createElement('select');
    sel.innerHTML = '<option value="0">否</option><option value="1">是</option>';
    sel.value = getEl().bold ? '1' : '0';
    sel.addEventListener('change', () => {
      getEl().bold = sel.value === '1';
      renderPreview();
    });
    lab.appendChild(sel);
  } else if (field === 'text') {
    const inp = document.createElement('input');
    inp.type = 'text';
    inp.maxLength = 60;
    inp.value = getEl().text || '';
    inp.addEventListener('input', () => {
      getEl().text = inp.value;
      renderPreview();
    });
    lab.appendChild(inp);
  } else if (field === 'color') {
    const inp = document.createElement('input');
    inp.type = 'color';
    inp.value = getEl().color || '#000000';
    inp.addEventListener('input', () => {
      getEl().color = inp.value;
      renderPreview();
    });
    lab.appendChild(inp);
  } else {
    const inp = document.createElement('input');
    inp.type = 'number';
    inp.step = '0.1';
    inp.min = '0';
    inp.value = getEl()[field];
    inp.addEventListener('input', () => {
      const v = parseFloat(inp.value);
      if (!isNaN(v) && v >= 0) {
        getEl()[field] = Math.round(v * 10) / 10;
        renderPreview();
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
  designerSettings.custom.push(c);
  selectedElement = 'custom:' + c.id;
  buildElementPanel();
  renderPreview();
  showToast('已添加自定义文本，可在预览中拖动', 'success');
}

// 向下复制出一个相同元素（新元素 Y 偏移 +6mm，避免重叠）
function duplicateCustomElement(id) {
  const src = designerSettings.custom.find((c) => c.id === id);
  if (!src) return;
  const copy = LabelRender.normalizeCustomElement(deepCopy(src));
  copy.id = LabelRender.newCustomId(); // 复制必须换新 id，否则与原件冲突
  copy.y = Math.round((src.y + 6) * 10) / 10;
  designerSettings.custom.push(copy);
  selectedElement = 'custom:' + copy.id;
  buildElementPanel();
  renderPreview();
}

function removeCustomElement(id) {
  designerSettings.custom = designerSettings.custom.filter((c) => c.id !== id);
  if (selectedElement === 'custom:' + id) selectedElement = 'name';
  buildElementPanel();
  renderPreview();
}

// 预览用单位：mm → px（自适应缩放）
function unitMM(v) { return Math.round(v * MM_TO_PX * currentPreviewScale) + 'px'; }

// 预览中元素的实际 px 尺寸（用于拖拽换算）
function mmToPx(v) { return v * MM_TO_PX * currentPreviewScale; }

// ---------------- 对齐吸附与参考线 ----------------

const SNAP_DIST = 0.5; // 吸附阈值（mm）：元素边缘相差小于此值即吸附

// 元素关键边缘（mm 坐标系）；文本元素高度按字号估算
function elementEdges(el) {
  const w = el.w || 0;
  const h = el.h || (el.fontSize || 0) * 1.3;
  return {
    left: el.x, centerX: el.x + w / 2, right: el.x + w,
    top: el.y, centerY: el.y + h / 2, bottom: el.y + h,
    w, h,
  };
}

// 收集其他可见元素的边缘候选（排除当前拖动的元素）
function collectSnapCandidates(excludeKey) {
  const xs = [];
  const ys = [];
  const addEl = (key, el) => {
    if (!el.visible) return;
    const e = elementEdges(el);
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
function bestSnap(val, candidates) {
  let best = null;
  for (const c of candidates) {
    const d = c - val;
    if (Math.abs(d) <= SNAP_DIST && (!best || Math.abs(d) < Math.abs(best.delta))) {
      best = { delta: d, snapTo: c };
    }
  }
  return best;
}

// 计算拖拽吸附：返回 { tx, ty, gx, gy }（gx/gy 为参考线位置，null 表示不显示）
function computeSnap(key, el, tx, ty) {
  const cand = collectSnapCandidates(key);
  const e = elementEdges({ ...el, x: tx, y: ty });
  let gx = null, gy = null;
  // 水平（X）方向：左边缘 / 中心线（被拖动元素的右边缘不参与吸附，避免右端被吸走）
  const xCand = [
    { offset: 0, val: e.left },
    { offset: e.w / 2, val: e.centerX },
  ];
  let bestX = null;
  for (const c of xCand) {
    const s = bestSnap(c.val, cand.xs);
    if (s && (!bestX || Math.abs(s.delta) < Math.abs(bestX.snap.delta))) bestX = { offset: c.offset, snap: s };
  }
  if (bestX) { tx = Math.max(0, Math.round((tx + bestX.snap.delta) * 10) / 10); gx = bestX.snap.snapTo; }
  // 垂直（Y）方向
  const yCand = [
    { offset: 0, val: e.top },
    { offset: e.h / 2, val: e.centerY },
    { offset: e.h, val: e.bottom },
  ];
  let bestY = null;
  for (const c of yCand) {
    const s = bestSnap(c.val, cand.ys);
    if (s && (!bestY || Math.abs(s.delta) < Math.abs(bestY.snap.delta))) bestY = { offset: c.offset, snap: s };
  }
  if (bestY) { ty = Math.max(0, Math.round((ty + bestY.snap.delta) * 10) / 10); gy = bestY.snap.snapTo; }
  return { tx, ty, gx, gy };
}

// 显示对齐参考线（gx/gy 为 mm 坐标，null 不显示该方向；挂到标签坐标系内，跟随旋转）
function showGuides(gx, gy) {
  const label = $('previewLabel');
  if (!label) return;
  label.querySelectorAll('.guide-v, .guide-h').forEach((n) => n.remove());
  if (gx != null) {
    const d = document.createElement('div');
    d.className = 'guide-v';
    d.style.left = unitMM(gx);
    label.appendChild(d);
  }
  if (gy != null) {
    const d = document.createElement('div');
    d.className = 'guide-h';
    d.style.top = unitMM(gy);
    label.appendChild(d);
  }
}

function clearGuides() {
  const label = $('previewLabel');
  if (!label) return;
  label.querySelectorAll('.guide-v, .guide-h').forEach((n) => n.remove());
}

function renderPreview() {
  const stage = $('previewStage');
  const labelEl = $('previewLabel');
  const cfg = LabelRender.SIZE_CFG[designerSettings.labelSize];
  const isA4 = designerSettings.labelSize === 'a4';
  // 打印方向：横向时整个标签旋转 90°（预览与真实打印一致）
  const landscape = $('optLandscape') && $('optLandscape').value === '1';
  const labelW = isA4 ? 60 : cfg.w;
  const labelH = isA4 ? 40 : cfg.h;

  // 预览区画布尺寸（A4 显示整页，其他按标签本体）
  const stageW = isA4 ? cfg.w : labelW;
  const stageH = isA4 ? cfg.h : labelH;

  // 视觉显示尺寸：横向时宽高交换（标签旋转 90° 后占位）
  const dispW = landscape ? stageH : stageW;
  const dispH = landscape ? stageW : stageH;

  // 自适应缩放：完整显示标签，小标签放大、大标签缩小
  const rightPane = document.querySelector('.designer-right');
  const availW = (rightPane ? rightPane.clientWidth : 700) - 50;
  const availH = (rightPane ? rightPane.clientHeight : 560) - 70;
  const scaleByW = availW / (dispW * MM_TO_PX);
  const scaleByH = availH / (dispH * MM_TO_PX);
  currentPreviewScale = Math.max(0.4, Math.min(MAX_PREVIEW_SCALE, scaleByW, scaleByH));

  stage.style.width = mmToPx(dispW) + 'px';
  stage.style.height = mmToPx(dispH) + 'px';
  // 标签本体尺寸保持原方向，旋转由 CSS transform 完成（横向 = 真实打印方向）
  labelEl.style.width = mmToPx(stageW) + 'px';
  labelEl.style.height = mmToPx(stageH) + 'px';
  labelEl.style.position = 'absolute';
  labelEl.style.left = '50%';
  labelEl.style.top = '50%';
  labelEl.style.transform = landscape
    ? 'translate(-50%, -50%) rotate(90deg)'
    : 'translate(-50%, -50%)';

  // 预览商品：用第一个商品作为样板
  const sample = designerProducts[0] || { name: '商品名称', sku: 'SKU-0001', price: 12.5, barcodeSvg: '' };

  const body = [];
  const el = designerSettings.elements;
  if (el.name.visible && sample.name) {
    body.push(`<div class="el el-name" data-key="name" style="left:${unitMM(el.name.x)};top:${unitMM(el.name.y)};width:${unitMM(el.name.w)};font-size:${unitMM(el.name.fontSize)};text-align:${el.name.align};font-weight:${el.name.bold ? 'bold' : 'normal'};color:${el.name.color};">${LabelRender.esc(sample.name)}</div>`);
  }
  if (el.price.visible && sample.price !== '' && sample.price != null) {
    body.push(`<div class="el el-price" data-key="price" style="left:${unitMM(el.price.x)};top:${unitMM(el.price.y)};width:${unitMM(el.price.w)};font-size:${unitMM(el.price.fontSize)};text-align:${el.price.align};font-weight:${el.price.bold ? 'bold' : 'normal'};color:${el.price.color};">¥${Number(sample.price).toFixed(2)}</div>`);
  }
  if (el.sku.visible && sample.sku) {
    body.push(`<div class="el el-sku" data-key="sku" style="left:${unitMM(el.sku.x)};top:${unitMM(el.sku.y)};width:${unitMM(el.sku.w)};font-size:${unitMM(el.sku.fontSize)};text-align:${el.sku.align};font-weight:${el.sku.bold ? 'bold' : 'normal'};color:${el.sku.color};">${LabelRender.esc(sample.sku)}</div>`);
  }
  if (el.barcode.visible && sample.barcodeSvg) {
    body.push(`<img class="el el-barcode" data-key="barcode" src="${sample.barcodeSvg}" alt="barcode" style="left:${unitMM(el.barcode.x)};top:${unitMM(el.barcode.y)};width:${unitMM(el.barcode.w)};height:${unitMM(el.barcode.h)};">`);
    if (sample.barcodeText && el.barcode.fontSize > 0) {
      body.push(`<div class="el el-barcode-text" data-key="barcode" style="left:${unitMM(el.barcode.x)};top:${unitMM(el.barcode.y + el.barcode.h)};width:${unitMM(el.barcode.w)};font-size:${unitMM(el.barcode.fontSize)};text-align:${el.barcode.align};">${LabelRender.esc(sample.barcodeText)}</div>`);
    }
  }
  // 自定义元素
  (designerSettings.custom || []).forEach((c) => {
    if (!c.visible) return;
    body.push(`<div class="el el-custom" data-key="custom:${c.id}" style="left:${unitMM(c.x)};top:${unitMM(c.y)};width:${unitMM(c.w)};font-size:${unitMM(c.fontSize)};text-align:${c.align};font-weight:${c.bold ? 'bold' : 'normal'};color:${c.color};">${LabelRender.esc(c.text)}</div>`);
  });

  labelEl.innerHTML = body.join('\n');

  // 事件：拖拽 + 选中
  labelEl.querySelectorAll('.el').forEach((node) => {
    const key = node.dataset.key;
    if (selectedElement === key) node.classList.add('selected');
    node.addEventListener('mousedown', (e) => startDrag(e, key, node));
  });

  const cfgInfo = LabelRender.SIZE_CFG[designerSettings.labelSize];
  $('previewMeta').textContent = `标签 ${cfgInfo.label} · 方向 ${landscape ? '横向' : '纵向'} · 预览缩放 ${Math.round(currentPreviewScale * 100) / 100} 倍 · 拖动元素调整位置`;
  clearGuides();
}

function startDrag(e, key, node) {
  e.preventDefault();
  e.stopPropagation();
  selectedElement = key;
  buildElementPanel();
  renderPreview();
  // 重新获取节点（renderPreview 重建了 DOM）
  const fresh = document.querySelector(`.el[data-key="${CSS.escape(key)}"]`);
  if (!fresh) return;
  const orig = elementByKey(key);
  if (!orig) return;
  dragging = {
    key,
    origX: orig.x,
    origY: orig.y,
    startPX: e.clientX,
    startPY: e.clientY,
  };
  document.body.style.cursor = 'move';
  clearGuides();
  const onMove = (ev) => {
    if (!dragging) return;
    const landscape = $('optLandscape') && $('optLandscape').value === '1';
    // 屏幕位移 → 内容坐标位移（横向时标签旋转 90°，方向需换算）
    const sxMM = (ev.clientX - dragging.startPX) / mmToPx(1);
    const syMM = (ev.clientY - dragging.startPY) / mmToPx(1);
    const dxMM = landscape ? -syMM : sxMM;
    const dyMM = landscape ? sxMM : syMM;
    const el = elementByKey(dragging.key);
    if (!el) return;
    // 未吸附的目标位置
    const txRaw = Math.max(0, Math.round((dragging.origX + dxMM) * 10) / 10);
    const tyRaw = Math.max(0, Math.round((dragging.origY + dyMM) * 10) / 10);
    // 对齐吸附 + 参考线
    const snap = computeSnap(dragging.key, el, txRaw, tyRaw);
    el.x = snap.tx;
    el.y = snap.ty;
    renderPreview();
    syncElementInputs(dragging.key);
    showGuides(snap.gx, snap.gy);
  };
  const onUp = () => {
    dragging = null;
    document.body.style.cursor = '';
    clearGuides();
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
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
  const fieldOrder = fields.filter((f) => f !== 'align' && f !== 'bold' && f !== 'text' && f !== 'color');
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
    $('printModal').classList.add('hidden');
  });
  $('btnPrintConfirm').addEventListener('click', doPrint);

  // 打印预设
  $('presetSelect').addEventListener('change', async (e) => {
    if (!designerSettings) return;
    const name = e.target.value;
    if (!printPresets[name]) return;
    // 切换预设：可能把当前未保存的调整丢弃，先确认
    activePreset = name;
    designerSettings = LabelRender.normalizeSettings(printPresets[name]);
    $('printSize').value = designerSettings.labelSize;
    buildElementPanel();
    renderPreview();
  });
  $('btnPresetSave').addEventListener('click', saveToActivePreset);
  $('btnPresetNew').addEventListener('click', saveAsPreset);
  $('btnPresetDelete').addEventListener('click', deletePreset);

  // 自定义元素
  $('btnAddCustom').addEventListener('click', addCustomElement);

  // 打印选项（打印机/方向/份数/静默）变更即保存
  $('optPrinter').addEventListener('change', savePrinterOptionsNow);
  $('optLandscape').addEventListener('change', () => {
    savePrinterOptionsNow();
    if (designerSettings) renderPreview(); // 方向切换即时重绘预览
  });
  $('optCopies').addEventListener('input', savePrinterOptionsNow);
  $('optSilent').addEventListener('change', savePrinterOptionsNow);

  $('printSize').addEventListener('change', (e) => {
    if (!designerSettings) return;
    designerSettings = LabelRender.normalizeSettings({ labelSize: e.target.value, custom: designerSettings.custom });
    $('printSize').value = designerSettings.labelSize;
    buildElementPanel();
    renderPreview();
  });

  $('btnResetLayout').addEventListener('click', () => {
    if (!designerSettings) return;
    designerSettings = LabelRender.normalizeSettings({ labelSize: designerSettings.labelSize, custom: designerSettings.custom });
    buildElementPanel();
    renderPreview();
    showToast('已恢复默认布局', 'success');
  });

  // 键盘：方向键微调、Ctrl+C/V 复制粘贴自定义元素、Delete 删除
  document.addEventListener('keydown', (e) => {
    if ($('printModal').classList.contains('hidden')) return;
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    if (!selectedElement) return;

    const step = e.shiftKey ? 2 : 0.5;
    const moves = {
      ArrowLeft: [-step, 0], ArrowRight: [step, 0],
      ArrowUp: [0, -step], ArrowDown: [0, step],
    };
    if (moves[e.key]) {
      e.preventDefault();
      const el = elementByKey(selectedElement);
      if (!el) return;
      el.x = Math.max(0, Math.round((el.x + moves[e.key][0]) * 10) / 10);
      el.y = Math.max(0, Math.round((el.y + moves[e.key][1]) * 10) / 10);
      renderPreview();
      syncElementInputs(selectedElement);
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'c' || e.key === 'C')) {
      if (!selectedElement.startsWith('custom:')) return;
      clipboardCustom = deepCopy(elementByKey(selectedElement));
      showToast('已复制元素', 'success');
      e.preventDefault();
      return;
    }
    if ((e.ctrlKey || e.metaKey) && (e.key === 'v' || e.key === 'V')) {
      if (!clipboardCustom) { showToast('没有可粘贴的元素', 'warn'); return; }
      const copy = LabelRender.normalizeCustomElement(deepCopy(clipboardCustom));
      copy.id = LabelRender.newCustomId();
      copy.y = Math.round((copy.y + 6) * 10) / 10;
      designerSettings.custom.push(copy);
      selectedElement = 'custom:' + copy.id;
      buildElementPanel();
      renderPreview();
      e.preventDefault();
      return;
    }
    if (e.key === 'Delete' && selectedElement.startsWith('custom:')) {
      removeCustomElement(selectedElement.slice(7));
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
