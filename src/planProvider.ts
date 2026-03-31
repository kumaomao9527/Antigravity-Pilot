import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export enum PlanItemType {
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

        const workspacePaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath.toLowerCase()) || [];

        if (!element) {
            // 第一层：显示日期分组
            const allFolders = await this.getAllRelevantFolders(workspacePaths);
            const dateGroups = new Set<string>();
            allFolders.forEach(f => {
                const dateStr = this.formatDate(f.time);
                dateGroups.add(dateStr);
            });

            return Array.from(dateGroups)
                .sort((a, b) => b.localeCompare(a)) // 日期降序
                .map(date => new PlanItem(
                    date,
                    vscode.TreeItemCollapsibleState.Collapsed,
                    date,
                    PlanItemType.DateGroup
                ));
        }

        if (element.type === PlanItemType.DateGroup) {
            // 第二层：显示该日期下的任务文件夹
            const allFolders = await this.getAllRelevantFolders(workspacePaths);
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

    private async checkRelevance(folderPath: string, workspacePaths: string[]): Promise<boolean> {
        if (workspacePaths.length === 0) return false;

        const matchKeywords: string[][] = workspacePaths.map(wp => {
            const normalized = wp.replace(/\\/g, '/');
            let decoded = normalized;
            try {
                decoded = decodeURIComponent(normalized).toLowerCase();
            } catch { }

            const keywords: string[] = [wp, normalized, decoded];
            const folderName = path.basename(wp).toLowerCase();
            if (folderName) {
                keywords.push(folderName);
                try {
                    keywords.push(encodeURIComponent(decodeURIComponent(folderName)).toLowerCase());
                } catch { }
            }
            return [...new Set(keywords)];
        });

        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                if (!file.endsWith('.md') || file.includes('.resolved')) continue;
                const content = fs.readFileSync(path.join(folderPath, file), 'utf8').toLowerCase();
                for (const keywords of matchKeywords) {
                    for (const kw of keywords) {
                        if (kw && content.includes(kw)) return true;
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

        if (type === PlanItemType.DateGroup) {
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
