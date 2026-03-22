import os from 'os';
import path from 'path';

const KNOWN_MACHINES: Record<string, string> = {
  'Maxs-Mac-mini': 'mini',
  'Macmini': 'mini',
  'Maxs-MacBook-Pro': 'macbook',
  'Mac': 'macbook',
};

export function getMachineId(): string {
  const envMachine = process.env.ARIA_MACHINE;
  if (envMachine) return envMachine;

  const hostname = os.hostname();
  // Strip .local suffix if present
  const clean = hostname.replace(/\.local$/, '');
  const machine = KNOWN_MACHINES[clean];
  if (!machine) {
    throw new Error(`Unknown machine hostname: ${hostname}. Set ARIA_MACHINE env var.`);
  }
  return machine;
}

export function getDataDir(): string {
  return path.join(os.homedir(), 'Library', 'Mobile Documents', 'com~apple~CloudDocs', 'aria', 'data');
}

export function getLocalDbPath(): string {
  return path.join(getDataDir(), `${getMachineId()}.db`);
}

export function getPeerDbPath(): string {
  const machineId = getMachineId();
  const peer = machineId === 'mini' ? 'macbook' : 'mini';
  return path.join(getDataDir(), `${peer}.db`);
}

export function isWorker(): boolean {
  return getMachineId() !== 'mini';
}

export function getCoordinatorUrl(): string | null {
  if (!isWorker()) return null;
  return process.env.ARIA_COORDINATOR ?? 'http://mac-mini:8080';
}
