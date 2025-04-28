// public/extensions/third-party/daily-usage-stats/statsWorker.js

// 注意：Worker 无法直接访问主线程的全局变量或 DOM
// 需要一种方式让 Worker 也能使用 idbHelper，或者在主线程查询后将数据发送给 Worker

// 方案一：Worker 自己导入 idbHelper (如果环境允许，现代浏览器通常可以)
import { getAllStats } from './idbHelper.js'; // 假设路径正确
const extensionName = "day1"; // 需要在这里也定义

self.onmessage = async (event) => {
    if (event.data && event.data.command === 'fetchAndProcessStats') {
        console.log(`[${extensionName} Worker] Received fetch command.`);
        try {
            const allStats = await getAllStats(); // Worker 调用 IndexedDB

            // --- 在这里进行数据处理、排序、聚合 ---
            const processedData = {};
            const sortedDates = [...new Set(allStats.map(s => s.date))].sort().reverse();

            for (const dateStr of sortedDates) {
                processedData[dateStr] = allStats
                    .filter(s => s.date === dateStr)
                    .sort((a, b) => a.name.localeCompare(b.name)); // 按名字排序
            }
            // --- 处理结束 ---

            console.log(`[${extensionName} Worker] Sending processed data back.`);
            self.postMessage({ command: 'statsResult', data: processedData });
        } catch (error) {
            console.error(`[${extensionName} Worker] Error processing stats:`, error);
            self.postMessage({ command: 'statsError', error: error.message });
        }
    }
};

console.log(`[${extensionName} Worker] Initialized.`);
