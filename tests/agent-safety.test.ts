import { describe, it, expect, beforeEach } from 'vitest';
import {
  classifyError,
  calculateBackoff,
  validatePathSandbox,
  checkCommandSafety,
  smartTruncateByToolType,
  addResultMetadata,
  estimateResultTokens,
  recordErrorPattern,
  compactOldToolResult,
  getErrorRecoverySuggestions,
  formatErrorRecovery,
  resetAllSafetyState,
  storeToolResult,
} from '../src/renderer/services/agent-safety.js';

describe('classifyError', () => {
  it('分类瞬态错误为可重试', () => {
    const r = classifyError('Network timeout after 30s');
    expect(r.class).toBe('transient');
    expect(r.shouldRetry).toBe(true);
    expect(r.maxRetries).toBeGreaterThan(0);
  });

  it('分类连接重置为瞬态', () => {
    expect(classifyError('ECONNRESET').class).toBe('transient');
    expect(classifyError('ETIMEDOUT').class).toBe('transient');
    expect(classifyError('连接失败').class).toBe('transient');
  });

  it('分类永久错误为不可重试', () => {
    const r = classifyError('ENOENT: no such file or directory');
    expect(r.class).toBe('permanent');
    expect(r.shouldRetry).toBe(false);
    expect(r.maxRetries).toBe(0);
  });

  it('分类权限拒绝为永久', () => {
    expect(classifyError('EACCES: permission denied').class).toBe('permanent');
  });

  it('分类安全错误为不可重试', () => {
    const r = classifyError('安全警告: 检测到注入');
    expect(r.class).toBe('security');
    expect(r.shouldRetry).toBe(false);
  });

  it('分类未知错误允许一次重试', () => {
    const r = classifyError('some unusual failure');
    expect(r.class).toBe('unknown');
    expect(r.shouldRetry).toBe(true);
    expect(r.maxRetries).toBe(1);
  });
});

describe('calculateBackoff', () => {
  it('指数退避递增且上限 10s', () => {
    expect(calculateBackoff(0, 1000)).toBe(1000);
    expect(calculateBackoff(1, 1000)).toBe(2000);
    expect(calculateBackoff(2, 1000)).toBe(4000);
    expect(calculateBackoff(5, 1000)).toBe(10000); // 封顶
  });
});

describe('validatePathSandbox', () => {
  const ws = 'C:/Users/tester/workspace';

  it('工作空间内路径放行', () => {
    const r = validatePathSandbox('C:/Users/tester/workspace/src/file.ts', ws);
    expect(r.valid).toBe(true);
  });

  it('空路径拒绝', () => {
    expect(validatePathSandbox('', ws).valid).toBe(false);
  });

  it('绝对路径越界拒绝', () => {
    const r = validatePathSandbox('C:/Users/tester/other/file.ts', ws);
    expect(r.valid).toBe(false);
    expect(r.reason).toContain('工作空间');
  });

  it('路径遍历超出工作空间拒绝', () => {
    const r = validatePathSandbox('C:/Users/tester/workspace/../../etc/passwd', ws);
    // 相对部分深于工作空间根应拒绝
    expect(r.valid).toBe(false);
  });

  it('无工作空间时放行', () => {
    expect(validatePathSandbox('/any/path', '').valid).toBe(true);
  });

  it('大小写不敏感匹配 Windows 工作空间', () => {
    const r = validatePathSandbox('c:/users/tester/workspace/x.txt', ws);
    expect(r.valid).toBe(true);
  });
});

describe('checkCommandSafety', () => {
  it('判定禁止命令', () => {
    const r = checkCommandSafety('rm -rf /');
    expect(r.safe).toBe(false);
    expect(r.riskLevel).toBe('forbidden');
  });

  it('判定 fork 炸弹', () => {
    const r = checkCommandSafety(':(){ :|:& };:');
    expect(r.riskLevel).toBe('forbidden');
  });

  it('判定关机命令', () => {
    expect(checkCommandSafety('shutdown -h now').riskLevel).toBe('forbidden');
  });

  it('判定高风险命令为 medium/high 但非 forbidden', () => {
    const r = checkCommandSafety('git push --force');
    expect(r.riskLevel).toBe('medium');
    expect(r.safe).toBe(true); // medium 允许但需确认
  });

  it('普通命令安全', () => {
    const r = checkCommandSafety('ls -la');
    expect(r.safe).toBe(true);
    expect(r.riskLevel).toBe('none');
  });
});

describe('smartTruncateByToolType', () => {
  const content = 'x'.repeat(1000);

  it('不超限时原样返回', () => {
    expect(smartTruncateByToolType('read_file', 'short', 5000)).toBe('short');
  });

  it('按头部策略截断（search_files）并标记省略量', () => {
    const out = smartTruncateByToolType('search_files', content, 300);
    expect(out.length).toBeLessThan(1000);
    expect(out).toContain('R95截断');
    expect(out.startsWith('xxx')).toBe(true);
  });

  it('按尾部策略截断（git）', () => {
    const out = smartTruncateByToolType('git', content, 300);
    expect(out.endsWith('xxx')).toBe(true);
    expect(out).toContain('R95截断');
  });

  it('默认 both 策略保留头尾', () => {
    const out = smartTruncateByToolType('_default', content, 400);
    expect(out.startsWith('xxx')).toBe(true);
    expect(out.endsWith('xxx')).toBe(true);
  });
});

describe('estimateResultTokens / addResultMetadata', () => {
  it('估算中文与英文字符 token', () => {
    expect(estimateResultTokens('你好')).toBeGreaterThan(0);
    expect(estimateResultTokens('hello world')).toBeGreaterThan(0);
    expect(estimateResultTokens('')).toBe(0);
  });

  it('大结果追加元数据标记', () => {
    const big = '字'.repeat(1200);
    const out = addResultMetadata(big);
    expect(out).toContain('[元数据: ~');
  });

  it('小结果不追加元数据', () => {
    expect(addResultMetadata('short')).toBe('short');
  });
});

describe('recordErrorPattern', () => {
  beforeEach(() => resetAllSafetyState());

  it('首次出现不返回建议', () => {
    expect(recordErrorPattern('read_file', 'ENOENT: no such file')).toBeUndefined();
  });

  it('同一错误出现 2 次返回建议', () => {
    recordErrorPattern('read_file', 'ENOENT: no such file');
    const hint = recordErrorPattern('read_file', 'ENOENT: no such file');
    expect(hint).toContain('错误模式提示');
  });
});

describe('compactOldToolResult', () => {
  it('短结果原样返回', () => {
    const msg = { role: 'tool' as const, content: 'short', tool_name: 'read_file' };
    expect(compactOldToolResult(msg).content).toBe('short');
  });

  it('超长结果归档为引用', () => {
    const msg = { role: 'tool' as const, content: 'x'.repeat(2000), tool_name: 'read_file' };
    const out = compactOldToolResult(msg);
    expect(out.content).toContain('[工具结果已归档');
    expect(out.content).toContain('ref=');
  });

  it('已归档结果不重复处理', () => {
    const msg = { role: 'tool' as const, content: '[工具结果已归档 ref=xxx]', tool_name: 'read_file' };
    expect(compactOldToolResult(msg).content).toBe(msg.content);
  });
});

describe('storeToolResult / 归档引用', () => {
  beforeEach(() => resetAllSafetyState());

  it('生成唯一引用 id 并可通过归档消息识别', () => {
    const id = storeToolResult('web_fetch', 'full content here');
    expect(id).toMatch(/^toolref_/);
  });
});

describe('getErrorRecoverySuggestions / formatErrorRecovery', () => {
  it('文件未找到给出检查路径建议', () => {
    const s = getErrorRecoverySuggestions('read_file', 'ENOENT: no such file');
    expect(s.suggestions.length).toBeGreaterThan(0);
  });

  it('格式化包含错误与建议条目', () => {
    const s = getErrorRecoverySuggestions('run_command', 'command not found');
    const formatted = formatErrorRecovery(s);
    expect(formatted).toContain('错误恢复建议');
    expect(formatted).toContain('run_command');
    expect(formatted).toContain('which/where');
  });

  it('无匹配规则时提供通用建议', () => {
    const s = getErrorRecoverySuggestions('unknown_tool', 'weird error');
    expect(s.suggestions.length).toBeGreaterThan(0);
  });
});
