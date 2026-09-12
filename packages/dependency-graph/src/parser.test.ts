import { describe, it, expect } from 'vitest';
import path from 'path';
import { fileURLToPath } from 'url';
import { extractImports, extractRawSpecifiers } from './parser.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

describe('AST-based import parser', () => {
  const fixtureProjectRoot = path.join(__dirname, '__fixtures__/sample-project');
  const entryFilePath = path.join(fixtureProjectRoot, 'src/entry.ts');

  it('should extract raw specifiers from source code using TypeScript AST', () => {
    const raw = extractRawSpecifiers(
      `
      import { a } from "./rel";
      import { b } from "@alias/pkg";
      const dyn = import("./dyn");
      const req = require("./req");
      `,
      'dummy.ts'
    );

    expect(raw).toContain('./rel');
    expect(raw).toContain('@alias/pkg');
    expect(raw).toContain('./dyn');
    expect(raw).toContain('./req');
  });

  it('should resolve relative, path-alias, and dynamic imports to real file paths', () => {
    const imports = extractImports(entryFilePath, fixtureProjectRoot);

    const expectedRelative = path.join(fixtureProjectRoot, 'src/relative-target.ts');
    const expectedAlias = path.join(fixtureProjectRoot, 'src/aliased/alias-target.ts');
    const expectedDynamic = path.join(fixtureProjectRoot, 'src/dynamic-target.ts');

    expect(imports).toContain(expectedRelative);
    expect(imports).toContain(expectedAlias);
    expect(imports).toContain(expectedDynamic);
    expect(imports).toHaveLength(3);
  });

  it('should throw an error when target file does not exist', () => {
    expect(() => {
      extractImports(path.join(fixtureProjectRoot, 'src/non-existent.ts'), fixtureProjectRoot);
    }).toThrow(/File not found/);
  });
});
