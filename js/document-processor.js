/**
 * DocumentProcessor - 文档分块处理
 */

/**
 * 将文本切分为语义块
 * @param {string} text - 原始文本
 * @param {object} options
 * @param {number} options.maxChunkSize - 每块最大字符数 (默认 1500)
 * @param {number} options.overlap - 块间重叠字符数 (默认 200)
 * @returns {string[]} 分块后的文本数组
 */
export function chunkText(text, { maxChunkSize = 1500, overlap = 200 } = {}) {
    if (!text || text.trim().length === 0) return [];

    // 先按段落分割
    const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
    const chunks = [];
    let current = '';

    for (const para of paragraphs) {
        const trimmed = para.trim();
        if (!trimmed) continue;

        // 单段落超过 maxChunkSize → 按句子分割
        if (trimmed.length > maxChunkSize) {
            if (current) {
                chunks.push(current.trim());
                current = '';
            }
            const sentences = splitSentences(trimmed);
            let sentenceBuf = '';
            for (const sent of sentences) {
                if ((sentenceBuf + sent).length > maxChunkSize && sentenceBuf) {
                    chunks.push(sentenceBuf.trim());
                    // 保留末尾 overlap
                    sentenceBuf = overlap > 0
                        ? sentenceBuf.slice(-overlap) + sent
                        : sent;
                } else {
                    sentenceBuf += sent;
                }
            }
            if (sentenceBuf.trim()) {
                current = sentenceBuf;
            }
            continue;
        }

        // 正常段落累积
        if ((current + '\n\n' + trimmed).length > maxChunkSize && current) {
            chunks.push(current.trim());
            // 保留末尾 overlap
            if (overlap > 0 && current.length > overlap) {
                current = current.slice(-overlap) + '\n\n' + trimmed;
            } else {
                current = trimmed;
            }
        } else {
            current = current ? current + '\n\n' + trimmed : trimmed;
        }
    }

    if (current.trim()) {
        chunks.push(current.trim());
    }

    return chunks;
}

/**
 * 按句子分割（中英文兼容）
 */
function splitSentences(text) {
    // 中文句号、问号、感叹号 + 英文句号等
    const parts = text.split(/(?<=[。！？.!?])\s*/);
    return parts.filter(p => p.trim()).map(p => p.trim() + ' ');
}

/**
 * 从文件内容提取文档信息
 * @param {string} content - 文件内容
 * @param {string} filename - 文件名
 * @returns {{ text: string, filename: string }}
 */
export function extractDocument(content, filename) {
    return {
        text: content,
        filename
    };
}

/**
 * 生成文档块的元数据
 */
export function createChunkMetadata(chunk, index, docId, filename) {
    return {
        id: `${docId}_chunk_${index}`,
        docId,
        filename,
        chunkIndex: index,
        text: chunk,
        charCount: chunk.length
    };
}
