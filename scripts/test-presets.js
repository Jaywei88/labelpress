'use strict';
/* ============================================================
 * test-presets.js — 打印预设功能端到端验证（独立 Electron 入口）
 * 用法：npx electron scripts/test-presets.js
 * 数据落在临时目录，不污染真实数据；输出 PRESET_TEST=...
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

// 关键：必须在 require('./main.js') 之前设置临时数据目录
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlabel-preset-test-'));
process.env.PORTABLE_EXECUTABLE_DIR = tmpRoot;

require('../main.js');

const { app, BrowserWindow } = require('electron');

const assert = (cond, msg) => {
  if (!cond) throw new Error('ASSERT_FAIL: ' + msg);
};

async function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

app.whenReady().then(async () => {
  let result = 'UNKNOWN';
  try {
    // 等主窗口与渲染层就绪
    await wait(1200);
    const win = BrowserWindow.getAllWindows()[0];
    if (!win) throw new Error('no main window');

    // 注入的渲染层测试脚本（避免模板字符串嵌套，用数组 join 构造）
    const injected = [
      '(async () => {',
      "  const $ = (id) => document.getElementById(id);",
      "  const logs = [];",
      "  const log = (m) => logs.push(m);",
      "  const sleep = (ms) => new Promise(r => setTimeout(r, ms));",
      // 1. 打开打印设计器（构造一个内联商品，走 preparePrintPayload）
      "  await openPrintModal([{ id: 't-1', name: '测试商品', sku: 'T-001', price: 9.9, barcode: 'T001-ABC', barcodeType: 'CODE128' }]);",
      "  await sleep(150);",
      "  if (!$('printModal').classList.contains('hidden')) {} else { throw new Error('modal not open'); }",
      // 2. 首次：应存在默认预设并选中
      "  let opts = [...$('presetSelect').options].map(o => o.value);",
      "  log('presets@open=' + JSON.stringify(opts));",
      "  if (!opts.includes('默认')) throw new Error('default preset missing');",
      // 3. 修改字号并保存到当前预设
      "  designerSettings.elements.name.fontSize = 8.8;",
      "  $('btnPresetSave').click();",
      "  await sleep(200);",
      "  let st = await window.api.getPrintSettings();",
      "  log('afterSave 默认.fontSize=' + st.presets['默认'].elements.name.fontSize);",
      "  if (st.presets['默认'].elements.name.fontSize !== 8.8) throw new Error('saved to preset failed');",
      // 4. 切换尺寸到 30x40（竖版）
      "  $('printSize').value = '30x40';",
      "  $('printSize').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  if (designerSettings.labelSize !== '30x40') throw new Error('size change failed');",
      // 5. 另存为新预设（驱动 prompt 弹层）
      "  const p = saveAsPreset();",
      "  await sleep(80);",
      "  $('promptInput').value = '竖版专用';",
      "  $('btnPromptOk').click();",
      "  await p;",
      "  await sleep(200);",
      "  st = await window.api.getPrintSettings();",
      "  log('presetsAfterNew=' + JSON.stringify(Object.keys(st.presets)) + ' active=' + st.active);",
      "  if (!st.presets['竖版专用']) throw new Error('new preset not saved');",
      "  if (st.presets['竖版专用'].labelSize !== '30x40') throw new Error('new preset labelSize wrong: ' + st.presets['竖版专用'].labelSize);",
      "  if (st.active !== '竖版专用') throw new Error('active not switched');",
      // 6. 切换到「默认」预设：应恢复 60x40 + 字号 8.8
      "  $('presetSelect').value = '默认';",
      "  $('presetSelect').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  log('switchBack labelSize=' + designerSettings.labelSize + ' fontSize=' + designerSettings.elements.name.fontSize);",
      "  if (designerSettings.labelSize !== '60x40') throw new Error('switch back labelSize failed');",
      "  if (designerSettings.elements.name.fontSize !== 8.8) throw new Error('switch back fontSize failed');",
      // 7. 回到竖版专用，删除它（驱动确认弹层）
      "  $('presetSelect').value = '竖版专用';",
      "  $('presetSelect').dispatchEvent(new Event('change'));",
      "  await sleep(80);",
      "  const dp = deletePreset();",
      "  await sleep(80);",
      "  $('btnConfirmOk').click();",
      "  await dp;",
      "  await sleep(200);",
      "  st = await window.api.getPrintSettings();",
      "  log('presetsAfterDelete=' + JSON.stringify(Object.keys(st.presets)) + ' active=' + st.active);",
      "  if (st.presets['竖版专用']) throw new Error('preset not deleted');",
      "  if (!st.presets['默认']) throw new Error('default preset lost');",
      "  return JSON.stringify({ ok: true, logs });",
      '})()',
    ].join('\n');

    const out = await win.webContents.executeJavaScript(injected);
    console.log('PRESET_TEST=' + out);
    result = 'OK';
  } catch (e) {
    console.log('PRESET_TEST=FAIL ' + (e && e.message ? e.message : e));
    result = 'FAIL';
  } finally {
    // 打印落地文件内容用于核对
    const dataDir = path.join(tmpRoot, '数据');
    const sf = path.join(dataDir, 'print-settings.json');
    try {
      if (fs.existsSync(sf)) {
        console.log('PRESET_FILE_CONTENT=' + fs.readFileSync(sf, 'utf-8').replace(/\n/g, '|'));
      } else {
        console.log('PRESET_FILE_CONTENT=NOT_FOUND');
      }
    } catch (e2) {
      console.log('PRESET_FILE_CONTENT=ERR ' + e2.message);
    }
    // 清理临时目录（延迟退出后再清）
    setTimeout(() => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
      app.exit(result === 'OK' ? 0 : 1);
    }, 300);
  }
});