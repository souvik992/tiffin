import { useCallback, useEffect, useRef, useState } from 'react';
import { KeyRound, Pencil, Plus, UserCheck, UserX } from 'lucide-react';
import { newKey } from '../lib/api.ts';
import type { Role, StaffUser } from '../lib/api.ts';
import { messageOf, useSession } from '../lib/session.tsx';
import { Modal } from '../components/ui.tsx';
import { PIN_LENGTH, isPin, pinDigits } from '../lib/pin.ts';

const ROLES: Array<{ role: Role; label: string; can: string }> = [
  { role: 'cashier', label: 'Cashier', can: 'Bills, payments, own shift, reprints, sees stock.' },
  { role: 'manager', label: 'Manager', can: 'Everything a cashier does, plus cancellations, refunds, big discounts, menu, stock, purchases, reports and printers.' },
  { role: 'owner', label: 'Owner', can: 'Everything, plus store details, bill design, users and backups.' },
];
const roleLabel = (r: Role) => ROLES.find((x) => x.role === r)!.label;

/** Settings > Users (owner only): who can sign in, with which role and PIN. */
export function UsersSettings() {
  const { api, fail, notify } = useSession();
  const [users, setUsers] = useState<StaffUser[] | null>(null);
  const [dialog, setDialog] = useState<{ kind: 'add' } | { kind: 'edit' | 'pin' | 'off'; user: StaffUser } | null>(null);
  const load = useCallback(() => api.users().then(setUsers).catch((e) => { setUsers([]); fail(e); }), [api, fail]);
  useEffect(() => { void load(); }, [load]);

  const reactivate = async (u: StaffUser) => {
    try { await api.reactivateUser(u.id); notify('success', `${u.name} can sign in again with their old PIN.`); await load(); } catch (e) { fail(e); }
  };
  const done = (msg: string) => { setDialog(null); notify('success', msg); void load(); };

  return (
    <>
      <div className="mb-4 flex items-center gap-3">
        <h2 className="font-display text-2xl">Users</h2>
        <button className="btn-primary ml-auto" onClick={() => setDialog({ kind: 'add' })}><Plus className="h-4 w-4" />Add user</button>
      </div>
      <p className="mb-4 text-sm text-muted-foreground">Everyone who signs in to this POS. They pick their name on the sign-in screen and type their PIN.</p>
      <table className="table">
        <thead className="bg-muted text-left">
          <tr><th className="p-3">Name</th><th>Role</th><th>Status</th><th className="w-80 pr-3 text-right">Actions</th></tr>
        </thead>
        <tbody>
          {users === null && <tr><td colSpan={4} className="p-6 text-center text-muted-foreground">Loading…</td></tr>}
          {users?.map((u) => (
            <tr key={u.id} className={`border-t border-border ${u.active ? '' : 'text-muted-foreground'}`}>
              <td className="p-3 font-medium">{u.name}{u.you && <span className="ml-2 rounded-full bg-accent px-2 py-0.5 text-xs text-primary">You</span>}</td>
              <td>{roleLabel(u.role)}</td>
              <td>
                {!u.active ? <span className="rounded-full bg-muted px-2 py-0.5 text-xs font-semibold">Deactivated</span>
                  : u.locked ? <span className="rounded-full bg-destructive/15 px-2 py-0.5 text-xs font-semibold text-destructive" title="Too many wrong PINs. Reset the PIN to unlock now.">Locked</span>
                  : <span className="rounded-full bg-primary/15 px-2 py-0.5 text-xs font-semibold text-primary">Active</span>}
              </td>
              <td className="pr-3">
                <div className="flex justify-end gap-1">
                  {u.active ? (
                    <>
                      <button className="btn-ghost h-9 whitespace-nowrap px-3" onClick={() => setDialog({ kind: 'edit', user: u })}><Pencil className="h-4 w-4" />Edit</button>
                      <button className="btn-ghost h-9 whitespace-nowrap px-3" onClick={() => setDialog({ kind: 'pin', user: u })}><KeyRound className="h-4 w-4" />{u.you ? 'Change PIN' : 'Reset PIN'}</button>
                      {!u.you && <button className="btn-ghost h-9 whitespace-nowrap px-3" onClick={() => setDialog({ kind: 'off', user: u })}><UserX className="h-4 w-4" />Deactivate</button>}
                    </>
                  ) : <button className="btn-ghost h-9 whitespace-nowrap px-3" onClick={() => void reactivate(u)}><UserCheck className="h-4 w-4" />Reactivate</button>}
                </div>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {dialog?.kind === 'add' && <UserDialog onClose={() => setDialog(null)} onDone={(n) => done(`${n} can now sign in.`)} />}
      {dialog?.kind === 'edit' && <UserDialog user={dialog.user} onClose={() => setDialog(null)} onDone={(n) => done(`${n} saved.`)} />}
      {dialog?.kind === 'pin' && <PinDialog user={dialog.user} onClose={() => setDialog(null)} onDone={() => done(dialog.user.you ? 'Your PIN is changed.' : `${dialog.user.name}'s PIN is reset. Tell them the new PIN.`)} />}
      {dialog?.kind === 'off' && <DeactivateDialog user={dialog.user} onClose={() => setDialog(null)} onDone={() => done(`${dialog.user.name} can no longer sign in. Their bills stay in the records.`)} />}
    </>
  );
}

function PinFields({ pin, setPin, again, setAgain }: { pin: string; setPin: (v: string) => void; again: string; setAgain: (v: string) => void }) {
  return (
    <div className="grid grid-cols-2 gap-3">
      <label className="block text-sm font-medium">PIN ({PIN_LENGTH} digits)
        <input className="field mt-1 w-full tracking-[0.4em]" type="password" inputMode="numeric" autoComplete="new-password" value={pin} maxLength={PIN_LENGTH} onChange={(e) => setPin(pinDigits(e.target.value))} aria-label="PIN" />
      </label>
      <label className="block text-sm font-medium">PIN again
        <input className="field mt-1 w-full tracking-[0.4em]" type="password" inputMode="numeric" autoComplete="new-password" value={again} maxLength={PIN_LENGTH} onChange={(e) => setAgain(pinDigits(e.target.value))} aria-label="PIN again" />
      </label>
    </div>
  );
}
const pinProblem = (pin: string, again: string) => (!isPin(pin) ? `The PIN must be exactly ${PIN_LENGTH} digits.` : pin !== again ? 'The two PINs are different.' : null);

function UserDialog({ user, onClose, onDone }: { user?: StaffUser; onClose: () => void; onDone: (name: string) => void }) {
  const { api } = useSession();
  const key = useRef(newKey());
  const [name, setName] = useState(user?.name ?? '');
  const [role, setRole] = useState<Role>(user?.role ?? 'cashier');
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const problem = !name.trim() ? 'Enter a name.' : user ? null : pinProblem(pin, again);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      const r = user ? await api.updateUser(user.id, { name: name.trim(), role }, key.current) : await api.createUser({ name: name.trim(), role, pin }, key.current);
      onDone(r.name);
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={user ? `Edit ${user.name}` : 'Add user'} onClose={onClose} width="max-w-lg">
      <div className="space-y-4">
        <label className="block text-sm font-medium">Name, as shown on the sign-in screen
          <input className="field mt-1 w-full" maxLength={60} value={name} onChange={(e) => setName(e.target.value)} placeholder="Ravi K" aria-label="Name" autoFocus />
        </label>
        <fieldset>
          <legend className="mb-1 text-sm font-medium">Role</legend>
          <div className="space-y-2" role="radiogroup">
            {ROLES.map((r) => (
              <label key={r.role} className={`flex cursor-pointer items-start gap-3 rounded-xl border p-3 ${role === r.role ? 'border-primary bg-accent' : 'border-border'} ${user?.you ? 'cursor-not-allowed opacity-60' : ''}`}>
                <input type="radio" name="role" className="mt-1" checked={role === r.role} disabled={user?.you} onChange={() => setRole(r.role)} aria-label={r.label} />
                <span><span className="block text-sm font-semibold">{r.label}</span><span className="text-xs text-muted-foreground">{r.can}</span></span>
              </label>
            ))}
          </div>
          {user?.you && <p className="mt-1 text-xs text-muted-foreground">You cannot change your own role. Another owner can.</p>}
        </fieldset>
        {!user && <PinFields pin={pin} setPin={setPin} again={again} setAgain={setAgain} />}
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : user ? 'Save' : 'Add user'}</button>
        </div>
      </div>
    </Modal>
  );
}

function PinDialog({ user, onClose, onDone }: { user: StaffUser; onClose: () => void; onDone: () => void }) {
  const { api } = useSession();
  const key = useRef(newKey());
  const [pin, setPin] = useState('');
  const [again, setAgain] = useState('');
  const [current, setCurrent] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const save = async () => {
    const problem = pinProblem(pin, again);
    if (problem) { setError(problem); return; }
    setBusy(true); setError(null);
    try {
      if (user.you) await api.changeOwnPin(user.id, current, pin, key.current);
      else await api.resetPin(user.id, pin, key.current);
      onDone();
    } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={user.you ? 'Change your PIN' : `New PIN for ${user.name}`} onClose={onClose}>
      <div className="space-y-4">
        {user.you ? (
          <label className="block text-sm font-medium">Your current PIN
            <input className="field mt-1 w-full tracking-[0.4em]" type="password" inputMode="numeric" value={current} maxLength={PIN_LENGTH} onChange={(e) => setCurrent(pinDigits(e.target.value))} aria-label="Current PIN" autoFocus />
          </label>
        ) : <p className="text-sm text-muted-foreground">Use this when {user.name} forgot their PIN or is locked out. Tell them the new PIN in person.</p>}
        <PinFields pin={pin} setPin={setPin} again={again} setAgain={setAgain} />
        {error && <p role="alert" className="text-sm text-destructive">{error}</p>}
        <div className="flex gap-2">
          <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
          <button className="btn-primary flex-1" disabled={busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save PIN'}</button>
        </div>
      </div>
    </Modal>
  );
}

function DeactivateDialog({ user, onClose, onDone }: { user: StaffUser; onClose: () => void; onDone: () => void }) {
  const { api } = useSession();
  const key = useRef(newKey());
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const go = async () => {
    setBusy(true);
    try { await api.deactivateUser(user.id, key.current); onDone(); } catch (e) { key.current = newKey(); setError(messageOf(e)); } finally { setBusy(false); }
  };
  return (
    <Modal title={`Deactivate ${user.name}?`} onClose={onClose}>
      <p className="text-sm">{user.name} will be signed out now and removed from the sign-in screen. Their bills and history stay. You can reactivate them later.</p>
      {error && <p role="alert" className="mt-2 text-sm text-destructive">{error}</p>}
      <div className="mt-4 flex gap-2">
        <button className="btn-ghost flex-1" onClick={onClose}>Cancel</button>
        <button className="btn-primary flex-1 bg-destructive" disabled={busy} onClick={() => void go()}>Deactivate</button>
      </div>
    </Modal>
  );
}
