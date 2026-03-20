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
            const foldersData = fs.readdirSync(this.brainDir, { withFileTypes: true })
                .filter(dirent => dirent.isDirectory())
                .map(dirent => {
                    const fullPath = path.join(this.brainDir, dirent.name);
                    const stats = fs.statSync(fullPath);
                    return {
                        name: dirent.name,
                        fullPath: fullPath,
                        time: stats.birthtimeMs || stats.mtimeMs
                    };
                })
                // 从最新的最先显示 (降序排序)
                .sort((a, b) => b.time - a.time);

            const items: PlanItem[] = [];
            const workspacePaths = vscode.workspace.workspaceFolders?.map(f => f.uri.fsPath.toLowerCase()) || [];

            for (const folderData of foldersData) {
                const fullPath = folderData.fullPath;
                const folder = folderData.name;
                const isRelevant = await this.checkRelevance(fullPath, workspacePaths);

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
            return items; // 按降序排序，最近的在前
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

    /**
     * 启发式检测：检查 brain 文件夹中的 md 文件是否包含任一当前工作区的引用串。
     * 支持三种匹配策略：
     * 1. 直接路径匹配（小写原始路径或正斜杠形式）
     * 2. URL 解码路径匹配（md 文件中路径常以 file:///...%XX%YY... 形式存储）
     * 3. 工作区文件夹名片段匹配（兜底，适用于路径中含中文编码的场景）
     */
    private async checkRelevance(folderPath: string, workspacePaths: string[]): Promise<boolean> {
        if (workspacePaths.length === 0) return false;

        // 预计算每个工作区的匹配关键字列表（多种形式）
        const matchKeywords: string[][] = workspacePaths.map(wp => {
            const normalized = wp.replace(/\\/g, '/');  // 反斜杠 -> 正斜杠
            let decoded = normalized;
            try {
                decoded = decodeURIComponent(normalized).toLowerCase();
            } catch { /* 忽略解码错误 */ }

            const keywords: string[] = [
                wp,                          // 原始路径（已 toLowerCase）
                normalized,                  // 正斜杠形式
                decoded,                     // URL 解码后
            ];

            // 额外加入最后一层文件夹名（中文项目名往往在最尾端）
            const folderName = path.basename(wp).toLowerCase();
            if (folderName) {
                keywords.push(folderName);
                // URL 编码版本的文件夹名（匹配 file:/// 链接中的编码段）
                try {
                    keywords.push(encodeURIComponent(decodeURIComponent(folderName)).toLowerCase());
                } catch { /* 忽略 */ }
            }

            return [...new Set(keywords)]; // 去重
        });

        try {
            const files = fs.readdirSync(folderPath);
            for (const file of files) {
                if (!file.endsWith('.md') || file.includes('.resolved')) {
                    continue;
                }
                const content = fs.readFileSync(path.join(folderPath, file), 'utf8').toLowerCase();

                for (const keywords of matchKeywords) {
                    for (const kw of keywords) {
                        if (kw && content.includes(kw)) {
                            return true;
                        }
                    }
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
