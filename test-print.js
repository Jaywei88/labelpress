'use strict';

// label-render 渲染单测（纯 Node，无需 Electron）
const assert = require('assert');
const LR = require('./renderer/label-render');

// 真实形态：barcodeSvg 是纯 PNG data URL（不含 <img> 包裹）
const dataUrlStub = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

const products = [
  { name: '农夫山泉 550ml', sku: 'SKU-0001', price: 2.5, barcodeSvg: dataUrlStub },
  { name: '可乐 330ml', sku: 'SKU-0002', price: 3, barcodeSvg: dataUrlStub },
  { name: '<script>alert(1)</script>', sku: 'X&Y', price: 0, barcodeSvg: dataUrlStub },
];

// 1. 默认 60x40
const s1 = LR.normalizeSettings({ labelSize: '60x40' });
const h1 = LR.buildPrintHtml(products, s1);
assert.ok(h1.includes('@page { size: 60mm 40mm; margin: 0; }'), '60x40 page rule');
assert.ok(h1.includes('width:60mm;height:40mm'), 'label size 60x40');
assert.ok(h1.includes('¥2.50'), 'price shown');
assert.ok(h1.includes('农夫山泉 550ml'), 'product name');
assert.ok(h1.includes(dataUrlStub), 'barcode data url embedded');
// 关键回归：barcodeSvg 必须是纯 data URL，不能是嵌套 <img>
assert.ok(!h1.includes('src="<img'), 'no nested img tag in src');
assert.strictEqual((h1.match(/<img class="el el-barcode" src="data:image\/png/g) || []).length, 3, '3 barcode imgs with pure data url');
assert.ok(!h1.includes('<script>'), 'XSS escaped (script removed)');
assert.ok(h1.includes('&lt;script&gt;'), 'XSS escaped (name escaped)');
assert.ok(h1.includes('X&amp;Y'), 'XSS escaped (sku escaped)');
assert.strictEqual((h1.match(/class="label"/g) || []).length, 3, '3 labels');

// 2. 隐藏价格
const s2 = LR.normalizeSettings({ labelSize: '60x40', elements: { price: { visible: false } } });
const h2 = LR.buildPrintHtml(products, s2);
assert.ok(!h2.includes('¥2.50'), 'price hidden when invisible');

// 3. A4 网格
const s3 = LR.normalizeSettings({ labelSize: 'a4' });
const h3 = LR.buildPrintHtml(products, s3);
assert.ok(h3.includes('@page { size: A4; margin: 8mm; }'), 'A4 page rule');
assert.ok(h3.includes('grid-template-columns: repeat(3, 60mm)'), 'A4 grid');
assert.ok(h3.includes('width:60mm;height:40mm'), 'A4 label keeps 60x40 size');

// 4. 无价格商品
const s4 = LR.normalizeSettings({});
const h4 = LR.buildPrintHtml([{ name: '无价', sku: 'S1', price: '', barcodeSvg: dataUrlStub }], s4);
assert.ok(!h4.includes('¥NaN'), 'no NaN price');
assert.ok(!h4.includes('¥0.00'), 'no price for empty price');

// 5. 自定义位置/字号生效
const s5 = LR.normalizeSettings({ labelSize: '60x40', elements: { name: { x: 10, y: 20, fontSize: 6, bold: false, color: '#ff0000' } } });
const h5 = LR.buildPrintHtml([{ name: '测试', sku: 'S', price: 1, barcodeSvg: dataUrlStub }], s5);
assert.ok(h5.includes('left:10mm'), 'custom x');
assert.ok(h5.includes('top:20mm'), 'custom y');
assert.ok(h5.includes('font-size:6mm'), 'custom font size');
assert.ok(h5.includes('font-weight:normal'), 'bold off');
assert.ok(h5.includes('color:#ff0000'), 'custom color');

// 6. 50x30 默认布局按比例缩放
const s6 = LR.normalizeSettings({ labelSize: '50x30' });
const d60 = LR.defaultsForSize('60x40');
const d50 = LR.defaultsForSize('50x30');
assert.ok(d50.name.w < d60.name.w, '50x30 layout scaled down');
assert.ok(d50.barcode.h < d60.barcode.h, '50x30 barcode height scaled down');

// 7. 条码下方数字（HTML 文本）渲染
const s7 = LR.normalizeSettings({ labelSize: '60x40' });
const h7 = LR.buildPrintHtml([{ name: '测试', sku: 'S', price: 1, barcodeSvg: dataUrlStub, barcodeText: '6901234567892' }], s7);
assert.ok(h7.includes('el-barcode-text'), 'barcode text element present');
assert.ok(h7.includes('6901234567892'), 'barcode text content');
assert.ok(h7.includes('font-size:3.2mm'), 'barcode text font size from settings');
// 数字定位在条码下方（top = y + h）
assert.ok(h7.includes('top:24mm'), 'barcode text positioned below barcode (8+16)');

// 8. barcodeText 为空时不渲染数字
const h8 = LR.buildPrintHtml([{ name: '测试', sku: 'S', price: 1, barcodeSvg: dataUrlStub }], s7);
assert.ok(!h8.includes('el-barcode-text'), 'no barcode text when barcodeText empty');

// 9. 新增尺寸：配置存在
for (const sz of ['40x30', '30x40', '80x100', '100x80']) {
  assert.ok(LR.SIZE_CFG[sz], 'size cfg exists: ' + sz);
  assert.ok(LR.SIZE_CFG[sz].page.includes('size: ' + sz.replace('x', 'mm ') + 'mm'), 'page rule for ' + sz);
  const lay = LR.defaultsForSize(sz);
  // 元素都在标签范围内
  const cfg = LR.SIZE_CFG[sz];
  for (const k of LR.ELEMENT_KEYS) {
    const e = lay[k];
    assert.ok(e.x >= 0 && e.x + e.w <= cfg.w, sz + ' ' + k + ' within width (x=' + e.x + ' w=' + e.w + ' max=' + cfg.w + ')');
    const bottom = k === 'barcode' ? e.y + e.h + e.fontSize : e.y + e.fontSize * 1.4;
    assert.ok(bottom <= cfg.h + 0.1, sz + ' ' + k + ' within height (bottom=' + bottom.toFixed(1) + ' max=' + cfg.h + ')');
  }
}
// 30x40 竖版：宽度小于高度
assert.ok(LR.SIZE_CFG['30x40'].w < LR.SIZE_CFG['30x40'].h, '30x40 is portrait');
// 30x40 默认布局的条码宽度用满横向空间（竖版条码居中较大）
const lay30 = LR.defaultsForSize('30x40');
assert.ok(lay30.barcode.w >= 24, '30x40 barcode uses width');

// 10. 打印 HTML 用新尺寸的 @page
const h10 = LR.buildPrintHtml([{ name: '测试', sku: 'S', price: 1, barcodeSvg: dataUrlStub, barcodeText: '1234567890123' }], LR.normalizeSettings({ labelSize: '80x100' }));
assert.ok(h10.includes('@page { size: 80mm 100mm; margin: 0; }'), '80x100 page rule');
assert.ok(h10.includes('width:80mm;height:100mm'), '80x100 label size');
assert.ok(h10.includes('font-size:6mm'), '80x100 name font from layout');

console.log('LABEL_RENDER_TESTS=OK');
