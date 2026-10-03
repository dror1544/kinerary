// Type declarations for child-env.js, so control-plane/api's TypeScript
// build (rootDir: src, no allowJs) can resolve named-export types for this
// plain-CommonJS module without pulling it into tsc's program as a source
// file to compile. Runtime still loads child-env.js — this file has no
// emit and no presence at runtime; keep it in sync with child-env.js by
// hand (there is no autogeneration for a CJS module's .d.ts here).

export declare const STRUCTURING_BASE_ENV: readonly string[];

export declare function structuringChildEnv(
  extra?: readonly string[],
  source?: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export declare function hermesChildEnv(source?: NodeJS.ProcessEnv): NodeJS.ProcessEnv;
