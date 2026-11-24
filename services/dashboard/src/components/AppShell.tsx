'use client';

import React, { useState } from 'react';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import {
  Activity,
  AlertTriangle,
  BarChart3,
  Database,
  LogOut,
  Mic,
  PhoneCall,
  PlayCircle,
  Radio,
  Settings,
  ShieldCheck,
} from 'lucide-react';
import { useAuth } from './AuthContext';

const NAV_ITEMS = [
  { href: '/', label: 'Overview & Usage', icon: BarChart3 },
  { href: '/realtime-voice', label: 'Real-Time Voice (Barge-In)', icon: Radio },
  { href: '/live-agent', label: 'Live AI Voice Call (Classic)', icon: Mic },
  { href: '/catalog', label: 'Product Catalog & RAG CSV', icon: Database },
  { href: '/simulator', label: 'Webhook & IVR Test Bench', icon: PlayCircle },
  { href: '/calls', label: 'Call History', icon: PhoneCall },
  { href: '/settings', label: 'Voice Settings', icon: Settings },
  { href: '/errors', label: 'Error Monitor', icon: AlertTriangle },
];

export function AppShell({ children }: { children: React.ReactNode }) {
  const { user, tenants, activeTenantId, setActiveTenantId, login, logout, loading } = useAuth();
  const pathname = usePathname();
  const [email, setEmail] = useState('admin@flowmind.ai');
  const [password, setPassword] = useState('FlowMind@2026');
  const [authError, setAuthError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);

  if (loading) {
    return (
      <div className="min-h-screen flex items-center justify-center bg-slate-950 text-slate-200">
        <div className="flex items-center gap-3 text-sm">
          <Activity className="w-5 h-5 animate-pulse text-blue-400" />
          Loading FlowMind AI Console...
        </div>
      </div>
    );
  }

  if (!user) {
    const handleSubmit = async (e: React.FormEvent) => {
      e.preventDefault();
      setAuthError(null);
      setSubmitting(true);
      try {
        await login(email, password);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Login failed');
      } finally {
        setSubmitting(false);
      }
    };

    const quickLogin = async (u: string, p: string) => {
      setEmail(u);
      setPassword(p);
      setAuthError(null);
      setSubmitting(true);
      try {
        await login(u, p);
      } catch (err) {
        setAuthError(err instanceof Error ? err.message : 'Login failed');
      } finally {
        setSubmitting(false);
      }
    };

    return (
      <div className="min-h-screen bg-slate-950 flex items-center justify-center p-6">
        <div className="w-full max-w-md bg-white rounded-2xl shadow-2xl border border-slate-200 overflow-hidden">
          <div className="bg-gradient-to-r from-slate-900 to-blue-950 px-6 py-6 text-white">
            <div className="flex items-center gap-2.5">
              <div className="w-9 h-9 rounded-lg bg-blue-500/20 border border-blue-400/40 flex items-center justify-center">
                <PhoneCall className="w-5 h-5 text-blue-300" />
              </div>
              <div>
                <h1 className="text-lg font-bold tracking-tight">FlowMind AI</h1>
                <p className="text-xs text-blue-200">Voice Order Confirmation System — SRS v1.0</p>
              </div>
            </div>
          </div>

          <form onSubmit={handleSubmit} className="p-6 space-y-4">
            {authError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {authError}
              </div>
            )}
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Password</label>
              <input
                type="password"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg focus:outline-none focus:ring-2 focus:ring-blue-500"
              />
            </div>
            <button
              type="submit"
              disabled={submitting}
              className="w-full py-2.5 bg-blue-600 hover:bg-blue-700 disabled:opacity-50 text-white text-sm font-semibold rounded-lg transition"
            >
              {submitting ? 'Signing in...' : 'Sign In to Dashboard'}
            </button>

            <div className="pt-4 border-t border-slate-100">
              <p className="text-[11px] font-semibold uppercase tracking-wider text-slate-400 mb-2">
                Demo Accounts (Tenant Isolation Testing)
              </p>
              <div className="grid grid-cols-1 gap-1.5">
                <button
                  type="button"
                  onClick={() => quickLogin('admin@flowmind.ai', 'FlowMind@2026')}
                  className="text-left px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs"
                >
                  <span className="font-semibold text-slate-800">Super Admin</span>
                  <span className="text-slate-500 ml-2">admin@flowmind.ai (All Tenants)</span>
                </button>
                <button
                  type="button"
                  onClick={() => quickLogin('owner@deshfashion.bd', 'DeshFashion@2026')}
                  className="text-left px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs"
                >
                  <span className="font-semibold text-slate-800">Desh Fashion BD</span>
                  <span className="text-slate-500 ml-2">owner@deshfashion.bd</span>
                </button>
                <button
                  type="button"
                  onClick={() => quickLogin('owner@dhakaorganic.bd', 'DhakaOrganic@2026')}
                  className="text-left px-3 py-2 rounded-lg border border-slate-200 hover:bg-slate-50 text-xs"
                >
                  <span className="font-semibold text-slate-800">Dhaka Organic Store</span>
                  <span className="text-slate-500 ml-2">owner@dhakaorganic.bd</span>
                </button>
              </div>
            </div>
          </form>
        </div>
      </div>
    );
  }

  return (
    <div className="min-h-screen flex bg-slate-50">
      {/* Sidebar */}
      <aside className="w-64 bg-slate-950 text-slate-200 flex flex-col shrink-0">
        <div className="px-5 py-5 border-b border-slate-800 flex items-center gap-2.5">
          <div className="w-8 h-8 rounded-lg bg-blue-600 flex items-center justify-center">
            <PhoneCall className="w-4 h-4 text-white" />
          </div>
          <div>
            <div className="text-sm font-bold text-white leading-tight">FlowMind AI</div>
            <div className="text-[11px] text-slate-400">Voice Confirmation v1.0</div>
          </div>
        </div>

        <nav className="flex-1 p-3 space-y-1">
          {NAV_ITEMS.map((item) => {
            const Icon = item.icon;
            const active =
              item.href === '/'
                ? pathname === '/' || pathname.startsWith('/orders')
                : pathname.startsWith(item.href);
            return (
              <Link
                key={item.href}
                href={item.href}
                className={`flex items-center gap-3 px-3 py-2.5 rounded-lg text-sm font-medium transition ${
                  active
                    ? 'bg-blue-600 text-white'
                    : 'text-slate-300 hover:bg-slate-800/80 hover:text-white'
                }`}
              >
                <Icon className="w-4 h-4 shrink-0" />
                {item.label}
              </Link>
            );
          })}
        </nav>

        <div className="p-4 border-t border-slate-800 space-y-3">
          <div className="flex items-center gap-2 text-xs text-emerald-400 bg-emerald-950/60 border border-emerald-800/50 rounded-lg px-2.5 py-2">
            <ShieldCheck className="w-4 h-4 shrink-0" />
            <span>DTMF IVR · Tenant Isolated</span>
          </div>
          <div className="text-xs">
            <div className="font-semibold text-white truncate">{user.name || user.email}</div>
            <div className="text-slate-400 capitalize">{user.role.replace('_', ' ')}</div>
          </div>
          <button
            onClick={logout}
            className="w-full flex items-center justify-center gap-2 py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-xs text-slate-300 border border-slate-800"
          >
            <LogOut className="w-3.5 h-3.5" />
            Sign Out
          </button>
        </div>
      </aside>

      {/* Main Content */}
      <div className="flex-1 flex flex-col min-w-0">
        <header className="h-14 bg-white border-b border-slate-200 px-6 flex items-center justify-between">
          <div className="text-sm font-medium text-slate-600">
            Order Created → Bangla TTS → Outbound IVR → DTMF 1/2/3 → Store & WhatsApp
          </div>
          <div className="flex items-center gap-3">
            {tenants.length > 0 && (
              <div className="flex items-center gap-2">
                <span className="text-xs font-medium text-slate-500">Tenant:</span>
                {user.role === 'super_admin' ? (
                  <select
                    value={activeTenantId || ''}
                    onChange={(e) => setActiveTenantId(e.target.value)}
                    className="text-xs font-semibold bg-slate-100 border border-slate-300 rounded-md px-2.5 py-1.5 text-slate-800"
                  >
                    {tenants.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name} ({t.timezone})
                      </option>
                    ))}
                  </select>
                ) : (
                  <span className="text-xs font-semibold bg-blue-50 text-blue-800 border border-blue-200 rounded-md px-2.5 py-1">
                    {tenants[0]?.name}
                  </span>
                )}
              </div>
            )}
          </div>
        </header>

        <main className="flex-1 p-6 max-w-7xl w-full mx-auto">{children}</main>
      </div>
    </div>
  );
}
