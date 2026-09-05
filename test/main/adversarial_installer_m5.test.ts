import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';

function parsePEHeader(filePath: string) {
  const fd = fs.openSync(filePath, 'r');
  const buffer = Buffer.alloc(4096);
  fs.readSync(fd, buffer, 0, 4096, 0);
  fs.closeSync(fd);

  // DOS MZ check
  const isMZ = buffer[0] === 0x4d && buffer[1] === 0x5a; // 'MZ'
  if (!isMZ) {
    return { valid: false, reason: 'Not a valid MZ header' };
  }

  // Offset to PE Header is at 0x3C (DWORD)
  const peOffset = buffer.readInt32LE(0x3c);
  if (peOffset < 0 || peOffset + 24 > buffer.length) {
    return { valid: false, reason: `Invalid PE header offset: ${peOffset}` };
  }

  // PE signature 'PE\0\0' (0x00004550)
  const isPE =
    buffer[peOffset] === 0x50 &&
    buffer[peOffset + 1] === 0x45 &&
    buffer[peOffset + 2] === 0x00 &&
    buffer[peOffset + 3] === 0x00;

  if (!isPE) {
    return { valid: false, reason: 'Missing PE signature at offset' };
  }

  const machine = buffer.readUInt16LE(peOffset + 4);
  let machineType = 'Unknown';
  if (machine === 0x014c) machineType = 'IMAGE_FILE_MACHINE_I386 (x86 32-bit)';
  else if (machine === 0x8664) machineType = 'IMAGE_FILE_MACHINE_AMD64 (x64 64-bit)';
  else if (machine === 0xaa64) machineType = 'IMAGE_FILE_MACHINE_ARM64';

  const characteristics = buffer.readUInt16LE(peOffset + 22);
  const isDLL = (characteristics & 0x2000) !== 0;
  const isExecutable = (characteristics & 0x0002) !== 0;

  return {
    valid: true,
    isMZ,
    isPE,
    peOffset,
    machine,
    machineType,
    characteristics,
    isDLL,
    isExecutable
  };
}

function getFileHash(filePath: string): string {
  const content = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(content).digest('hex');
}

describe('M5 Windows Production Installer & Artifacts Verification', () => {
  const rootDir = path.resolve(__dirname, '../../');
  const distDir = path.join(rootDir, 'dist');
  const setupExe = path.join(distDir, 'jarvis-1.0.0-setup.exe');
  const unpackedExe = path.join(distDir, 'win-unpacked', 'jarvis.exe');
  const resourcesDir = path.join(distDir, 'win-unpacked', 'resources');
  const asarFile = path.join(resourcesDir, 'app.asar');
  const unpackedResourcesDir = path.join(resourcesDir, 'app.asar.unpacked');

  it('verifies NSIS installer executable (jarvis-1.0.0-setup.exe) integrity and PE headers', () => {
    expect(fs.existsSync(setupExe)).toBe(true);
    const stat = fs.statSync(setupExe);
    expect(stat.size).toBeGreaterThan(100 * 1024 * 1024); // > 100MB

    const pe = parsePEHeader(setupExe);
    expect(pe.valid).toBe(true);
    expect(pe.isMZ).toBe(true);
    expect(pe.isPE).toBe(true);
    expect(pe.isExecutable).toBe(true);
    // NSIS installer executable header is standard 32-bit stub or 64-bit launcher
    expect([0x014c, 0x8664]).toContain(pe.machine);

    const hash = getFileHash(setupExe);
    expect(hash.length).toBe(64);
  });

  it('verifies unpacked main application binary (jarvis.exe) integrity and PE headers', () => {
    expect(fs.existsSync(unpackedExe)).toBe(true);
    const stat = fs.statSync(unpackedExe);
    expect(stat.size).toBeGreaterThan(100 * 1024 * 1024); // > 100MB

    const pe = parsePEHeader(unpackedExe);
    expect(pe.valid).toBe(true);
    expect(pe.isMZ).toBe(true);
    expect(pe.isPE).toBe(true);
    expect(pe.machine).toBe(0x8664); // Must be AMD64 (x64)
    expect(pe.machineType).toContain('AMD64');
    expect(pe.isExecutable).toBe(true);

    const hash = getFileHash(unpackedExe);
    expect(hash.length).toBe(64);
  });

  it('verifies app.asar archive existence and non-zero size', () => {
    expect(fs.existsSync(asarFile)).toBe(true);
    const stat = fs.statSync(asarFile);
    expect(stat.size).toBeGreaterThan(1024 * 1024); // > 1MB
  });

  it('verifies better-sqlite3 native bindings in app.asar.unpacked', () => {
    const bsDir = path.join(unpackedResourcesDir, 'node_modules', 'better-sqlite3');
    expect(fs.existsSync(bsDir)).toBe(true);

    const win64Node = path.join(bsDir, 'prebuilds', 'win32-x64.node');
    expect(fs.existsSync(win64Node)).toBe(true);
    const stat = fs.statSync(win64Node);
    expect(stat.size).toBeGreaterThan(500 * 1024); // > 500KB

    // PE Header check for win32-x64.node
    const pe = parsePEHeader(win64Node);
    expect(pe.valid).toBe(true);
    expect(pe.isMZ).toBe(true);
    expect(pe.isPE).toBe(true);
    expect(pe.machine).toBe(0x8664); // Must be x64 DLL
    expect(pe.isDLL).toBe(true);

    // Test requiring and executing better-sqlite3 from the unpacked folder
    const Database = require(bsDir);
    const db = new Database(':memory:');
    db.exec('CREATE TABLE challenger_test (id INTEGER PRIMARY KEY, name TEXT)');
    const insert = db.prepare('INSERT INTO challenger_test (name) VALUES (?)');
    insert.run('challenger_verification_passed');
    const row = db.prepare('SELECT * FROM challenger_test WHERE id = 1').get() as {
      id: number;
      name: string;
    };
    expect(row).toBeDefined();
    expect(row.name).toBe('challenger_verification_passed');
    db.close();
  });

  it('verifies sqlite3 native bindings in app.asar.unpacked', () => {
    const sqlite3Node = path.join(
      unpackedResourcesDir,
      'node_modules',
      'sqlite3',
      'build',
      'Release',
      'node_sqlite3.node'
    );
    expect(fs.existsSync(sqlite3Node)).toBe(true);
    const pe = parsePEHeader(sqlite3Node);
    expect(pe.valid).toBe(true);
    expect(pe.isMZ).toBe(true);
    expect(pe.isPE).toBe(true);
    expect(pe.machine).toBe(0x8664);
    expect(pe.isDLL).toBe(true);
  });

  it('verifies bundled Live2D Mao Pro model assets integrity in unpacked resources', () => {
    const maoProDir = path.join(unpackedResourcesDir, 'out', 'renderer', 'models', 'mao_pro');
    expect(fs.existsSync(maoProDir)).toBe(true);

    const model3JsonPath = path.join(maoProDir, 'runtime', 'mao_pro.model3.json');
    expect(fs.existsSync(model3JsonPath)).toBe(true);
    const model3Content = JSON.parse(fs.readFileSync(model3JsonPath, 'utf8'));
    expect(model3Content.Version).toBe(3);
    expect(model3Content.FileReferences).toBeDefined();
    expect(model3Content.FileReferences.Moc).toBe('mao_pro.moc3');

    // Verify .moc3 binary exists and is valid size
    const moc3Path = path.join(maoProDir, 'runtime', model3Content.FileReferences.Moc);
    expect(fs.existsSync(moc3Path)).toBe(true);
    expect(fs.statSync(moc3Path).size).toBeGreaterThan(100 * 1024);

    // Verify textures exist
    for (const tex of model3Content.FileReferences.Textures) {
      const texPath = path.join(maoProDir, 'runtime', tex);
      expect(fs.existsSync(texPath)).toBe(true);
      expect(fs.statSync(texPath).size).toBeGreaterThan(10 * 1024);
    }

    // Verify motions exist
    if (model3Content.FileReferences.Motions) {
      for (const group of Object.keys(model3Content.FileReferences.Motions)) {
        const motions = model3Content.FileReferences.Motions[group];
        for (const m of motions) {
          const mPath = path.join(maoProDir, 'runtime', m.File);
          expect(fs.existsSync(mPath)).toBe(true);
        }
      }
    }
  });

  it('verifies bundled Live2D Shizuku model assets integrity in unpacked resources', () => {
    const shizukuDir = path.join(unpackedResourcesDir, 'out', 'renderer', 'models', 'shizuku');
    expect(fs.existsSync(shizukuDir)).toBe(true);

    const model3JsonPath = path.join(shizukuDir, 'runtime', 'shizuku.model3.json');
    expect(fs.existsSync(model3JsonPath)).toBe(true);
    const model3Content = JSON.parse(fs.readFileSync(model3JsonPath, 'utf8'));
    expect(model3Content.Version).toBe(3);
    expect(model3Content.FileReferences.Moc).toBe('shizuku.moc3');

    const moc3Path = path.join(shizukuDir, 'runtime', model3Content.FileReferences.Moc);
    expect(fs.existsSync(moc3Path)).toBe(true);
    expect(fs.statSync(moc3Path).size).toBeGreaterThan(50 * 1024);
  });

  it('verifies 3D VRM models and ONNX/WASM runtime libraries exist in unpacked bundle', () => {
    const avatarVrm = path.join(
      unpackedResourcesDir,
      'out',
      'renderer',
      'models',
      '2063446566963229667.vrm'
    );
    expect(fs.existsSync(avatarVrm)).toBe(true);
    expect(fs.statSync(avatarVrm).size).toBeGreaterThan(10 * 1024 * 1024); // > 10MB VRM file

    const libsDir = path.join(unpackedResourcesDir, 'out', 'renderer', 'libs');
    expect(fs.existsSync(libsDir)).toBe(true);
    expect(fs.existsSync(path.join(libsDir, 'live2dcubismcore.min.js'))).toBe(true);
    expect(fs.existsSync(path.join(libsDir, 'live2d.min.js'))).toBe(true);
  });
});
