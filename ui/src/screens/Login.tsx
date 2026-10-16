import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSession } from '../lib/session.tsx';
import type { LoginUser } from '../lib/api.ts';
import { PinPad } from '../components/ui.tsx';
import { Setup } from './Setup.tsx';

export function Login() {
  const { api, signIn, lockedUserId } = useSession();
  const [users, setUsers] = useState<LoginUser[] | null>(null);
  const [picked, setPicked] = useState<LoginUser | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);

  const load = () => {
    setOffline(false);
    api.loginUsers().then((u) => {
      setUsers(u);
      setPicked(u.find((x) => x.id === lockedUserId) ?? (u.length === 1 ? u[0]! : null));
    }).catch(() => setOffline(true));
  };
  useEffect(load, [api, lockedUserId]);

  if (offline) {
    return (
      <Centered>
        <h1 className="font-display text-3xl">Billing service not running</h1>
        <p className="mt-2 text-sm text-muted-foreground">Start the POS backend on this computer, then try again.</p>
        <button className="btn-primary mt-6" onClick={load}>Try again</button>
      </Centered>
    );
  }
  if (!users) return <Centered><p className="text-muted-foreground">Loading…</p></Centered>;
  if (users.length === 0) return <Setup onDone={load} />;

  const submit = async (pin: string) => {
    if (!picked) return;
    setBusy(true); setError('');
    try { await signIn(picked, pin); } catch (e) {
      const msg = (e as { message?: string }).message;
      setError(msg && msg !== 'Incorrect user or PIN.' ? msg : 'Wrong PIN. Try again.');
    } finally { setBusy(false); }
  };

  return (
    <Centered>
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary font-display text-2xl text-primary-foreground">T</div>
      <h1 className="font-display text-3xl">Tiffin POS</h1>
      <p className="mb-6 text-sm text-muted-foreground">{lockedUserId ? 'Session locked. Enter your PIN to continue.' : 'Who is billing?'}</p>
      <div className="mb-6 flex flex-wrap justify-center gap-2">
        {users.map((u) => (
          <button key={u.id} className={`chip ${picked?.id === u.id ? 'chip-active' : ''}`} onClick={() => { setPicked(u); setError(''); }}>
            {u.name} <span className="ml-1.5 text-xs opacity-70">{u.role}</span>
          </button>
        ))}
      </div>
      {picked && <PinPad key={picked.id} busy={busy} label={`PIN for ${picked.name}`} onSubmit={submit} />}
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
    </Centered>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10 text-center">{children}</div>;
}
