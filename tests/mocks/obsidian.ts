/**
 * Mock implementations for Obsidian API.
 * @module tests/mocks/obsidian
 */

/**
 * Mock Plugin class.
 */
export class Plugin {
    app: App;
    manifest: PluginManifest | null = null;

    constructor(app: App, manifest: PluginManifest) {
        this.app = app;
        this.manifest = manifest;
    }

    addCommand(_command: Command): Command {
        return _command;
    }

    addRibbonIcon(_icon: string, _title: string, _callback: () => void): HTMLElement {
        return document.createElement('div');
    }

    addSettingTab(_settingTab: PluginSettingTab): void {
        // Mock implementation
    }

    addStatusBarItem(): HTMLElement {
        return document.createElement('div');
    }

    async loadData(): Promise<unknown> {
        return {};
    }

    async saveData(_data: unknown): Promise<void> {
        // Mock implementation
    }
}

/**
 * Mock App class.
 */
export class App {
    vault: Vault = new Vault();
    workspace: Workspace = new Workspace();
}

/**
 * Mock Vault class.
 */
export class Vault {
    adapter = {
        exists: async (_path: string): Promise<boolean> => false,
    };

    async createBinary(_path: string, _data: ArrayBuffer): Promise<void> {
        // Mock implementation
    }

    getRoot(): TFolder {
        return new TFolder('');
    }

    static recurseChildren(_root: TFolder, _callback: (file: TAbstractFile) => void): void {
        // Mock implementation
    }
}

/**
 * Mock Workspace class.
 */
export class Workspace {
    getActiveViewOfType<T>(_type: new (...args: unknown[]) => T): T | null {
        return null;
    }
}

/**
 * Mock Notice class.
 */
export class Notice {
    constructor(_message: string, _timeout?: number) {
        // Mock implementation
    }
}

/**
 * Mock Modal class.
 */
export class Modal {
    app: App;
    contentEl: HTMLElement = document.createElement('div');

    constructor(app: App) {
        this.app = app;
    }

    open(): void {
        // Mock implementation
    }

    close(): void {
        // Mock implementation
    }

    onOpen(): void {
        // Mock implementation
    }

    onClose(): void {
        // Mock implementation
    }
}

/**
 * Mock Setting class.
 */
export class Setting {
    settingEl: HTMLElement;
    nameEl: HTMLElement;
    descEl: HTMLElement;

    constructor(_containerEl: HTMLElement) {
        this.settingEl = document.createElement('div');
        this.nameEl = document.createElement('div');
        this.descEl = document.createElement('div');
    }

    setName(_name: string): this {
        return this;
    }

    setDesc(_desc: string): this {
        return this;
    }

    setHeading(): this {
        return this;
    }

    addText(_callback: (text: TextComponent) => void): this {
        return this;
    }

    addToggle(_callback: (toggle: ToggleComponent) => void): this {
        return this;
    }

    addDropdown(_callback: (dropdown: DropdownComponent) => void): this {
        return this;
    }

    addSlider(_callback: (slider: SliderComponent) => void): this {
        return this;
    }
}

/**
 * Mock PluginSettingTab class.
 */
export class PluginSettingTab {
    app: App;
    containerEl: HTMLElement = document.createElement('div');
    plugin: Plugin;

    constructor(app: App, plugin: Plugin) {
        this.app = app;
        this.plugin = plugin;
    }

    display(): void {
        // Mock implementation
    }

    hide(): void {
        // Mock implementation
    }
}

/**
 * Mock MarkdownView class.
 */
export class MarkdownView {
    editor: Editor | null = null;
}

/**
 * Mock Editor class.
 */
export class Editor {
    replaceSelection(_text: string): void {
        // Mock implementation
    }
}

/**
 * Mock TAbstractFile class.
 */
export class TAbstractFile {
    path: string;

    constructor(path: string) {
        this.path = path;
    }
}

/**
 * Mock TFolder class.
 */
export class TFolder extends TAbstractFile {
    children: TAbstractFile[] = [];
}

/**
 * Mock TFile class.
 */
export class TFile extends TAbstractFile {
    basename: string;
    extension: string;

    constructor(path: string) {
        super(path);
        const parts = path.split('/');
        const filename = parts[parts.length - 1];
        const nameParts = filename.split('.');
        this.extension = nameParts.pop() ?? '';
        this.basename = nameParts.join('.');
    }
}

/**
 * Mock DropdownComponent class.
 */
export class DropdownComponent {
    value = '';

    addOption(_value: string, _display: string): this {
        return this;
    }

    setValue(value: string): this {
        this.value = value;
        return this;
    }

    onChange(_callback: (value: string) => void): this {
        return this;
    }
}

/**
 * Mock TextComponent class.
 */
export class TextComponent {
    inputEl: HTMLInputElement = document.createElement('input');
    value = '';

    setPlaceholder(_placeholder: string): this {
        return this;
    }

    setValue(value: string): this {
        this.value = value;
        return this;
    }

    onChange(_callback: (value: string) => void): this {
        return this;
    }
}

/**
 * Mock ToggleComponent class.
 */
export class ToggleComponent {
    value = false;

    setValue(value: boolean): this {
        this.value = value;
        return this;
    }

    onChange(_callback: (value: boolean) => void): this {
        return this;
    }
}

/**
 * Mock SliderComponent class.
 */
export class SliderComponent {
    value = 0;

    setLimits(_min: number, _max: number, _step: number): this {
        return this;
    }

    setValue(value: number): this {
        this.value = value;
        return this;
    }

    setDynamicTooltip(): this {
        return this;
    }

    onChange(_callback: (value: number) => void): this {
        return this;
    }
}

/**
 * Mock normalizePath function.
 */
export function normalizePath(path: string): string {
    return path.replace(/\\/g, '/').replace(/\/+/g, '/');
}

// Type definitions
export interface PluginManifest {
    id: string;
    name: string;
    version: string;
}

export interface Command {
    id: string;
    name: string;
    callback?: () => void;
}
