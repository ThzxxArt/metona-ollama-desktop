/**
 * Tool Registry - 工具注册与调度中心
 * 管理所有可用工具的定义，负责执行调度
 */

import type { ToolDefinition, ToolResult } from '../types.js';
import { state, KEYS } from '../state/state.js';
import { logToolStart, logToolResult, logError, logInfo, logWarn } from './log-service.js';
import { getMCPToolDefinitions } from './mcp-client.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read a file from the local filesystem. Supports text mode (utf-8/latin1, line-based pagination) and binary mode (base64, byte-based pagination). Files up to 5MB (text) or 50MB (binary). When truncated, returns remaining_lines/remaining_bytes and a hint to continue reading. Use start_line/end_line for text files, offset_bytes/limit_bytes for binary files or raw byte access.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'The file path to read. Absolute or relative to workspace.' },
          encoding: { type: 'string', enum: ['utf-8', 'latin1', 'base64'], description: 'File encoding. Default: utf-8. Use base64 for binary content.' },
          start_line: { type: 'integer', description: 'Start line (1-indexed) for text files. Use with end_line for pagination.' },
          end_line: { type: 'integer', description: 'End line (inclusive). Default: start_line + 2000.' },
          mode: { type: 'string', enum: ['text', 'binary'], description: 'Read mode. text = decode as string, binary = return base64. Default: text.' },
          offset_bytes: { type: 'integer', description: 'Byte offset to start reading from (0-indexed). Use for binary files or large text.' },
          limit_bytes: { type: 'integer', description: 'Max bytes to read. Default: 50000 (text) or 102400 (binary).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description: 'Write content to a local file. Creates parent directories automatically. Supports text (utf-8/latin1) and binary (base64) modes. Use mode="append" to add to existing file instead of overwriting. Max 10MB (overwrite) or 5MB (append). Returns file stats including overwrite info.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: { type: 'string', description: 'The file path to write to. Absolute or relative to workspace.' },
          content: { type: 'string', description: 'The content to write. For binary files, pass base64-encoded string with encoding="base64".' },
          encoding: { type: 'string', enum: ['utf-8', 'latin1', 'base64'], description: 'File encoding. Use "base64" to write binary content (images, PDFs, etc). Default: utf-8.' },
          mode: { type: 'string', enum: ['overwrite', 'append'], description: 'Write mode. overwrite = replace file, append = add to end. Default: overwrite.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description: 'List directory contents up to 2000 entries. Returns names, types, sizes, modification times. Supports offset pagination, recursion, and extension filtering.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          recursive: { type: 'boolean', description: 'List recursively. Default: false.' },
          max_depth: { type: 'integer', description: 'Max recursion depth. Default: 3.' },
          include_hidden: { type: 'boolean', description: 'Include hidden files. Default: false.' },
          offset: { type: 'integer', description: 'Skip first N entries for pagination. Default: 0.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description: 'Search files by name pattern or text content within files. Supports regular expressions with use_regex=true.',
      parameters: {
        type: 'object',
        required: ['path', 'query'],
        properties: {
          path: { type: 'string', description: 'Root directory to search.' },
          query: { type: 'string', description: 'Search query (glob, text, or regex).' },
          search_type: { type: 'string', enum: ['filename', 'content', 'both'], description: 'Search target. Default: both.' },
          case_sensitive: { type: 'boolean', description: 'Case sensitive. Default: false.' },
          max_results: { type: 'integer', description: 'Max results. Default: 50.' },
          file_extensions: { type: 'array', items: { type: 'string' }, description: 'Filter extensions, e.g. [".ts", ".js"]' },
          use_regex: { type: 'boolean', description: 'Treat query as regular expression. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'create_directory',
      description: 'Create a new directory. Creates parents automatically.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path to create.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description: 'Delete a file or directory. Returns deleted item count and total size. Use recursive=true for non-empty directories.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Path to delete.' },
          recursive: { type: 'boolean', description: 'Recursive delete for directories. Returns filesDeleted count and total deletedSize.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description: 'Execute a shell command via workspace. No timeout limit — runs until the process exits. Requires user confirmation. Output is streamed in real-time through the workspace process.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to workspace directory.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'move_file',
      description: 'Move or rename a file/directory. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['source', 'destination'],
        properties: {
          source: { type: 'string', description: 'Source path.' },
          destination: { type: 'string', description: 'Destination path.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'copy_file',
      description: 'Copy a file or directory to a new location. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['source', 'destination'],
        properties: {
          source: { type: 'string', description: 'Source path.' },
          destination: { type: 'string', description: 'Destination path.' },
          recursive: { type: 'boolean', description: 'Copy directories recursively. Default: true.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description: 'Fetch and extract full text content from a URL. Typically used after web_search: pick the most relevant result URLs from search and call web_fetch on each to get detailed content before answering. Automatically retries on failure (up to 2 times with exponential backoff). Auto-upgrades to browser rendering for JavaScript-heavy pages.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'URL to fetch (http/https).' },
          max_chars: { type: 'integer', description: 'Max characters to return. Default: 0 (no limit, return full content).' },
          extract_mode: { type: 'string', enum: ['text', 'markdown'], description: 'Extraction mode. Default: text.' },
          mobile_ua: { type: 'boolean', description: 'Use mobile User-Agent. Some sites return simpler content for mobile. Default: false.' },
          retry: { type: 'boolean', description: 'Enable auto-retry on failure (5xx/network errors, up to 2 times). Default: true.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description: 'Find and replace text in a file. Supports literal string matching and regex (use_regex=true). Use all=true to replace all occurrences. More efficient than write_file for small edits.',
      parameters: {
        type: 'object',
        required: ['path', 'old_text', 'new_text'],
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          old_text: { type: 'string', description: 'Text to find. Can be a regex pattern when use_regex=true.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          all: { type: 'boolean', description: 'Replace all occurrences. Default: false.' },
          use_regex: { type: 'boolean', description: 'Treat old_text as a regular expression. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_file_info',
      description: 'Get detailed file or directory information: size, dates, permissions, type.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'File or directory path.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'tree',
      description: 'Display directory structure as a tree. Shows nested files and folders. Default depth: 5 levels.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Root directory path.' },
          max_depth: { type: 'integer', description: 'Max depth. Default: 3.' },
          include_hidden: { type: 'boolean', description: 'Include hidden files. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'download_file',
      description: 'Download a file from a URL to a local path. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['url', 'destination'],
        properties: {
          url: { type: 'string', description: 'URL to download (http/https).' },
          destination: { type: 'string', description: 'Local path to save the file.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'diff_files',
      description: 'Compare two files and show differences. Returns a unified diff.',
      parameters: {
        type: 'object',
        required: ['file1', 'file2'],
        properties: {
          file1: { type: 'string', description: 'First file path.' },
          file2: { type: 'string', description: 'Second file path.' },
          context_lines: { type: 'integer', description: 'Context lines around changes. Default: 3.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'replace_in_files',
      description: 'Find and replace text across multiple files matching a glob pattern. Requires user confirmation.',
      parameters: {
        type: 'object',
        required: ['path', 'glob', 'old_text', 'new_text'],
        properties: {
          path: { type: 'string', description: 'Root directory.' },
          glob: { type: 'string', description: 'File pattern, e.g. "*.ts", "**/*.js".' },
          old_text: { type: 'string', description: 'Text to find.' },
          new_text: { type: 'string', description: 'Replacement text.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'read_multiple_files',
      description: 'Read up to 50 files at once in parallel. Returns content of all requested files (10KB each by default).',
      parameters: {
        type: 'object',
        required: ['paths'],
        properties: {
          paths: { type: 'array', items: { type: 'string' }, description: 'Array of file paths to read.' },
          max_chars_per_file: { type: 'integer', description: 'Max chars per file. Default: 2000.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'git',
      description: 'Git operations: status, log, diff, add, commit, push, pull, branch, checkout, merge, stash, remote, clone, init. All operations are automatic (no confirmation).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['status', 'log', 'diff', 'add', 'commit', 'push', 'pull', 'branch', 'checkout', 'merge', 'stash', 'remote', 'clone', 'init', 'reset', 'tag'], description: 'Git action to perform.' },
          path: { type: 'string', description: 'Repository path. Defaults to workspace.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files for add/diff/checkout.' },
          message: { type: 'string', description: 'Commit message for commit action.' },
          branch: { type: 'string', description: 'Branch name for branch/checkout/merge.' },
          remote: { type: 'string', description: 'Remote name for push/pull/remote.' },
          remote_url: { type: 'string', description: 'Remote URL for remote add.' },
          count: { type: 'integer', description: 'Number of log entries. Default: 20.' },
          all: { type: 'boolean', description: 'Show all (branches, stashes, etc). Default: false.' },
          staged: { type: 'boolean', description: 'Show staged changes in diff. Default: false.' },
          new_branch: { type: 'boolean', description: 'Create new branch in branch action. Default: false.' },
          delete_branch: { type: 'boolean', description: 'Delete branch in branch action. Default: false.' },
          force: { type: 'boolean', description: 'Force push/checkout. Default: false.' },
          url: { type: 'string', description: 'Repository URL for clone.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'compress',
      description: 'Create or extract archives (zip/tar.gz). Requires user confirmation for create.',
      parameters: {
        type: 'object',
        required: ['action', 'path'],
        properties: {
          action: { type: 'string', enum: ['create', 'extract'], description: 'Create or extract archive.' },
          path: { type: 'string', description: 'Source path (create) or archive path (extract).' },
          destination: { type: 'string', description: 'Output archive path (create) or extract dir (extract).' },
          format: { type: 'string', enum: ['zip', 'tar.gz'], description: 'Archive format. Default: tar.gz.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description: 'Search the web and optionally auto-fetch full page content. Set fetch_top to automatically fetch complete content from the top N results — this saves you the extra step of calling web_fetch yourself. Use fetch_top=3 for most cases. Returns snippets + full fetched content. Supports time range filtering.',
      parameters: {
        type: 'object',
        required: ['query', 'fetch_top'],
        properties: {
          query: { type: 'string', description: 'The search query. Be specific and concise for best results.' },
          max_results: { type: 'integer', description: 'Maximum number of results to return. Default: 30, max: 30.' },
          time_range: { type: 'string', enum: ['day', 'week', 'month', 'year'], description: 'Filter results by time. Supported by Bing and Google. Use for recent news, latest version, etc.' },
          enhance_snippets: { type: 'boolean', description: 'Auto-fetch detailed snippet for results with too-short descriptions. Default: true.' },
          fetch_top: { type: 'integer', description: 'Number of top results to auto-fetch full content for. Min: 3, max: 10. Results shorter than this are useless — snippets lack detail.' }
        }
      }
    }
  },
  // ══════════════════════════════════════════════
  // v4.0 新增工具：记忆和会话管理
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'memory_search',
      description: 'Search agent memories by semantic similarity or keywords. Returns relevant memories about the user, preferences, rules, and past conversations.',
      parameters: {
        type: 'object',
        required: ['query'],
        properties: {
          query: { type: 'string', description: 'Search query for memories.' },
          limit: { type: 'integer', description: 'Max results to return. Default: 8.' },
          type: { type: 'string', enum: ['fact', 'preference', 'rule'], description: 'Filter by memory type.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_add',
      description: 'Add a new memory entry for future reference. Use when you learn something important about the user, their preferences, or rules they want you to follow.',
      parameters: {
        type: 'object',
        required: ['type', 'content'],
        properties: {
          type: { type: 'string', enum: ['fact', 'preference', 'rule'], description: 'Memory type: fact (about user), preference (user preference), rule (must follow).' },
          content: { type: 'string', description: 'The memory content. Be concise and specific.' },
          importance: { type: 'integer', description: 'Importance 1-10. Higher = more important. Default: 5.' },
          tags: { type: 'array', items: { type: 'string' }, description: 'Tags for search matching. 2-5 keywords.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_replace',
      description: 'Replace an existing memory entry with updated content. Uses substring matching to find the entry to replace.',
      parameters: {
        type: 'object',
        required: ['target', 'old_text', 'new_content'],
        properties: {
          target: { type: 'string', enum: ['memory', 'user'], description: 'Target store: memory (agent notes) or user (user profile).' },
          old_text: { type: 'string', description: 'Unique substring that identifies the entry to replace.' },
          new_content: { type: 'string', description: 'The new content to replace the old entry with.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'memory_remove',
      description: 'Remove a memory entry. Uses substring matching to find the entry to remove.',
      parameters: {
        type: 'object',
        required: ['target', 'old_text'],
        properties: {
          target: { type: 'string', enum: ['memory', 'user'], description: 'Target store: memory (agent notes) or user (user profile).' },
          old_text: { type: 'string', description: 'Unique substring that identifies the entry to remove.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'session_list',
      description: 'List previous chat sessions with their titles and timestamps. Useful for referencing past conversations.',
      parameters: {
        type: 'object',
        properties: {
          limit: { type: 'integer', description: 'Max sessions to return. Default: 20.' },
          search: { type: 'string', description: 'Filter sessions by title keyword.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'session_read',
      description: 'Read the messages from a previous chat session. Use when the user references something from a past conversation.',
      parameters: {
        type: 'object',
        required: ['session_id'],
        properties: {
          session_id: { type: 'string', description: 'The session ID to read.' },
          max_messages: { type: 'integer', description: 'Max messages to return. Default: 50.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_list',
      description: 'List all available auto-generated skills. Shows name, description, and success rate. Use skill_view to see full details of a specific skill.',
      parameters: {
        type: 'object',
        properties: {}
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'skill_view',
      description: 'View full details of a specific skill including its tool chain, parameter hints, and usage statistics.',
      parameters: {
        type: 'object',
        required: ['name'],
        properties: {
          name: { type: 'string', description: 'The skill name (or partial name) to view.' }
        }
      }
    }
  },
  // ══════════════════════════════════════════════
  // v4.3 新增工具：子代理委派
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'spawn_task',
      description: 'Spawn a sub-agent to independently execute a task using read-only tools (file reading, web search, browser viewing, memory/session/skill queries). Use this to parallelize independent research or analysis sub-tasks. For the model parameter, prefer smaller models (e.g. "qwen3:1.8b", "qwen3:4b") for simple lookups and the current model for complex analysis. Leave blank to use the default configured in Settings.',
      parameters: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', description: 'The task description for the sub-agent to execute.' },
          context: { type: 'string', description: 'Optional additional context or reference data for the sub-agent.' },
          model: { type: 'string', description: 'Optional model name. If the specified model is not installed, the default model will be used automatically. Best practice: only specify a model you know exists (e.g. "qwen3:1.8b"), or leave blank for the Settings default.' }
        }
      }
    }
  },
  // ══════════════════════════════════════════════
  // v5.0 新增工具：浏览器控制
  // ══════════════════════════════════════════════
  // v5.1 Browser 控制工具（增强版）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'browser_open',
      description: 'Open a URL in the agent browser. Waits for page load. Use wait_selector to wait for a specific element (useful for SPA pages). Returns page title and URL.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'The URL to open (http/https).' },
          wait_selector: { type: 'string', description: 'CSS selector to wait for after page load. Useful for SPA/dynamic pages. Default: none.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_screenshot',
      description: 'Take a screenshot of the current page. Supports viewport (default), full_page (entire scrollable page), or selector (specific element only). Returns base64 PNG.',
      parameters: {
        type: 'object',
        properties: {
          full_page: { type: 'boolean', description: 'Capture the entire scrollable page. Default: false.' },
          selector: { type: 'string', description: 'CSS selector of element to capture. Overrides full_page.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_evaluate',
      description: 'Execute JavaScript in the browser page. Returns the result as JSON string. Use to read DOM, extract data, or interact programmatically.',
      parameters: {
        type: 'object',
        required: ['js'],
        properties: {
          js: { type: 'string', description: 'JavaScript code to execute in the page context.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_extract',
      description: 'Extract text and links from the current page. Use selector to extract only from a specific element (e.g. "main", "#content", "article"). Without selector, extracts full page. Returns title, text, and up to 50 links.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to extract from. Default: entire body.' },
          max_chars: { type: 'integer', description: 'Max characters to return. Default: 15000.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_click',
      description: 'Click an element by CSS selector. Use wait=true to wait up to 10s for the element to appear first (useful after page navigation). Scrolls element into view before clicking.',
      parameters: {
        type: 'object',
        required: ['selector'],
        properties: {
          selector: { type: 'string', description: 'CSS selector for the element to click.' },
          wait: { type: 'boolean', description: 'Wait for element to appear before clicking (max 10s). Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_type',
      description: 'Type text into an input field. Use clear=false to append instead of replacing. Use submit=true to press Enter or submit the parent form after typing.',
      parameters: {
        type: 'object',
        required: ['selector', 'text'],
        properties: {
          selector: { type: 'string', description: 'CSS selector for the input element.' },
          text: { type: 'string', description: 'Text to type into the input.' },
          clear: { type: 'boolean', description: 'Clear existing text first. Default: true.' },
          submit: { type: 'boolean', description: 'Submit the form or press Enter after typing. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_scroll',
      description: 'Scroll the page. Use direction for up/down/top/bottom, or selector to scroll a specific element into view.',
      parameters: {
        type: 'object',
        properties: {
          direction: { type: 'string', enum: ['down', 'up', 'top', 'bottom'], description: 'Scroll direction. Default: down.' },
          selector: { type: 'string', description: 'CSS selector to scroll into view (overrides direction).' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_wait',
      description: 'Wait for a condition. Use selector to wait for an element to appear, or time_ms for a fixed delay. Default: 1 second.',
      parameters: {
        type: 'object',
        properties: {
          selector: { type: 'string', description: 'CSS selector to wait for. Returns found: true/false.' },
          time_ms: { type: 'integer', description: 'Fixed wait time in milliseconds. Default: 1000.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'browser_close',
      description: 'Close the agent browser and free resources.',
      parameters: { type: 'object', properties: {} }
    }
  },
  {
    type: 'function',
    function: {
      name: 'datetime',
      description: 'Get the precise current system time. Returns ISO timestamp, Unix time (seconds and milliseconds), locale-formatted date/time, timezone, and individual components (year/month/day/hour/minute/second/millisecond/day_of_week). Use format parameter to request specific output: "iso" / "unix" / "date" / "time" / "full" (default: full).',
      parameters: {
        type: 'object',
        properties: {
          format: { type: 'string', enum: ['full', 'iso', 'unix', 'date', 'time'], description: 'Output format. Default: full (all fields).' },
          timezone: { type: 'string', description: 'IANA timezone name (e.g., "Asia/Shanghai", "America/New_York"). Default: system timezone.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'calculator',
      description: 'Safely evaluate a mathematical expression. Supports + - * / ** % () and floating-point numbers. Uses a pure JS recursive descent parser — no eval(), CSP-safe. Returns the numeric result.',
      parameters: {
        type: 'object',
        required: ['expression'],
        properties: {
          expression: { type: 'string', description: 'The mathematical expression to evaluate (e.g., "(3 + 5) * 2 ** 3"). Max 500 characters.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'random',
      description: 'Generate random numbers or pick random items. Supports: int (integer range, default 0-100), float (decimal, default 0-1), pick (select from array of items), string (random alphanumeric, default length 8). Use count for multiple values.',
      parameters: {
        type: 'object',
        properties: {
          type: { type: 'string', enum: ['int', 'float', 'pick', 'string'], description: 'Random type. Default: int.' },
          min: { type: 'number', description: 'Minimum value (int/float). Default: 0.' },
          max: { type: 'number', description: 'Maximum value (int/float). Default: 100 (int) or 1 (float).' },
          count: { type: 'integer', description: 'Number of results. Max 100. Default: 1.' },
          items: { type: 'array', items: { type: 'string' }, description: 'Item pool for pick type.' },
          length: { type: 'integer', description: 'String length for string type. Max 256. Default: 8.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'uuid',
      description: 'Generate cryptographically random UUID v4 (e.g., "550e8400-e29b-41d4-a716-446655440000"). Uses Node.js crypto.randomUUID(). Supports batch generation up to 20.',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'integer', description: 'Number of UUIDs. Max 20. Default: 1.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'json_format',
      description: 'Format and validate a JSON string. Returns pretty-printed JSON with configurable indentation. Optionally sort object keys alphabetically. Also works as a JSON syntax validator — returns error details on invalid input.',
      parameters: {
        type: 'object',
        required: ['json'],
        properties: {
          json: { type: 'string', description: 'The JSON string to format/validate.' },
          indent: { type: 'integer', description: 'Indentation spaces. Default: 2.' },
          sort_keys: { type: 'boolean', description: 'Sort object keys alphabetically. Default: false.' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'hash',
      description: 'Compute cryptographic hash of text. Supports MD5, SHA-1, SHA-256, SHA-384, SHA-512. Default: SHA-256. Returns hex-encoded digest.',
      parameters: {
        type: 'object',
        required: ['text'],
        properties: {
          text: { type: 'string', description: 'The text to hash.' },
          algorithm: { type: 'string', enum: ['md5', 'sha1', 'sha256', 'sha384', 'sha512'], description: 'Hash algorithm. Default: sha256.' }
        }
      }
    }
  }
];

const CONFIRM_TOOLS = ['run_command'];

export function needsConfirmation(toolName: string): boolean {
  if (toolName === 'run_command') {
    // run_command 确认模式由 runCommandMode 状态控制
    const runCommandMode = (window as any).__runCommandMode || 'confirm';
    return runCommandMode === 'confirm';
  }
  return CONFIRM_TOOLS.includes(toolName);
}

/** 设置 run_command 执行模式 */
export function setRunCommandMode(mode: 'auto' | 'confirm' | 'disabled'): void {
  (window as any).__runCommandMode = mode;
  if (mode === 'disabled') {
    setToolEnabled('run_command', false);
  } else {
    setToolEnabled('run_command', true);
  }
}

let enabledTools: Set<string> = new Set([
  'read_file', 'list_directory', 'search_files',
  'write_file', 'create_directory', 'delete_file',
  'run_command',
  'move_file', 'copy_file', 'web_fetch', 'web_search', 'edit_file',
  'get_file_info', 'tree', 'download_file', 'diff_files', 'replace_in_files',
  'read_multiple_files', 'git', 'compress',
  'memory_search', 'memory_add', 'memory_replace', 'memory_remove',
  'session_list', 'session_read', 'skill_list', 'skill_view', 'spawn_task',
  'browser_open', 'browser_screenshot', 'browser_evaluate', 'browser_extract',
  'browser_click', 'browser_type', 'browser_scroll', 'browser_close',
  'datetime', 'calculator',
  'random', 'uuid', 'json_format', 'hash'
]);

export function setToolEnabled(toolName: string, enabled: boolean): void {
  if (enabled) enabledTools.add(toolName);
  else enabledTools.delete(toolName);
}


export function getEnabledToolDefinitions(): ToolDefinition[] {
  const builtIn = TOOL_DEFINITIONS.filter(def => enabledTools.has(def.function.name));
  return [...builtIn, ..._mcpToolCache];
}

/** MCP 工具缓存 */
let _mcpToolCache: ToolDefinition[] = [];

/** 刷新 MCP 工具缓存（在 MCP 服务器配置变更时调用） */
export async function refreshMCPTools(): Promise<void> {
  try {
    const rawTools = await getMCPToolDefinitions();
    // v5.1.2 Shadowing 防护：MCP 工具不能覆盖内置工具
    const builtInNames = new Set(TOOL_DEFINITIONS.map(d => d.function.name));
    const filtered = rawTools.filter(t => {
      if (builtInNames.has(t.function.name)) {
        logWarn(`MCP 工具 "${t.function.name}" 与内置工具重名，已跳过`);
        return false;
      }
      return true;
    });
    const skipped = rawTools.length - filtered.length;
    _mcpToolCache = filtered;
    if (filtered.length > 0) {
      logInfo(`MCP 工具已注册: ${filtered.length} 个${skipped > 0 ? `（${skipped} 个因重名被跳过）` : ''}`, filtered.map(t => t.function.name).join(', '));
    }
  } catch (err) {
    logError('MCP 工具刷新失败', (err as Error).message);
    _mcpToolCache = [];
  }
}

export async function executeTool(toolName: string, args: Record<string, unknown>): Promise<ToolResult> {
  // MCP 工具路由
  if (toolName.startsWith('mcp_')) {
    const { executeMCPTool } = await import('./mcp-client.js');
    return executeMCPTool(toolName, args);
  }

  if (!enabledTools.has(toolName)) {
    logError(`工具未启用: ${toolName}`);
    return { success: false, error: `工具 ${toolName} 未启用` };
  }

  const bridge = window.metonaDesktop;
  if (!bridge?.isDesktop) {
    logError(`工具调用仅支持桌面版: ${toolName}`);
    return { success: false, error: '工具调用仅支持桌面版' };
  }

  try {
    // 内存工具（不走 IPC，直接处理）
    if (toolName === 'memory_search') {
      const { searchMemories } = await import('./memory-manager.js');
      const query = args.query as string;
      const limit = (args.limit as number) || 8;
      const type = args.type as string | undefined;
      let results = searchMemories(query, limit);
      if (type) results = results.filter(r => r.type === type);
      logToolResult('memory_search', true, `${results.length} 条结果`);
      return { success: true, results, total: results.length };
    }
    if (toolName === 'memory_add') {
      const { addMemory } = await import('./memory-manager.js');
      const type = args.type as 'fact' | 'preference' | 'rule';
      const content = args.content as string;
      const importance = (args.importance as number) || 5;
      const tags = (args.tags as string[]) || [];
      if (!content || content.length < 2) {
        return { success: false, error: 'content 不能为空且至少 2 个字符' };
      }
      const entry = await addMemory({ type, content, importance, tags });
      logToolResult('memory_add', true, `${type}: ${content.slice(0, 50)}`);
      return { success: true, id: entry.id, type: entry.type, content: entry.content };
    }
    if (toolName === 'memory_replace') {
      const { replaceMemoryByContent } = await import('./memory-manager.js');
      const target = String(args.target || 'memory') as 'memory' | 'user';
      const oldText = String(args.old_text || '');
      const newContent = String(args.new_content || '');
      const result = await replaceMemoryByContent(target, oldText, newContent);
      logToolResult('memory_replace', result.success, result.message);
      return result;
    }
    if (toolName === 'memory_remove') {
      const { removeMemoryByContent } = await import('./memory-manager.js');
      const target = String(args.target || 'memory') as 'memory' | 'user';
      const oldText = String(args.old_text || '');
      const result = await removeMemoryByContent(target, oldText);
      logToolResult('memory_remove', result.success, result.message);
      return result;
    }
    if (toolName === 'session_list') {
      const bridge = window.metonaDesktop;
      if (!bridge?.db) return { success: false, error: '桌面 API 不可用' };
      const limit = (args.limit as number) || 20;
      const search = (args.search as string) || '';
      const sessions = await bridge.db.getAllSessions();
      let filtered = sessions.map((s: any) => ({
        id: s.id,
        title: s.title,
        model: s.model,
        messageCount: 0, // 从 SQLite 获取的原始行不含 messages
        createdAt: s.created_at,
        updatedAt: s.updated_at
      }));
      if (search) {
        filtered = filtered.filter((s: any) => s.title.toLowerCase().includes(search.toLowerCase()));
      }
      filtered.sort((a: any, b: any) => b.updatedAt - a.updatedAt);
      filtered = filtered.slice(0, limit);
      logToolResult('session_list', true, `${filtered.length} 个会话`);
      return { success: true, sessions: filtered, total: filtered.length };
    }
    if (toolName === 'session_read') {
      const bridge = window.metonaDesktop;
      if (!bridge?.db) return { success: false, error: '桌面 API 不可用' };
      const sessionId = args.session_id as string;
      const maxMessages = (args.max_messages as number) || 50;
      if (!sessionId) return { success: false, error: '缺少 session_id 参数' };
      const session = await bridge.db.getSession(sessionId);
      if (!session) return { success: false, error: `会话 ${sessionId} 不存在` };
      const messages = await bridge.db.getMessages(sessionId);
      const msgs = messages.slice(0, maxMessages).map((m: any) => ({
        role: m.role,
        content: m.content || '',
        timestamp: m.created_at
      }));
      logToolResult('session_read', true, `${msgs.length} 条消息`);
      return { success: true, session: { id: session.id, title: session.title, model: session.model }, messages: msgs, total: messages.length };
    }

    // v4.3 spawn_task 走子代理
    if (toolName === 'spawn_task') {
      const { executeSubAgent } = await import('./sub-agent.js');
      const task = args.task as string;
      const context = args.context as string | undefined;
      const specifiedModel = (args.model as string) || state.get<string>('subAgentModel', '');
      // 校验指定模型是否存在，不存在则回退
      let model: string | undefined;
      if (specifiedModel) {
        try {
          const api = state.get<any>(KEYS.API);
          const models = await api.listModels();
          const names = new Set(models.models?.map((m: any) => m.name) || []);
          if (names.has(specifiedModel)) {
            model = specifiedModel;
          } else {
            logWarn(`子代理指定模型 "${specifiedModel}" 未安装，回退到默认模型`);
          }
        } catch { model = undefined; }
      }
      if (!task) return { success: false, error: '缺少 task 参数' };
      logInfo(`子代理委派: ${task.slice(0, 80)}${model ? ` (模型: ${model})` : ''}`);
      const result = await executeSubAgent(task, context, model ? { model } : {});
      logToolResult('spawn_task', result.success, result.success ? `完成, ${(result as any).loops} 轮` : result.error);
      return result;
    }
    if (toolName === 'skill_list') {
      const { listSkills } = await import('./skill-manager.js');
      const skills = await listSkills();
      logToolResult('skill_list', true, `${skills.length} 个技能`);
      return { success: true, skills, total: skills.length };
    }
    if (toolName === 'skill_view') {
      const { viewSkill } = await import('./skill-manager.js');
      const name = String(args.name || '');
      const result = await viewSkill(name);
      logToolResult('skill_view', result.success, result.success ? result.skill?.name : result.error);
      return result;
    }

    // run_command 走 workspace IPC
    if (toolName === 'run_command') {
      const command = args.command as string;
      const cwd = args.cwd as string | undefined;
      if (!command) {
        return { success: false, error: '缺少 command 参数' };
      }
      logInfo(`工作空间命令执行: ${command.slice(0, 100)}`);
      const result = await bridge.workspace.execTool(command, cwd);
      logToolResult('run_command', result.success, result.success ? undefined : result.stderr?.slice(0, 200));
      return {
        success: result.success,
        stdout: result.stdout,
        stderr: result.stderr,
        exitCode: result.exitCode,
        duration: result.duration
      };
    }

    // 其他工具：IPC 调用（无超时，由 renderer 内部处理）
    const result = await bridge.tool.execute(toolName, args);
    logToolResult(toolName, result.success, result.success ? undefined : result.error);
    return result;
  } catch (err) {
    logError(`工具异常: ${toolName}`, (err as Error).message);
    return { success: false, error: (err as Error).message };
  }
}

export function getToolIcon(name: string): string {
  const icons: Record<string, string> = {
    read_file: '📄', write_file: '✏️', list_directory: '📁',
    search_files: '🔍', create_directory: '📂', delete_file: '🗑️', run_command: '💻',
    move_file: '📦', copy_file: '📋', web_fetch: '🌐',
    edit_file: '✂️', get_file_info: 'ℹ️', tree: '🌳', download_file: '⬇️',
    diff_files: '🔀', replace_in_files: '🔄', read_multiple_files: '📚',
    git: '🔖', compress: '🗜️', web_search: '🔍',
    memory_search: '🧠', memory_add: '💾', memory_replace: '🔄', memory_remove: '🗑️',
    session_list: '📋', session_read: '📖', skill_list: '📚', skill_view: '📖', spawn_task: '🤖',
    browser_open: '🌐', browser_screenshot: '📸', browser_evaluate: '⚡', browser_extract: '📰',
    browser_click: '👆', browser_type: '⌨️', browser_scroll: '↕️', browser_close: '❌'
  };
  return icons[name] || '🔧';
}

export function formatToolName(name: string): string {
  const names: Record<string, string> = {
    read_file: '读取文件', write_file: '写入文件', list_directory: '列出目录',
    search_files: '搜索文件', create_directory: '创建目录', delete_file: '删除文件',
    run_command: '执行命令', move_file: '移动文件', copy_file: '复制文件',
    web_fetch: '网页抓取', edit_file: '编辑文件',
    get_file_info: '文件信息', tree: '目录树', download_file: '下载文件',
    diff_files: '文件对比', replace_in_files: '批量替换', read_multiple_files: '批量读取',
    git: 'Git 操作', compress: '压缩/解压', web_search: '联网搜索',
    memory_search: '搜索记忆', memory_add: '添加记忆', memory_replace: '替换记忆', memory_remove: '删除记忆',
    session_list: '会话列表', session_read: '读取会话', skill_list: '技能列表', skill_view: '技能详情', spawn_task: '子代理委派',
    browser_open: '打开网页', browser_screenshot: '浏览器截图', browser_evaluate: '执行JS', browser_extract: '提取内容',
    browser_click: '点击元素', browser_type: '输入文本', browser_scroll: '滚动页面', browser_close: '关闭浏览器'
  };
  return names[name] || name;
}
