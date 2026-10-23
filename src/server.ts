import { buildApp } from './app.js';
import { loadEnvironment } from './config/env.js';

const environment = loadEnvironment();
const app = buildApp();

const shutdown = async (signal: string): Promise<void> => {
  app.log.info({ signal }, 'Shutting down application');
  await app.close();
};

process.once('SIGINT', () => {
  void shutdown('SIGINT');
});
process.once('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await app.listen({ host: environment.HOST, port: environment.PORT });
} catch (error) {
  app.log.error(error);
  process.exitCode = 1;
}
