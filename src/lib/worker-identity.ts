import { randomUUID } from "node:crypto";
import { hostname } from "node:os";

const processIdentity = `${hostname()}-${process.pid}-${randomUUID()}`;

export function workerIdentity(role: string) {
  return `${role}-${processIdentity}`;
}
