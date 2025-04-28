// public/extensions/third-party/day1/worker.js

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
            self.postMessage({ type: 'WORKER_INIT_ERROR', error: `IndexedDB open request error: ${error?.message || error}` });
            reject('IndexedDB open request error: ' + error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB 打开成功');
            // 数据库成功打开后，发送就绪消息
            self.postMessage({ type: 'WORKER_READY' });
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            console.log('Day1 Worker: IndexedDB 升级或创建');
            try {
                const store = event.target.result.createObjectStore(STORE_NAME, { keyPath: 'date' });
                console.log('Day1 Worker: Object store 创建成功');
            } catch (error) {
                console.error('Day1 Worker: 创建 object store 失败:', error);
                self.postMessage({ type: 'WORKER_INIT_ERROR', error: `创建 object store 失败: ${error?.message || error}` });
                reject('创建 object store 失败: ' + error);
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
                resolve(event.target.result ? event.target.result.statsMap : {});
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

            getRequest.onsuccess = (event) => {
                let data = event.target.result;
                let statsMap = {};

                if (data && typeof data.statsMap === 'object' && data.statsMap !== null) {
                    statsMap = data.statsMap;
                } else {
                    data = { date: dateKey, statsMap: {} };
                }

                const chatStats = statsMap[chatId] || { userMessages: 0, aiMessages: 0, totalTokens: 0 };

                if (messageType === 'user') {
                    chatStats.userMessages += 1;
                } else if (messageType === 'ai') {
                    chatStats.aiMessages += 1;
                }
                chatStats.totalTokens = (chatStats.totalTokens || 0) + (tokenCount || 0); // 确保累加的是数字

                statsMap[chatId] = chatStats;
                data.statsMap = statsMap;

                const putRequest = store.put(data);

                putRequest.onerror = (event) => {
                    console.error(`Day1 Worker: 写入数据失败 (Key: ${dateKey})`, event.target.error);
                    reject(event.target.error);
                };

                putRequest.onsuccess = () => {
                    // console.log(`Day1 Worker: 数据更新成功 (Key: ${dateKey}, Chat: ${chatId})`);
                    resolve();
                };
            };

        } catch (error) {
            console.error(`Day1 Worker: updateStats 捕获到错误 (Key: ${dateKey}, Chat: ${chatId})`, error);
            reject(error);
        }
    });
}

// 4. 监听来自主线程的消息
self.onmessage = async (event) => {
    const { type, payload } = event.data;
    console.log('Day1 Worker: 收到消息:', type, payload);

    try {
        if (type === 'UPDATE_STATS') {
            const { dateKey, chatId, messageType, tokenCount } = payload;
             // 再次检查 chatId
            if (!chatId) {
                console.warn('Day1 Worker: UPDATE_STATS 缺少 chatId');
                self.postMessage({ type: 'STATS_UPDATE_ERROR', success: false, error: 'Missing chatId', payload });
                return;
            }
            await updateStats(dateKey, chatId, messageType, tokenCount);
            // self.postMessage({ type: 'STATS_UPDATED', success: true, payload });
        } else if (type === 'GET_STATS') {
            const { dateKey } = payload;
            const stats = await getStats(dateKey);
            self.postMessage({ type: 'STATS_RESULT', success: true, payload: { dateKey, stats } });
        }
    } catch (error) {
        console.error(`Day1 Worker: 处理消息 ${type} 时出错:`, error);
        self.postMessage({ type: type === 'UPDATE_STATS' ? 'STATS_UPDATE_ERROR' : 'STATS_GET_ERROR', success: false, error: error?.message || String(error), payload });
    }
};

// 立即尝试初始化数据库
console.log("Day1 Worker: 脚本开始执行，尝试初始化 DB...");
initDB().catch(error => {
    console.error("Day1 Worker: 初始化 DB 失败:", error);
    // 即使这里失败，onerror 处理器应该已经发送了错误消息
});
