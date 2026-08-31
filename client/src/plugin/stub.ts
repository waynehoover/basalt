/**
 * The `obsidian` module, at runtime, for tests.
 *
 * The npm package is types only: `"main": ""`. Obsidian itself provides the
 * implementation when it loads a plugin, which is why the build marks it
 * external and why nothing here could be run.
 *
 * This is the implementation, for tests only. `vitest.config.ts` aliases
 * `obsidian` to this file; nothing else does, so `tsc` still checks every use
 * against the real `obsidian.d.ts` and the shipped bundle still expects the real
 * one. Types from the declarations, behaviour from here.
 *
 * It is deliberately not exhaustive. It implements what the plugin actually
 * touches, and a plugin that started touching more would fail here loudly rather
 * than silently working against a fake that agreed with it.
 */

import { FakeAdapter, normalizePath } from "./fake.ts";

export { normalizePath };

/* ---------------------------------------------------------------- *
 * Just enough of an element
 * ---------------------------------------------------------------- */

/**
 * A stand-in for Obsidian's augmented HTMLElement.
 *
 * Obsidian adds `createEl`, `createDiv`, `empty` and `setText` to every element,
 * and the plugin uses all four. A real DOM would need jsdom for no gain: what is
 * being checked is that the plugin builds the controls it says it does, and a
 * tree of plain objects answers that.
 */
export class FakeEl {
    readonly children: FakeEl[] = [];
    text = "";

    constructor(
        readonly tag: string,
        public cls: string = ""
    ) {}

    createEl(tag: string, o?: { text?: string; cls?: string } | string): FakeEl {
        const el = new FakeEl(tag, typeof o === "string" ? o : (o?.cls ?? ""));
        if (typeof o === "object" && o?.text) el.text = o.text;
        this.children.push(el);
        return el;
    }

    createDiv(o?: { text?: string; cls?: string } | string): FakeEl {
        return this.createEl("div", o);
    }

    createSpan(o?: { text?: string; cls?: string } | string): FakeEl {
        return this.createEl("span", o);
    }

    empty(): void {
        this.children.length = 0;
    }

    setText(value: string): void {
        this.text = value;
    }

    /**
     * Listeners are recorded rather than ignored, so a test can click what the
     * plugin drew. A modal whose buttons cannot be pressed is a modal whose
     * behaviour is untested no matter how much of its markup is asserted on.
     */
    private readonly listeners = new Map<string, (() => void)[]>();

    addEventListener(event: string, handler: () => void): void {
        const list = this.listeners.get(event) ?? [];
        list.push(handler);
        this.listeners.set(event, list);
    }

    fire(event: string): void {
        for (const h of this.listeners.get(event) ?? []) h();
    }

    addClass(...classes: string[]): void {
        for (const c of classes) {
            // What a real DOMTokenList does, word for word, because a stub that
            // shrugs at an empty token lets a crash through: the status bar
            // painter passed one and it surfaced as a sync error about a
            // DOMTokenList, from a stack that never mentioned the status bar.
            if (c === "") throw new Error("Failed to execute 'add' on 'DOMTokenList': The token provided must not be empty.");
            if (/\s/.test(c)) throw new Error("Failed to execute 'add' on 'DOMTokenList': The token provided contains HTML space characters.");
        }
        this.cls = [this.cls, ...classes].filter(Boolean).join(" ");
    }

    removeClass(...classes: string[]): void {
        const drop = new Set(classes);
        this.cls = this.cls.split(" ").filter((c) => c && !drop.has(c)).join(" ");
    }

    readonly attributes = new Map<string, string>();

    setAttribute(name: string, value: string): void {
        this.attributes.set(name, value);
    }

    /** Every string anywhere in the tree, for asserting on what was rendered. */
    allText(): string {
        return [this.text, ...this.children.map((c) => c.allText())].filter(Boolean).join("\n");
    }
}

/* ---------------------------------------------------------------- *
 * The app
 * ---------------------------------------------------------------- */

type VaultEvent = "create" | "modify" | "delete" | "rename";

export class FakeVault {
    readonly adapter = new FakeAdapter();

    /** What the plugin reads instead of asking the adapter about every file. */
    getAllLoadedFiles() {
        return this.adapter.index();
    }
    /** Obsidian's own: "typically `.obsidian` but it could be different". */
    configDir = ".obsidian";
    private readonly handlers = new Map<VaultEvent, ((...args: unknown[]) => void)[]>();

    on(name: VaultEvent, callback: (...args: unknown[]) => void): { name: VaultEvent } {
        const list = this.handlers.get(name) ?? [];
        list.push(callback);
        this.handlers.set(name, list);
        return { name };
    }

    /** Fires an event, as Obsidian would after a file changed. */
    fire(name: VaultEvent, ...args: unknown[]): void {
        for (const handler of this.handlers.get(name) ?? []) handler(...args);
    }

    /** How many handlers a plugin registered, so a test can see it registered any. */
    handlerCount(): number {
        return [...this.handlers.values()].reduce((n, list) => n + list.length, 0);
    }
}

/**
 * Just enough workspace.
 *
 * `onLayoutReady` runs its callback immediately when the layout is already up,
 * and queues it otherwise. Both are modelled, because a plugin that only worked
 * in one of the two cases would pass a test that only exercised the other.
 */
export class FakeWorkspace {
    layoutReady = true;
    private readonly waiting: (() => void)[] = [];

    /** The file the plugin will be told is open. */
    activeFile: { path: string; extension: string } | undefined;
    /** Handlers registered per event name, so a test can fire one. */
    readonly handlers = new Map<string, ((...args: unknown[]) => unknown)[]>();

    onLayoutReady(callback: () => void): void {
        if (this.layoutReady) callback();
        else this.waiting.push(callback);
    }

    on(name: string, handler: (...args: unknown[]) => unknown): { name: string } {
        const list = this.handlers.get(name) ?? [];
        list.push(handler);
        this.handlers.set(name, list);
        return { name };
    }

    getActiveFile(): { path: string; extension: string } | undefined {
        return this.activeFile;
    }

    /** Fires a registered event, which is what Obsidian would do. */
    fire(name: string, ...args: unknown[]): void {
        for (const h of this.handlers.get(name) ?? []) h(...args);
    }

    /** Obsidian finishing its startup. */
    finishLayout(): void {
        this.layoutReady = true;
        while (this.waiting.length) this.waiting.shift()!();
    }
}

export class App {
    readonly vault = new FakeVault();
    readonly workspace = new FakeWorkspace();
}

/**
 * The context menu Obsidian hands to a `file-menu` handler.
 *
 * Records what a plugin adds, and lets a test click it, which is the only way
 * to find out whether the entry does what its title says.
 */
export class MenuItem {
    title = "";
    icon = "";
    private handler: (() => void) | undefined;

    setTitle(title: string): this {
        this.title = title;
        return this;
    }

    setIcon(icon: string): this {
        this.icon = icon;
        return this;
    }

    onClick(handler: () => void): this {
        this.handler = handler;
        return this;
    }

    click(): void {
        this.handler?.();
    }
}

export class Menu {
    readonly items: MenuItem[] = [];

    addItem(cb: (item: MenuItem) => unknown): this {
        const item = new MenuItem();
        cb(item);
        this.items.push(item);
        return this;
    }

    addSeparator(): this {
        return this;
    }
}

/* ---------------------------------------------------------------- *
 * Notices
 * ---------------------------------------------------------------- */

/** Everything shown to the user, in order, for asserting on what was said. */
export const notices: { message: string; duration: number | undefined }[] = [];

/**
 * Obsidian's icon helper, which sets a glyph inside an element.
 *
 * Recorded as an attribute so a test can assert which icon a state chose: the
 * status bar is an icon and a tooltip now, and "which glyph" is the whole of
 * what it says.
 */
export function setIcon(el: FakeEl, name: string): void {
    el.setAttribute("data-icon", name);
}

export class Notice {
    constructor(
        message: string,
        public duration?: number
    ) {
        notices.push({ message: String(message), duration });
    }

    setMessage(): this {
        return this;
    }

    hide(): void {
        /* nothing to hide */
    }
}

/* ---------------------------------------------------------------- *
 * Plugin
 * ---------------------------------------------------------------- */

export class Component {
    onload(): void {}
    onunload(): void {}
}

export class Plugin extends Component {
    /** What `saveData` wrote, which Obsidian keeps in the plugin's data.json. */
    savedData: unknown = null;
    readonly statusBarItems: FakeEl[] = [];
    readonly ribbonIcons: { icon: string; title: string; callback: () => void; el: FakeEl }[] = [];
    readonly commands: {
        id: string;
        name: string;
        // Obsidian permits an async command callback and runCommand below
        // awaits one. Typed as returning void, that await was awaiting a
        // non-promise: the stub would resolve before the command it ran had
        // finished, which is the sort of thing that makes a test flake rather
        // than fail.
        callback?: () => void | Promise<void>;
        checkCallback?: (checking: boolean) => boolean;
    }[] = [];
    /** What registerCliHandler was given, so the handlers can be driven. */
    readonly cliHandlers = new Map<
        string,
        { description: string; handler: (flags: Record<string, unknown>) => unknown }
    >();
    readonly registeredEvents: unknown[] = [];

    constructor(
        public app: App,
        public manifest: { id: string; dir?: string }
    ) {
        super();
    }

    addStatusBarItem(): FakeEl {
        const el = new FakeEl("div", "status-bar-item");
        this.statusBarItems.push(el);
        return el;
    }

    addRibbonIcon(icon: string, title: string, callback: (evt: unknown) => void): FakeEl {
        const el = new FakeEl("div", "ribbon");
        this.ribbonIcons.push({ icon, title, callback: () => callback(undefined), el });
        return el;
    }

    addCommand(command: {
        id: string;
        name: string;
        callback?: () => void;
        checkCallback?: (checking: boolean) => boolean;
    }): typeof command {
        this.commands.push(command);
        return command;
    }

    registerCliHandler(
        command: string,
        description: string,
        _flags: unknown,
        handler: (flags: Record<string, unknown>) => unknown
    ): void {
        this.cliHandlers.set(command, { description, handler });
    }

    registerEvent(ref: unknown): void {
        this.registeredEvents.push(ref);
    }

    registerInterval(id: number): number {
        return id;
    }

    async loadData(): Promise<unknown> {
        return this.savedData;
    }

    async saveData(data: unknown): Promise<void> {
        // Round-tripped through JSON, as Obsidian's does by writing a file. A
        // value that does not survive JSON would work here and fail there.
        this.savedData = data === null || data === undefined ? null : JSON.parse(JSON.stringify(data));
    }

    /** Runs a command by id, the way a person would from the palette. */
    async runCommand(id: string): Promise<void> {
        const command = this.commands.find((c) => c.id === id);
        if (!command) throw new Error(`no such command: ${id}`);
        await command.callback?.();
    }
}

/* ---------------------------------------------------------------- *
 * Modal and Setting
 * ---------------------------------------------------------------- */

/** Every Modal built, newest last, so a test can read what it rendered. */
export const modals: Modal[] = [];

export class Modal {
    readonly contentEl = new FakeEl("div", "modal-content");
    readonly modalEl = new FakeEl("div", "modal");
    readonly titleEl = new FakeEl("div", "modal-title");
    isOpen = false;

    setTitle(title: string): this {
        this.titleEl.setText(title);
        return this;
    }

    constructor(public app: App) {
        modals.push(this);
    }

    open(): void {
        this.isOpen = true;
        this.onOpen();
    }

    close(): void {
        this.isOpen = false;
        this.onClose();
    }

    onOpen(): void {}
    onClose(): void {}
}

export class TextComponent {
    private value = "";
    placeholder = "";
    readonly inputEl = new FakeEl("input");

    setPlaceholder(placeholder: string): this {
        this.placeholder = placeholder;
        return this;
    }

    getValue(): string {
        return this.value;
    }

    setValue(value: string): this {
        this.value = value;
        return this;
    }

    /** Types into the field, as a person would. */
    type(value: string): void {
        this.value = value;
    }
}

export class ButtonComponent {
    label = "";
    cta = false;
    warning = false;
    private onClickHandler: (() => unknown) | undefined;

    setButtonText(name: string): this {
        this.label = name;
        return this;
    }

    setCta(): this {
        this.cta = true;
        return this;
    }

    setWarning(): this {
        this.warning = true;
        return this;
    }

    setDisabled(): this {
        return this;
    }

    onClick(callback: () => unknown): this {
        this.onClickHandler = callback;
        return this;
    }

    /** Presses the button, and waits for whatever it started. */
    async click(): Promise<void> {
        await this.onClickHandler?.();
    }
}

/**
 * Obsidian's settings row builder.
 *
 * Records what was built rather than rendering it, so a test can find a control
 * by the name next to it, which is how a person finds it too.
 */
export class Setting {
    name = "";
    desc = "";
    readonly texts: TextComponent[] = [];
    readonly buttons: ButtonComponent[] = [];
    readonly settingEl = new FakeEl("div", "setting-item");

    constructor(containerEl: FakeEl) {
        containerEl.children.push(this.settingEl);
        built.push(this);
    }

    setName(name: string): this {
        this.name = String(name);
        return this;
    }

    setDesc(desc: string): this {
        this.desc = String(desc);
        return this;
    }

    setHeading(): this {
        return this;
    }

    addText(cb: (component: TextComponent) => unknown): this {
        const component = new TextComponent();
        this.texts.push(component);
        cb(component);
        return this;
    }

    addButton(cb: (component: ButtonComponent) => unknown): this {
        const component = new ButtonComponent();
        this.buttons.push(component);
        cb(component);
        return this;
    }
}

/** Every Setting built, newest last, so a test can find one by name. */
export const built: Setting[] = [];

/** Forgets everything recorded, between tests. */
export function resetStub(): void {
    notices.length = 0;
    built.length = 0;
    modals.length = 0;
}
