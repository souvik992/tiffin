import { useState } from 'react';
import { Lock } from 'lucide-react';
import { useSession } from '../lib/session.tsx';
import { PinPad } from '../components/ui.tsx';
import { Centered } from './Login.tsx';

/**
 * The screen after the lock button (and after a restart while locked): only the signed-in person's PIN opens it again.
 * Nothing else of the app is on screen meanwhile; the open bill is kept by the POS and comes back after unlocking.
 */
export function LockScreen() {
  const { locked, unlock, signOut } = useSession();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  if (!locked) return null;
  const submit = async (pin: string) => {
    setBusy(true); setError('');
    try { await unlock(pin); } catch (e) {
      const msg = (e as { message?: string }).message;
      setError(msg && !msg.startsWith('Incorrect') ? msg : 'Wrong PIN. Try again.');
    } finally { setBusy(false); }
  };
  return (
    <Centered>
      <div className="mb-2 flex h-14 w-14 items-center justify-center rounded-2xl bg-primary text-primary-foreground"><Lock className="h-7 w-7" /></div>
      <h1 className="font-display text-3xl">Locked</h1>
      <p className="mb-6 text-sm text-muted-foreground">{locked.name}, enter your PIN to continue. The open bill is kept.</p>
      <PinPad key={locked.userId} busy={busy} label={`PIN for ${locked.name}`} onSubmit={(pin) => void submit(pin)} />
      {error && <p className="mt-3 text-sm text-destructive" role="alert">{error}</p>}
      <button className="btn-ghost mt-6" disabled={busy} onClick={() => void signOut()}>Sign out and sign in as someone else</button>
    </Centered>
  );
}
