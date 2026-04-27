import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PlanProvider } from './planProvider';

export function activate(context: vscode.ExtensionContext) {
    const planProvider = new PlanProvider();

    // 注册 TreeView 并开启多选
    const treeView = vscode.window.createTreeView('antigravityPlans', {
        treeDataProvider: planProvider,
        canSelectMany: true
    });
    context.subscriptions.push(treeView);

    // 注册刷新命令
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityPlans.refreshEntry', () => planProvider.refresh())
    );

    // 监听活跃编辑器切换，自动刷新
    context.subscriptions.push(
        vscode.window.onDidChangeActiveTextEditor(() => {
            planProvider.refresh();
        })
    );

    // 注册打开文件命令
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityPlans.openPlan', (fileUri: vscode.Uri) => {
            vscode.window.showTextDocument(fileUri);
        })
    );

    // 注册应用到 AI 对话框命令
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityPlans.applyToChat', async (item: any, selectedItems?: any[]) => {
            const items = selectedItems || [item];
            if (items.length === 0) return;

            try {
                // 如果是多个项目，生成一个组合 prompt
                let prompt = "";
                if (items.length === 1) {
                    const filePath = items[0].resourceUri.fsPath;
                    prompt = `请读取该路径下的实施计划并协助我执行：${filePath}`;
                } else {
                    const paths = items.map(i => i.resourceUri.fsPath).join('\n');
                    prompt = `请读取以下路径下的实施计划并协助我执行：\n${paths}`;
                }

                await vscode.env.clipboard.writeText(prompt);

                // 尝试聚焦多个可能的 AI 聊天命令
                const focusCommands = [
                    'workbench.action.chat.focus',
                    'workbench.panel.chat.view.focus',
                    'workbench.panel.aichat.view.focus',
                    'workbench.action.focusChat'
                ];

                for (const cmd of focusCommands) {
                    try {
                        await vscode.commands.executeCommand(cmd);
                        break;
                    } catch { }
                }

                vscode.window.showInformationMessage('选中的任务计划已复制到剪贴板，请直接在 AI 对话框中粘贴。');
            } catch (err: any) {
                vscode.window.showErrorMessage(`应用失败: ${err.message}`);
            }
        })
    );

    // 注册删除命令（支持单选、多选、日期分组批量删除）
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityPlans.deleteFolder', async (item: any, selectedItems?: any[]) => {
            const items = selectedItems || [item];
            const validItems = items.filter(i => i && (i.fullPath || i.contextValue === 'dateGroup'));

            if (validItems.length === 0) return;

            const brainDir = planProvider.getBrainDir();
            if (!fs.existsSync(brainDir)) return;

            // 预取所有目录信息，用于日期匹配
            const allFolders = fs.readdirSync(brainDir, { withFileTypes: true })
                .filter(d => d.isDirectory())
                .map(d => {
                    const p = path.join(brainDir, d.name);
                    const s = fs.statSync(p);
                    const time = s.birthtimeMs || s.mtimeMs;
                    const date = new Date(time);
                    const dateStr = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
                    return { path: p, date: dateStr };
                });

            // 汇总待删除的所有物理路径
            const pathsToRm = new Set<string>();
            let summaryMessages = [];

            for (const i of validItems) {
                if (i.contextValue === 'dateGroup') {
                    const targetDate = i.fullPath;
                    const folderPaths = allFolders.filter(f => f.date === targetDate).map(f => f.path);
                    folderPaths.forEach(p => pathsToRm.add(p));
                    summaryMessages.push(`日期 [${targetDate}] 下的所有任务 (${folderPaths.length} 个)`);
                } else if (i.fullPath) {
                    pathsToRm.add(i.fullPath);
                    if (validItems.length <= 1) {
                        summaryMessages.push(`项目: ${path.basename(i.fullPath)}`);
                    }
                }
            }

            if (pathsToRm.size === 0) return;

            const confirmMessage = summaryMessages.length > 1 || pathsToRm.size > 1
                ? `确定要物理删除选中的项目吗？共计 ${pathsToRm.size} 个文件夹。此操作不可撤销。`
                : `确定要物理删除以下内容吗？此操作不可撤销。\n${summaryMessages[0]}`;

            const confirm = await vscode.window.showWarningMessage(
                confirmMessage,
                { modal: true },
                '确定删除'
            );

            if (confirm === '确定删除') {
                try {
                    for (const p of pathsToRm) {
                        if (fs.existsSync(p)) {
                            fs.rmSync(p, { recursive: true, force: true });
                        }
                    }
                    vscode.window.showInformationMessage(`已成功删除 ${pathsToRm.size} 个文件夹`);
                    planProvider.refresh();
                } catch (err: any) {
                    vscode.window.showErrorMessage(`删除失败: ${err.message}`);
                }
            }
        })
    );
}

export function deactivate() { }
