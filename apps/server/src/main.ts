import { buildApp } from './app.js';
import { loadConfig, parseServerArgs } from './config.js';

/** Starts the server and shuts down gracefully on SIGINT/SIGTERM. */
async function main(): Promise<void> {
  const config = loadConfig(parseServerArgs(process.argv.slice(2)));
  const app = await buildApp(config);

  let closing = false;
  const shutdown = (signal: string): void => {
    if (closing) return;
    closing = true;
    app.log.info({ signal }, 'shutting down');
    app.close().then(
      () => process.exit(0),
      (error: unknown) => {
        app.log.error({ error }, 'error during shutdown');
        process.exit(1);
      },
    );
  };
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('SIGTERM', () => shutdown('SIGTERM'));

  await app.listen({ port: config.port, host: config.host });
}

main().catch((error: unknown) => {
  process.stderr.write(`s1pilot server failed to start: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
