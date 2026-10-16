import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { useSession } from '../lib/session.tsx';
import type { LoginUser, LoginWith } from '../lib/api.ts';
import { PinPad } from '../components/ui.tsx';
import { isMobile, mobileDigits } from '../lib/pin.ts';
import { Setup } from './Setup.tsx';

/**
 * Sign-in: mobile number and PIN. After an inactivity lock, the same person unlocks with the PIN alone.
 * Staff made before mobile numbers existed pick their name until the owner adds a number in Settings > Users.
 */
export function Login() {
  const { api, signIn, lockedUserId } = useSession();
  const [users, setUsers] = useState<LoginUser[] | null>(null);
  const [mobile, setMobile] = useState('');
  const [picked, setPicked] = useState<LoginUser | null>(null); // a user without a mobile number
  const [otherUser, setOtherUser] = useState(false); // "not you?" on the lock screen
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [offline, setOffline] = useState(false);

  const load = () => {
    setOffline(false);
    api.loginUsers().then(setUsers).catch(() => setOffline(true));
  };
  useEffect(load, [api]);
  useEffect(() => { setOtherUser(false); setPicked(null); setError(''); }, [lockedUserId]);

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

  const locked = !otherUser ? users.find((u) => u.id === lockedUserId) ?? null : null;
  const noMobile = users.filter((u) => !u.hasMobile);

  const submit = async (who: LoginWith, pin: string) => {
    setBusy(true); setError('');
    try { await signIn(who, pin); } catch (e) {
      const msg = (e as { message?: string }).message;
      setError(msg && !msg.startsWith('Incorrect') ? msg : 'mobile' in who ? 'Wrong mobile number or PIN. Try again.' : 'Wrong PIN. Try again.');
    } finally { setBusy(false); }
  };
  const byMobile = (pin: string) => {
    if (!isMobile(mobile)) { setError('Enter your 10-digit mobile number first.'); return; }
    void submit({ mobile }, pin);
  };

  const header = (text: string) => (
    <>
      <div className="mb-2 flex h-12 w-12 items-center justify-center rounded-xl bg-primary font-display text-2xl text-primary-foreground">T</div>
      <h1 className="font-display text-3xl">Tiffin POS</h1>
      <p className="mb-6 text-sm text-muted-foreground">{text}</p>
    </>
  );

  if (locked) {
    return (
      <Centered>
        {header(`Locked after inactivity. ${locked.name}, enter your PIN to continue.`)}
        <PinPad key={locked.id} busy={busy} label={`PIN for ${locked.name}`} onSubmit={(pin) => void submit({ userId: locked.id }, pin)} />
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        <button className="btn-ghost mt-4" onClick={() => { setOtherUser(true); setError(''); }}>Sign in as someone else</button>
      </Centered>
    );
  }

  if (picked) {
    return (
      <Centered>
        {header(`${picked.name} has no mobile number yet. Ask the owner to add it in Settings > Users.`)}
        <PinPad key={picked.id} busy={busy} label={`PIN for ${picked.name}`} onSubmit={(pin) => void submit({ userId: picked.id }, pin)} />
        {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
        <button className="btn-ghost mt-4" onClick={() => { setPicked(null); setError(''); }}>Back to mobile number sign-in</button>
      </Centered>
    );
  }

  return (
    <Centered>
      {header('Sign in with your mobile number and PIN.')}
      <label className="mb-5 flex w-full max-w-xs flex-col gap-1 text-left text-sm">
        <span className="font-medium">Mobile number</span>
        <input className="field text-center text-lg tabular-nums tracking-wider" inputMode="numeric" autoComplete="username" maxLength={10} placeholder="10 digits" value={mobile} autoFocus aria-label="Mobile number"
          onChange={(e) => {
            const v = mobileDigits(e.target.value);
            setMobile(v); setError('');
            if (v.length === 10) e.target.blur(); // the keyboard now types the PIN
          }}
          onKeyDown={(e) => { if (e.key === 'Enter') e.currentTarget.blur(); }} />
      </label>
      <PinPad busy={busy} label="PIN" onSubmit={byMobile} />
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      {noMobile.length > 0 && (
        <div className="mt-8 max-w-md">
          <p className="mb-2 text-xs text-muted-foreground">No mobile number yet? Pick your name:</p>
          <div className="flex flex-wrap justify-center gap-2">
            {noMobile.map((u) => (
              <button key={u.id} className="chip" onClick={() => { setPicked(u); setError(''); }}>
                {u.name} <span className="ml-1.5 text-xs opacity-70">{u.role}</span>
              </button>
            ))}
          </div>
        </div>
      )}
    </Centered>
  );
}

export function Centered({ children }: { children: ReactNode }) {
  return <div className="flex min-h-screen flex-col items-center justify-center bg-background px-4 py-10 text-center">{children}</div>;
}
