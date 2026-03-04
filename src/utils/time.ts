import { v4 as uuidv4 } from "uuid";

export function nowIso(): string {
  return new Date().toISOString();
}

export function newTaskId(): string {
  return `task-${uuidv4()}`;
}

export function newToken(): string {
  return uuidv4();
}

export function expiresInMinutes(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString();
}