import { randomUUID } from "crypto";

export function generateId(): string {
  return randomUUID();
}

export function now(): number {
  return Math.floor(Date.now() / 1000);
}
