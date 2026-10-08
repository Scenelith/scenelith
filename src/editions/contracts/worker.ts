export interface EditionWorker {
  enabled(role: string): boolean;
  heartbeatRole: string;
  drain(): Promise<void>;
  drainGeneration?(): Promise<void>;
  cleanup(before: string): Promise<void>;
}
