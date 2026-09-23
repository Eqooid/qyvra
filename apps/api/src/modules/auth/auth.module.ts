import { Module } from '@nestjs/common';
import { ProfileController } from './profile.controller';
import { ProfileService } from './profile.service';
import { ConfigurationModule } from '../../configuration/configuration.module';
import { DatabaseModule } from '../../database/database.module';
import { RegistrationController } from './registration.controller';
import { RegistrationService } from './registration.service';
import { RegistrationRepository } from './registration.repository';
import { PasswordService } from './password.service';
import { LoginController } from './login.controller';
import { LoginService } from './login.service';
import { LoginRepository } from './login.repository';
import { CurrentUserController } from './current-user.controller';
import { SessionAuthGuard } from './session-auth.guard';
import { SessionService } from './session.service';
import { AuthenticationCookies } from './authentication-cookies';
import { SessionLifecycleService } from './session-lifecycle.service';
import { SessionLifecycleController } from './session-lifecycle.controller';
import { SessionManagementController } from './session-management.controller';
import { SessionManagementService } from './session-management.service';

/**
 * @author Cristono Wijaya
 * @description Wires local authentication controllers and services and exports reusable session authentication providers.
 * @tags Authentication
 * @class AuthModule
 * @module AuthModule
 */
@Module({
  imports: [ConfigurationModule, DatabaseModule],
  controllers: [
    ProfileController,
    RegistrationController,
    LoginController,
    CurrentUserController,
    SessionLifecycleController,
    SessionManagementController,
  ],
  providers: [
    ProfileService,
    RegistrationService,
    RegistrationRepository,
    PasswordService,
    LoginService,
    LoginRepository,
    SessionAuthGuard,
    SessionService,
    AuthenticationCookies,
    SessionLifecycleService,
    SessionManagementService,
  ],
  exports: [SessionAuthGuard, SessionService, ConfigurationModule],
})
export class AuthModule {}
