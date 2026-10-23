import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { post, setToken } from '../api';
import { ErrorBox, Field, Input } from '../components/ui';

export function AuthShell({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex min-h-full items-center justify-center bg-gradient-to-br from-slate-900 via-slate-800 to-brand-700 p-4">
      <div className="grid w-full max-w-4xl overflow-hidden rounded-2xl bg-white shadow-2xl md:grid-cols-2">
        <div className="hidden flex-col justify-between bg-side p-8 text-slate-200 md:flex">
          <div className="flex items-center gap-2"><img src="/favicon.svg" alt="" className="h-8 w-8" /><span className="text-lg font-semibold text-white">Saral ERP</span></div>
          <div>
            <div className="text-2xl font-semibold leading-snug text-white">Finance, GST compliance, inventory, manufacturing and payroll in one place.</div>
            <ul className="mt-4 space-y-1.5 text-sm text-slate-300">
              <li>• Double-entry books with GST (CGST, SGST, IGST)</li>
              <li>• FIFO inventory with batches, serials and warehouses</li>
              <li>• BOMs, manufacturing orders, job cards and quality checks</li>
              <li>• GSTR-1, GSTR-3B, e-invoice and e-way bill files</li>
              <li>• Indian payroll with EPF, ESI, PT and TDS</li>
            </ul>
          </div>
          <div className="text-xs text-slate-300">Business management for Indian companies</div>
        </div>
        <div className="p-8">{children}</div>
      </div>
    </div>
  );
}

export default function Login({ onLogin }: { onLogin: () => void }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const nav = useNavigate();
  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const r = await post('/auth/login', { email, password });
      setToken(r.token);
      onLogin();
      nav('/');
    } catch (err: any) {
      setError(err.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell>
      <form className="space-y-4" onSubmit={submit}>
        <div>
          <h1 className="text-xl">Sign in</h1>
          <p className="mt-1 text-slate-500">Use the email and password your administrator gave you.</p>
        </div>
        <ErrorBox error={error} />
        <Field label="Email"><Input type="email" autoComplete="username" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus /></Field>
        <Field label="Password"><Input type="password" autoComplete="current-password" value={password} onChange={(e) => setPassword(e.target.value)} required /></Field>
        <button className="btn btn-primary w-full py-2" disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
        <p className="text-xs text-slate-500">Forgotten your password? Ask an administrator to reset it in Settings → Users.</p>
      </form>
    </AuthShell>
  );
}
