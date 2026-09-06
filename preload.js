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
});
