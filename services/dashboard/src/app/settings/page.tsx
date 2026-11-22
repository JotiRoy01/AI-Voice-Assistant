'use client';

import React, { useEffect, useState } from 'react';
import { KeyRound, Save, ShieldCheck } from 'lucide-react';
import { useAuth } from '@/components/AuthContext';
import { apiFetch } from '@/lib/api';

interface VoiceSettingsData {
  enabled: boolean;
  language: string;
  voiceName: string;
  callWindowStart: string;
  callWindowEnd: string;
  retryLimit: number;
  retryIntervalMinutes: number;
  menuReplayLimit: number;
  invalidKeyLimit: number;
  eligibleStatuses: string[];
  whatsappFallbackContact: string;
  ttsProvider: 'local_http' | 'mock';
  telephonyProvider: 'simulator' | 'asterisk_ari';
  whatsappProvider: 'simulator' | 'meta_cloud';
}

interface CredentialRow {
  id: string;
  provider: string;
  status: string;
  hasEncryptedSecret: boolean;
  updatedAt: string;
}

export default function VoiceSettingsPage() {
  const { token, activeTenantId } = useAuth();
  const [settings, setSettings] = useState<VoiceSettingsData | null>(null);
  const [statusesText, setStatusesText] = useState('');
  const [credentials, setCredentials] = useState<CredentialRow[]>([]);
  const [credProvider, setCredProvider] = useState('shopify');
  const [credSecret, setCredSecret] = useState('');
  const [notice, setNotice] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  const load = async () => {
    if (!token || !activeTenantId) return;
    const [sRes, cRes] = await Promise.all([
      apiFetch<{ settings: VoiceSettingsData }>('/api/voice/settings', {
        token,
        tenantId: activeTenantId,
      }),
      apiFetch<{ credentials: CredentialRow[] }>('/api/dashboard/credentials', {
        token,
        tenantId: activeTenantId,
      }),
    ]);
    setSettings(sRes.settings);
    setStatusesText(sRes.settings.eligibleStatuses.join(', '));
    setCredentials(cRes.credentials);
  };

  useEffect(() => {
    load().catch(() => {});
  }, [token, activeTenantId]);

  const handleSaveSettings = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!settings || !token || !activeTenantId) return;
    setSaving(true);
    setNotice(null);
    try {
      const eligibleStatuses = statusesText
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean);
      const res = await apiFetch<{ settings: VoiceSettingsData }>('/api/voice/settings', {
        method: 'PATCH',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({ ...settings, eligibleStatuses }),
      });
      setSettings(res.settings);
      setNotice('Tenant voice verification settings saved.');
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to save settings');
    } finally {
      setSaving(false);
    }
  };

  const handleSaveCredential = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!credSecret || !token || !activeTenantId) return;
    setNotice(null);
    try {
      await apiFetch(`/api/dashboard/credentials/${credProvider}`, {
        method: 'PUT',
        token,
        tenantId: activeTenantId,
        body: JSON.stringify({ secret: credSecret, status: 'active' }),
      });
      setCredSecret('');
      setNotice(`Encrypted ${credProvider} secret stored (AES-256-GCM).`);
      await load();
    } catch (err) {
      setNotice(err instanceof Error ? err.message : 'Failed to encrypt credential');
    }
  };

  if (!settings) {
    return <div className="text-sm text-slate-500">Loading tenant voice configuration...</div>;
  }

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-bold text-slate-900">Voice Settings & Credentials</h1>
        <p className="text-sm text-slate-500">
          Configure Bangla voice, tenant calling window, retry policy, eligible order statuses, and AES-256-GCM encrypted provider secrets
        </p>
      </div>

      {notice && (
        <div className="p-3 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-900">
          {notice}
        </div>
      )}

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
        <form
          onSubmit={handleSaveSettings}
          className="lg:col-span-2 bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-5"
        >
          <div className="flex items-center justify-between pb-4 border-b border-slate-100">
            <div>
              <h2 className="text-sm font-bold text-slate-900">Automated Voice Verification</h2>
              <p className="text-xs text-slate-500">Enable or pause automated outbound calls for this tenant</p>
            </div>
            <label className="inline-flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={settings.enabled}
                onChange={(e) => setSettings({ ...settings, enabled: e.target.checked })}
                className="w-4 h-4 accent-blue-600"
              />
              <span className="text-sm font-semibold text-slate-800">
                {settings.enabled ? 'Enabled' : 'Disabled'}
              </span>
            </label>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Language</label>
              <input
                value={settings.language}
                onChange={(e) => setSettings({ ...settings, language: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Bangla TTS Voice</label>
              <select
                value={settings.voiceName}
                onChange={(e) => setSettings({ ...settings, voiceName: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="bn-BD-NabanitaNeural">bn-BD-NabanitaNeural (BD Female Neural)</option>
                <option value="bn-BD-PradeepNeural">bn-BD-PradeepNeural (BD Male Neural)</option>
                <option value="bn-IN-TanishaaNeural">bn-IN-TanishaaNeural (Bengali Female)</option>
                <option value="piper-bn-local">piper-bn-local (Offline Piper ONNX)</option>
              </select>
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Calling Window Start (Local)
              </label>
              <input
                type="time"
                value={settings.callWindowStart}
                onChange={(e) => setSettings({ ...settings, callWindowStart: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Calling Window End (Local)
              </label>
              <input
                type="time"
                value={settings.callWindowEnd}
                onChange={(e) => setSettings({ ...settings, callWindowEnd: e.target.value })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">No-Answer Retry Limit</label>
              <input
                type="number"
                min={0}
                max={5}
                value={settings.retryLimit}
                onChange={(e) => setSettings({ ...settings, retryLimit: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">
                Retry Interval (Minutes)
              </label>
              <input
                type="number"
                min={1}
                max={240}
                value={settings.retryIntervalMinutes}
                onChange={(e) => setSettings({ ...settings, retryIntervalMinutes: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Menu Replay Limit (No Input)</label>
              <input
                type="number"
                min={0}
                max={3}
                value={settings.menuReplayLimit}
                onChange={(e) => setSettings({ ...settings, menuReplayLimit: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Invalid Key Attempt Limit</label>
              <input
                type="number"
                min={1}
                max={5}
                value={settings.invalidKeyLimit}
                onChange={(e) => setSettings({ ...settings, invalidKeyLimit: Number(e.target.value) })}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              Eligible Order Statuses (comma-separated)
            </label>
            <input
              value={statusesText}
              onChange={(e) => setStatusesText(e.target.value)}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              placeholder="pending, cod_unverified, processing"
            />
          </div>

          <div>
            <label className="block text-xs font-semibold text-slate-700 mb-1">
              WhatsApp Business / Fallback Contact Number
            </label>
            <input
              value={settings.whatsappFallbackContact}
              onChange={(e) => setSettings({ ...settings, whatsappFallbackContact: e.target.value })}
              className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
            />
          </div>

          <button
            type="submit"
            disabled={saving}
            className="inline-flex items-center gap-2 px-4 py-2.5 rounded-lg bg-blue-600 hover:bg-blue-700 text-white text-sm font-semibold"
          >
            <Save className="w-4 h-4" />
            {saving ? 'Saving...' : 'Save Voice Settings'}
          </button>
        </form>

        {/* Encrypted Provider Credentials Vault */}
        <div className="bg-white rounded-xl border border-slate-200 p-6 shadow-sm space-y-4">
          <div className="flex items-center gap-2 text-sm font-bold text-slate-900">
            <KeyRound className="w-4 h-4 text-blue-600" />
            Encrypted Provider Secrets
          </div>
          <p className="text-xs text-slate-500">
            Secrets are encrypted at rest with AES-256-GCM and never returned to the browser.
          </p>

          <div className="space-y-2">
            {credentials.map((c) => (
              <div
                key={c.id}
                className="px-3 py-2 rounded-lg bg-slate-50 border border-slate-200 flex items-center justify-between text-xs"
              >
                <span className="font-semibold uppercase text-slate-800">{c.provider}</span>
                <span className="inline-flex items-center gap-1 text-emerald-700">
                  <ShieldCheck className="w-3.5 h-3.5" /> Encrypted
                </span>
              </div>
            ))}
          </div>

          <form onSubmit={handleSaveCredential} className="pt-3 border-t border-slate-100 space-y-3">
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">Provider</label>
              <select
                value={credProvider}
                onChange={(e) => setCredProvider(e.target.value)}
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg bg-white"
              >
                <option value="shopify">Shopify Webhook Secret</option>
                <option value="woocommerce">WooCommerce Webhook Secret</option>
                <option value="custom">Custom Store Webhook Secret</option>
                <option value="whatsapp">Meta WhatsApp Access Token</option>
                <option value="asterisk_sip">Asterisk / SIP Trunk Secret</option>
              </select>
            </div>
            <div>
              <label className="block text-xs font-semibold text-slate-700 mb-1">New Secret / Token</label>
              <input
                type="password"
                value={credSecret}
                onChange={(e) => setCredSecret(e.target.value)}
                placeholder="Enter secret (write-only)"
                required
                className="w-full px-3 py-2 text-sm border border-slate-300 rounded-lg"
              />
            </div>
            <button
              type="submit"
              className="w-full py-2 rounded-lg bg-slate-900 hover:bg-slate-800 text-white text-xs font-semibold"
            >
              Encrypt & Store Secret
            </button>
          </form>
        </div>
      </div>
    </div>
  );
}
