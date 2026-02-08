import { existsSync } from "fs";
import { join } from "path";
import { ItemView, Plugin, WorkspaceLeaf } from "obsidian";
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
    return "Ghostty terminal";
  }

  getIcon(): string {
    return "terminal";
  }

  async onOpen(): Promise<void> {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.addClass("ghostty-terminal-view");

    this.bodyEl = contentEl;

    const nativeState = await Promise.resolve(this.plugin.getNativeState(true));

    if (nativeState.native) {
      this.startSession(nativeState.native);
    } else {
      contentEl.createEl("div", {
        cls: "ghostty-terminal-placeholder",
        text: nativeState.message,
      });
    }
  }

  async onClose(): Promise<void> {
    await Promise.resolve();
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
      // eslint-disable-next-line @typescript-eslint/no-require-imports, @typescript-eslint/no-var-requires -- Native node-pty module needs runtime require() for dynamic path resolution in Electron
      ({ spawn: spawnPty } = require(nodePtyPath) as typeof import("node-pty"));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.bodyEl?.createEl("div", {
        cls: "ghostty-terminal-placeholder",
        text: `Failed to load node-pty: ${message}`,
      });
      return;
    }

    const shell =
      process.env.SHELL ||
      (process.platform === "win32" ? "powershell.exe" : "/bin/zsh");

    const adapter = this.app.vault.adapter as { getBasePath?: () => string };
    const cwd: string =
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

    this.resizeObserver = new ResizeObserver(() => {
      // Invalidate char size cache on resize
      this.charSize = null;
      this.updateSize();
    });
    this.resizeObserver.observe(screen);

    // Delay initial render to ensure styles are applied
    requestAnimationFrame(() => {
      this.charSize = null; // Re-measure after styles are applied
      this.scheduleRender();
    });
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
      this.screenEl.removeEventListener("scroll", this.handleScroll);
      this.screenEl.removeEventListener("wheel", this.handleWheel);
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
    span.addClass("ghostty-char-measure");
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

  focusInput(): void {
    this.inputEl?.focus();
  }

  private updateCaret(): void {
    if (!this.screenEl || !this.vt) return;
    const cursor = this.vt.cursorPosition();
    if (!cursor?.valid) {
      this.screenEl.setCssProps({ "--ghostty-caret-visible": "0" });
      return;
    }
    
    // Hide caret when scrolled away from the active screen
    if (!this.autoScroll) {
      this.screenEl.setCssProps({ "--ghostty-caret-visible": "0" });
      return;
    }
    
    const { width, height } = this.getCharSize();
    // Cursor position is 1-indexed from VT, convert to 0-indexed pixels
    const x = (cursor.col - 1) * width;
    const y = (cursor.row - 1) * height;
    this.screenEl.setCssProps({
      "--ghostty-caret-x": `${x}px`,
      "--ghostty-caret-y": `${y}px`,
      "--ghostty-caret-w": `${width}px`,
      "--ghostty-caret-h": `${height}px`,
      "--ghostty-caret-visible": "1",
    });
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
        if (linesToScroll < 0) {
          this.autoScroll = false;
        } else {
          // Scrolling down - re-enable autoScroll
          this.autoScroll = true;
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
    
    // Only handle when our input is focused
    if (document.activeElement !== this.inputEl) return;

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

    // Cmd+Backspace = Ctrl+U (kill line backward)
    if (event.metaKey && event.key === "Backspace") {
      data = "\x15";
    // Cmd+A = Ctrl+A (beginning of line)
    } else if (event.metaKey && event.key.toLowerCase() === "a") {
      data = "\x01";
    // Cmd+E = Ctrl+E (end of line)
    } else if (event.metaKey && event.key.toLowerCase() === "e") {
      data = "\x05";
    // Cmd+K = Ctrl+K (kill to end of line)
    } else if (event.metaKey && event.key.toLowerCase() === "k") {
      data = "\x0b";
    // Cmd+U = Ctrl+U (kill to beginning of line)
    } else if (event.metaKey && event.key.toLowerCase() === "u") {
      data = "\x15";
    // Cmd+L = Ctrl+L (clear screen)
    } else if (event.metaKey && event.key.toLowerCase() === "l") {
      data = "\x0c";
    // Option+Left = move back one word (Esc+b)
    } else if (event.altKey && event.key === "ArrowLeft") {
      data = "\x1bb";
    // Option+Right = move forward one word (Esc+f)
    } else if (event.altKey && event.key === "ArrowRight") {
      data = "\x1bf";
    // Option+Backspace = delete word backward (Esc+Backspace)
    } else if (event.altKey && event.key === "Backspace") {
      data = "\x1b\x7f";
    // Option+D = delete word forward
    } else if (event.altKey && event.key.toLowerCase() === "d") {
      data = "\x1bd";
    } else if (event.ctrlKey && event.key.length === 1) {
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
    // Home = beginning of line
    } else if (event.key === "Home") {
      data = "\x1b[H";
    // End = end of line  
    } else if (event.key === "End") {
      data = "\x1b[F";
    // Delete key
    } else if (event.key === "Delete") {
      data = "\x1b[3~";
    }

    if (data) {
      this.pty.write(data);
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
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
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    } else if (event.key === "End" && event.shiftKey) {
      // Scroll to bottom
      this.vt.scrollViewport(10000);
      this.autoScroll = true;
      this.scheduleRender();
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      return true;
    }

    if (delta !== 0) {
      const result = this.vt.scrollViewport(delta);
      if (result === 0) {
        this.autoScroll = delta > 0; // true if scrolling down, false if up
        this.scheduleRender();
      }
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
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
    this.registerView(VIEW_TYPE_GHOSTTY, (leaf: WorkspaceLeaf) => {
      return new GhosttyTerminalView(leaf, this);
    });

    this.addCommand({
      id: "open",
      name: "Open",
      callback: () => {
        this.activateView().catch(console.error);
      },
    });

    this.addCommand({
      id: "toggle",
      name: "Toggle terminal",
      hotkeys: [{ modifiers: ["Mod"], key: "j" }],
      callback: () => {
        this.toggleView().catch(console.error);
      },
    });

    await Promise.resolve();
  }

  onunload(): void {
    // Views are cleaned up automatically by Obsidian
  }

  private async toggleView(): Promise<void> {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);

    if (existingLeaves.length > 0) {
      const leaf = existingLeaves[0];
      // If the terminal is focused, close it; otherwise reveal it
      if (workspace.activeLeaf === leaf) {
        leaf.detach();
        return;
      }
      await workspace.revealLeaf(leaf);
      const view = leaf.view;
      if (view instanceof GhosttyTerminalView) {
        view.focusInput();
      }
      return;
    }

    await this.activateView();
  }

  private async activateView(): Promise<void> {
    const { workspace } = this.app;
    const existingLeaves = workspace.getLeavesOfType(VIEW_TYPE_GHOSTTY);

    if (existingLeaves.length > 0) {
      await workspace.revealLeaf(existingLeaves[0]);
      const view = existingLeaves[0].view;
      if (view instanceof GhosttyTerminalView) {
        view.focusInput();
      }
      return;
    }

    const leaf = workspace.getLeaf("split", "horizontal");
    await leaf.setViewState({ type: VIEW_TYPE_GHOSTTY, active: true });
    await workspace.revealLeaf(leaf);

    // Focus the terminal input after it opens
    setTimeout(() => {
      const view = leaf.view;
      if (view instanceof GhosttyTerminalView) {
        view.focusInput();
      }
    }, 100);
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
          join(basePath, this.app.vault.configDir, "plugins", this.manifest.id)
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
