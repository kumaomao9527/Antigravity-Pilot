import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';

export class PlanProvider implements vscode.TreeDataProvider<PlanItem> {
    private _onDidChangeTreeData: vscode.EventEmitter<PlanItem | undefined | void> = new vscode.EventEmitter<PlanItem | undefined | void>();
    readonly onDidChangeTreeData: vscode.Event<PlanItem | undefined | void> = this._onDidChangeTreeData.event;

    private brainDir: string;

    constructor() {
        // 反重力默认 brain 目录
        const homeDir = process.env.USERPROFILE || process.env.HOME || '';
        this.brainDir = path.join(homeDir, '.gemini', 'antigravity', 'brain');
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

        if (element) {
            // 如果点击的是文件夹，展开其包含的 md 文件
            return this.getPlansInFolder(element.fullPath);
        } else {
            // 获取 brain 下的所有对话文件夹，并进行启发式过滤
            const folders = fs.readdirSync(this.brainDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => dirent.name);

            const items: PlanItem[] = [];
            const currentWorkspace = vscode.workspace.workspaceFolders?.[0].uri.fsPath.toLowerCase();

            for (const folder of folders) {
                const fullPath = path.join(this.brainDir, folder);
                const isRelevant = await this.checkRelevance(fullPath, currentWorkspace);

                if (isRelevant) {
                    const stats = this.getFolderStats(fullPath);
                    const folderTitle = this.getFolderTitle(fullPath) || folder;

                    const item = new PlanItem(
                        folderTitle,
                        vscode.TreeItemCollapsibleState.Collapsed,
                        fullPath,
                        true
                    );

                    if (stats.total > 0) {
                        item.description = `${stats.completed}/${stats.total}`;
                        item.tooltip = `${fullPath}\n总进度: ${stats.completed}/${stats.total}`;

                        if (stats.completed === stats.total) {
                            // 使用带颜色的文件夹图标
                            item.iconPath = new vscode.ThemeIcon('folder-active', new vscode.ThemeColor('gitDecoration.addedResourceForeground'));
                        } else {
                            // 使用黄色/橙色表示进行中
                            item.iconPath = new vscode.ThemeIcon('folder', new vscode.ThemeColor('gitDecoration.modifiedResourceForeground'));
                        }
                    }

                    items.push(item);
                }
            }

            // 也提供一个“历史记录”节点存放不相关的（可选，此处先简单展示相关的）
            return items.reverse(); // 最近的在前
        }
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
                false
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
            item.contextValue = 'planFile';
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
            // 优先查找 task.md
            const taskPath = path.join(folderPath, 'task.md');
            if (fs.existsSync(taskPath)) {
                const content = fs.readFileSync(taskPath, 'utf8');
                const titleMatch = content.match(/^#\s+(.+)$/m);
                if (titleMatch) return titleMatch[1].trim();
            }

            // 备选查找任何其他的 md 文件
            const files = fs.readdirSync(folderPath).filter(f => f.endsWith('.md'));
            for (const file of files) {
                const content = fs.readFileSync(path.join(folderPath, file), 'utf8');
                const titleMatch = content.match(/^#\s+(.+)$/m);
                if (titleMatch) return titleMatch[1].trim();
            }
        } catch { }
        return undefined;
    }

    /**
     * 启发式检测：检查 brain 文件夹中的 md 文件是否包含当前工作区的引用串启发式检测：检查 brain 文件夹中的 md 文件是否包含当前工作区的引用串
     */
    private async checkRelevance(folderPath: string, workspacePath?: string): Promise<boolean> {
        if (!workspacePath) return false;

        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                if (file.endsWith('.md')) {
                    const content = fs.readFileSync(path.join(folderPath, file), 'utf8').toLowerCase();
                    // 检查路径引用、CorpusName 或关键路径片段
                    if (content.includes(workspacePath.toLowerCase()) ||
                        content.includes(workspacePath.replace(/\\/g, '/').toLowerCase())) {
                        return true;
                    }

                    // 特殊处理：如果 content 中包含 task.md 且引用了当前目录下的文件（较弱的匹配）
                }
            }
        } catch {
            return false;
        }
        return false;
    }
}

class PlanItem extends vscode.TreeItem {
    constructor(
        public readonly label: string,
        public readonly collapsibleState: vscode.TreeItemCollapsibleState,
        public readonly fullPath: string,
        public readonly isFolder: boolean
    ) {
        super(label, collapsibleState);
        this.tooltip = this.fullPath;
        this.resourceUri = vscode.Uri.file(fullPath);

        if (isFolder) {
            this.contextValue = 'planFolder';
            if (!this.iconPath) {
                this.iconPath = new vscode.ThemeIcon('folder');
            }
        } else {
            this.contextValue = 'planFile';
            // 文件不再通过 label 拼进度，改用 description
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
