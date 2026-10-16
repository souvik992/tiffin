export interface Clock { now(): number }
export type Rng = (n: number) => Uint8Array;

export interface IdGenerator { next(): string }

/**
 * UUIDv7 (RFC 9562, method 1): 48-bit ms timestamp + 12-bit counter + random.
 * Strictly increasing within one generator, even with a frozen clock.
 * Clock and randomness are injected so tests are deterministic.
 */
export function createIdGenerator(clock: Clock, rng: Rng): IdGenerator {
  let lastMs = -1;
  let counter = 0;
  return {
    next(): string {
      let ms = clock.now();
      if (ms > lastMs) {
        lastMs = ms;
        const r = rng(2);
        counter = (((r[0]! << 8) | r[1]!) & 0x7ff); // start below 2048 to leave headroom
      } else {
        counter++;
        if (counter > 0xfff) { lastMs++; counter = 0; }
        ms = lastMs;
      }
      const b = new Uint8Array(16);
      let t = BigInt(ms);
      for (let i = 5; i >= 0; i--) { b[i] = Number(t & 0xffn); t >>= 8n; }
      b[6] = 0x70 | ((counter >> 8) & 0x0f);
      b[7] = counter & 0xff;
      const r = rng(8);
      b[8] = 0x80 | (r[0]! & 0x3f);
      for (let i = 1; i < 8; i++) b[8 + i] = r[i]!;
      const h = Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
      return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
    },
  };
}
