import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module.js';
import { configureApp } from './bootstrap.js';
import { APP_ENV } from './config/config.module.js';
import type { AppEnv } from './config/env.js';

async function main(): Promise<void> {
  const app = await NestFactory.create(AppModule);
  configureApp(app);

  const env = app.get<AppEnv>(APP_ENV);
  await app.listen(env.apiPort);
}

void main();
