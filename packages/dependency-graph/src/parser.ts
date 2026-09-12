import fs from 'fs';
import path from 'path';
import ts from 'typescript';

export interface ExtractImportsOptions {
  includeExternal?: boolean;
}

/**
 * Loads compiler options from tsconfig.json or jsconfig.json in projectRoot if available.
 */
export function loadCompilerOptions(projectRoot: string): ts.CompilerOptions {
  const tsconfigPath =
    ts.findConfigFile(projectRoot, ts.sys.fileExists, 'tsconfig.json') ??
    ts.findConfigFile(projectRoot, ts.sys.fileExists, 'jsconfig.json');

  if (tsconfigPath) {
    const configFile = ts.readConfigFile(tsconfigPath, ts.sys.readFile);
    if (!configFile.error) {
      const parsedConfig = ts.parseJsonConfigFileContent(
        configFile.config,
        ts.sys,
        path.dirname(tsconfigPath)
      );
      return parsedConfig.options;
    }
  }

  return {
    moduleResolution: ts.ModuleResolutionKind.NodeNext,
    target: ts.ScriptTarget.ES2022,
    allowJs: true,
    baseUrl: projectRoot
  };
}

/**
 * Extracts raw import/require/export specifiers from a source file using TypeScript AST.
 */
export function extractRawSpecifiers(sourceText: string, filePath: string): string[] {
  const sourceFile = ts.createSourceFile(filePath, sourceText, ts.ScriptTarget.Latest, true);
  const specifiers: Set<string> = new Set();

  function visit(node: ts.Node) {
    // 1. import ... from 'specifier' or export ... from 'specifier'
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) {
      if (node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
        specifiers.add(node.moduleSpecifier.text);
      }
    }
    // 2. import x = require('specifier')
    else if (ts.isImportEqualsDeclaration(node)) {
      if (
        ts.isExternalModuleReference(node.moduleReference) &&
        node.moduleReference.expression &&
        ts.isStringLiteral(node.moduleReference.expression)
      ) {
        specifiers.add(node.moduleReference.expression.text);
      }
    }
    // 3. require('specifier') or import('specifier')
    else if (ts.isCallExpression(node)) {
      const isDynamicImport = node.expression.kind === ts.SyntaxKind.ImportKeyword;
      const isRequire = ts.isIdentifier(node.expression) && node.expression.text === 'require';

      if (
        (isDynamicImport || isRequire) &&
        node.arguments.length > 0 &&
        ts.isStringLiteral(node.arguments[0])
      ) {
        specifiers.add(node.arguments[0].text);
      }
    }

    ts.forEachChild(node, visit);
  }

  visit(sourceFile);
  return Array.from(specifiers);
}

/**
 * Resolves a single specifier to an absolute file path.
 */
export function resolveSpecifier(
  specifier: string,
  containingFile: string,
  projectRoot: string,
  compilerOptions: ts.CompilerOptions
): string | null {
  const normalizedContainingFile = path.resolve(containingFile);
  const resolution = ts.resolveModuleName(
    specifier,
    normalizedContainingFile,
    compilerOptions,
    ts.sys
  );

  if (resolution.resolvedModule) {
    const resolvedPath = path.resolve(resolution.resolvedModule.resolvedFileName);
    // Ignore external node_modules packages unless within projectRoot source
    if (resolution.resolvedModule.isExternalLibraryImport && !resolvedPath.startsWith(projectRoot)) {
      return null;
    }
    return resolvedPath;
  }

  // Fallback for relative imports if resolution did not catch
  if (specifier.startsWith('.')) {
    const dir = path.dirname(normalizedContainingFile);
    const candidateBase = path.resolve(dir, specifier);
    const extensions = [
      '',
      '.ts',
      '.tsx',
      '.js',
      '.jsx',
      '/index.ts',
      '/index.js',
      '/index.tsx',
      '/index.jsx'
    ];
    for (const ext of extensions) {
      const cand = candidateBase + ext;
      if (fs.existsSync(cand) && fs.statSync(cand).isFile()) {
        return path.resolve(cand);
      }
    }
  }

  return null;
}

/**
 * Extracts and resolves imported module paths for a given JS/TS file.
 */
export function extractImports(
  filePath: string,
  projectRoot: string,
  _options: ExtractImportsOptions = {}
): string[] {
  const absoluteFilePath = path.resolve(filePath);
  const absoluteProjectRoot = path.resolve(projectRoot);

  if (!fs.existsSync(absoluteFilePath)) {
    throw new Error(`File not found: ${absoluteFilePath}`);
  }

  const sourceText = fs.readFileSync(absoluteFilePath, 'utf-8');
  const compilerOptions = loadCompilerOptions(absoluteProjectRoot);
  const rawSpecifiers = extractRawSpecifiers(sourceText, absoluteFilePath);

  const resolvedPaths = new Set<string>();

  for (const specifier of rawSpecifiers) {
    const resolved = resolveSpecifier(
      specifier,
      absoluteFilePath,
      absoluteProjectRoot,
      compilerOptions
    );
    if (resolved) {
      resolvedPaths.add(resolved);
    }
  }

  return Array.from(resolvedPaths);
}
