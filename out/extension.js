"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    Object.defineProperty(o, k2, { enumerable: true, get: function() { return m[k]; } });
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || function (mod) {
    if (mod && mod.__esModule) return mod;
    var result = {};
    if (mod != null) for (var k in mod) if (k !== "default" && Object.prototype.hasOwnProperty.call(mod, k)) __createBinding(result, mod, k);
    __setModuleDefault(result, mod);
    return result;
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.activate = void 0;
const vscode = __importStar(require("vscode"));
const NodePath = __importStar(require("path"));
const BuildVersion = require('../package.json').version;
const KeyVditorOptions = 'vditor.options';
const KeyOutlinePinned = 'markdown-editor.outlinePinned';
const KeyOutlineWidth = 'markdown-editor.outlineWidth';
let extensionContext;
let activeMarkdownWebview;
let activeMarkdownMode = 'preview';
const markdownWebviewModes = new WeakMap();
const markdownWebviewUris = new WeakMap();
const markdownWebviewDocuments = new WeakMap();
const markdownWebviewSelections = new WeakMap();
const markdownWebviewContextTimes = new WeakMap();
const markdownAutoPromotionInFlight = new Set();
const markdownManualTextOverrides = new Set();
let lastActiveTabSnapshot;
let activeContextEmitter;
function markActiveContextChanged(webview = activeMarkdownWebview) {
    if (webview) {
        markdownWebviewContextTimes.set(webview, Date.now());
    }
    if (activeContextEmitter && (!webview || webview === activeMarkdownWebview)) {
        activeContextEmitter.fire();
    }
}
function invalidateMarkdownSelection(webview) {
    markdownWebviewSelections.delete(webview);
}
function normalizeMarkdownSelection(selection, document) {
    if (!selection || typeof selection.text !== 'string' || !selection.text.length) {
        return undefined;
    }
    if (selection.accuracy === 'rendered-text') {
        return { text: selection.text, accuracy: 'rendered-text' };
    }
    if (selection.accuracy !== 'exact') {
        return undefined;
    }
    const coordinates = ['startOffset', 'endOffset', 'startLine', 'endLine'];
    if (!coordinates.every((key) => Number.isInteger(selection[key]) && selection[key] >= 0)) {
        return undefined;
    }
    const documentText = document.getText();
    if (selection.startOffset > selection.endOffset || selection.endOffset > documentText.length ||
        selection.startLine > selection.endLine || selection.endLine >= document.lineCount ||
        documentText.slice(selection.startOffset, selection.endOffset) !== selection.text) {
        return undefined;
    }
    return {
        text: selection.text,
        startOffset: selection.startOffset,
        endOffset: selection.endOffset,
        startLine: selection.startLine,
        endLine: selection.endLine,
        accuracy: 'exact',
    };
}
function getActiveMarkdownContext(input) {
    const webview = activeMarkdownWebview;
    if (!webview) {
        return undefined;
    }
    const document = markdownWebviewDocuments.get(webview);
    const uri = markdownWebviewUris.get(webview);
    if (!document || !uri) {
        return undefined;
    }
    if (input && input.viewType && input.viewType !== MarkdownEditorProvider.viewType) {
        return undefined;
    }
    if (input && input.uri && input.uri.toString() !== uri.toString()) {
        return undefined;
    }
    const selection = markdownWebviewSelections.get(webview);
    return {
        providerId: 'sightmd',
        viewType: MarkdownEditorProvider.viewType,
        uri,
        languageId: 'markdown',
        documentVersion: document.version,
        isDirty: document.isDirty,
        mode: markdownWebviewModes.get(webview) || 'preview',
        documentText: document.getText(),
        ...(selection ? { selection: { ...selection } } : {}),
        updatedAt: markdownWebviewContextTimes.get(webview) || Date.now(),
    };
}
function setActiveMarkdownWebview(webview) {
    const changed = activeMarkdownWebview !== webview;
    activeMarkdownWebview = webview;
    activeMarkdownMode = markdownWebviewModes.get(webview) || 'preview';
    markdownWebviewModes.set(webview, activeMarkdownMode);
    vscode.commands.executeCommand('setContext', 'markdownEditor.mode', activeMarkdownMode);
    vscode.commands.executeCommand('setContext', 'markdownEditor.active', true);
    const uri = markdownWebviewUris.get(webview);
    if (uri) {
        vscode.commands.executeCommand('setContext', 'markdownEditor.documentUri', uri.toString());
        vscode.commands.executeCommand('setContext', 'markdownEditor.documentLanguage', 'markdown');
        vscode.commands.executeCommand('setContext', 'markdownEditor.documentPath', uri.fsPath);
    }
    if (changed) {
        markActiveContextChanged(webview);
    }
}
function clearActiveMarkdownWebview(webview) {
    if (activeMarkdownWebview !== webview) {
        return;
    }
    activeMarkdownWebview = undefined;
    vscode.commands.executeCommand('setContext', 'markdownEditor.active', false);
    vscode.commands.executeCommand('setContext', 'markdownEditor.documentUri', undefined);
    vscode.commands.executeCommand('setContext', 'markdownEditor.documentLanguage', undefined);
    vscode.commands.executeCommand('setContext', 'markdownEditor.documentPath', undefined);
    markActiveContextChanged();
}
function setMarkdownWebviewVisibility(webview, active) {
    if (active) {
        setActiveMarkdownWebview(webview);
    }
    else if (activeMarkdownWebview === webview) {
        clearActiveMarkdownWebview(webview);
    }
}
function isMarkdownEditorTab(tab) {
    const input = tab === null || tab === void 0 ? void 0 : tab.input;
    return !!(input && (input.viewType === 'markdown-editor.customEditor' || input.viewType === 'markdown-editor'));
}
function getTabInputUri(input) {
    if (!input) {
        return undefined;
    }
    return input.uri || input.modified || input.original;
}
function snapshotActiveTab() {
    const group = vscode.window.tabGroups.activeTabGroup;
    const tab = group && group.activeTab;
    if (!tab) {
        return undefined;
    }
    const custom = isMarkdownEditorTab(tab);
    let uri = getTabInputUri(tab.input);
    if (!uri && custom && activeMarkdownWebview) {
        uri = markdownWebviewUris.get(activeMarkdownWebview);
    }
    if (!uri && !custom && vscode.window.activeTextEditor) {
        uri = vscode.window.activeTextEditor.document.uri;
    }
    const tabs = group && Array.isArray(group.tabs) ? group.tabs : [];
    return {
        group,
        tab,
        index: tabs.indexOf(tab),
        uri,
        key: uri && uri.toString(),
        custom,
    };
}
function recordActiveTabTransition() {
    const current = snapshotActiveTab();
    const previous = lastActiveTabSnapshot;
    if (previous && current && previous.custom && !current.custom &&
        previous.key && previous.key === current.key && previous.group === current.group &&
        !markdownAutoPromotionInFlight.has(current.key)) {
        // Reopen Editor inserts the replacement before closing the custom tab.
        // The same document can move to a different index during that operation.
        markdownManualTextOverrides.add(current.key);
    }
    lastActiveTabSnapshot = current;
}
function recordManualTextEditorActivation(editor) {
    if (!editor || !editor.document || !editor.document.uri || !lastActiveTabSnapshot) {
        return;
    }
    const key = editor.document.uri.toString();
    const previous = lastActiveTabSnapshot;
    if (!previous.custom || previous.key !== key || markdownAutoPromotionInFlight.has(key)) {
        return;
    }
    markdownManualTextOverrides.add(key);
    // activeTextEditor can update before tabGroups. Preserve the tab slot but
    // mark it as text immediately so automatic openWith cannot win the race.
    lastActiveTabSnapshot = {
        group: previous.group,
        tab: previous.tab,
        index: previous.index,
        uri: editor.document.uri,
        key,
        custom: false,
    };
}
function pruneClosedManualTextOverrides() {
    const groups = vscode.window.tabGroups.all;
    if (!Array.isArray(groups)) {
        return;
    }
    const openKeys = new Set();
    groups.forEach((group) => {
        const tabs = Array.isArray(group.tabs) ? group.tabs : [];
        tabs.forEach((tab) => {
            const uri = getTabInputUri(tab.input);
            if (uri) {
                openKeys.add(uri.toString());
            }
        });
    });
    markdownManualTextOverrides.forEach((key) => {
        if (!openKeys.has(key)) {
            markdownManualTextOverrides.delete(key);
        }
    });
}
function refreshActiveEditorContext() {
    const activeGroup = vscode.window.tabGroups.activeTabGroup;
    const activeTab = activeGroup && activeGroup.activeTab;
    if (activeMarkdownWebview && isMarkdownEditorTab(activeTab)) {
        setActiveMarkdownWebview(activeMarkdownWebview);
        return;
    }
    if (activeMarkdownWebview) {
        clearActiveMarkdownWebview(activeMarkdownWebview);
    }
}
function setMarkdownMode(mode) {
    if (!['preview', 'split', 'readonly'].includes(mode)) {
        return;
    }
    const changed = activeMarkdownMode !== mode;
    activeMarkdownMode = mode;
    vscode.commands.executeCommand('setContext', 'markdownEditor.mode', mode);
    if (activeMarkdownWebview) {
        markdownWebviewModes.set(activeMarkdownWebview, mode);
        activeMarkdownWebview.postMessage({ command: 'markdown-editor:set-mode', mode });
        if (changed) {
            markActiveContextChanged(activeMarkdownWebview);
        }
    }
}
function getEditorUiState(webview = activeMarkdownWebview) {
    return {
        editorMode: (webview && markdownWebviewModes.get(webview)) || 'preview',
        editorTheme: vscode.workspace.getConfiguration('markdown-editor').get('theme') || 'default',
        pinned: extensionContext ? extensionContext.globalState.get(KeyOutlinePinned, false) : false,
        outlineWidth: extensionContext ? extensionContext.globalState.get(KeyOutlineWidth, 220) : 220,
    };
}
function debug(...args) {
    console.log(...args);
}
function showError(msg) {
    vscode.window.showErrorMessage(`[markdown-editor] ${msg}`);
}
/**
 * Webview CSP. VS Code's default CSP only allows scripts/styles from the webview
 * resource scheme, which blocks Vditor from loading its diagram runtimes (mermaid,
 * echarts, graphviz) from the unpkg CDN at render time, and blocks graphviz's blob
 * Web Worker. Loosen it just enough to let those runtimes load and run.
 */
function buildCsp(webview) {
    return [
        "default-src 'none'",
        `img-src ${webview.cspSource} https: data: blob:`,
        `style-src ${webview.cspSource} 'unsafe-inline' https:`,
        `font-src ${webview.cspSource} https: data:`,
        `script-src ${webview.cspSource} 'unsafe-inline' 'unsafe-eval' https:`,
        "worker-src blob: https:",
        "connect-src https: data: blob:"
    ].join('; ');
}
function escapeHtmlAttribute(value) {
    return String(value || '')
        .replace(/&/g, '&amp;')
        .replace(/"/g, '&quot;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
}
function resolveGraphicPreviewSource(documentUri, webview, source) {
    const value = String(source || '').trim();
    if (!value) {
        return undefined;
    }
    if (/^(?:data:image\/|https?:|blob:|vscode-webview(?:-resource)?:)/i.test(value)) {
        return value;
    }
    try {
        if (/^file:/i.test(value)) {
            return webview.asWebviewUri(vscode.Uri.parse(value)).toString();
        }
        const clean = value.split('#')[0].split('?')[0];
        const decoded = decodeURIComponent(clean);
        const localPath = NodePath.isAbsolute(decoded)
            ? decoded
            : NodePath.resolve(NodePath.dirname(documentUri.fsPath), decoded);
        return webview.asWebviewUri(vscode.Uri.file(localPath)).toString();
    }
    catch (_) {
        return undefined;
    }
}
function openGraphicPreview(documentUri, preview) {
    if (!preview || preview.kind !== 'image') {
        return;
    }
    const column = vscode.ViewColumn && vscode.ViewColumn.Active !== undefined
        ? vscode.ViewColumn.Active
        : vscode.ViewColumn.One;
    const panel = vscode.window.createWebviewPanel('markdown-editor.graphicPreview', 'Graphic Preview', column, {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.file('/')],
        retainContextWhenHidden: false,
    });
    const source = resolveGraphicPreviewSource(documentUri, panel.webview, preview.src);
    if (!source) {
        panel.dispose();
        showError('Cannot open graphic preview.');
        return;
    }
    const alt = escapeHtmlAttribute(preview.alt || 'Graphic preview');
    const src = escapeHtmlAttribute(source);
    panel.webview.html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta http-equiv="Content-Security-Policy" content="${buildCsp(panel.webview)}">
<title>Graphic Preview</title>
<style>
html,body{width:100%;height:100%;margin:0;background:var(--vscode-editor-background);color:var(--vscode-editor-foreground);overflow:hidden}
main{display:grid;place-items:center;box-sizing:border-box;width:100%;height:100%;padding:56px;overflow:auto}
img{display:block;max-width:100%;max-height:100%;width:auto;height:auto;object-fit:contain}
button{position:fixed;top:16px;right:16px;width:32px;height:32px;border:1px solid var(--vscode-editorWidget-border);border-radius:9px;background:var(--vscode-editor-background);color:var(--vscode-descriptionForeground);font:20px/1 sans-serif;cursor:pointer}
button:hover{color:var(--vscode-focusBorder);background:var(--vscode-toolbar-hoverBackground)}
</style>
</head>
<body><button id="close" type="button" title="Close" aria-label="Close">&times;</button><main><img src="${src}" alt="${alt}"></main>
<script>const api=acquireVsCodeApi();const close=()=>api.postMessage({command:'close'});document.getElementById('close').addEventListener('click',close);document.addEventListener('keydown',event=>{if(event.key==='Escape')close()});</script>
</body></html>`;
    panel.webview.onDidReceiveMessage((message) => {
        if (message && message.command === 'close') {
            panel.dispose();
        }
    });
}
/**
 * True when a document change came from disk rather than from the webview.
 *
 * Webview edits reach the document through applyEdit and always leave it dirty, so a
 * content change that leaves the document clean can only be VS Code reloading a file
 * that another program wrote. That also means there is no pending webview edit to
 * clobber: if the webview had unsynced content, the document would still be dirty.
 *
 * The contentChanges check matters: onDidChangeTextDocument also fires for pure
 * dirty-state transitions with an empty contentChanges array, so every save (incl.
 * autosave) emits a clean-document event that must not be mistaken for a reload.
 */
function isExternalReload(e) {
    return e.contentChanges.length > 0 && !e.document.isDirty;
}
function resolveMarkdownLink(markdownFileUri, href) {
    if (!href || href[0] === '#') {
        return undefined;
    }
    if (/^https?:\/\//i.test(href)) {
        return { kind: 'remote', uri: vscode.Uri.parse(href), display: href };
    }
    if (/^file:/i.test(href)) {
        const uri = vscode.Uri.parse(href.split('#')[0]);
        return { kind: 'local', uri, display: uri.fsPath };
    }
    if (/^[a-zA-Z]:[\\/]/.test(href)) {
        const uri = vscode.Uri.file(href.split(/[?#]/)[0]);
        return { kind: 'local', uri, display: uri.fsPath };
    }
    if (/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(href)) {
        return { kind: 'uri', uri: vscode.Uri.parse(href), display: href };
    }
    let localHref = href.split(/[?#]/)[0];
    try {
        localHref = decodeURIComponent(localHref);
    }
    catch (_) { }
    if (!localHref) {
        return undefined;
    }
    const uri = vscode.Uri.file(NodePath.resolve(NodePath.dirname(markdownFileUri.fsPath), localHref));
    return { kind: 'local', uri, display: uri.fsPath };
}
function escapeMarkdownLinkText(value) {
    return value.replace(/\\/g, '\\\\').replace(/\[/g, '\\[').replace(/\]/g, '\\]');
}
function encodeMarkdownTarget(value) {
    const needsAngleBrackets = /[\s()]/.test(value);
    const encoded = value
        .replace(/%/g, '%25')
        .replace(/#/g, '%23')
        .replace(/\?/g, '%3F')
        .replace(/</g, '%3C')
        .replace(/>/g, '%3E')
        .replace(/\s/g, (character) => encodeURIComponent(character))
        .replace(/\(/g, '%28')
        .replace(/\)/g, '%29');
    return needsAngleBrackets ? `<${encoded}>` : encoded;
}
function createDocumentLinkMarkdown(markdownFileUri, targetUri) {
    const label = escapeMarkdownLinkText(NodePath.basename(targetUri.fsPath));
    const fromDirectory = NodePath.dirname(markdownFileUri.fsPath);
    const fromRoot = NodePath.parse(fromDirectory).root.toLowerCase();
    const targetRoot = NodePath.parse(targetUri.fsPath).root.toLowerCase();
    let target;
    if (process.platform === 'win32' && fromRoot !== targetRoot) {
        target = targetUri.toString(true);
    }
    else {
        target = NodePath.relative(fromDirectory, targetUri.fsPath).replace(/\\/g, '/');
        if (!target.startsWith('.')) {
            target = `./${target}`;
        }
    }
    return `[${label}](${encodeMarkdownTarget(target)})`;
}
async function pickDocumentLink(markdownFileUri, webview) {
    try {
        const selected = await vscode.window.showOpenDialog({
            canSelectFiles: true,
            canSelectFolders: false,
            canSelectMany: false,
            defaultUri: vscode.Uri.file(NodePath.dirname(markdownFileUri.fsPath)),
            openLabel: 'Insert Document Link',
        });
        if (!selected || !selected[0]) {
            return;
        }
        await webview.postMessage({
            command: 'markdown-editor:insert-document-link',
            markdown: createDocumentLinkMarkdown(markdownFileUri, selected[0]),
        });
    }
    catch (error) {
        showError(`Cannot insert document link: ${error instanceof Error ? error.message : String(error)}`);
    }
}
async function postResolvedLinkPreview(markdownFileUri, webview, message) {
    const resolved = resolveMarkdownLink(markdownFileUri, message.href);
    if (!resolved) {
        return;
    }
    await webview.postMessage({
        command: 'markdown-editor:resolved-link-preview',
        requestId: message.requestId,
        href: message.href,
        display: resolved.display,
    });
}
/**
 * Opens web links externally and resolves local links from the Markdown file.
 */
async function openMarkdownLink(markdownFileUri, href) {
    const resolved = resolveMarkdownLink(markdownFileUri, href);
    if (!resolved) {
        return;
    }
    if (resolved.kind === 'remote') {
        try {
            const opened = await vscode.env.openExternal(resolved.uri);
            if (opened === false) {
                showError(`Cannot open link target: ${href}`);
            }
        }
        catch (error) {
            showError(`Cannot open link target: ${href}`);
        }
        return;
    }
    if (resolved.kind === 'uri') {
        await vscode.commands.executeCommand('vscode.open', resolved.uri);
        return;
    }
    const localUri = resolved.uri;
    let fileStat;
    try {
        fileStat = await vscode.workspace.fs.stat(localUri);
    }
    catch (error) {
        showError(`Cannot open link target: ${href}`);
        return;
    }
    if (fileStat.type === vscode.FileType.Directory) {
        await vscode.commands.executeCommand('revealInExplorer', localUri);
        return;
    }
    const extension = NodePath.extname(localUri.fsPath).toLowerCase();
    if (extension === '.md' || extension === '.markdown') {
        await vscode.commands.executeCommand('vscode.openWith', localUri, MarkdownEditorProvider.viewType);
        return;
    }
    try {
        await vscode.commands.executeCommand('vscode.open', localUri);
    }
    catch (error) {
        try {
            const opened = await vscode.env.openExternal(localUri);
            if (opened === false) {
                showError(`Cannot open link target: ${href}`);
            }
        }
        catch (fallbackError) {
            showError(`Cannot open link target: ${href}`);
        }
    }
}
function hasConflictingExplicitEditorAssociation(document) {
    const inspected = vscode.workspace.getConfiguration('workbench').inspect('editorAssociations');
    if (!inspected) {
        return false;
    }
    const explicitValues = [
        inspected.globalValue,
        inspected.workspaceValue,
        inspected.workspaceFolderValue,
    ];
    return explicitValues.some((associations) => {
        if (!associations || typeof associations !== 'object') {
            return false;
        }
        return Object.entries(associations).some(([pattern, editorId]) => {
            if (!editorId || editorId === MarkdownEditorProvider.viewType) {
                return false;
            }
            return vscode.languages.match({ pattern }, document) > 0;
        });
    });
}
async function maybeOpenMarkdownWithCustomEditor(editor) {
    if (!editor || editor !== vscode.window.activeTextEditor || editor.document.languageId !== 'markdown' || editor.document.isUntitled) {
        return;
    }
    if (hasConflictingExplicitEditorAssociation(editor.document)) {
        return;
    }
    const key = editor.document.uri.toString();
    if (markdownManualTextOverrides.has(key)) {
        return;
    }
    if (markdownAutoPromotionInFlight.has(key)) {
        return;
    }
    markdownAutoPromotionInFlight.add(key);
    try {
        await vscode.commands.executeCommand('vscode.openWith', editor.document.uri, MarkdownEditorProvider.viewType, {
            viewColumn: editor.viewColumn,
            preserveFocus: false,
        });
    }
    catch (error) {
        debug('automatic custom editor association failed', error);
    }
    finally {
        markdownAutoPromotionInFlight.delete(key);
    }
}
function activate(context) {
    extensionContext = context;
    activeContextEmitter = new vscode.EventEmitter();
    context.subscriptions.push(activeContextEmitter);
    vscode.commands.executeCommand('setContext', 'markdownEditor.mode', activeMarkdownMode);
    vscode.commands.executeCommand('setContext', 'markdownEditor.active', false);
    vscode.commands.executeCommand('setContext', 'markdownEditor.documentUri', undefined);
    vscode.commands.executeCommand('setContext', 'markdownEditor.documentLanguage', undefined);
    vscode.commands.executeCommand('setContext', 'markdownEditor.documentPath', undefined);
    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor((editor) => {
        recordManualTextEditorActivation(editor);
        // Custom editors do not populate activeTextEditor. Resolve toolbar state from
        // the active tab instead, so switching to any other editor clears the actions.
        setTimeout(() => {
            recordActiveTabTransition();
            refreshActiveEditorContext();
            maybeOpenMarkdownWithCustomEditor(editor);
        }, 0);
    }));
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabs(() => {
        // Capture each transition before later tab events replace its state.
        recordActiveTabTransition();
        setTimeout(() => {
            recordActiveTabTransition();
            pruneClosedManualTextOverrides();
            refreshActiveEditorContext();
        }, 0);
    }));
    context.subscriptions.push(vscode.window.tabGroups.onDidChangeTabGroups(() => {
        recordActiveTabTransition();
        setTimeout(() => {
            recordActiveTabTransition();
            pruneClosedManualTextOverrides();
            refreshActiveEditorContext();
        }, 0);
    }));
    // Register original command (used by context menu/shortcuts)
    context.subscriptions.push(vscode.commands.registerCommand('markdown-editor.openEditor', async (uri) => {
        const activeTextEditor = vscode.window.activeTextEditor;
        const targetUri = uri || (activeTextEditor && activeTextEditor.document.uri);
        if (!targetUri) {
            showError(`Did not open markdown file!`);
            return;
        }
        await vscode.commands.executeCommand('vscode.openWith', targetUri, MarkdownEditorProvider.viewType);
    }));
    context.subscriptions.push(vscode.commands.registerCommand('markdown-editor.mode.preview', () => setMarkdownMode('preview')));
    context.subscriptions.push(vscode.commands.registerCommand('markdown-editor.mode.split', () => setMarkdownMode('split')));
    context.subscriptions.push(vscode.commands.registerCommand('markdown-editor.mode.readonly', () => setMarkdownMode('readonly')));
    context.subscriptions.push(vscode.commands.registerCommand('markdown-editor.selectTheme', async () => {
        const themes = [
            { label: 'Default', value: 'default' },
            { label: 'Pine Ink', value: 'pine' },
            { label: 'Red', value: 'red' },
            { label: 'Orange', value: 'orange' },
            { label: 'Green', value: 'green' },
        ];
        const current = vscode.workspace.getConfiguration('markdown-editor').get('theme') || 'default';
        const themeColors = {
            default: 'editor-foreground',
            pine: 'charts.green',
            red: 'charts.red',
            orange: 'charts.orange',
            green: 'charts.green',
        };
        const items = themes.map((theme) => ({
            ...theme,
            description: theme.value === current ? 'Current theme' : 'Markdown rendering theme',
            detail: theme.value === 'default'
                ? 'VS Code theme colors with a restrained document layout'
                : `${theme.label} document accents and heading treatment`,
            iconPath: new vscode.ThemeIcon('circle-filled', new vscode.ThemeColor(themeColors[theme.value])),
        }));
        const picker = vscode.window.createQuickPick();
        picker.title = 'Markdown Editor Theme';
        picker.placeholder = 'Choose a rendering theme';
        picker.matchOnDescription = true;
        picker.matchOnDetail = true;
        picker.items = items;
        const currentItem = items.find((item) => item.value === current);
        if (currentItem) {
            picker.activeItems = [currentItem];
        }
        const selected = await new Promise((resolve) => {
            picker.onDidAccept(() => resolve(picker.selectedItems[0]));
            picker.onDidHide(() => resolve(undefined));
            picker.show();
        });
        picker.dispose();
        if (!selected) {
            return;
        }
        await vscode.workspace.getConfiguration('markdown-editor').update('theme', selected.value, vscode.ConfigurationTarget.Global);
        if (activeMarkdownWebview) {
            activeMarkdownWebview.postMessage({ command: 'markdown-editor:set-theme', theme: selected.value });
        }
    }));
    // Register CustomTextEditorProvider (for "Open With" and default editor)
    context.subscriptions.push(vscode.window.registerCustomEditorProvider(MarkdownEditorProvider.viewType, new MarkdownEditorProvider(context), {
        webviewOptions: {
            retainContextWhenHidden: true,
        },
        supportsMultipleEditorsPerDocument: false,
    }));
    lastActiveTabSnapshot = snapshotActiveTab();
    maybeOpenMarkdownWithCustomEditor(vscode.window.activeTextEditor);
    context.globalState.setKeysForSync([KeyVditorOptions, KeyOutlinePinned, KeyOutlineWidth]);
    return {
        customEditorContextProvider: {
            apiVersion: 1,
            getActiveContext: getActiveMarkdownContext,
            onDidChangeActiveContext: activeContextEmitter.event,
        },
    };
}
exports.activate = activate;
/**
 * Manages cat coding webview panels
 */
class EditorPanel {
    constructor(_context, _panel, _extensionUri, _document, _uri = _document.uri // Opened from explorer, only uri exists, no _document
    ) {
        // Set the webview's initial html content
        this._context = _context;
        this._panel = _panel;
        this._extensionUri = _extensionUri;
        this._document = _document;
        this._uri = _uri;
        this._disposables = [];
        this._isEdit = false;
        this._init();
        markdownWebviewUris.set(this._panel.webview, this._uri);
        setActiveMarkdownWebview(this._panel.webview);
        this._panel.onDidChangeViewState((event) => {
            if (event.webviewPanel.active) {
                setMarkdownWebviewVisibility(event.webviewPanel.webview, true);
                event.webviewPanel.webview.postMessage({ command: 'markdown-editor:set-mode', mode: activeMarkdownMode });
            }
            else {
                setMarkdownWebviewVisibility(event.webviewPanel.webview, false);
            }
        }, null, this._disposables);
        // Listen for when the panel is disposed
        // This happens when the user closes the panel or when the panel is closed programmatically
        this._panel.onDidDispose(() => this.dispose(), null, this._disposables);
        let textEditTimer;
        let applyingWebviewEdit = 0;
        let webviewEditQueue = Promise.resolve();
        const syncToEditor = (content) => {
            webviewEditQueue = webviewEditQueue.catch(() => undefined).then(async () => {
                debug('sync to editor', this._document, this._uri);
                if (this._document) {
                    if (this._document.getText() === content) {
                        return;
                    }
                    const edit = new vscode.WorkspaceEdit();
                    const fullDocumentRange = new vscode.Range(this._document.positionAt(0), this._document.positionAt(this._document.getText().length));
                    edit.replace(this._document.uri, fullDocumentRange, content);
                    applyingWebviewEdit += 1;
                    try {
                        await vscode.workspace.applyEdit(edit);
                    }
                    finally {
                        applyingWebviewEdit -= 1;
                    }
                }
                else if (this._uri) {
                    await vscode.workspace.fs.writeFile(this._uri, Buffer.from(content));
                }
                else {
                    showError(`Cannot find original file to save!`);
                }
            });
            return webviewEditQueue;
        };
        // close EditorPanel when vsc editor is close
        vscode.workspace.onDidCloseTextDocument((e) => {
            if (e.fileName === this._fsPath) {
                this.dispose();
            }
        }, this._disposables);
        // re-init webview when VS Code theme changes
        vscode.window.onDidChangeActiveColorTheme((theme) => {
            this._update({
                type: 'init',
                options: EditorPanel.getVditorOptions(this._context),
                theme: theme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
                ...getEditorUiState(this._panel.webview),
            });
        }, null, this._disposables);
        // update EditorPanel when vsc editor changes
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.fileName !== this._document.fileName) {
                return;
            }
            if (applyingWebviewEdit > 0) {
                return;
            }
            // Don't echo the webview's own edits back at it, but always take a change that
            // came from disk: the panel stays "active" while another program has focus, so
            // this would otherwise drop every external edit.
            if (this._panel.active && !isExternalReload(e)) {
                return;
            }
            textEditTimer && clearTimeout(textEditTimer);
            textEditTimer = setTimeout(() => {
                this._update();
                this._updateEditTitle();
            }, 300);
        }, this._disposables);
        // Handle messages from the webview
        this._panel.webview.onDidReceiveMessage(async (message) => {
            debug('msg from webview review', message, this._panel.active);
            switch (message.command) {
                case 'ready': {
                    this._update({
                        type: 'init',
                        options: EditorPanel.getVditorOptions(this._context),
                        theme: vscode.window.activeColorTheme.kind ===
                            vscode.ColorThemeKind.Dark
                            ? 'dark'
                            : 'light',
                        ...getEditorUiState(this._panel.webview),
                    });
                    break;
                }
                case 'save-options':
                    this._context.globalState.update(KeyVditorOptions, message.options);
                    break;
                case 'outline-pinned':
                    if (typeof message.pinned === 'boolean')
                        await this._context.globalState.update(KeyOutlinePinned, message.pinned);
                    break;
                case 'outline-width':
                    if (typeof message.width === 'number' && Number.isFinite(message.width))
                        await this._context.globalState.update(KeyOutlineWidth, Math.max(190, Math.min(520, message.width)));
                    break;
                case 'scroll':
                    EditorPanel._scrollPositions.set(this._fsPath, message.top || 0);
                    break;
                case 'info':
                    vscode.window.showInformationMessage(message.content);
                    break;
                case 'error':
                    showError(message.content);
                    break;
                case 'edit': {
                    // Only sync to VS Code editor when webview is in edit mode to avoid repeated refresh
                    if (this._panel.active) {
                        await syncToEditor(message.content);
                        this._updateEditTitle();
                    }
                    break;
                }
                case 'reset-config': {
                    await this._context.globalState.update(KeyVditorOptions, {});
                    break;
                }
                case 'save': {
                    await syncToEditor(message.content);
                    await this._document.save();
                    this._updateEditTitle();
                    break;
                }
                case 'upload': {
                    const assetsFolder = EditorPanel.getAssetsFolder(this._uri);
                    try {
                        await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetsFolder));
                    }
                    catch (error) {
                        console.error(error);
                        showError(`Invalid image folder: ${assetsFolder}`);
                    }
                    await Promise.all(message.files.map(async (f) => {
                        const content = Buffer.from(f.base64, 'base64');
                        return vscode.workspace.fs.writeFile(vscode.Uri.file(NodePath.join(assetsFolder, f.name)), content);
                    }));
                    const files = message.files.map((f) => NodePath.relative(NodePath.dirname(this._fsPath), NodePath.join(assetsFolder, f.name)).replace(/\\/g, '/'));
                    this._panel.webview.postMessage({
                        command: 'uploaded',
                        files,
                    });
                    break;
                }
                case 'open-link': {
                    await openMarkdownLink(this._uri, message.href);
                    break;
                }
                case 'pick-document-link': {
                    await pickDocumentLink(this._uri, this._panel.webview);
                    break;
                }
                case 'resolve-link-preview': {
                    await postResolvedLinkPreview(this._uri, this._panel.webview, message);
                    break;
                }
                case 'open-graphic-preview': {
                    openGraphicPreview(this._uri, message.preview);
                    break;
                }
            }
        }, null, this._disposables);
    }
    static async createOrShow(context, uri) {
        var _a, _b;
        const { extensionUri } = context;
        const column = vscode.window.activeTextEditor
            ? vscode.window.activeTextEditor.viewColumn
            : undefined;
        // Known limitation: switching files disposes and recreates this panel (a brand
        // new webview), which can trigger a VS Code platform-level transition where the
        // new webview briefly renders at the wrong zoom level before VS Code's own
        // zoom-sync (Electron webContents.setZoomFactor, applied outside this page's
        // control) settles - see PR #166. Confirmed this is specific to that dispose+
        // recreate transition, not "any new webview": the *first* panel ever opened in a
        // session does not show it, only switching to a different file does. Reusing the
        // same panel across file switches (updating its bound document in place, the
        // same flash-free mechanism already used for theme changes) would likely avoid
        // it, but requires also keeping <base href> (used to resolve relative image/file
        // links) in sync with whichever file is currently bound instead of baking it into
        // the HTML once at panel-creation time - deliberately not done here for now.
        if (EditorPanel.currentPanel && uri !== ((_a = EditorPanel.currentPanel) === null || _a === void 0 ? void 0 : _a._uri)) {
            EditorPanel.currentPanel.dispose();
        }
        // If we already have a panel, show it.
        if (EditorPanel.currentPanel) {
            EditorPanel.currentPanel._panel.reveal(column);
            EditorPanel.currentPanel._panel.webview.postMessage({ command: 'focus' });
            return;
        }
        if (!vscode.window.activeTextEditor && !uri) {
            showError(`Did not open markdown file!`);
            return;
        }
        let doc;
        // From context menu: Find if there is a markdown editor for the current active TextEditor, if so bind the document
        if (uri) {
            // Open file from context menu: Open document first then enable auto-sync, otherwise cannot save file or sync to opened document
            doc = await vscode.workspace.openTextDocument(uri);
        }
        else {
            doc = (_b = vscode.window.activeTextEditor) === null || _b === void 0 ? void 0 : _b.document;
            // from command mode
            if (doc && doc.languageId !== 'markdown') {
                showError(`Current file language is not markdown, got ${doc.languageId}`);
                return;
            }
        }
        if (!doc) {
            showError(`Cannot find markdown file!`);
            return;
        }
        // Otherwise, create a new panel.
        const panel = vscode.window.createWebviewPanel(EditorPanel.viewType, 'markdown-editor', column || vscode.ViewColumn.One, EditorPanel.getWebviewOptions(uri));
        EditorPanel.currentPanel = new EditorPanel(context, panel, extensionUri, doc, uri);
    }
    static getFolders() {
        const data = [];
        for (let i = 65; i <= 90; i++) {
            data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`));
        }
        return data;
    }
    static getWebviewOptions(uri) {
        return {
            // Enable javascript in the webview
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file("/"), ...this.getFolders()],
            retainContextWhenHidden: true,
            enableCommandUris: true,
            enableFindWidget: true,
        };
    }
    get _fsPath() {
        return this._uri.fsPath;
    }
    static get config() {
        return vscode.workspace.getConfiguration('markdown-editor');
    }
    /**
     * Builds initial Vditor options from VS Code settings and saved options.
     */
    static getVditorOptions(context) {
        return {
            useVscodeThemeColor: EditorPanel.config.get('useVscodeThemeColor'),
            ...context.globalState.get(KeyVditorOptions),
        };
    }
    static getAssetsFolder(uri) {
        var _a;
        const imageSaveFolder = (EditorPanel.config.get('imageSaveFolder') || 'assets')
            .replace('${projectRoot}', ((_a = vscode.workspace.getWorkspaceFolder(uri)) === null || _a === void 0 ? void 0 : _a.uri.fsPath) || '')
            .replace('${file}', uri.fsPath)
            .replace('${fileBasenameNoExtension}', NodePath.basename(uri.fsPath, NodePath.extname(uri.fsPath)))
            .replace('${dir}', NodePath.dirname(uri.fsPath));
        const assetsFolder = NodePath.resolve(NodePath.dirname(uri.fsPath), imageSaveFolder);
        return assetsFolder;
    }
    dispose() {
        clearActiveMarkdownWebview(this._panel.webview);
        EditorPanel.currentPanel = undefined;
        // Clean up our resources
        this._panel.dispose();
        while (this._disposables.length) {
            const x = this._disposables.pop();
            if (x) {
                x.dispose();
            }
        }
    }
    _init() {
        const webview = this._panel.webview;
        this._panel.webview.html = this._getHtmlForWebview(webview);
        this._panel.title = NodePath.basename(this._fsPath);
    }
    _updateEditTitle() {
        const isEdit = this._document.isDirty;
        if (isEdit !== this._isEdit) {
            this._isEdit = isEdit;
            this._panel.title = `${isEdit ? `[edit]` : ''}${NodePath.basename(this._fsPath)}`;
        }
    }
    // private fileToWebviewUri = (f: string) => {
    //   return this._panel.webview.asWebviewUri(vscode.Uri.file(f)).toString()
    // }
    async _update(props = { options: void 0 }) {
        const md = this._document
            ? this._document.getText()
            : (await vscode.workspace.fs.readFile(this._uri)).toString();
        // const dir = NodePath.dirname(this._document.fileName)
        this._panel.webview.postMessage({
            command: 'update',
            content: md,
            ...(props.type === 'init'
                ? { scrollTop: EditorPanel._scrollPositions.get(this._fsPath) || 0 }
                : {}),
            ...props,
        });
    }
    _getHtmlForWebview(webview) {
        const toUri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this._extensionUri, f));
        const baseHref = NodePath.dirname(webview.asWebviewUri(vscode.Uri.file(this._fsPath)).toString()) + '/';
        const toMediaPath = (f) => `media/dist/${f}`;
        const JsFiles = ['main.js'].map(toMediaPath).map(toUri);
        const CssFiles = ['main.css'].map(toMediaPath).map(toUri);
        const enhancementCss = `${toUri('media/eyan-editor.css')}?v=${encodeURIComponent(BuildVersion)}`;
        const enhancementJs = `${toUri('media/eyan-editor.js')}?v=${encodeURIComponent(BuildVersion)}`;
        const initialEditorTheme = EditorPanel.config.get('theme') || 'default';
        const initialVscodeDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const initialBodyClasses = [initialVscodeDark ? 'eyan-vscode-dark' : '', initialEditorTheme === 'default' ? '' : `eyan-theme-${initialEditorTheme}`].filter(Boolean).join(' ');
        const initialSurface = initialEditorTheme === 'default' ? 'var(--vscode-editor-background, #fff)' : '#fff';
        const initialHtmlClasses = initialEditorTheme === 'default' ? '' : `eyan-theme-${initialEditorTheme}`;
        return (`<!DOCTYPE html>
			<html lang="en"${initialHtmlClasses ? ` class="${initialHtmlClasses}"` : ''}>
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="${buildCsp(webview)}">
				<base href="${baseHref}" />

					<style>${EditorPanel.appVisibilityCss}html,body,#app{background:${initialSurface}!important;color-scheme:${initialVscodeDark && initialEditorTheme === 'default' ? 'dark' : 'light'}}</style>

				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet" onload="document.body.setAttribute('data-vmd-css-loaded','1')" onerror="document.body.setAttribute('data-vmd-css-loaded','1')">`).join('\n')}
				<link href="${enhancementCss}" rel="stylesheet">

				<title>markdown editor</title>
        <style>` +
            EditorPanel.config.get('customCss') +
            `</style>
			</head>
				<body class="${initialBodyClasses}" data-eyan-build="${BuildVersion}">
				<div id="app"></div>


				${JsFiles.map((f) => `<script src="${f}"></script>`).join('\n')}
				<script src="${enhancementJs}"></script>
			</body>
			</html>`);
    }
}
EditorPanel.viewType = 'markdown-editor';
/**
 * Remembers the last scroll position for each file, keyed by fsPath, so that
 * switching to another file and back doesn't reset the reading position.
 * Shared across both the EditorPanel (singleton webview, disposed/recreated per
 * file) and MarkdownEditorProvider (one webview per document via "Open With")
 * entry points, since neither keeps the panel instance alive across a full close.
 */
EditorPanel._scrollPositions = new Map();
/**
 * Hides #app until BOTH of these are true: (a) the external main.css has actually
 * finished loading (its <link>'s onload sets data-vmd-css-loaded="1" - see below),
 * and (b) main.ts confirms Vditor has fully finished building its UI and applying
 * the saved scroll position (sets data-vmd-ready="1" - see main.ts). Both
 * conditions are necessary: a script's execution is not guaranteed to wait for an
 * earlier stylesheet to finish loading, so Vditor can finish building (and fire
 * its ready signal) *before* its own real CSS sizing has actually loaded, which
 * would flash an intermediate, oddly-scaled paint (e.g. toolbar buttons at native
 * SVG size) - most noticeable right after a file switch recreates the webview.
 * This rule is deliberately inlined into the HTML <head> of both webview templates
 * rather than placed in main.css itself, since that stylesheet is exactly the
 * thing this rule needs to not depend on to take effect.
 */
EditorPanel.appVisibilityCss = `#app{opacity:0}body[data-vmd-ready="1"][data-vmd-css-loaded="1"] #app{opacity:1}`;
/**
 * MarkdownEditorProvider implements CustomTextEditorProvider interface
 * Supports opening markdown files via "Open With"
 */
class MarkdownEditorProvider {
    constructor(context) {
        this.context = context;
    }
    /**
     * Called when user selects Markdown Editor via "Open With"
     */
    async resolveCustomTextEditor(document, webviewPanel, _token) {
        const panelWebview = webviewPanel.webview;
        let disposed = false;
        // Set webview options
        panelWebview.options = this.getWebviewOptions();
        // Init webview content
        const uri = document.uri;
        panelWebview.html = this.getHtmlForWebview(panelWebview, uri);
        webviewPanel.title = NodePath.basename(uri.fsPath);
        markdownWebviewUris.set(panelWebview, uri);
        markdownWebviewDocuments.set(panelWebview, document);
        markdownWebviewContextTimes.set(panelWebview, Date.now());
        setActiveMarkdownWebview(panelWebview);
        const disposables = [];
        webviewPanel.onDidChangeViewState((event) => {
            if (event.webviewPanel.active) {
                setMarkdownWebviewVisibility(event.webviewPanel.webview, true);
                event.webviewPanel.webview.postMessage({ command: 'markdown-editor:set-mode', mode: activeMarkdownMode });
            }
            else {
                setMarkdownWebviewVisibility(event.webviewPanel.webview, false);
            }
        }, null, disposables);
        vscode.window.onDidChangeActiveColorTheme((theme) => {
            updateWebview({
                type: 'init',
                options: EditorPanel.getVditorOptions(this.context),
                theme: theme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
                ...getEditorUiState(panelWebview),
            });
        }, null, disposables);
        let isEditing = false;
        let applyingWebviewEdit = 0;
        let webviewEditQueue = Promise.resolve();
        // Update title to show edit status
        const updateEditTitle = () => {
            const isDirty = document.isDirty;
            if (isDirty !== isEditing) {
                isEditing = isDirty;
                webviewPanel.title = `${isDirty ? '[edit]' : ''}${NodePath.basename(uri.fsPath)}`;
            }
        };
        // Send update to webview
        const updateWebview = (props = {}) => {
            if (disposed) {
                return;
            }
            panelWebview.postMessage({
                command: 'update',
                content: document.getText(),
                ...(props.type === 'init'
                    ? { scrollTop: EditorPanel._scrollPositions.get(uri.fsPath) || 0 }
                    : {}),
                ...props,
            });
        };
        const syncToEditor = (content) => {
            webviewEditQueue = webviewEditQueue.catch(() => undefined).then(async () => {
                if (document.getText() === content) {
                    return;
                }
                const edit = new vscode.WorkspaceEdit();
                const fullDocumentRange = new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length));
                edit.replace(document.uri, fullDocumentRange, content);
                applyingWebviewEdit += 1;
                try {
                    await vscode.workspace.applyEdit(edit);
                }
                finally {
                    applyingWebviewEdit -= 1;
                }
            });
            return webviewEditQueue;
        };
        // Listen for document close
        vscode.workspace.onDidCloseTextDocument((e) => {
            if (e.fileName === uri.fsPath) {
                webviewPanel.dispose();
            }
        }, null, disposables);
        // Listen for document changes (sync from external editor to webview)
        vscode.workspace.onDidChangeTextDocument((e) => {
            if (e.document.fileName !== document.fileName) {
                return;
            }
            invalidateMarkdownSelection(panelWebview);
            markActiveContextChanged(panelWebview);
            if (applyingWebviewEdit > 0) {
                return;
            }
            // Don't echo the webview's own edits back at it, but always take a change that
            // came from disk - see isExternalReload.
            if (webviewPanel.active && !isExternalReload(e)) {
                return;
            }
            updateWebview();
            updateEditTitle();
        }, null, disposables);
        vscode.workspace.onDidSaveTextDocument((savedDocument) => {
            if (savedDocument.fileName === document.fileName) {
                markActiveContextChanged(panelWebview);
            }
        }, null, disposables);
        // Handle messages from webview
        panelWebview.onDidReceiveMessage(async (message) => {
            if (disposed) {
                return;
            }
            debug('msg from webview', message, webviewPanel.active);
            switch (message.command) {
                case 'markdown-editor:active-selection': {
                    if (message.selection == null) {
                        invalidateMarkdownSelection(panelWebview);
                        markActiveContextChanged(panelWebview);
                        break;
                    }
                    const selection = normalizeMarkdownSelection(message.selection, document);
                    if (selection) {
                        markdownWebviewSelections.set(panelWebview, selection);
                        markActiveContextChanged(panelWebview);
                    }
                    break;
                }
                case 'ready':
                    updateWebview({
                        type: 'init',
                        options: EditorPanel.getVditorOptions(this.context),
                        theme: vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark ? 'dark' : 'light',
                        ...getEditorUiState(panelWebview),
                    });
                    break;
                case 'save-options':
                    this.context.globalState.update(KeyVditorOptions, message.options);
                    break;
                case 'outline-pinned':
                    if (typeof message.pinned === 'boolean')
                        await this.context.globalState.update(KeyOutlinePinned, message.pinned);
                    break;
                case 'outline-width':
                    if (typeof message.width === 'number' && Number.isFinite(message.width))
                        await this.context.globalState.update(KeyOutlineWidth, Math.max(190, Math.min(520, message.width)));
                    break;
                case 'scroll':
                    EditorPanel._scrollPositions.set(uri.fsPath, message.top || 0);
                    break;
                case 'info':
                    vscode.window.showInformationMessage(message.content);
                    break;
                case 'error':
                    showError(message.content);
                    break;
                case 'edit':
                    if (webviewPanel.active) {
                        await syncToEditor(message.content);
                        updateEditTitle();
                    }
                    break;
                case 'reset-config':
                    await this.context.globalState.update(KeyVditorOptions, {});
                    break;
                case 'save':
                    await syncToEditor(message.content);
                    await document.save();
                    updateEditTitle();
                    markActiveContextChanged(panelWebview);
                    break;
                case 'upload': {
                    const assetsFolder = EditorPanel.getAssetsFolder(uri);
                    try {
                        await vscode.workspace.fs.createDirectory(vscode.Uri.file(assetsFolder));
                    }
                    catch (error) {
                        console.error(error);
                        showError(`Invalid image folder: ${assetsFolder}`);
                    }
                    await Promise.all(message.files.map(async (f) => {
                        const content = Buffer.from(f.base64, 'base64');
                        return vscode.workspace.fs.writeFile(vscode.Uri.file(NodePath.join(assetsFolder, f.name)), content);
                    }));
                    const files = message.files.map((f) => NodePath.relative(NodePath.dirname(uri.fsPath), NodePath.join(assetsFolder, f.name)).replace(/\\/g, '/'));
                    if (disposed)
                        break;
                    panelWebview.postMessage({
                        command: 'uploaded',
                        files,
                    });
                    break;
                }
                case 'open-link': {
                    await openMarkdownLink(uri, message.href);
                    break;
                }
                case 'pick-document-link': {
                    await pickDocumentLink(uri, panelWebview);
                    break;
                }
                case 'resolve-link-preview': {
                    await postResolvedLinkPreview(uri, panelWebview, message);
                    break;
                }
                case 'open-graphic-preview': {
                    openGraphicPreview(uri, message.preview);
                    break;
                }
            }
        }, null, disposables);
        // Clean up resources
        webviewPanel.onDidDispose(() => {
            disposed = true;
            invalidateMarkdownSelection(panelWebview);
            clearActiveMarkdownWebview(panelWebview);
            disposables.forEach((d) => d.dispose());
        });
    }
    static getFolders() {
        const data = [];
        for (let i = 65; i <= 90; i++) {
            data.push(vscode.Uri.file(`${String.fromCharCode(i)}:/`));
        }
        return data;
    }
    getWebviewOptions() {
        return {
            enableScripts: true,
            localResourceRoots: [vscode.Uri.file('/'), ...MarkdownEditorProvider.getFolders()],
            retainContextWhenHidden: true,
            enableFindWidget: true,
        };
    }
    getHtmlForWebview(webview, uri) {
        const toUri = (f) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, f));
        const baseHref = NodePath.dirname(webview.asWebviewUri(vscode.Uri.file(uri.fsPath)).toString()) + '/';
        const toMediaPath = (f) => `media/dist/${f}`;
        const JsFiles = ['main.js'].map(toMediaPath).map(toUri);
        const CssFiles = ['main.css'].map(toMediaPath).map(toUri);
        const enhancementCss = `${toUri('media/eyan-editor.css')}?v=${encodeURIComponent(BuildVersion)}`;
        const enhancementJs = `${toUri('media/eyan-editor.js')}?v=${encodeURIComponent(BuildVersion)}`;
        const initialEditorTheme = vscode.workspace.getConfiguration('markdown-editor').get('theme') || 'default';
        const initialVscodeDark = vscode.window.activeColorTheme.kind === vscode.ColorThemeKind.Dark;
        const initialBodyClasses = [initialVscodeDark ? 'eyan-vscode-dark' : '', initialEditorTheme === 'default' ? '' : `eyan-theme-${initialEditorTheme}`].filter(Boolean).join(' ');
        const initialSurface = initialEditorTheme === 'default' ? 'var(--vscode-editor-background, #fff)' : '#fff';
        const initialHtmlClasses = initialEditorTheme === 'default' ? '' : `eyan-theme-${initialEditorTheme}`;
        return (`<!DOCTYPE html>
			<html lang="en"${initialHtmlClasses ? ` class="${initialHtmlClasses}"` : ''}>
			<head>
				<meta charset="UTF-8">

				<meta name="viewport" content="width=device-width, initial-scale=1.0">
				<meta http-equiv="Content-Security-Policy" content="${buildCsp(webview)}">
				<base href="${baseHref}" />

					<style>${EditorPanel.appVisibilityCss}html,body,#app{background:${initialSurface}!important;color-scheme:${initialVscodeDark && initialEditorTheme === 'default' ? 'dark' : 'light'}}</style>

				${CssFiles.map((f) => `<link href="${f}" rel="stylesheet" onload="document.body.setAttribute('data-vmd-css-loaded','1')" onerror="document.body.setAttribute('data-vmd-css-loaded','1')">`).join('\n')}
				<link href="${enhancementCss}" rel="stylesheet">

				<title>markdown editor</title>
        <style>` +
            EditorPanel.config.get('customCss') +
            `</style>
			</head>
				<body class="${initialBodyClasses}" data-eyan-build="${BuildVersion}">
				<div id="app"></div>


				${JsFiles.map((f) => `<script src="${f}"></script>`).join('\n')}
				<script src="${enhancementJs}"></script>
			</body>
			</html>`);
    }
}
MarkdownEditorProvider.viewType = 'markdown-editor.customEditor';
//# sourceMappingURL=extension.js.map
