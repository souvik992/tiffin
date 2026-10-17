// Minimal ELF reader/patcher for packaging Node in the APK: DT_NEEDED, DT_SONAME and segment alignment (32- and 64-bit).
import { readFileSync } from 'node:fs';

export interface ElfInfo { needed: string[]; soname: string | null; align: number; bits: 32 | 64 }

export function readElf(file: string): ElfInfo {
  const b = readFileSync(file);
  if (b.readUInt32BE(0) !== 0x7f454c46) throw new Error(`${file} is not an ELF file`);
  const is64 = b[4] === 2;
  const u = (o: number) => (is64 ? Number(b.readBigUInt64LE(o)) : b.readUInt32LE(o));
  const phoff = is64 ? u(0x20) : u(0x1c), phentsize = b.readUInt16LE(is64 ? 0x36 : 0x2a), phnum = b.readUInt16LE(is64 ? 0x38 : 0x2c);
  const loads: Array<{ vaddr: number; offset: number; align: number }> = [];
  let dyn: { offset: number; size: number } | null = null;
  for (let i = 0; i < phnum; i++) {
    const o = phoff + i * phentsize, type = b.readUInt32LE(o);
    const offset = is64 ? u(o + 8) : u(o + 4), vaddr = is64 ? u(o + 0x10) : u(o + 8), size = is64 ? u(o + 0x20) : u(o + 0x10), align = is64 ? u(o + 0x30) : u(o + 0x1c);
    if (type === 1) loads.push({ vaddr, offset, align });
    if (type === 2) dyn = { offset, size };
  }
  const entries: Array<[number, number]> = [];
  const step = is64 ? 16 : 8;
  if (dyn) for (let o = dyn.offset; o < dyn.offset + dyn.size; o += step) {
    const tag = is64 ? Number(b.readBigInt64LE(o)) : b.readInt32LE(o);
    if (tag === 0) break;
    entries.push([tag, is64 ? u(o + 8) : u(o + 4)]);
  }
  const strtab = entries.find(([t]) => t === 5)?.[1] ?? 0;
  const seg = [...loads].sort((a, z) => z.vaddr - a.vaddr).find((l) => strtab >= l.vaddr);
  const base = seg ? strtab - seg.vaddr + seg.offset : 0;
  const str = (i: number) => { const s = base + i; return b.toString('latin1', s, b.indexOf(0, s)); };
  return {
    needed: entries.filter(([t]) => t === 1).map(([, v]) => str(v)),
    soname: entries.filter(([t]) => t === 14).map(([, v]) => str(v))[0] ?? null,
    align: Math.min(...loads.map((l) => l.align)),
    bits: is64 ? 64 : 32,
  };
}

/** Replaces a library name in the string table, in place, with one no longer than it (padded with NULs). */
export function renameLib(buf: Buffer, from: string, to: string): number {
  if (from === to) return 0;
  if (to.length > from.length) throw new Error(`${to} is longer than ${from}`);
  const needle = Buffer.from(`\0${from}\0`, 'latin1');
  let n = 0;
  for (let i = buf.indexOf(needle); i >= 0; i = buf.indexOf(needle, i + 1)) { Buffer.from(to.padEnd(from.length, '\0'), 'latin1').copy(buf, i + 1); n++; }
  return n;
}

/** "libssl.so.3" -> "libssl3.so"; "libcares.so" stays. Android installs only lib*.so files. */
export const apkName = (soname: string): string => { const m = /^(lib.+)\.so\.(\d+)(?:\.[\d.]+)?$/.exec(soname); return m ? `${m[1]}${m[2]}.so` : soname; };
