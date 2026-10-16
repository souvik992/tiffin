import { AppError } from '../store/db.ts';

export type V<T> = (v: unknown, path: string) => T;
const bad = (path: string, msg: string): never => { throw new AppError('VALIDATION', `${path || 'body'}: ${msg}`, 400); };

export const str = (o: { min?: number; max?: number } = {}): V<string> => (v, p) => {
  if (typeof v !== 'string') return bad(p, 'must be text');
  if (v.length < (o.min ?? 0)) return bad(p, `must be at least ${o.min} characters`);
  if (v.length > (o.max ?? 5000)) return bad(p, `must be at most ${o.max ?? 5000} characters`);
  return v;
};
export const int = (o: { min?: number; max?: number } = {}): V<number> => (v, p) => {
  if (typeof v !== 'number' || !Number.isSafeInteger(v)) return bad(p, 'must be a whole number');
  if (o.min !== undefined && v < o.min) return bad(p, `must be at least ${o.min}`);
  if (o.max !== undefined && v > o.max) return bad(p, `must be at most ${o.max}`);
  return v;
};
export const bool: V<boolean> = (v, p) => (typeof v === 'boolean' ? v : bad(p, 'must be true or false'));
export const oneOf = <T extends string>(...vals: T[]): V<T> => (v, p) => (typeof v === 'string' && (vals as string[]).includes(v) ? (v as T) : bad(p, `must be one of ${vals.join(', ')}`));
export const opt = <T>(inner: V<T>): V<T | undefined> => (v, p) => (v === undefined ? undefined : inner(v, p));
export const nullable = <T>(inner: V<T>): V<T | null> => (v, p) => (v === null ? null : inner(v, p));
export const arr = <T>(inner: V<T>, o: { max?: number } = {}): V<T[]> => (v, p) => {
  if (!Array.isArray(v)) return bad(p, 'must be a list');
  if (v.length > (o.max ?? 2000)) return bad(p, 'has too many entries');
  return v.map((x, i) => inner(x, `${p}[${i}]`));
};
export const obj = <S extends Record<string, V<unknown>>>(shape: S): V<{ [K in keyof S]: ReturnType<S[K]> }> => (v, p) => {
  if (typeof v !== 'object' || v === null || Array.isArray(v)) return bad(p, 'must be an object');
  const rec = v as Record<string, unknown>;
  for (const k of Object.keys(rec)) if (!(k in shape)) bad(p ? `${p}.${k}` : k, 'is not an allowed field');
  const out: Record<string, unknown> = {};
  for (const [k, inner] of Object.entries(shape)) {
    const r = inner(rec[k], p ? `${p}.${k}` : k);
    if (r !== undefined) out[k] = r;
  }
  return out as { [K in keyof S]: ReturnType<S[K]> };
};

export const discount = obj({ type: oneOf('amount', 'percent'), value: int({ min: 0 }) });
export const override = obj({ userId: str({ min: 1, max: 64 }), pin: str({ min: 4, max: 6 }) });
export const payment = obj({ mode: str({ max: 10 }), amount: int({ min: 1 }), tendered: opt(nullable(int({ min: 1 }))), reference: opt(nullable(str({ max: 60 }))) });
