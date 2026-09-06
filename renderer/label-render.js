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
    return {
      id: el.id || newCustomId(),
      type: 'text',
      text: String(el.text == null ? '' : el.text),
      visible: el.visible !== false,
      x: numberOr(el.x, 2),
      y: numberOr(el.y, 2),
      w: numberOr(el.w, 50),
      fontSize: numberOr(el.fontSize, 3.5),
      align: ['left', 'center', 'right'].includes(el.align) ? el.align : 'left',
      bold: !!el.bold,
      color: el.color || '#000000',
    };
  }

  function numberOr(v, def) {
    const n = Number(v);
    return isFinite(n) && n >= 0 ? Math.round(n * 10) / 10 : def;
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

  // 深合并：把 defaults 与 user 合并，补齐缺失字段
  function mergeElements(defaults, user) {
    const out = {};
    for (const k of ELEMENT_KEYS) {
      const d = defaults[k];
      const u = (user && user[k]) || {};
      out[k] = { ...d, ...u };
    }
    return out;
  }

  // 规范化设置：补齐缺失字段、修正越界值
  function normalizeSettings(settings) {
    settings = settings || {};
    const size = SIZE_CFG[settings.labelSize] ? settings.labelSize : '60x40';
    const defaults = defaultsForSize(size);
    const custom = Array.isArray(settings.custom) ? settings.custom.map(normalizeCustomElement) : [];
    return {
      labelSize: size,
      elements: mergeElements(defaults, settings.elements),
      custom,
    };
  }

  // ---------------- 渲染 ----------------

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  // 单个标签的 HTML。unit(mmV) 把 mm 数值换成目标单位字符串（打印 'mm'，预览 'px'）
  function renderLabelHTML(p, elements, custom, unit) {
    const parts = [];
    const e = elements;

    if (e.name.visible && p.name) {
      parts.push(`<div class="el el-name" style="left:${unit(e.name.x)};top:${unit(e.name.y)};width:${unit(e.name.w)};font-size:${unit(e.name.fontSize)};text-align:${e.name.align};font-weight:${e.name.bold ? 'bold' : 'normal'};color:${e.name.color};">${esc(p.name)}</div>`);
    }
    if (e.price.visible && p.price !== '' && p.price != null) {
      parts.push(`<div class="el el-price" style="left:${unit(e.price.x)};top:${unit(e.price.y)};width:${unit(e.price.w)};font-size:${unit(e.price.fontSize)};text-align:${e.price.align};font-weight:${e.price.bold ? 'bold' : 'normal'};color:${e.price.color};">¥${Number(p.price).toFixed(2)}</div>`);
    }
    if (e.sku.visible && p.sku) {
      parts.push(`<div class="el el-sku" style="left:${unit(e.sku.x)};top:${unit(e.sku.y)};width:${unit(e.sku.w)};font-size:${unit(e.sku.fontSize)};text-align:${e.sku.align};font-weight:${e.sku.bold ? 'bold' : 'normal'};color:${e.sku.color};">${esc(p.sku)}</div>`);
    }
    if (e.barcode.visible && p.barcodeSvg) {
      parts.push(`<img class="el el-barcode" src="${p.barcodeSvg}" alt="barcode" style="left:${unit(e.barcode.x)};top:${unit(e.barcode.y)};width:${unit(e.barcode.w)};height:${unit(e.barcode.h)};">`);
      // 条码下方数字（HTML 文本渲染，清晰可调）
      if (p.barcodeText && e.barcode.fontSize > 0) {
        parts.push(`<div class="el el-barcode-text" style="left:${unit(e.barcode.x)};top:${unit(e.barcode.y + e.barcode.h)};width:${unit(e.barcode.w)};font-size:${unit(e.barcode.fontSize)};text-align:${e.barcode.align};">${esc(p.barcodeText)}</div>`);
      }
    }
    // 自定义元素（自由文本，可任意添加/复制/移动）
    for (const c of custom || []) {
      if (!c.visible) continue;
      parts.push(`<div class="el el-custom" style="left:${unit(c.x)};top:${unit(c.y)};width:${unit(c.w)};font-size:${unit(c.fontSize)};text-align:${c.align};font-weight:${c.bold ? 'bold' : 'normal'};color:${c.color};">${esc(c.text)}</div>`);
    }
    return parts.join('\n');
  }

  // 打印用完整 HTML（精确 mm 单位）
  function buildPrintHtml(products, settings) {
    settings = normalizeSettings(settings);
    const cfg = SIZE_CFG[settings.labelSize];
    const isA4 = settings.labelSize === 'a4';
    const labelW = isA4 ? A4_LABEL_W : cfg.w;
    const labelH = isA4 ? A4_LABEL_H : cfg.h;
    const mm = (v) => v + 'mm';

    const labels = products.map((p) =>
      `<div class="label" style="width:${labelW}mm;height:${labelH}mm;">\n${renderLabelHTML(p, settings.elements, settings.custom, mm)}\n</div>`
    ).join('\n');

    const sheetStyle = isA4
      ? `.labels { display: grid; grid-template-columns: repeat(3, ${A4_LABEL_W}mm); gap: 5mm; justify-content: start; }`
      : `.labels { display: flex; flex-direction: column; } .label { page-break-after: always; }`;

    return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<style>
  ${cfg.page}
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
<body><div class="labels">${labels}</div></body>
</html>`;
  }

  return {
    SIZE_CFG,
    ELEMENT_KEYS,
    DEFAULT_ELEMENTS,
    defaultsForSize,
    normalizeSettings,
    normalizeCustomElement,
    newCustomId,
    renderLabelHTML,
    buildPrintHtml,
    esc,
  };
});
