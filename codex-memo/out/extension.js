"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = activate;
exports.deactivate = deactivate;
const cp = __importStar(require("child_process"));
const crypto = __importStar(require("crypto"));
const fs = __importStar(require("fs/promises"));
const os = __importStar(require("os"));
const path = __importStar(require("path"));
const vscode = __importStar(require("vscode"));
const MEMO_FILE_NAME = ".codex-memos/memos.json";
const COLORS = [
    "#3ea8ff",
    "#f59e0b",
    "#22c55e",
    "#ef4444",
    "#a855f7",
    "#14b8a6",
    "#ec4899",
    "#84cc16"
];
function activate(context) {
    const store = new MemoStore();
    const decorations = new DecorationManager();
    const provider = new MemoViewProvider(context.extensionUri, store, decorations);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider("codexMemo.memos", provider, {
        webviewOptions: { retainContextWhenHidden: true }
    }), vscode.commands.registerCommand("codexMemo.addMemo", async () => {
        await provider.createDraftFromSelection();
    }), vscode.commands.registerCommand("codexMemo.focus", async () => {
        await vscode.commands.executeCommand("codexMemo.memos.focus");
    }), vscode.window.onDidChangeActiveTextEditor(async () => {
        await provider.refresh();
    }), vscode.window.onDidChangeTextEditorVisibleRanges((event) => {
        provider.syncToVisibleRange(event.textEditor);
    }), vscode.workspace.onDidChangeTextDocument(async (event) => {
        const active = vscode.window.activeTextEditor;
        if (active && event.document.uri.toString() === active.document.uri.toString()) {
            decorations.apply(active, store.getMemosForDocument(active.document));
            await provider.refresh();
        }
    }), vscode.workspace.onDidChangeConfiguration(async (event) => {
        if (event.affectsConfiguration("codexMemo.alignment") || event.affectsConfiguration("codexMemo.authorName")) {
            await provider.refresh();
        }
    }), vscode.workspace.onDidChangeWorkspaceFolders(async () => {
        await provider.reloadFromDisk();
    }), store, decorations);
    void store.initialize().then(async () => {
        context.subscriptions.push(store.watch(async () => {
            await provider.reloadFromDisk();
        }));
        await provider.refresh();
    });
}
function deactivate() {
    // VS Code disposes subscriptions registered in activate.
}
class MemoStore {
    data = { version: 1, memos: [] };
    memoFileUri;
    rootUri;
    disposed = false;
    async initialize() {
        this.rootUri = await this.resolveMemoRootUri();
        this.memoFileUri = this.rootUri ? vscode.Uri.file(path.join(this.rootUri.fsPath, MEMO_FILE_NAME)) : undefined;
        if (!this.memoFileUri) {
            this.data = { version: 1, memos: [] };
            return;
        }
        await this.ensureFile();
        await this.load();
    }
    dispose() {
        this.disposed = true;
    }
    getMemoFileUri() {
        return this.memoFileUri;
    }
    async load() {
        if (!this.memoFileUri || this.disposed) {
            return;
        }
        try {
            const raw = await fs.readFile(this.memoFileUri.fsPath, "utf8");
            const parsed = JSON.parse(raw);
            this.data = {
                version: 1,
                memos: Array.isArray(parsed.memos) ? parsed.memos.filter(isMemo) : []
            };
        }
        catch {
            this.data = { version: 1, memos: [] };
        }
    }
    async addMemo(memo) {
        this.data.memos.push(memo);
        await this.save();
    }
    async updateMemo(id, patch) {
        const memo = this.data.memos.find((candidate) => candidate.id === id);
        if (!memo) {
            return;
        }
        Object.assign(memo, patch);
        memo.updatedAt = patch.updatedAt ?? new Date().toISOString();
        await this.save();
    }
    async deleteMemo(id) {
        this.data.memos = this.data.memos.filter((memo) => memo.id !== id);
        await this.save();
    }
    getMemosForDocument(document) {
        const file = this.toWorkspacePath(document.uri);
        if (!file) {
            return [];
        }
        return this.data.memos.filter((memo) => memo.file === file).sort(compareMemoPosition);
    }
    getAll() {
        return [...this.data.memos];
    }
    toWorkspacePath(uri) {
        if (!this.rootUri || !isInsidePath(uri.fsPath, this.rootUri.fsPath)) {
            return null;
        }
        return normalizePath(path.relative(this.rootUri.fsPath, uri.fsPath));
    }
    async openMemoDocument(memo) {
        if (!this.rootUri) {
            return null;
        }
        try {
            return await vscode.workspace.openTextDocument(vscode.Uri.file(path.join(this.rootUri.fsPath, memo.file)));
        }
        catch {
            return null;
        }
    }
    watch(onChange) {
        if (!this.rootUri) {
            return new vscode.Disposable(() => undefined);
        }
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(this.rootUri, MEMO_FILE_NAME));
        const run = debounce(() => {
            void onChange();
        }, 100);
        watcher.onDidChange(run);
        watcher.onDidCreate(run);
        watcher.onDidDelete(run);
        return watcher;
    }
    async resolveMemoRootUri() {
        const active = vscode.window.activeTextEditor;
        if (active) {
            const root = await findGitRoot(path.dirname(active.document.uri.fsPath));
            if (root) {
                return vscode.Uri.file(root);
            }
        }
        for (const folder of vscode.workspace.workspaceFolders ?? []) {
            const directRoot = await findGitRoot(folder.uri.fsPath);
            if (directRoot) {
                return vscode.Uri.file(directRoot);
            }
            const nestedRoot = await scanForGitRoot(folder.uri.fsPath, 4);
            if (nestedRoot) {
                return vscode.Uri.file(nestedRoot);
            }
        }
        return vscode.workspace.workspaceFolders?.[0]?.uri;
    }
    async ensureFile() {
        if (!this.memoFileUri) {
            return;
        }
        await fs.mkdir(path.dirname(this.memoFileUri.fsPath), { recursive: true });
        try {
            await fs.access(this.memoFileUri.fsPath);
        }
        catch {
            await fs.writeFile(this.memoFileUri.fsPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
        }
    }
    async save() {
        if (!this.memoFileUri) {
            void vscode.window.showWarningMessage("Memo storage is unavailable because no workspace folder is open.");
            return;
        }
        await this.ensureFile();
        await fs.writeFile(this.memoFileUri.fsPath, `${JSON.stringify(this.data, null, 2)}\n`, "utf8");
    }
}
class MemoViewProvider {
    extensionUri;
    store;
    decorations;
    view;
    draft = null;
    focusedMemoId = null;
    lastVisibleKey = null;
    constructor(extensionUri, store, decorations) {
        this.extensionUri = extensionUri;
        this.store = store;
        this.decorations = decorations;
    }
    resolveWebviewView(webviewView) {
        this.view = webviewView;
        const webview = webviewView.webview;
        webview.options = {
            enableScripts: true,
            localResourceRoots: [this.extensionUri]
        };
        webview.html = this.getHtml(webview);
        webview.onDidReceiveMessage((message) => {
            void this.handleMessage(message);
        });
        void this.refresh();
    }
    async createDraftFromSelection() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return;
        }
        const selection = getSelectionOrWord(editor);
        if (selection.isEmpty) {
            void vscode.window.showInformationMessage("Select text before adding a memo.");
            return;
        }
        const file = this.store.toWorkspacePath(editor.document.uri);
        if (!file) {
            void vscode.window.showWarningMessage("Memo can only be created for files inside the workspace.");
            return;
        }
        const author = await resolveAuthorName();
        this.draft = {
            file,
            anchor: rangeToAnchor(selection),
            selectedText: editor.document.getText(selection),
            author,
            color: authorColor(author)
        };
        await vscode.commands.executeCommand("codexMemo.memos.focus");
        await this.refresh();
        this.post({ type: "focusDraft" });
    }
    async reloadFromDisk() {
        await this.store.load();
        await this.refresh();
    }
    async refresh() {
        const editor = vscode.window.activeTextEditor;
        if (editor) {
            this.decorations.apply(editor, this.store.getMemosForDocument(editor.document));
        }
        this.post({ type: "state", state: await this.buildState() });
    }
    syncToVisibleRange(editor) {
        if (editor !== vscode.window.activeTextEditor || !editor.visibleRanges.length) {
            return;
        }
        const visible = getVisibleWindow(editor);
        const key = visible ? `${editor.document.uri.toString()}:${visible.startLine}:${visible.endLine}` : null;
        if (key && key !== this.lastVisibleKey) {
            this.lastVisibleKey = key;
            void this.refresh();
        }
    }
    async buildState() {
        const editor = vscode.window.activeTextEditor;
        if (!editor) {
            return {
                activeFile: null,
                memos: [],
                fileMemos: [],
                allMemos: this.store.getAll().sort(compareMemoFileAndPosition),
                draft: this.draft,
                focusedMemoId: this.focusedMemoId,
                visibleWindow: null,
                alignment: getAlignmentSettings()
            };
        }
        const activeFile = this.store.toWorkspacePath(editor.document.uri);
        const visibleWindow = getVisibleWindow(editor);
        const fileMemos = this.store.getMemosForDocument(editor.document)
            .map((memo) => ({
            ...memo,
            stale: !resolveMemoRange(editor.document, memo)
        }));
        const memos = fileMemos.filter((memo) => isMemoVisibleAtStartLine(memo, visibleWindow));
        return {
            activeFile,
            memos,
            fileMemos,
            allMemos: this.store.getAll().sort(compareMemoFileAndPosition),
            draft: this.draft?.file === activeFile ? this.draft : null,
            focusedMemoId: this.focusedMemoId,
            visibleWindow,
            alignment: getAlignmentSettings()
        };
    }
    post(message) {
        void this.view?.webview.postMessage(message);
    }
    async handleMessage(message) {
        if (!isRecord(message) || typeof message.type !== "string") {
            return;
        }
        switch (message.type) {
            case "saveDraft":
                await this.saveDraft(String(message.body ?? ""));
                break;
            case "cancelDraft":
                this.draft = null;
                await this.refresh();
                break;
            case "jump":
                await this.jumpToMemo(String(message.id ?? ""));
                break;
            case "delete":
            case "resolve":
                await this.store.deleteMemo(String(message.id ?? ""));
                await this.refresh();
                break;
            case "edit":
                await this.editMemo(String(message.id ?? ""), String(message.body ?? ""));
                break;
            case "reply":
                await this.addReply(String(message.id ?? ""), String(message.body ?? ""));
                break;
            case "editReply":
                await this.editReply(String(message.id ?? ""), String(message.replyId ?? ""), String(message.body ?? ""));
                break;
            case "deleteReply":
            case "resolveReply":
                await this.deleteReply(String(message.id ?? ""), String(message.replyId ?? ""));
                break;
            case "color":
                await this.updateColor(String(message.id ?? ""), String(message.color ?? ""));
                break;
        }
    }
    async saveDraft(body) {
        if (!this.draft || !body.trim()) {
            this.draft = null;
            await this.refresh();
            return;
        }
        const now = new Date().toISOString();
        const memo = {
            id: crypto.randomUUID(),
            file: this.draft.file,
            anchor: this.draft.anchor,
            selectedText: this.draft.selectedText,
            body: body.trim(),
            author: this.draft.author,
            color: this.draft.color,
            createdAt: now,
            updatedAt: now,
            replies: []
        };
        this.draft = null;
        await this.store.addMemo(memo);
        this.focusedMemoId = memo.id;
        await this.refresh();
    }
    async editMemo(id, body) {
        if (!body.trim()) {
            return;
        }
        await this.store.updateMemo(id, {
            body: body.trim(),
            updatedAt: new Date().toISOString()
        });
        await this.refresh();
    }
    async addReply(id, body) {
        if (!body.trim()) {
            return;
        }
        const memo = this.store.getAll().find((candidate) => candidate.id === id);
        if (!memo) {
            return;
        }
        const now = new Date().toISOString();
        const author = await resolveAuthorName();
        await this.store.updateMemo(id, {
            replies: [
                ...memo.replies,
                {
                    id: crypto.randomUUID(),
                    body: body.trim(),
                    author,
                    createdAt: now,
                    updatedAt: now
                }
            ],
            updatedAt: now
        });
        await this.refresh();
    }
    async editReply(id, replyId, body) {
        if (!body.trim()) {
            return;
        }
        const memo = this.store.getAll().find((candidate) => candidate.id === id);
        if (!memo) {
            return;
        }
        const now = new Date().toISOString();
        const replies = memo.replies.map((reply) => reply.id === replyId
            ? { ...reply, body: body.trim(), updatedAt: now }
            : reply);
        await this.store.updateMemo(id, {
            replies,
            updatedAt: now
        });
        await this.refresh();
    }
    async deleteReply(id, replyId) {
        const memo = this.store.getAll().find((candidate) => candidate.id === id);
        if (!memo) {
            return;
        }
        await this.store.updateMemo(id, {
            replies: memo.replies.filter((reply) => reply.id !== replyId),
            updatedAt: new Date().toISOString()
        });
        await this.refresh();
    }
    async updateColor(id, color) {
        if (!/^#[0-9a-fA-F]{6}$/.test(color)) {
            return;
        }
        await this.store.updateMemo(id, {
            color,
            updatedAt: new Date().toISOString()
        });
        await this.refresh();
    }
    async jumpToMemo(id) {
        const memo = this.store.getAll().find((candidate) => candidate.id === id);
        if (!memo) {
            return;
        }
        const document = await this.store.openMemoDocument(memo);
        if (!document) {
            return;
        }
        const editor = await vscode.window.showTextDocument(document, { preserveFocus: false });
        const range = resolveMemoRange(document, memo) ?? anchorToRange(memo.anchor);
        editor.selection = new vscode.Selection(range.start, range.end);
        editor.revealRange(range, vscode.TextEditorRevealType.InCenterIfOutsideViewport);
        this.focusedMemoId = id;
        this.decorations.apply(editor, this.store.getMemosForDocument(document));
        await this.refresh();
    }
    getHtml(webview) {
        const nonce = crypto.randomBytes(16).toString("base64");
        const csp = [
            "default-src 'none'",
            `img-src ${webview.cspSource} data:`,
            `style-src ${webview.cspSource} 'unsafe-inline'`,
            `script-src 'nonce-${nonce}'`
        ].join("; ");
        return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Memos</title>
  <style>
    :root {
      color-scheme: light dark;
      --card-bg: var(--vscode-editor-background);
      --card-border: var(--vscode-panel-border);
      --muted: var(--vscode-descriptionForeground);
      --input-bg: var(--vscode-input-background);
      --input-fg: var(--vscode-input-foreground);
      --button-hover: var(--vscode-toolbar-hoverBackground);
      --danger: var(--vscode-errorForeground);
    }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
      overflow: hidden;
    }
    body {
      margin: 0;
      padding: 8px 0;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-sideBar-foreground);
      font: 12px/1.4 var(--vscode-font-family);
    }
    #root {
      display: flex;
      flex-direction: column;
      height: 100%;
      min-height: 0;
    }
    .empty {
      color: var(--muted);
      padding: 12px;
    }
    .toolbar {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 4px;
      flex: 0 0 auto;
      padding: 0 8px 8px;
      align-items: center;
    }
    .search {
      min-width: 0;
      height: 26px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--vscode-input-border, var(--card-border));
      border-radius: 2px;
      padding: 3px 6px;
      font: 12px var(--vscode-font-family);
    }
    .tool {
      appearance: none;
      background: transparent;
      color: inherit;
      border: 1px solid transparent;
      border-radius: 3px;
      cursor: pointer;
      height: 24px;
      min-width: 24px;
      padding: 2px 5px;
      font: 12px var(--vscode-font-family);
    }
    .tool:hover, .tool.active {
      background: var(--button-hover);
      border-color: var(--card-border);
    }
    .filter-panel {
      display: none;
      grid-template-columns: minmax(0, 1fr) minmax(0, 1fr) auto;
      gap: 4px;
      flex: 0 0 auto;
      padding: 0 8px 8px;
    }
    .filter-panel.open {
      display: grid;
    }
    .filter-panel select {
      min-width: 0;
      height: 24px;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--vscode-input-border, var(--card-border));
      border-radius: 2px;
      font: 12px var(--vscode-font-family);
    }
    .file {
      flex: 0 0 auto;
      color: var(--muted);
      font-size: 11px;
      padding: 0 8px 8px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .board {
      position: relative;
      flex: 1 1 auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .results {
      flex: 1 1 auto;
      min-height: 0;
      overflow-x: hidden;
      overflow-y: auto;
    }
    .board-spacer {
      width: 1px;
      min-height: 100%;
      pointer-events: none;
    }
    .memo {
      width: 100%;
      background: var(--card-bg);
      border-left: 4px solid var(--memo-color);
      border-top: 1px solid var(--card-border);
      border-bottom: 1px solid var(--card-border);
      margin: 0;
      padding: 8px 7px 8px 8px;
    }
    .board .memo {
      position: absolute;
      left: 0;
      right: 0;
    }
    .results .memo {
      position: relative;
      margin-bottom: 8px;
    }
    .memo.focused {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .memo.stale {
      opacity: 0.72;
    }
    .header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto auto;
      gap: 4px;
      align-items: start;
    }
    .meta {
      display: flex;
      align-items: baseline;
      gap: 4px;
      min-width: 0;
      overflow: hidden;
    }
    .author {
      font-weight: 600;
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .date {
      color: var(--muted);
      font-size: 11px;
      flex: 0 0 auto;
    }
    .context {
      color: var(--muted);
      border-left: 2px solid var(--memo-color);
      margin: 7px 0;
      padding-left: 7px;
      white-space: nowrap;
      overflow: hidden;
      text-overflow: ellipsis;
    }
    .body, .reply-body {
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      margin: 6px 0;
    }
    .reply {
      border-top: 1px solid var(--card-border);
      margin-top: 7px;
      padding-top: 7px;
    }
    .reply-header {
      display: grid;
      grid-template-columns: minmax(0, 1fr) auto auto;
      gap: 4px;
      align-items: start;
    }
    .reply-main {
      min-width: 0;
    }
    .reply-meta {
      color: var(--muted);
      font-size: 11px;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
    .icon {
      appearance: none;
      background: transparent;
      color: inherit;
      border: 0;
      border-radius: 3px;
      cursor: pointer;
      height: 22px;
      min-width: 22px;
      padding: 2px 4px;
      font: inherit;
    }
    .icon:hover {
      background: var(--button-hover);
    }
    .palette {
      width: 22px;
      height: 22px;
      padding: 2px;
    }
    textarea {
      width: 100%;
      min-height: 26px;
      max-height: 130px;
      resize: vertical;
      background: var(--input-bg);
      color: var(--input-fg);
      border: 1px solid var(--vscode-input-border, var(--card-border));
      border-radius: 2px;
      padding: 4px 5px;
      font: 12px/1.35 var(--vscode-font-family);
    }
    textarea:focus {
      outline: 1px solid var(--vscode-focusBorder);
      outline-offset: -1px;
    }
    .draft {
      border-left-style: dashed;
    }
    .menu-wrap {
      position: relative;
    }
    .menu {
      position: absolute;
      right: 0;
      top: 24px;
      z-index: 5;
      min-width: 88px;
      background: var(--vscode-menu-background);
      color: var(--vscode-menu-foreground);
      border: 1px solid var(--vscode-menu-border, var(--card-border));
      box-shadow: 0 4px 12px rgba(0,0,0,0.22);
      padding: 3px;
    }
    .menu button {
      width: 100%;
      appearance: none;
      background: transparent;
      color: inherit;
      border: 0;
      text-align: left;
      padding: 5px 8px;
      font: inherit;
      cursor: pointer;
    }
    .menu button:hover {
      background: var(--vscode-menu-selectionBackground);
      color: var(--vscode-menu-selectionForeground);
    }
    .menu button.delete {
      color: var(--danger);
    }
    .colors {
      display: none;
      grid-template-columns: repeat(4, 18px);
      gap: 5px;
      margin: 7px 0;
    }
    .colors.open {
      display: grid;
    }
    .swatch {
      width: 18px;
      height: 18px;
      border-radius: 50%;
      border: 1px solid var(--card-border);
      cursor: pointer;
    }
  </style>
</head>
<body>
  <main id="root"></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const colors = ${JSON.stringify(COLORS)};
    let state = {
      activeFile: null,
      memos: [],
      fileMemos: [],
      allMemos: [],
      draft: null,
      focusedMemoId: null,
      visibleWindow: null,
      alignment: { topOffsetPx: 0, lineHeightPx: 0, lineScale: 1, cardAnchorOffsetPx: 0 }
    };
    let ui = {
      query: '',
      scope: 'file',
      filterOpen: false,
      filterType: 'tag',
      filterValue: ''
    };
    let searchRenderTimer = 0;
    let isComposingSearch = false;
    const root = document.getElementById('root');

    window.addEventListener('message', event => {
      const message = event.data;
      if (message.type === 'state') {
        state = message.state;
        render();
      }
      if (message.type === 'focusDraft') {
        setTimeout(() => document.querySelector('[data-draft] textarea')?.focus(), 0);
      }
    });
    window.addEventListener('resize', () => {
      const board = document.querySelector('.board');
      const spacer = document.querySelector('.board-spacer');
      if (board && spacer) {
        for (const card of board.querySelectorAll('.memo')) {
          const top = lineTopPx(Number(card.dataset.anchorLine ?? 0));
          card.dataset.desiredTop = String(top);
        }
        layoutCards(board, spacer);
      }
    });

    function render() {
      root.innerHTML = '';
      root.appendChild(renderToolbar());
      root.appendChild(renderFilterPanel());
      if (state.activeFile) {
        const file = document.createElement('div');
        file.className = 'file';
        file.textContent = ui.scope === 'all' ? 'All files' : state.activeFile;
        root.appendChild(file);
      }
      if (!state.activeFile) {
        root.appendChild(empty('Open a workspace file to see memos.'));
        return;
      }

      const listMode = ui.scope === 'all' || hasActiveSearch();
      if (listMode) {
        renderResults();
        return;
      }

      const board = document.createElement('div');
      board.className = 'board';
      root.appendChild(board);
      if (state.draft) {
        board.appendChild(positionCard(renderDraft(state.draft), state.draft.anchor, -1));
      }
      if (!state.draft && state.memos.length === 0) {
        board.appendChild(empty('No visible memos for this file.'));
      }
      state.memos.forEach((memo, index) => {
        board.appendChild(positionCard(renderMemo(memo), memo.anchor, index));
      });
      const spacer = document.createElement('div');
      spacer.className = 'board-spacer';
      board.appendChild(spacer);
      requestAnimationFrame(() => layoutCards(board, spacer));
    }

    function renderToolbar() {
      const toolbar = document.createElement('div');
      toolbar.className = 'toolbar';

      const input = document.createElement('input');
      input.className = 'search';
      input.placeholder = 'memo';
      input.value = ui.query;
      input.addEventListener('compositionstart', () => {
        isComposingSearch = true;
      });
      input.addEventListener('compositionend', () => {
        isComposingSearch = false;
        ui.query = input.value;
        scheduleSearchRender();
      });
      input.addEventListener('input', () => {
        ui.query = input.value;
        if (!isComposingSearch) {
          scheduleSearchRender();
        }
      });

      const scope = document.createElement('button');
      scope.className = 'tool' + (ui.scope === 'all' ? ' active' : '');
      scope.title = ui.scope === 'all' ? 'Search all files' : 'Search current file';
      scope.textContent = ui.scope === 'all' ? '⧉' : '▤';
      scope.addEventListener('click', () => {
        ui.scope = ui.scope === 'all' ? 'file' : 'all';
        render();
      });

      const filter = document.createElement('button');
      filter.className = 'tool' + (ui.filterOpen || ui.filterValue ? ' active' : '');
      filter.title = 'Filter';
      filter.textContent = '▽';
      filter.addEventListener('click', () => {
        ui.filterOpen = !ui.filterOpen;
        render();
      });

      toolbar.append(input, scope, filter);
      return toolbar;
    }

    function scheduleSearchRender() {
      if (searchRenderTimer) {
        clearTimeout(searchRenderTimer);
      }
      searchRenderTimer = setTimeout(() => {
        searchRenderTimer = 0;
        render();
        const search = document.querySelector('.search');
        if (search) {
          search.focus();
          const end = search.value.length;
          search.setSelectionRange(end, end);
        }
      }, 180);
    }

    function renderFilterPanel() {
      const panel = document.createElement('div');
      panel.className = 'filter-panel' + (ui.filterOpen ? ' open' : '');

      const type = document.createElement('select');
      for (const [value, label] of [['tag', '#tag'], ['color', '#color'], ['user', '#user']]) {
        const option = document.createElement('option');
        option.value = value;
        option.textContent = label;
        type.appendChild(option);
      }
      type.value = ui.filterType;
      type.addEventListener('change', () => {
        ui.filterType = type.value;
        ui.filterValue = '';
        render();
      });

      const value = document.createElement('select');
      const options = filterOptions(ui.filterType);
      value.appendChild(new Option('All', ''));
      for (const optionValue of options) {
        value.appendChild(new Option(optionLabel(ui.filterType, optionValue), optionValue));
      }
      value.value = ui.filterValue;
      value.addEventListener('change', () => {
        ui.filterValue = value.value;
        render();
      });

      const clear = document.createElement('button');
      clear.className = 'tool';
      clear.title = 'Clear filter';
      clear.textContent = '×';
      clear.addEventListener('click', () => {
        ui.filterValue = '';
        ui.query = '';
        render();
      });

      panel.append(type, value, clear);
      return panel;
    }

    function renderResults() {
      const results = document.createElement('div');
      results.className = 'results';
      root.appendChild(results);

      const memos = filteredMemos();
      if (memos.length === 0) {
        results.appendChild(empty('No matching memos.'));
        return;
      }
      memos.forEach((memo, index) => {
        results.appendChild(renderMemo(memo, { showFile: ui.scope === 'all', order: index }));
      });
    }

    function hasActiveSearch() {
      return ui.query.trim().length > 0 || ui.filterValue.length > 0;
    }

    function filteredMemos() {
      const source = ui.scope === 'all' ? state.allMemos : state.fileMemos;
      const query = ui.query.trim().toLowerCase();
      return source.filter(memo => {
        if (query && !memoSearchText(memo).includes(query)) {
          return false;
        }
        if (!ui.filterValue) {
          return true;
        }
        if (ui.filterType === 'tag') {
          return memoTags(memo).includes(ui.filterValue);
        }
        if (ui.filterType === 'color') {
          return memo.color.toLowerCase() === ui.filterValue;
        }
        if (ui.filterType === 'user') {
          return memoUsers(memo).includes(ui.filterValue);
        }
        return true;
      });
    }

    function filterOptions(type) {
      const source = ui.scope === 'all' ? state.allMemos : state.fileMemos;
      const values = new Set();
      for (const memo of source) {
        if (type === 'tag') {
          memoTags(memo).forEach(value => values.add(value));
        } else if (type === 'color') {
          values.add(memo.color.toLowerCase());
        } else if (type === 'user') {
          memoUsers(memo).forEach(value => values.add(value));
        }
      }
      return [...values].sort((a, b) => a.localeCompare(b));
    }

    function optionLabel(type, value) {
      if (type === 'tag') {
        return value;
      }
      if (type === 'color') {
        return value;
      }
      return value;
    }

    function memoSearchText(memo) {
      return [
        memo.file,
        memo.selectedText,
        memo.body,
        memo.author,
        ...memo.replies.flatMap(reply => [reply.body, reply.author])
      ].join(' ').toLowerCase();
    }

    function memoTags(memo) {
      const text = [memo.body, ...memo.replies.map(reply => reply.body)].join(' ');
      const matches = text.match(/#[\\p{L}\\p{N}_-]+/gu) || [];
      return [...new Set(matches.map(tag => tag.toLowerCase()))];
    }

    function memoUsers(memo) {
      return [...new Set([memo.author, ...memo.replies.map(reply => reply.author)].filter(Boolean))].sort((a, b) => a.localeCompare(b));
    }

    function positionCard(card, anchor, order) {
      const top = lineTopPx(anchor.startLine);
      card.dataset.desiredTop = String(top);
      card.dataset.anchorLine = String(anchor.startLine);
      card.dataset.order = String(order);
      card.style.top = Math.round(top) + 'px';
      return card;
    }

    function layoutCards(board, spacer) {
      const gap = 6;
      const cards = [...board.querySelectorAll('.memo')]
        .sort((a, b) => {
          const topDelta = finiteNumber(Number(a.dataset.desiredTop), 0) - finiteNumber(Number(b.dataset.desiredTop), 0);
          if (Math.abs(topDelta) > 0.5) {
            return topDelta;
          }
          return finiteNumber(Number(a.dataset.order), 0) - finiteNumber(Number(b.dataset.order), 0);
        });

      let nextTop = 0;
      for (const card of cards) {
        const desiredTop = finiteNumber(Number(card.dataset.desiredTop), 0);
        const top = Math.max(0, desiredTop, nextTop);
        card.style.top = Math.round(top) + 'px';
        nextTop = top + card.offsetHeight + gap;
      }
      spacer.style.height = Math.max(board.clientHeight, nextTop) + 'px';
    }

    function lineTopPx(line) {
      if (!state.visibleWindow) {
        return 0;
      }
      const start = state.visibleWindow.startLine;
      const end = state.visibleWindow.endLine;
      const board = document.querySelector('.board');
      const boardHeight = board?.clientHeight || window.innerHeight;
      const span = Math.max(1, end - start + 1);
      const clamped = Math.max(start, Math.min(end, line));
      const alignment = state.alignment || {};
      const estimatedLineHeight = boardHeight / span;
      const lineHeight = positiveNumber(alignment.lineHeightPx) || estimatedLineHeight;
      const lineScale = finiteNumber(alignment.lineScale, 1);
      const topOffset = finiteNumber(alignment.topOffsetPx, 0);
      const cardAnchorOffset = finiteNumber(alignment.cardAnchorOffsetPx, 0);
      return topOffset + ((clamped - start) * lineHeight * lineScale) - cardAnchorOffset;
    }

    function positiveNumber(value) {
      return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
    }

    function finiteNumber(value, fallback) {
      return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
    }

    function renderDraft(draft) {
      const card = document.createElement('section');
      card.className = 'memo draft';
      card.dataset.draft = 'true';
      card.style.setProperty('--memo-color', draft.color);
      card.innerHTML = '<div class="header"><div class="meta"><div class="author"></div><div class="date">Draft</div></div></div><div class="context"></div>';
      card.querySelector('.author').textContent = draft.author;
      card.querySelector('.context').textContent = draft.selectedText;
      const input = document.createElement('textarea');
      input.placeholder = 'Memo';
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          vscode.postMessage({ type: 'saveDraft', body: input.value });
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          vscode.postMessage({ type: 'cancelDraft' });
        }
      });
      card.appendChild(input);
      return card;
    }

    function renderMemo(memo, options = {}) {
      const card = document.createElement('section');
      card.className = 'memo' + (memo.stale ? ' stale' : '') + (state.focusedMemoId === memo.id ? ' focused' : '');
      card.dataset.id = memo.id;
      card.dataset.order = String(options.order ?? 0);
      card.style.setProperty('--memo-color', memo.color);
      card.addEventListener('click', event => {
        if (event.target.closest('button, textarea, .menu, .swatch')) {
          return;
        }
        vscode.postMessage({ type: 'jump', id: memo.id });
      });

      const header = document.createElement('div');
      header.className = 'header';
      const meta = document.createElement('div');
      meta.className = 'meta';
      meta.innerHTML = '<div class="author"></div><div class="date"></div>';
      meta.querySelector('.author').textContent = memo.author;
      meta.querySelector('.date').textContent = formatDate(memo.createdAt);
      header.appendChild(meta);
      header.appendChild(icon('🎨', 'Change color', () => toggleColors(card)));
      header.appendChild(icon('✓', 'Resolve', () => vscode.postMessage({ type: 'resolve', id: memo.id })));
      header.appendChild(menuButton(memo));
      card.appendChild(header);

      const colorList = document.createElement('div');
      colorList.className = 'colors';
      for (const color of colors) {
        const swatch = document.createElement('button');
        swatch.className = 'swatch';
        swatch.title = color;
        swatch.style.background = color;
        swatch.addEventListener('click', () => vscode.postMessage({ type: 'color', id: memo.id, color }));
        colorList.appendChild(swatch);
      }
      card.appendChild(colorList);

      const context = document.createElement('div');
      context.className = 'context';
      const prefix = options.showFile ? memo.file + ':' + (memo.anchor.startLine + 1) + ' - ' : '';
      context.textContent = prefix + (memo.stale ? 'Stale anchor: ' + memo.selectedText : memo.selectedText);
      card.appendChild(context);

      const body = document.createElement('div');
      body.className = 'body';
      body.textContent = memo.body;
      card.appendChild(body);

      for (const reply of memo.replies) {
        const node = document.createElement('div');
        node.className = 'reply';
        const replyHeader = document.createElement('div');
        replyHeader.className = 'reply-header';
        const replyMain = document.createElement('div');
        replyMain.className = 'reply-main';
        const metaLine = document.createElement('div');
        metaLine.className = 'reply-meta';
        metaLine.textContent = reply.author + ', ' + formatDate(reply.createdAt);
        const replyBody = document.createElement('div');
        replyBody.className = 'reply-body';
        replyBody.textContent = reply.body;
        replyMain.append(metaLine, replyBody);
        replyHeader.appendChild(replyMain);
        replyHeader.appendChild(icon('✓', 'Resolve reply', () => vscode.postMessage({ type: 'resolveReply', id: memo.id, replyId: reply.id })));
        replyHeader.appendChild(replyMenuButton(memo, reply));
        node.appendChild(replyHeader);
        card.appendChild(node);
      }

      const reply = document.createElement('textarea');
      reply.placeholder = 'Reply';
      reply.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          vscode.postMessage({ type: 'reply', id: memo.id, body: reply.value });
          reply.value = '';
        }
        if (event.key === 'Escape') {
          reply.value = '';
          reply.blur();
        }
      });
      card.appendChild(reply);
      return card;
    }

    function menuButton(memo) {
      const wrap = document.createElement('div');
      wrap.className = 'menu-wrap';
      const trigger = icon('⋮', 'More actions', () => {
        const existing = wrap.querySelector('.menu');
        if (existing) {
          existing.remove();
          return;
        }
        const menu = document.createElement('div');
        menu.className = 'menu';
        const edit = document.createElement('button');
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => {
          menu.remove();
          startInlineEdit(wrap.closest('.memo').querySelector('.body'), memo.body, next => {
            vscode.postMessage({ type: 'edit', id: memo.id, body: next });
          });
        });
        const del = document.createElement('button');
        del.className = 'delete';
        del.textContent = 'Delete';
        del.addEventListener('click', () => vscode.postMessage({ type: 'delete', id: memo.id }));
        menu.append(edit, del);
        wrap.appendChild(menu);
      });
      wrap.appendChild(trigger);
      return wrap;
    }

    function replyMenuButton(memo, reply) {
      const wrap = document.createElement('div');
      wrap.className = 'menu-wrap';
      const trigger = icon('⋮', 'More reply actions', () => {
        const existing = wrap.querySelector('.menu');
        if (existing) {
          existing.remove();
          return;
        }
        const menu = document.createElement('div');
        menu.className = 'menu';
        const edit = document.createElement('button');
        edit.textContent = 'Edit';
        edit.addEventListener('click', () => {
          menu.remove();
          startInlineEdit(wrap.closest('.reply').querySelector('.reply-body'), reply.body, next => {
            vscode.postMessage({ type: 'editReply', id: memo.id, replyId: reply.id, body: next });
          });
        });
        const del = document.createElement('button');
        del.className = 'delete';
        del.textContent = 'Delete';
        del.addEventListener('click', () => vscode.postMessage({ type: 'deleteReply', id: memo.id, replyId: reply.id }));
        menu.append(edit, del);
        wrap.appendChild(menu);
      });
      wrap.appendChild(trigger);
      return wrap;
    }

    function startInlineEdit(target, initialValue, onSave) {
      if (!target || target.dataset.editing === 'true') {
        return;
      }
      target.dataset.editing = 'true';
      const original = target.textContent;
      const input = document.createElement('textarea');
      input.value = initialValue;
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !event.shiftKey) {
          event.preventDefault();
          const value = input.value.trim();
          if (value) {
            onSave(value);
          } else {
            cancel();
          }
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          cancel();
        }
      });
      input.addEventListener('blur', () => {
        if (document.body.contains(input)) {
          cancel();
        }
      });
      target.textContent = '';
      target.appendChild(input);
      input.focus();
      input.select();

      function cancel() {
        target.dataset.editing = 'false';
        target.textContent = original;
      }
    }

    function icon(text, title, onClick) {
      const button = document.createElement('button');
      button.className = 'icon';
      button.title = title;
      button.textContent = text;
      button.addEventListener('click', onClick);
      return button;
    }

    function toggleColors(card) {
      card.querySelector('.colors')?.classList.toggle('open');
    }

    function empty(text) {
      const node = document.createElement('div');
      node.className = 'empty';
      node.textContent = text;
      return node;
    }

    function formatDate(value) {
      const date = new Date(value);
      if (Number.isNaN(date.getTime())) {
        return value;
      }
      return date.toLocaleString(undefined, {
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit'
      });
    }

  </script>
</body>
</html>`;
    }
}
class DecorationManager {
    decorations = new Map();
    dispose() {
        for (const decoration of this.decorations.values()) {
            decoration.dispose();
        }
        this.decorations.clear();
    }
    apply(editor, memos) {
        const grouped = new Map();
        for (const memo of memos) {
            const range = resolveMemoRange(editor.document, memo);
            if (!range) {
                continue;
            }
            const list = grouped.get(memo.color) ?? [];
            list.push({
                range,
                hoverMessage: new vscode.MarkdownString(`**${escapeMarkdown(memo.author)}**: ${escapeMarkdown(memo.body)}`)
            });
            grouped.set(memo.color, list);
        }
        for (const color of [...this.decorations.keys()]) {
            if (!grouped.has(color)) {
                const decoration = this.decorations.get(color);
                if (decoration) {
                    editor.setDecorations(decoration, []);
                }
            }
        }
        for (const [color, ranges] of grouped) {
            const decoration = this.getDecoration(color);
            editor.setDecorations(decoration, ranges);
        }
    }
    getDecoration(color) {
        const existing = this.decorations.get(color);
        if (existing) {
            return existing;
        }
        const decoration = vscode.window.createTextEditorDecorationType({
            backgroundColor: alpha(color, "33"),
            border: `1px solid ${alpha(color, "99")}`,
            overviewRulerColor: color,
            overviewRulerLane: vscode.OverviewRulerLane.Right,
            light: {
                backgroundColor: alpha(color, "2b")
            },
            dark: {
                backgroundColor: alpha(color, "38")
            }
        });
        this.decorations.set(color, decoration);
        return decoration;
    }
}
function getSelectionOrWord(editor) {
    if (!editor.selection.isEmpty) {
        return editor.selection;
    }
    const wordRange = editor.document.getWordRangeAtPosition(editor.selection.active);
    return wordRange ?? editor.selection;
}
function rangeToAnchor(range) {
    return {
        startLine: range.start.line,
        startCharacter: range.start.character,
        endLine: range.end.line,
        endCharacter: range.end.character
    };
}
function anchorToRange(anchor) {
    return new vscode.Range(new vscode.Position(anchor.startLine, anchor.startCharacter), new vscode.Position(anchor.endLine, anchor.endCharacter));
}
function resolveMemoRange(document, memo) {
    const direct = anchorToRange(memo.anchor);
    if (isRangeInsideDocument(document, direct)) {
        const text = document.getText(direct);
        if (text === memo.selectedText) {
            return direct;
        }
    }
    const fullText = document.getText();
    const index = fullText.indexOf(memo.selectedText);
    if (index < 0) {
        return null;
    }
    const start = document.positionAt(index);
    const end = document.positionAt(index + memo.selectedText.length);
    return new vscode.Range(start, end);
}
function isRangeInsideDocument(document, range) {
    if (range.start.line < 0 || range.end.line >= document.lineCount) {
        return false;
    }
    const endLine = document.lineAt(range.end.line);
    return range.end.character <= endLine.text.length;
}
function compareMemoPosition(a, b) {
    return a.anchor.startLine - b.anchor.startLine || a.anchor.startCharacter - b.anchor.startCharacter;
}
function compareMemoFileAndPosition(a, b) {
    return a.file.localeCompare(b.file) || compareMemoPosition(a, b);
}
function getVisibleWindow(editor) {
    if (!editor.visibleRanges.length) {
        return null;
    }
    return editor.visibleRanges.reduce((window, range) => ({
        startLine: Math.min(window.startLine, range.start.line),
        endLine: Math.max(window.endLine, range.end.line)
    }), {
        startLine: editor.visibleRanges[0].start.line,
        endLine: editor.visibleRanges[0].end.line
    });
}
function isMemoVisibleAtStartLine(memo, visibleWindow) {
    if (!visibleWindow) {
        return true;
    }
    return memo.anchor.startLine >= visibleWindow.startLine
        && memo.anchor.startLine <= visibleWindow.endLine;
}
function getAlignmentSettings() {
    const config = vscode.workspace.getConfiguration("codexMemo.alignment");
    return {
        topOffsetPx: config.get("topOffsetPx", 0),
        lineHeightPx: config.get("lineHeightPx", 0),
        lineScale: config.get("lineScale", 1),
        cardAnchorOffsetPx: config.get("cardAnchorOffsetPx", 0)
    };
}
async function resolveAuthorName() {
    const gitName = await getGitUserName();
    if (gitName) {
        return gitName;
    }
    const configured = vscode.workspace.getConfiguration("codexMemo").get("authorName");
    if (configured?.trim()) {
        return configured.trim();
    }
    return os.userInfo().username || "Anonymous";
}
async function getGitUserName() {
    const active = vscode.window.activeTextEditor;
    const activeRoot = active ? await findGitRoot(path.dirname(active.document.uri.fsPath)) : null;
    const cwd = activeRoot ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;
    if (!cwd) {
        return null;
    }
    return new Promise((resolve) => {
        cp.execFile("git", ["config", "user.name"], { cwd }, (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const value = stdout.trim();
            resolve(value || null);
        });
    });
}
function authorColor(author) {
    let hash = 0;
    for (const char of author) {
        hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
    }
    return COLORS[hash % COLORS.length];
}
function normalizePath(value) {
    return value.split(path.sep).join("/");
}
function isInsidePath(child, parent) {
    const relative = path.relative(parent, child);
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function findGitRoot(startPath) {
    return new Promise((resolve) => {
        cp.execFile("git", ["-C", startPath, "rev-parse", "--show-toplevel"], (error, stdout) => {
            if (error) {
                resolve(null);
                return;
            }
            const root = stdout.trim();
            resolve(root || null);
        });
    });
}
async function scanForGitRoot(root, maxDepth) {
    try {
        await fs.access(path.join(root, ".git"));
        return root;
    }
    catch {
        // Continue with a bounded scan below.
    }
    if (maxDepth <= 0) {
        return null;
    }
    let entries;
    try {
        entries = await fs.readdir(root, { withFileTypes: true });
    }
    catch {
        return null;
    }
    const ignoredDirs = new Set([
        ".cache",
        ".vscode",
        "build",
        "devel",
        "dist",
        "node_modules",
        "out",
        "target",
        "venv"
    ]);
    for (const entry of entries) {
        if (!entry.isDirectory() || ignoredDirs.has(entry.name)) {
            continue;
        }
        const found = await scanForGitRoot(path.join(root, entry.name), maxDepth - 1);
        if (found) {
            return found;
        }
    }
    return null;
}
function alpha(hex, opacity) {
    return `${hex}${opacity}`;
}
function escapeMarkdown(value) {
    return value.replace(/[\\`*_{}[\]()#+\-.!]/g, "\\$&");
}
function isMemo(value) {
    if (!isRecord(value)) {
        return false;
    }
    return typeof value.id === "string"
        && typeof value.file === "string"
        && isAnchor(value.anchor)
        && typeof value.selectedText === "string"
        && typeof value.body === "string"
        && typeof value.author === "string"
        && typeof value.color === "string"
        && typeof value.createdAt === "string"
        && typeof value.updatedAt === "string"
        && Array.isArray(value.replies);
}
function isAnchor(value) {
    if (!isRecord(value)) {
        return false;
    }
    return Number.isInteger(value.startLine)
        && Number.isInteger(value.startCharacter)
        && Number.isInteger(value.endLine)
        && Number.isInteger(value.endCharacter);
}
function isRecord(value) {
    return typeof value === "object" && value !== null;
}
function debounce(fn, delay) {
    let timer;
    return () => {
        if (timer) {
            clearTimeout(timer);
        }
        timer = setTimeout(fn, delay);
    };
}
//# sourceMappingURL=extension.js.map