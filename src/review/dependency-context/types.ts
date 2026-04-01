export type FrontendPackageManager = 'npm' | 'pnpm' | 'unknown';

export interface FrontendDependencyVersion {
  name: string;
  declaredVersion?: string;
  resolvedVersion?: string;
}

export interface FrontendDependencySnapshot {
  packageRoot: string;
  packageManager: FrontendPackageManager;
  appliesToFiles: string[];
  dependencies: FrontendDependencyVersion[];
}

export interface FrontendDependencyContext {
  snapshots: FrontendDependencySnapshot[];
}
