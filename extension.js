const vscode = require('vscode');
const fs = require('fs');
const path = require('path');

let treeProvider;

function activate(context) {
    const workspaceRoot = vscode.workspace.rootPath;
    if (!workspaceRoot) return;
    
    treeProvider = new FFHTMLTreeDataProvider(workspaceRoot);
    const treeView = vscode.window.registerTreeDataProvider('ffhtmlView', treeProvider);
    context.subscriptions.push(treeView);
    
    // Reload command
    context.subscriptions.push(
        vscode.commands.registerCommand('ffhtmlView.reload', () => treeProvider.refresh())
    );
    
    // Context menu commands
    context.subscriptions.push(
        vscode.commands.registerCommand('ffhtmlView.createResource', element => createFilePrompt(element, 'resource')),
        vscode.commands.registerCommand('ffhtmlView.createSource', element => createFilePrompt(element, 'source')),
        vscode.commands.registerCommand('ffhtmlView.createInclude', element => createFilePrompt(element, 'include')),
        vscode.commands.registerCommand('ffhtmlView.delete', element => deleteFilePrompt(element)) // ← register delete
    );
    
    const watcherPatterns = [
        '**/*.fccw',
        'web-src/**',
        'res/**',
        'include/**'
    ];
    
    watcherPatterns.forEach(pattern => {
        const watcher = vscode.workspace.createFileSystemWatcher(new vscode.RelativePattern(workspaceRoot, pattern));
        watcher.onDidCreate(() => treeProvider.refresh());
        watcher.onDidChange(() => treeProvider.refresh());
        watcher.onDidDelete(() => treeProvider.refresh());
        context.subscriptions.push(watcher);
    });
}

function deactivate() {}

/**
* Prompt user for a file name and create it in the specified type folder.
*/
async function createFilePrompt(element, type) {
    const fileName = await vscode.window.showInputBox({ prompt: `Enter ${type} file name` });
    if (!fileName) return;

    let baseDir;
    if (type === 'resource') baseDir = treeProvider.resourcesDirectory;
    else if (type === 'source') baseDir = treeProvider.sourceDirectory;
    else if (type === 'include') baseDir = treeProvider.includeDirectory;

    let targetDir = baseDir;

    if (element && element.resourceUri) {
        const stats = fs.statSync(element.resourceUri.fsPath);

        // Determine element type folder
        let elementTypeDir = null;
        if (element.resourceUri.fsPath.startsWith(treeProvider.sourceDirectory)) elementTypeDir = treeProvider.sourceDirectory;
        else if (element.resourceUri.fsPath.startsWith(treeProvider.resourcesDirectory)) elementTypeDir = treeProvider.resourcesDirectory;
        else if (element.resourceUri.fsPath.startsWith(treeProvider.includeDirectory)) elementTypeDir = treeProvider.includeDirectory;

        // Calculate relative path **inside the element type folder**
        if (elementTypeDir) {
            const rel = path.relative(elementTypeDir, stats.isDirectory() ? element.resourceUri.fsPath : path.dirname(element.resourceUri.fsPath));
            targetDir = path.join(baseDir, rel); // mirror only subfolder
        } else if (stats.isDirectory()) {
            targetDir = element.resourceUri.fsPath;
        } else {
            targetDir = path.dirname(element.resourceUri.fsPath);
        }
    }

    const targetPath = path.join(targetDir, fileName);
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, '', 'utf8');
    vscode.window.showInformationMessage(`${type} file created: ${targetPath}`);
    treeProvider.refresh();
}

async function deleteFilePrompt(element) {
    if (!element || !element.resourceUri) return;
    
    const confirm = await vscode.window.showWarningMessage(
        `Delete ${element.resourceUri.fsPath}?`,
        { modal: true },
        'Delete'
    );
    if (confirm !== 'Delete') return;
    
    const stats = fs.statSync(element.resourceUri.fsPath);
    if (stats.isDirectory()) {
        fs.rmdirSync(element.resourceUri.fsPath, { recursive: true });
    } else {
        fs.unlinkSync(element.resourceUri.fsPath);
    }
    
    vscode.window.showInformationMessage(`${element.resourceUri.fsPath} deleted.`);
    treeProvider.refresh();
}

class FFHTMLTreeDataProvider {
    constructor(workspaceRoot) {
        this.workspaceRoot = workspaceRoot;
        this.sourceDirectory = path.join(workspaceRoot, 'web-src');
        this.includeDirectory = path.join(workspaceRoot, 'include');
        this.resourcesDirectory = path.join(workspaceRoot, 'res');
        this._onDidChangeTreeData = new vscode.EventEmitter();
        this.onDidChangeTreeData = this._onDidChangeTreeData.event;
    }
    
    refresh() {
        this._onDidChangeTreeData.fire();
    }
    
    getTreeItem(element) {
        return element;
    }
    
    getChildren(element) {
        if (!this.workspaceRoot) return [];
        
        if (!element) {
            const fccwFiles = this._findFCCWFiles(this.workspaceRoot);
            
            if (fccwFiles.length === 0) {
                return [new vscode.TreeItem("No .fccw workspace found")];
            }
            
            if (fccwFiles.length === 1) {
                const fccwPath = fccwFiles[0];
                const json = JSON.parse(fs.readFileSync(fccwPath, 'utf8'));
                return [...this._getFoldersFromConfig(json)];
            }
            
            return fccwFiles.map(file => {
                const name = path.basename(file);
                const item = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.Collapsed);
                item._fccwPath = file;
                return item;
            });
        }
        
        if (element._fccwPath) {
            const json = JSON.parse(fs.readFileSync(element._fccwPath, 'utf8'));
            return this._getFoldersFromConfig(json);
        }
        
        if (element.children) return element.children;
        
        return [];
    }
    
    _findFCCWFiles(dir) {
        const items = fs.readdirSync(dir, { withFileTypes: true });
        let fccwFiles = [];
        for (const item of items) {
            const fullPath = path.join(dir, item.name);
            if (item.isFile() && item.name.endsWith('.fccw')) {
                fccwFiles.push(fullPath);
            } else if (item.isDirectory()) {
                fccwFiles = fccwFiles.concat(this._findFCCWFiles(fullPath));
            }
        }
        return fccwFiles;
    }
    
    _getFoldersFromConfig(json) {
        const sections = [];
        
        if (json.sourceDirectory || json.resourcesDirectory) {
            const combined = new vscode.TreeItem("Combined source", vscode.TreeItemCollapsibleState.Collapsed);
            combined.children = this._getFilesFromFolders([json.sourceDirectory, json.resourcesDirectory]);
            sections.push(combined);
        }
        
        if (json.includeDirectory) {
            const includes = new vscode.TreeItem("Includes", vscode.TreeItemCollapsibleState.Collapsed);
            includes.children = this._getFilesFromFolders([json.includeDirectory]);
            sections.push(includes);
        }
        
        return sections;
    }
    
    _getFilesFromFolders(folderNames, isFullPath = false) {
        if (!folderNames) return [];
        const merged = new Map();
        
        folderNames.forEach(folderName => {
            if (!folderName) return;
            const folderPath = isFullPath ? folderName : path.join(this.workspaceRoot, folderName);
            if (!fs.existsSync(folderPath)) return;
            
            const files = fs.readdirSync(folderPath);
            files.forEach(f => {
                const filePath = path.join(folderPath, f);
                const isDir = fs.statSync(filePath).isDirectory();
                
                if (merged.has(f)) {
                    if (isDir) merged.get(f)._mergePaths.push(filePath);
                    return;
                }
                
                const item = new vscode.TreeItem(
                    f,
                    isDir ? vscode.TreeItemCollapsibleState.Collapsed : vscode.TreeItemCollapsibleState.None
                );
                item.resourceUri = vscode.Uri.file(filePath);
                if (!isDir) {
                    item.command = {
                        command: 'vscode.open',
                        title: 'Open File',
                        arguments: [vscode.Uri.file(filePath)]
                    };
                }
                
                if (isDir) item._mergePaths = [filePath];
                merged.set(f, item);
            });
        });
        
        for (const item of merged.values()) {
            if (item._mergePaths) {
                const children = this._getFilesFromFolders(item._mergePaths, true);
                item._mergePaths = null;
                item.children = children;
            }
        }
        
        return Array.from(merged.values());
    }
}

module.exports = { activate, deactivate };
