import fs from 'fs';
import path from 'path';

export interface DiagramNode {
  id: string;
  label: string;
  type?: 'service' | 'database' | 'agent' | 'team' | 'storage' | 'external';
  description?: string;
}

export interface DiagramEdge {
  from: string;
  to: string;
  label?: string;
  style?: 'solid' | 'dashed';
}

export interface DiagramSpecification {
  title: string;
  description?: string;
  nodes: DiagramNode[];
  edges: DiagramEdge[];
}

/**
 * DiagramGenerator
 * 
 * Generates editorial-style standalone SVG / HTML and Mermaid architecture diagrams
 * that are version-controllable and can be embedded in documentation.
 */
export class DiagramGenerator {
  private outputDir: string;

  constructor(projectRoot: string) {
    this.outputDir = path.join(path.resolve(projectRoot), 'docs', 'architecture');
  }

  public ensureOutputDir(): void {
    if (!fs.existsSync(this.outputDir)) {
      fs.mkdirSync(this.outputDir, { recursive: true });
    }
  }

  /**
   * Generates a standard Mermaid markdown flowchart.
   */
  public generateMermaid(spec: DiagramSpecification): string {
    const lines: string[] = ['flowchart TD'];

    for (const node of spec.nodes) {
      const shape = node.type === 'database' ? `[(${node.label})]` :
                    node.type === 'agent' ? `[/"${node.label}"/]` :
                    node.type === 'team' ? `{{${node.label}}}` :
                    `["${node.label}"]`;
      lines.push(`  ${node.id}${shape}`);
    }

    for (const edge of spec.edges) {
      const arrow = edge.style === 'dashed' ? '-.->' : '-->';
      const label = edge.label ? `|${edge.label}|` : '';
      lines.push(`  ${edge.from} ${arrow}${label} ${edge.to}`);
    }

    return lines.join('\n');
  }

  /**
   * Generates a clean, standalone SVG diagram.
   */
  public generateSvg(spec: DiagramSpecification): string {
    const nodeWidth = 180;
    const nodeHeight = 60;
    const paddingX = 40;
    const paddingY = 80;
    const cols = Math.min(3, Math.max(1, spec.nodes.length));
    const rows = Math.ceil(spec.nodes.length / cols);
    const svgWidth = cols * (nodeWidth + paddingX) + paddingX;
    const svgHeight = rows * (nodeHeight + paddingY) + 120;

    const nodePositions = new Map<string, { x: number; y: number }>();
    spec.nodes.forEach((node, i) => {
      const col = i % cols;
      const row = Math.floor(i / cols);
      const x = paddingX + col * (nodeWidth + paddingX);
      const y = 80 + row * (nodeHeight + paddingY);
      nodePositions.set(node.id, { x, y });
    });

    let svg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${svgWidth} ${svgHeight}" width="${svgWidth}" height="${svgHeight}" style="background-color:#0f172a;font-family:system-ui,-apple-system,sans-serif;">\n`;
    
    // Title
    svg += `  <text x="${paddingX}" y="40" fill="#f8fafc" font-size="20" font-weight="bold">${spec.title}</text>\n`;
    if (spec.description) {
      svg += `  <text x="${paddingX}" y="60" fill="#94a3b8" font-size="13">${spec.description}</text>\n`;
    }

    // Edges
    for (const edge of spec.edges) {
      const fromPos = nodePositions.get(edge.from);
      const toPos = nodePositions.get(edge.to);
      if (fromPos && toPos) {
        const x1 = fromPos.x + nodeWidth / 2;
        const y1 = fromPos.y + nodeHeight;
        const x2 = toPos.x + nodeWidth / 2;
        const y2 = toPos.y;
        svg += `  <line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="#64748b" stroke-width="2" ${edge.style === 'dashed' ? 'stroke-dasharray="5,5"' : ''} />\n`;
        if (edge.label) {
          const midX = (x1 + x2) / 2;
          const midY = (y1 + y2) / 2;
          svg += `  <text x="${midX}" y="${midY - 5}" fill="#38bdf8" font-size="11" text-anchor="middle">${edge.label}</text>\n`;
        }
      }
    }

    // Nodes
    for (const node of spec.nodes) {
      const pos = nodePositions.get(node.id)!;
      const fillColor = node.type === 'agent' ? '#1e293b' :
                        node.type === 'database' ? '#1e3a5f' :
                        node.type === 'team' ? '#2e1065' : '#1e293b';
      const strokeColor = node.type === 'agent' ? '#38bdf8' :
                          node.type === 'database' ? '#0284c7' :
                          node.type === 'team' ? '#c084fc' : '#475569';

      svg += `  <g transform="translate(${pos.x}, ${pos.y})">\n`;
      svg += `    <rect width="${nodeWidth}" height="${nodeHeight}" rx="8" fill="${fillColor}" stroke="${strokeColor}" stroke-width="1.5" />\n`;
      svg += `    <text x="${nodeWidth / 2}" y="${nodeHeight / 2 + 5}" fill="#f1f5f9" font-size="14" font-weight="600" text-anchor="middle">${node.label}</text>\n`;
      svg += `  </g>\n`;
    }

    svg += `</svg>`;
    return svg;
  }

  /**
   * Saves both Mermaid (.mmd) and SVG (.svg) representations to disk.
   */
  public async saveDiagram(fileName: string, spec: DiagramSpecification): Promise<{ mermaidPath: string; svgPath: string }> {
    this.ensureOutputDir();
    const baseName = fileName.replace(/\.[^/.]+$/, '');
    const mmdPath = path.join(this.outputDir, `${baseName}.mmd`);
    const svgPath = path.join(this.outputDir, `${baseName}.svg`);

    const mmdContent = this.generateMermaid(spec);
    const svgContent = this.generateSvg(spec);

    await fs.promises.writeFile(mmdPath, mmdContent, 'utf-8');
    await fs.promises.writeFile(svgPath, svgContent, 'utf-8');

    return {
      mermaidPath: mmdPath,
      svgPath: svgPath
    };
  }
}
