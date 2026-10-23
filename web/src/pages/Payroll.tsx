import { ArrowLeft, Plus } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Link, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { del, get, post, put } from '../api';
import { DataTable } from '../components/DataTable';
import { AccountPicker, StateSelect } from '../components/pickers';
import { Badge, Check, Confirm, ErrorBox, Field, Input, KeyVal, Modal, PageHeader, Select, Spinner, Stat, useAction } from '../components/ui';
import { date, money, qty, today } from '../lib/format';
import { useApi, useCan, useMeta } from '../lib/hooks';

const back = (to: string, label: string) => <Link to={to} className="mb-1 inline-flex items-center gap-1 text-xs no-underline"><ArrowLeft className="h-3 w-3" />{label}</Link>;

function Employees() {
  const { data } = useApi<any[]>('/payroll/employees');
  const nav = useNavigate();
  const can = useCan();
  return (
    <div>
      <PageHeader title="Employees" actions={can('payroll', 'create') && <Link to="/payroll/employees/new" className="btn btn-primary no-underline"><Plus className="h-4 w-4" />Add Employee</Link>} />
      <div className="p-5"><DataTable exportName="employees" rows={data ?? []} onRow={(r) => nav(`/payroll/employees/${r.id}`)} cols={[
        { key: 'emp_code', label: 'Emp ID' }, { key: 'name', label: 'Name', render: (r) => <span className="link font-medium">{r.name}</span> },
        { key: 'department', label: 'Department' }, { key: 'designation', label: 'Designation' }, { key: 'doj', label: 'Joined', render: (r) => date(r.doj) },
        { key: 'annual_ctc', label: 'Annual CTC', num: true, render: (r) => money(r.annual_ctc) }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status} /> },
      ]} /></div>
    </div>
  );
}

function EmployeeForm() {
  const { id } = useParams();
  const nav = useNavigate();
  const { meta } = useMeta();
  const { data: deps } = useApi<any[]>('/payroll/departments');
  const { data: des } = useApi<any[]>('/payroll/designations');
  const { run, busy } = useAction();
  const [f, setF] = useState<any>(id ? null : { doj: today(), work_state: meta.org.state_code, pf_enabled: true, esi_enabled: true, pt_enabled: true, tds_enabled: true, annual_ctc: 0, components: {} });
  useEffect(() => { if (id) get(`/payroll/employees/${id}`).then((e) => setF({ ...e, pf_enabled: !!e.pf_enabled, esi_enabled: !!e.esi_enabled, pt_enabled: !!e.pt_enabled, tds_enabled: !!e.tds_enabled })); }, [id]);
  if (!f) return <Spinner />;
  const set = (p: any) => setF({ ...f, ...p });
  return (
    <div className="pb-20">
      <PageHeader title={id ? `Edit ${f.name}` : 'Add Employee'} back={back('/payroll/employees', 'Employees')} />
      <div className="space-y-4 p-5">
        <div className="card grid gap-4 p-5 sm:grid-cols-2 lg:grid-cols-3">
          <Field label="Employee ID" required><Input value={f.emp_code ?? ''} onChange={(e) => set({ emp_code: e.target.value })} /></Field>
          <Field label="Full name" required><Input value={f.name ?? ''} onChange={(e) => set({ name: e.target.value })} /></Field>
          <Field label="Email"><Input value={f.email ?? ''} onChange={(e) => set({ email: e.target.value })} /></Field>
          <Field label="Gender"><Select value={f.gender ?? ''} placeholder="Select" onChange={(e) => set({ gender: e.target.value })} options={[{ value: 'male', label: 'Male' }, { value: 'female', label: 'Female' }, { value: 'other', label: 'Other' }]} /></Field>
          <Field label="Date of birth"><Input type="date" value={f.dob ?? ''} onChange={(e) => set({ dob: e.target.value })} /></Field>
          <Field label="Date of joining" required><Input type="date" value={f.doj ?? ''} onChange={(e) => set({ doj: e.target.value })} /></Field>
          <Field label="Department"><Select value={f.department_id ?? ''} placeholder="Select" onChange={(e) => set({ department_id: Number(e.target.value) || null })} options={(deps ?? []).map((d) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Designation"><Select value={f.designation_id ?? ''} placeholder="Select" onChange={(e) => set({ designation_id: Number(e.target.value) || null })} options={(des ?? []).map((d) => ({ value: d.id, label: d.name }))} /></Field>
          <Field label="Work location (state)"><StateSelect value={f.work_state} onChange={(v) => set({ work_state: v })} /></Field>
          <Field label="PAN"><Input value={f.pan ?? ''} onChange={(e) => set({ pan: e.target.value.toUpperCase() })} /></Field>
          <Field label="UAN"><Input value={f.uan ?? ''} onChange={(e) => set({ uan: e.target.value })} /></Field>
          <Field label="ESI IP number"><Input value={f.esi_number ?? ''} onChange={(e) => set({ esi_number: e.target.value })} /></Field>
          <Field label="Bank name"><Input value={f.bank_name ?? ''} onChange={(e) => set({ bank_name: e.target.value })} /></Field>
          <Field label="Account number"><Input value={f.bank_account ?? ''} onChange={(e) => set({ bank_account: e.target.value })} /></Field>
          <Field label="IFSC"><Input value={f.ifsc ?? ''} onChange={(e) => set({ ifsc: e.target.value.toUpperCase() })} /></Field>
          <Field label="Exit date"><Input type="date" value={f.exit_date ?? ''} onChange={(e) => set({ exit_date: e.target.value || null })} /></Field>
        </div>
        <div className="card space-y-3 p-5">
          <h3>Salary</h3>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Annual CTC (₹)" required hint={`Monthly ₹${qty(f.annual_ctc / 12)}`}><Input type="number" value={f.annual_ctc} onChange={(e) => set({ annual_ctc: Number(e.target.value) })} /></Field>
            <Field label="Conveyance allowance / month (override)"><Input type="number" value={f.components?.CONV ?? ''} onChange={(e) => set({ components: { ...f.components, CONV: e.target.value === '' ? undefined : Number(e.target.value) } })} /></Field>
          </div>
          <div className="flex flex-wrap gap-5">
            <Check label="EPF" checked={f.pf_enabled} onChange={(v) => set({ pf_enabled: v })} />
            <Check label="ESI (if eligible)" checked={f.esi_enabled} onChange={(v) => set({ esi_enabled: v })} />
            <Check label="Professional Tax" checked={f.pt_enabled} onChange={(v) => set({ pt_enabled: v })} />
            <Check label="Income tax (TDS)" checked={f.tds_enabled} onChange={(v) => set({ tds_enabled: v })} />
          </div>
        </div>
        <div className="card space-y-3 p-5">
          <h3>Opening year-to-date (optional)</h3>
          <p className="text-xs text-slate-600">Salary and TDS for this tax year that were <b>not</b> paid through this system: months paid before you started running payroll here, or pay from a previous employer this year. Do not include pay runs recorded here. Monthly TDS is then calculated on the full year.</p>
          <div className="grid gap-4 sm:grid-cols-3">
            <Field label="Tax year" hint="e.g. 2026-27"><Input value={f.ytd_fy ?? ''} placeholder="2026-27" onChange={(e) => set({ ytd_fy: e.target.value || null })} /></Field>
            <Field label="Gross salary paid (₹)"><Input type="number" value={f.ytd_gross ?? 0} onChange={(e) => set({ ytd_gross: Number(e.target.value) })} /></Field>
            <Field label="TDS deducted (₹)"><Input type="number" value={f.ytd_tds ?? 0} onChange={(e) => set({ ytd_tds: Number(e.target.value) })} /></Field>
          </div>
        </div>
      </div>
      <div className="no-print fixed bottom-0 left-0 right-0 flex gap-2 border-t bg-white px-5 py-3 lg:left-60"><button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => (id ? put(`/payroll/employees/${id}`, f) : post('/payroll/employees', f)), 'Employee saved'); if (r) nav(`/payroll/employees/${r.id}`); }}>Save</button><button className="btn" onClick={() => nav(-1)}>Cancel</button></div>
    </div>
  );
}

function EmployeeView() {
  const { id } = useParams();
  const { data: e, error, loading } = useApi<any>(`/payroll/employees/${id}`);
  const { meta } = useMeta();
  if (loading && !e) return <Spinner />;
  if (error || !e) return <div className="p-6"><ErrorBox error={error} /></div>;
  const s = e.salary;
  return (
    <div>
      <PageHeader title={`${e.name} (${e.emp_code})`} subtitle={[e.designation, e.department].filter(Boolean).join(' · ')} back={back('/payroll/employees', 'Employees')} actions={<Link className="btn no-underline" to={`/payroll/employees/${id}/edit`}>Edit</Link>} />
      <div className="grid gap-4 p-5 lg:grid-cols-2">
        <div className="card p-4"><h3 className="mb-2">Profile</h3><KeyVal items={[['Joined', date(e.doj)], ['Exit', date(e.exit_date)], ['Work location', meta.states[e.work_state]], ['PAN', e.pan], ['UAN', e.uan], ['ESI number', e.esi_number], ['Bank', [e.bank_name, e.bank_account, e.ifsc].filter(Boolean).join(' · ')], ['Statutory', [e.pf_enabled && 'EPF', e.esi_enabled && 'ESI', e.pt_enabled && 'PT', e.tds_enabled && 'TDS'].filter(Boolean).join(', ')]]} /></div>
        <div className="card p-4"><h3 className="mb-2">Monthly salary structure</h3>
          {s?.error ? <ErrorBox error={s.error} /> : s && (
            <table className="table"><tbody>
              {s.earnings.map((x: any) => <tr key={x.code}><td>{x.name}</td><td className="num">{money(x.amount)}</td></tr>)}
              <tr><td className="font-semibold">Gross salary</td><td className="num font-semibold">{money(s.gross)}</td></tr>
              <tr><td className="text-slate-500">Employer contributions (in CTC)</td><td className="num text-slate-500">{money(s.monthlyCtc - s.gross)}</td></tr>
              <tr><td className="font-semibold">Monthly CTC</td><td className="num font-semibold">{money(s.monthlyCtc)}</td></tr>
            </tbody></table>
          )}
          {s && !s.error && <div className="mt-2 text-xs text-slate-500">ESI {s.esiApplies ? 'applies' : 'does not apply'} · EPF wage ceiling {money(s.ceiling)}</div>}
        </div>
        <div className="card p-4 lg:col-span-2"><h3 className="mb-2">Payslips</h3>
          <DataTable rows={e.payslips} cols={[{ key: 'period', label: 'Period', render: (r) => <Link to={`/payroll/payslips/${r.id}`}>{r.period}</Link> }, { key: 'lop_days', label: 'LOP', num: true }, { key: 'gross', label: 'Gross', num: true, render: (r) => money(r.gross) }, { key: 'net', label: 'Net pay', num: true, render: (r) => money(r.net) }, { key: 'status', label: 'Run status', render: (r) => <Badge status={r.status} /> }]} />
        </div>
      </div>
    </div>
  );
}

function PayRuns() {
  const { data, reload } = useApi<any[]>('/payroll/pay-runs');
  const nav = useNavigate();
  const [create, setCreate] = useState<any>(null);
  const { run, busy } = useAction();
  const can = useCan();
  const prev = (() => { const d = new Date(); d.setDate(1); d.setMonth(d.getMonth() - 1); return d.toISOString().slice(0, 7); })();
  return (
    <div>
      <PageHeader title="Pay Runs" subtitle="Monthly payroll with EPF, ESI, professional tax and TDS" actions={can('payroll', 'create') && <button className="btn btn-primary" onClick={() => setCreate({ period: prev })}><Plus className="h-4 w-4" />Create Pay Run</button>} />
      <div className="p-5"><DataTable rows={data ?? []} onRow={(r) => nav(`/payroll/pay-runs/${r.id}`)} cols={[
        { key: 'period', label: 'Period', render: (r) => <span className="link">{new Date(`${r.period}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</span> },
        { key: 'pay_date', label: 'Pay date', render: (r) => date(r.pay_date) }, { key: 'employees', label: 'Employees', num: true, render: (r) => r.totals.employees },
        { key: 'gross', label: 'Gross', num: true, render: (r) => money(r.totals.gross) }, { key: 'net', label: 'Net pay', num: true, render: (r) => money(r.totals.net) },
        { key: 'employer_cost', label: 'Employer cost', num: true, render: (r) => money(r.totals.employer_cost) }, { key: 'status', label: 'Status', render: (r) => <Badge status={r.status === 'approved' ? 'approved' : r.status} /> },
      ]} /></div>
      {create && (
        <Modal title="Create pay run" onClose={() => setCreate(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { const r = await run(() => post('/payroll/pay-runs', create), 'Pay run created'); if (r) { setCreate(null); reload(); nav(`/payroll/pay-runs/${r.id}`); } }}>Create</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Pay period"><Input type="month" value={create.period} onChange={(e) => setCreate({ ...create, period: e.target.value })} /></Field>
            <Field label="Pay date (default: month end)"><Input type="date" value={create.pay_date ?? ''} onChange={(e) => setCreate({ ...create, pay_date: e.target.value || undefined })} /></Field>
          </div>
        </Modal>
      )}
    </div>
  );
}

function PayRunView() {
  const { id } = useParams();
  const { data: r, error, loading, setData } = useApi<any>(`/payroll/pay-runs/${id}`);
  const [pay, setPay] = useState<any>(null);
  const [del_, setDel] = useState(false);
  const { run, busy } = useAction();
  const nav = useNavigate();
  if (loading && !r) return <Spinner />;
  if (error || !r) return <div className="p-6"><ErrorBox error={error} /></div>;
  const t = r.totals;
  const draft = r.status === 'draft';
  return (
    <div>
      <PageHeader title={`Pay run · ${new Date(`${r.period}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}`} subtitle={<span className="flex items-center gap-2">{r.number}<Badge status={r.status} /></span>} back={back('/payroll/pay-runs', 'Pay Runs')}
        actions={<>
          {draft && <button className="btn" disabled={busy} onClick={async () => { const x = await run(() => post(`/payroll/pay-runs/${id}/recalculate`), 'Recalculated'); if (x) setData(x); }}>Recalculate</button>}
          {draft && <button className="btn btn-primary" disabled={busy} onClick={async () => { const x = await run(() => post(`/payroll/pay-runs/${id}/approve`), 'Pay run approved and posted'); if (x) setData(x); }}>Approve</button>}
          {r.status === 'approved' && <button className="btn btn-primary" onClick={() => setPay({ date: r.pay_date })}>Record Payment</button>}
          {draft && <button className="btn" onClick={() => setDel(true)}>Delete</button>}
        </>} />
      <div className="space-y-4 p-5">
        <div className="grid gap-3 sm:grid-cols-4">
          <Stat label="Gross pay" value={money(t.gross)} sub={`${t.employees} employees`} />
          <Stat label="Net pay" value={money(t.net)} sub={t.withheld ? `${money(t.withheld)} withheld` : undefined} />
          <Stat label="Statutory dues" value={money(t.pf_ee + t.pf_er + t.pf_other + t.esi_ee + t.esi_er + t.pt + t.tds)} sub={`EPF ${money(t.pf_ee + t.pf_er + t.pf_other)} · ESI ${money(t.esi_ee + t.esi_er)}`} />
          <Stat label="Employer cost" value={money(t.gross + t.employer_cost)} sub={`PT ${money(t.pt)} · TDS ${money(t.tds)}`} />
        </div>
        <div className="card overflow-x-auto p-4">
          <table className="table min-w-[1000px]"><thead><tr><th>Employee</th><th className="num">Paid days</th><th className="num w-24">LOP days</th><th className="num">Gross</th><th className="num">EPF</th><th className="num">ESI</th><th className="num">PT</th><th className="num">TDS</th><th className="num">Net pay</th><th>Withhold</th><th /></tr></thead>
            <tbody>{r.payslips.map((p: any) => {
              const d = (c: string) => p.deductions.find((x: any) => x.code === c)?.amount ?? 0;
              return (
                <tr key={p.id}>
                  <td>{p.employee_name}<div className="text-[11px] text-slate-500">{p.emp_code}</div></td>
                  <td className="num">{qty(p.paid_days)}/{p.days}</td>
                  <td>{draft ? <input className="input w-20 text-right" type="number" step="0.5" defaultValue={p.lop_days} aria-label="LOP days" onBlur={async (e) => { if (Number(e.target.value) !== p.lop_days) { const x = await run(() => put(`/payroll/payslips/${p.id}`, { lop_days: Number(e.target.value) })); if (x) setData(await get(`/payroll/pay-runs/${id}`)); } }} /> : <span className="num">{qty(p.lop_days)}</span>}</td>
                  <td className="num">{money(p.gross)}</td><td className="num">{money(d('EPF_EE'))}</td><td className="num">{money(d('ESI_EE'))}</td><td className="num">{money(d('PT'))}</td><td className="num">{money(d('TDS'))}</td>
                  <td className="num font-medium">{money(p.net)}</td>
                  <td>{draft ? <Check label="" checked={!!p.withheld} onChange={async (v) => { const x = await run(() => put(`/payroll/payslips/${p.id}`, { withheld: v })); if (x) setData(await get(`/payroll/pay-runs/${id}`)); }} /> : p.withheld ? (r.status === 'paid' ? <button className="text-xs text-brand-600" onClick={async () => { if (await run(() => post(`/payroll/payslips/${p.id}/release`, {}), 'Released')) setData(await get(`/payroll/pay-runs/${id}`)); }}>Release</button> : 'Yes') : ''}</td>
                  <td><Link to={`/payroll/payslips/${p.id}`} className="text-xs">Payslip</Link></td>
                </tr>
              );
            })}</tbody></table>
        </div>
        {r.journal.length > 0 && (
          <div className="card p-4"><h3 className="mb-2">Accounting entries</h3><table className="table"><tbody>{r.journal.map((j: any, i: number) => <tr key={i}><td>{date(j.date)}</td><td>{j.memo}</td><td>{j.account_name}</td><td className="num">{j.debit ? money(j.debit) : ''}</td><td className="num">{j.credit ? money(j.credit) : ''}</td></tr>)}</tbody></table></div>
        )}
      </div>
      {pay && (
        <Modal title="Record salary payment" onClose={() => setPay(null)} footer={<button className="btn btn-primary" disabled={busy} onClick={async () => { const x = await run(() => post(`/payroll/pay-runs/${id}/pay`, pay), 'Payment recorded'); if (x) { setData(x); setPay(null); } }}>Record</button>}>
          <div className="grid gap-3 sm:grid-cols-2">
            <Field label="Paid from"><AccountPicker value={pay.account_id} onChange={(v) => setPay({ ...pay, account_id: v })} types={['bank', 'cash']} /></Field>
            <Field label="Payment date"><Input type="date" value={pay.date} onChange={(e) => setPay({ ...pay, date: e.target.value })} /></Field>
          </div>
          <p className="mt-2 text-xs text-slate-500">Net pay of {money(t.net_payable)} (excluding withheld salaries) will be paid.</p>
        </Modal>
      )}
      {del_ && <Confirm danger title="Delete pay run" message="Delete this draft pay run?" confirmLabel="Delete" onClose={() => setDel(false)} onConfirm={async () => { setDel(false); if (await run(() => del(`/payroll/pay-runs/${id}`), 'Deleted')) nav('/payroll/pay-runs'); }} />}
    </div>
  );
}

function Payslip() {
  const { id } = useParams();
  const { data: p } = useApi<any>(`/payroll/payslips/${id}`);
  if (!p) return <Spinner />;
  return (
    <div>
      <PageHeader title={`Payslip · ${p.employee_name} · ${p.period}`} back={back(`/payroll/pay-runs/${p.pay_run_id}`, 'Pay run')} actions={<button className="btn" onClick={() => window.print()}>Print / PDF</button>} />
      <div className="p-5">
        <div className="card print-area mx-auto max-w-3xl p-8 text-[12.5px]">
          <div className="flex justify-between border-b pb-3"><div><div className="text-lg font-bold">{p.org.legal_name || p.org.name}</div><div className="text-slate-600">{p.org.address}, {p.org.city}</div></div>
            <div className="text-right"><div className="font-semibold">Payslip for {new Date(`${p.period}-01T00:00:00`).toLocaleDateString('en-GB', { month: 'long', year: 'numeric' })}</div><div className="text-slate-500">Pay date {date(p.pay_date)}</div></div></div>
          <div className="grid grid-cols-2 gap-2 py-3"><KeyVal items={[['Employee', p.employee_name], ['Employee ID', p.emp_code], ['Designation', p.designation], ['Department', p.department]]} /><KeyVal items={[['PAN', p.pan], ['UAN', p.uan], ['Paid days', `${p.paid_days} of ${p.days}`], ['LOP days', p.lop_days], ['Bank', `${p.bank_name ?? ''} ${p.bank_account ? `••${String(p.bank_account).slice(-4)}` : ''}`]]} /></div>
          <div className="grid grid-cols-2 gap-4">
            <table className="table"><thead><tr><th>Earnings</th><th className="num">Amount</th></tr></thead><tbody>{p.earnings.map((e: any) => <tr key={e.code}><td>{e.name}</td><td className="num">{money(e.amount)}</td></tr>)}<tr><td className="font-semibold">Gross earnings</td><td className="num font-semibold">{money(p.gross)}</td></tr></tbody></table>
            <table className="table"><thead><tr><th>Deductions</th><th className="num">Amount</th></tr></thead><tbody>{p.deductions.map((e: any) => <tr key={e.code}><td>{e.name}</td><td className="num">{money(e.amount)}</td></tr>)}<tr><td className="font-semibold">Total deductions</td><td className="num font-semibold">{money(p.total_deductions)}</td></tr></tbody></table>
          </div>
          <div className="mt-4 rounded bg-slate-50 p-3 text-base font-semibold">Net pay: {money(p.net)}{p.withheld ? ' (withheld)' : ''}</div>
          <div className="mt-3 text-[11px] text-slate-500">Employer contributions: {p.employer.map((e: any) => `${e.name} ${money(e.amount)}`).join(' · ')}</div>
          <div className="mt-6 text-center text-[10px] text-slate-500">This is a system-generated payslip.</div>
        </div>
      </div>
    </div>
  );
}

export default function Payroll() {
  return (
    <Routes>
      <Route path="employees" element={<Employees />} />
      <Route path="employees/new" element={<EmployeeForm />} />
      <Route path="employees/:id" element={<EmployeeView />} />
      <Route path="employees/:id/edit" element={<EmployeeForm />} />
      <Route path="pay-runs" element={<PayRuns />} />
      <Route path="pay-runs/:id" element={<PayRunView />} />
      <Route path="payslips/:id" element={<Payslip />} />
      <Route path="*" element={<Employees />} />
    </Routes>
  );
}
