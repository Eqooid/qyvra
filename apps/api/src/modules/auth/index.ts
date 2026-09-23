/**
 * @author Cristono Wijaya
 * @description Exports the supported authentication module, guard, decorators, and trusted context types for other API modules.
 * @tags Authentication
 */
export { AuthModule } from './auth.module';
export { SessionAuthGuard } from './session-auth.guard';
export { CurrentUser, CurrentSession } from './authenticated-user';
export type {
  AuthenticatedUser,
  AuthenticatedRequest,
  AuthenticatedSession,
} from './authenticated-user';
