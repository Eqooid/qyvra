import {
  Injectable,
  OnApplicationShutdown,
  OnModuleInit,
} from '@nestjs/common';
import { PrismaService } from '../../database/prisma.service';
import { markWorkerReady } from './worker-ready';

/** Container-local readiness is true only while broker and database are usable. */
@Injectable()
export class WorkerReadiness implements OnModuleInit, OnApplicationShutdown {
  private databaseReady = false;
  private consumerReady = false;
  private stopped = false;
  private timer?: ReturnType<typeof setInterval>;

  constructor(private readonly database: PrismaService) {}

  async onModuleInit(): Promise<void> {
    await this.refreshDatabase();
    this.timer = setInterval(() => {
      void this.refreshDatabase();
    }, 5000);
  }

  setConsumerReady(ready: boolean): void {
    this.consumerReady = ready;
    this.update();
  }

  async refreshDatabase(): Promise<void> {
    try {
      await this.database.ping();
      this.databaseReady = true;
    } catch {
      this.databaseReady = false;
    }
    this.update();
  }

  async onApplicationShutdown(): Promise<void> {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.update();
  }

  private update(): void {
    markWorkerReady(!this.stopped && this.databaseReady && this.consumerReady);
  }
}
