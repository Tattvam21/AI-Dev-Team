import fs from 'fs';
import path from 'path';

export interface SecurityFinding {
  type: 'secret' | 'vulnerability' | 'unsafe_pattern';
  severity: 'low' | 'medium' | 'high' | 'critical';
  file: string;
  line: number;
  description: string;
  matchedPattern: string;
  recommendation: string;
}

export interface SecurityScanReport {
  passed: boolean;
  totalFindings: number;
  criticalCount: number;
  highCount: number;
  mediumCount: number;
  lowCount: number;
  findings: SecurityFinding[];
  scannedFilesCount: number;
}

/**
 * Secret patterns (API keys, Private Keys, Cloud Credentials, JWTs)
 */
const SECRET_RULES = [
  {
    name: 'AWS Access Key ID',
    regex: /(?:A3T[A-Z0-9]|AKIA|AGPA|AIDA|AROA|AIPA|ANPA|ANVA|ASIA)[A-Z0-9]{16}/,
    severity: 'critical' as const,
    recommendation: 'Use environment variables (e.g. process.env.AWS_ACCESS_KEY_ID) instead of hardcoded keys.'
  },
  {
    name: 'Generic API Key / Secret Token',
    regex: /(?:api[_-]?key|secret[_-]?key|auth[_-]?token|bearer\s+[a-zA-Z0-9_\-\.]{20,})\s*[:=]\s*['"`][a-zA-Z0-9_\-\.]{16,}['"`]/i,
    severity: 'high' as const,
    recommendation: 'Store API keys in .env and load securely at runtime.'
  },
  {
    name: 'RSA / OpenSSH Private Key Header',
    regex: /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    severity: 'critical' as const,
    recommendation: 'Never commit private keys to repositories. Use a secret manager.'
  },
  {
    name: 'GitHub Personal Access Token',
    regex: /gh[pousr]_[A-Za-z0-9_]{36,}/,
    severity: 'critical' as const,
    recommendation: 'Revoke and rotate exposed GitHub tokens immediately.'
  }
];

/**
 * Unsafe Code Patterns (Code injection, command injection, path traversal)
 */
const VULNERABILITY_RULES = [
  {
    name: 'Unsafe eval() or Function Constructor',
    regex: /(?:\beval\s*\(|\bnew\s+Function\s*\()/,
    severity: 'high' as const,
    recommendation: 'Avoid dynamic eval(); parse structured JSON or use strict state-machines.'
  },
  {
    name: 'Potential Command Injection (child_process with concatenation)',
    regex: /(?:exec|execSync)\s*\(\s*`[^`]*\${.+}[^`]*`/,
    severity: 'high' as const,
    recommendation: 'Use execFile or spawn with explicitly separated arguments instead of shell string templates.'
  },
  {
    name: 'Potential SQL Injection (raw query concatenation)',
    regex: /(?:\.query|\.execute)\s*\(\s*['"`].*(?:SELECT|INSERT|UPDATE|DELETE).*\$\{.+}/i,
    severity: 'high' as const,
    recommendation: 'Use parameterized queries or ORM bindings (e.g. Prisma) instead of template strings.'
  },
  {
    name: 'Path Traversal Risk (unvalidated path.join with req/user input)',
    regex: /path\.(?:join|resolve)\s*\([^)]*(?:req\.(?:query|body|params)|userInput)/,
    severity: 'medium' as const,
    recommendation: 'Sanitize user paths with path.normalize() and verify they remain within the expected base directory.'
  }
];

/**
 * Scans files for secrets and common security vulnerability patterns.
 */
export async function runSecurityScan(targetDir: string, filesToScan: string[] = []): Promise<SecurityScanReport> {
  const resolvedDir = path.resolve(targetDir);
  const findings: SecurityFinding[] = [];
  let scannedFilesCount = 0;

  const files = filesToScan.length > 0 ? filesToScan : getScannableFiles(resolvedDir);

  for (const relativePath of files) {
    const fullPath = path.isAbsolute(relativePath) ? relativePath : path.join(resolvedDir, relativePath);
    if (!fs.existsSync(fullPath) || fs.statSync(fullPath).isDirectory()) continue;

    scannedFilesCount++;
    let content = '';
    try {
      content = await fs.promises.readFile(fullPath, 'utf-8');
    } catch {
      continue;
    }

    const lines = content.split('\n');
    for (let lineIndex = 0; lineIndex < lines.length; lineIndex++) {
      const line = lines[lineIndex];

      // Check Secret Patterns
      for (const rule of SECRET_RULES) {
        if (rule.regex.test(line)) {
          findings.push({
            type: 'secret',
            severity: rule.severity,
            file: relativePath,
            line: lineIndex + 1,
            description: `Exposed ${rule.name}`,
            matchedPattern: rule.name,
            recommendation: rule.recommendation
          });
        }
      }

      // Check Vulnerability Patterns
      for (const rule of VULNERABILITY_RULES) {
        if (rule.regex.test(line)) {
          findings.push({
            type: 'vulnerability',
            severity: rule.severity,
            file: relativePath,
            line: lineIndex + 1,
            description: `Potential vulnerability: ${rule.name}`,
            matchedPattern: rule.name,
            recommendation: rule.recommendation
          });
        }
      }
    }
  }

  const criticalCount = findings.filter(f => f.severity === 'critical').length;
  const highCount = findings.filter(f => f.severity === 'high').length;
  const mediumCount = findings.filter(f => f.severity === 'medium').length;
  const lowCount = findings.filter(f => f.severity === 'low').length;

  return {
    passed: criticalCount === 0 && highCount === 0,
    totalFindings: findings.length,
    criticalCount,
    highCount,
    mediumCount,
    lowCount,
    findings,
    scannedFilesCount
  };
}

function getScannableFiles(dir: string, baseDir: string = dir): string[] {
  const result: string[] = [];
  const entries = fs.readdirSync(dir, { withFileTypes: true });

  for (const entry of entries) {
    if (entry.name === 'node_modules' || entry.name === '.git' || entry.name === 'dist' || entry.name === '.aidev') {
      continue;
    }
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      result.push(...getScannableFiles(fullPath, baseDir));
    } else if (/\.(ts|js|mjs|tsx|jsx|json|yaml|yml|env)$/.test(entry.name)) {
      result.push(path.relative(baseDir, fullPath).replace(/\\/g, '/'));
    }
  }

  return result;
}
