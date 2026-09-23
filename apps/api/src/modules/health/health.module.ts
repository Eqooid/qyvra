import { Module } from '@nestjs/common';
import { HealthController } from './health.controller';
import { HealthService } from './health.service';
import { DatabaseModule } from '../../database/database.module';

/**
 * @author Cristono Wijaya
 * @description Connects public health routes to lifecycle state and the existing PostgreSQL provider.
 * @tags Health Checks
 * @class HealthModule
 * @module HealthModule
 */
@Module({
  imports: [DatabaseModule],
  controllers: [HealthController],
  providers: [HealthService],
})
export class HealthModule {}
