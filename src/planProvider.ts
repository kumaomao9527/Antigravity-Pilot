import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export enum PlanItemType {
    Info = 'info',
    DateGroup = 'dateGroup',
    TaskFolder = 'taskFolder',
    TaskFile = 'taskFile'
}

export class PlanProvider implements vscode.TreeDataProvider<PlanItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<PlanItem | undefined | void> = new vscode.EventEmitter<PlanItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<PlanItem | undefined | void> = this._onDidChangeTreeData.event;

    public brainDir: string;

    constructor() {
        // 反重力默认 brain 目录
        const homeDir = process.env.USERPROFILE || process.env.HOME || '';
        this.brainDir = path.join(homeDir, '.gemini', 'antigravity', 'brain');
    }

    public getBrainDir(): string {
        return this.brainDir;
    }

    refresh(): void {
        this._onDidChangeTreeData.fire();
    }

    getTreeItem(element: PlanItem): vscode.TreeItem {
        return element;
    }

    async getChildren(element?: PlanItem): Promise<PlanItem[]> {
        if (!fs.existsSync(this.brainDir)) {
            return [];
        }

        const activeEditor = vscode.window.activeTextEditor;
        const activeFilePath = activeEditor?.document.uri.fsPath;
        const workspacePaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath) || [];
        
        // 汇总所有可能的匹配路径（工作区路径 + 当前打开文件路径）
        const allTargetPaths = [...workspacePaths];
        if (activeFilePath) {
            allTargetPaths.push(activeFilePath);
        }

        if (!element) {
            const items: PlanItem[] = [];

            // 添加工作区信息
            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (workspaceFolders) {
                workspaceFolders.forEach(folder => {
                    items.push(new PlanItem(
                        `工作区: ${folder.name}`,
                        vscode.TreeItemCollapsibleState.None,
                        folder.uri.fsPath,
                        PlanItemType.Info
                    ));
                });
            }

            // 添加匹配依据信息
            items.push(new PlanItem(
                `匹配依据: 完整路径匹配`,
                vscode.TreeItemCollapsibleState.None,
                '仅显示包含当前工作区完整路径的任务',
                PlanItemType.Info
            ));

            // 添加匹配路径信息 (Brain 完整路径)
            items.push(new PlanItem(
                `匹配路径: ${this.brainDir}`,
                vscode.TreeItemCollapsibleState.None,
                '任务文件存放目录',
                PlanItemType.Info
            ));

            // 第一层：显示日期分组
            const allFolders = await this.getAllRelevantFolders(allTargetPaths);
            const dateGroups = new Set<string>();
            allFolders.forEach(f => {
                const dateStr = this.formatDate(f.time);
                dateGroups.add(dateStr);
            });

            const dateItems = Array.from(dateGroups)
                .sort((a, b) => b.localeCompare(a)) // 日期降序
                .map(date => new PlanItem(
                    date,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    date,
                    PlanItemType.DateGroup
                ));

            return [...items, ...dateItems];
        }

        if (element.type === PlanItemType.DateGroup) {
            // 第二层：显示该日期下的任务文件夹
            const allFolders = await this.getAllRelevantFolders(allTargetPaths);
            const targetDate = element.fullPath;
            const foldersInDate = allFolders.filter(f => this.formatDate(f.time) === targetDate);

            const items: PlanItem[] = [];
            for (const folderData of foldersInDate) {
                const fullPath = folderData.fullPath;
                const folder = folderData.name;
                const stats = this.getFolderStats(fullPath);
                const folderTitle = this.getFolderTitle(fullPath) || folder;

                const item = new PlanItem(
                    folderTitle,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    fullPath,
                    PlanItemType.TaskFolder
                );

                if (stats.total > 0) {
                    item.description = `${stats.completed}/${stats.total}`;
                    item.tooltip = `${fullPath}\n总进度: ${stats.completed}/${stats.total}`;

                    if (stats.completed === stats.total) {
                        item.iconPath = new vscode.ThemeIcon('folder-active', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
                    } else {
                        item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
                    }
                }
                items.push(item);
            }
            return items;
        }

        if (element.type === PlanItemType.TaskFolder) {
            // 第三层：显示文件夹内的 md 文件
            return this.getPlansInFolder(element.fullPath);
        }

        return [];
    }

    private async getAllRelevantFolders(workspacePaths: string[]): Promise<any[]> {
        const folders = fs.readdirSync(this.brainDir, { withFileTypes: true })
            .filter(dirent => dirent.isDirectory())
            .map(dirent => {
                const fullPath = path.join(this.brainDir, dirent.name);
                const stats = fs.statSync(fullPath);
                return {
                    name: dirent.name,
                    fullPath: fullPath,
                    time: stats.birthtimeMs || stats.mtimeMs
                };
            });

        const relevantFolders = [];
        for (const folder of folders) {
            if (await this.checkRelevance(folder.fullPath, workspacePaths)) {
                relevantFolders.push(folder);
            }
        }
        return relevantFolders.sort((a, b) => b.time - a.time);
    }

    private formatDate(timestamp: number): string {
        const date = new Date(timestamp);
        const y = date.getFullYear();
        const m = String(date.getMonth() + 1).padStart(2, '0');
        const d = String(date.getDate()).padStart(2, '0');
        return `${y}-${m}-${d}`;
    }

    private getPlansInFolder(folderPath: string): PlanItem[] {
        const files = fs.readdirSync(folderPath)
            .filter(file => file.endsWith('.md') && !file.includes('.resolved'));

        return files.map(file => {
            const fullPath = path.join(folderPath, file);
            const content = fs.readFileSync(fullPath, 'utf8');

            // 解析任务状态
            const totalTasks = (content.match(/-\s*\[[ x/]]/g) || []).length;
            const completedTasks = (content.match(/-\s*\[x]/g) || []).length;
            const inProgressTasks = (content.match(/-\s*\[\/]/g) || []).length;

            let label = file;
            if (totalTasks > 0) {
                label = `${file} (${completedTasks}/${totalTasks})`;
                if (inProgressTasks > 0) {
                    label += ` ⏳`;
                }
            }

            const item = new PlanItem(
                label,
                vscode.TreeItemCollapsibleState.None,
                fullPath,
                PlanItemType.TaskFile
            );

            // 根据状态设置不同的上下文和图标提示
            item.tooltip = `${fullPath}\n进度: ${completedTasks}/${totalTasks}\n进行中: ${inProgressTasks}`;

            if (totalTasks > 0 && completedTasks === totalTasks) {
                item.iconPath = new vscode.ThemeIcon('pass-filled', new vscode.ThemeColor('testing.iconPassed'));
            } else if (inProgressTasks > 0) {
                item.iconPath = new vscode.ThemeIcon('play-circle', new vscode.ThemeColor('charts.yellow'));
            }

            item.command = {
                command: 'antigravityPlans.openPlan',
                title: '打开计划',
                arguments: [vscode.Uri.file(fullPath)]
            };
            return item;
        });
    }

    private getFolderStats(folderPath: string): { total: number, completed: number, inProgress: number } {
        let total = 0;
        let completed = 0;
        let inProgress = 0;

        try {
            const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(folderPath, file), 'utf8');
                total += (content.match(/-\s*\[[ x/]]/g) || []).length;
                completed += (content.match(/-\s*\[x]/g) || []).length;
                inProgress += (content.match(/-\s*\[\/]/g) || []).length;
            }
        } catch { }

        return { total, completed, inProgress };
    }

    private getFolderTitle(folderPath: string): string | undefined {
        try {
            // 1. 优先查找 implementation_plan.md
            const impPath = path.join(folderPath, 'implementation_plan.md');
            if (fs.existsSync(impPath)) {
                const content = fs.readFileSync(impPath, 'utf8');
                const titleMatch = content.match(/^#\s+(.+)$/m);
                if (titleMatch) return titleMatch[1].trim();
            }

            // 2. 其次找 task.md
            const taskPath = path.join(folderPath, 'task.md');
            if (fs.existsSync(taskPath)) {
                const content = fs.readFileSync(taskPath, 'utf8');
                const titleMatch = content.match(/^#\s+(.+)$/m);
                if (titleMatch) return titleMatch[1].trim();
            }

            // 3. 备选查找任何其他的 md 文件（排除 .resolved 备份）
            const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md') && !f.includes('.resolved'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(folderPath, file), 'utf8');
                const titleMatch = content.match(/^#\s+(.+)$/m);
                if (titleMatch) return titleMatch[1].trim();
            }
        } catch { }
        return undefined;
    }

    private async checkRelevance(folderPath: string, targetPaths: string[]): Promise<boolean> {
        if (targetPaths.length === 0) return false;

        // 规范化所有目标工作区路径（统一为斜杠、小写）
        const normalizedTargets = targetPaths.map(tp => {
            let p = tp.replace(/\\/g, '/').toLowerCase();
            if (p.endsWith('/')) {
                p = p.substring(0, p.length - 1);
            }
            return p;
        });

        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                if (!file.endsWith('.md') || file.includes('.resolved')) continue;
                const fullPath = path.join(folderPath, file);
                const rawContent = fs.readFileSync(fullPath, 'utf8');
                const lowerContent = rawContent.toLowerCase();
                
                // 1. 尝试直接在原始内容中搜索编码后的目标路径（提升性能）
                // 虽然 URI 编码的大小写可能有差异，但这能覆盖大部分情况
                for (const target of normalizedTargets) {
                    try {
                        const encodedTarget = encodeURIComponent(target).toLowerCase();
                        // 注意：encodeURIComponent 会编码 /，而 file:/// 里的 / 通常不编码
                        // 这是一个简单的兜底
                        if (lowerContent.includes(target)) return true;
                    } catch { }
                }

                // 2. 解码整个内容并进行路径匹配（最准确，但稍重）
                try {
                    const decodedContent = decodeURIComponent(rawContent).toLowerCase();
                    // 规范化内容中的斜杠
                    const normalizedContent = decodedContent.replace(/\\/g, '/');
                    
                    for (const target of normalizedTargets) {
                        // 检查是否包含完整的目标路径
                        if (normalizedContent.includes(target)) {
                            return true;
                        }
                    }
                } catch (e) {
                    // 如果 decodeURIComponent 失败（可能包含非法字符），则降级到正则提取匹配
                    const uriRegex = /file:\/\/\/[^\)\s]*/gi;
                    let match;
                    while ((match = uriRegex.exec(rawContent)) !== null) {
                        try {
                            const decoded = decodeURIComponent(match[0]).toLowerCase().replace(/\\/g, '/');
                            for (const target of normalizedTargets) {
                                if (decoded.includes(target)) return true;
                            }
                        } catch { }
                    }
                }
            }
        } catch { return false; }
        return false;
    }
}

class PlanItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly fullPath: string,
        public readonly type: PlanItemType
    ) {
        super(label, collapsibleState);
        this.tooltip = this.fullPath;
        
        // 只有文件和文件夹才有关联的 resourceUri
        if (type !== PlanItemType.DateGroup) {
            this.resourceUri = vscode.Uri.file(fullPath);
        }

        if (type === PlanItemType.Info) {
            this.contextValue = 'infoItem';
            if (label.startsWith('工作区')) {
                this.iconPath = new vscode.ThemeIcon('folder-active');
            } else if (label.startsWith('匹配依据')) {
                this.iconPath = new vscode.ThemeIcon('search');
            } else if (label.startsWith('匹配路径')) {
                this.iconPath = new vscode.ThemeIcon('folder-opened');
            } else {
                this.iconPath = new vscode.ThemeIcon('info');
            }
            this.description = fullPath;
        } else if (type === PlanItemType.DateGroup) {
            this.contextValue = 'dateGroup';
            this.iconPath = new vscode.ThemeIcon('calendar');
        } else if (type === PlanItemType.TaskFolder) {
            this.contextValue = 'planFolder';
            if (!this.iconPath) {
                this.iconPath = new vscode.ThemeIcon('folder');
            }
        } else {
            this.contextValue = 'planFile';
            const match = label.match(/\((\d+\/\d+)\)/);
            if (match) {
                this.label = label.replace(/\s*\(\d+\/\d+\)/, '');
                this.description = match[1];
            }
            if (!this.iconPath) {
                this.iconPath = new vscode.ThemeIcon('markdown');
            }
        }
    }
}
