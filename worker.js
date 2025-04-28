// 文件: public/extensions/third-party/day1/worker.js
// (在 index.js 中引用时路径为 'scripts/extensions/third-party/day1/worker.js')

const DB_NAME = 'SillyTavernDay1Stats';
const STORE_NAME = 'dailyStats';
const DB_VERSION = 1; // 确保这个版本号和 index.js 中的一致
let db; // 用于缓存数据库连接

// --- IndexedDB 辅助函数 ---

/**
 * 打开或返回已打开的 IndexedDB 数据库连接。
 * 注意：此函数不再处理数据库升级或对象存储创建，这由主线程负责。
 */
function openDB() {
    return new Promise((resolve, reject) => {
        // 如果已有连接，直接返回
        if (db) {
            resolve(db);
            return;
        }

        console.log("Day1 Worker: Attempting to open IndexedDB...");
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        // 处理打开数据库时可能发生的错误
        request.onerror = (event) => {
            console.error('Day1 Worker: IndexedDB open error:', event.target.error);
            reject('IndexedDB error: ' + event.target.error);
        };

        // 数据库成功打开后，缓存连接并解析 Promise
        request.onsuccess = (event) => {
            db = event.target.result;
            console.log('Day1 Worker: IndexedDB connection opened successfully.');

            // (可选) 添加数据库错误和关闭的监听器，以提高健壮性
            db.onerror = (event) => {
                console.error("Day1 Worker: Database error:", event.target.error);
            };
            db.onclose = () => {
                console.log("Day1 Worker: Database connection closed.");
                db = null; // 清除缓存的连接
            };
            db.onversionchange = () => {
                 console.log("Day1 Worker: Database version change detected, closing connection.");
                 if (db) {
                    db.close();
                    db = null;
                 }
            };


            resolve(db);
        };

        // onupgradeneeded 事件处理程序已移除，由主线程负责数据库结构创建
    });
}

/**
 * 从指定的对象存储中读取特定 ID 的数据。
 * @param {string} entityId 要读取数据的实体 ID (主键)。
 * @returns {Promise<object|undefined>} 返回找到的数据对象，如果未找到则返回 undefined。
 */
function readData(entityId) {
    return new Promise(async (resolve, reject) => {
        try {
            // 确保数据库连接已打开
            const currentDb = await openDB();
            // 启动一个只读事务
            const transaction = currentDb.transaction(STORE_NAME, 'readonly');
            const store = transaction.objectStore(STORE_NAME);
            // 通过主键获取数据
            const request = store.get(entityId);

            request.onerror = (event) => reject('Error reading data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result); // 返回结果

        } catch (error) {
            // 捕获 openDB 可能抛出的错误
            console.error("Day1 Worker: Error during readData transaction setup:", error);
            reject(error);
        }
    });
}

/**
 * 将数据写入（或更新）到指定的对象存储中。
 * @param {object} data 要写入的数据对象，必须包含 keyPath ('entityId')。
 * @returns {Promise<IDBValidKey>} 写入成功时返回写入记录的主键。
 */
function writeData(data) {
    return new Promise(async (resolve, reject) => {
        try {
            // 确保数据库连接已打开
            const currentDb = await openDB();
            // 启动一个读写事务
            const transaction = currentDb.transaction(STORE_NAME, 'readwrite');
            const store = transaction.objectStore(STORE_NAME);
            // 使用 put 方法插入或更新数据
            const request = store.put(data);

            request.onerror = (event) => reject('Error writing data: ' + event.target.error);
            request.onsuccess = (event) => resolve(event.target.result); // 返回操作的主键

        } catch (error) {
            // 捕获 openDB 可能抛出的错误
            console.error("Day1 Worker: Error during writeData transaction setup:", error);
            reject(error);
        }
    });
}

// --- Web Worker 消息处理 ---

/**
 * 监听来自主线程的消息，并执行相应的命令。
 */
self.onmessage = async (event) => {
    // 确保 event.data 和 command 存在
    if (!event.data || !event.data.command) {
        console.warn("Day1 Worker: Received invalid message format.");
        return;
    }

    const { command, payload } = event.data;

    // 处理 'processMessage' 命令
    if (command === 'processMessage') {
        // 确保 payload 和必要字段存在
        if (!payload || !payload.entityId || !payload.timestamp) {
             console.warn('Day1 Worker: Received processMessage command with missing payload data (entityId or timestamp).', payload);
             return;
        }
        const { entityId, entityName, isUser, tokenCount, timestamp } = payload;


        try {
            // 获取当天日期字符串 (YYYY-MM-DD)
            // 对 timestamp 进行更健壮的处理
            let date;
            try {
                date = new Date(timestamp);
                if (isNaN(date.getTime())) { // 检查日期是否有效
                    console.warn(`Day1 Worker: Invalid timestamp received (${timestamp}), using current time.`);
                    date = new Date();
                }
            } catch (e) {
                 console.warn(`Day1 Worker: Error parsing timestamp (${timestamp}), using current time.`, e);
                 date = new Date();
            }
            const dateString = date.toISOString().split('T')[0];

            // 1. 读取现有数据
            let stats = await readData(entityId);

            // 2. 如果没有数据，创建新记录
            if (!stats) {
                stats = {
                    entityId: entityId,
                    // 使用 entityName，如果不存在则回退到 entityId
                    entityName: entityName || entityId,
                    dailyData: {}, // 初始化 dailyData
                };
                console.log(`Day1 Worker: Creating new stats entry for ${entityId}`);
            }

            // 3. 确保当天的统计对象存在
            if (!stats.dailyData[dateString]) {
                stats.dailyData[dateString] = {
                    userMessages: 0,
                    aiMessages: 0,
                    cumulativeTokens: 0,
                };
                console.log(`Day1 Worker: Creating new daily entry for ${entityId} on ${dateString}`);
            }

            // 4. 更新实体名称（如果提供了且与现有不同）
            // 确保 entityName 存在且不为空字符串
            if (entityName && stats.entityName !== entityName) {
                console.log(`Day1 Worker: Updating entity name for ${entityId} from "${stats.entityName}" to "${entityName}"`);
                stats.entityName = entityName;
            }

            // 5. 更新统计数据
            const dailyStat = stats.dailyData[dateString];
            if (isUser === true) { // 显式检查布尔值
                dailyStat.userMessages += 1;
            } else if (isUser === false) {
                dailyStat.aiMessages += 1;
            }
            // 确保 tokenCount 是数字
            dailyStat.cumulativeTokens += Number(tokenCount) || 0;

            // 6. 写回数据库
            await writeData(stats);
            // console.log(`Day1 Worker: Stats updated successfully for ${entityId} on ${dateString}. New stats:`, dailyStat);

            // (可选) 回发成功状态给主线程
            // self.postMessage({ status: 'processed', entityId: entityId, date: dateString });

        } catch (error) {
            console.error(`Day1 Worker: Error processing message for entity ${entityId}:`, error);
            // (可选) 回发错误状态给主线程
            // self.postMessage({ status: 'error', entityId: entityId, message: error.toString() });
        }
    }
    // 可以添加其他 command 处理逻辑
    // else if (command === 'getStats') { ... }
};

// --- Worker 初始化 ---
console.log('Day1 Worker: Script loaded and initializing.');

// 首次加载时尝试打开数据库连接，但不处理升级
// 这有助于预热连接，并捕获早期的连接错误
openDB().then(() => {
    console.log("Day1 Worker: Initial DB connection attempt successful.");
}).catch(e => {
    console.error("Day1 Worker: Initial DB connection attempt failed.", e);
    // 在 Worker 无法连接到 DB 的情况下，可能需要通知主线程
    // self.postMessage({ status: 'error', message: 'Worker failed to connect to IndexedDB.' });
});
