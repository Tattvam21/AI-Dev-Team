export interface DocSearchResult {
  title: string;
  url: string;
  snippet: string;
  source: 'npm' | 'docs' | 'web';
}

export interface DocSearchQueryOptions {
  query: string;
  targetPackage?: string;
  limit?: number;
}

/**
 * DocSearchClient
 * 
 * Provides agents with real-time documentation retrieval for npm packages,
 * runtime APIs (Node.js, TypeScript), and technical error references.
 */
export class DocSearchClient {
  /**
   * Searches package metadata and documentation references.
   */
  public async search(options: DocSearchQueryOptions): Promise<DocSearchResult[]> {
    const results: DocSearchResult[] = [];
    const limit = options.limit || 5;

    // 1. If targetPackage is specified, query npm registry registry.npmjs.org
    if (options.targetPackage) {
      try {
        const pkgRes = await fetch(`https://registry.npmjs.org/${encodeURIComponent(options.targetPackage)}`);
        if (pkgRes.ok) {
          const pkgData: any = await pkgRes.json();
          const latestVer = pkgData['dist-tags']?.latest;
          const verData = latestVer ? pkgData.versions?.[latestVer] : null;

          results.push({
            title: `${options.targetPackage} (v${latestVer || 'latest'})`,
            url: pkgData.homepage || `https://www.npmjs.com/package/${options.targetPackage}`,
            snippet: pkgData.description || 'Package repository and documentation',
            source: 'npm'
          });

          if (verData?.repository?.url) {
            results.push({
              title: `${options.targetPackage} Repository`,
              url: verData.repository.url.replace(/^git\+/, ''),
              snippet: `Source repository for ${options.targetPackage}`,
              source: 'docs'
            });
          }
        }
      } catch {
        // Fallback gracefully
      }
    }

    // 2. Query DuckDuckGo Lite API / HTML for general tech search queries
    try {
      const ddgUrl = `https://api.duckduckgo.com/?q=${encodeURIComponent(options.query)}&format=json&no_html=1&skip_disambig=1`;
      const res = await fetch(ddgUrl);
      if (res.ok) {
        const data: any = await res.json();
        if (data.AbstractText) {
          results.push({
            title: data.Heading || options.query,
            url: data.AbstractURL || 'https://duckduckgo.com',
            snippet: data.AbstractText,
            source: 'web'
          });
        }

        if (Array.isArray(data.RelatedTopics)) {
          for (const topic of data.RelatedTopics.slice(0, limit - results.length)) {
            if (topic.Text && topic.FirstURL) {
              results.push({
                title: topic.Text.split(' - ')[0] || options.query,
                url: topic.FirstURL,
                snippet: topic.Text,
                source: 'web'
              });
            }
          }
        }
      }
    } catch {
      // Fallback
    }

    // If external network is restricted, provide fallback technical reference
    if (results.length === 0) {
      results.push({
        title: `Documentation Reference for "${options.query}"`,
        url: `https://developer.mozilla.org/search?q=${encodeURIComponent(options.query)}`,
        snippet: `Reference information for ${options.query}. Check official platform specifications.`,
        source: 'docs'
      });
    }

    return results.slice(0, limit);
  }
}
