// public/extensions/third-party/day1/index.js
import {
    getContext,
    renderExtensionTemplateAsync,
    extension_settings, // 如果需要存储插件设置
    // loadExtensionSettings, // 通常不需要插件自己调用
} from "../../../extensions.js";
import {
    eventSource,
    event_types,
    saveSettingsDebounced, // 如果需要保存插件设置
} from "../../../../script.js";

jQuery(async () => {
    const pluginName = "day1";
    const pluginFolderName = "day1"; // 确保与你的文件夹名一致
    const extensionSettings = extension_settings[pluginName] || {}; // 获取或初始化设置对象

    let statWorker;
    let currentChatId = null;
    let isWorkerReady = false;
    let lastDisplayedStats = { userMessages: 0, aiMessages: 0, totalTokens: 0 };

    // 1. 初始化 Web Worker
    function initWorker() {
        try {
            // 确保路径相对于 SillyTavern 的根目录
            statWorker = new Worker(`extensions/third-party/${pluginFolderName}/worker.js`);
            // 注意：此时 isWorkerReady 还是 false，等待 worker 发送 'WORKER_READY'

            statWorker.onmessage = (event) => {
                const { type, success, payload, error } = event.data;
                console.log(`${pluginName}: 收到 Worker 消息:`, type, payload);

                if (type === 'WORKER_READY') {
                    isWorkerReady = true;
                    console.log(`${pluginName}: Web Worker 已就绪。`);
                    // Worker 就绪后，立即请求一次当前聊天的数据
                    triggerDisplayUpdate();
                } else if (type === 'WORKER_INIT_ERROR') {
                    isWorkerReady = false;
                    console.error(`${pluginName}: Worker 初始化失败: ${error}`);
                    toastr.error(`每日统计插件 Worker 初始化失败: ${error}`, "插件错误");
                } else if (type === 'STATS_RESULT' && success) {
                    const todayKey = getTodayDateKey();
                    // 确保收到的是当天的数据，并且有当前聊天ID
                    if (payload.dateKey === todayKey && currentChatId) {
                        const chatStats = payload.stats[currentChatId] || { userMessages: 0, aiMessages: 0, totalTokens: 0 };
                        updateDisplayValues(chatStats.userMessages, chatStats.aiMessages, chatStats.totalTokens);
                        lastDisplayedStats = chatStats; // 缓存最后显示的数据
                        console.log(`${pluginName}: UI 已更新为来自 Worker 的数据:`, chatStats);
                    } else if (payload.dateKey !== todayKey) {
                         console.log(`${pluginName}: 收到非今日数据，忽略 UI 更新`);
                    } else if (!currentChatId) {
                         console.log(`${pluginName}: 收到数据但无当前聊天 ID，显示 0`);
                         updateDisplayValues(0, 0, 0);
                         lastDisplayedStats = { userMessages: 0, aiMessages: 0, totalTokens: 0 };
                    }
                } else if (!success) { // 处理来自 worker 的其他错误消息
                    console.error(`${pluginName}: Worker 报告错误 (${type}): ${error}`, payload);
                    // 可能需要向用户显示错误
                     toastr.error(`统计操作失败: ${error}`, "插件错误");
                }
            };

            statWorker.onerror = (errorEvent) => {
                // 这个 onerror 主要捕获加载错误或 Worker 内部未捕获的顶层错误
                console.error(`${pluginName}: Web Worker 发生顶层错误:`, errorEvent.message, errorEvent);
                isWorkerReady = false;
                toastr.error(`每日统计插件 Worker 严重错误: ${errorEvent.message || '无法加载或运行'}`, "插件错误");
                // 可以在这里禁用插件 UI 或显示错误状态
                updateDisplayValues('错误', '错误', '错误');
            };

            console.log(`${pluginName}: Web Worker 实例已创建，等待就绪消息...`);

        } catch (error) {
            console.error(`${pluginName}: 创建 Web Worker 实例失败:`, error);
            isWorkerReady = false;
            toastr.error("无法创建每日统计插件的 Worker，统计功能将不可用。", "插件错误");
        }
    }

    // 2. 获取当天的日期 Key (YYYY-MM-DD)
    function getTodayDateKey() {
        return new Date().toISOString().split('T')[0];
    }

    // 3. 更新扩展页面中的统计数据显示
    function updateDisplayValues(userCount, aiCount, tokenCount) {
        $('#day1_user_messages').text(userCount);
        $('#day1_ai_messages').text(aiCount);
        $('#day1_total_tokens').text(tokenCount);
    }

    // 4. 从 Worker 请求更新显示 (针对当前聊天)
    async function triggerDisplayUpdate() {
        if (!isWorkerReady) {
            console.log(`${pluginName}: triggerDisplayUpdate - Worker 未就绪，显示 0`);
            updateDisplayValues(0, 0, 0);
            lastDisplayedStats = { userMessages: 0, aiMessages: 0, totalTokens: 0 }; // 重置缓存
            return;
        }
         // 确保我们有最新的 Chat ID
        currentChatId = getContext().getCurrentChatId();
        if (!currentChatId) {
             console.log(`${pluginName}: triggerDisplayUpdate - 无当前聊天 ID，显示 0`);
            updateDisplayValues(0, 0, 0);
            lastDisplayedStats = { userMessages: 0, aiMessages: 0, totalTokens: 0 };
            return;
        }

        const dateKey = getTodayDateKey();
        console.log(`${pluginName}: 请求 Worker 获取统计数据 (Key: ${dateKey})`);
        statWorker.postMessage({ type: 'GET_STATS', payload: { dateKey } });
        // UI 更新由 Worker 的 'STATS_RESULT' 消息处理
    }

    // 5. 处理发送的消息
    async function handleMessageSent(messageId) {
        if (!isWorkerReady) return;

        const context = getContext();
        // 重新获取最新的 Chat ID，防止竞争条件
        const chatId = context.getCurrentChatId();

        if (!chatId) {
            console.warn(`${pluginName}: MESSAGE_SENT - 无法确定 chatId，跳过统计。`);
            return;
        }
         // 确保消息 ID 有效且是用户消息
        if (messageId === undefined || messageId < 0 || messageId >= context.chat.length || !context.chat[messageId]?.is_user) {
            console.warn(`${pluginName}: MESSAGE_SENT - 无效的 messageId 或非用户消息:`, messageId);
            return;
        }

        const message = context.chat[messageId];
        const dateKey = getTodayDateKey();

        try {
            console.log(`${pluginName}: 用户消息发送 (ID: ${messageId}, Chat: ${chatId})`);
            // 异步计算 Token 数
            const tokenCount = await context.getTokenCountAsync(message.mes);
            console.log(`${pluginName}: 用户消息 Token 数: ${tokenCount}`);

            // 发送给 Worker 更新统计
            statWorker.postMessage({
                type: 'UPDATE_STATS',
                payload: { dateKey, chatId, messageType: 'user', tokenCount }
            });

            // 乐观更新 UI
            const newUserCount = (typeof lastDisplayedStats.userMessages === 'number' ? lastDisplayedStats.userMessages : 0) + 1;
            const newAiCount = typeof lastDisplayedStats.aiMessages === 'number' ? lastDisplayedStats.aiMessages : 0;
            const newTotalTokens = (typeof lastDisplayedStats.totalTokens === 'number' ? lastDisplayedStats.totalTokens : 0) + (tokenCount || 0);

            updateDisplayValues(newUserCount, newAiCount, newTotalTokens);
            // 更新本地缓存以供下一次乐观更新
            lastDisplayedStats = { userMessages: newUserCount, aiMessages: newAiCount, totalTokens: newTotalTokens };

        } catch (error) {
            console.error(`${pluginName}: MESSAGE_SENT 处理出错:`, error);
        }
    }

    // 6. 处理接收的消息
    async function handleMessageReceived(messageId) {
        if (!isWorkerReady) return;

        const context = getContext();
        // 重新获取最新的 Chat ID
        const chatId = context.getCurrentChatId();

         if (!chatId) {
            console.warn(`${pluginName}: MESSAGE_RECEIVED - 无法确定 chatId，跳过统计。`);
            return;
        }
         // 确保消息 ID 有效且是 AI 消息
        if (messageId === undefined || messageId < 0 || messageId >= context.chat.length || context.chat[messageId]?.is_user || context.chat[messageId]?.is_system) {
             console.warn(`${pluginName}: MESSAGE_RECEIVED - 无效的 messageId 或非 AI 消息:`, messageId);
            return;
        }

        const message = context.chat[messageId];
        const dateKey = getTodayDateKey();

        try {
            console.log(`${pluginName}: AI 消息接收 (ID: ${messageId}, Chat: ${chatId})`);
            // 异步计算 Token 数
            const tokenCount = await context.getTokenCountAsync(message.mes);
             console.log(`${pluginName}: AI 消息 Token 数: ${tokenCount}`);

            // 发送给 Worker 更新统计
            statWorker.postMessage({
                type: 'UPDATE_STATS',
                payload: { dateKey, chatId, messageType: 'ai', tokenCount }
            });

            // 乐观更新 UI
            const newUserCount = typeof lastDisplayedStats.userMessages === 'number' ? lastDisplayedStats.userMessages : 0;
            const newAiCount = (typeof lastDisplayedStats.aiMessages === 'number' ? lastDisplayedStats.aiMessages : 0) + 1;
            const newTotalTokens = (typeof lastDisplayedStats.totalTokens === 'number' ? lastDisplayedStats.totalTokens : 0) + (tokenCount || 0);

            updateDisplayValues(newUserCount, newAiCount, newTotalTokens);
             // 更新本地缓存以供下一次乐观更新
            lastDisplayedStats = { userMessages: newUserCount, aiMessages: newAiCount, totalTokens: newTotalTokens };

        } catch (error) {
            console.error(`${pluginName}: MESSAGE_RECEIVED 处理出错:`, error);
        }
    }

    // 7. 处理聊天切换
    function handleChatChanged(chatId) { // chatId 参数通常是当前聊天的 ID
        const context = getContext();
        currentChatId = context.getCurrentChatId(); // 再次确认，以防万一
        console.log(`${pluginName}: 聊天切换事件，新的 Chat ID: ${currentChatId}`);
        // 请求 Worker 更新显示
        triggerDisplayUpdate();
    }

    // --- 插件初始化 ---
    try {
        console.log(`加载插件: ${pluginName}`);

        // 加载并注入 UI
        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
        // 尝试更常用的容器
        $('#translation_container').append(settingsHtml);
        console.log(`${pluginName}: UI 已注入到 #translation_container`);

        // 初始化 Worker
        initWorker(); // Worker 初始化后会自己请求数据

        // 注册事件监听器
        eventSource.on(event_types.MESSAGE_SENT, handleMessageSent);
        eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);

        console.log(`${pluginName}: 初始化完成并已设置事件监听器。`);

    } catch (error) {
        console.error(`${pluginName}: 初始化失败:`, error);
         toastr.error(`每日统计插件 UI 加载失败: ${error.message}`, "插件错误");
    }
});
