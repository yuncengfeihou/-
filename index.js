import { extension_settings, loadExtensionSettings, getContext, renderExtensionTemplateAsync } from '../../../extensions.js';
import { saveSettingsDebounced, eventSource, event_types } from '../../../../script.js';
import { getTokenCountAsync } from '../../../tokenizers.js';

// 使用 IIFE (立即调用函数表达式) 来封装插件逻辑，避免全局命名冲突
(function () {
    // --- 插件基础信息 ---
    const extensionName = "day1"; // 插件名称，用于设置存储
    const pluginFolderName = "day1"; // 插件文件夹名称，用于资源路径
    // 插件脚本文件夹路径 (根据用户要求指定)
    const extensionFolderPath = `scripts/extensions/third-party/${pluginFolderName}`;
    // 获取或初始化插件设置对象
    const extensionSettings = extension_settings[extensionName] || {};
    // 插件的默认设置 (如果需要的话)
    const defaultSettings = {};

    // --- 插件状态变量 ---
    let day1Worker; // Web Worker 实例
    let currentEntityId = null; // 当前聊天对象的唯一标识符 (角色头像或群组 ID)
    let currentEntityName = null; // 当前聊天对象的名称

    // --- IndexedDB 相关 (主线程主要负责读取和初始化结构) ---
    const DB_NAME = 'SillyTavernDay1Stats'; // 数据库名称
    const STORE_NAME = 'dailyStats'; // 对象存储名称
    const DB_VERSION = 1; // 数据库版本号 (与 worker.js 保持一致)
    let dbInstance; // 缓存数据库连接

    /**
     * 打开或返回已打开的 IndexedDB 数据库连接。
     * 主线程版本，包含数据库结构创建逻辑。
     */
    function openDBMain() {
        return new Promise((resolve, reject) => {
            // 如果已有连接，直接返回缓存的实例
            if (dbInstance) {
                console.log("Day1 Main: Using cached DB instance.");
                resolve(dbInstance);
                return;
            }

            console.log("Day1 Main: Attempting to open IndexedDB...");
            const request = indexedDB.open(DB_NAME, DB_VERSION);

            // 处理打开数据库时可能发生的错误
            request.onerror = (event) => {
                console.error("Day1 Main: IndexedDB open error:", event.target.error);
                reject('IndexedDB error: ' + event.target.error);
            };

            // 数据库成功打开后
            request.onsuccess = (event) => {
                dbInstance = event.target.result;
                console.log("Day1 Main: IndexedDB connection opened successfully.");

                // 添加必要的数据库事件监听器
                dbInstance.onerror = (event) => {
                    console.error("Day1 Main: Database error:", event.target.error);
                };
                dbInstance.onclose = () => {
                    console.log("Day1 Main: Database connection closed.");
                    dbInstance = null; // 清除缓存
                };
                dbInstance.onversionchange = () => {
                    console.log("Day1 Main: Database version change detected, closing connection.");
                     if (dbInstance) {
                        dbInstance.close();
                        dbInstance = null;
                     }
                };

                resolve(dbInstance); // 返回数据库实例
            };

            // 处理数据库升级或首次创建
            // 这个事件只在版本号增加或数据库不存在时触发
            request.onupgradeneeded = (event) => {
                console.log("Day1 Main: IndexedDB upgrade needed.");
                const db = event.target.result;
                const transaction = event.target.transaction; // 获取升级事务

                // 检查对象存储是否存在，如果不存在则创建
                if (!db.objectStoreNames.contains(STORE_NAME)) {
                    try {
                        // 创建对象存储，使用 'entityId' 作为主键
                        db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                        console.log(`Day1 Main: Object store "${STORE_NAME}" created.`);
                    } catch (e) {
                         console.error(`Day1 Main: Error creating object store "${STORE_NAME}"`, e);
                         // 如果创建失败，拒绝 Promise 并尝试取消事务
                         if (transaction) {
                             transaction.abort();
                         }
                         reject(`Error creating object store: ${e}`);
                         return; // 提前退出
                    }
                }
                // 如果未来需要添加索引，也在这里进行
                // 例如:
                // if (transaction) { // 确保事务存在
                //    const store = transaction.objectStore(STORE_NAME);
                //    if (!store.indexNames.contains('byDate')) {
                //        store.createIndex('byDate', 'dateString', { unique: false }); // 假设我们按日期索引
                //        console.log("Day1 Main: Index 'byDate' created.");
                //    }
                //}
                console.log("Day1 Main: IndexedDB upgrade finished.");
            };
        });
    }

    /**
     * 从 IndexedDB 读取所有统计数据。
     * @returns {Promise<Array<object>>} 返回包含所有统计记录的数组。
     */
    function getAllStats() {
        return new Promise(async (resolve, reject) => {
            try {
                // 确保数据库已连接
                const db = await openDBMain();
                // 开始只读事务
                const transaction = db.transaction(STORE_NAME, 'readonly');
                const store = transaction.objectStore(STORE_NAME);
                // 获取所有数据
                const request = store.getAll();

                request.onerror = (event) => reject('Error reading all data: ' + event.target.error);
                // 成功时返回结果数组，如果为空则返回空数组
                request.onsuccess = (event) => resolve(event.target.result || []);

            } catch (error) {
                console.error("Day1 Main: Error during getAllStats:", error);
                reject(error);
            }
        });
    }

    // --- Worker 通信 ---

    /**
     * 向 Web Worker 发送消息。
     * @param {string} command 命令名称。
     * @param {object} payload 命令所需的数据。
     */
    function sendMessageToWorker(command, payload) {
        if (!day1Worker) {
            console.error("Day1 Main: Worker not initialized! Cannot send message.");
            return;
        }
        // 结构化地发送命令和数据
        day1Worker.postMessage({ command, payload });
    }

    // --- UI 更新 ---

    /**
     * 从 IndexedDB 获取最新数据并更新 HTML 表格。
     */
    async function updateStatsTable() {
        const tableBody = $('#day1-stats-table-body');
        // 如果 UI 元素不存在，则不执行更新
        if (!tableBody.length) {
            console.warn("Day1 Main: Stats table body not found in DOM.");
            return;
        }

        // 显示加载状态
        tableBody.empty().append('<tr><td colspan="5"><i>正在加载统计数据...</i></td></tr>');

        try {
            // 获取所有统计数据
            const allStats = await getAllStats();
            // 获取今天的日期字符串 (YYYY-MM-DD)
            const todayString = new Date().toISOString().split('T')[0];

            tableBody.empty(); // 清空加载提示

            if (allStats.length === 0) {
                tableBody.append('<tr><td colspan="5"><i>暂无任何统计数据。</i></td></tr>');
                return;
            }

            let hasTodayData = false;
            // 按实体名称（角色/群组名）字母顺序排序
            allStats.sort((a, b) => (a.entityName || a.entityId || '').localeCompare(b.entityName || b.entityId || ''));

            // 遍历每个实体的统计数据
            allStats.forEach(entityStats => {
                // 检查是否存在今天的数据
                const dailyData = entityStats.dailyData ? entityStats.dailyData[todayString] : null;
                if (dailyData) {
                    hasTodayData = true; // 标记今天有数据
                    // 创建表格行 HTML
                    const row = `
                        <tr>
                            <td>${entityStats.entityName || entityStats.entityId}</td>
                            <td>${dailyData.userMessages || 0}</td>
                            <td>${dailyData.aiMessages || 0}</td>
                            <td>${dailyData.cumulativeTokens || 0}</td>
                            <td>${todayString}</td>
                        </tr>
                    `;
                    tableBody.append(row); // 添加到表格
                }
            });

            // 如果遍历完所有实体都没有找到今天的数据
            if (!hasTodayData) {
                 tableBody.append(`<tr><td colspan="5"><i>今天 (${todayString}) 还没有聊天记录。</i></td></tr>`);
            }

        } catch (error) {
            console.error('Day1 Main: Error fetching or updating stats table:', error);
            // 显示错误信息
            tableBody.empty().append('<tr><td colspan="5"><i style="color: red;">加载统计数据失败，请检查控制台。</i></td></tr>');
        }
    }

    // --- 事件处理 ---

    /**
     * 处理消息发送或接收事件，提取信息并发送给 Worker。
     * @param {object} message SillyTavern 的消息对象。
     * @param {boolean} isUser 标记消息是否由用户发送。
     */
    async function handleMessage(message, isUser) {
        // 如果没有消息对象或当前未选中任何实体，则忽略
        if (!message || !currentEntityId) return;

        // 异步获取 Token 数量
        let tokenCount = 0;
        try {
            // 优先使用消息自带的 token_count (通常由 ST 核心或其他插件计算)
            if (typeof message?.extra?.token_count === 'number' && message.extra.token_count > 0) {
                tokenCount = message.extra.token_count;
            } else if (message.mes) {
                // 如果没有，则尝试异步计算 (可能稍微延迟，但更准确)
                tokenCount = await getTokenCountAsync(message.mes || '', 0);
                // console.log(`Day1 Main: Calculated token count for ${isUser ? 'user' : 'AI'} message: ${tokenCount}`);
            }
        } catch (err) {
            // 如果计算失败，进行估算
            console.warn("Day1 Main: Failed to get token count, estimating...", err);
            tokenCount = Math.round((message.mes || '').length / 3.5); // 简单的估算方法
        }

        // 准备发送给 Worker 的数据
        const payload = {
            entityId: currentEntityId,
            entityName: currentEntityName, // 传递当前实体名称
            isUser: isUser,
            tokenCount: tokenCount,
            // 使用消息自带的时间戳，如果不存在则使用当前时间
            timestamp: message.send_date || Date.now(),
        };

        // 发送数据到 Worker 进行处理
        sendMessageToWorker('processMessage', payload);

        // (可选) 轻微延迟后更新表格，避免过于频繁的 UI 操作
        // setTimeout(updateStatsTable, 500);
    }

    /**
     * 当用户发送消息时触发的回调。
     * @param {number} messageId 发送消息的 ID。
     */
    function onMessageSent(messageId) {
        const context = getContext(); // 获取当前上下文
        if (!context || !context.chat || !context.chat[messageId]) return;
        const message = context.chat[messageId];
        handleMessage(message, true); // 处理用户消息
    }

    /**
     * 当接收到 AI 回复时触发的回调。
     * @param {number} messageId 接收消息的 ID。
     */
    function onMessageReceived(messageId) {
        const context = getContext(); // 获取当前上下文
        if (!context || !context.chat || !context.chat[messageId]) return;
        const message = context.chat[messageId];
        // 确保是 AI 的回复，而不是系统消息或用户的消息
        if (message && !message.is_user && !message.is_system) {
            handleMessage(message, false); // 处理 AI 消息
        }
    }

    /**
     * 当切换聊天对象（角色或群组）时触发的回调。
     * @param {string} chatId 新聊天的 ID (可能是角色头像文件名或群组 ID)。
     */
    function onChatChanged(chatId) {
        const context = getContext(); // 获取当前上下文
        if (!context) {
             currentEntityId = null;
             currentEntityName = null;
             return;
        }

        // 根据上下文判断是群组还是角色
        if (context.groupId) { // 优先判断是否为群组
            currentEntityId = context.groupId; // 群组使用其 ID
            // 尝试从 context.groups 获取群组名称，否则使用 ID
            currentEntityName = context.groups?.find(g => String(g.id) === String(context.groupId))?.name || context.groupId;
        } else if (context.characterId !== undefined && context.characters && context.characters[context.characterId]) { // 判断是否为角色
            currentEntityId = context.characters[context.characterId].avatar; // 角色使用头像文件名作为 ID
            currentEntityName = context.characters[context.characterId].name; // 获取角色名称
        } else { // 其他情况（如初始状态或临时聊天）
            currentEntityId = null;
            currentEntityName = null;
        }

        console.log(`Day1 Main: Chat context changed. Current entity: ${currentEntityName || 'None'} (ID: ${currentEntityId || 'None'})`);

        // (可选) 可以在切换聊天时自动刷新统计表格
        // if ($('#day1-stats-table-body').is(':visible')) { // 仅当面板可见时刷新
        //     updateStatsTable();
        // }
    }

    // --- 插件初始化 ---
    // 使用 jQuery(async () => { ... }) 确保在 DOM 加载完毕后执行初始化代码
    jQuery(async () => {
        console.log(`Day1 Main: Initializing extension ${extensionName}...`);

        // 1. 加载或初始化插件设置
        extension_settings[extensionName] = extension_settings[extensionName] || {};
        Object.assign(extension_settings[extensionName], {
            ...defaultSettings, // 合并默认设置
            ...extension_settings[extensionName], // 应用已保存的设置
        });

        // 2. 确保 IndexedDB 数据库结构已就绪
        try {
            await openDBMain(); // 尝试打开数据库，如果需要会创建结构
            console.log("Day1 Main: Initial DB connection/setup successful.");
        } catch (error) {
            console.error("Day1 Main: Critical - Failed initial DB open/setup:", error);
            // 如果数据库无法初始化，插件的核心功能将失效，可能需要提示用户
            alert("Day1 插件数据库初始化失败，统计功能可能无法正常工作。请检查浏览器控制台获取详细信息。");
            // 可以选择在这里提前退出，或者允许 UI 加载但功能受限
        }

        // 3. 注入插件的 UI 界面到 SillyTavern 的扩展设置区域
        try {
            const settingsHtml = await renderExtensionTemplateAsync(`third-party/${pluginFolderName}`, 'settings_display');
            // 确定目标容器，优先使用 #translation_container (较新版本 ST)
            const targetContainer = $('#translation_container').length ? '#translation_container' : '#extensions_settings';
            $(targetContainer).append(settingsHtml);
            console.log(`Day1 Main: Settings UI injected into ${targetContainer}`);

            // 为 UI 元素绑定事件处理器
            $('#day1-refresh-button').on('click', updateStatsTable);

            // 延迟首次加载表格数据，确保 DB 和 UI 都已准备好
            setTimeout(updateStatsTable, 500); // 延迟 500 毫秒

        } catch (error) {
            console.error(`Day1 Main: Error loading or injecting settings HTML: ${error}`);
        }

        // 4. 初始化并启动 Web Worker
        try {
            // 使用要求的路径格式
            const workerPath = `scripts/extensions/third-party/${pluginFolderName}/worker.js`;
            day1Worker = new Worker(workerPath);

            // 设置 Worker 的消息监听器
            day1Worker.onmessage = (event) => {
                // 在这里处理来自 Worker 的消息（如果 Worker 需要回发信息）
                console.log("Day1 Main: Received message from worker:", event.data);
                // 例如，如果 Worker 完成处理后发送状态更新:
                // if (event.data.status === 'processed') {
                //     console.log(`Day1 Main: Worker processed data for ${event.data.entityId}`);
                //     // 可能触发一次 UI 更新
                //     if ($('#day1-stats-table-body').is(':visible')) { updateStatsTable(); }
                // }
            };
            // 设置 Worker 的错误监听器
            day1Worker.onerror = (error) => {
                console.error("Day1 Main: Worker error reported:", error.message, error);
                // 可能需要通知用户 Worker 出错
            };
            console.log(`Day1 Main: Web Worker initialized successfully from path: ${workerPath}`);
        } catch (error) {
            console.error(`Day1 Main: Failed to initialize Web Worker from path "${extensionFolderPath}/worker.js":`, error);
            // Worker 加载失败是严重问题，需要告知用户
            alert("Day1 插件未能成功加载后台处理程序，统计功能将不可用。请检查浏览器控制台错误信息，特别是关于 Worker 路径和 MIME 类型的问题。");
            day1Worker = null; // 将 worker 设为 null 以阻止后续通信尝试
        }

        // 5. 注册 SillyTavern 的核心事件监听器
        eventSource.on(event_types.MESSAGE_SENT, onMessageSent);
        eventSource.on(event_types.MESSAGE_RECEIVED, onMessageReceived);
        eventSource.on(event_types.CHAT_CHANGED, onChatChanged);

        // 6. 初始化时获取一次当前的聊天实体信息
        onChatChanged(getContext()?.chatId); // 传递当前 chatId (如果有)

        console.log(`Day1 Main: Extension ${extensionName} initialization complete.`);
    }); // jQuery(async () => { ... }) 结束

})(); // IIFE 结束
