import { useEffect, useState } from 'react';
import { CheckCircle2, CircleAlert, KeyRound } from 'lucide-react';
import { BASE, host } from './host.ts';

const { useSession, newKey, messageOf } = host;

interface Keys { google: { set: boolean; hint: string | null } }
interface TestResult { ok: boolean; message: string }

/** Settings > API keys (owner only). The keys stay in the POS backend: this screen can set or remove them, never read them. */
export function ApiKeys() {
  const { api, notify } = useSession();
  const [keys, setKeys] = useState<Keys | null>(null);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [test, setTest] = useState<{ search: TestResult; map: TestResult } | null>(null);
  const [confirmRemove, setConfirmRemove] = useState(false);
  useEffect(() => { api.request<Keys>('GET', `${BASE}/api-keys`).then(setKeys).catch((e) => setError(messageOf(e))); }, [api]);

  const runTest = async () => {
    setBusy(true); setTest(null); setError(null);
    try { setTest(await api.request<{ search: TestResult; map: TestResult }>('POST', `${BASE}/api-keys/test`, {}, newKey())); } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };
  const save = async (google: string | null) => {
    setBusy(true); setError(null); setTest(null);
    try {
      const k = await api.request<Keys>('PUT', `${BASE}/api-keys`, { google }, newKey());
      setKeys(k); setTyped(''); setConfirmRemove(false);
      notify('success', google ? 'Google Maps key saved. The map and place search now use Google.' : 'Google Maps key removed. The free map is used again.');
      if (google) void runTest();
    } catch (e) { setError(messageOf(e)); } finally { setBusy(false); }
  };

  return (
    <>
      <h2 className="mb-1 font-display text-2xl">API keys</h2>
      <p className="mb-4 max-w-2xl text-sm text-muted-foreground">Keys for outside services. They are kept in this POS only, never shown again after saving, and never sent to the screens or the order hub.</p>
      <section className="max-w-2xl rounded-2xl border border-border bg-card p-4" aria-label="Google Maps">
        <h3 className="mb-1 flex items-center gap-2 font-semibold"><KeyRound className="h-4 w-4 text-primary" />Google Maps
          <span className={`ml-auto rounded-full px-2 py-0.5 text-xs font-normal ${keys?.google.set ? 'bg-veg/15 text-veg' : 'bg-muted text-muted-foreground'}`}>{!keys ? '…' : keys.google.set ? `Saved (ends ${keys.google.hint})` : 'Not set: free map in use'}</span>
        </h3>
        <p className="mb-3 text-sm text-muted-foreground">Used for the map and the place search in Settings &gt; Serviceability.</p>
        <label className="block text-sm font-medium">{keys?.google.set ? 'Replace the key' : 'API key'}
          <input className="field mt-1 w-full font-mono text-sm" type="password" autoComplete="off" spellCheck={false} placeholder="AIza…" value={typed} onChange={(e) => setTyped(e.target.value)} aria-label="Google Maps API key" />
        </label>
        <div className="mt-3 flex flex-wrap gap-2">
          <button className="btn-primary" disabled={busy || !typed.trim()} onClick={() => void save(typed.trim())}>{busy ? 'Working…' : 'Save key'}</button>
          {keys?.google.set && <button className="btn-ghost" disabled={busy} onClick={() => void runTest()}>Test key</button>}
          {keys?.google.set && (confirmRemove
            ? <><button className="btn-primary bg-destructive" disabled={busy} onClick={() => void save(null)}>Yes, remove</button><button className="btn-ghost" onClick={() => setConfirmRemove(false)}>Back</button></>
            : <button className="btn-ghost" disabled={busy} onClick={() => setConfirmRemove(true)}>Remove key</button>)}
        </div>
        {error && <p role="alert" className="mt-3 text-sm text-destructive">{error}</p>}
        {test && (
          <ul className="mt-3 space-y-2 text-sm" aria-label="Test result">
            {([['Place search (Places API (New))', test.search], ['Map pictures (Map Tiles API)', test.map]] as const).map(([name, t]) => (
              <li key={name} className={`flex gap-2 rounded-lg p-2 ${t.ok ? 'bg-veg/10' : 'bg-destructive/10'}`}>
                {t.ok ? <CheckCircle2 className="h-4 w-4 shrink-0 text-veg" /> : <CircleAlert className="h-4 w-4 shrink-0 text-destructive" />}
                <span><b>{name}:</b> {t.message}</span>
              </li>
            ))}
          </ul>
        )}
        <details className="mt-4 text-sm">
          <summary className="cursor-pointer font-medium">How to get the key</summary>
          <ol className="mt-2 list-decimal space-y-1 pl-5 text-muted-foreground">
            <li>console.cloud.google.com: create a project and add a billing account (pay-as-you-go; the free monthly allowance applies).</li>
            <li>APIs &amp; Services &gt; Library: enable <b>Places API (New)</b> and <b>Map Tiles API</b>.</li>
            <li>APIs &amp; Services &gt; Credentials: create an API key. Under API restrictions, allow only those two APIs.</li>
            <li>Optional: a budget alert under Billing, and a daily limit under each API's Quotas.</li>
          </ol>
        </details>
      </section>
    </>
  );
}
