import { Module } from '@nestjs/common';
import { ConfigurationModule } from '../../configuration/configuration.module';
import { DatabaseModule } from '../../database/database.module';
import { SearchEnrollmentService } from './search-enrollment.service';

@Module({
  imports: [ConfigurationModule, DatabaseModule],
  providers: [SearchEnrollmentService],
  exports: [SearchEnrollmentService],
})
export class SearchEnrollmentModule {}
