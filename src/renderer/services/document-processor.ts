/**
 * DocumentProcessor - 文档分块处理
 */

export function chunkText(text: string, { maxChunkSize = 1500, overlap = 200 } = {}): string[] {
  if (!text || text.trim().length === 0) return [];

  const paragraphs = text.split(/\n\s*\n/).filter(p => p.trim());
  const chunks: string[] = [];
  let current = '';

  for (const para of paragraphs) {
    const trimmed = para.trim();
    if (!trimmed) continue;

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
          sentenceBuf = overlap > 0 ? sentenceBuf.slice(-overlap) + sent : sent;
        } else {
          sentenceBuf += sent;
        }
      }
      if (sentenceBuf.trim()) {
        current = sentenceBuf;
      }
      continue;
    }

    if ((current + '\n\n' + trimmed).length > maxChunkSize && current) {
      chunks.push(current.trim());
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

function splitSentences(text: string): string[] {
  const parts = text.split(/(?<=[。！？.!?])\s*/);
  return parts.filter(p => p.trim()).map(p => p.trim() + ' ');
}

export function createChunkMetadata(chunk: string, index: number, docId: string, filename: string) {
  return {
    id: `${docId}_chunk_${index}`,
    docId,
    filename,
    chunkIndex: index,
    text: chunk,
    charCount: chunk.length
  };
}
