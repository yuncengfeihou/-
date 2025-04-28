// public/extensions/third-party/day1/statsWorker.js (临时替换内容)
const extensionName = "day1";
console.log(`[${extensionName} Worker] Script successfully loaded and started.`);

self.onmessage = (event) => {
    console.log(`[${extensionName} Worker] Received command:`, event.data?.command);
    if (event.data && event.data.command === 'fetchAndProcessStats') {
        console.log(`[${extensionName} Worker] Simulating work and posting back.`);
        // 模拟返回一个空数据，避免主线程报错
        self.postMessage({ command: 'statsResult', data: {} });
    }
};

console.log(`[${extensionName} Worker] Message handler ready.`);
// 可以在最后发送一个消息表明 worker 确实初始化了
// self.postMessage({ command: 'workerReady' });
