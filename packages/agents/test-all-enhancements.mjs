import fs from 'fs';
import path from 'path';
import os from 'os';
import { MemoryAgent } from './src/memory-agent.ts';
import { extractCodeOutline } from './src/memory/code-ast-outline.ts';
import { runSecurityScan } from './src/security/security-scanner.ts';
import { DiagramGenerator } from './src/visual/diagram-generator.ts';
import { DocSearchClient } from './src/tools/doc-search-client.ts';
import { UniversalToolProtocolAdapter } from './src/tools/tool-protocol-adapter.ts';
import { SkillRegistry } from './src/teams/skill-registry.ts';
import { ManagerAgent } from './src/teams/manager-agent.ts';
import { IssueResolverPipeline } from './src/workflows/issue-resolver-pipeline.ts';
import { TelemetryVisualizer } from './src/workflows/telemetry-visualizer.ts';

function assert(condition, message) {
  if (!condition) {
    console.error(`❌ ASSERTION FAILED: ${message}`);
    process.exit(1);
  }
  console.log(`  ✔ ${message}`);
}

async function runTests() {
  console.log('====================================================');
  console.log('🧪 RUNNING AI DEV TEAM ENHANCEMENTS VERIFICATION SUITE');
  console.log('====================================================\n');

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'aidev-verify-suite-'));

  try {
    // Test 1: Code AST Outline
    console.log('Test 1: Structural Code AST Outline Extraction');
    const sampleCode = `
      import fs from 'fs';
      export interface UserProfile { id: string; name: string; }
      export class UserService {
        public async getUser(id: string): Promise<UserProfile> { return { id, name: 'Alice' }; }
      }
      export function validateId(id: string): boolean { return id.length > 0; }
    `;
    const outline = extractCodeOutline('src/user.ts', sampleCode);
    assert(outline.typesAndInterfaces.includes('interface UserProfile'), 'Extracts TypeScript interface');
    assert(outline.classes[0].name === 'UserService', 'Extracts class definition');
    assert(outline.classes[0].methods.some(m => m.includes('getUser')), 'Extracts class methods');
    assert(outline.functions.some(f => f.includes('validateId')), 'Extracts standalone functions');

    // Test 2: Tiered Memory & Salience Filter
    console.log('\nTest 2: Tiered Memory & Salience Filter');
    const memory = new MemoryAgent(tempDir);
    memory.ensureInitialized();
    const noiseRes = await memory.recordEpisode({ ticketId: 't-0', targetFile: 'x.ts', title: 'no', verdict: 'pass' });
    assert(noiseRes.recorded === false, 'Salience filter rejects low-signal noise');

    const validRes = await memory.recordEpisode({
      ticketId: 't-1',
      targetFile: 'src/user.ts',
      title: 'Fix authentication failure with expired tokens',
      verdict: 'fail',
      reviewerNotes: 'Failed backward compatibility tests'
    });
    assert(validRes.recorded === true, 'High-signal episode recorded');

    const recallL2 = await memory.recall('src/user.ts');
    assert(recallL2.episodes.length === 1, 'L2 episodic stream retrieved');
    assert(recallL2.tierUsed === 'L2', 'Tier identified as L2');

    const recallL0 = await memory.recall('src/user.ts');
    assert(recallL0.tierUsed === 'L0', 'Subsequent recall hits L0 cache');

    // Test 3: Security & Secrets Scanner
    console.log('\nTest 3: Security & Secrets Scanner');
    const secretFile = path.join(tempDir, 'secret_leak.ts');
    fs.writeFileSync(secretFile, 'const key = "AKIAIOSFODNN7EXAMPLE"; eval("console.log(key)");', 'utf-8');
    const secReport = await runSecurityScan(tempDir, ['secret_leak.ts']);
    assert(secReport.passed === false, 'Security scanner catches leaked key and eval');
    assert(secReport.criticalCount >= 1, 'Flags critical AWS key');
    assert(secReport.highCount >= 1, 'Flags high-severity eval');

    // Test 4: Diagram Generator
    console.log('\nTest 4: Architecture Diagram Generator (SVG & Mermaid)');
    const diagramGen = new DiagramGenerator(tempDir);
    const diagramFiles = await diagramGen.saveDiagram('test_arch', {
      title: 'Test Architecture',
      nodes: [
        { id: 'mgr', label: 'Manager Agent', type: 'agent' },
        { id: 'team', label: 'Production Team', type: 'team' }
      ],
      edges: [{ from: 'mgr', to: 'team', label: 'delegates' }]
    });
    assert(fs.existsSync(diagramFiles.mermaidPath), 'Mermaid .mmd file generated');
    assert(fs.existsSync(diagramFiles.svgPath), 'SVG .svg file generated');

    // Test 5: Universal Tool Protocol Adapter
    console.log('\nTest 5: Universal Tool Protocol Adapter');
    const adapter = new UniversalToolProtocolAdapter();
    adapter.registerTool({
      name: 'ping_service',
      description: 'Pings a service',
      inputSchema: { type: 'object', properties: { host: { type: 'string' } } },
      handler: async (params) => ({ status: 'pong', host: params.host })
    });
    const toolExec = await adapter.executeTool('ping_service', { host: 'localhost' });
    assert(toolExec.status === 'pong', 'Standard tool executes successfully via adapter');

    // Test 6: Skill Registry with all 16 skills & Risk Scoring
    console.log('\nTest 6: Skill Registry (16 Skills & Risk Ratings)');
    const registry = new SkillRegistry();
    const prodSkills = registry.getAvailableSkills('production');
    const debugSkills = registry.getAvailableSkills('debugging');
    const deploySkills = registry.getAvailableSkills('deployment');
    assert(prodSkills.some(s => s.name === 'diagram_gen'), 'diagram_gen available to production');
    assert(debugSkills.some(s => s.name === 'security_scan'), 'security_scan available to debugging');
    assert(prodSkills.some(s => s.name === 'universal_tool_adapter'), 'universal_tool_adapter available');
    assert(registry.get('deploy_api')?.riskLevel === 'high', 'deploy_api scored as high risk');
    assert(registry.get('memory_recall')?.riskLevel === 'low', 'memory_recall scored as low risk');

    // Test 7: Manager Agent Two-Loop Supervisor
    console.log('\nTest 7: Manager Agent Two-Loop Supervisor');
    const manager = new ManagerAgent({ projectRoot: tempDir, skillRegistry: registry });
    const riskEval = manager.evaluateTaskRisk({
      taskId: 'task-deploy-1',
      assignedTeam: 'deployment',
      taskType: 'deploy',
      expectedOutput: 'Deploy production release to live cluster',
      context: {},
      status: 'pending'
    });
    assert(riskEval.level === 'high', 'Deployment task evaluated as high risk');
    assert(riskEval.requiresApproval === true, 'High risk triggers supervisor gate');

    // Test 8: End-to-End Autonomous Issue Resolver Pipeline
    console.log('\nTest 8: Autonomous Issue Resolver Pipeline & Telemetry');
    const pipeline = new IssueResolverPipeline({ projectRoot: tempDir, managerAgent: manager });
    const srcDir = path.join(tempDir, 'src');
    fs.mkdirSync(srcDir, { recursive: true });
    fs.writeFileSync(path.join(srcDir, 'math.ts'), 'export function add(a: number, b: number) { return a + b; }', 'utf-8');

    const issueRes = await pipeline.resolveIssue({
      issueId: '42',
      title: 'Fix issue in math utility',
      body: 'Review and verify math utility',
      targetFile: 'src/math.ts',
      labels: ['bugfix']
    });
    assert(issueRes.issueId === '42', 'Pipeline completes resolution cycle');
    assert(issueRes.stages.triage.outlineExtracted === true, 'Outline extracted during triage');
    assert(issueRes.stages.securityCheck.passed === true, 'Security verification passed');
    assert(issueRes.telemetry.nodes.length >= 3, 'Execution telemetry recorded all graph stages');

    console.log('\n====================================================');
    console.log('🎉 ALL 8 VERIFICATION SUITES PASSED CLEANLY!');
    console.log('====================================================\n');
  } finally {
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch {}
  }
}

runTests().catch(err => {
  console.error('Fatal error during test run:', err);
  process.exit(1);
});
