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

    // 注册删除命令（支持批量删除）
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityPlans.deleteFolder', async (item: any, selectedItems?: any[]) => {
            // VS Code 会把当前点击的项作为第一个参数，所有选中的项作为第二个参数
            const items = selectedItems || [item];
            const validItems = items.filter(i => i && i.fullPath);

            if (validItems.length === 0) return;

            const isMultiple = validItems.length > 1;
            const message = isMultiple
                ? `确定要物理删除选中的 ${validItems.length} 个项目吗？此操作不可撤销。`
                : `确定要物理删除该项目吗？此操作不可撤销。\n路径: ${validItems[0].fullPath}`;

            const confirm = await vscode.window.showWarningMessage(
                message,
                { modal: true },
                '确定删除'
            );

            if (confirm === '确定删除') {
                try {
                    for (const i of validItems) {
                        if (fs.existsSync(i.fullPath)) {
                            fs.rmSync(i.fullPath, { recursive: true, force: true });
                        }
                    }
                    vscode.window.showInformationMessage(isMultiple ? `${validItems.length} 个项目已删除` : '项目已删除');
                    planProvider.refresh();
                } catch (err: any) {
                    vscode.window.showErrorMessage(`删除失败: ${err.message}`);
                }
            }
        })
    );
}

export function deactivate() { }
