// Payment machines add-on: registers its screens with the POS (window.__POS__.register).
import { CreditCard } from 'lucide-react';
import { useEffect } from 'react';
import { host } from './host.ts';
import { PaymentMachines } from './PaymentMachines.tsx';
import { InvoiceMachinePanel, MachinePayDialog, loadMachines, machineOptions, pendingFor } from './Checkout.tsx';

declare const __ADDON_CSS__: string; // this add-on's own style sheet, built with the POS's theme (scripts/build.mjs)
const style = document.createElement('style');
style.dataset.addon = 'edc';
style.textContent = __ADDON_CSS__;
document.head.appendChild(style);

/** Keeps the counter's list of machines fresh (on sign-in, after settings change, and every minute). Draws nothing. */
function Loader() {
  const { api } = host.useSession();
  useEffect(() => { loadMachines(api); const t = setInterval(() => loadMachines(api), 60_000); return () => clearInterval(t); }, [api]);
  return null;
}

/** Settings > Payment machines; the list at the counter reloads after a change. */
function Settings() {
  const { api } = host.useSession();
  useEffect(() => () => loadMachines(api), [api]);
  return <PaymentMachines />;
}

host.register({
  id: 'edc',
  settings: [{ key: 'payment-machines', label: 'Payment machines', hint: 'Paytm and Pine Labs card machines, wireless or wired', icon: CreditCard, component: Settings, roles: ['owner'] }],
  railFooter: Loader,
  checkout: {
    options: machineOptions,
    Dialog: MachinePayDialog,
    pending: pendingFor,
  },
  invoicePanels: [InvoiceMachinePanel],
});
