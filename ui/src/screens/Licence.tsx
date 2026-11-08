// P8-10: the licence. A lock screen when Tiffin POS has no usable licence (nothing else is reachable), a banner in its
// last days, and Settings > Licence. Three ways in: sign in with the portal account (30-day trial, or the key the
// account already has for this PC), Renew (the portal's plans page in the browser), or paste a licence key.
import { useCallback, useEffect, useState } from 'react';
import { CreditCard, KeyRound, LogIn, ShieldAlert } from 'lucide-react';
import { ApiError, LICENCE_EVENT } from '../lib/api.ts';
import type { LicenceInfo } from '../lib/api.ts';
import { useSession } from '../lib/session.tsx';

const date = (iso: string | null) => (iso ? new Date(iso).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : '');
const errorText = (e: unknown) => (e instanceof ApiError ? e.message : 'Something went wrong. Please try again.');

/** The licence, checked at start, every 5 minutes, and at once when the backend refuses a call for it. */
export function useLicence(): { licence: LicenceInfo | null; reload: () => void; set: (l: LicenceInfo) => void } {
  const { api } = useSession();
  const [licence, setLicence] = useState<LicenceInfo | null>(null);
  const reload = useCallback(() => { api.licence().then(setLicence).catch(() => { /* backend not up yet: the sign-in screen says so */ }); }, [api]);
  useEffect(() => {
    reload();
    const t = setInterval(reload, 300_000);
    const on = (e: Event) => { const d = (e as CustomEvent<{ licence?: LicenceInfo }>).detail; if (d?.licence) setLicence(d.licence); else reload(); };
    window.addEventListener(LICENCE_EVENT, on);
    return () => { clearInterval(t); window.removeEventListener(LICENCE_EVENT, on); };
  }, [reload]);
  return { licence, reload, set: setLicence };
}

/** The status and the three ways to (re)activate. Used by the lock screen and Settings > Licence. */
export function LicencePanel({ licence, onChanged }: { licence: LicenceInfo; onChanged: (l: LicenceInfo) => void }) {
  const { api } = useSession();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [key, setKey] = useState('');
  const [busy, setBusy] = useState<'' | 'trial' | 'signin' | 'key'>('');
  const [error, setError] = useState('');
  const [done, setDone] = useState('');

  const activate = async (mode: 'trial' | 'signin') => {
    if (!email.trim() || !password) { setError('Enter the email and password of your account.'); return; }
    setBusy(mode); setError(''); setDone('');
    try {
      const l = await api.activateLicence({ mode, email: email.trim(), password });
      setPassword(''); setDone(l.message); onChanged(l);
    } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };
  const install = async () => {
    if (key.trim().length < 20) { setError('Paste the whole licence key.'); return; }
    setBusy('key'); setError(''); setDone('');
    try { const l = await api.installLicence(key.trim()); setKey(''); setDone(l.message); onChanged(l); } catch (e) { setError(errorText(e)); } finally { setBusy(''); }
  };

  const bad = !licence.usable || licence.state === 'grace' || licence.state === 'activate';
  return (
    <div className="space-y-4 text-left">
      <div className={`rounded-xl border p-4 ${bad ? 'border-destructive/40 bg-destructive/5' : 'border-border bg-card'}`}>
        <p className="text-sm font-semibold" role={bad ? 'alert' : 'status'}>{licence.message}</p>
        <p className="mt-1 text-xs text-muted-foreground">
          This PC: <span className="font-mono font-semibold text-foreground">{licence.hardwareId}</span>
          {licence.expiresAt ? <> · ends {date(licence.expiresAt)}</> : null}
          {licence.licensee ? <> · {licence.licensee}</> : null}
          {licence.linked ? <> · renews by itself while online</> : null}
        </p>
      </div>
      {error ? <p className="rounded-lg bg-destructive/10 p-3 text-sm text-destructive" role="alert">{error}</p> : null}
      {done ? <p className="rounded-lg bg-accent p-3 text-sm" role="status">{done}</p> : null}

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 font-semibold"><LogIn className="h-4 w-4 text-primary" /> Sign in with your account</h2>
        <p className="mt-1 text-xs text-muted-foreground">The account you made at <a href={licence.portalUrl} target="_blank" rel="noreferrer" className="font-semibold text-primary">{licence.portalUrl.replace(/^https:\/\//, '')}</a>. No account yet? Create one there first.</p>
        <div className="mt-3 grid gap-2 sm:grid-cols-2">
          <input className="field w-full" type="email" autoComplete="email" placeholder="Email" aria-label="Account email" value={email} onChange={(e) => setEmail(e.target.value)} />
          <input className="field w-full" type="password" autoComplete="current-password" placeholder="Password" aria-label="Account password" value={password} onChange={(e) => setPassword(e.target.value)} />
        </div>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy !== ''} onClick={() => void activate('trial')}>{busy === 'trial' ? 'Starting…' : 'Start 30-day free trial'}</button>
          <button className="btn-ghost" disabled={busy !== ''} onClick={() => void activate('signin')}>{busy === 'signin' ? 'Signing in…' : 'I have a plan: get my licence'}</button>
        </div>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 font-semibold"><CreditCard className="h-4 w-4 text-primary" /> Renew</h2>
        <p className="mt-1 text-xs text-muted-foreground">Choose a plan and pay in your account. Then come back and choose <i>I have a plan: get my licence</i> (or wait: a PC that is online gets it by itself within the hour).</p>
        <a className="btn-primary mt-3 inline-flex" href={licence.renewUrl} target="_blank" rel="noreferrer">Renew or choose a plan</a>
      </section>

      <section className="rounded-xl border border-border bg-card p-4">
        <h2 className="flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-primary" /> Enter a licence key</h2>
        <p className="mt-1 text-xs text-muted-foreground">A key we sent you for this PC ({licence.hardwareId}).</p>
        <textarea className="field mt-3 h-24 w-full font-mono text-xs" placeholder="Paste the licence key" aria-label="Licence key" value={key} onChange={(e) => setKey(e.target.value)} />
        <button className="btn-ghost mt-2" disabled={busy !== ''} onClick={() => void install()}>{busy === 'key' ? 'Checking…' : 'Install key'}</button>
      </section>
    </div>
  );
}

/** Nothing else is on screen (or reachable) while Tiffin POS has no usable licence. */
export function LicenceLock({ licence, onChanged }: { licence: LicenceInfo; onChanged: (l: LicenceInfo) => void }) {
  return (
    <div className="flex min-h-screen justify-center overflow-y-auto bg-background px-4 py-10">
      <div className="w-full max-w-2xl">
        <div className="mb-6 flex items-center gap-3">
          <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-primary font-display text-2xl text-primary-foreground">T</div>
          <div>
            <h1 className="flex items-center gap-2 font-display text-3xl"><ShieldAlert className="h-6 w-6 text-destructive" /> Licence needed</h1>
            <p className="text-sm text-muted-foreground">Tiffin POS is locked until this PC has a licence. Your bills and data are safe.</p>
          </div>
        </div>
        <LicencePanel licence={licence} onChanged={onChanged} />
      </div>
    </div>
  );
}

/** A thin bar in the licence's last days, in its grace, and in the 30 days an existing install has to activate. */
export function LicenceBanner({ licence }: { licence: LicenceInfo | null }) {
  if (!licence || !licence.usable || !['expiring', 'grace', 'activate'].includes(licence.state)) return null;
  return (
    <div className={`flex flex-wrap items-center gap-3 px-4 py-2 text-sm ${licence.state === 'expiring' ? 'bg-accent' : 'bg-destructive/10 text-destructive'}`} role="status">
      <span className="font-semibold">{licence.message}</span>
      <a className="font-semibold underline" href="#/settings" onClick={() => { try { sessionStorage.setItem('pos.settings.section', 'licence'); } catch { /* storage unavailable */ } }}>Licence settings</a>
      <a className="font-semibold underline" href={licence.renewUrl} target="_blank" rel="noreferrer">Renew</a>
    </div>
  );
}
