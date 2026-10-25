import { chmod, chown, lstat, mkdir } from 'node:fs/promises';

// Railway mounts the data volume as root. Prepare only this fixed directory,
// then drop all root privileges before loading the HTTP application.
if (process.platform === 'linux' && process.getuid() === 0) {
  await mkdir('/data', { recursive: true, mode: 0o700 });
  const directory = await lstat('/data');
  if (!directory.isDirectory() || directory.isSymbolicLink()) throw new Error('Invalid analytics volume.');
  await chown('/data', 1000, 1000);
  await chmod('/data', 0o700);
  process.setgroups([]);
  process.setgid(1000);
  process.setuid(1000);
}
const { startServer } = await import('./server.mjs');
startServer();
