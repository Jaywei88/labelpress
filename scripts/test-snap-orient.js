'use strict';
/* ============================================================
 * test-snap-orient.js — 拖拽吸附 + 方向切换预览验证
 * 用法：npx electron scripts/test-snap-orient.js
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlabel-snap-test-'));
process.env.PORTABLE_EXECUTABLE_DIR = tmpRoot;

require('../main.js');

const { app, BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let result = 'UNKNOWN';
  try {
    await wait(1200);
    const win = BrowserWindow.getAllWindows()[0];

    const injected = [
      '(async () => {',
      "  const $ = (id) => document.getElementById(id);",
      "  const logs = [];",
      "  const log = (m) => logs.push(m);",
      "  const sleep = (ms) => new Promise(r => setTimeout(r, ms));",
      "  await openPrintModal([{ id: 't-1', name: '测试', sku: 'T-1', price: 9.9, barcode: 'T1', barcodeType: 'CODE128' }]);",
      "  await sleep(300);",
      // 1. 纵向预览：方向标签应为纵向，transform 无旋转
      "  let meta = $('previewMeta').textContent;",
      "  log('meta@open=' + meta);",
      "  if (!meta.includes('纵向')) throw new Error('default orientation not vertical');",
      "  if ($('previewLabel').style.transform.includes('rotate')) throw new Error('portrait should not rotate');",
      // 2. 切换到横向：标签尺寸应交换显示（transform 旋转 + meta 横向）
      "  $('optLandscape').value = '1';",
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  meta = $('previewMeta').textContent;",
      "  log('meta@landscape=' + meta);",
      "  if (!meta.includes('横向')) throw new Error('landscape meta missing');",
      "  if (!$('previewLabel').style.transform.includes('rotate')) throw new Error('landscape should rotate');",
      "  const stageW = $('previewStage').style.width;",
      "  const stageH = $('previewStage').style.height;",
      "  log('stage=' + stageW + 'x' + stageH);",
      // 3. 切回纵向
      "  $('optLandscape').value = '0';",
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  if ($('previewLabel').style.transform.includes('rotate')) throw new Error('back to portrait should unrotate');",
      // 4. 吸附逻辑：把 name 元素放到与 sku 同一 y（top 对齐），computeSnap 应吸附并给出水平参考线 gy
      "  const nameEl = designerSettings.elements.name;",
      "  const skuEl = designerSettings.elements.sku;",
      "  skuEl.visible = true;",
      "  nameEl.x = 10; nameEl.y = skuEl.y + 0.3; // 差 0.3mm < SNAP_DIST 0.5 → 应吸附",
      "  const snap = computeSnap('name', nameEl, nameEl.x, nameEl.y);",
      "  log('snap y=' + snap.ty + ' gy=' + snap.gy + ' (sku.y=' + skuEl.y + ')');",
      "  if (Math.abs(snap.ty - skuEl.y) > 0.001) throw new Error('vertical snap failed: ty=' + snap.ty + ' want=' + skuEl.y);",
      "  if (snap.gy === null) throw new Error('no horizontal guide emitted');",
      // 5. 水平吸附：x 左边缘对齐（name 的 left 对齐 price 的 left）
      "  const priceEl = designerSettings.elements.price;",
      "  priceEl.x = 20; priceEl.y = 5;",
      "  nameEl.x = priceEl.x; // left == price.left → 差 0",
      "  const snap2 = computeSnap('name', nameEl, priceEl.x + 0.2, nameEl.y); // 微移 0.2 → 吸回 20",
      "  log('snap2 tx=' + snap2.tx + ' gx=' + snap2.gx + ' (want 20)');",
      "  if (snap2.tx !== 20) throw new Error('horizontal snap failed: tx=' + snap2.tx);",
      "  if (snap2.gx === null) throw new Error('no vertical guide emitted');",
      // 6. 参考线渲染：showGuides 后标签内应出现 guide 元素
      "  showGuides(5, 10);",
      "  await sleep(50);",
      "  const gv = document.querySelectorAll('#previewLabel .guide-v').length;",
      "  const gh = document.querySelectorAll('#previewLabel .guide-h').length;",
      "  log('guides v=' + gv + ' h=' + gh);",
      "  if (gv !== 1 || gh !== 1) throw new Error('guides not rendered');",
      "  clearGuides();",
      "  if (document.querySelectorAll('#previewLabel .guide-v').length !== 0) throw new Error('guides not cleared');",
      "  return JSON.stringify({ ok: true, logs });",
      '})()',
    ].join('\n');

    const out = await win.webContents.executeJavaScript(injected);
    console.log('SNAP_TEST=' + out);
    result = 'OK';
  } catch (e) {
    console.log('SNAP_TEST=FAIL ' + (e && e.message ? e.message : e));
    result = 'FAIL';
  } finally {
    setTimeout(() => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
      app.exit(result === 'OK' ? 0 : 1);
    }, 300);
  }
});