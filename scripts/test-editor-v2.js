'use strict';
/* ============================================================
 * test-editor-v2.js — 设计器 v2 专项：撤销/重做、关闭自动保存、
 * A4 横向打印 HTML、文本自动缩字、多选对齐、边界 clamp、
 * 打印选项随预设、样板商品切换
 * 用法：npx electron scripts/test-editor-v2.js
 * ============================================================ */
const path = require('path');
const fs = require('fs');
const os = require('os');

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dlabel-editor-v2-'));
process.env.PORTABLE_EXECUTABLE_DIR = tmpRoot;

require('../main.js');

const { app, BrowserWindow } = require('electron');
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

app.whenReady().then(async () => {
  let result = 'UNKNOWN';
  try {
    await wait(1200);
    const win = BrowserWindow.getAllWindows()[0];

    const products = `[
      { id: 't-1', name: '${'超长商品名称测试'.repeat(2)}超长商品名称', sku: 'T-1', price: 9.9, barcode: 'T1', barcodeType: 'CODE128' },
      { id: 't-2', name: '短名', sku: 'T-2', price: 1.5, barcode: 'T2', barcodeType: 'CODE128' }
    ]`;

    const injected = [
      '(async () => {',
      "  const $ = (id) => document.getElementById(id);",
      "  const logs = [];",
      "  const log = (m) => logs.push(m);",
      "  const sleep = (ms) => new Promise(r => setTimeout(r, ms));",
      `  const prods = ${products};`,
      "  await openPrintModal(prods);",
      "  await sleep(400);",
      // A. 样板商品切换
      "  if ($('sampleNav').classList.contains('hidden')) throw new Error('sample nav should be visible for 2 products');",
      "  if (!$('sampleIdxText').textContent.includes('1 / 2')) throw new Error('sample idx text wrong: ' + $('sampleIdxText').textContent);",
      "  $('btnSampleNext').click(); await sleep(80);",
      "  if (!$('sampleIdxText').textContent.includes('2 / 2')) throw new Error('sample next failed');",
      "  $('btnSamplePrev').click(); await sleep(80);",
      "  log('A sample-nav ok');",
      // B. 文本溢出自动缩字
      "  const nameNode = document.querySelector('.el-name');",
      "  if (!nameNode) throw new Error('name node missing');",
      "  const fitMM = parseFloat(nameNode.style.fontSize) / (MM_TO_PX * currentPreviewScale);",
      "  log('B fit font=' + fitMM.toFixed(2) + 'mm (set ' + designerSettings.elements.name.fontSize + 'mm)');",
      "  if (fitMM >= designerSettings.elements.name.fontSize) throw new Error('long text should auto-shrink');",
      "  if (nameNode.scrollWidth > nameNode.clientWidth + 2) throw new Error('text still overflowing after fit');",
      // C. 边界 clamp：拖出标签右/下边界应被夹回
      "  const nameEl = designerSettings.elements.name;",
      "  const clamped = computeSnap('name', nameEl, 100, 100);",
      "  log('C clamp tx=' + clamped.tx + ' ty=' + clamped.ty + ' (label ' + curLabelW + 'x' + curLabelH + ', w=' + nameEl.w + ')');",
      "  if (clamped.tx > curLabelW - nameEl.w + 0.001) throw new Error('x not clamped: ' + clamped.tx);",
      "  if (clamped.ty > curLabelH - 1) throw new Error('y not clamped: ' + clamped.ty);",
      // D. 撤销 / 重做
      "  const fs0 = designerSettings.elements.name.fontSize;",
      "  pushUndo();",
      "  designerSettings.elements.name.fontSize = 9.9;",
      "  doUndo();",
      "  if (designerSettings.elements.name.fontSize !== fs0) throw new Error('undo failed: ' + designerSettings.elements.name.fontSize);",
      "  doRedo();",
      "  if (designerSettings.elements.name.fontSize !== 9.9) throw new Error('redo failed');",
      "  designerSettings.elements.name.fontSize = fs0;",
      "  log('D undo/redo ok');",
      // E. 多选 + 批量对齐 + 撤销恢复
      "  designerSettings.elements.name.x = 6;",
      "  setSelection(['name', 'price', 'sku']);",
      "  if ($('selectionToolbar').classList.contains('hidden')) throw new Error('selection toolbar should show for multi-select');",
      "  alignSelection('left');",
      "  const xs = ['name', 'price', 'sku'].map(k => designerSettings.elements[k].x);",
      "  log('E align-left xs=' + xs.join(','));",
      "  if (!(xs[0] === 2 && xs[1] === 2 && xs[2] === 2)) throw new Error('align left failed: ' + xs.join(','));",
      "  doUndo();",
      "  if (designerSettings.elements.name.x !== 6) throw new Error('undo align failed: ' + designerSettings.elements.name.x);",
      "  designerSettings.elements.name.x = 2;",
      // F. 打印选项随预设
      "  $('optCopies').value = '3';",
      "  $('optCopies').dispatchEvent(new Event('input'));",
      "  $('optLandscape').value = '1';",
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  if (!designerSettings.printOptions || designerSettings.printOptions.landscape !== true || designerSettings.printOptions.copies !== 3) throw new Error('options not bound to preset settings');",
      "  flushAutoSave(); await sleep(200);",
      "  let st = await window.api.getPrintSettings();",
      "  if (!st.presets['默认'].printOptions || st.presets['默认'].printOptions.landscape !== true) throw new Error('options not persisted in preset');",
      "  log('F preset printOptions ok');",
      // G. 关闭设计器自动保存（不点打印也不丢）
      "  $('optLandscape').value = '0';",
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  designerSettings.elements.name.x = 42.5;",
      "  $('btnPrintCancel').click();",
      "  await sleep(200);",
      "  st = await window.api.getPrintSettings();",
      "  if (st.presets['默认'].elements.name.x !== 42.5) throw new Error('autosave on close failed: ' + st.presets['默认'].elements.name.x);",
      "  log('G autosave-on-close ok');",
      // H. 重新打开设计器：自动保存的设置应恢复
      "  await openPrintModal(prods);",
      "  await sleep(400);",
      "  if (designerSettings.elements.name.x !== 42.5) throw new Error('settings not restored on reopen: ' + designerSettings.elements.name.x);",
      "  log('H reopen restore ok');",
      // I. A4 横向打印 HTML：网格重排 4 列 + @page 横放
      "  const ls = LabelRender.buildPrintHtml([{ name: 'A', sku: 'S', price: 1, barcodeSvg: '', barcodeText: '' }], { labelSize: 'a4', custom: [] }, true);",
      "  if (!ls.includes('A4 landscape')) throw new Error('a4 landscape @page missing');",
      "  if (!ls.includes('repeat(4')) throw new Error('a4 landscape grid should be 4 columns');",
      "  const ps = LabelRender.buildPrintHtml([{ name: 'A', sku: 'S', price: 1, barcodeSvg: '', barcodeText: '' }], { labelSize: 'a4', custom: [] }, false);",
      "  if (!ps.includes('repeat(3')) throw new Error('a4 portrait grid should be 3 columns');",
      "  if (ps.includes('landscape')) throw new Error('a4 portrait should not mention landscape');",
      "  log('I a4 landscape print html ok');",
      // J. A4 整页预览：标签切线网格（纵向 3×6=18 格，第一格可编辑；横向 4×4=16 格、纸张横放不旋转）
      "  $('printSize').value = 'a4';",
      "  $('printSize').dispatchEvent(new Event('change'));",
      "  await sleep(120);",
      "  const tiles = document.querySelectorAll('#previewLabel .a4-tile');",
      "  log('J a4 tiles=' + tiles.length + ' editableEls=' + tiles[0].querySelectorAll('.el').length);",
      "  if (tiles.length !== 18) throw new Error('a4 portrait tiles should be 18: ' + tiles.length);",
      "  if (!tiles[0].querySelectorAll('.el').length) throw new Error('first tile should contain editable elements');",
      "  if (getCanvasEl() !== tiles[0]) throw new Error('canvas should be the first tile');",
      "  $('optLandscape').value = '1';",
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  await sleep(120);",
      "  if (document.querySelectorAll('#previewLabel .a4-tile').length !== 16) throw new Error('a4 landscape tiles should be 16');",
      "  if ($('previewLabel').style.transform.includes('rotate')) throw new Error('a4 landscape sheet should not rotate');",
      "  $('optLandscape').value = '0';",
      "  $('optLandscape').dispatchEvent(new Event('change'));",
      "  $('printSize').value = '60x40';",
      "  $('printSize').dispatchEvent(new Event('change'));",
      "  await sleep(100);",
      "  log('J a4 preview grid ok');",
      // K. 撤销/重做按钮：初始禁用 → 操作后可用 → 点击生效
      "  resetUndo(); renderPreview(); // 清栈建立基线（前面的尺寸切换会产生撤销步）",
      "  if (!$('btnUndo').disabled) throw new Error('btnUndo should be disabled after reopen (empty stack)');",
      "  pushUndo();",
      "  designerSettings.elements.name.fontSize = 8;",
      "  renderPreview();",
      "  if ($('btnUndo').disabled) throw new Error('btnUndo should be enabled after change');",
      "  $('btnUndo').click(); await sleep(80);",
      "  if (designerSettings.elements.name.fontSize !== 3.5) throw new Error('btnUndo click failed: ' + designerSettings.elements.name.fontSize);",
      "  if ($('btnRedo').disabled) throw new Error('btnRedo should be enabled after undo');",
      "  $('btnRedo').click(); await sleep(80);",
      "  if (designerSettings.elements.name.fontSize !== 8) throw new Error('btnRedo click failed');",
      "  designerSettings.elements.name.fontSize = 3.5;",
      "  log('K undo/redo buttons ok');",
      // L. 自定义元素名称：默认取文本前 5 字；手动改名后锁定
      "  addCustomElement(); await sleep(80);",
      "  const customEl = elementByKey(selectedElement);",
      "  const customCard = document.querySelector('.element-card-custom');",
      "  const textInputs = customCard.querySelectorAll('input[type=text]');",
      "  const nameInput = textInputs[0], textInput = textInputs[1];",
      "  textInput.value = '生产日期：2026-01-01';",
      "  textInput.dispatchEvent(new Event('input', { bubbles: true }));",
      "  await sleep(60);",
      "  log('L auto name=' + customEl.name + ' head=' + customCard.querySelector('.element-card-head span').textContent);",
      "  if (customEl.name !== '生产日期：') throw new Error('name should auto-derive to first 5 chars: ' + customEl.name);",
      "  if (!customCard.querySelector('.element-card-head span').textContent.includes('生产日期：')) throw new Error('card title not updated');",
      "  nameInput.value = '保质期备注';",
      "  nameInput.dispatchEvent(new Event('input', { bubbles: true }));",
      "  await sleep(60);",
      "  if (customEl.name !== '保质期备注' || !customEl.nameLocked) throw new Error('manual rename failed');",
      "  textInput.value = '存储条件：避光防潮';",
      "  textInput.dispatchEvent(new Event('input', { bubbles: true }));",
      "  await sleep(60);",
      "  if (customEl.name !== '保质期备注') throw new Error('locked name should not follow text: ' + customEl.name);",
      "  log('L custom name derive/lock ok');",
      // M. 新建空白预设：所有元素（含自定义）取消勾选
      "  const pBlank = saveAsBlankPreset();",
      "  $('promptInput').value = '空白标签';",
      "  $('btnPromptOk').click();",
      "  await pBlank; await sleep(100);",
      "  const fixedAllHidden = Object.values(designerSettings.elements).every((e) => e.visible === false);",
      "  const customAllHidden = designerSettings.custom.every((c) => c.visible === false);",
      "  log('M blank fixedHidden=' + fixedAllHidden + ' customHidden=' + customAllHidden + ' active=' + activePreset);",
      "  if (!fixedAllHidden || !customAllHidden) throw new Error('blank preset should uncheck all elements');",
      "  if (activePreset !== '空白标签') throw new Error('active preset should switch to blank');",
      "  st = await window.api.getPrintSettings();",
      "  if (!st.presets['空白标签'] || st.presets['空白标签'].elements.name.visible !== false) throw new Error('blank preset not persisted');",
      "  const dpBlank = deletePreset();",
      "  $('btnConfirmOk').click();",
      "  await dpBlank; await sleep(100);",
      "  if (activePreset !== '默认') throw new Error('should fall back to 默认 after delete');",
      "  log('M blank preset ok');",
      "  return JSON.stringify({ ok: true, logs });",
      '})()',
    ].join('\n');

    const out = await win.webContents.executeJavaScript(injected);
    console.log('EDITOR_V2=' + out);
    result = 'OK';
  } catch (e) {
    console.log('EDITOR_V2=FAIL ' + (e && e.message ? e.message : e));
    result = 'FAIL';
  } finally {
    setTimeout(() => {
      try { fs.rmSync(tmpRoot, { recursive: true, force: true }); } catch (_) {}
      app.exit(result === 'OK' ? 0 : 1);
    }, 300);
  }
});
