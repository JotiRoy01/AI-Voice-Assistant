'use client';

import React, { createContext, useContext, useEffect, useState } from 'react';
import { apiFetch, AuthUser, TenantInfo } from '@/lib/api';

interface AuthContextValue {
  token: string | null;
  user: AuthUser | null;
  tenants: TenantInfo[];
  activeTenantId: string | null;
  setActiveTenantId: (id: string) => void;
  login: (email: string, password: string) => Promise<void>;
  logout: () => void;
  loading: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [token, setToken] = useState<string | null>(null);
  const [user, setUser] = useState<AuthUser | null>(null);
  const [tenants, setTenants] = useState<TenantInfo[]>([]);
  const [activeTenantId, setActiveTenantIdState] = useState<string | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const savedToken = localStorage.getItem('flowmind_token');
    const savedTenant = localStorage.getItem('flowmind_tenant');
    if (!savedToken) {
      setLoading(false);
      return;
    }
    setToken(savedToken);
    apiFetch<{ user: AuthUser; activeTenant: TenantInfo | null; tenants: TenantInfo[] }>('/api/auth/me', {
      token: savedToken,
    })
      .then((res) => {
        setUser(res.user);
        setTenants(res.tenants || []);
        const resolvedTenant =
          res.user.role === 'super_admin' && savedTenant
            ? savedTenant
            : res.user.tenantId || res.tenants?.[0]?.id || null;
        setActiveTenantIdState(resolvedTenant);
      })
      .catch(() => {
        localStorage.removeItem('flowmind_token');
        setToken(null);
      })
      .finally(() => setLoading(false));
  }, []);

  const login = async (email: string, password: string) => {
    const res = await apiFetch<{ accessToken: string; user: AuthUser }>('/api/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email, password }),
    });
    localStorage.setItem('flowmind_token', res.accessToken);
    setToken(res.accessToken);
    setUser(res.user);

    const me = await apiFetch<{ activeTenant: TenantInfo | null; tenants: TenantInfo[] }>('/api/auth/me', {
      token: res.accessToken,
    });
    setTenants(me.tenants || []);
    const tid = res.user.tenantId || me.tenants?.[0]?.id || null;
    setActiveTenantIdState(tid);
    if (tid) localStorage.setItem('flowmind_tenant', tid);
  };

  const logout = () => {
    localStorage.removeItem('flowmind_token');
    localStorage.removeItem('flowmind_tenant');
    setToken(null);
    setUser(null);
    setTenants([]);
    setActiveTenantIdState(null);
  };

  const setActiveTenantId = (id: string) => {
    setActiveTenantIdState(id);
    localStorage.setItem('flowmind_tenant', id);
  };

  return (
    <AuthContext.Provider
      value={{ token, user, tenants, activeTenantId, setActiveTenantId, login, logout, loading }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
