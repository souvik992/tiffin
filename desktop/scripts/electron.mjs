// Runs Electron with the given arguments. Clears ELECTRON_RUN_AS_NODE, which VS Code's terminal sets
// and which would make Electron behave as plain Node (no window).
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';

const electron = createRequire(import.meta.url)('electron'); // the path to electron.exe
const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;
const child = spawn(electron, process.argv.slice(2), { stdio: 'inherit', env, windowsHide: false });
child.on('exit', (code) => process.exit(code ?? 0));
