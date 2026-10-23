import { useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { get, post, setToken } from '../api';
import { Check, ErrorBox, Field, Input, Select, Spinner } from '../components/ui';
import { AuthShell } from './Login';

const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];

/** First-run setup: organisation profile and the first administrator. Shown only while no user exists. */
export default function Setup({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const [states, setStates] = useState<Record<string, string> | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [org, setOrg] = useState<any>({ name: '', legal_name: '', gstin: '', state_code: '', address: '', city: '', pincode: '', email: '', phone: '', fiscal_year_start_month: 4, inventory_start_date: '', valuation_method: 'fifo', einvoice_enabled: false });
  const [admin, setAdmin] = useState({ name: '', email: '', password: '', confirm: '' });
  const [code, setCode] = useState('');
  const setO = (p: any) => setOrg((o: any) => ({ ...o, ...p }));
  useEffect(() => {
    get('/setup').then((r) => (r.needs_setup ? setStates(r.states) : nav('/login', { replace: true }))).catch((e) => setError(e.message));
  }, [nav]);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (admin.password !== admin.confirm) { setError('Passwords do not match'); return; }
    setBusy(true);
    setError(null);
    try {
      const organisation = { ...org, gstin: org.gstin.trim().toUpperCase(), fiscal_year_start_month: Number(org.fiscal_year_start_month) };
      const r = await post('/setup', { setup_code: code, organisation, admin: { name: admin.name, email: admin.email, password: admin.password } });
      setToken(r.token);
      onDone();
      nav('/', { replace: true });
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };

  if (!states) return <AuthShell>{error ? <ErrorBox error={error} /> : <Spinner />}</AuthShell>;
  const stateOptions = Object.entries(states).filter(([k]) => !['96', '97'].includes(k)).sort((a, b) => a[1].localeCompare(b[1])).map(([value, label]) => ({ value, label: `${label} (${value})` }));
  return (
    <AuthShell>
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <h1 className="text-xl">Set up your organisation</h1>
          <p className="mt-1 text-slate-500">This is done once. You can change these details later in Settings.</p>
        </div>
        <ErrorBox error={error} />
        <Field label="Setup code" required hint="Printed in the server log when the server starts (or set with the SETUP_TOKEN environment variable). It proves you run this installation."><Input value={code} onChange={(e) => setCode(e.target.value.toUpperCase())} required autoComplete="off" placeholder="XXXX-XXXX-XXXX" /></Field>
        <fieldset className="space-y-3">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Organisation</legend>
          <Field label="Organisation name" required><Input value={org.name} onChange={(e) => setO({ name: e.target.value })} required /></Field>
          <Field label="Legal name" hint="As registered; printed on tax invoices. Defaults to the organisation name."><Input value={org.legal_name} onChange={(e) => setO({ legal_name: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="State" required><Select value={org.state_code} onChange={(e) => setO({ state_code: e.target.value })} options={stateOptions} placeholder="Select state" required /></Field>
            <Field label="GSTIN" hint="Leave blank if not registered"><Input value={org.gstin} maxLength={15} onChange={(e) => setO({ gstin: e.target.value.toUpperCase() })} /></Field>
          </div>
          <Field label="Address"><Input value={org.address} onChange={(e) => setO({ address: e.target.value })} /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="City"><Input value={org.city} onChange={(e) => setO({ city: e.target.value })} /></Field>
            <Field label="PIN code"><Input value={org.pincode} inputMode="numeric" maxLength={6} onChange={(e) => setO({ pincode: e.target.value.replace(/\D/g, '') })} /></Field>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Financial year starts in"><Select value={org.fiscal_year_start_month} onChange={(e) => setO({ fiscal_year_start_month: e.target.value })} options={MONTHS.map((m, i) => ({ value: i + 1, label: m }))} /></Field>
            <Field label="Opening balance date" hint="Opening stock and balances are recorded on this date. Defaults to the start of the current financial year."><Input type="date" value={org.inventory_start_date} onChange={(e) => setO({ inventory_start_date: e.target.value })} /></Field>
          </div>
          <Field label="Inventory valuation" hint="Cannot be changed after stock transactions are recorded."><Select value={org.valuation_method} onChange={(e) => setO({ valuation_method: e.target.value })} options={[{ value: 'fifo', label: 'FIFO (first in, first out)' }, { value: 'wac', label: 'Weighted average cost' }]} /></Field>
          <Check label="My business must issue e-invoices (IRN)" checked={org.einvoice_enabled} onChange={(v) => setO({ einvoice_enabled: v })} />
        </fieldset>
        <fieldset className="space-y-3">
          <legend className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">Administrator account</legend>
          <Field label="Your name" required><Input value={admin.name} onChange={(e) => setAdmin({ ...admin, name: e.target.value })} required autoComplete="name" /></Field>
          <Field label="Email" required><Input type="email" value={admin.email} onChange={(e) => setAdmin({ ...admin, email: e.target.value })} required autoComplete="username" /></Field>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Password" hint="At least 8 characters" required><Input type="password" value={admin.password} onChange={(e) => setAdmin({ ...admin, password: e.target.value })} required minLength={8} autoComplete="new-password" /></Field>
            <Field label="Confirm password" required><Input type="password" value={admin.confirm} onChange={(e) => setAdmin({ ...admin, confirm: e.target.value })} required minLength={8} autoComplete="new-password" /></Field>
          </div>
        </fieldset>
        <button className="btn btn-primary w-full py-2" disabled={busy}>{busy ? 'Setting up…' : 'Create organisation'}</button>
      </form>
    </AuthShell>
  );
}
