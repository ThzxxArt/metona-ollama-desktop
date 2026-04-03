/**
 * Ollama API 客户端封装
 *
 * 基于 Fetch API 与 Ollama REST 接口交互
 * 支持：流式聊天、模型管理、连接检测
 *
 * API 文档：https://docs.ollama.com/api
 */

export class OllamaAPI {
    constructor(baseUrl = 'http://127.0.0.1:11434') {
        this.baseUrl = baseUrl.replace(/\/+$/, '');
    }

    /** 通用请求方法 */
    async _request(path, options = {}) {
        const url = `${this.baseUrl}${path}`;
        const config = {
            ...options,
            headers: { 'Content-Type': 'application/json', ...options.headers }
        };
        const response = await fetch(url, config);
        if (!response.ok) {
            const errorBody = await response.text().catch(() => '');
            throw new Error(`Ollama API 错误 ${response.status}: ${errorBody || response.statusText}`);
        }
        return response;
    }

    /** JSON 请求快捷方法 */
    async _json(path, body = null) {
        const options = body ? { method: 'POST', body: JSON.stringify(body) } : {};
        const response = await this._request(path, options);
        return response.json();
    }

    // ── 模型管理 ──

    /** 获取已安装模型列表 */
    async listModels() { return this._json('/api/tags'); }

    /** 获取运行中的模型列表 */
    async psModels() { return this._json('/api/ps'); }

    /** 获取 Ollama 版本 */
    async getVersion() { return this._json('/api/version'); }

    /** 查看模型详情 */
    async showModel(model) { return this._json('/api/show', { model }); }

    // ── 聊天 API ──

    /** 非流式聊天 */
    async chat(params) {
        const body = {
            model: params.model,
            messages: params.messages,
            stream: false,
            ...(params.think !== undefined && { think: params.think }),
            ...(params.system && { system: params.system }),
            ...(params.keep_alive !== undefined && { keep_alive: params.keep_alive }),
            ...(params.options && { options: params.options })
        };
        return this._json('/api/chat', body);
    }

    /**
     * 流式聊天
     * 使用 ReadableStream + TextDecoder 解析 NDJSON 流
     * Ollama 流式响应格式 (NDJSON):
     * {"model":"xxx","message":{"role":"assistant","content":"Hello"},"done":false}
     */
    async chatStream(params, onChunk) {
        const body = {
            model: params.model,
            messages: params.messages,
            stream: true,
            ...(params.think !== undefined && { think: params.think }),
            ...(params.system && { system: params.system }),
            ...(params.keep_alive !== undefined && { keep_alive: params.keep_alive }),
            ...(params.options && { options: params.options })
        };

        const response = await this._request('/api/chat', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const chunk = JSON.parse(line);
                    if (onChunk) onChunk(chunk);
                    if (chunk.done) {
                        reader.cancel();
                        return;
                    }
                } catch (err) {
                    console.warn('[OllamaAPI] 流式数据解析警告:', err.message);
                }
            }
        }

        if (buffer.trim()) {
            try {
                const chunk = JSON.parse(buffer);
                if (onChunk) onChunk(chunk);
            } catch { /* 忽略 */ }
        }
    }

    /** 流式生成（单轮） */
    async generateStream(params, onChunk) {
        const body = {
            model: params.model,
            prompt: params.prompt,
            stream: true,
            ...(params.images && { images: params.images }),
            ...(params.options && { options: params.options })
        };

        const response = await this._request('/api/generate', {
            method: 'POST',
            body: JSON.stringify(body)
        });

        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = '';

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split('\n');
            buffer = lines.pop() || '';

            for (const line of lines) {
                if (!line.trim()) continue;
                try {
                    const chunk = JSON.parse(line);
                    if (onChunk) onChunk(chunk);
                    if (chunk.done) {
                        reader.cancel();
                        return;
                    }
                } catch { /* 忽略不完整数据 */ }
            }
        }
    }

    /** 生成嵌入向量 */
    async embed(model, input) {
        return this._json('/api/embed', { model, input });
    }
}
