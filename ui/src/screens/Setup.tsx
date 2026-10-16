import { useRef, useState } from 'react';
import type { FormEvent } from 'react';
import { useSession, messageOf } from '../lib/session.tsx';
import { newKey } from '../lib/api.ts';
import { PIN_LENGTH, isMobile, isPin, mobileDigits, pinDigits } from '../lib/pin.ts';

/** First run on a new PC: creates the outlet, this counter and the owner (POST /api/setup, allowed once). */
export function Setup({ onDone }: { onDone: () => void }) {
  const { api, notify } = useSession();
  const key = useRef(newKey()); // one key for this setup, so a double submit cannot create two outlets
  const [f, setF] = useState({ name: '', gstin: '', fssaiNo: '', stateCode: '', address: '', phone: '', device: 'Counter 1', prefix: 'A1', owner: '', mobile: '', pin: '', pin2: '' });
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const set = (k: keyof typeof f) => (e: { target: { value: string } }) => setF({ ...f, [k]: k === 'pin' || k === 'pin2' ? pinDigits(e.target.value) : k === 'mobile' ? mobileDigits(e.target.value) : e.target.value });

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    if (!isMobile(f.mobile)) return setError('Enter the owner\'s 10-digit mobile number. It is used to sign in.');
    if (!isPin(f.pin)) return setError(`The PIN must be exactly ${PIN_LENGTH} digits.`);
    if (f.pin !== f.pin2) return setError('The two PINs do not match.');
    setBusy(true); setError('');
    try {
      await api.setup({
        outlet: { name: f.name.trim(), gstin: f.gstin.trim().toUpperCase() || null, fssaiNo: f.fssaiNo.trim() || null, stateCode: f.stateCode.trim(), address: f.address.trim() || null, phone: f.phone.trim() || null },
        device: { name: f.device.trim(), seriesPrefix: f.prefix.trim().toUpperCase() },
        owner: { name: f.owner.trim(), pin: f.pin, mobile: f.mobile },
      }, key.current);
      notify('success', 'Shop set up. Sign in as the owner to add your menu.');
      onDone();
    } catch (err) { setError(messageOf(err)); } finally { setBusy(false); }
  };

  const field = (label: string, k: keyof typeof f, o: { required?: boolean; placeholder?: string; type?: string; inputMode?: 'numeric' | 'text'; maxLength?: number; hint?: string } = {}) => (
    <label className="flex flex-col gap-1 text-left text-sm">
      <span className="font-medium">{label}{o.required ? '' : <span className="text-muted-foreground"> (optional)</span>}</span>
      <input className="field" value={f[k]} onChange={set(k)} required={o.required} placeholder={o.placeholder} type={o.type ?? 'text'} inputMode={o.inputMode} maxLength={o.maxLength} />
      {o.hint && <span className="text-xs text-muted-foreground">{o.hint}</span>}
    </label>
  );

  return (
    <div className="min-h-screen bg-background px-4 py-10">
      <form onSubmit={submit} className="mx-auto max-w-2xl rounded-2xl border border-border bg-card p-6 shadow-sm">
        <h1 className="font-display text-3xl">Set up this shop</h1>
        <p className="mb-6 text-sm text-muted-foreground">One time only. These details print on every bill, so check them with your accountant.</p>
        <div className="grid gap-4 sm:grid-cols-2">
          {field('Business name', 'name', { required: true, maxLength: 80 })}
          {field('GSTIN', 'gstin', { maxLength: 15, placeholder: '29ABCDE1234F1Z5' })}
          {field('State code', 'stateCode', { required: true, inputMode: 'numeric', maxLength: 2, placeholder: '29', hint: 'First two digits of your GSTIN' })}
          {field('FSSAI licence number', 'fssaiNo', { maxLength: 14 })}
          {field('Address', 'address', { maxLength: 200 })}
          {field('Phone', 'phone', { inputMode: 'numeric', maxLength: 15 })}
          {field('This counter', 'device', { required: true, maxLength: 40 })}
          {field('Bill number prefix', 'prefix', { required: true, maxLength: 2, hint: '1-2 letters or digits, e.g. A1 gives A1/26-27/000001' })}
          {field('Owner name', 'owner', { required: true, maxLength: 60 })}
          <div />
          {field('Owner mobile number', 'mobile', { required: true, inputMode: 'numeric', maxLength: 10, placeholder: '98XXXXXXXX', hint: 'Used with the PIN to sign in' })}
          {field('Owner PIN', 'pin', { required: true, type: 'password', inputMode: 'numeric', maxLength: PIN_LENGTH, hint: `${PIN_LENGTH} digits` })}
          {field('Repeat PIN', 'pin2', { required: true, type: 'password', inputMode: 'numeric', maxLength: PIN_LENGTH })}
        </div>
        {error && <p className="mt-4 text-sm text-destructive" role="alert">{error}</p>}
        <button className="btn-primary mt-6 w-full" disabled={busy}>{busy ? 'Setting up…' : 'Set up shop'}</button>
      </form>
    </div>
  );
}
