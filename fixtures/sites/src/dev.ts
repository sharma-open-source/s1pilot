import { startFixtureServer } from './server.js';

const port = Number(process.env['PORT'] ?? 4400);
const bugs = (process.env['FIXTURE_BUGS'] ?? '').split(',').filter(Boolean);
const server = await startFixtureServer({ port, bugs, variant: process.env['FIXTURE_VARIANT'] });
process.stdout.write(`Fixture sites on ${server.url}  (Ctrl+C to stop)\n`);
process.on('SIGINT', () => void server.close().then(() => process.exit(0)));
