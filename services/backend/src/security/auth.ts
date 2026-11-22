import { NextFunction, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { AppEnv } from '../config/env';
import { AuthContext, UserRole } from '../domain/types';
import { timingSafeCompare } from './crypto';
import { logger } from '../utils/logger';

declare global {
  namespace Express {
    interface Request {
      auth?: AuthContext;
      rawBody?: Buffer;
    }
  }
}

export function signAccessToken(payload: AuthContext, secret: string): string {
  /**
   * FUNCTION DESCRIPTION: signAccessToken
   * - CALLED BY: `authRoutes.ts` (`POST /api/auth/login`) after verifying a user's email and password.
   * - INPUT SOURCE: `payload` (`{ userId, tenantId, role, email }`) from the logged-in `User` record, and `secret` from `env.JWT_SECRET`.
   * - PURPOSE: Signs a 24-hour JSON Web Token (JWT) that the Next.js Admin Dashboard sends in `Authorization: Bearer <token>` on subsequent API calls.
   */
  return jwt.sign(payload, secret, { expiresIn: '24h' });
}

export function verifyAccessToken(token: string, secret: string): AuthContext | null {
  /**
   * FUNCTION DESCRIPTION: verifyAccessToken
   * - CALLED BY: `requireAuth` middleware in this file.
   * - INPUT SOURCE: `token` string extracted from the `Authorization: Bearer ...` header and `secret` (`env.JWT_SECRET`).
   * - PURPOSE: Cryptographically verifies the JWT signature and expiration time, returning the decoded `AuthContext` or `null` if tampered/expired.
   */
  try {
    const decoded = jwt.verify(token, secret) as AuthContext;
    return {
      userId: decoded.userId,
      tenantId: decoded.tenantId,
      role: decoded.role,
      email: decoded.email,
    };
  } catch {
    return null;
  }
}

export function requireAuth(env: AppEnv) {
  /**
   * MIDDLEWARE DESCRIPTION: requireAuth
   * - CALLED BY: Protected Express routes in `authRoutes.ts`, `voiceAndOrderRoutes.ts`, and `dashboardAndSimulatorRoutes.ts`.
   * - INPUT SOURCE: Incoming HTTP `req.headers.authorization` (`Bearer <JWT>`) or `req.headers['x-internal-token']`.
   * - PURPOSE: Blocks unauthenticated requests with `401 Unauthorized` and attaches the verified user identity (`req.auth`) to the Express request object.
   */
  return (req: Request, res: Response, next: NextFunction): void => {
    const internalToken = req.header('x-internal-token');
    if (internalToken && timingSafeCompare(internalToken, env.INTERNAL_SERVICE_TOKEN)) {
      const scopedTenant = req.header('x-tenant-id') || null;
      req.auth = {
        userId: 'internal-service',
        tenantId: scopedTenant,
        role: 'super_admin',
        email: 'service@flowmind.internal',
        isInternalService: true,
      };
      next();
      return;
    }

    const header = req.header('authorization');
    if (!header?.startsWith('Bearer ')) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    const token = header.slice('Bearer '.length).trim();
    const ctx = verifyAccessToken(token, env.JWT_SECRET);
    if (!ctx) {
      res.status(401).json({ error: 'Invalid or expired access token' });
      return;
    }
    req.auth = ctx;
    next();
  };
}

export function requireInternalService(env: AppEnv) {
  /**
   * MIDDLEWARE DESCRIPTION: requireInternalService
   * - CALLED BY: Internal n8n orchestration routes (`/api/internal/*` and `POST /api/voice/jobs` in `voiceAndOrderRoutes.ts`).
   * - INPUT SOURCE: `X-Internal-Token` HTTP header sent by self-hosted n8n.
   * - PURPOSE: Uses constant-time comparison (`timingSafeCompare`) to verify that the request came from our internal n8n orchestrator (`env.INTERNAL_SERVICE_TOKEN`).
   */
  return (req: Request, res: Response, next: NextFunction): void => {
    const internalToken = req.header('x-internal-token');
    if (!internalToken || !timingSafeCompare(internalToken, env.INTERNAL_SERVICE_TOKEN)) {
      logger.warn({ path: req.path }, 'Rejected unauthorized internal service request');
      res.status(401).json({ error: 'Internal service authentication required' });
      return;
    }
    req.auth = {
      userId: 'internal-service',
      tenantId: req.header('x-tenant-id') || null,
      role: 'super_admin',
      email: 'service@flowmind.internal',
      isInternalService: true,
    };
    next();
  };
}

export function requireRoles(...roles: UserRole[]) {
  /**
   * MIDDLEWARE DESCRIPTION: requireRoles (Role-Based Access Control / RBAC)
   * - CALLED BY: Mutating endpoints in `voiceAndOrderRoutes.ts` and `dashboardAndSimulatorRoutes.ts` (e.g., updating voice settings, saving encrypted credentials, or retrying calls).
   * - INPUT SOURCE: `req.auth.role` populated by `requireAuth`.
   * - PURPOSE: Enforces the 4 SRS roles (`super_admin`, `business_owner`, `operator`, `support_viewer`). If the user's role is not in `roles`, blocks the request with `403 Forbidden`.
   */
  return (req: Request, res: Response, next: NextFunction): void => {
    if (!req.auth) {
      res.status(401).json({ error: 'Authentication required' });
      return;
    }
    if (!roles.includes(req.auth.role)) {
      res.status(403).json({ error: 'Insufficient permissions' });
      return;
    }
    next();
  };
}

export function resolveScopedTenantId(req: Request): string | null {
  /**
   * FUNCTION DESCRIPTION: resolveScopedTenantId (Multi-Tenant Isolation Guard)
   * - CALLED BY: Every tenant-scoped route in `voiceAndOrderRoutes.ts` and `dashboardAndSimulatorRoutes.ts`.
   * - INPUT SOURCE: `req.auth` (from the user's JWT) and optional `X-Tenant-Id` header or `?tenantId=` query parameter.
   * - PURPOSE: Enforces strict multi-tenant data isolation (SRS FR-03 & Section 15):
   *   • `super_admin` is allowed to inspect any tenant via `X-Tenant-Id`.
   *   • Tenant users (`business_owner`, `operator`, `support_viewer`) are locked to their own `req.auth.tenantId`. If they try to pass another tenant's ID in `X-Tenant-Id`, this returns `'__FORBIDDEN__'` and the route immediately responds with `403 Cross-tenant access denied`.
   */
  if (!req.auth) return null;
  if (req.auth.role === 'super_admin') {
    const requested = (req.header('x-tenant-id') || (req.query.tenantId as string) || req.auth.tenantId);
    return requested ? String(requested) : null;
  }
  const requestedHeader = req.header('x-tenant-id');
  if (requestedHeader && requestedHeader !== req.auth.tenantId) {
    logger.warn(
      { userId: req.auth.userId, userTenant: req.auth.tenantId, attemptedTenant: requestedHeader },
      'Cross-tenant access attempt blocked'
    );
    return '__FORBIDDEN__';
  }
  return req.auth.tenantId;
}
