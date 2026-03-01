import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { PlanProvider } from './planProvider';

export function activate(context: vscode.ExtensionContext) {
    const planProvider = new PlanProvider();

    // 注册 TreeView
    vscode.window.registerTreeDataProvider('antigravityPlans', planProvider);

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
        vscode.commands.registerCommand('antigravityPlans.applyToChat', async (item: any) => {
            if (!item.resourceUri) return;

            try {
                // 不再复制全文，改为复制路径并引导 AI 读取
                const filePath = item.resourceUri.fsPath;
                const prompt = `请读取该路径下的实施计划并协助我执行：${filePath}`;

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
                        break; // 成功一个就跳出
                    } catch {
                        // 继续尝试下一个
                    }
                }

                vscode.window.showInformationMessage('任务计划已复制到剪贴板，请直接在 AI 对话框中粘贴。');
            } catch (err: any) {
                vscode.window.showErrorMessage(`应用失败: ${err.message}`);
            }
        })
    );

    // 注册删除计划文件夹命令
    context.subscriptions.push(
        vscode.commands.registerCommand('antigravityPlans.deleteFolder', async (item: any) => {
            if (!item || !item.fullPath) return;

            const confirm = await vscode.window.showWarningMessage(
                `确定要物理删除整个计划文件夹吗？此操作不可撤销。\n路径: ${item.fullPath}`,
                { modal: true },
                '确定删除'
            );

            if (confirm === '确定删除') {
                try {
                    // 强制删除文件夹及其所有内容
                    fs.rmSync(item.fullPath, { recursive: true, force: true });
                    vscode.window.showInformationMessage('计划文件夹已删除');
                    planProvider.refresh();
                } catch (err: any) {
                    vscode.window.showErrorMessage(`删除失败: ${err.message}`);
                }
            }
        })
    );
}

export function deactivate() { }
