import { createContext, useCallback, useContext, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ApiError, createApi } from './api.ts';
import type { Api, LoginUser, Me, Override } from './api.ts';

// The token lives in sessionStorage: a page reload keeps the cashier signed in, closing the window does not.
// Storage can be unavailable (private mode, locked-down kiosk); the app then simply asks for the PIN again.
const TOKEN_KEY = 'pos.session';
const readToken = (): string | null => { try { return sessionStorage.getItem(TOKEN_KEY); } catch { return null; } };
/** The signed-in session token (for live streams opened with fetch). */
export const currentToken = readToken;
const writeToken = (t: string | null) => { try { if (t) sessionStorage.setItem(TOKEN_KEY, t); else sessionStorage.removeItem(TOKEN_KEY); } catch { /* storage unavailable */ } };

export interface Notice { id: number; kind: 'error' | 'success' | 'info'; text: string }

interface ApprovalRequest { reason: string; resolve: (o: Override | null) => void }

interface SessionValue {
  api: Api;
  user: Me | null;
  /** Set when the session expired or locked: the login screen preselects this person. */
  lockedUserId: string | null;
  signIn: (u: LoginUser, pin: string) => Promise<void>;
  signOut: () => Promise<void>;
  restore: () => Promise<boolean>;
  notices: Notice[];
  notify: (kind: Notice['kind'], text: string) => void;
  dismiss: (id: number) => void;
  /** Shows an error in plain language (never a stack trace). */
  fail: (e: unknown) => void;
  /**
   * Runs an action that may need a manager's approval. On APPROVAL_REQUIRED the approval dialog opens,
   * and the action runs again with the override. Callers pass the same idempotency key to both attempts.
   */
  withApproval: <T>(reason: string, run: (o?: Override) => Promise<T>) => Promise<T | null>;
  approval: ApprovalRequest | null;
}

const Ctx = createContext<SessionValue | null>(null);

export function useSession(): SessionValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useSession outside SessionProvider');
  return v;
}

export function messageOf(e: unknown): string {
  if (e instanceof ApiError) return e.message;
  return 'Something went wrong. Please try again.';
}

export function SessionProvider({ children }: { children: ReactNode }) {
  const tokenRef = useRef<string | null>(readToken());
  const [user, setUser] = useState<Me | null>(null);
  const [lockedUserId, setLockedUserId] = useState<string | null>(null);
  const [notices, setNotices] = useState<Notice[]>([]);
  const [approval, setApproval] = useState<ApprovalRequest | null>(null);
  const seq = useRef(0);
  const userRef = useRef<Me | null>(null);
  userRef.current = user;

  const notify = useCallback((kind: Notice['kind'], text: string) => {
    const id = ++seq.current;
    setNotices((n) => [...n.slice(-3), { id, kind, text }]);
    if (kind !== 'error') setTimeout(() => setNotices((n) => n.filter((x) => x.id !== id)), 6000);
  }, []);
  const dismiss = useCallback((id: number) => setNotices((n) => n.filter((x) => x.id !== id)), []);

  const api = useMemo(() => createApi({
    getToken: () => tokenRef.current,
    onAuthLost: (code) => {
      tokenRef.current = null; writeToken(null);
      setLockedUserId(userRef.current?.userId ?? null);
      setUser(null);
      if (code === 'SESSION_LOCKED') notify('info', 'Locked after inactivity. Enter your PIN to continue. The open bill is kept.');
    },
  }), [notify]);

  const fail = useCallback((e: unknown) => {
    if (e instanceof ApiError && (e.code === 'UNAUTHENTICATED' || e.code === 'SESSION_LOCKED')) return; // handled by onAuthLost
    notify('error', messageOf(e));
  }, [notify]);

  const signIn = useCallback(async (u: LoginUser, pin: string) => {
    const r = await api.login(u.id, pin);
    tokenRef.current = r.token; writeToken(r.token);
    setLockedUserId(null);
    setUser(r.user);
  }, [api]);

  const signOut = useCallback(async () => {
    try { await api.logout(); } catch { /* signing out locally is enough */ }
    tokenRef.current = null; writeToken(null);
    setLockedUserId(null);
    setUser(null);
  }, [api]);

  const restore = useCallback(async () => {
    if (!tokenRef.current) return false;
    try { setUser(await api.me()); return true; } catch { tokenRef.current = null; writeToken(null); return false; }
  }, [api]);

  const withApproval = useCallback(async <T,>(reason: string, run: (o?: Override) => Promise<T>): Promise<T | null> => {
    try {
      return await run();
    } catch (e) {
      if (!(e instanceof ApiError) || e.code !== 'APPROVAL_REQUIRED') throw e;
    }
    for (;;) {
      const override = await new Promise<Override | null>((resolve) => setApproval({ reason, resolve }));
      setApproval(null);
      if (!override) return null; // cancelled
      try {
        return await run(override);
      } catch (e) {
        if (e instanceof ApiError && (e.code === 'BAD_PIN' || e.code === 'APPROVAL_REQUIRED')) {
          notify('error', e.code === 'BAD_PIN' ? 'Incorrect approval PIN. Try again.' : e.message);
          continue;
        }
        throw e;
      }
    }
  }, [notify]);

  const value: SessionValue = { api, user, lockedUserId, signIn, signOut, restore, notices, notify, dismiss, fail, withApproval, approval };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
