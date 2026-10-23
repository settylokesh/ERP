import React, { lazy, Suspense, useEffect, useState } from 'react';
import ReactDOM from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { getToken, setUnauthorizedHandler, setToken } from './api';
import { Layout } from './components/Layout';
import { Spinner, ToastProvider } from './components/ui';
import { MetaProvider } from './lib/hooks';
import Login from './pages/Login';
import './index.css';

const Dashboard = lazy(() => import('./pages/Dashboard'));
const DocList = lazy(() => import('./pages/docs/DocList'));
const DocForm = lazy(() => import('./pages/docs/DocForm'));
const DocView = lazy(() => import('./pages/docs/DocView'));
const Items = lazy(() => import('./pages/Items'));
const Contacts = lazy(() => import('./pages/Contacts'));
const Payments = lazy(() => import('./pages/Payments'));
const Accountant = lazy(() => import('./pages/Accountant'));
const Banking = lazy(() => import('./pages/Banking'));
const Assets = lazy(() => import('./pages/Assets'));
const Manufacturing = lazy(() => import('./pages/Manufacturing'));
const Payroll = lazy(() => import('./pages/Payroll'));
const Compliance = lazy(() => import('./pages/Compliance'));
const Reports = lazy(() => import('./pages/Reports'));
const Settings = lazy(() => import('./pages/Settings'));
const Custom = lazy(() => import('./pages/Custom'));
const Recurring = lazy(() => import('./pages/Recurring'));

function Authed() {
  const nav = useNavigate();
  useEffect(() => setUnauthorizedHandler(() => { setToken(''); nav('/login'); }), [nav]);
  return (
    <MetaProvider fallback={<Spinner label="Loading your organisation…" />}>
      <Layout>
        <Suspense fallback={<Spinner />}>
          <Routes>
            <Route path="/" element={<Dashboard />} />
            <Route path="/docs/:type" element={<DocList />} />
            <Route path="/docs/:type/new" element={<DocForm />} />
            <Route path="/docs/:type/:id" element={<DocView />} />
            <Route path="/docs/:type/:id/edit" element={<DocForm />} />
            <Route path="/items/*" element={<Items />} />
            <Route path="/price-lists" element={<Items priceLists />} />
            <Route path="/customers/*" element={<Contacts kind="customer" />} />
            <Route path="/vendors/*" element={<Contacts kind="vendor" />} />
            <Route path="/payments/:kind/*" element={<Payments />} />
            <Route path="/recurring" element={<Recurring />} />
            <Route path="/accountant/*" element={<Accountant />} />
            <Route path="/banking/*" element={<Banking />} />
            <Route path="/assets/*" element={<Assets />} />
            <Route path="/manufacturing/*" element={<Manufacturing />} />
            <Route path="/payroll/*" element={<Payroll />} />
            <Route path="/compliance/*" element={<Compliance />} />
            <Route path="/reports/*" element={<Reports />} />
            <Route path="/settings/*" element={<Settings />} />
            <Route path="/custom/:key/*" element={<Custom />} />
            <Route path="*" element={<Navigate to="/" />} />
          </Routes>
        </Suspense>
      </Layout>
    </MetaProvider>
  );
}

function App() {
  const [authed, setAuthed] = useState(!!getToken());
  return (
    <BrowserRouter>
      <ToastProvider>
        <Routes>
          <Route path="/login" element={<Login onLogin={() => setAuthed(true)} />} />
          <Route path="/*" element={authed && getToken() ? <Authed /> : <Navigate to="/login" />} />
        </Routes>
      </ToastProvider>
    </BrowserRouter>
  );
}

ReactDOM.createRoot(document.getElementById('root')!).render(<React.StrictMode><App /></React.StrictMode>);
