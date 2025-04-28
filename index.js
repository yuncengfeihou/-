// public/extensions/third-party/daily-usage-stats/index.js
import { extension_settings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { eventSource, event_types, characters, itemizedPrompts } from '../../../../script.js';
import { moment } from '../../../lib.js'; // 导入 moment.js
import { groups } from '../../../chats-group.js';

// 导入 IndexedDB 辅助函数
import { initDB, addOrUpdateStat, getAllStats } from './idbHelper.js'; // 确保路径正确

const extensionName = "day1";
const extensionFolderPath = `third-party/${extensionName}`;

let statsWorker = null; // Web Worker 实例

// 获取当前日期字符串 (YYYY-MM-DD)
function getCurrentDateString() {
    return moment().format('YYYY-MM-DD');
}

// 计算提示的总 Token 数 (与之前版本相同)
function calculatePromptTokens(promptData) {
    if (!promptData) return 0;
    if (promptData.oaiTotalTokens !== undefined) return promptData.oaiTotalTokens;
    let total = 0;
    const fieldsToSum = [ 'storyStringTokens', 'worldInfoStringTokens', 'examplesStringTokens', 'ActualChatHistoryTokens', 'allAnchorsTokens', 'promptBiasTokens','chatInjects','userPersonaStringTokens','beforeScenarioAnchorTokens', 'afterScenarioAnchorTokens','summarizeStringTokens','authorsNoteStringTokens', 'smartContextStringTokens','chatVectorsStringTokens','dataBankVectorsStringTokens','padding'];
    for (const field of fieldsToSum) { if (typeof promptData[field] === 'number' && !isNaN(promptData[field])) { total += promptData[field]; } }
    // if (total === 0 && promptData.rawPrompt) { console.warn("无法精确计算非 OpenAI API 的 Token 总数"); }
    return total;
}


// 处理用户发送的消息
async function handleUserMessage(messageId) {
    const context = getContext();
    const entityId = context.groupId || context.characters[context.characterId]?.avatar;
    const entityName = context.groupId ? context.groups.find(g => g.id === context.groupId)?.name : context.characters[context.characterId]?.name;

    if (!entityId) return;

    const todayStr = getCurrentDateString();
    try {
        // 调用 IndexedDB 函数更新数据
        await addOrUpdateStat(todayStr, entityId, entityName, 'userMessages', 1);
        console.log(`[${extensionName}] User message stat updated for ${entityName} (${entityId}) on ${todayStr}`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to update user message stat:`, error);
    }
}

// 处理 AI 接收的消息，并记录对应的 Token
async function handleAiMessage(messageId) {
    const context = getContext();
    const entityId = context.groupId || context.characters[context.characterId]?.avatar;
    const entityName = context.groupId ? context.groups.find(g => g.id === context.groupId)?.name : context.characters[context.characterId]?.name;

    if (!entityId) return;

    const todayStr = getCurrentDateString();
    let tokensSent = 0;
    const promptData = itemizedPrompts.find(item => item.mesId === messageId);

    if (promptData) {
        tokensSent = calculatePromptTokens(promptData);
    } else {
        console.warn(`[${extensionName}] AI Message: Prompt data not found for mesId ${messageId}`);
    }

    try {
        // 更新 AI 消息数
        await addOrUpdateStat(todayStr, entityId, entityName, 'aiMessages', 1);
        // 如果有 Token 数，更新 Token 总数
        if (tokensSent > 0) {
            await addOrUpdateStat(todayStr, entityId, entityName, 'totalTokensSent', tokensSent);
        }
        console.log(`[${extensionName}] AI message stat (+${tokensSent} tokens) updated for ${entityName} (${entityId}) on ${todayStr}`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to update AI message stat:`, error);
    }
}

// 在 UI 上显示统计数据 (此版本使用 Web Worker)
function displayStatsWithWorker() {
    const displayArea = $('#usage-stats-display-area');
    displayArea.html('<p>正在加载统计数据...</p>'); // 显示加载提示

    if (!statsWorker) {
         displayArea.html('<p>错误：Web Worker 未初始化。</p>');
         console.error(`[${extensionName}] Stats Worker is not initialized.`);
         return;
    }
    console.log(`[${extensionName}] Sending command to worker to fetch stats.`);
    statsWorker.postMessage({ command: 'fetchAndProcessStats' });
}

// 更新 UI 的函数 (由 Worker 调用后执行)
function updateStatsUI(processedData) {
    const displayArea = $('#usage-stats-display-area');
    displayArea.empty(); // 清空旧内容

    const sortedDates = Object.keys(processedData).sort().reverse(); // Worker 返回的数据已经是按日期排序的

    if (sortedDates.length === 0) {
        displayArea.append('<p>暂无统计数据。</p>');
        return;
    }

    let html = '';
    for (const dateStr of sortedDates) {
        const entities = processedData[dateStr]; // Worker 返回的数据已经是按实体排序的

        if (entities.length === 0) continue;

        html += `<div class="stats-date-header">${dateStr}</div>`;
        html += '<table class="stats-table">';
        html += '<thead><tr><th>角色/群组</th><th>用户消息</th><th>AI 消息</th><th>发送 Tokens</th></tr></thead>';
        html += '<tbody>';

        for (const data of entities) {
            html += `<tr>
                        <td class="entity-name">${data.name}</td>
                        <td>${data.userMessages}</td>
                        <td>${data.aiMessages}</td>
                        <td>${data.totalTokensSent}</td>
                     </tr>`;
        }

        html += '</tbody></table>';
    }

    displayArea.append(html);
     console.log(`[${extensionName}] Stats UI updated.`);
}


// 插件初始化逻辑
jQuery(async () => {
    console.log(`加载插件: ${extensionName}`);

    // 1. 初始化 IndexedDB
    try {
        await initDB(); // 确保数据库已准备好
    } catch (error) {
         console.error(`[${extensionName}] Failed to initialize IndexedDB:`, error);
         // 可以在 UI 上显示错误信息
    }

     // 2. 初始化 Web Worker (可选)
    try {
        // 确保 worker 文件路径相对于 SillyTavern 的根目录或主 JS 文件是正确的
        // 通常相对于 `script.js` 或应用程序入口
        // 这里的路径 `'./extensions/third-party/daily-usage-stats/statsWorker.js'` 是一个 *示例*，
        // 你需要根据你的项目结构调整！！！
        // 如果你的 index.js 在 public/extensions/third-party/daily-usage-stats/
        // 并且 script.js 在 public/
        // 那么正确的路径可能是 './extensions/third-party/daily-usage-stats/statsWorker.js'
        // （相对于根目录下的 public/index.html）
        statsWorker = new Worker('./extensions/third-party/daily-usage-stats/statsWorker.js', { type: 'module' });

        statsWorker.onmessage = (event) => {
            if (event.data && event.data.command === 'statsResult') {
                console.log(`[${extensionName}] Received stats result from worker.`);
                updateStatsUI(event.data.data);
            } else if (event.data && event.data.command === 'statsError') {
                console.error(`[${extensionName}] Worker error:`, event.data.error);
                 $('#usage-stats-display-area').html(`<p>加载统计数据时出错: ${event.data.error}</p>`);
            }
        };
        statsWorker.onerror = (error) => {
            console.error(`[${extensionName}] Worker initialization error:`, error);
             $('#usage-stats-display-area').html('<p>错误：无法启动统计 Worker。</p>');
             statsWorker = null; // 标记为不可用
        };
         console.log(`[${extensionName}] Stats Worker initialized.`);
    } catch (error) {
        console.error(`[${extensionName}] Failed to create Web Worker:`, error);
        $('#usage-stats-display-area').html('<p>错误：浏览器不支持或无法创建 Web Worker。</p>');
    }


    // 3. 加载并注入 UI 模板
    try {
        const settingsHtml = await renderExtensionTemplateAsync(extensionFolderPath, 'stats_display');
        $('#extensions_settings').append(settingsHtml);

        // 4. 绑定 UI 元素的事件监听器
        $('#refresh-usage-stats').on('click', displayStatsWithWorker); // 使用 Worker 版本

    } catch (error) {
        console.error(`[${extensionName}] 加载或注入 stats_display.html 失败:`, error);
    }

    // 5. 注册 SillyTavern 事件监听器
    eventSource.on(event_types.MESSAGE_SENT, (messageId) => {
        const context = getContext();
        if (context.chat[messageId]?.is_user === true) {
            handleUserMessage(messageId);
        }
    });

    eventSource.on(event_types.MESSAGE_RECEIVED, (messageId, type) => {
        const context = getContext();
        const message = context.chat[messageId];
        if (message && !message.is_user && !message.is_system && (context.characterId !== undefined || context.groupId !== undefined)) {
            handleAiMessage(messageId);
        }
    });

    console.log(`插件 ${extensionName} 初始化完成。`);
});
