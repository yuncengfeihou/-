import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types, getTokenCountAsync } from '../../../../script.js';

(function () {
    const extensionName = "day1";
    const pluginFolderName = "day1"; // 必须和你的文件夹名一致！
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`; // 按要求指定路径
    const extensionSettings = extension_settings[extensionName] || {};
    const defaultSettings = {}; // 本插件暂时不需要特殊设置

    let day1Worker;
    let currentEntityId = null;
    let currentEntityName = null;

    // --- IndexedDB 相关 (主线程读取，Worker 写入) ---
    const DB_NAME = 'SillyTavernDay1Stats';
    const STORE_NAME = 'dailyStats';
    const DB_VERSION = 1;
    let dbInstance;

    function openDBMain() {
        return new Promise((resolve, reject) => {
            if (dbInstance) {
                resolve(dbInstance);
                return;
            }
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            request.onerror = (event) => reject('IndexedDB error: ' + event.target.error);
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                resolve(dbInstance);
            };
            // Worker 会处理 onupgradeneeded
        });
    }

    function getAllStats() {
        return new Promise(async (resolve, reject) => {
            try {
                const db = await openDBMain();
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                const request = store.getAll();

                request.onerror = (event) => reject('Error reading all data: ' + event.target.error);
                request.onsuccess = (event) => resolve(event.target.result || []); // 返回所有记录的数组

            } catch (error) {
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) {
            console.error("Day1: Worker not initialized!");
            return;
        }
        day1Worker.postMessage({ command, payload });
    }

    // --- UI 更新 ---
    async function updateStatsTable() {
        const tableBody = $('#day1-stats-table-body');
        if (!tableBody.length) return; // 如果表格还没加载，则退出

        try {
            const allStats = await getAllStats();
            const todayString = new Date().toISOString().split('T')[0];

            tableBody.empty(); // 清空旧数据

            if (allStats.length === 0) {
                tableBody.append('<tr><td colspan="5"><i>暂无统计数据。</i></td></tr>');
                return;
            }

            let hasTodayData = false;
            // 按实体名称排序
            allStats.sort((a, b) => (a.entityName || '').localeCompare(b.entityName || ''));

            allStats.forEach(entityStats => {
                // 只显示今天的数据
                const dailyData = entityStats.dailyData[todayString];
                if (dailyData) {
                    hasTodayData = true;
                    const row = `
                        <tr>
                            <td>${entityStats.entityName || entityStats.entityId}</td>
                            <td>${dailyData.userMessages || 0}</td>
                            <td>${dailyData.aiMessages || 0}</td>
                            <td>${dailyData.cumulativeTokens || 0}</td>
                            <td>${todayString}</td>
                        </tr>
                    `;
                    tableBody.append(row);
                }
            });

            if (!hasTodayData) {
                 tableBody.append(`<tr><td colspan="5"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }

        } catch (error) {
            console.error('Day1: Error fetching or updating stats table:', error);
            tableBody.empty().append('<tr><td colspan="5"><i>加载统计数据失败。</i></td></tr>');
        }
    }

    // --- 事件处理 ---
    async function handleMessage(message, isUser) {
        if (!message || !currentEntityId) return;

        // 获取 Token 数量
        let tokenCount = 0;
        if (isUser) {
            // 对于用户消息，我们需要计算
            try {
                tokenCount = await getTokenCountAsync(message.mes, 0);
            } catch (err) {
                console.warn("Day1: Failed to get token count for user message", err);
                tokenCount = Math.round((message.mes || '').length / 3.5); // 估算
            }
        } else {
            // 对于 AI 消息，尝试从 extra 中获取
            tokenCount = message?.extra?.token_count || 0;
            if (tokenCount === 0 && message.mes) {
                 console.warn("Day1: AI message token count is 0, estimating...");
                 tokenCount = Math.round((message.mes || '').length / 3.5); // 估算
            }
        }

        // 发送给 Worker 处理
        sendMessageToWorker('processMessage', {
            entityId: currentEntityId,
            entityName: currentEntityName, // 传递当前名称
            isUser: isUser,
            tokenCount: tokenCount,
            timestamp: message.send_date || Date.now(), // 使用消息时间戳或当前时间
        });

        // 可以在这里轻微延迟更新表格，或者让刷新按钮来做
        // setTimeout(updateStatsTable, 500);
    }

    function onMessageSent(messageId) {
        const context = getContext();
        if (!context) return;
        const message = context.chat[messageId];
        handleMessage(message, true);
    }

    function onMessageReceived(messageId) {
        const context = getContext();
        if (!context) return;
        const message = context.chat[messageId];
        // 忽略系统消息等非 AI 回复
        if (message && !message.is_user && !message.is_system) {
            handleMessage(message, false);
        }
    }

    function onChatChanged(chatId) {
        // 更新当前实体 ID 和名称
        const context = getContext();
        if (context.groupId) {
            currentEntityId = context.groupId;
            currentEntityName = context.groups?.find(g => g.id === context.groupId)?.name || context.groupId;
        } else if (context.characterId !== undefined && context.characters[context.characterId]) {
            currentEntityId = context.characters[context.characterId].avatar;
            currentEntityName = context.characters[context.characterId].name;
        } else {
            currentEntityId = null;
            currentEntityName = null;
        }
        console.log(`Day1: Chat changed to entity: ${currentEntityName} (ID: ${currentEntityId})`);
        // 可以在这里触发一次表格更新，或者等待用户手动刷新
        // updateStatsTable();
    }

    // --- 插件初始化 ---
    jQuery(async () => {
        // 加载设置 (虽然此插件目前不用，但保留框架)
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], {
            ...defaultSettings,
            ...extension_settings[extensionName],
        });

        // 注入设置页面 UI
        try {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            // 尝试新的容器，如果不行再用旧的
            const targetContainer = $('#translation_container').length ? '#translation_container' : '#extensions_settings';
            $(targetContainer).append(settingsHtml);

            // 绑定刷新按钮事件
            $('#day1-refresh-button').on('click', updateStatsTable);

            // 首次加载时更新表格
            updateStatsTable();

        } catch (error) {
            console.error(`Day1: Error loading or injecting settings HTML: ${error}`);
        }

        // 初始化 Web Worker
        try {
            // 使用指定路径创建 Worker
            const workerPath = `scripts/extensions/third-party/${pluginFolderName}/worker.js`;
            day1Worker = new Worker(workerPath);

            day1Worker.onmessage = (event) => {
                // 处理来自 Worker 的消息（如果需要）
                console.log("Day1: Message from worker:", event.data);
                // if (event.data.status === 'updated') { updateStatsTable(); }
            };
            day1Worker.onerror = (error) => {
                console.error("Day1: Worker error:", error);
            };
            console.log(`Day1: Worker initialized from ${workerPath}`);
        } catch (error) {
            console.error(`Day1: Failed to initialize Web Worker from ${extensionFolderPath}/worker.js:`, error);
            alert("Day1 插件未能成功加载后台处理程序，统计功能将不可用。请检查控制台错误。");
        }

        // 注册事件监听器
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        // 初始化时获取当前实体信息
        onChatChanged();

        console.log("Day1 Extension loaded!");
    });

})(); // IIFE 结束
