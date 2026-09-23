import { HttpException } from '@nestjs/common';
import { NextFunction, Request, Response, json } from 'express';
import { ApiConfiguration } from '../configuration/settings';

/**
 * @author Cristono Wijaya
 * @description Middleware that implements rate limiting for authentication endpoints.
 * It restricts registration, login, refresh, and password-change work using configured budgets.
 * @tags Authentication Rate Limiting
 * @param configuration - The application configuration settings used to customize the rate limiting behavior.
 * @returns - A middleware function that enforces rate limits on authentication requests.
 */
export function authenticationRateLimit(configuration: ApiConfiguration) {
  const policy = configuration.authentication;
  const limits: Record<string, number> = {
    register: policy.registerRateLimit,
    login: policy.loginRateLimit,
    refresh: policy.refreshRateLimit,
  };
  let resetAt = 0;
  let total = 0;
  const counts = new Map<string, number>();
  return (request: Request, response: Response, next: NextFunction): void => {
    const match = /^\/api\/v1\/auth\/(register|login|refresh)\/?$/i.exec(
      request.path,
    );
    const passwordChange =
      request.method === 'PATCH' &&
      /^\/api\/v1\/me\/password\/?$/i.test(request.path);
    if (!passwordChange && (request.method !== 'POST' || !match)) return next();
    const now = Date.now();
    if (now >= resetAt) {
      resetAt = now + policy.rateWindowSeconds * 1000;
      total = 0;
      counts.clear();
    }
    // Password verification shares the login peer budget and global Argon2 admission budget.
    const endpoint = passwordChange ? 'login' : match?.[1].toLowerCase();
    if (!endpoint) return next();
    const key = `${endpoint}:${request.socket.remoteAddress ?? 'unknown'}`;
    const count = counts.get(key) ?? 0;
    if (total >= policy.globalRateLimit || count >= limits[endpoint]) {
      response.setHeader(
        'Retry-After',
        Math.max(1, Math.ceil((resetAt - now) / 1000)),
      );
      return next(new HttpException('Too Many Requests', 429));
    }
    total++;
    counts.set(key, count + 1);
    next();
  };
}

/**
 * @author Cristono Wijaya
 * @description Middleware that enforces a bounded JSON body size for incoming requests.
 * It ensures that requests with a body exceeding the specified limit are rejected with an appropriate HTTP status code.
 * @tags Bounded JSON Body Middleware
 * @param limit - The maximum allowed size of the JSON body in bytes.
 * @returns - A middleware function that validates the size of the JSON body in incoming requests.
 */
export function boundedJsonBody(limit: number) {
  const parser = json({ limit, inflate: false });
  return (request: Request, response: Response, next: NextFunction): void => {
    const hasBody =
      request.headers['transfer-encoding'] !== undefined ||
      Number(request.headers['content-length'] ?? 0) > 0;
    // Only the upload route bypasses JSON parsing; its authenticated handler enforces streaming limits.
    if (
      request.method === 'POST' &&
      /^\/api\/v1\/documents(?:\/[^/]+\/versions)?\/?$/i.test(request.path) &&
      request.is('multipart/form-data')
    ) {
      if (
        request.headers['content-encoding'] &&
        request.headers['content-encoding'] !== 'identity'
      )
        return next(new HttpException('Unsupported Media Type', 415));
      return next();
    }
    if (hasBody && !request.is('application/json'))
      return next(new HttpException('Unsupported Media Type', 415));
    parser(request, response, (error: unknown) => {
      if (!error) return next();
      // Only these known parser conditions become client errors. Never forward
      // parser errors containing raw request bytes to logging or responses.
      const type =
        typeof error === 'object' && error !== null && 'type' in error
          ? error.type
          : undefined;
      const status =
        type === 'entity.too.large'
          ? 413
          : type === 'encoding.unsupported' || type === 'charset.unsupported'
            ? 415
            : 400;
      next(new HttpException('Invalid request body', status));
    });
  };
}
