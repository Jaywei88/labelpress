'use strict';
/* ============================================================
 * test-legacy-presets.js — 旧版单份 print-settings.json 迁移验证
 * 用法：npx electron scripts/test-legacy-presets.js
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'labelpress-legacy-test-'));
process.env.PORTABLE_EXECUTABLE_DIR = tmpRoot;

// 预写旧版格式：单份 settings（无 presets 字段）
const dataDir = path.join(tmpRoot, '数据');
fs.mkdirSync(dataDir, { recursive: true });
const legacy = {
  labelSize: '50x30',
  elements: {
    name:    { visible: true, x: 1.5, y: 1.5, w: 47, fontSize: 3,   align: 'center', bold: true,  color: '#000000' },
    price:   { visible: true, x: 1.5, y: 21, w: 47, fontSize: 3.8, align: 'center', bold: true,  color: '#c0392b' },
    sku:     { visible: true, x: 1.5, y: 26, w: 47, fontSize: 2.2, align: 'center', bold: false, color: '#333333' },
    barcode: { visible: true, x: 1.5, y: 6,  w: 47, h: 12, fontSize: 2.6, align: 'center' },
  },
};
fs.writeFileSync(path.join(dataDir, 'print-settings.json'), JSON.stringify(legacy), 'utf-8');

require('../main.js');

const { app, BrowserWindow } = require('electron');
const assert = (cond, msg) => { if (!cond) throw new Error('ASSERT_FAIL: ' + msg); };
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
      // 打开设计器：旧设置应被迁移为「默认」预设并自动应用
      "  await openPrintModal([{ id: 't-1', name: '旧数据商品', sku: 'OLD', price: 1, barcode: 'OLD-1', barcodeType: 'CODE128' }]);",
      "  await new Promise(r => setTimeout(r, 150));",
      "  const opts = [...$('presetSelect').options].map(o => o.value);",
      "  log('presets@open=' + JSON.stringify(opts));",
      "  if (!opts.includes('默认')) throw new Error('migrated default preset missing');",
      "  if (designerSettings.labelSize !== '50x30') throw new Error('legacy labelSize not applied: ' + designerSettings.labelSize);",
      "  log('labelSize=' + designerSettings.labelSize + ' name.size=' + designerSettings.elements.name.fontSize);",
      // 再次获取存储：应已是新结构且 active=默认
      "  const st = await window.api.getPrintSettings();",
      "  log('savedFormatPresets=' + JSON.stringify(Object.keys(st.presets)) + ' active=' + st.active);",
      "  if (st.presets['默认'].labelSize !== '50x30') throw new Error('migrated preset content wrong');",
      "  return JSON.stringify({ ok: true, logs });",
      '})()',
    ].join('\n');
    const out = await win.webContents.executeJavaScript(injected);
    console.log('LEGACY_TEST=' + out);
    result = 'OK';
  } catch (e) {
    console.log('LEGACY_TEST=FAIL ' + (e && e.message ? e.message : e));
    result = 'FAIL';
  } finally {
    const sf = path.join(dataDir, 'print-settings.json');
    try {
      if (fs.existsSync(sf)) console.log('LEGACY_FILE=' + fs.readFileSync(sf, 'utf-8').replace(/\n/g, '|'));
    } catch (e2) { console.log('LEGACY_FILE=ERR ' + e2.message); }
    setTimeout(() => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
      app.exit(result === 'OK' ? 0 : 1);
    }, 300);
  }
});