import { Test, TestingModule } from '@nestjs/testing';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { ConfigurationService } from './configuration/configuration.module';

describe('AppController', () => {
  let appController: AppController;

  beforeEach(async () => {
    const app: TestingModule = await Test.createTestingModule({
      controllers: [AppController],
      providers: [
        AppService,
        {
          provide: ConfigurationService,
          useValue: { application: { name: 'Brainless API' } },
        },
      ],
    }).compile();

    appController = app.get<AppController>(AppController);
  });

  describe('root', () => {
    it('returns application information', () => {
      expect(appController.getInformation()).toEqual({
        name: 'Brainless API',
        apiVersion: 'v1',
      });
    });
  });
});
