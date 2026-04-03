/**
 * Service Worker - PWA 离线支持
 * 缓存应用资源以便离线使用
 */

const CACHE_NAME = 'metona-ollama-v3';
const ASSETS = [
    './',
    './index.html',
    './style.css',
    './chat-db.js',
    './marked.esm.js',
    './ollama-api.js',
    './manifest.json'
];

// 安装阶段：预缓存核心资源
self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE_NAME)
            .then(cache => cache.addAll(ASSETS))
            .then(() => self.skipWaiting())
    );
});

// 激活阶段：清理旧缓存
self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then(keys => Promise.all(
                keys.filter(key => key !== CACHE_NAME).map(key => caches.delete(key))
            ))
            .then(() => self.clients.claim())
    );
});

// 拦截请求：缓存优先，网络回退
self.addEventListener('fetch', (event) => {
    // 不拦截非 GET 请求
    if (event.request.method !== 'GET') return;

    event.respondWith(
        caches.match(event.request)
            .then(cached => {
                if (cached) return cached;
                return fetch(event.request).then(response => {
                    // 仅缓存成功的响应
                    if (response && response.status === 200) {
                        const clone = response.clone();
                        caches.open(CACHE_NAME).then(cache => cache.put(event.request, clone));
                    }
                    return response;
                }).catch(() => {
                    // 离线且无缓存时返回简单提示
                    if (event.request.destination === 'document') {
                        return new Response('离线模式：请检查网络连接', {
                            headers: { 'Content-Type': 'text/plain; charset=utf-8' }
                        });
                    }
                });
            })
    );
});
