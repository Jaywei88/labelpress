'use strict';

const { app, BrowserWindow, ipcMain, dialog, shell, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { buildPrintHtml, normalizeSettings, defaultsForSize } = require('./renderer/label-render');

// ---------------------------------------------------------------------------
// 数据目录解析（便携关键）
//   - electron-builder portable 模式：exe 同级的「数据」文件夹 → 拷走文件夹=换设备
//   - 开发模式：userData 兜底
// ---------------------------------------------------------------------------
function getDataDir() {
  const portableDir = process.env.PORTABLE_EXECUTABLE_DIR;
  if (portableDir) return path.join(portableDir, '数据');
  return path.join(app.getPath('userData'), '数据');
}

const DATA_FILE = () => path.join(getDataDir(), 'products.json');
const BACKUP_FILE = () => path.join(getDataDir(), 'products.backup.json');

let productsCache = null;

function loadProducts() {
  if (productsCache) return productsCache;
  try {
    const raw = fs.readFileSync(DATA_FILE(), 'utf-8');
    const data = JSON.parse(raw);
    productsCache = Array.isArray(data.products) ? data.products : [];
  } catch (err) {
    productsCache = [];
  }
  return productsCache;
}

function ensureDataDir() {
  const dir = getDataDir();
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  return dir;
}

// 原子写入：先写临时文件再改名覆盖；写前保留上一份为 backup
function saveProducts() {
  ensureDataDir();
  const target = DATA_FILE();
  if (fs.existsSync(target)) {
    try { fs.copyFileSync(target, BACKUP_FILE()); } catch (_) { /* ignore */ }
  }
  const tmp = target + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify({ version: 1, products: productsCache }, null, 2), 'utf-8');
  fs.renameSync(tmp, target);
}

function now() { return new Date().toISOString(); }

function findProduct(id) {
  return loadProducts().find((p) => p.id === id);
}

// ---------------------------------------------------------------------------
// 主窗口
// ---------------------------------------------------------------------------
let mainWindow = null;

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1240,
    height: 800,
    minWidth: 980,
    minHeight: 640,
    title: '商品条码管理',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  mainWindow.setMenuBarVisibility(false);
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  // 冒烟测试模式：加载完成后输出标记并退出
  if (process.env.SMOKE_TEST) {
    mainWindow.webContents.on('did-finish-load', async () => {
      let result = 'UNKNOWN';
      try {
        result = await mainWindow.webContents.executeJavaScript(`(async () => {
          if (typeof window.api === 'undefined' || typeof JsBarcode === 'undefined') return 'MISSING_API_OR_LIB';
          const r1 = await window.api.loadData();
          if (!r1 || !Array.isArray(r1.products)) return 'LOAD_FAIL';
          const test = await window.api.saveProduct({ name: '__smoke__', sku: 'SMK', barcode: 'SMK001', barcodeType: 'CODE128' });
          if (!test.ok || !test.products.some(p => p.name === '__smoke__')) return 'SAVE_FAIL';
          const r2 = await window.api.loadData();
          if (!r2.products.some(p => p.name === '__smoke__')) return 'RELOAD_FAIL';
          const del = await window.api.deleteProduct(test.products.find(p => p.name === '__smoke__').id);
          if (!del.ok || del.products.some(p => p.name === '__smoke__')) return 'DELETE_FAIL';
          return 'OK';
        })()`);
        console.log('SMOKE_RESULT=' + result);
      } catch (e) {
        console.log('SMOKE_RESULT=FAIL ' + e.message);
      }
      setTimeout(() => app.exit(result === 'OK' ? 0 : 1), 300);
    });
    mainWindow.webContents.on('did-fail-load', (_e, code, desc) => {
      console.log('SMOKE_RESULT=FAIL load ' + code + ' ' + desc);
      app.exit(1);
    });
  }

  // 截图测试模式：注入示例数据并保存界面截图（供开发验证，正常使用不触发）
  if (process.env.SCREENSHOT_PATH) {
    let injected = false;
    mainWindow.webContents.on('did-finish-load', async () => {
      if (injected) return;
      injected = true;
      try {
        await mainWindow.webContents.executeJavaScript(`(async () => {
          const samples = [
            { name: '农夫山泉 550ml', sku: 'SKU-0001', category: '饮料', unit: '瓶', price: 2.5, spec: '550ml', barcodeType: 'EAN13', barcode: '690123456789', remark: '' },
            { name: '可口可乐 330ml', sku: 'SKU-0002', category: '饮料', unit: '罐', price: 3.0, spec: '330ml', barcodeType: 'EAN13', barcode: '690102807609', remark: '冰镇' },
            { name: '康师傅红烧牛肉面', sku: 'SKU-0003', category: '食品', unit: '包', price: 4.5, spec: '104g', barcodeType: 'CODE128', barcode: 'NSF-001', remark: '' },
          ];
          for (const s of samples) await window.api.saveProduct(s);
          return 'seeded';
        })()`);
        await new Promise((r) => setTimeout(r, 400));
        await mainWindow.webContents.reload();
        await new Promise((r) => setTimeout(r, 1500));
        // 点击第二个商品，展示编辑态 + 条码预览
        await mainWindow.webContents.executeJavaScript(
          'document.querySelectorAll("#productBody tr")[1] && document.querySelectorAll("#productBody tr")[1].click()'
        ).catch(() => {});
        await new Promise((r) => setTimeout(r, 800));
        const img = await mainWindow.webContents.capturePage();
        require('fs').writeFileSync(process.env.SCREENSHOT_PATH, img.toPNG());
        console.log('SCREENSHOT_SAVED');
      } catch (e) {
        console.log('SCREENSHOT_ERR ' + e.message);
      }
      app.exit(0);
    });
  }
}

// ---------------------------------------------------------------------------
// 打印设置预持久化（print-settings.json 存于数据目录，随数据一起便携）
// 结构：{ active: '预设名', presets: { '预设名': {labelSize, elements}, ... } }
// 兼容旧版单份设置格式：读到时自动迁移为名为「默认」的预设
// ---------------------------------------------------------------------------
const SETTINGS_FILE = () => path.join(getDataDir(), 'print-settings.json');

function loadPrintPresets() {
  try {
    const raw = fs.readFileSync(SETTINGS_FILE(), 'utf-8');
    const data = JSON.parse(raw);
    // 新版结构
    if (data && typeof data === 'object' && data.presets && typeof data.presets === 'object') {
      const names = Object.keys(data.presets);
      if (!names.length) return { active: '默认', presets: {} };
      const active = names.includes(data.active) ? data.active : names[0];
      return { active, presets: data.presets };
    }
    // 旧版：单份设置 → 迁移为「默认」预设
    if (data && typeof data === 'object' && (data.labelSize || data.elements)) {
      return { active: '默认', presets: { '默认': data } };
    }
    return null;
  } catch (_) {
    return null;
  }
}

function savePrintPresets(active, presets) {
  ensureDataDir();
  const clean = {};
  for (const name of Object.keys(presets || {})) {
    clean[name] = normalizeSettings(presets[name]);
  }
  const names = Object.keys(clean);
  const act = names.includes(active) ? active : (names[0] || '默认');
  fs.writeFileSync(SETTINGS_FILE(), JSON.stringify({ active: act, presets: clean }, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// 打印设备选项持久化（print-options.json）
// 记住上次使用的打印机、方向、份数、静默模式，避免每次打印都重新选择
// ---------------------------------------------------------------------------
const PRINT_OPTS_FILE = () => path.join(getDataDir(), 'print-options.json');

function loadPrintOptions() {
  try {
    const raw = fs.readFileSync(PRINT_OPTS_FILE(), 'utf-8');
    const o = JSON.parse(raw);
    if (o && typeof o === 'object') return o;
    return null;
  } catch (_) {
    return null;
  }
}

function savePrintOptions(opts) {
  ensureDataDir();
  const o = opts || {};
  fs.writeFileSync(PRINT_OPTS_FILE(), JSON.stringify({
    deviceName: String(o.deviceName || ''),
    landscape: !!o.landscape,
    copies: Math.max(1, Math.min(999, Math.round(Number(o.copies) || 1))),
    // 默认直接打印（记忆打印机/方向/份数，不再被系统对话框重置）；显式 false 才弹系统对话框
    silent: o.silent === false ? false : true,
  }, null, 2), 'utf-8');
}

// ---------------------------------------------------------------------------
// 打印窗口
// ---------------------------------------------------------------------------
async function printLabels(products, opts) {
  const settings = normalizeSettings(opts && opts.settings ? opts.settings : undefined);
  const html = buildPrintHtml(products, settings);
  const win = new BrowserWindow({
    show: false,
    webPreferences: { sandbox: true },
  });
  try {
    await win.loadURL('data:text/html;charset=utf-8,' + encodeURIComponent(html));
  } catch (err) {
    win.destroy();
    throw new Error('打印页面生成失败: ' + err.message);
  }
  const size = settings.labelSize || '60x40';
  const micron = (mm) => Math.round(mm * 1000);
  const sizeMap = { '60x40': [60, 40], '50x30': [50, 30], '40x30': [40, 30], '40x25': [40, 25], '30x40': [30, 40], '80x100': [80, 100], '100x80': [100, 80] };
  const pageSize = sizeMap[size] ? { width: micron(sizeMap[size][0]), height: micron(sizeMap[size][1]) } : undefined;

  // 打印设备选项：记住上次的打印机/方向/份数/静默模式
  const po = (opts && opts.printOptions) || {};
  const printOptions = {
    silent: !!po.silent,
    printBackground: true,
    pageSize,
    margins: { marginType: 'none' },
  };
  if (po.deviceName) printOptions.deviceName = po.deviceName;
  if (po.landscape) printOptions.landscape = true;
  const copies = Math.max(1, Math.min(999, Math.round(Number(po.copies) || 1)));
  if (copies !== 1) printOptions.copies = copies;

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };
    // 超时兜底：打印对话框卡住时 5 分钟强制结束，避免界面永久阻塞
    const timer = setTimeout(() => finish({ ok: false, reason: '打印超时' }), 5 * 60 * 1000);
    try {
      win.webContents.print(printOptions, (success, reason) => {
        finish(success ? { ok: true } : { ok: false, reason: reason || '用户取消' });
      });
    } catch (err) {
      finish({ ok: false, reason: err.message });
    }
  });
}

// ---------------------------------------------------------------------------
// IPC
// ---------------------------------------------------------------------------
ipcMain.handle('data:load', () => ({ products: loadProducts(), dataDir: getDataDir() }));

ipcMain.handle('data:save', (_e, product) => {
  const list = loadProducts();
  if (!product.id) product.id = crypto.randomUUID();
  const idx = list.findIndex((p) => p.id === product.id);
  product.updatedAt = now();
  if (idx >= 0) {
    list[idx] = { ...list[idx], ...product };
  } else {
    product.createdAt = now();
    list.push(product);
  }
  productsCache = list;
  saveProducts();
  return { ok: true, products: list };
});

ipcMain.handle('data:delete', (_e, id) => {
  const list = loadProducts().filter((p) => p.id !== id);
  productsCache = list;
  saveProducts();
  return { ok: true, products: list };
});

ipcMain.handle('data:backup', async () => {
  ensureDataDir();
  const src = DATA_FILE();
  if (!fs.existsSync(src)) {
    fs.writeFileSync(src, JSON.stringify({ version: 1, products: [] }, null, 2), 'utf-8');
  }
  const stamp = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const r = await dialog.showSaveDialog(mainWindow, {
    title: '备份商品数据',
    defaultPath: path.join(app.getPath('documents'), `商品数据备份-${stamp}.json`),
    filters: [{ name: 'JSON 数据备份', extensions: ['json'] }],
  });
  if (r.canceled || !r.filePath) return { ok: false, canceled: true };
  fs.copyFileSync(src, r.filePath);
  return { ok: true, path: r.filePath };
});

ipcMain.handle('data:restore', async () => {
  const r = await dialog.showOpenDialog(mainWindow, {
    title: '选择备份文件恢复数据',
    filters: [{ name: 'JSON 数据备份', extensions: ['json'] }],
    properties: ['openFile'],
  });
  if (r.canceled || !r.filePaths.length) return { ok: false, canceled: true };
  const file = r.filePaths[0];
  let parsed;
  try {
    parsed = JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (err) {
    return { ok: false, error: '文件不是有效的备份文件' };
  }
  const list = Array.isArray(parsed.products) ? parsed.products : Array.isArray(parsed) ? parsed : null;
  if (!list) return { ok: false, error: '备份文件格式不正确' };
  // 恢复前先备份当前数据
  const cur = DATA_FILE();
  if (fs.existsSync(cur)) {
    try { fs.copyFileSync(cur, BACKUP_FILE()); } catch (_) { /* ignore */ }
  }
  productsCache = list;
  saveProducts();
  return { ok: true, products: list };
});

ipcMain.handle('data:openFolder', () => {
  const dir = ensureDataDir();
  shell.openPath(dir);
  return { ok: true };
});

ipcMain.handle('print:labels', async (_e, payload) => {
  try {
    const result = await printLabels(payload.products || [], payload.opts || {});
    return result;
  } catch (err) {
    return { ok: false, error: err.message };
  }
});

ipcMain.handle('print:getSettings', () => {
  const data = loadPrintPresets();
  if (!data) return { ok: true, presets: {}, active: '默认' };
  return { ok: true, presets: data.presets, active: data.active };
});

ipcMain.handle('print:saveSettings', (_e, payload) => {
  // payload: { active?: string, presets?: {name: settings} }
  const old = loadPrintPresets() || { active: '默认', presets: {} };
  const active = (payload && payload.active) || old.active || '默认';
  const presets = (payload && payload.presets) || old.presets || {};
  savePrintPresets(active, presets);
  return { ok: true };
});

ipcMain.handle('print:getPrinters', async (e) => {
  try {
    const win = BrowserWindow.fromWebContents(e.sender) || mainWindow;
    if (!win) return { ok: true, printers: [] };
    const printers = await win.webContents.getPrintersAsync();
    return { ok: true, printers };
  } catch (err) {
    return { ok: true, printers: [], error: err.message };
  }
});

ipcMain.handle('print:getPrintOptions', () => {
  return { ok: true, options: loadPrintOptions() || {} };
});

ipcMain.handle('print:savePrintOptions', (_e, options) => {
  savePrintOptions(options || {});
  return { ok: true };
});

// ---------------------------------------------------------------------------
// 生命周期
// ---------------------------------------------------------------------------
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (mainWindow) {
      if (mainWindow.isMinimized()) mainWindow.restore();
      mainWindow.focus();
    }
  });

  app.whenReady().then(() => {
    Menu.setApplicationMenu(null);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
