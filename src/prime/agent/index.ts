/**
 * Public surface of the ported prime-agent agent loop.
 * Mirrors packages/agent/src/index.ts, minus the proxy module (excluded
 * daemon transport; see PORT.md).
 */

// Core Agent
export * from "./agent";
// Loop functions
export * from "./agent-loop";
// Types
export * from "./types";
