/**
 * Tool Handlers - 主进程工具执行器入口
 * 按类别拆分：文件系统 / 系统网络 / Git
 * 所有导出保持不变，ipc.ts 无需修改
 */

export { sendLog, resolvePath, type ToolResult } from './tool-handlers-shared.js';

// 文件系统操作（15 个）
export {
  handleReadFile,
  handleWriteFile,
  handleListDir,
  handleSearchFiles,
  handleCreateDir,
  handleDeleteFile,
  handleMoveFile,
  handleCopyFile,
  handleEditFile,
  handleGetFileInfo,
  handleTree,
  handleDiffFiles,
  handleReplaceInFiles,
  handleReadMultipleFiles,
} from './tool-handlers-fs.js';

// 系统与网络操作（6 个）
export {
  handleRunCommand,
  killToolProcess,
  handleWebFetch,
  handleWebSearch,
  handleDownloadFile,
  handleCompress,
} from './tool-handlers-system.js';

// Git 操作（1 个）
export { handleGit } from './tool-handlers-git.js';
