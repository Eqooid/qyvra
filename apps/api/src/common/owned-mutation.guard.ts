import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Injectable,
} from '@nestjs/common';
import { Request } from 'express';
import { ConfigurationService } from '../configuration/configuration.module';

/** @author Cristono Wijaya
 * @description Applies the documented Origin/custom-header CSRF policy to owned-resource mutations without changing authentication.
 * @tags Request Security
 */
@Injectable()
export class OwnedMutationGuard implements CanActivate {
  /** @description Uses the existing validated browser-origin allowlist. */
  constructor(private readonly configuration: ConfigurationService) {}
  /** @description GET remains read-only; mutations require trusted origin, CSRF header and no query fields. */
  canActivate(context: ExecutionContext): boolean {
    const request = context.switchToHttp().getRequest<Request>();
    if (request.method === 'GET') {
      const body: unknown = request.body;
      if (
        body !== undefined &&
        (body === null ||
          typeof body !== 'object' ||
          Array.isArray(body) ||
          Object.keys(body).length)
      )
        throw new BadRequestException();
      return true;
    }
    const origin = request.headers.origin;
    if (
      request.headers['x-csrf-protection'] !== '1' ||
      (origin !== undefined &&
        !this.configuration.cors.origins.includes(origin)) ||
      (origin === undefined &&
        request.headers['sec-fetch-site'] === 'cross-site')
    )
      throw new ForbiddenException();
    if (Object.keys(request.query).length) throw new BadRequestException();
    return true;
  }
}
