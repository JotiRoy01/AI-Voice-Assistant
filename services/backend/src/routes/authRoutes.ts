import { Router } from 'express';
import { z } from 'zod';
import { AppEnv } from '../config/env';
import { FlowMindRepository } from '../db/repository';
import { requireAuth, signAccessToken } from '../security/auth';
import { verifyPassword } from '../security/crypto';

const loginSchema = z.object({
  email: z.string().email(),
  password: z.string().min(1),
});

export function createAuthRouter(repo: FlowMindRepository, env: AppEnv): Router {
  /**
   * ============================================================================
   * ROUTER FACTORY DESCRIPTION: createAuthRouter (`/api/auth`)
   * - MEANING: Handles dashboard user login and session inspection.
   * - WHY WE USE IT: Dashboard users (`super_admin`, `business_owner`, `operator`, `support_viewer`) must authenticate to receive a signed JWT containing their `userId`, `tenantId`, and `role`.
   * - WHERE IT IS USED: Mounted at `/api/auth` in `src/app.ts` and called by the Next.js Admin Dashboard login screen.
   * ============================================================================
   */
  const router = Router();

  router.post('/login', async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: POST /api/auth/login
     * - CALLED BY: The Next.js Admin Dashboard login page (`services/dashboard`).
     * - INPUT SOURCE: `req.body` containing `{ email, password }`.
     * - PURPOSE: Looks up the user by email in the database, verifies their scrypt password hash (`verifyPassword`), and returns a 24-hour signed JWT (`accessToken`) along with the user's role and tenant info.
     */
    try {
      const parsed = loginSchema.safeParse(req.body);
      if (!parsed.success) {
        res.status(400).json({ error: 'Invalid credentials payload', details: parsed.error.flatten() });
        return;
      }
      const user = await repo.getUserByEmail(parsed.data.email);
      if (!user || !verifyPassword(parsed.data.password, user.passwordHash)) {
        res.status(401).json({ error: 'Invalid email or password' });
        return;
      }
      const token = signAccessToken(
        {
          userId: user.id,
          tenantId: user.tenantId,
          role: user.role,
          email: user.email,
        },
        env.JWT_SECRET
      );
      const tenant = user.tenantId ? await repo.getTenantById(user.tenantId) : null;
      res.json({
        accessToken: token,
        user: {
          id: user.id,
          email: user.email,
          name: user.name,
          role: user.role,
          tenantId: user.tenantId,
          tenantName: tenant?.name ?? null,
        },
      });
    } catch (err) {
      next(err);
    }
  });

  router.get('/me', requireAuth(env), async (req, res, next) => {
    /**
     * ENDPOINT DESCRIPTION: GET /api/auth/me
     * - CALLED BY: The Next.js Admin Dashboard on page load to restore the logged-in user's session and list available tenants.
     * - INPUT SOURCE: `Authorization: Bearer <JWT>` header parsed by `requireAuth(env)` into `req.auth`.
     * - PURPOSE: Returns the current user's profile, their active tenant, and (for `super_admin`) the list of all tenants so they can switch tenants in the dashboard header.
     */
    try {
      const tenant = req.auth?.tenantId ? await repo.getTenantById(req.auth.tenantId) : null;
      const tenants = req.auth?.role === 'super_admin' ? await repo.listTenants() : tenant ? [tenant] : [];
      res.json({
        user: req.auth,
        activeTenant: tenant,
        tenants,
      });
    } catch (err) {
      next(err);
    }
  });

  return router;
}
