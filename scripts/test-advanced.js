'use strict';
/* ============================================================
 * test-advanced.js — 自定义元素 + 打印选项端到端验证
 * 用法：npx electron scripts/test-advanced.js
 * 数据落在临时目录，不污染真实数据；输出 ADVANCED_TEST=...
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlabel-advanced-test-'));
process.env.PORTABLE_EXECUTABLE_DIR = tmpRoot;

require('../main.js');

const { app, BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let result = 'UNKNOWN';
  try {
    await wait(1200);
    const win = BrowserWindow.getAllWindows()[0];

    // 先测主进程侧：打印选项保存/读取往返 + 默认静默
    const optDefault = await win.webContents.executeJavaScript(`
      (async () => {
        const g1 = await window.api.getPrintOptions();
        const before = JSON.stringify(g1.options || {});
        await window.api.savePrintOptions({ deviceName: 'FAKE-PRINTER', landscape: true, copies: 3, silent: false });
        const g2 = await window.api.getPrintOptions();
        const after = JSON.stringify(g2.options || {});
        // 再保存 silent 默认（undefined → 应默认 true）
        await window.api.savePrintOptions({ deviceName: 'FAKE-PRINTER-2', landscape: false, copies: 2 });
        const g3 = await window.api.getPrintOptions();
        return JSON.stringify({ before, after, g3: g3.options });
      })()
    `);
    const optRes = JSON.parse(optDefault);
    if (!/landscape/.test(optRes.after)) throw new Error('print options not persisted');
    if (optRes.g3.silent !== true) throw new Error('silent default should be true');
    if (optRes.g3.copies !== 2) throw new Error('copies roundtrip failed: ' + optRes.g3.copies);
    console.log('PRINT_OPTS=' + optDefault);

    // 渲染层：自定义元素增删复制 + 打印选项 UI
    const injected = [
      '(async () => {',
      "  const $ = (id) => document.getElementById(id);",
      "  const logs = [];",
      "  const log = (m) => logs.push(m);",
      "  const sleep = (ms) => new Promise(r => setTimeout(r, ms));",
      // 打开设计器
      "  await openPrintModal([{ id: 't-1', name: '测试', sku: 'T-1', price: 9.9, barcode: 'T1', barcodeType: 'CODE128' }]);",
      "  await sleep(250);",
      // 初始无自定义元素
      "  if (designerSettings.custom.length !== 0) throw new Error('should start with 0 custom');",
      // 添加一个自定义文本
      "  addCustomElement();",
      "  await sleep(50);",
      "  if (designerSettings.custom.length !== 1) throw new Error('add failed');",
      "  const c1 = designerSettings.custom[0];",
      "  log('added custom text=' + c1.text + ' y=' + c1.y);",
      "  if (selectedElement !== 'custom:' + c1.id) throw new Error('new element not selected');",
      // 修改文本
      "  c1.text = '生产日期：2026-01-01';",
      "  renderPreview();",
      // 预览中应有该元素
      "  const inPreview = document.querySelector('#previewLabel .el-custom');",
      "  if (!inPreview) throw new Error('custom element not rendered in preview');",
      "  log('preview custom rendered: ' + inPreview.textContent);",
      // 复制一个（向下偏移 6mm）
      "  duplicateCustomElement(c1.id);",
      "  await sleep(50);",
      "  if (designerSettings.custom.length !== 2) throw new Error('duplicate failed');",
      "  const c2 = designerSettings.custom[1];",
      "  if (Math.round((c2.y - c1.y) * 10) / 10 !== 6) throw new Error('duplicate y offset not 6mm: ' + (c2.y - c1.y));",
      "  log('duplicated y offset = ' + (c2.y - c1.y));",
      // 键盘方向键微调选中元素
      "  selectedElement = 'custom:' + c2.id;",
      "  const beforeX = c2.x;",
      "  const pre = document.querySelector('#previewLabel .el-custom[data-key=\"custom:' + c2.id + '\"]');",
      "  if (!pre) throw new Error('c2 not in preview');",
      // 删除第一个自定义元素
      "  removeCustomElement(c1.id);",
      "  await sleep(50);",
      "  if (designerSettings.custom.length !== 1) throw new Error('remove failed');",
      "  log('after remove remaining=' + designerSettings.custom.length + ' id=' + designerSettings.custom[0].id);",
      // 保存到预设，验证自定义元素随预设持久化
      "  $('btnPresetSave').click();",
      "  await sleep(200);",
      "  const st = await window.api.getPrintSettings();",
      "  log('preset custom count=' + (st.presets['默认'].custom || []).length);",
      "  if ((st.presets['默认'].custom || []).length !== 1) throw new Error('custom not saved into preset');",
      // 打印选项 UI：设置值并确认 currentPrintOptions 读取正确
      // （打印机下拉选真实存在的项；若无打印机则保持“系统默认”空值）
      "  await sleep(300);", // 等 loadPrinterOptions 异步填充完成
      "  const prOpts = [...$('optPrinter').options].map(o => o.value);",
      "  log('printerOptions=' + JSON.stringify(prOpts));",
      "  const pick = prOpts.find(v => v) || '';",
      "  $('optPrinter').value = pick;",
      "  $('optLandscape').value = '1';",
      "  $('optCopies').value = '5';",
      "  $('optSilent').checked = false;",
      "  const co = currentPrintOptions();",
      "  log('currentPrintOptions=' + JSON.stringify(co));",
      "  if (!co.landscape || co.copies !== 5 || co.silent !== false) throw new Error('currentPrintOptions wrong: ' + JSON.stringify(co));",
      "  if (pick && co.deviceName !== pick) throw new Error('deviceName pick mismatch');",
      // 变更事件应触发自动保存（savePrinterOptionsNow）
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  await sleep(150);",
      "  const sv = await window.api.getPrintOptions();",
      "  log('auto-saved options=' + JSON.stringify(sv.options));",
      "  if (sv.options.landscape !== true || sv.options.copies !== 5) throw new Error('auto save on change failed');",
      "  return JSON.stringify({ ok: true, logs });",
      '})()',
    ].join('\n');

    const out = await win.webContents.executeJavaScript(injected);
    console.log('ADVANCED_TEST=' + out);
    result = 'OK';
  } catch (e) {
    console.log('ADVANCED_TEST=FAIL ' + (e && e.message ? e.message : e));
    result = 'FAIL';
  } finally {
    const dataDir = path.join(tmpRoot, '数据');
    const pf = path.join(dataDir, 'print-options.json');
    try {
      if (fs.existsSync(pf)) console.log('OPTIONS_FILE=' + fs.readFileSync(pf, 'utf-8').replace(/\n/g, '|'));
      else console.log('OPTIONS_FILE=NOT_FOUND');
    } catch (e2) { console.log('OPTIONS_FILE=ERR ' + e2.message); }
    setTimeout(() => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
      app.exit(result === 'OK' ? 0 : 1);
    }, 300);
  }
});