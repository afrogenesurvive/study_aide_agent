/**
 * Material-generation barrel.
 *
 * `repo` is SQL only, `pipeline` and `candidates` are pure, `transport` is the
 * test seam, and `run` is the orchestration the IPC layer calls. Importing from
 * here keeps call sites free of relative-path noise, mirroring
 * `services/fsrs/index.ts`.
 *
 * Note what is *not* here: nothing in this tree reads `agent-config/` or the
 * app config from disk. The caller loads those and passes them in, which is what
 * keeps the whole subsystem runnable under Vitest with no Electron stub.
 */

export * from "./candidates";
export * from "./options";
export * from "./pipeline";
export * from "./repo";
export * from "./run";
export * from "./scope";
export * from "./tools";
export * from "./transport";
export * from "./units";
export * from "./validate";
