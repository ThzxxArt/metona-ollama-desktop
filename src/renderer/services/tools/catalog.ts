/**
 * 内置工具目录（0.18.0：严格 18 个）
 * 与工具面板、帮助文档、测试保持单一事实来源。
 */

import type { ToolDefinition } from '../../types.js';

export const TOOL_DEFINITIONS: ToolDefinition[] = [
  {
    type: 'function',
    function: {
      name: 'read_file',
      description:
        'Read one or more LOCAL files. Use "path" for a single file, or "paths" to batch-read up to 50 files in parallel. Does NOT support URLs — use web_fetch for web pages. Supports text (utf-8/latin1, line pagination) and binary (base64, byte pagination). Files up to 5MB (text) or 50MB (binary). When truncated, returns remaining_lines/remaining_bytes and a hint to continue.',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description: 'Single local file path (NOT a URL). Absolute or relative to workspace.',
          },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Batch-read multiple local files (max 50). Mutually exclusive with path.',
          },
          max_chars_per_file: {
            type: 'integer',
            description: 'Max chars per file when using paths. Default: 10000.',
          },
          encoding: {
            type: 'string',
            enum: ['utf-8', 'latin1', 'base64'],
            description: 'File encoding. Default: utf-8. Use base64 for binary content.',
          },
          start_line: {
            type: 'integer',
            description: 'Start line (1-indexed) for text files. Use with end_line for pagination.',
          },
          end_line: { type: 'integer', description: 'End line (inclusive). Default: start_line + 2000.' },
          mode: {
            type: 'string',
            enum: ['text', 'binary'],
            description: 'Read mode. text = decode as string, binary = return base64. Default: text.',
          },
          offset_bytes: {
            type: 'integer',
            description: 'Byte offset to start reading from (0-indexed). Use for binary files or large text.',
          },
          limit_bytes: {
            type: 'integer',
            description: 'Max bytes to read. Default: 50000 (text) or 102400 (binary).',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'write_file',
      description:
        'Write content to a local file. Creates parent directories automatically. The "path" parameter is REQUIRED — always specify a file path (relative to workspace or absolute). For example: path="output.txt" writes to workspace. Supports text (utf-8/latin1) and binary (base64). Use mode="append" to add to existing file. Max 10MB overwrite / 5MB append.',
      parameters: {
        type: 'object',
        required: ['path', 'content'],
        properties: {
          path: {
            type: 'string',
            description:
              'REQUIRED — File path. Relative paths use workspace as base. E.g. "output.txt", "docs/report.md", or absolute "/home/user/file.txt".',
          },
          content: {
            type: 'string',
            description: 'The content to write. For binary files, pass base64-encoded string with encoding="base64".',
          },
          encoding: {
            type: 'string',
            enum: ['utf-8', 'latin1', 'base64'],
            description: 'File encoding. Use "base64" to write binary content (images, PDFs, etc). Default: utf-8.',
          },
          mode: {
            type: 'string',
            enum: ['overwrite', 'append'],
            description: 'Write mode. overwrite = replace file, append = add to end. Default: overwrite.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'list_directory',
      description:
        'List directory contents up to 2000 entries, or render a tree when format="tree". Returns names, types, sizes, modification times. Supports offset pagination, recursion, and extension filtering.',
      parameters: {
        type: 'object',
        required: ['path'],
        properties: {
          path: { type: 'string', description: 'Directory path.' },
          format: {
            type: 'string',
            enum: ['list', 'tree'],
            description: 'list = flat entries; tree = nested directory tree. Default: list.',
          },
          recursive: { type: 'boolean', description: 'List recursively. Default: false.' },
          max_depth: { type: 'integer', description: 'Max recursion depth. Default: 3 (list) / 5 (tree).' },
          include_hidden: { type: 'boolean', description: 'Include hidden files. Default: false.' },
          filter_extension: {
            type: 'string',
            description:
              'Filter files by extension (e.g. ".txt"). Only files matching this extension are returned. Default: no filter.',
          },
          offset: { type: 'integer', description: 'Skip first N entries for pagination. Default: 0.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_files',
      description:
        'Search files by name pattern or text content within files. Supports regular expressions with use_regex=true.',
      parameters: {
        type: 'object',
        required: ['path', 'query'],
        properties: {
          path: { type: 'string', description: 'Root directory to search.' },
          query: { type: 'string', description: 'Search query (glob, text, or regex).' },
          search_type: {
            type: 'string',
            enum: ['filename', 'content', 'both'],
            description: 'Search target. Default: both.',
          },
          case_sensitive: { type: 'boolean', description: 'Case sensitive. Default: false.' },
          max_results: { type: 'integer', description: 'Max results. Default: 0 (no limit).' },
          file_extensions: {
            type: 'array',
            items: { type: 'string' },
            description: 'Filter extensions, e.g. [".ts", ".js"]',
          },
          use_regex: { type: 'boolean', description: 'Treat query as regular expression. Default: false.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'delete_file',
      description:
        'Delete a file or directory. Supports batch deletion via paths parameter. At least one of path or paths must be provided. Returns deleted item count and total size. Use recursive=true for non-empty directories.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string', description: 'Single path to delete. Use this for deleting one file/directory.' },
          paths: {
            type: 'array',
            items: { type: 'string' },
            description: 'Multiple paths to delete in batch. Use this when deleting multiple files at once.',
          },
          recursive: {
            type: 'boolean',
            description: 'Recursive delete for directories. Returns filesDeleted count and total deletedSize.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'run_command',
      description:
        'Execute a shell command via workspace. cwd defaults to workspace directory. Output is streamed in real-time through the workspace process. Execution mode is configurable (auto / confirm / disabled) — set in the Tools panel; in confirm mode the user must approve each command before it runs.',
      parameters: {
        type: 'object',
        required: ['command'],
        properties: {
          command: { type: 'string', description: 'Shell command to execute.' },
          cwd: { type: 'string', description: 'Working directory. Defaults to workspace directory.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'file_transfer',
      description:
        'Copy or move a file/directory. operation="copy" copies, operation="move" moves or renames. Creates destination parent directories automatically.',
      parameters: {
        type: 'object',
        required: ['operation', 'source', 'destination'],
        properties: {
          operation: {
            type: 'string',
            enum: ['copy', 'move'],
            description: 'copy = duplicate, move = move or rename.',
          },
          source: { type: 'string', description: 'Source path.' },
          destination: { type: 'string', description: 'Destination path.' },
          recursive: { type: 'boolean', description: 'Copy directories recursively (copy only). Default: true.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_fetch',
      description:
        'Fetch and extract full text content from a URL. Typically used after web_search: pick the most relevant result URLs from search and call web_fetch on each to get detailed content before answering. Automatically retries on failure (up to 2 times with exponential backoff). Auto-upgrades to browser rendering for JavaScript-heavy pages.',
      parameters: {
        type: 'object',
        required: ['url'],
        properties: {
          url: { type: 'string', description: 'URL to fetch (http/https).' },
          max_chars: { type: 'integer', description: 'Max characters to return. Default: 0 (no limit, return full content).' },
          extract_mode: {
            type: 'string',
            enum: ['text', 'markdown'],
            description: 'Extraction mode. Default: text.',
          },
          mobile_ua: {
            type: 'boolean',
            description: 'Use mobile User-Agent. Some sites return simpler content for mobile. Default: false.',
          },
          retry: {
            type: 'boolean',
            description: 'Enable auto-retry on failure (5xx/network errors, up to 2 times). Default: true.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'edit_file',
      description:
        'Find and replace text in a file. Supports literal string matching and regex (use_regex=true). Use all=true to replace all occurrences. More efficient than write_file for small edits.',
      parameters: {
        type: 'object',
        required: ['path', 'old_text', 'new_text'],
        properties: {
          path: { type: 'string', description: 'File path to edit.' },
          old_text: { type: 'string', description: 'Text to find. Can be a regex pattern when use_regex=true.' },
          new_text: { type: 'string', description: 'Replacement text.' },
          all: { type: 'boolean', description: 'Replace all occurrences. Default: false.' },
          use_regex: { type: 'boolean', description: 'Treat old_text as a regular expression. Default: false.' },
        },
      },
    },
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
          destination: { type: 'string', description: 'Local path to save the file.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'git',
      description:
        'Git operations: status, log, diff, add, commit, push, pull, branch, checkout, merge, stash, remote, clone, init. All operations are automatic (no confirmation).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: [
              'status',
              'log',
              'diff',
              'add',
              'commit',
              'push',
              'pull',
              'branch',
              'checkout',
              'merge',
              'stash',
              'remote',
              'clone',
              'init',
              'reset',
              'tag',
            ],
            description: 'Git action to perform.',
          },
          path: { type: 'string', description: 'Repository path. Defaults to workspace.' },
          files: { type: 'array', items: { type: 'string' }, description: 'Files for add/diff/checkout.' },
          message: { type: 'string', description: 'Commit message for commit action.' },
          branch: { type: 'string', description: 'Branch name for branch/checkout/merge.' },
          tag_name: {
            type: 'string',
            description: 'Tag name for tag action (creates an annotated tag if message is provided).',
          },
          stash_sub: {
            type: 'string',
            enum: ['push', 'pop', 'apply', 'list', 'drop'],
            description: 'Stash subcommand. Default: push.',
          },
          remote: { type: 'string', description: 'Remote name for push/pull/remote.' },
          remote_url: { type: 'string', description: 'Remote URL for remote add.' },
          count: { type: 'integer', description: 'Number of log entries. Default: 20.' },
          all: { type: 'boolean', description: 'Show all (branches, stashes, etc). Default: false.' },
          staged: { type: 'boolean', description: 'Show staged changes in diff. Default: false.' },
          new_branch: { type: 'boolean', description: 'Create new branch in branch action. Default: false.' },
          delete_branch: { type: 'boolean', description: 'Delete branch in branch action. Default: false.' },
          force: { type: 'boolean', description: 'Force push/checkout. Default: false.' },
          url: { type: 'string', description: 'Repository URL for clone.' },
        },
      },
    },
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
          destination: {
            type: 'string',
            description: 'Output archive path (create) or extract dir (extract).',
          },
          format: { type: 'string', enum: ['zip', 'tar.gz'], description: 'Archive format. Default: tar.gz.' },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'diff',
      description:
        'Compare file contents and return unified diff format. Supports three modes: file_vs_file (compare two files), file_vs_content (compare a file against provided text), file_vs_git_head (compare working copy against git HEAD). Useful for verifying edits before committing, checking what changed after edit_file, or comparing two versions of a file.',
      parameters: {
        type: 'object',
        required: ['mode'],
        properties: {
          mode: {
            type: 'string',
            enum: ['file_vs_file', 'file_vs_content', 'file_vs_git_head'],
            description:
              'Comparison mode. file_vs_file: compare path1 vs path2. file_vs_content: compare path1 file vs provided content. file_vs_git_head: compare path1 working copy vs git HEAD version.',
          },
          path1: {
            type: 'string',
            description:
              'Primary file path. Required for all modes. In file_vs_file, this is the "old" file. In file_vs_git_head, this is the working copy.',
          },
          path2: { type: 'string', description: 'Second file path (only for file_vs_file mode).' },
          content: { type: 'string', description: 'Content to compare against (only for file_vs_content mode).' },
          context_lines: {
            type: 'integer',
            description: 'Number of context lines around changes in the diff output. Default: 3.',
          },
        },
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'web_search',
      description:
        'Search the web with auto-fetch. Always use this when the user asks for information, news, facts, or current data. Never rely on training data or past conversation results — call this tool every time the user asks to search. Set fetch_top to auto-fetch full page content from the top N results.',
      parameters: {
        type: 'object',
        required: ['query', 'fetch_top'],
        properties: {
          query: { type: 'string', description: 'The search query. Be specific and concise for best results.' },
          max_results: { type: 'integer', description: 'Maximum number of results to return. Default: 30, max: 30.' },
          time_range: {
            type: 'string',
            enum: ['day', 'week', 'month', 'year'],
            description: 'Filter results by time. Supported by Bing and Google. Use for recent news, latest version, etc.',
          },
          enhance_snippets: {
            type: 'boolean',
            description: 'Auto-fetch detailed snippet for results with too-short descriptions. Default: true.',
          },
          fetch_top: {
            type: 'integer',
            description:
              'Number of top results to auto-fetch full content for. Min: 3. Results shorter than this are useless — snippets lack detail.',
          },
        },
      },
    },
  },
  // ══════════════════════════════════════════════
  // 记忆工具（统一入口，读写工作空间 MEMORY.md）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'memory',
      description: `Manage agent memories stored in MEMORY.md. Usage by action:
- search: {"action":"search","query":"keywords","limit":8}
- add: {"action":"add","type":"fact","content":"the memory content","importance":8,"tags":["tag1","tag2"]}  ← type and content are REQUIRED for add!
- replace: {"action":"replace","old_text":"unique substring","new_content":"replacement"}
- remove: {"action":"remove","old_text":"unique substring"}
- remove_batch: {"action":"remove_batch","old_texts":["substring1","substring2","substring3"]}  ← Batch delete multiple entries in one call
- read_all: {"action":"read_all"}

CRITICAL: For add action, you MUST include both "type" (fact/preference/rule) and "content" fields. If you omit them, the call will fail.
TIP: Use remove_batch when deleting multiple entries — it's much more efficient than calling remove repeatedly.`,
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['search', 'add', 'replace', 'remove', 'remove_batch', 'read_all'],
            description:
              'Which operation to perform. Note: "add" requires "type"+"content", "replace" requires "old_text"+"new_content", "remove" requires "old_text", "remove_batch" requires "old_texts" (array), "search" requires "query".',
          },
          query: { type: 'string', description: '[search REQUIRED] Keywords to search for.' },
          limit: { type: 'integer', description: '[search] Max results. Default: 8.' },
          type: {
            type: 'string',
            enum: ['fact', 'preference', 'rule'],
            description: '[add REQUIRED] Memory type. fact=user info, preference=user preference, rule=behavior rule.',
          },
          content: {
            type: 'string',
            description: '[add REQUIRED, replace] Memory text. Keep it concise (8-100 chars).',
          },
          importance: { type: 'integer', description: '[add] Priority 1-10. Default: 5. Use 8+ for critical info.' },
          tags: { type: 'array', items: { type: 'string' }, description: '[add] 2-5 keywords for search matching.' },
          old_text: {
            type: 'string',
            description:
              '[replace, remove REQUIRED] Unique substring to identify the entry. Must be ≥5 chars. Use exact text from read_all for best results.',
          },
          old_texts: {
            type: 'array',
            items: { type: 'string' },
            description:
              '[remove_batch REQUIRED] Array of substrings to identify multiple entries for batch deletion. Each must be ≥5 chars.',
          },
          new_content: { type: 'string', description: '[replace REQUIRED] New text to replace with.' },
        },
      },
    },
  },
  // ══════════════════════════════════════════════
  // 子代理委派
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'spawn_task',
      description:
        'Spawn a sub-agent to independently execute a task. Default permission is "readonly" (file reading, web search, browser viewing, memory/session queries). Set permission to "limited_write" for file editing tasks (write_file, edit_file, file_transfer, browser) or "full_write" for full capability (run_command, git, delete_file). Use this to parallelize independent sub-tasks. The model is configured in Settings and cannot be overridden per call.',
      parameters: {
        type: 'object',
        required: ['task'],
        properties: {
          task: { type: 'string', description: 'The task description for the sub-agent to execute.' },
          context: { type: 'string', description: 'Optional additional context or reference data for the sub-agent.' },
          permission: {
            type: 'string',
            enum: ['readonly', 'limited_write', 'full_write'],
            description:
              'Permission level for the sub-agent. readonly=file reading/search only, limited_write=can edit files but no shell commands, full_write=full capability including run_command and git. Default: readonly.',
          },
        },
      },
    },
  },
  // ══════════════════════════════════════════════
  // 会话读取（合并 list / read）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'session',
      description:
        'Read previous chat sessions. action="list" lists sessions (optional search/limit); action="read" reads messages of a session (requires session_id).',
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: { type: 'string', enum: ['list', 'read'], description: 'list = list sessions, read = read one session.' },
          session_id: { type: 'string', description: '[read REQUIRED] Session ID to read.' },
          max_messages: { type: 'integer', description: '[read] Max messages to return. Default: 50.' },
          limit: { type: 'integer', description: '[list] Max sessions to return. Default: 20.' },
          search: { type: 'string', description: '[list] Filter sessions by title keyword.' },
        },
      },
    },
  },
  // ══════════════════════════════════════════════
  // 浏览器控制（合并 9 个 action）
  // ══════════════════════════════════════════════
  {
    type: 'function',
    function: {
      name: 'browser',
      description: `Control the agent browser via action:
- open: {"action":"open","url":"https://example.com","wait_selector":"#main"}
- extract: {"action":"extract","selector":"article","max_chars":15000}
- screenshot: {"action":"screenshot","full_page":true} or {"selector":"#chart"}
- click: {"action":"click","selector":"button.submit","wait":true}
- type: {"action":"type","selector":"input[name=q]","text":"query","clear":true,"submit":true}
- scroll: {"action":"scroll","direction":"down"} or {"selector":"#footer"}
- wait: {"action":"wait","selector":".loaded"} or {"time_ms":1000}
- evaluate: {"action":"evaluate","js":"document.title"}
- close: {"action":"close"}`,
      parameters: {
        type: 'object',
        required: ['action'],
        properties: {
          action: {
            type: 'string',
            enum: ['open', 'extract', 'screenshot', 'click', 'type', 'scroll', 'wait', 'evaluate', 'close'],
            description: 'Browser action.',
          },
          url: { type: 'string', description: '[open REQUIRED] URL (http/https).' },
          wait_selector: { type: 'string', description: '[open] CSS selector to wait for after load.' },
          selector: { type: 'string', description: '[extract/click/type/scroll/wait/screenshot] CSS selector.' },
          max_chars: { type: 'integer', description: '[extract] Max characters. Default: 15000.' },
          full_page: { type: 'boolean', description: '[screenshot] Capture full page.' },
          wait: { type: 'boolean', description: '[click] Wait up to 10s for element.' },
          text: { type: 'string', description: '[type REQUIRED] Text to type.' },
          clear: { type: 'boolean', description: '[type] Clear input first. Default: true.' },
          submit: { type: 'boolean', description: '[type] Submit form after typing.' },
          direction: {
            type: 'string',
            enum: ['down', 'up', 'top', 'bottom'],
            description: '[scroll] Direction. Default: down.',
          },
          time_ms: { type: 'integer', description: '[wait] Fixed delay in ms. Default: 1000.' },
          js: { type: 'string', description: '[evaluate REQUIRED] JavaScript to execute.' },
        },
      },
    },
  },
];

/** 需要三档开关（auto/confirm/disabled）的写操作工具 */
export const MODE_TOOLS = [
  'run_command',
  'write_file',
  'delete_file',
  'edit_file',
  'file_transfer',
  'download_file',
  'compress',
];

export type ToolMode = 'auto' | 'confirm' | 'disabled';
