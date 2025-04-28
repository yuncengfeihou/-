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
            isWorkerReady = true;
            console.log(`${pluginName}: Web Worker 初始化成功。`);

            statWorker.onmessage = (event) => {
                const { type, success, payload, error } = event.data;
                if (type === 'STATS_RESULT' && success) {
                    // 如果获取的数据是今天的，并且是当前聊天的，更新UI
                    const todayKey = getTodayDateKey();
                    if (payload.dateKey === todayKey && currentChatId) {
                         const chatStats = payload.stats[currentChatId] || { userMessages: 0, aiMessages: 0, totalTokens: 0 };
                         updateDisplayValues(chatStats.userMessages, chatStats.aiMessages, chatStats.totalTokens);
                         lastDisplayedStats = chatStats; // 缓存最后显示的数据
                    }
                } else if (!success) {
                    console.error(`${pluginName}: Worker 错误: ${error}`, payload);
                }
            };

            statWorker.onerror = (error) => {
                console.error(`${pluginName}: Web Worker 发生错误:`, error);
                isWorkerReady = false;
                toastr.error("每日统计插件 Worker 出错，统计功能可能无法正常工作。", "插件错误");
            };

        } catch (error) {
            console.error(`${pluginName}: 初始化 Web Worker 失败:`, error);
            isWorkerReady = false;
            toastr.error("无法启动每日统计插件的 Worker，统计功能将不可用。", "插件错误");
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
        if (!isWorkerReady || !currentChatId) {
            // 如果 worker 未就绪或没有当前聊天，显示 0
            updateDisplayValues(0, 0, 0);
            lastDisplayedStats = { userMessages: 0, aiMessages: 0, totalTokens: 0 }; // 重置缓存
            return;
        }
        const dateKey = getTodayDateKey();
        // 请求 worker 获取当天的所有统计数据
        statWorker.postMessage({ type: 'GET_STATS', payload: { dateKey } });
        // Worker 的 onmessage 会处理结果并更新 UI
    }

    // 5. 处理发送的消息
    async function handleMessageSent(messageId) {
        if (!isWorkerReady) return;
        const context = getContext();
        // 确保消息 ID 有效且是用户消息
        if (messageId === undefined || messageId < 0 || messageId >= context.chat.length || !context.chat[messageId]?.is_user) {
            return;
        }

        const message = context.chat[messageId];
        const chatId = currentChatId; // 使用事件发生时的 currentChatId
        const dateKey = getTodayDateKey();

        if (!chatId) {
             console.warn(`${pluginName}: 无法确定 chatId，跳过用户消息统计。`);
             return;
        }

        try {
            // 异步计算 Token 数
            const tokenCount = await context.getTokenCountAsync(message.mes);
            // 发送给 Worker 更新统计
            statWorker.postMessage({
                type: 'UPDATE_STATS',
                payload: { dateKey, chatId, messageType: 'user', tokenCount }
            });
            // 立即尝试更新显示（基于本地缓存+1，然后由 worker 的 GET_STATS 修正）
            updateDisplayValues(lastDisplayedStats.userMessages + 1, lastDisplayedStats.aiMessages, lastDisplayedStats.totalTokens + tokenCount);
            lastDisplayedStats.userMessages += 1;
            lastDisplayedStats.totalTokens += tokenCount;

        } catch (error) {
            console.error(`${pluginName}: 计算用户消息 token 或发送到 worker 时出错:`, error);
        }
    }

    // 6. 处理接收的消息
    async function handleMessageReceived(messageId) {
        if (!isWorkerReady) return;
        const context = getContext();
        // 确保消息 ID 有效且是 AI 消息
         if (messageId === undefined || messageId < 0 || messageId >= context.chat.length || context.chat[messageId]?.is_user || context.chat[messageId]?.is_system) {
            return;
        }

        const message = context.chat[messageId];
        const chatId = currentChatId; // 使用事件发生时的 currentChatId
        const dateKey = getTodayDateKey();

        if (!chatId) {
             console.warn(`${pluginName}: 无法确定 chatId，跳过 AI 消息统计。`);
             return;
        }

        try {
            // 异步计算 Token 数
            const tokenCount = await context.getTokenCountAsync(message.mes);
            // 发送给 Worker 更新统计
            statWorker.postMessage({
                type: 'UPDATE_STATS',
                payload: { dateKey, chatId, messageType: 'ai', tokenCount }
            });
             // 立即尝试更新显示（基于本地缓存+1，然后由 worker 的 GET_STATS 修正）
             updateDisplayValues(lastDisplayedStats.userMessages, lastDisplayedStats.aiMessages + 1, lastDisplayedStats.totalTokens + tokenCount);
             lastDisplayedStats.aiMessages += 1;
             lastDisplayedStats.totalTokens += tokenCount;
        } catch (error) {
            console.error(`${pluginName}: 计算 AI 消息 token 或发送到 worker 时出错:`, error);
        }
    }

    // 7. 处理聊天切换
    function handleChatChanged(chatId) {
        // SillyTavern 的 chatId 可能是角色头像文件名或群组 ID
        // const context = getContext();
        // currentChatId = context.groupId || (context.characterId !== undefined ? context.characters[context.characterId]?.avatar : null);
        // 使用 getContext().getCurrentChatId() 更可靠
        const context = getContext();
        currentChatId = context.getCurrentChatId();

        console.log(`${pluginName}: 聊天切换，新的 Chat ID: ${currentChatId}`);
        triggerDisplayUpdate(); // 切换聊天后更新显示
    }

    // --- 插件初始化 ---
    try {
        console.log(`加载插件: ${pluginName}`);

        // 加载并注入 UI
        const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
        $('#extensions_settings').append(settingsHtml); // 或者 #translation_container

        // 初始化 Worker
        initWorker();

        // 获取当前聊天 ID 并首次更新显示
        // 需要等待上下文可用
        const context = getContext();
        // currentChatId = context.groupId || (context.characterId !== undefined ? context.characters[context.characterId]?.avatar : null);
        currentChatId = context.getCurrentChatId();
        console.log(`${pluginName}: 初始 Chat ID: ${currentChatId}`);
        triggerDisplayUpdate();

        // 注册事件监听器
        eventSource.on(event_types.MESSAGE_SENT, handleMessageSent);
        eventSource.on(event_types.MESSAGE_RECEIVED, handleMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, handleChatChanged);

        console.log(`${pluginName}: 初始化完成并已设置事件监听器。`);

    } catch (error) {
        console.error(`${pluginName}: 初始化失败:`, error);
    }
});
