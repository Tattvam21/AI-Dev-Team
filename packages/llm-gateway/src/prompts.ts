import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export type PromptRole = 'scanner' | 'triage' | 'fixer' | 'reviewer' | 'test-writer' | string;

export interface LoadedPromptResult {
  content: string;
  version: string;
  role: string;
  filePath: string;
}

/**
 * Finds the base prompts directory by looking up from current file or cwd.
 */
export function findPromptsBaseDir(customDir?: string): string {
  if (customDir && fs.existsSync(customDir)) {
    return customDir;
  }
  if (process.env.PROMPTS_DIR && fs.existsSync(process.env.PROMPTS_DIR)) {
    return process.env.PROMPTS_DIR;
  }

  // Check from cwd
  const fromCwd = path.resolve(process.cwd(), 'prompts');
  if (fs.existsSync(fromCwd)) {
    return fromCwd;
  }

  // Check from __dirname / import.meta.url
  try {
    const currentDir = path.dirname(fileURLToPath(import.meta.url));
    const candidates = [
      path.resolve(currentDir, '../../prompts'),
      path.resolve(currentDir, '../../../prompts'),
      path.resolve(currentDir, '../prompts')
    ];
    for (const cand of candidates) {
      if (fs.existsSync(cand)) {
        return cand;
      }
    }
  } catch {
    // ignore
  }

  return fromCwd;
}

/**
 * Resolves the concrete prompt file version (e.g. 'latest' -> 'v1').
 */
export function resolvePromptVersion(
  role: PromptRole,
  version: string = 'latest',
  customPromptsDir?: string
): { resolvedVersion: string; filePath: string } {
  const baseDir = findPromptsBaseDir(customPromptsDir);
  const roleDir = path.join(baseDir, role);

  if (!fs.existsSync(roleDir)) {
    throw new Error(`Prompt directory not found for role '${role}' at ${roleDir}`);
  }

  const files = fs.readdirSync(roleDir).filter((f) => f.endsWith('.md'));
  if (files.length === 0) {
    throw new Error(`No markdown prompt files found for role '${role}' in ${roleDir}`);
  }

  if (version !== 'latest') {
    const targetFile = version.endsWith('.md') ? version : `${version}.md`;
    const fullPath = path.join(roleDir, targetFile);
    if (!fs.existsSync(fullPath)) {
      throw new Error(`Prompt file '${targetFile}' not found for role '${role}' at ${fullPath}`);
    }
    const cleanVersion = targetFile.replace(/\.md$/, '');
    return { resolvedVersion: cleanVersion, filePath: fullPath };
  }

  // Find latest by parsing v<number>
  const versioned = files
    .map((file) => {
      const match = file.match(/^v(\d+)\.md$/i);
      return {
        file,
        versionNum: match ? parseInt(match[1], 10) : -1,
        versionStr: file.replace(/\.md$/, '')
      };
    })
    .sort((a, b) => b.versionNum - a.versionNum);

  const selected = versioned[0];
  return {
    resolvedVersion: selected.versionStr,
    filePath: path.join(roleDir, selected.file)
  };
}

/**
 * Substitutes {{variable}} occurrences in the template.
 */
export function substituteVariables(template: string, variables: Record<string, any> = {}): string {
  return template.replace(/{{\s*([\w.-]+)\s*}}/g, (match, key) => {
    if (key in variables) {
      const val = variables[key];
      return typeof val === 'object' && val !== null ? JSON.stringify(val, null, 2) : String(val);
    }
    return match;
  });
}

/**
 * Loads a prompt for a given role and version, substituting variables, and returns full details.
 */
export function loadPromptWithVersion(
  role: PromptRole,
  version: string = 'latest',
  variables: Record<string, any> = {},
  customPromptsDir?: string
): LoadedPromptResult {
  const { resolvedVersion, filePath } = resolvePromptVersion(role, version, customPromptsDir);
  const rawTemplate = fs.readFileSync(filePath, 'utf-8');
  const content = substituteVariables(rawTemplate, variables);

  return {
    content,
    version: resolvedVersion,
    role,
    filePath
  };
}

/**
 * Standard prompt loader: reads the prompt file and performs {{variable}} substitution.
 */
export function loadPrompt(
  role: PromptRole,
  version: string = 'latest',
  variables: Record<string, any> = {},
  customPromptsDir?: string
): string {
  return loadPromptWithVersion(role, version, variables, customPromptsDir).content;
}
