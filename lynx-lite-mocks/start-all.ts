const RESET = '\x1b[0m';

const SERVICES = [
  { name: 'DATADIS', color: '\x1b[33m', port: Number(process.env.PORT_DATADIS ?? 3001), entry: 'services/datadis/server.js' },
  { name: 'REData',  color: '\x1b[34m', port: Number(process.env.PORT_REDATA  ?? 3002), entry: 'services/redata/server.ts'  },
  { name: 'ESIOS',   color: '\x1b[32m', port: Number(process.env.PORT_ESIOS   ?? 3003), entry: 'services/esios/server.ts'   },
  { name: 'PVGIS',   color: '\x1b[35m', port: Number(process.env.PORT_PVGIS   ?? 3004), entry: 'services/pvgis/server.ts'   },
];

const BUN = process.execPath;

console.log('\n┌──────────┬─────────────────────────────┐');
console.log('│ Servicio │ URL                         │');
console.log('├──────────┼─────────────────────────────┤');
for (const s of SERVICES) {
  const url = `http://localhost:${s.port}`.padEnd(27);
  console.log(`│ ${s.color}${s.name.padEnd(8)}${RESET} │ ${url} │`);
}
console.log('└──────────┴─────────────────────────────┘');
console.log('\nCtrl+C para detener todos los servicios\n');

function spawnService(s: typeof SERVICES[number]) {
  let onFirstLine: () => void;
  const firstLine = new Promise<void>(r => { onFirstLine = r; });

  const proc = Bun.spawn([BUN, 'run', s.entry], {
    env: { ...process.env, PORT: String(s.port) },
    stdout: 'pipe',
    stderr: 'pipe',
    cwd: import.meta.dir,
  });

  const prefix = `${s.color}[${s.name}]${RESET} `;

  async function pipe(stream: ReadableStream<Uint8Array>, isErr = false) {
    const decoder = new TextDecoder();
    let buf = '';
    let notified = false;
    for await (const chunk of stream as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop()!;
      for (const line of lines) {
        if (line.trim()) {
          (isErr ? process.stderr : process.stdout).write(prefix + line + '\n');
          if (!notified) { notified = true; onFirstLine(); }
        }
      }
    }
    if (buf.trim()) process.stdout.write(prefix + buf + '\n');
  }

  pipe(proc.stdout);
  pipe(proc.stderr, true);

  return { proc, firstLine };
}

// Espera a que DATADIS emita su primera línea antes de arrancar los demás
const [datadis, ...rest] = SERVICES;
const { proc: datadisProc, firstLine: datadisReady } = spawnService(datadis);
await Promise.race([datadisReady, Bun.sleep(1500)]);
const restProcs = rest.map(s => spawnService(s).proc);
const procs = [datadisProc, ...restProcs];

process.on('SIGINT', () => {
  console.log('\nDeteniendo todos los servicios...');
  for (const proc of procs) proc.kill();
  process.exit(0);
});

await Promise.all(procs.map(p => p.exited));
