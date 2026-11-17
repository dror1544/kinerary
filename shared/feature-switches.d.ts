// Type declarations for feature-switches.js, so control-plane/api's TypeScript
// build (rootDir: src, no allowJs) can resolve the registry's types without
// compiling it. Same arrangement as child-env.d.ts; keep in sync by hand.

export type FeatureSurface = "relay" | "site" | "companion" | "control_plane";

export interface FeatureSwitchEntry {
  readonly name: string;
  readonly summary: string;
  readonly surfaces: readonly FeatureSurface[];
  readonly memberVisible: boolean;
}

export declare const NAME_PATTERN: RegExp;
export declare const SURFACES: readonly FeatureSurface[];
export declare const FEATURE_SWITCHES: readonly FeatureSwitchEntry[];
export declare function findSwitch(name: unknown): FeatureSwitchEntry | null;
export declare function isRegisteredSwitch(name: unknown): boolean;
