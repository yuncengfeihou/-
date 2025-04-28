// 注意：此文件路径为 'public/extensions/third-party/day1/worker.js'
// 但是在 index.js 中引用时要使用 'scripts/extensions/third-party/day1/worker.js'

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1;
let db;

// --- IndexedDB 辅助函数 ---
function openDB() {
    return new Promise((resolve, reject) => {
        if (db) {
            resolve(db);
            return;
        }
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error('Day1 Worker: IndexedDB error:', event.target.error);
            reject('IndexedDB error: ' + event.target.error);
        };

        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB opened successfully.');
            resolve(db);
        };

        request.onupgradeneeded = (event) => {
            console.log('Day1 Worker: IndexedDB upgrade needed.');
            db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // 使用 entityId 作为主键
                db.createObjectStore(STORE_NAME, { keyPath: 'entityId' });
                console.log(`Day1 Worker: Object store "${STORE_NAME}" created.`);
            }
        };
    });
}

function readData(entityId) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.get(entityId);

            request.onerror = (event) => reject('Error reading data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result); // 返回找到的记录或 undefined

        } catch (error) {
            reject(error);
        }
    });
}

function writeData(data) {
    return new Promise(async (resolve, reject) => {
        try {
            const currentDb = await openDB();
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            const request = store.put(data); // put 会覆盖或插入

            request.onerror = (event) => reject('Error writing data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result);

        } catch (error) {
            reject(error);
        }
    });
}

// --- Web Worker 消息处理 ---
self.onmessage = async (event) => {
    const { command, payload } = event.data;

    if (command === 'processMessage') {
        const { entityId, entityName, isUser, tokenCount, timestamp } = payload;
        if (!entityId) {
            console.warn('Day1 Worker: Received message without entityId, skipping.');
            return;
        }

        try {
            // 获取当天日期字符串 (YYYY-MM-DD)
            const date = new Date(timestamp);
            const dateString = date.toISOString().split('T')[0];

            // 读取现有数据或创建新记录
            let stats = await readData(entityId);
            if (!stats) {
                stats = {
                    entityId: entityId,
                    entityName: entityName || entityId, // 记录名称方便显示
                    dailyData: {},
                };
            }

            // 确保当天的记录存在
            if (!stats.dailyData[dateString]) {
                stats.dailyData[dateString] = {
                    userMessages: 0,
                    aiMessages: 0,
                    cumulativeTokens: 0,
                };
            }
             // 更新名称，以防用户重命名角色/组
            if (entityName && stats.entityName !== entityName) {
                stats.entityName = entityName;
            }

            // 更新统计数据
            const dailyStat = stats.dailyData[dateString];
            if (isUser) {
                dailyStat.userMessages += 1;
            } else {
                dailyStat.aiMessages += 1;
            }
            dailyStat.cumulativeTokens += tokenCount || 0; // 累加 token

            // 写回数据库
            await writeData(stats);
            // console.log(`Day1 Worker: Stats updated for ${entityId} on ${dateString}`, dailyStat);

            // (可选) 可以回发消息通知主线程更新成功或发送最新数据
            // self.postMessage({ status: 'updated', entityId: entityId, date: dateString, stats: dailyStat });

        } catch (error) {
            console.error(`Day1 Worker: Error processing message for ${entityId}:`, error);
            // (可选) 回发错误信息
            // self.postMessage({ status: 'error', message: error.toString() });
        }
    }
};

console.log('Day1 Worker: Initialized.');
// 首次加载时尝试打开数据库以触发 onupgradeneeded (如果需要)
openDB().catch(e => console.error("Day1 Worker: Initial DB open failed", e));
