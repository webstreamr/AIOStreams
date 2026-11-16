import { Request, Response, NextFunction } from 'express';
import {
  APIError,
  constants,
  testXtreamLogin,
  XtreamAddon,
  XtreamError,
} from '@aiostreams/core';
import { z } from 'zod';
import { createResponse } from '../../utils/responses.js';
import { requireSessionIfAuthRequired } from '../../middlewares/auth.js';
import { userApiRateLimiter } from '../../middlewares/ratelimit.js';
import { liveTvRouter } from './livetv.js';

/** The provider's failures as the provider's, not as this server's. */
const failure = (error: unknown) =>
  error instanceof XtreamError
    ? new APIError(constants.ErrorCode.UPSTREAM_ERROR, 502, error.message)
    : error;

const router = liveTvRouter((config) => new XtreamAddon(config), failure);

const LoginSchema = z.object({
  server: z.string().min(1),
  username: z.string().min(1),
  password: z.string().min(1),
});

/** `POST /test` for the configure page, which a browser reaches past `internalMiddleware`. */
router.post(
  '/test',
  requireSessionIfAuthRequired,
  userApiRateLimiter,
  async (req: Request, res: Response, next: NextFunction) => {
    const login = LoginSchema.safeParse(req.body ?? {});
    if (!login.success) {
      res.status(400).json(
        createResponse({
          success: false,
          detail: 'The server, username and password are all needed to test',
        })
      );
      return;
    }
    try {
      res.json(
        createResponse({
          success: true,
          data: await testXtreamLogin(login.data),
        })
      );
    } catch (error) {
      next(error);
    }
  }
);

export default router;
