// public/extensions/third-party/day1/worker.js

const DB_NAME = 'SillyTavernDay1StatsDB';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1;

let db;

// 1. 初始化（或打开）IndexedDB 数据库
function initDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('Day1 Worker: IndexedDB 错误:', event.target.error);
            reject('IndexedDB 错误: ' + event.target.error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB 打开成功');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            console.log('Day1 Worker: IndexedDB 升级或创建');
            const store = event.target.result.createObjectStore(STORE_NAME, { keyPath: 'date' });
            // 你可以在这里添加索引，如果需要的话
            // store.createIndex('chatIdIndex', 'stats.chatId', { unique: false });
        };
    });
}

// 2. 获取指定日期的统计数据
function getStats(dateKey) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await initDB();
            const transaction = currentDb.transaction([STORE_NAME], 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(dateKey);

            request.onerror = (event) => {
                console.error(`Day1 Worker: 获取数据失败 (Key: ${dateKey})`, event.target.error);
                reject(event.target.error);
            };

            request.onsuccess = (event) => {
                // 如果找不到当天的记录，返回一个空对象
                resolve(event.target.result ? event.target.result.statsMap : {});
            };
        } catch (error) {
            reject(error);
        }
    });
}

// 3. 更新指定日期和聊天ID的统计数据
function updateStats(dateKey, chatId, messageType, tokenCount) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await initDB();
            const transaction = currentDb.transaction([STORE_NAME], 'readwrite');
            const store = transaction.objectStore(STORE_NAME);

            const getRequest = store.get(dateKey);

            getRequest.onsuccess = (event) => {
                let data = event.target.result;
                let statsMap = {};

                if (data) {
                    // IndexedDB 不能直接存储 Map，所以我们用普通对象模拟
                    statsMap = data.statsMap || {};
                } else {
                    // 如果当天没有记录，创建一个新的
                    data = { date: dateKey, statsMap: {} };
                }

                // 获取或初始化特定聊天的统计
                const chatStats = statsMap[chatId] || { userMessages: 0, aiMessages: 0, totalTokens: 0 };

                // 更新计数
                if (messageType === 'user') {
                    chatStats.userMessages += 1;
                } else if (messageType === 'ai') {
                    chatStats.aiMessages += 1;
                }
                chatStats.totalTokens += tokenCount;

                // 将更新后的聊天统计放回 Map（模拟对象）
                statsMap[chatId] = chatStats;
                data.statsMap = statsMap; // 更新回主记录

                // 将更新后的记录存回 IndexedDB
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

            getRequest.onerror = (event) => {
                console.error(`Day1 Worker: 获取数据失败 (Key: ${dateKey}) for update`, event.target.error);
                reject(event.target.error);
            };

        } catch (error) {
            reject(error);
        }
    });
}

// 4. 监听来自主线程的消息
self.onmessage = async (event) => {
    const { type, payload } = event.data;

    try {
        if (type === 'UPDATE_STATS') {
            const { dateKey, chatId, messageType, tokenCount } = payload;
            if (!chatId) {
                console.warn('Day1 Worker: 收到无效的 chatId，无法更新统计');
                return;
            }
            await updateStats(dateKey, chatId, messageType, tokenCount);
            // 可以选择性地发送回执消息
            // self.postMessage({ type: 'STATS_UPDATED', success: true, payload });
        } else if (type === 'GET_STATS') {
            const { dateKey } = payload;
            const stats = await getStats(dateKey);
            self.postMessage({ type: 'STATS_RESULT', success: true, payload: { dateKey, stats } });
        }
    } catch (error) {
        console.error('Day1 Worker: 处理消息时出错:', error);
        // 发送错误回执
        self.postMessage({ type: type === 'UPDATE_STATS' ? 'STATS_UPDATE_ERROR' : 'STATS_GET_ERROR', success: false, error: error.message, payload });
    }
};

// 立即尝试初始化数据库
initDB().catch(error => console.error("Day1 Worker: 初始化 DB 失败:", error));
