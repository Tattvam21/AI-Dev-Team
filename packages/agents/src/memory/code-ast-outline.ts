/**
 * Structural Code AST Outline Extractor
 * 
 * Extracts high-level structural signatures (imports, exports, class declarations,
 * function signatures, interfaces, and type definitions) without loading full method
 * bodies into prompt context. This reduces token consumption during recall.
 */

export interface CodeOutline {
  filePath: string;
  imports: string[];
  exports: string[];
  classes: Array<{ name: string; methods: string[] }>;
  functions: string[];
  typesAndInterfaces: string[];
  totalLines: number;
}

export function extractCodeOutline(filePath: string, sourceCode: string): CodeOutline {
  const lines = sourceCode.split('\n');
  const imports: string[] = [];
  const exports: string[] = [];
  const classes: Array<{ name: string; methods: string[] }> = [];
  const functions: string[] = [];
  const typesAndInterfaces: string[] = [];

  let currentClass: { name: string; methods: string[] } | null = null;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    // 1. Imports
    if (line.startsWith('import ') || line.startsWith('import{') || line.startsWith('const ') && line.includes('require(')) {
      imports.push(line);
      continue;
    }

    // 2. Types & Interfaces
    const interfaceMatch = line.match(/^(export\s+)?interface\s+([A-Za-z0-9_]+)/);
    if (interfaceMatch) {
      typesAndInterfaces.push(`interface ${interfaceMatch[2]}`);
    }
    const typeMatch = line.match(/^(export\s+)?type\s+([A-Za-z0-9_]+)/);
    if (typeMatch) {
      typesAndInterfaces.push(`type ${typeMatch[2]}`);
    }

    // 3. Classes
    const classMatch = line.match(/^(export\s+)?(abstract\s+)?class\s+([A-Za-z0-9_]+)/);
    if (classMatch) {
      currentClass = { name: classMatch[3], methods: [] };
      classes.push(currentClass);
    }

    // 4. Methods within Class
    if (currentClass) {
      const methodMatch = line.match(/^(public|private|protected|async|static)?\s*(async\s+)?([A-Za-z0-9_]+)\s*\(([^)]*)\)(:\s*[^;{]+)?/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[3])) {
        currentClass.methods.push(`${methodMatch[3]}(${methodMatch[4] || ''})`);
      }
      if (line.startsWith('}')) {
        currentClass = null;
      }
    }

    // 5. Standalone Functions
    const funcMatch = line.match(/^(export\s+)?(async\s+)?function\s+([A-Za-z0-9_]+)\s*\(([^)]*)\)(:\s*[^;{]+)?/);
    if (funcMatch) {
      functions.push(`${funcMatch[3]}(${funcMatch[4] || ''})`);
    }

    // Arrow function exports
    const arrowFuncMatch = line.match(/^(export\s+)?const\s+([A-Za-z0-9_]+)\s*=\s*(async\s*)?\(([^)]*)\)(:\s*[^=>]+)?\s*=>/);
    if (arrowFuncMatch) {
      functions.push(`${arrowFuncMatch[2]}(${arrowFuncMatch[4] || ''})`);
    }

    // 6. Generic Exports
    if (line.startsWith('export ') && !line.startsWith('export default') && !funcMatch && !classMatch && !interfaceMatch && !typeMatch) {
      exports.push(line.replace(/;$/, ''));
    }
  }

  return {
    filePath,
    imports,
    exports,
    classes,
    functions,
    typesAndInterfaces,
    totalLines: lines.length
  };
}

export function formatOutlineAsMarkdown(outline: CodeOutline): string {
  const sections: string[] = [
    `#### Outline: ${outline.filePath} (${outline.totalLines} lines)`
  ];

  if (outline.typesAndInterfaces.length > 0) {
    sections.push(`**Types & Interfaces:**\n${outline.typesAndInterfaces.map(t => `- \`${t}\``).join('\n')}`);
  }

  if (outline.classes.length > 0) {
    const classDescs = outline.classes.map(c => {
      const methods = c.methods.length > 0 ? `\n  - Methods: ${c.methods.map(m => `\`${m}\``).join(', ')}` : '';
      return `- Class \`${c.name}\`${methods}`;
    });
    sections.push(`**Classes:**\n${classDescs.join('\n')}`);
  }

  if (outline.functions.length > 0) {
    sections.push(`**Functions:**\n${outline.functions.map(f => `- \`${f}\``).join('\n')}`);
  }

  return sections.join('\n\n');
}
