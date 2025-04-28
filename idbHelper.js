// public/extensions/third-party/daily-usage-stats/idbHelper.js

const DB_NAME = 'SillyTavernStatsDB';
const STORE_NAME = 'usageStats';
const DB_VERSION = 1; // 版本号，如果更改 schema 需要增加

let dbPromise = null;

// 初始化数据库连接
function initDB() {
    if (dbPromise) return dbPromise;

    dbPromise = new Promise((resolve, reject) => {
        const request = indexedDB.open(DB_NAME, DB_VERSION);

        request.onerror = (event) => {
            console.error(`[${extensionName}] IndexedDB error:`, event.target.error);
            reject(`IndexedDB error: ${event.target.error}`);
        };

        request.onsuccess = (event) => {
            console.log(`[${extensionName}] IndexedDB connection successful.`);
            resolve(event.target.result);
        };

        // 如果数据库不存在或版本升级时调用
        request.onupgradeneeded = (event) => {
            console.log(`[${extensionName}] Upgrading IndexedDB...`);
            const db = event.target.result;
            if (!db.objectStoreNames.contains(STORE_NAME)) {
                // 创建对象存储，使用复合键或自动生成键+索引
                // 方式一：自动生成键 + 索引 (推荐)
                const store = db.createObjectStore(STORE_NAME, { keyPath: 'id', autoIncrement: true });
                store.createIndex('date', 'date', { unique: false });
                store.createIndex('entityId', 'entityId', { unique: false });
                store.createIndex('date_entityId', ['date', 'entityId'], { unique: true }); // 复合索引保证唯一性
                 console.log(`[${extensionName}] Object store "${STORE_NAME}" created with indexes.`);

                // 方式二：复合键 (如果浏览器支持且你偏好)
                // db.createObjectStore(STORE_NAME, { keyPath: ['date', 'entityId'] });
            }
        };
    });
    return dbPromise;
}

// 添加或更新统计数据 (核心函数)
async function addOrUpdateStat(dateStr, entityId, entityName, statToIncrement, incrementValue = 1) {
    try {
        const db = await initDB();
        const transaction = db.transaction(STORE_NAME, 'readwrite');
        const store = transaction.objectStore(STORE_NAME);
        // 使用索引查找记录
        const index = store.index('date_entityId');
        const request = index.get([dateStr, entityId]);

        return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                let data = event.target.result;

                if (data) {
                    // 更新现有记录
                    if (statToIncrement) {
                         data[statToIncrement] = (data[statToIncrement] || 0) + incrementValue;
                    }
                     // 如果实体名称在记录中丢失或不同，则更新
                     if (!data.name || data.name !== entityName) {
                        data.name = entityName;
                     }
                    store.put(data); // 保存更新
                } else {
                    // 创建新记录
                    const newRecord = {
                        date: dateStr,
                        entityId: entityId,
                        name: entityName || `未知实体 (${entityId})`,
                        userMessages: 0,
                        aiMessages: 0,
                        totalTokensSent: 0,
                    };
                     if (statToIncrement) {
                        newRecord[statToIncrement] = incrementValue;
                    }
                    store.add(newRecord); // 添加新记录
                }

                transaction.oncomplete = () => {
                    // console.log(`[${extensionName}] Stat update complete for ${entityName} on ${dateStr}`);
                    resolve();
                };

                transaction.onerror = (event) => {
                    console.error(`[${extensionName}] Transaction error:`, event.target.error);
                    reject(event.target.error);
                };
            };

             request.onerror = (event) => {
                console.error(`[${extensionName}] Error fetching record:`, event.target.error);
                reject(event.target.error);
            };
        });

    } catch (error) {
        console.error(`[${extensionName}] Failed to update stat:`, error);
    }
}

// 获取所有统计数据 (用于显示)
async function getAllStats() {
    try {
        const db = await initDB();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const request = store.getAll();

        return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                resolve(event.target.result || []);
            };
            request.onerror = (event) => {
                console.error(`[${extensionName}] Error getting all stats:`, event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error(`[${extensionName}] Failed to get all stats:`, error);
        return []; // 返回空数组表示失败
    }
}

// (可选) 获取指定日期的统计数据
async function getStatsByDate(dateStr) {
     try {
        const db = await initDB();
        const transaction = db.transaction(STORE_NAME, 'readonly');
        const store = transaction.objectStore(STORE_NAME);
        const index = store.index('date'); // 使用日期索引
        const request = index.getAll(dateStr); // 获取该日期的所有记录

        return new Promise((resolve, reject) => {
            request.onsuccess = (event) => {
                resolve(event.target.result || []);
            };
            request.onerror = (event) => {
                console.error(`[${extensionName}] Error getting stats for date ${dateStr}:`, event.target.error);
                reject(event.target.error);
            };
        });
    } catch (error) {
        console.error(`[${extensionName}] Failed to get stats for date ${dateStr}:`, error);
        return [];
    }
}


// 导出需要在 index.js 中使用的函数
export { initDB, addOrUpdateStat, getAllStats, getStatsByDate };
// 确保在index.js中定义extensionName
const extensionName = "daily-usage-stats";
