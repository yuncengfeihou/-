// public/extensions/third-party/day1/worker.js
// (或者根据您的实际路径是 public/scripts/extensions/third-party/day1/worker.js)

const DB_NAME = 'SillyTavernDay1StatsDB';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1;

let db;

// 1. 初始化（或打开）IndexedDB 数据库
function initDB() {
    return new Promise((resolve, reject) => {
        console.log('Day1 Worker: initDB 开始');
        if (db) {
            console.log('Day1 Worker: DB 已存在，直接返回');
            resolve(db);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            const error = event.target.error;
            console.error('Day1 Worker: IndexedDB open request 错误:', error);
            // 尝试向主线程发送错误，即使在初始化阶段
            try {
                self.postMessage({ type: 'WORKER_INIT_ERROR', error: `IndexedDB open request error: ${error?.message || error}` });
            } catch (postError) {
                console.error("Day1 Worker: 发送 WORKER_INIT_ERROR 失败", postError);
            }
            reject('IndexedDB open request error: ' + error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB 打开成功');
            // 数据库成功打开后，发送就绪消息
             try {
                self.postMessage({ type: 'WORKER_READY' });
            } catch (postError) {
                console.error("Day1 Worker: 发送 WORKER_READY 失败", postError);
            }
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            console.log('Day1 Worker: IndexedDB 升级或创建');
            try {
                // 检查对象存储是否已存在，避免重复创建引发错误
                if (!event.target.result.objectStoreNames.contains(STORE_NAME)) {
                    const store = event.target.result.createObjectStore(STORE_NAME, { keyPath: 'date' });
                    console.log('Day1 Worker: Object store 创建成功');
                } else {
                     console.log('Day1 Worker: Object store 已存在');
                }
            } catch (error) {
                console.error('Day1 Worker: 创建/处理 object store 失败:', error);
                 try {
                    self.postMessage({ type: 'WORKER_INIT_ERROR', error: `创建/处理 object store 失败: ${error?.message || error}` });
                } catch (postError) {
                    console.error("Day1 Worker: 发送 WORKER_INIT_ERROR 失败", postError);
                }
                reject('创建/处理 object store 失败: ' + error);
            }
        };
    });
}

// 2. 获取指定日期的统计数据
function getStats(dateKey) {
    return new Promise(async (resolve, reject) => {
        try {
            console.log(`Day1 Worker: getStats 开始 (Key: ${dateKey})`);
            const currentDb = await initDB(); // 确保数据库已初始化
            const transaction = currentDb.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(dateKey);

            request.onerror = (event) => {
                console.error(`Day1 Worker: 获取数据请求失败 (Key: ${dateKey})`, event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                console.log(`Day1 Worker: 获取数据成功 (Key: ${dateKey})`, event.target.result);
                // 返回整个 statsMap 对象，或者空对象
                resolve(event.target.result?.statsMap || {});
            };
        } catch (error) {
            console.error(`Day1 Worker: getStats 捕获到错误 (Key: ${dateKey})`, error);
            reject(error);
        }
    });
}

// 3. 更新指定日期和聊天ID的统计数据
function updateStats(dateKey, chatId, messageType, tokenCount) {
     // 添加检查，防止对无效 chatId 进行操作
    if (!chatId || typeof chatId !== 'string' || chatId.trim() === '') {
        console.warn('Day1 Worker: 收到无效的 chatId，无法更新统计:', chatId);
        return Promise.reject(new Error('Invalid chatId received by worker'));
    }

    return new Promise(async (resolve, reject) => {
        try {
            // console.log(`Day1 Worker: updateStats 开始 (Key: ${dateKey}, Chat: ${chatId})`);
            const currentDb = await initDB(); // 确保数据库已初始化
            const transaction = currentDb.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const getRequest = store.get(dateKey);

            getRequest.onerror = (event) => {
                console.error(`Day1 Worker: 更新前获取数据失败 (Key: ${dateKey})`, event.target.error);
                reject(event.target.error);
            };

            // 使用 transaction 的 oncomplete 和 onerror 处理事务结果
            transaction.oncomplete = () => {
                // console.log(`Day1 Worker: 事务完成 (Key: ${dateKey}, Chat: ${chatId})`);
                resolve();
            };
            transaction.onerror = (event) => {
                 console.error(`Day1 Worker: 事务错误 (Key: ${dateKey}, Chat: ${chatId})`, event.target.error);
                 reject(event.target.error || new Error("IndexedDB transaction failed"));
            };
            // 注意：不要在 onsuccess 内部 resolve/reject，而是在事务级别处理

            getRequest.onsuccess = (event) => {
                let data = event.target.result;
                let statsMap = {};

                // 确保从获取的数据中正确恢复 statsMap
                if (data && typeof data.statsMap === 'object' && data.statsMap !== null) {
                    statsMap = data.statsMap;
                } else {
                    // 如果当天记录不存在，则创建新记录
                    data = { date: dateKey, statsMap: {} };
                     statsMap = data.statsMap; // 指向新创建的空对象
                }

                // 获取或初始化特定聊天的统计，确保所有字段都是数字
                const chatStats = statsMap[chatId] || { userMessages: 0, aiMessages: 0, totalTokens: 0 };
                chatStats.userMessages = Number(chatStats.userMessages) || 0;
                chatStats.aiMessages = Number(chatStats.aiMessages) || 0;
                chatStats.totalTokens = Number(chatStats.totalTokens) || 0;


                if (messageType === 'user') {
                    chatStats.userMessages += 1;
                } else if (messageType === 'ai') {
                    chatStats.aiMessages += 1;
                }
                chatStats.totalTokens += (Number(tokenCount) || 0); // 确保累加的是数字

                statsMap[chatId] = chatStats;
                data.statsMap = statsMap; // 确保更新回主数据对象

                // Put 操作应该在 onsuccess 回调内部，因为它依赖 getRequest 的结果
                 try {
                    const putRequest = store.put(data);
                     putRequest.onerror = (event) => {
                        // Put 错误也会导致事务失败，会被 transaction.onerror 捕获
                        console.error(`Day1 Worker: 写入数据 put 失败 (Key: ${dateKey})`, event.target.error);
                        // 不需要在这里 reject，事务错误会处理
                    };
                     putRequest.onsuccess = () => {
                        // Put 成功不代表事务完成，等待 transaction.oncomplete
                        // console.log(`Day1 Worker: Put 操作成功 (Key: ${dateKey}, Chat: ${chatId})`);
                    };
                } catch(putError) {
                     console.error(`Day1 Worker: 执行 put 操作时出错 (Key: ${dateKey})`, putError);
                     // 尝试中止事务
                     try { transaction.abort(); } catch (abortErr) {}
                     reject(putError);
                }
            };

        } catch (error) {
            console.error(`Day1 Worker: updateStats 捕获到顶层错误 (Key: ${dateKey}, Chat: ${chatId})`, error);
            reject(error);
        }
    });
}

// 4. 监听来自主线程的消息
self.onmessage = async (event) => {
    // 确保 event.data 存在且是对象
    if (!event.data || typeof event.data !== 'object') {
        console.warn("Day1 Worker: 收到无效消息格式:", event.data);
        return;
    }

    const { type, payload } = event.data;
    console.log('Day1 Worker: 收到消息:', type, payload);

    // 确保 payload 存在
    if (!payload) {
         console.warn(`Day1 Worker: 消息 ${type} 缺少 payload`);
         // 根据情况决定是否发送错误
         try {
            self.postMessage({ type: `${type}_ERROR`, success: false, error: 'Missing payload', payload });
         } catch(postError) { console.error("Day1 Worker: 发送错误消息失败", postError); }
         return;
    }

    try {
        if (type === 'UPDATE_STATS') {
            const { dateKey, chatId, messageType, tokenCount } = payload;
             // 再次检查 chatId
            if (!chatId) {
                console.warn('Day1 Worker: UPDATE_STATS 缺少 chatId');
                 try {
                    self.postMessage({ type: 'STATS_UPDATE_ERROR', success: false, error: 'Missing chatId', payload });
                 } catch(postError) { console.error("Day1 Worker: 发送错误消息失败", postError); }
                return;
            }
            await updateStats(dateKey, chatId, messageType, tokenCount);
            // 可以在这里发送成功回执（如果需要）
            // self.postMessage({ type: 'STATS_UPDATED', success: true, payload });
        } else if (type === 'GET_STATS') {
            const { dateKey } = payload;
             if (!dateKey) {
                 console.warn('Day1 Worker: GET_STATS 缺少 dateKey');
                 try {
                    self.postMessage({ type: 'STATS_GET_ERROR', success: false, error: 'Missing dateKey', payload });
                 } catch(postError) { console.error("Day1 Worker: 发送错误消息失败", postError); }
                return;
             }
            const stats = await getStats(dateKey);
             try {
                self.postMessage({ type: 'STATS_RESULT', success: true, payload: { dateKey, stats } });
             } catch(postError) { console.error("Day1 Worker: 发送 STATS_RESULT 失败", postError); }
        } else {
            console.warn("Day1 Worker: 收到未知消息类型:", type);
        }
    } catch (error) {
        console.error(`Day1 Worker: 处理消息 ${type} 时出错:`, error);
         try {
            self.postMessage({ type: `${type}_ERROR`, success: false, error: error?.message || String(error), payload });
         } catch(postError) { console.error("Day1 Worker: 发送错误消息失败", postError); }
    }
};

// 立即尝试初始化数据库
console.log("Day1 Worker: 脚本开始执行，尝试初始化 DB...");
// 避免顶层 await，使用 .then/.catch 处理初始化 Promise
initDB()
    .then(() => console.log("Day1 Worker: DB 初始化流程启动成功 (或已完成)"))
    .catch(error => {
        console.error("Day1 Worker: 初始化 DB 过程出错:", error);
        // 可以在这里再尝试发送一次错误消息，以防之前的发送失败
         try {
            self.postMessage({ type: 'WORKER_INIT_ERROR', error: `IndexedDB init process error: ${error?.message || error}` });
         } catch (postError) {
             console.error("Day1 Worker: 发送初始化错误消息失败", postError);
         }
});

console.log("Day1 Worker: 脚本已完全加载"); // 添加一个日志确认脚本加载完成
