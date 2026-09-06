'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('api', {
  loadData: () => ipcRenderer.invoke('data:load'),
  saveProduct: (product) => ipcRenderer.invoke('data:save', product),
  deleteProduct: (id) => ipcRenderer.invoke('data:delete', id),
  backupData: () => ipcRenderer.invoke('data:backup'),
  restoreData: () => ipcRenderer.invoke('data:restore'),
  openDataFolder: () => ipcRenderer.invoke('data:openFolder'),
  printLabels: (products, opts) => ipcRenderer.invoke('print:labels', { products, opts }),
  getPrintSettings: () => ipcRenderer.invoke('print:getSettings'),
  savePrintSettings: (settings) => ipcRenderer.invoke('print:saveSettings', settings),
  getPrinters: () => ipcRenderer.invoke('print:getPrinters'),
  getPrintOptions: () => ipcRenderer.invoke('print:getPrintOptions'),
  savePrintOptions: (options) => ipcRenderer.invoke('print:savePrintOptions', options),
  getPrintHistory: () => ipcRenderer.invoke('print:getHistory'),
  savePrintHistory: (entry) => ipcRenderer.invoke('print:saveHistory', entry),
  exportPdf: (payload) => ipcRenderer.invoke('print:exportPdf', payload),
  // 关窗瞬间防抖未落盘的设置用 fire-and-forget 同步发出，避免 invoke 被卸载打断
  savePrintSettingsSync: (settings) => ipcRenderer.send('print:saveSettingsSync', settings),
});
