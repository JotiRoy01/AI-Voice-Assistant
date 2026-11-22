export const API_BASE_URL =
  process.env.NEXT_PUBLIC_API_BASE_URL || 'http://localhost:4000';

export interface AuthUser {
  id: string;
  email: string;
  name: string;
  role: 'super_admin' | 'business_owner' | 'operator';
  tenantId: string | null;
  tenantName?: string | null;
}

export interface TenantInfo {
  id: string;
  name: string;
  slug: string;
  status: string;
  timezone: string;
}

export async function apiFetch<T>(
  path: string,
  options: RequestInit & { token?: string | null; tenantId?: string | null } = {}
): Promise<T> {
  const { token, tenantId, headers, ...rest } = options;
  const reqHeaders: Record<string, string> = {
    'Content-Type': 'application/json',
    ...(headers as Record<string, string>),
  };
  if (token) {
    reqHeaders['Authorization'] = `Bearer ${token}`;
  }
  if (tenantId) {
    reqHeaders['X-Tenant-Id'] = tenantId;
  }

  const res = await fetch(`${API_BASE_URL}${path}`, {
    ...rest,
    headers: reqHeaders,
    cache: 'no-store',
  });

  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    throw new Error(data.error || data.reason || `Request failed (${res.status})`);
  }
  return data as T;
}

export function formatTenantDateTime(iso: string | null | undefined, timeZone = 'Asia/Dhaka'): string {
  if (!iso) return '—';
  try {
    return new Intl.DateTimeFormat('en-GB', {
      timeZone,
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
      hour12: true,
    }).format(new Date(iso));
  } catch {
    return iso;
  }
}
