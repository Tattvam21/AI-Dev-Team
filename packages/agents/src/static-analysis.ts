import fs from 'fs';
import path from 'path';
import { ESLint } from 'eslint';

export interface LintFinding {
  file: string;
  line: number;
  message: string;
  ruleId: string | null;
  severity: 'error' | 'warning';
  column?: number;
}

export interface StaticAnalysisOptions {
  cwd?: string;
  overrideConfigFile?: string;
  overrideConfig?: Record<string, any>;
  warnOnMissingConfig?: boolean;
}

/**
 * Checks if an ESLint configuration file exists in the directory or parents.
 */
export function hasEslintConfig(dir: string): boolean {
  const configNames = [
    'eslint.config.js',
    'eslint.config.mjs',
    'eslint.config.cjs',
    'eslint.config.ts',
    '.eslintrc.js',
    '.eslintrc.cjs',
    '.eslintrc.yaml',
    '.eslintrc.yml',
    '.eslintrc.json',
    '.eslintrc'
  ];

  let current = path.resolve(dir);
  while (true) {
    for (const name of configNames) {
      if (fs.existsSync(path.join(current, name))) {
        return true;
      }
    }
    // Also check package.json for "eslintConfig"
    const pkgPath = path.join(current, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        if (pkg.eslintConfig) {
          return true;
        }
      } catch {
        // ignore parse error
      }
    }

    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }

  return false;
}

/**
 * Runs ESLint programmatically against a given list of files and normalizes findings.
 */
export async function runStaticAnalysis(
  files: string[],
  options: StaticAnalysisOptions = {}
): Promise<LintFinding[]> {
  if (!files || files.length === 0) {
    return [];
  }

  const cwd = path.resolve(options.cwd ?? process.cwd());
  const warnOnMissingConfig = options.warnOnMissingConfig ?? true;

  // Check if target project has an ESLint configuration
  const configExists = options.overrideConfigFile || options.overrideConfig || hasEslintConfig(cwd);

  if (!configExists) {
    if (warnOnMissingConfig) {
      console.warn(
        `[StaticAnalysis] Warning: No ESLint configuration found in '${cwd}'. Returning empty findings without crashing.`
      );
    }
    return [];
  }

  try {
    const eslint = new ESLint({
      cwd,
      overrideConfigFile: options.overrideConfigFile,
      overrideConfig: options.overrideConfig as any
    });

    const results = await eslint.lintFiles(files);
    const findings: LintFinding[] = [];

    for (const result of results) {
      for (const msg of result.messages) {
        findings.push({
          file: result.filePath,
          line: msg.line || 1,
          message: msg.message,
          ruleId: msg.ruleId,
          severity: msg.severity === 2 ? 'error' : 'warning',
          column: msg.column
        });
      }
    }

    return findings;
  } catch (error: any) {
    const errorMsg = error?.message || String(error);

    // Gracefully handle missing config errors from ESLint internals
    if (
      errorMsg.includes('Could not find config file') ||
      errorMsg.includes('No ESLint configuration found') ||
      error.code === 'ERR_CONFIG_NOT_FOUND'
    ) {
      if (warnOnMissingConfig) {
        console.warn(
          `[StaticAnalysis] Warning: ESLint config not found in '${cwd}' (${errorMsg}). Returning empty findings.`
        );
      }
      return [];
    }

    throw error;
  }
}
