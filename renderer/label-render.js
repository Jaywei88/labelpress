/* ============================================================
 * label-render.js — 标签渲染共享模块（UMD）
 * 预览和打印共用同一套布局逻辑，保证所见即所得。
 * 浏览器: <script> 后 window.LabelRender
 * 主进程: require('./renderer/label-render.js')
 * 所有坐标/尺寸单位为 mm（毫米），由 unitFn 换算成最终单位。
 * ============================================================ */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) {
    module.exports = factory();
  } else {
    root.LabelRender = factory();
  }
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------- 尺寸配置 ----------------
  const SIZE_CFG = {
    '60x40': { w: 60, h: 40, page: '@page { size: 60mm 40mm; margin: 0; }', label: '60×40 mm' },
    '50x30': { w: 50, h: 30, page: '@page { size: 50mm 30mm; margin: 0; }', label: '50×30 mm' },
    '40x30': { w: 40, h: 30, page: '@page { size: 40mm 30mm; margin: 0; }', label: '40×30 mm' },
    '40x25': { w: 40, h: 25, page: '@page { size: 40mm 25mm; margin: 0; }', label: '40×25 mm' },
    '30x40': { w: 30, h: 40, page: '@page { size: 30mm 40mm; margin: 0; }', label: '30×40 mm（竖版）' },
    '80x100': { w: 80, h: 100, page: '@page { size: 80mm 100mm; margin: 0; }', label: '80×100 mm' },
    '100x80': { w: 100, h: 80, page: '@page { size: 100mm 80mm; margin: 0; }', label: '100×80 mm' },
    'a4':    { w: 210, h: 297, page: '@page { size: A4; margin: 8mm; }', label: 'A4 整页' },
  };

  // A4 模式下单个标签的本体尺寸（网格排列）
  const A4_LABEL_W = 60;
  const A4_LABEL_H = 40;

  // ---------------- 各尺寸默认元素布局 ----------------
  const ELEMENT_KEYS = ['name', 'price', 'sku', 'barcode'];

  // 自定义元素默认字段（新增自定义文本元素时使用）
  function newCustomId() {
    return 'c' + Date.now().toString(36) + Math.floor(Math.random() * 46656).toString(36).padStart(3, '0');
  }

  function normalizeCustomElement(el) {
    el = el || {};
    const text = String(el.text == null ? '' : el.text);
    // 名称：未手动改名（nameLocked）时自动取文本前 5 字；手动改过后以用户名称为准
    const nameLocked = !!el.nameLocked;
    const name = nameLocked && el.name != null ? String(el.name) : text.slice(0, 5);
    return {
      id: el.id || newCustomId(),
      type: 'text',
      text,
      name,
      nameLocked,
      visible: el.visible !== false,
      x: numberOr(el.x, 2),
      y: numberOr(el.y, 2),
      w: numberOr(el.w, 50),
      fontSize: numberOr(el.fontSize, 3.5),
      align: ['left', 'center', 'right'].includes(el.align) ? el.align : 'left',
      bold: !!el.bold,
      color: el.color || '#000000',
      rot: normalizeRot(el.rot),
      vertical: !!el.vertical,
    };
  }

  function numberOr(v, def) {
    const n = Number(v);
    return isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : def;
  }

  // 打印设备选项（打印机/方向/份数/静默/偏移）随预设记忆；无输入时返回 null（旧预设回退全局记忆）
  function normalizePrintOptions(o) {
    if (!o || typeof o !== 'object') return null;
    return {
      deviceName: String(o.deviceName || ''),
      landscape: !!o.landscape,
      copies: Math.max(1, Math.min(999, Math.round(Number(o.copies) || 1))),
      silent: o.silent === false ? false : true,
      offsetX: clampOffset(o.offsetX),
      offsetY: clampOffset(o.offsetY),
    };
  }

  function clampOffset(v) {
    const n = Number(v);
    if (!isFinite(n)) return 0;
    return Math.max(-20, Math.min(20, Math.round(n * 10) / 10));
  }

  // 元素旋转角度：只允许 0/90/180/270（度），覆盖竖排文本等常见需求
  function normalizeRot(v) {
    const n = Number(v) || 0;
    return [90, 180, 270].includes(n) ? n : 0;
  }

  const DEFAULT_ELEMENTS = {
    name:    { visible: true, x: 2, y: 2,  w: 56, fontSize: 3.5, align: 'center', bold: true,  color: '#000000' },
    price:   { visible: true, x: 2, y: 28, w: 56, fontSize: 4.5, align: 'center', bold: true,  color: '#c0392b' },
    sku:     { visible: true, x: 2, y: 35, w: 56, fontSize: 2.5, align: 'center', bold: false, color: '#333333' },
    barcode: { visible: true, x: 2, y: 8,  w: 56, h: 16, fontSize: 3.2, align: 'center' },
  };

  // 各尺寸独立默认布局（手工优化；未列出的尺寸按 60x40 比例缩放）
  const PER_SIZE_LAYOUTS = {
    '60x40': DEFAULT_ELEMENTS,
    '50x30': {
      name:    { visible: true, x: 1.5, y: 1.5, w: 47, fontSize: 3,   align: 'center', bold: true,  color: '#000000' },
      price:   { visible: true, x: 1.5, y: 21, w: 47, fontSize: 3.8, align: 'center', bold: true,  color: '#c0392b' },
      sku:     { visible: true, x: 1.5, y: 26, w: 47, fontSize: 2.2, align: 'center', bold: false, color: '#333333' },
      barcode: { visible: true, x: 1.5, y: 6,  w: 47, h: 12, fontSize: 2.6, align: 'center' },
    },
    '40x30': {
      name:    { visible: true, x: 1.5, y: 1.5, w: 37, fontSize: 2.8, align: 'center', bold: true,  color: '#000000' },
      price:   { visible: true, x: 1.5, y: 21, w: 37, fontSize: 3.6, align: 'center', bold: true,  color: '#c0392b' },
      sku:     { visible: true, x: 1.5, y: 26, w: 37, fontSize: 2,   align: 'center', bold: false, color: '#333333' },
      barcode: { visible: true, x: 1.5, y: 6,  w: 37, h: 12, fontSize: 2.4, align: 'center' },
    },
    '40x25': {
      name:    { visible: true, x: 1.5, y: 1.2, w: 37, fontSize: 2.6, align: 'center', bold: true,  color: '#000000' },
      price:   { visible: true, x: 1.5, y: 17, w: 37, fontSize: 3.4, align: 'center', bold: true,  color: '#c0392b' },
      sku:     { visible: true, x: 1.5, y: 21.5, w: 37, fontSize: 2, align: 'center', bold: false, color: '#333333' },
      barcode: { visible: true, x: 1.5, y: 5,  w: 37, h: 10, fontSize: 2.2, align: 'center' },
    },
    '30x40': {
      // 竖版：名称顶部，条码居中较大，价格底部
      name:    { visible: true, x: 2, y: 2,   w: 26, fontSize: 3,   align: 'center', bold: true,  color: '#000000' },
      price:   { visible: true, x: 2, y: 31,  w: 26, fontSize: 4,   align: 'center', bold: true,  color: '#c0392b' },
      sku:     { visible: true, x: 2, y: 36,  w: 26, fontSize: 2.2, align: 'center', bold: false, color: '#333333' },
      barcode: { visible: true, x: 2, y: 8,   w: 26, h: 18, fontSize: 2.6, align: 'center' },
    },
    '80x100': {
      // 大标签：名称、条码、价格、SKU 竖排，字大
      name:    { visible: true, x: 4, y: 4,   w: 72, fontSize: 6,   align: 'center', bold: true,  color: '#000000' },
      price:   { visible: true, x: 4, y: 72,  w: 72, fontSize: 9,   align: 'center', bold: true,  color: '#c0392b' },
      sku:     { visible: true, x: 4, y: 88,  w: 72, fontSize: 4,   align: 'center', bold: false, color: '#333333' },
      barcode: { visible: true, x: 4, y: 16,  w: 72, h: 44, fontSize: 5, align: 'center' },
    },
    '100x80': {
      name:    { visible: true, x: 4, y: 3,   w: 92, fontSize: 6,   align: 'center', bold: true,  color: '#000000' },
      price:   { visible: true, x: 4, y: 58,  w: 92, fontSize: 8,   align: 'center', bold: true,  color: '#c0392b' },
      sku:     { visible: true, x: 4, y: 72,  w: 92, fontSize: 4,   align: 'center', bold: false, color: '#333333' },
      barcode: { visible: true, x: 4, y: 12,  w: 92, h: 38, fontSize: 5, align: 'center' },
    },
  };

  // 按标签尺寸取默认布局（有独立布局用独立布局，否则按 60x40 比例缩放）
  function defaultsForSize(size) {
    if (PER_SIZE_LAYOUTS[size]) return deepCopy(PER_SIZE_LAYOUTS[size]);
    const base = SIZE_CFG[size] || SIZE_CFG['60x40'];
    const scale = (size === 'a4') ? 1 : (base.w / 60);
    const out = {};
    for (const k of ELEMENT_KEYS) {
      const e = DEFAULT_ELEMENTS[k];
      const n = { ...e };
      if (typeof e.x === 'number') n.x = round1(e.x * scale);
      if (typeof e.y === 'number') n.y = round1(e.y * scale);
      if (typeof e.w === 'number') n.w = round1(e.w * scale);
      if (typeof e.h === 'number') n.h = round1(e.h * scale);
      if (typeof e.fontSize === 'number') n.fontSize = round1(e.fontSize * scale);
      out[k] = n;
    }
    return out;
  }

  function deepCopy(o) {
    return JSON.parse(JSON.stringify(o));
  }

  function round1(v) { return Math.round(v * 10) / 10; }

  // 深合并：把 defaults 与 user 合并，补齐缺失字段（含旋转角度）
  function mergeElements(defaults, user) {
    const out = {};
    for (const k of ELEMENT_KEYS) {
      const d = defaults[k];
      const u = (user && user[k]) || {};
      out[k] = { ...d, ...u };
      out[k].rot = normalizeRot(out[k].rot);
    }
    return out;
  }

  // 规范化设置：补齐缺失字段、修正越界值；printOptions（若记忆过）原样保留
  function normalizeSettings(settings) {
    settings = settings || {};
    const size = SIZE_CFG[settings.labelSize] ? settings.labelSize : '60x40';
    const defaults = defaultsForSize(size);
    const custom = Array.isArray(settings.custom) ? settings.custom.map(normalizeCustomElement) : [];
    const out = {
      labelSize: size,
      elements: mergeElements(defaults, settings.elements),
      custom,
    };
    const po = normalizePrintOptions(settings.printOptions);
    if (po) out.printOptions = po;
    return out;
  }

  // ---------------- 渲染 ----------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 单个标签的 HTML。unit(mmV) 把 mm 数值换成目标单位字符串（打印 'mm'，预览 'px'）
  // rotTransform：旋转元素的 CSS 片段（绕中心旋转，视觉包围盒在 elementEdges 里对应换算）
  function rotTransform(el) {
    return el.rot ? `transform-origin:center;transform:rotate(${el.rot}deg);` : '';
  }

  // 竖排：字直立、逐字从上往下（writing-mode vertical-lr 保证首列贴盒左缘；upright 让数字/字母也直立）
  function verticalStyle(el) {
    return el.vertical ? 'writing-mode:vertical-lr;text-orientation:upright;' : '';
  }

  function renderLabelHTML(p, elements, custom, unit) {
    const parts = [];
    const e = elements;

    if (e.name.visible && p.name) {
      parts.push(`<div class="el el-name" style="left:${unit(e.name.x)};top:${unit(e.name.y)};width:${unit(e.name.w)};font-size:${unit(e.name.fontSize)};text-align:${e.name.align};font-weight:${e.name.bold ? 'bold' : 'normal'};color:${e.name.color};${rotTransform(e.name)}${verticalStyle(e.name)}">${esc(p.name)}</div>`);
    }
    if (e.price.visible && p.price !== '' && p.price != null) {
      parts.push(`<div class="el el-price" style="left:${unit(e.price.x)};top:${unit(e.price.y)};width:${unit(e.price.w)};font-size:${unit(e.price.fontSize)};text-align:${e.price.align};font-weight:${e.price.bold ? 'bold' : 'normal'};color:${e.price.color};${rotTransform(e.price)}${verticalStyle(e.price)}">¥${Number(p.price).toFixed(2)}</div>`);
    }
    if (e.sku.visible && p.sku) {
      parts.push(`<div class="el el-sku" style="left:${unit(e.sku.x)};top:${unit(e.sku.y)};width:${unit(e.sku.w)};font-size:${unit(e.sku.fontSize)};text-align:${e.sku.align};font-weight:${e.sku.bold ? 'bold' : 'normal'};color:${e.sku.color};${rotTransform(e.sku)}${verticalStyle(e.sku)}">${esc(p.sku)}</div>`);
    }
    if (e.barcode.visible && p.barcodeSvg) {
      parts.push(`<img class="el el-barcode" src="${p.barcodeSvg}" alt="barcode" style="left:${unit(e.barcode.x)};top:${unit(e.barcode.y)};width:${unit(e.barcode.w)};height:${unit(e.barcode.h)};${rotTransform(e.barcode)}">`);
      // 条码下方数字（HTML 文本渲染，清晰可调）
      if (p.barcodeText && e.barcode.fontSize > 0) {
        parts.push(`<div class="el el-barcode-text" style="left:${unit(e.barcode.x)};top:${unit(e.barcode.y + e.barcode.h)};width:${unit(e.barcode.w)};font-size:${unit(e.barcode.fontSize)};text-align:${e.barcode.align};${rotTransform({ rot: e.barcode.rot })}">${esc(p.barcodeText)}</div>`);
      }
    }
    // 自定义元素（自由文本，可任意添加/复制/移动/旋转）
    for (const c of custom || []) {
      if (!c.visible) continue;
      parts.push(`<div class="el el-custom" style="left:${unit(c.x)};top:${unit(c.y)};width:${unit(c.w)};font-size:${unit(c.fontSize)};text-align:${c.align};font-weight:${c.bold ? 'bold' : 'normal'};color:${c.color};${rotTransform(c)}${verticalStyle(c)}">${esc(c.text)}</div>`);
    }
    return parts.join('\n');
  }

  // 打印用完整 HTML（精确 mm 单位）
  // forceLandscape：A4 横向时网格重排为 4 列、@page 横放（热敏标签横向由 Electron 打印选项旋转，CSS 不变）
  // offset：打印偏移补偿 {x,y} mm（热敏打印机固定偏移校正），整体平移内容不影响分页
  function buildPrintHtml(products, settings, forceLandscape, offset) {
    settings = normalizeSettings(settings);
    const cfg = SIZE_CFG[settings.labelSize];
    const isA4 = settings.labelSize === 'a4';
    const landscape = !!(forceLandscape || (settings.printOptions && settings.printOptions.landscape));
    const ox = clampOffset(offset && offset.x);
    const oy = clampOffset(offset && offset.y);
    const labelW = isA4 ? A4_LABEL_W : cfg.w;
    const labelH = isA4 ? A4_LABEL_H : cfg.h;
    const mm = (v) => v + 'mm';

    const labels = products.map((p) =>
      `<div class="label" style="width:${labelW}mm;height:${labelH}mm;">\n${renderLabelHTML(p, settings.elements, settings.custom, mm)}\n</div>`
    ).join('\n');

    const pageCss = isA4 && landscape
      ? '@page { size: A4 landscape; margin: 8mm; }'
      : cfg.page;
    // A4 网格列数：纵向 3 列（3×60+2×5=190 ≤ 194），横向 4 列（4×60+3×5=255 ≤ 281）
    const offsetCss = (ox || oy) ? ` position: relative; left: ${ox}mm; top: ${oy}mm;` : '';
    const sheetStyle = isA4
      ? `.labels { display: grid; grid-template-columns: repeat(${landscape ? 4 : 3}, ${A4_LABEL_W}mm); gap: 5mm; justify-content: start;${offsetCss} }`
      : `.labels { display: flex; flex-direction: column;${offsetCss} } .label { page-break-after: always; }`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  ${pageCss}
  * { margin: 0; padding: 0; -webkit-print-color-adjust: exact; box-sizing: border-box; }
  body { background: #fff; }
  ${sheetStyle}
  .label {
    position: relative;
    overflow: hidden;
    font-family: "Microsoft YaHei", "SimHei", sans-serif;
  }
  .el { position: absolute; line-height: 1.15; overflow: hidden; white-space: nowrap; }
  .el-barcode { object-fit: contain; }
</style>
</head>
<body><div class="labels">${labels}</div>
<script>
/* 文本溢出自动缩字：与预览端 fitAndMeasure 同规则（0.2mm 步进，下限 1.2mm） */
(function () {
  var els = document.querySelectorAll('.el');
  for (var i = 0; i < els.length; i++) {
    var el = els[i];
    if (el.tagName === 'IMG') continue;
    var m = parseFloat(el.style.fontSize);
    if (!isFinite(m)) continue;
    var guard = 0;
    while (el.scrollWidth > el.clientWidth + 0.5 && m > 1.2 && guard++ < 60) {
      m = Math.round((m - 0.2) * 10) / 10;
      el.style.fontSize = m + 'mm';
    }
  }
})();
</script>
</body>
</html>`;
  }

  return {
    SIZE_CFG,
    ELEMENT_KEYS,
    DEFAULT_ELEMENTS,
    A4_LABEL_W,
    A4_LABEL_H,
    defaultsForSize,
    normalizeSettings,
    normalizePrintOptions,
    normalizeCustomElement,
    normalizeRot,
    newCustomId,
    renderLabelHTML,
    buildPrintHtml,
    esc,
  };
});
