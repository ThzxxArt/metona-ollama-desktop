/**
 * Context Indexer — 渐进式披露模块
 * Harness Engineering: 三级上下文管理
 *
 * 索引层 (Index)   — 始终保留：项目结构树 + 入口文件地图 + 技术栈摘要
 * 接口层 (Interface) — 按需加载：模块 API 声明 + 类型定义 + 配置文件
 * 实现层 (Implementation) — 修改时加载：具体源代码
 *
 * 设计理念：
 * - 用目录式索引告诉智能体"去哪找"，而非"全记住"
 * - 上下文可从数万 Token 压至几千
 * - 通过 load_context 工具按需触发接口层和实现层的加载
 */

import { logInfo, logDebug, logWarn } from './log-service.js';
import { estimateTokens } from './context-manager.js';
import type { ProjectIndex, ContextTier } from '../types.js';

// ═══════════════════════════════════════════════════════════════
// 项目索引缓存
// ═══════════════════════════════════════════════════════════════

/** 项目索引缓存（5 分钟 TTL） */
let cachedIndex: ProjectIndex | null = null;
let cacheTimestamp = 0;
const INDEX_CACHE_TTL = 5 * 60 * 1000; // 5 分钟

/** 最大索引 Token 预算 */
const MAX_INDEX_TOKENS = 2000;

/**
 * 构建项目索引
 * 扫描工作空间目录结构，生成精简的结构摘要
 */
export async function buildProjectIndex(workspaceDir: string): Promise<ProjectIndex> {
  // 检查缓存
  if (cachedIndex && Date.now() - cacheTimestamp < INDEX_CACHE_TTL) {
    return cachedIndex;
  }

  try {
    const bridge = window.metonaDesktop;
    if (!bridge?.isDesktop) {
      return createEmptyIndex();
    }

    // 利用现有 tree 工具扫描目录结构（限制深度 3 层）
    const treeResult = await bridge.tool.execute('tree', {
      path: workspaceDir,
      max_depth: 3,
      include_hidden: false,
    });

    let structure = '';
    if (treeResult.success && treeResult.tree) {
      structure = String(treeResult.tree);
      // Token 预算截断
      if (estimateTokens(structure) > MAX_INDEX_TOKENS) {
        const lines = structure.split('\n');
        structure = lines.slice(0, Math.min(lines.length, 60)).join('\n')
          + '\n... (目录结构已截断，使用 list_directory 查看完整内容)';
      }
    } else {
      structure = '(无法读取工作空间目录结构)';
    }

    // 识别入口文件
    const entryFiles: string[] = [];
    const commonEntries = [
      'package.json', 'tsconfig.json', 'vite.config.ts',
      'main.ts', 'index.ts', 'index.html', 'app.ts',
      'Cargo.toml', 'pyproject.toml', 'go.mod', 'CMakeLists.txt',
      'README.md', 'Makefile', 'docker-compose.yml',
    ];
    for (const entry of commonEntries) {
      try {
        // 跨平台路径拼接（清理尾部斜杠，统一用 posix 风格，Node.js 可容错处理）
        const cleanDir = workspaceDir.replace(/[\\/]+$/, '');
        const filePath = cleanDir + '/' + entry;
        const checkResult = await bridge.workspace.readFile(filePath);
        if (checkResult?.success) {
          entryFiles.push(entry);
        }
      } catch { /* ignore */ }
    }

    // 检测技术栈
    const techStack = detectTechStack(entryFiles);

    const index: ProjectIndex = {
      structure,
      entryFiles,
      techStack,
      tokenCount: estimateTokens(structure),
      generatedAt: Date.now(),
    };

    cachedIndex = index;
    cacheTimestamp = Date.now();
    logInfo('项目索引已构建', `${techStack.join(', ')}, ${entryFiles.length} 入口文件, ${index.tokenCount} tokens`);
    return index;
  } catch (err) {
    logWarn('项目索引构建失败', (err as Error).message);
    return createEmptyIndex();
  }
}

/** 创建空索引 */
function createEmptyIndex(): ProjectIndex {
  return {
    structure: '(未检测到工作空间)',
    entryFiles: [],
    techStack: [],
    tokenCount: 0,
    generatedAt: Date.now(),
  };
}

/** 根据入口文件检测技术栈 */
function detectTechStack(entryFiles: string[]): string[] {
  const stack: string[] = [];
  const fileSet = new Set(entryFiles.map(f => f.toLowerCase()));

  if (fileSet.has('package.json')) stack.push('Node.js');
  if (fileSet.has('tsconfig.json')) stack.push('TypeScript');
  if (fileSet.has('vite.config.ts')) stack.push('Vite');
  if (fileSet.has('cargo.toml')) stack.push('Rust');
  if (fileSet.has('pyproject.toml')) stack.push('Python');
  if (fileSet.has('go.mod')) stack.push('Go');
  if (fileSet.has('cmakelists.txt')) stack.push('C/C++');
  if (fileSet.has('docker-compose.yml')) stack.push('Docker');
  if (fileSet.has('makefile')) stack.push('Make');

  return stack.length > 0 ? stack : ['未知'];
}

/**
 * 生成索引层系统提示词
 * 始终保留在上下文中，告诉 AI "去哪找"
 */
export function buildIndexContext(index: ProjectIndex): string {
  if (!index.structure || index.tokenCount === 0) return '';

  let context = `【项目索引 — 始终可见】
项目结构：
${index.structure}

技术栈: ${index.techStack.join(', ') || '未检测'}
入口文件: ${index.entryFiles.length > 0 ? index.entryFiles.join(', ') : '未检测'}

💡 使用 list_directory 查看目录详情，使用 read_file 读取具体文件。
💡 使用 search_files 按内容搜索代码。
`;

  // Token 预算控制
  if (estimateTokens(context) > MAX_INDEX_TOKENS) {
    context = context.slice(0, Math.floor(context.length * 0.8)) + '\n... (索引已截断)';
  }

  return context;
}

/**
 * 构建接口层上下文（按需加载）
 * @param modulePattern 模块匹配模式，如 "src/services/"
 */
export async function buildInterfaceContext(modulePattern: string, workspaceDir: string): Promise<string> {
  try {
    const bridge = window.metonaDesktop;
    if (!bridge?.isDesktop) return '';

    // 搜索模块相关的类型定义和配置文件
    const searchResult = await bridge.tool.execute('search_files', {
      path: workspaceDir,
      query: modulePattern,
      search_type: 'filename',
      max_results: 10,
    });

    if (!searchResult.success || !(searchResult as any).results?.length) {
      return `(未找到与 "${modulePattern}" 相关的接口文件)`;
    }

    const results = (searchResult as any).results as Array<{ path: string }>;
    const paths = results.map(r => r.path).slice(0, 8);

    // 批量读取接口文件（限制每文件 2000 字符）
    const readResult = await bridge.tool.execute('read_multiple_files', {
      paths,
      max_chars_per_file: 2000,
    });

    if (readResult.success) {
      const filesInfo = paths.map(p => `  📄 ${p}`).join('\n');
      return `【接口层 — ${modulePattern}】
相关文件：
${filesInfo}

内容预览：
${JSON.stringify((readResult as any).files)}`;
    }

    return `【接口层 — ${modulePattern}】
相关文件：${paths.join(', ')}`;
  } catch (err) {
    logWarn('接口层上下文加载失败', (err as Error).message);
    return '';
  }
}

/**
 * 加载指定层级的上下文
 */
export async function loadContextByTier(
  tier: ContextTier,
  modulePattern: string,
  workspaceDir: string,
): Promise<string> {
  switch (tier) {
    case 'index': {
      const index = await buildProjectIndex(workspaceDir);
      return buildIndexContext(index);
    }
    case 'interface':
      return buildInterfaceContext(modulePattern, workspaceDir);
    case 'implementation':
      // 实现层由 Agent 自行通过 read_file 加载
      return '';
  }
}
