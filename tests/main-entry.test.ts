import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

type AnyFn = (...args: any[]) => any;

const hoisted = vi.hoisted(() => {
  const appHandlers = new Map<string, AnyFn[]>();
  const windowInstances: any[] = [];
  const trayInstances: any[] = [];
  const menuTemplates: any[][] = [];
  const notificationInstances: any[] = [];
  const headerHandlers: AnyFn[] = [];
  const classes: Record<string, any> = {};
  const state = {
    userData: '',
    appPath: process.cwd(),
    gotLock: true,
    whenReadyImpl: async (): Promise<void> => {},
    isPackaged: false,
    notificationSupported: true,
    showErrorBoxThrows: false,
    appQuit: vi.fn(),
    showErrorBox: vi.fn(),
    showMessageBox: vi.fn(),
    openExternal: vi.fn(),
    initDatabase: vi.fn(async () => undefined),
    getSetting: vi.fn((_key: string, def: unknown) => def),
    flushDatabase: vi.fn(),
    sendLog: vi.fn(),
    registerAppIPC: vi.fn(),
    registerOllamaIPC: vi.fn(),
    registerToolsIPC: vi.fn(),
    registerDbIPC: vi.fn(),
    registerMemoryIPC: vi.fn(),
    registerMcpIPC: vi.fn(),
    registerMediaIPC: vi.fn(),
    ensureWorkspaceDir: vi.fn(),
    killAllProcesses: vi.fn(),
    setWorkspaceDir: vi.fn(),
    browserClose: vi.fn(async () => undefined),
    stopAllServers: vi.fn(),
    unloadModelsOnExit: vi.fn(async () => undefined),
    secretInit: vi.fn(async () => undefined),
    abortAllOllamaStreams: vi.fn(),
    buildFromTemplate: vi.fn((template: any[]) => {
      menuTemplates.push(template);
      return { template };
    }),
    setApplicationMenu: vi.fn(),
    createFromPath: vi.fn((p: string) => ({ path: p, resize: vi.fn(() => ({ resized: true })) })),
  };
  return {
    appHandlers,
    windowInstances,
    trayInstances,
    menuTemplates,
    notificationInstances,
    headerHandlers,
    classes,
    state,
  };
});

vi.mock('electron', () => {
  class FakeBrowserWindow {
    static instances = hoisted.windowInstances;
    static getAllWindows = vi.fn(() => hoisted.windowInstances.filter((w) => !w.destroyed));

    options: any;
    webContents: any;
    handlers = new Map<string, AnyFn[]>();
    onceHandlers = new Map<string, AnyFn[]>();
    destroyed = false;
    maximized = false;
    minimized = false;
    bounds = { x: 10, y: 20, width: 1000, height: 700 };
    windowOpenHandler: AnyFn | null = null;
    loadURL = vi.fn(async () => undefined);
    loadFile = vi.fn(async () => undefined);
    setMenuBarVisibility = vi.fn();
    show = vi.fn();
    hide = vi.fn();
    focus = vi.fn();
    restore = vi.fn();
    maximize = vi.fn(() => {
      this.maximized = true;
    });
    unmaximize = vi.fn(() => {
      this.maximized = false;
    });
    isMaximized = vi.fn(() => this.maximized);
    isMinimized = vi.fn(() => this.minimized);
    getBounds = vi.fn(() => this.bounds);
    setAlwaysOnTop = vi.fn();
    close = vi.fn();
    isDestroyed = vi.fn(() => this.destroyed);

    constructor(options: any) {
      this.options = options;
      this.webContents = {
        send: vi.fn(),
        setWindowOpenHandler: vi.fn((cb: AnyFn) => {
          this.windowOpenHandler = cb;
        }),
        toggleDevTools: vi.fn(),
      };
      hoisted.windowInstances.push(this);
    }

    on(event: string, cb: AnyFn) {
      const list = this.handlers.get(event) || [];
      list.push(cb);
      this.handlers.set(event, list);
      return this;
    }

    once(event: string, cb: AnyFn) {
      const list = this.onceHandlers.get(event) || [];
      list.push(cb);
      this.onceHandlers.set(event, list);
      return this;
    }

    emit(event: string, ...args: any[]) {
      for (const cb of this.handlers.get(event) || []) cb(...args);
    }

    emitOnce(event: string, ...args: any[]) {
      const list = this.onceHandlers.get(event) || [];
      this.onceHandlers.delete(event);
      for (const cb of list) cb(...args);
    }
  }

  class FakeTray {
    icon: any;
    handlers = new Map<string, AnyFn>();
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    constructor(icon: any) {
      this.icon = icon;
      hoisted.trayInstances.push(this);
    }
    on(event: string, cb: AnyFn) {
      this.handlers.set(event, cb);
      return this;
    }
  }

  class FakeNotification {
    static isSupported = vi.fn(() => hoisted.state.notificationSupported);
    options: any;
    show = vi.fn();
    constructor(options: any) {
      this.options = options;
      hoisted.notificationInstances.push(this);
    }
  }

  hoisted.classes.BrowserWindow = FakeBrowserWindow;
  hoisted.classes.Tray = FakeTray;
  hoisted.classes.Notification = FakeNotification;

  return {
    app: {
      getPath: (name: string) => (name === 'userData' ? hoisted.state.userData : hoisted.state.userData),
      getAppPath: () => hoisted.state.appPath,
      getVersion: () => '0.18.0',
      requestSingleInstanceLock: () => hoisted.state.gotLock,
      whenReady: () => hoisted.state.whenReadyImpl(),
      on: (event: string, cb: AnyFn) => {
        const list = hoisted.appHandlers.get(event) || [];
        list.push(cb);
        hoisted.appHandlers.set(event, list);
      },
      quit: hoisted.state.appQuit,
      get isPackaged() {
        return hoisted.state.isPackaged;
      },
    },
    BrowserWindow: FakeBrowserWindow,
    Tray: FakeTray,
    Notification: FakeNotification,
    Menu: {
      buildFromTemplate: hoisted.state.buildFromTemplate,
      setApplicationMenu: hoisted.state.setApplicationMenu,
    },
    nativeImage: { createFromPath: hoisted.state.createFromPath },
    dialog: {
      showErrorBox: (...args: any[]) => {
        hoisted.state.showErrorBox(...args);
        if (hoisted.state.showErrorBoxThrows) throw new Error('dialog unavailable');
      },
      showMessageBox: hoisted.state.showMessageBox,
    },
    shell: { openExternal: hoisted.state.openExternal },
    session: {
      defaultSession: {
        webRequest: {
          onHeadersReceived: (cb: AnyFn) => hoisted.headerHandlers.push(cb),
        },
      },
    },
  };
});

vi.mock('../src/main/db/sqlite.js', () => ({
  initDatabase: hoisted.state.initDatabase,
  getSetting: hoisted.state.getSetting,
  flushDatabase: hoisted.state.flushDatabase,
}));
vi.mock('../src/main/ipc/shared.js', () => ({ sendLog: hoisted.state.sendLog }));
vi.mock('../src/main/ipc/app.js', () => ({ registerAppIPC: hoisted.state.registerAppIPC }));
vi.mock('../src/main/ipc/ollama.js', () => ({
  registerOllamaIPC: hoisted.state.registerOllamaIPC,
  abortAllOllamaStreams: hoisted.state.abortAllOllamaStreams,
}));
vi.mock('../src/main/ipc/tools.js', () => ({ registerToolsIPC: hoisted.state.registerToolsIPC }));
vi.mock('../src/main/ipc/db.js', () => ({ registerDbIPC: hoisted.state.registerDbIPC }));
vi.mock('../src/main/ipc/memory.js', () => ({ registerMemoryIPC: hoisted.state.registerMemoryIPC }));
vi.mock('../src/main/ipc/mcp.js', () => ({ registerMcpIPC: hoisted.state.registerMcpIPC }));
vi.mock('../src/main/ipc/media.js', () => ({ registerMediaIPC: hoisted.state.registerMediaIPC }));
vi.mock('../src/main/workspace.js', () => ({
  ensureWorkspaceDir: hoisted.state.ensureWorkspaceDir,
  killAllProcesses: hoisted.state.killAllProcesses,
  setWorkspaceDir: hoisted.state.setWorkspaceDir,
}));
vi.mock('../src/main/browser.js', () => ({ browserClose: hoisted.state.browserClose }));
vi.mock('../src/main/mcp-manager.js', () => ({ stopAllServers: hoisted.state.stopAllServers }));
vi.mock('../src/main/ollama/client.js', () => ({ unloadModelsOnExit: hoisted.state.unloadModelsOnExit }));
vi.mock('../src/main/ollama/secret-store.js', () => ({
  getOllamaSecretStore: () => ({ init: hoisted.state.secretInit }),
}));

const originalPlatform = process.platform;
let tmpDir: string;
let baselineExceptionListeners: AnyFn[] = [];
let baselineRejectionListeners: AnyFn[] = [];

function setPlatform(value: string): void {
  Object.defineProperty(process, 'platform', { value, configurable: true });
}

function restorePlatform(): void {
  Object.defineProperty(process, 'platform', { value: originalPlatform, configurable: true });
}

async function flush(times = 6): Promise<void> {
  for (let i = 0; i < times; i++) {
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

async function loadMain() {
  vi.resetModules();
  const mod = await import('../src/main/main.js');
  await flush();
  return mod;
}

function appHandler(event: string): AnyFn {
  const list = hoisted.appHandlers.get(event);
  if (!list || list.length === 0) throw new Error(`missing app handler: ${event}`);
  return list[list.length - 1];
}

function findMenuItem(template: any[], label: string): any {
  for (const item of template) {
    if (item.label === label) return item;
    if (Array.isArray(item.submenu)) {
      const found = findMenuItem(item.submenu, label);
      if (found) return found;
    }
  }
  return undefined;
}

function appMenuTemplate(): any[] {
  const menu = hoisted.menuTemplates.find((t) => t.some((item) => item.label === '文件'));
  if (!menu) throw new Error('application menu not created');
  return menu;
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metona-main-entry-'));
  hoisted.state.userData = tmpDir;
  hoisted.state.appPath = process.cwd();
  hoisted.state.gotLock = true;
  hoisted.state.whenReadyImpl = async () => {};
  hoisted.state.isPackaged = false;
  hoisted.state.notificationSupported = true;
  hoisted.state.showErrorBoxThrows = false;
  hoisted.state.getSetting.mockImplementation((_key: string, def: unknown) => def);
  hoisted.state.browserClose.mockImplementation(async () => undefined);
  hoisted.state.unloadModelsOnExit.mockImplementation(async () => undefined);
  hoisted.state.secretInit.mockImplementation(async () => undefined);
  hoisted.state.initDatabase.mockImplementation(async () => undefined);
  hoisted.appHandlers.clear();
  hoisted.windowInstances.length = 0;
  hoisted.trayInstances.length = 0;
  hoisted.menuTemplates.length = 0;
  hoisted.notificationInstances.length = 0;
  hoisted.headerHandlers.length = 0;
  vi.clearAllMocks();
  delete (global as any)._trayHintShown;
  delete process.env.METONA_DEV_URL;
  baselineExceptionListeners = process.listeners('uncaughtException') as AnyFn[];
  baselineRejectionListeners = process.listeners('unhandledRejection') as AnyFn[];
});

afterEach(() => {
  restorePlatform();
  delete process.env.METONA_DEV_URL;
  for (const listener of process.listeners('uncaughtException')) {
    if (!baselineExceptionListeners.includes(listener)) process.removeListener('uncaughtException', listener);
  }
  for (const listener of process.listeners('unhandledRejection')) {
    if (!baselineRejectionListeners.includes(listener)) process.removeListener('unhandledRejection', listener);
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('main entry: single instance / startup', () => {
  it('获得单实例锁时注册 second-instance，并在 whenReady 后初始化全部子系统', async () => {
    hoisted.state.getSetting.mockReturnValue('/saved/workspace');
    await loadMain();

    expect(hoisted.state.initDatabase).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerOllamaIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerAppIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerToolsIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerDbIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerMemoryIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerMcpIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.registerMediaIPC).toHaveBeenCalledTimes(1);
    expect(hoisted.state.setWorkspaceDir).toHaveBeenCalledWith('/saved/workspace');
    expect(hoisted.state.ensureWorkspaceDir).toHaveBeenCalledTimes(1);
    expect(hoisted.state.secretInit).toHaveBeenCalledTimes(1);
    expect(hoisted.windowInstances).toHaveLength(1);
    expect(hoisted.trayInstances).toHaveLength(1);
    expect(hoisted.menuTemplates.length).toBeGreaterThanOrEqual(2);
    expect(hoisted.appHandlers.has('second-instance')).toBe(true);
    expect(hoisted.appHandlers.has('activate')).toBe(true);
    expect(hoisted.appHandlers.has('window-all-closed')).toBe(true);
    expect(hoisted.appHandlers.has('before-quit')).toBe(true);
  });

  it('未获得单实例锁时立即 quit，且不注册 second-instance', async () => {
    hoisted.state.gotLock = false;
    await loadMain();
    expect(hoisted.state.appQuit).toHaveBeenCalled();
    expect(hoisted.appHandlers.has('second-instance')).toBe(false);
  });

  it('whenReady 失败时写日志、弹错误框并退出', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.state.whenReadyImpl = async () => {
      throw new Error('init boom');
    };
    await loadMain();

    const log = fs.readFileSync(path.join(tmpDir, 'startup-error.log'), 'utf-8');
    expect(log).toContain('app.whenReady: Error: init boom');
    expect(hoisted.state.showErrorBox).toHaveBeenCalledWith(
      'Metona Ollama 启动失败',
      expect.stringContaining('init boom'),
    );
    expect(hoisted.state.appQuit).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('whenReady 失败且 dialog 抛错时仍然退出', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    hoisted.state.whenReadyImpl = async () => {
      throw 'string failure';
    };
    hoisted.state.showErrorBoxThrows = true;
    await loadMain();
    expect(hoisted.state.showErrorBox).toHaveBeenCalled();
    expect(hoisted.state.appQuit).toHaveBeenCalled();
    errorSpy.mockRestore();
  });

  it('process 级未捕获错误与未处理拒绝写入日志', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    await loadMain();

    const uncaught = process
      .listeners('uncaughtException')
      .find((listener) => !baselineExceptionListeners.includes(listener)) as AnyFn;
    const rejection = process
      .listeners('unhandledRejection')
      .find((listener) => !baselineRejectionListeners.includes(listener)) as AnyFn;
    expect(uncaught).toBeTypeOf('function');
    expect(rejection).toBeTypeOf('function');
    uncaught(new Error('uncaught boom'));
    rejection('rejected reason', Promise.resolve());

    const log = fs.readFileSync(path.join(tmpDir, 'startup-error.log'), 'utf-8');
    expect(log).toContain('uncaughtException: Error: uncaught boom');
    expect(log).toContain('unhandledRejection: rejected reason');
    expect(errorSpy).toHaveBeenCalledTimes(2);
    errorSpy.mockRestore();
  });

  it('setupIPC 恢复工作空间目录失败时被吞掉', async () => {
    hoisted.state.getSetting.mockImplementation(() => {
      throw new Error('db not ready');
    });
    await loadMain();
    expect(hoisted.state.setWorkspaceDir).not.toHaveBeenCalled();
    expect(hoisted.state.ensureWorkspaceDir).toHaveBeenCalled();
  });
});

describe('main entry: window creation / state', () => {
  it('读取已有 window-state 并在 ready-to-show 时最大化显示', async () => {
    const configPath = path.join(tmpDir, 'window-state.json');
    fs.writeFileSync(configPath, JSON.stringify({ width: 900, height: 700, x: 1, y: 2, maximized: true }));
    await loadMain();

    const win = hoisted.windowInstances[0];
    expect(win.options).toMatchObject({
      width: 900,
      height: 700,
      x: 1,
      y: 2,
      minWidth: 800,
      minHeight: 600,
      title: 'Metona Ollama',
      show: false,
      autoHideMenuBar: true,
    });
    expect(win.options.webPreferences).toMatchObject({
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
    });
    expect(win.options.webPreferences.preload).toContain('preload.js');
    expect(win.loadFile).toHaveBeenCalled();
    expect(win.setMenuBarVisibility).toHaveBeenCalledWith(false);

    win.emitOnce('ready-to-show');
    expect(win.maximize).toHaveBeenCalled();
    expect(win.show).toHaveBeenCalled();
  });

  it('window-state 损坏时使用默认尺寸；resize/move 保存边界', async () => {
    const configPath = path.join(tmpDir, 'window-state.json');
    fs.writeFileSync(configPath, '{not json');
    await loadMain();

    const win = hoisted.windowInstances[0];
    expect(win.options.width).toBe(1200);
    expect(win.options.height).toBe(800);

    win.bounds = { x: 30, y: 40, width: 1111, height: 777 };
    win.emit('resize');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ x: 30, y: 40, width: 1111, height: 777 });
    win.emit('move');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8'))).toEqual({ x: 30, y: 40, width: 1111, height: 777 });
  });

  it('最大化/最小化或窗口最大化时不覆盖保存边界', async () => {
    const configPath = path.join(tmpDir, 'window-state.json');
    await loadMain();
    const win = hoisted.windowInstances[0];

    win.maximized = true;
    win.emit('resize');
    expect(fs.existsSync(configPath)).toBe(false);

    win.maximized = false;
    win.minimized = true;
    win.emit('move');
    expect(fs.existsSync(configPath)).toBe(false);
  });

  it('maximize/unmaximize 更新状态文件；文件缺失时忽略异常', async () => {
    const configPath = path.join(tmpDir, 'window-state.json');
    fs.writeFileSync(configPath, JSON.stringify({ width: 1000, height: 700, maximized: false }));
    await loadMain();
    const win = hoisted.windowInstances[0];

    win.emit('maximize');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).maximized).toBe(true);
    win.emit('unmaximize');
    expect(JSON.parse(fs.readFileSync(configPath, 'utf-8')).maximized).toBe(false);

    fs.rmSync(configPath);
    expect(() => win.emit('maximize')).not.toThrow();
    expect(() => win.emit('unmaximize')).not.toThrow();
  });

  it('close 首次隐藏并提示托盘，重复 close 不再提示；退出中直接放行', async () => {
    const main = await loadMain();
    const win = hoisted.windowInstances[0];

    const first = { preventDefault: vi.fn() };
    win.emit('close', first);
    expect(first.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(1);
    expect(hoisted.notificationInstances).toHaveLength(1);
    expect(hoisted.notificationInstances[0].options).toMatchObject({
      title: 'Metona 已最小化到系统托盘',
      body: '点击托盘图标可重新打开',
    });
    expect(hoisted.notificationInstances[0].show).toHaveBeenCalled();

    const second = { preventDefault: vi.fn() };
    win.emit('close', second);
    expect(second.preventDefault).toHaveBeenCalled();
    expect(win.hide).toHaveBeenCalledTimes(2);
    expect(hoisted.notificationInstances).toHaveLength(1);

    main.setQuitting();
    const third = { preventDefault: vi.fn() };
    win.emit('close', third);
    expect(third.preventDefault).not.toHaveBeenCalled();
  });

  it('通知不受支持时不创建 Notification', async () => {
    hoisted.state.notificationSupported = false;
    await loadMain();
    const win = hoisted.windowInstances[0];
    win.emit('close', { preventDefault: vi.fn() });
    expect(hoisted.notificationInstances).toHaveLength(0);
  });

  it('closed 清空 mainWindow，second-instance 处理最小化/聚焦', async () => {
    await loadMain();
    const win = hoisted.windowInstances[0];
    const handler = appHandler('second-instance');

    win.minimized = true;
    handler();
    expect(win.restore).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalledTimes(1);

    win.minimized = false;
    handler();
    expect(win.focus).toHaveBeenCalledTimes(2);

    win.emit('closed');
    expect(() => handler()).not.toThrow();
  });

  it('activate 在无窗口时重建，有窗口时显示', async () => {
    await loadMain();
    const win = hoisted.windowInstances[0];
    const activate = appHandler('activate');

    hoisted.classes.BrowserWindow.getAllWindows.mockReturnValueOnce([]);
    activate();
    await flush();
    expect(hoisted.windowInstances).toHaveLength(2);
    const second = hoisted.windowInstances[1];

    hoisted.classes.BrowserWindow.getAllWindows.mockReturnValueOnce([win]);
    activate();
    expect(second.show).toHaveBeenCalled();
  });

  it('window-all-closed 在非 macOS 保持托盘运行（不退出）', async () => {
    await loadMain();
    expect(() => appHandler('window-all-closed')()).not.toThrow();
    expect(hoisted.state.appQuit).not.toHaveBeenCalled();
  });

  it('Windows 下使用 .ico 图标', async () => {
    setPlatform('win32');
    await loadMain();
    expect(hoisted.windowInstances[0].options.icon.endsWith('llama.ico')).toBe(true);
  });

  it('设置 METONA_DEV_URL 时加载开发服务器', async () => {
    process.env.METONA_DEV_URL = 'http://localhost:5173';
    await loadMain();
    const win = hoisted.windowInstances[0];
    expect(win.loadURL).toHaveBeenCalledWith('http://localhost:5173');
    expect(win.loadFile).not.toHaveBeenCalled();
  });

  it('安装安全响应头并保留原响应头', async () => {
    await loadMain();
    expect(hoisted.headerHandlers).toHaveLength(1);
    const callback = vi.fn();
    hoisted.headerHandlers[0]({ responseHeaders: { 'X-Test': ['1'] } }, callback);
    const headers = callback.mock.calls[0][0].responseHeaders;
    expect(headers['X-Test']).toEqual(['1']);
    expect(headers['X-Content-Type-Options']).toEqual(['nosniff']);
    expect(headers['Content-Security-Policy'][0]).toContain("default-src 'self'");
    expect(headers['Content-Security-Policy'][0]).toContain("frame-ancestors 'none'");
    expect(headers['Content-Security-Policy'][0]).toContain("object-src 'none'");

    const noHeaders = vi.fn();
    hoisted.headerHandlers[0]({}, noHeaders);
    expect(noHeaders.mock.calls[0][0].responseHeaders['Content-Security-Policy']).toBeTruthy();
  });

  it('setWindowOpenHandler 只允许 http/https 交给系统浏览器并始终 deny', async () => {
    await loadMain();
    const win = hoisted.windowInstances[0];
    expect(win.windowOpenHandler).toBeTypeOf('function');

    expect(win.windowOpenHandler!({ url: 'https://example.com' })).toEqual({ action: 'deny' });
    expect(hoisted.state.openExternal).toHaveBeenCalledWith('https://example.com');
    expect(win.windowOpenHandler!({ url: 'http://example.com' })).toEqual({ action: 'deny' });
    expect(hoisted.state.openExternal).toHaveBeenCalledTimes(2);

    expect(win.windowOpenHandler!({ url: 'file:///etc/passwd' })).toEqual({ action: 'deny' });
    expect(hoisted.state.openExternal).toHaveBeenCalledTimes(2);
  });
});

describe('main entry: before-quit cleanup', () => {
  it('preventDefault 后执行一次性清理并最终 quit', async () => {
    await loadMain();
    const handler = appHandler('before-quit');
    const event = { preventDefault: vi.fn() };

    handler(event);
    handler(event);
    expect(event.preventDefault).toHaveBeenCalledTimes(2);
    await flush();

    expect(hoisted.state.flushDatabase).toHaveBeenCalledTimes(1);
    expect(hoisted.state.abortAllOllamaStreams).toHaveBeenCalledTimes(1);
    expect(hoisted.state.browserClose).toHaveBeenCalledTimes(1);
    expect(hoisted.state.stopAllServers).toHaveBeenCalledTimes(1);
    expect(hoisted.state.killAllProcesses).toHaveBeenCalledTimes(1);
    expect(hoisted.state.unloadModelsOnExit).toHaveBeenCalledWith(5000);
    expect(hoisted.windowInstances[0].webContents.send).toHaveBeenCalledWith('app-quit');
    expect(hoisted.state.appQuit).toHaveBeenCalledTimes(1);

    const after = { preventDefault: vi.fn() };
    handler(after);
    expect(after.preventDefault).not.toHaveBeenCalled();
    expect(hoisted.state.flushDatabase).toHaveBeenCalledTimes(1);
  });

  it('各清理步骤抛错时仍完成退出', async () => {
    hoisted.state.flushDatabase.mockImplementation(() => {
      throw new Error('flush');
    });
    hoisted.state.abortAllOllamaStreams.mockImplementation(() => {
      throw new Error('abort');
    });
    hoisted.state.browserClose.mockImplementation(async () => {
      throw new Error('browser');
    });
    hoisted.state.stopAllServers.mockImplementation(() => {
      throw new Error('mcp');
    });
    hoisted.state.killAllProcesses.mockImplementation(() => {
      throw new Error('kill');
    });
    hoisted.state.unloadModelsOnExit.mockImplementation(async () => {
      throw new Error('unload');
    });
    await loadMain();
    hoisted.windowInstances[0].webContents.send.mockImplementation(() => {
      throw new Error('destroyed');
    });

    const handler = appHandler('before-quit');
    handler({ preventDefault: vi.fn() });
    await flush();

    expect(hoisted.state.unloadModelsOnExit).toHaveBeenCalled();
    expect(hoisted.state.appQuit).toHaveBeenCalledTimes(1);
  });
});

describe('main entry: menu / tray / window-state / utils', () => {
  it('菜单文件操作发送 menu-action，退出菜单设置 quitting 并 quit', async () => {
    await loadMain();
    const win = hoisted.windowInstances[0];
    const menu = appMenuTemplate();

    findMenuItem(menu, '新建会话').click();
    findMenuItem(menu, '导入会话').click();
    findMenuItem(menu, '导出会话').click();
    findMenuItem(menu, '使用帮助').click();
    expect(win.webContents.send).toHaveBeenCalledWith('menu-action', 'new-chat');
    expect(win.webContents.send).toHaveBeenCalledWith('menu-action', 'import');
    expect(win.webContents.send).toHaveBeenCalledWith('menu-action', 'export');
    expect(win.webContents.send).toHaveBeenCalledWith('menu-action', 'help');

    findMenuItem(menu, '退出').click();
    expect(hoisted.state.appQuit).toHaveBeenCalled();
  });

  it('菜单窗口操作：最大化/还原、置顶、关于', async () => {
    await loadMain();
    const win = hoisted.windowInstances[0];
    const menu = appMenuTemplate();

    win.maximized = true;
    findMenuItem(menu, '最大化/还原').click();
    expect(win.unmaximize).toHaveBeenCalled();
    win.maximized = false;
    findMenuItem(menu, '最大化/还原').click();
    expect(win.maximize).toHaveBeenCalled();

    findMenuItem(menu, '置顶').click({ checked: true });
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(true);
    findMenuItem(menu, '置顶').click({ checked: false });
    expect(win.setAlwaysOnTop).toHaveBeenCalledWith(false);

    findMenuItem(menu, '关于 Ollama').click();
    expect(hoisted.state.openExternal).toHaveBeenCalledWith('https://ollama.com');

    findMenuItem(menu, '关于 Metona').click();
    expect(hoisted.state.showMessageBox).toHaveBeenCalledWith(
      win,
      expect.objectContaining({
        type: 'info',
        title: '关于 Metona Ollama',
        message: 'Metona Ollama Desktop v0.18.0',
        icon: expect.stringContaining(path.join('assets', 'icons', 'llama.png')),
      }),
    );
  });

  it('开发模式显示 Dev 菜单并可切换开发者工具；打包后隐藏', async () => {
    await loadMain();
    const menu = appMenuTemplate();
    const dev = findMenuItem(menu, '切换开发者工具');
    expect(dev).toBeTruthy();
    dev.click();
    expect(hoisted.windowInstances[0].webContents.toggleDevTools).toHaveBeenCalled();

    hoisted.menuTemplates.length = 0;
    hoisted.state.isPackaged = true;
    await loadMain();
    expect(findMenuItem(appMenuTemplate(), 'Dev')).toBeUndefined();
  });

  it('托盘菜单打开/新建/退出与双击行为', async () => {
    await loadMain();
    const tray = hoisted.trayInstances[0];
    const win = hoisted.windowInstances[0];

    expect(tray.icon).toEqual({ resized: true });
    expect(hoisted.state.createFromPath).toHaveBeenCalledWith(
      expect.stringContaining(path.join('assets', 'icons', 'llama.png')),
    );
    expect(tray.setToolTip).toHaveBeenCalledWith('Metona Ollama');
    const contextMenu = tray.setContextMenu.mock.calls[0][0].template;

    findMenuItem(contextMenu, '打开 Metona').click();
    expect(win.show).toHaveBeenCalled();
    expect(win.focus).toHaveBeenCalled();

    findMenuItem(contextMenu, '新建会话').click();
    expect(win.webContents.send).toHaveBeenCalledWith('tray-action', 'new-chat');

    tray.handlers.get('double-click')();
    expect(win.show).toHaveBeenCalledTimes(3);
    expect(win.focus).toHaveBeenCalledTimes(3);

    findMenuItem(contextMenu, '退出').click();
    expect(hoisted.state.appQuit).toHaveBeenCalled();
  });

  it('主窗口关闭后菜单/托盘点击不抛错', async () => {
    await loadMain();
    const win = hoisted.windowInstances[0];
    win.emit('closed');
    const menu = appMenuTemplate();
    const tray = hoisted.trayInstances[0];
    const contextMenu = tray.setContextMenu.mock.calls[0][0].template;

    expect(() => findMenuItem(menu, '新建会话').click()).not.toThrow();
    expect(() => findMenuItem(menu, '最大化/还原').click()).not.toThrow();
    expect(() => findMenuItem(contextMenu, '打开 Metona').click()).not.toThrow();
    expect(() => tray.handlers.get('double-click')()).not.toThrow();
  });

  it('window-state 初始值、setter 与图标路径', async () => {
    vi.resetModules();
    const ws = await import('../src/main/window-state.js');
    expect(ws.mainWindow).toBeNull();
    expect(ws.isQuitting).toBe(false);

    const fake = { id: 1 };
    ws.setMainWindow(fake as any);
    expect(ws.mainWindow).toBe(fake);
    ws.setQuitting();
    expect(ws.isQuitting).toBe(true);
    ws.setMainWindow(null);
    expect(ws.mainWindow).toBeNull();

    expect(ws.getIconPath()).toBe(path.join(process.cwd(), 'assets', 'icons', 'llama.png'));
    setPlatform('win32');
    expect(ws.getIconPath()).toBe(path.join(process.cwd(), 'assets', 'icons', 'llama.ico'));
  });

  it('utils showNotification 根据支持状态创建通知', async () => {
    vi.resetModules();
    const utils = await import('../src/main/utils.js');
    utils.showNotification('标题', '内容');
    expect(hoisted.notificationInstances).toHaveLength(1);
    expect(hoisted.notificationInstances[0].options).toMatchObject({ title: '标题', body: '内容' });
    expect(hoisted.notificationInstances[0].show).toHaveBeenCalled();

    hoisted.state.notificationSupported = false;
    utils.showNotification('再试', '不应出现');
    expect(hoisted.notificationInstances).toHaveLength(1);
  });
});
