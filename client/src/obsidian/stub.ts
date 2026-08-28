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
        readonly cls: string = ""
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

    empty(): void {
        this.children.length = 0;
    }

    setText(value: string): void {
        this.text = value;
    }

    addEventListener(): void {
        /* Inputs in this stub are driven directly, not through events. */
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

export class App {
    readonly vault = new FakeVault();
}

/* ---------------------------------------------------------------- *
 * Notices
 * ---------------------------------------------------------------- */

/** Everything shown to the user, in order, for asserting on what was said. */
export const notices: { message: string; duration: number | undefined }[] = [];

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
    readonly ribbonIcons: { icon: string; title: string; callback: () => void }[] = [];
    readonly commands: { id: string; name: string; callback?: () => void }[] = [];
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
        this.ribbonIcons.push({ icon, title, callback: () => callback(undefined) });
        return new FakeEl("div", "ribbon");
    }

    addCommand(command: { id: string; name: string; callback?: () => void }): typeof command {
        this.commands.push(command);
        return command;
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

export class Modal {
    readonly contentEl = new FakeEl("div", "modal-content");
    isOpen = false;

    constructor(public app: App) {}

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
}
