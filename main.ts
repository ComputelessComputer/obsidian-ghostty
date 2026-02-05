import { existsSync } from "fs";
import { join } from "path";
import { ItemView, Notice, Plugin, WorkspaceLeaf } from "obsidian";
import type { IPty } from "node-pty";
import {
  tryLoadGhosttyNative,
  type GhosttyNative,
  type GhosttyNativeState,
  type GhosttyTerminal,
} from "./native/ghostty";

const VIEW_TYPE_GHOSTTY = "ghostty-terminal-view";

class GhosttyTerminalView extends ItemView {
  private pty: IPty | null = null;
  private vt: GhosttyTerminal | null = null;
  private outputEl: HTMLPreElement | null = null;
  private bodyEl: HTMLElement | null = null;
  private screenEl: HTMLElement | null = null;
  private statusEl: HTMLElement | null = null;
  private inputEl: HTMLTextAreaElement | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private pendingRender = false;
  private charSize: { width: number; height: number } | null = null;
  private autoScroll = true;
  private composing = false;
  private compositionBuffer = "";
  private scrollLines = 0;

  constructor(leaf: WorkspaceLeaf, private plugin: GhosttyPlugin) {
    super(leaf);
  }
  getViewType(): string {
    return VIEW_TYPE_GHOSTTY;
  }

  getDisplayText(): string {
    return "Ghostty Terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghostty-terminal-view");
    console.info("[ghostty] terminal view opened");

    contentEl.createEl("div", {
      cls: "ghostty-terminal-header",
      text: "Ghostty Terminal",
    });

    const body = contentEl.createEl("div", {
      cls: "ghostty-terminal-body",
    });
    this.bodyEl = body;

    const nativeState = this.plugin.getNativeState(true);
    this.statusEl = body.createEl("div", {
      cls: "ghostty-terminal-status",
      text: nativeState.message,
    });

    if (nativeState.native) {
      this.startSession(nativeState.native);
    } else {
      body.createEl("div", {
        cls: "ghostty-terminal-placeholder",
        text: "Native backend not loaded yet.",
      });
    }
  }

  async onClose(): Promise<void> {
    this.stopSession();
    this.contentEl.empty();
  }

  private startSession(native: GhosttyNative): void {
    if (!this.bodyEl) return;
    this.stopSession();

    const screen = this.bodyEl.createEl("div", {
      cls: "ghostty-terminal-screen",
    });
    this.screenEl = screen;
    this.outputEl = screen.createEl("pre", {
      cls: "ghostty-terminal-output",
    });

    const input = this.bodyEl.createEl("textarea", {
      cls: "ghostty-terminal-input",
    });
    input.spellcheck = false;
    input.autocapitalize = "off";
    input.autocomplete = "off";
    input.autocorrect = "off";
    this.inputEl = input;

    const { cols, rows } = this.measureSize();
    this.vt = native.createTerminal(cols, rows);

    let spawnPty: typeof import("node-pty").spawn;
    try {
      const pluginDir = this.plugin.getPluginDirPath();
      const nodePtyPath = pluginDir
        ? join(pluginDir, "node_modules", "node-pty")
        : "node-pty";
      // eslint-disable-next-line @typescript-eslint/no-var-requires
      ({ spawn: spawnPty } = require(nodePtyPath) as typeof import("node-pty"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.statusEl?.setText(
        `Failed to load node-pty: ${message}. Ensure node_modules is present in the plugin folder.`
      );
      return;
    }

    const shell =
      process.env.SHELL ||
      (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const cwd =
      adapter.getBasePath?.() || process.env.HOME || process.cwd() || "/";

    this.pty = spawnPty(shell, [], {
      name: "xterm-256color",
      cols,
      rows,
      cwd,
      env: process.env as Record<string, string>,
    });

    this.pty.onData((data) => {
      if (!this.vt) return;
      this.vt.feed(data);
      this.scheduleRender();
    });

    this.bodyEl.tabIndex = 0;
    this.bodyEl.addEventListener("mousedown", this.focusTerminal);
    this.bodyEl.addEventListener("click", this.focusTerminal);
    this.screenEl.addEventListener("scroll", this.handleScroll, { passive: true });
    this.screenEl.addEventListener("wheel", this.handleWheel, { passive: false });
    this.inputEl.addEventListener("keydown", this.handleKeyDown, true);
    this.inputEl.addEventListener("paste", this.handlePaste, true);
    this.inputEl.addEventListener("input", this.handleInput, true);
    this.inputEl.addEventListener(
      "compositionstart",
      this.handleCompositionStart,
      true
    );
    this.inputEl.addEventListener(
      "compositionupdate",
      this.handleCompositionUpdate,
      true
    );
    this.inputEl.addEventListener(
      "compositionend",
      this.handleCompositionEnd,
      true
    );
    this.inputEl.addEventListener("focus", this.handleFocus);
    this.inputEl.addEventListener("blur", this.handleBlur);
    this.inputEl.focus();

    this.resizeObserver = new ResizeObserver(() => this.updateSize());
    this.resizeObserver.observe(screen);

    this.scheduleRender();
  }

  private stopSession(): void {
    if (this.bodyEl) {
      this.bodyEl.removeEventListener("mousedown", this.focusTerminal);
      this.bodyEl.removeEventListener("click", this.focusTerminal);
    }
    if (this.resizeObserver) {
      this.resizeObserver.disconnect();
      this.resizeObserver = null;
    }
    if (this.pty) {
      try {
        this.pty.kill();
      } catch {
        // ignore
      }
      this.pty = null;
    }
    if (this.vt) {
      this.vt.free();
      this.vt = null;
    }
    if (this.screenEl) {
      this.screenEl.removeEventListener("scroll", this.handleScroll as EventListener);
      this.screenEl.removeEventListener("wheel", this.handleWheel as EventListener);
    }
    if (this.inputEl) {
      this.inputEl.removeEventListener("keydown", this.handleKeyDown, true);
      this.inputEl.removeEventListener("paste", this.handlePaste, true);
      this.inputEl.removeEventListener("input", this.handleInput, true);
      this.inputEl.removeEventListener(
        "compositionstart",
        this.handleCompositionStart,
        true
      );
      this.inputEl.removeEventListener(
        "compositionupdate",
        this.handleCompositionUpdate,
        true
      );
      this.inputEl.removeEventListener(
        "compositionend",
        this.handleCompositionEnd,
        true
      );
      this.inputEl.removeEventListener("focus", this.handleFocus);
      this.inputEl.removeEventListener("blur", this.handleBlur);
    }
    this.outputEl = null;
    this.screenEl = null;
    this.inputEl = null;
    this.pendingRender = false;
    this.charSize = null;
    this.autoScroll = true;
    this.composing = false;
    this.compositionBuffer = "";
    this.scrollLines = 0;
  }

  private scheduleRender(): void {
    if (this.pendingRender || !this.outputEl || !this.vt) return;
    this.pendingRender = true;
    requestAnimationFrame(() => {
      this.pendingRender = false;
      if (!this.outputEl || !this.vt) return;
      this.outputEl.setText(this.vt.dumpViewport());
      this.updateCaret();
      const container = this.screenEl;
      if (container && this.autoScroll) {
        container.scrollTop = container.scrollHeight;
      }
    });
  }

  private updateSize(): void {
    if (!this.vt || !this.pty) return;
    const { cols, rows } = this.measureSize();
    this.vt.resize(cols, rows);
    this.pty.resize(cols, rows);
    this.scheduleRender();
  }

  private measureSize(): { cols: number; rows: number } {
    const target = this.screenEl ?? this.bodyEl;
    if (!target) {
      return { cols: 80, rows: 24 };
    }
    const rect = target.getBoundingClientRect();
    const { width, height } = this.getCharSize();
    const cols = Math.max(2, Math.floor(rect.width / width));
    const rows = Math.max(2, Math.floor((rect.height - 12) / height));
    return { cols, rows };
  }

  private getCharSize(): { width: number; height: number } {
    if (this.charSize) return this.charSize;
    const target = this.outputEl ?? this.bodyEl;
    if (!target) {
      return { width: 8, height: 16 };
    }
    // Use a longer string and divide for more accurate measurement
    const testString = "MMMMMMMMMM";
    const span = document.createElement("span");
    span.textContent = testString;
    span.style.visibility = "hidden";
    span.style.position = "absolute";
    span.style.whiteSpace = "pre";
    span.style.margin = "0";
    span.style.padding = "0";
    span.style.border = "none";
    const style = getComputedStyle(target);
    span.style.fontFamily = style.fontFamily || "var(--font-monospace)";
    span.style.fontSize = style.fontSize || "12px";
    span.style.lineHeight = style.lineHeight || "1.2";
    span.style.letterSpacing = style.letterSpacing || "normal";
    target.appendChild(span);
    const rect = span.getBoundingClientRect();
    span.remove();
    this.charSize = {
      width: (rect.width / testString.length) || 8,
      height: rect.height || 16,
    };
    return this.charSize;
  }

  private focusTerminal = (): void => {
    this.inputEl?.focus();
  };

  private updateCaret(): void {
    if (!this.screenEl || !this.vt) return;
    const cursor = this.vt.cursorPosition();
    if (!cursor?.valid) return;
    const { width, height } = this.getCharSize();
    // Cursor position is 1-indexed from VT, convert to 0-indexed pixels
    const x = (cursor.col - 1) * width;
    const y = (cursor.row - 1) * height;
    this.screenEl.style.setProperty("--ghostty-caret-x", `${x}px`);
    this.screenEl.style.setProperty("--ghostty-caret-y", `${y}px`);
    this.screenEl.style.setProperty("--ghostty-caret-w", `${width}px`);
    this.screenEl.style.setProperty("--ghostty-caret-h", `${height}px`);
  }

  private handleFocus = (): void => {
    this.screenEl?.addClass("is-focused");
  };

  private handleBlur = (): void => {
    this.screenEl?.removeClass("is-focused");
  };

  private handleScroll = (): void => {
    this.updateCaret();
  };

  private handleWheel = (event: WheelEvent): void => {
    if (!this.vt) return;
    event.preventDefault();

    const { height } = this.getCharSize();
    this.scrollLines += event.deltaY;

    const linesToScroll = Math.trunc(this.scrollLines / height);
    if (linesToScroll !== 0) {
      this.scrollLines -= linesToScroll * height;
      // Negative = scroll up (show older content), positive = scroll down
      const result = this.vt.scrollViewport(linesToScroll);
      if (result === 0) {
        // Reset auto-scroll if user scrolls up
        if (linesToScroll < 0) {
          this.autoScroll = false;
        }
        this.scheduleRender();
      }
    }
  };

  private handlePaste = (event: ClipboardEvent): void => {
    if (!this.pty) return;
    const text = event.clipboardData?.getData("text");
    if (text) {
      this.pty.write(text);
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private handleKeyDown = (event: KeyboardEvent): void => {
    if (!this.pty) return;

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
      return;
    }
    if (event.isComposing || event.key === "Process") {
      return;
    }

    // Handle scroll keys with Shift modifier or Page Up/Down
    if (this.handleScrollKey(event)) {
      return;
    }

    let data: string | null = null;

    if (event.ctrlKey && event.key.length === 1) {
      const code = event.key.toUpperCase().charCodeAt(0) - 64;
      if (code >= 1 && code <= 26) {
        data = String.fromCharCode(code);
      }
    } else if (event.key === "Enter") {
      data = "\r";
    } else if (event.key === "Backspace") {
      data = "\x7f";
    } else if (event.key === "Tab") {
      data = "\t";
    } else if (event.key === "Escape") {
      data = "\x1b";
    } else if (event.key === "ArrowUp") {
      data = "\x1b[A";
    } else if (event.key === "ArrowDown") {
      data = "\x1b[B";
    } else if (event.key === "ArrowRight") {
      data = "\x1b[C";
    } else if (event.key === "ArrowLeft") {
      data = "\x1b[D";
    }

    if (data) {
      this.pty.write(data);
      event.preventDefault();
      event.stopPropagation();
    }
  };

  private handleScrollKey(event: KeyboardEvent): boolean {
    if (!this.vt) return false;

    let delta = 0;
    const pageSize = this.measureSize().rows - 1;

    if (event.key === "PageUp") {
      delta = -pageSize;
    } else if (event.key === "PageDown") {
      delta = pageSize;
    } else if (event.shiftKey && event.key === "ArrowUp") {
      delta = -1;
    } else if (event.shiftKey && event.key === "ArrowDown") {
      delta = 1;
    } else if (event.key === "Home" && event.shiftKey) {
      // Scroll to top
      this.vt.scrollViewport(-10000);
      this.autoScroll = false;
      this.scheduleRender();
      event.preventDefault();
      return true;
    } else if (event.key === "End" && event.shiftKey) {
      // Scroll to bottom
      this.vt.scrollViewport(10000);
      this.autoScroll = true;
      this.scheduleRender();
      event.preventDefault();
      return true;
    }

    if (delta !== 0) {
      const result = this.vt.scrollViewport(delta);
      if (result === 0) {
        if (delta < 0) this.autoScroll = false;
        this.scheduleRender();
      }
      event.preventDefault();
      return true;
    }

    return false;
  };

  private handleInput = (): void => {
    if (!this.pty || !this.inputEl || this.composing) return;
    const value = this.inputEl.value;
    if (value.length > 0) {
      this.pty.write(value);
      this.inputEl.value = "";
    }
  };

  private handleCompositionStart = (): void => {
    this.composing = true;
    this.compositionBuffer = "";
  };

  private handleCompositionUpdate = (event: CompositionEvent): void => {
    this.compositionBuffer = event.data ?? "";
  };

  private handleCompositionEnd = (event: CompositionEvent): void => {
    if (!this.pty || !this.inputEl) return;
    const text = event.data ?? this.compositionBuffer;
    if (text) {
      this.pty.write(text);
    }
    this.inputEl.value = "";
    this.composing = false;
    this.compositionBuffer = "";
  };
}

export default class GhosttyPlugin extends Plugin {
  private nativeState: GhosttyNativeState | null = null;
  async onload(): Promise<void> {
    console.info("[ghostty] plugin loaded");
    new Notice("Ghostty plugin loaded");
    this.registerView(VIEW_TYPE_GHOSTTY, (leaf: WorkspaceLeaf) => {
      return new GhosttyTerminalView(leaf, this);
    });

    this.addCommand({
      id: "open-ghostty-terminal",
      name: "Open Ghostty Terminal",
      hotkeys: [{ modifiers: ["Mod"], key: "J" }],
      callback: () => this.activateView(),
    });
  }

  async onunload(): Promise<void> {
    this.app.workspace.detachLeavesOfType(VIEW_TYPE_GHOSTTY);
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);
    if (existingLeaves.length > 0) {
      workspace.detachLeavesOfType(VIEW_TYPE_GHOSTTY);
      return;
    }

    let leaf = workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY)[0];

    if (!leaf) {
      const splitLeaf = (workspace as any).getLeaf?.(
        "split",
        "horizontal"
      ) as WorkspaceLeaf | undefined;
      leaf = splitLeaf ?? workspace.getRightLeaf(false);
      await leaf.setViewState({ type: VIEW_TYPE_GHOSTTY, active: true });
    }
    workspace.revealLeaf(leaf);
  }

  getNativeState(refresh = false): GhosttyNativeState {
    if (refresh || !this.nativeState || !this.nativeState.native) {
      this.nativeState = tryLoadGhosttyNative(this.resolvePluginDir());
    }
    return this.nativeState;
  }

  getPluginDirPath(): string {
    return this.resolvePluginDir();
  }

  private resolvePluginDir(): string {
    const candidates: string[] = [];
    const manifestDir = (this.manifest as { dir?: string }).dir;
    if (manifestDir) {
      candidates.push(manifestDir);
    }

    const adapter = this.app.vault.adapter as {
      getBasePath?: () => string;
    };
    if (adapter.getBasePath) {
      const basePath = adapter.getBasePath();
      if (basePath) {
        candidates.push(
          join(basePath, ".obsidian", "plugins", this.manifest.id)
        );
      }
    }

    for (const dir of candidates) {
      if (existsSync(join(dir, "manifest.json"))) {
        return dir;
      }
    }

    return candidates[0] ?? "";
  }
}
