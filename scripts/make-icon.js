'use strict';
/* ============================================================
 * make-icon.js — 从源图生成应用图标
 *   build/icon.ico：多尺寸 PNG-entry ICO（256/128/64/48/32/16）
 *   build/icon.png：1024×1024 PNG（electron-builder 转换用）
 * 用法：ICON_SRC=<源图> npx electron scripts/make-icon.js
 * ============================================================ */
const { app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');

const SRC = process.env.ICON_SRC;
const OUT_DIR = path.join(__dirname, '..', 'build');
const SIZES = [256, 128, 64, 48, 32, 16];

app.whenReady().then(() => {
  try {
    if (!SRC) throw new Error('missing ICON_SRC env');
    const img = nativeImage.createFromPath(SRC);
    if (img.isEmpty()) throw new Error('source image unreadable: ' + SRC);
    // 中心裁正方形（源图已是正方形则原样）
    const { width: iw, height: ih } = img.getSize();
    const side = Math.min(iw, ih);
    const base = (iw === ih)
      ? img
      : img.crop({
          x: Math.floor((iw - side) / 2),
          y: Math.floor((ih - side) / 2),
          width: side,
          height: side,
        });

    fs.mkdirSync(OUT_DIR, { recursive: true });

    // icon.png：1024×1024（builder 用 ≥512 的 png 自动转 ico 的后备路径）
    const pngOut = base.resize({ width: 1024, height: 1024 }).toPNG();
    fs.writeFileSync(path.join(OUT_DIR, 'icon.png'), pngOut);

    // icon.ico：各尺寸缩放为 PNG entry，手工打包 ICO 容器（Vista+ 支持 PNG entry）
    const pngs = SIZES.map((s) => ({ s, buf: base.resize({ width: s, height: s }).toPNG() }));
    const header = Buffer.alloc(6);
    header.writeUInt16LE(0, 0);           // reserved
    header.writeUInt16LE(1, 2);           // type: icon
    header.writeUInt16LE(pngs.length, 4); // count
    let offset = 6 + 16 * pngs.length;
    const entries = [];
    const datas = [];
    for (const { s, buf } of pngs) {
      const e = Buffer.alloc(16);
      e.writeUInt8(s >= 256 ? 0 : s, 0); // 256 写 0
      e.writeUInt8(s >= 256 ? 0 : s, 1);
      e.writeUInt8(0, 2);                // 调色板色数（PNG entry 为 0）
      e.writeUInt8(0, 3);                // reserved
      e.writeUInt16LE(1, 4);             // planes
      e.writeUInt16LE(32, 6);            // bpp
      e.writeUInt32LE(buf.length, 8);    // 数据长度
      e.writeUInt32LE(offset, 12);       // 数据偏移
      offset += buf.length;
      entries.push(e);
      datas.push(buf);
    }
    const ico = Buffer.concat([header, ...entries, ...datas]);
    const icoPath = path.join(OUT_DIR, 'icon.ico');
    fs.writeFileSync(icoPath, ico);

    // 校验：能被重新读取且为正方形
    const check = nativeImage.createFromPath(icoPath);
    if (check.isEmpty()) throw new Error('generated ico unreadable');
    const sz = check.getSize();
    console.log(`ICO_OK ${sz.width}x${sz.height} bytes=${ico.length} entries=${pngs.length}`);
    app.exit(0);
  } catch (e) {
    console.log('ICO_FAIL ' + (e && e.message ? e.message : e));
    app.exit(1);
  }
});
