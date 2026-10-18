// electron-builder afterPack: leaves out Electron files the POS never uses, so the installer unpacks and writes less
// (it matters on low-end shop PCs). dxcompiler.dll and dxil.dll compile shaders for WebGPU on Direct3D 12 only;
// the POS draws no 3D. Normal drawing keeps d3dcompiler_47.dll (Direct3D 11) and SwiftShader (no graphics card).
const { rmSync, existsSync } = require('node:fs');
const { join } = require('node:path');

const UNUSED = ['dxcompiler.dll', 'dxil.dll'];

exports.default = async function afterPack(context) {
  for (const name of UNUSED) {
    const file = join(context.appOutDir, name);
    if (existsSync(file)) rmSync(file);
  }
};
