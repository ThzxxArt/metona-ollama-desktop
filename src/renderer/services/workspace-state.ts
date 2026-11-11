/**
 * 工作空间路径共享状态。
 *
 * 独立成无 UI 依赖的模块，避免 service（agent / sub-agent）反向依赖
 * components/workspace-panel，从而形成 tool-registry ↔ sub-agent ↔ workspace-panel 循环。
 */

let workspaceDir = '';

export function getWorkspaceDirPath(): string {
  return workspaceDir;
}

export function setWorkspaceDirPath(dir: string): void {
  workspaceDir = dir;
}
