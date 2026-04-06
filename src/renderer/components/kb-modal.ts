/**
 * KBModal - 知识库管理面板
 */

import { state, KEYS } from '../state/state.js';
import {
  initVectorStore, getVectorStore, addDocumentToKB,
  removeDocumentFromKB, getDocumentsInCollection, retrieveContext,
  buildRagSystemPrompt
} from '../services/rag.js';
import { fileToText, formatSize, escapeHtml, truncate } from '../utils/utils.js';
import { showToast } from './toast.js';
import { showConfirm } from './prompt-modal.js';
import { OllamaAPI } from '../api/ollama.js';
import { logRAG, logError } from '../services/log-service.js';
import type { VectorCollection, SearchResult } from '../types.js';

let kbModalEl: HTMLElement;
let currentColId: string | null = null;
let ragEnabled = false;
let ragCollectionId: string | null = null;

export function initKBModal(): void {
  kbModalEl = document.querySelector('#kbModal')!;

  document.querySelector('#btnKB')!.addEventListener('click', openKBModal);
  document.querySelector('#btnCloseKB')!.addEventListener('click', closeKBModal);
  kbModalEl.addEventListener('click', (e) => {
    if (e.target === kbModalEl) closeKBModal();
  });

  document.querySelector('#btnNewCollection')!.addEventListener('click', createCollection);

  document.querySelector('#btnUploadDoc')!.addEventListener('click', () => {
    if (!currentColId) { showToast('请先选择一个知识库集合', 'warning'); return; }
    (document.querySelector('#kbFileInput') as HTMLInputElement).click();
  });
  document.querySelector('#kbFileInput')!.addEventListener('change', handleDocUpload);

  document.querySelector('#toggleRAG')!.addEventListener('change', (e) => {
    ragEnabled = (e.target as HTMLInputElement).checked;
    if (ragEnabled && currentColId) {
      ragCollectionId = currentColId;
      showToast('RAG 知识检索已开启', 'success');
    } else if (ragEnabled && !currentColId) {
      (e.target as HTMLInputElement).checked = false;
      ragEnabled = false;
      showToast('请先选择一个知识库集合', 'warning');
      return;
    } else {
      ragCollectionId = null;
      showToast('RAG 知识检索已关闭', 'info');
    }
    updateRagBadge();
  });

  document.querySelector('#selectEmbedModel')!.addEventListener('change', async (e) => {
    if (!currentColId) return;
    const vs = getVectorStore();
    const col = await vs!.getCollection(currentColId);
    if (col) {
      col.embeddingModel = (e.target as HTMLSelectElement).value;
      await vs!.updateCollection(col);
    }
  });
}

export function isRagEnabled(): boolean {
  return ragEnabled && !!ragCollectionId;
}

export function getRagCollectionId(): string | null {
  return ragCollectionId;
}

export async function performRagRetrieval(query: string): Promise<{ context: string; results: SearchResult[]; ragPrompt: string } | null> {
  if (!isRagEnabled()) return null;
  try {
    const { context, results } = await retrieveContext(query, ragCollectionId!, 5);
    if (!context) return null;
    return { context, results, ragPrompt: buildRagSystemPrompt(context) };
  } catch (err) {
    console.warn('[KB] RAG 检索失败:', err);
    return null;
  }
}

function updateRagBadge(): void {
  const badge = document.querySelector('#badgeRAG') as HTMLElement;
  if (!badge) return;
  badge.style.display = ragEnabled ? '' : 'none';
}

async function openKBModal(): Promise<void> {
  kbModalEl.style.display = '';
  await refreshCollections();
  await populateEmbedModels();
}

function closeKBModal(): void {
  kbModalEl.style.display = 'none';
}

async function refreshCollections(): Promise<void> {
  const vs = await initVectorStore();
  const collections = await vs.getCollections();
  const listEl = document.querySelector('#kbCollectionList')!;

  if (collections.length === 0) {
    listEl.innerHTML = '<p class="text-muted" style="padding:16px;text-align:center;">暂无知识库，点击上方「新建集合」创建</p>';
    currentColId = null;
    refreshDocList();
    return;
  }

  listEl.innerHTML = collections.map(c => `
    <div class="kb-collection-item ${c.id === currentColId ? 'active' : ''}" data-id="${c.id}">
      <div class="kb-col-info">
        <span class="kb-col-name">${escapeHtml(c.name)}</span>
        <span class="kb-col-stats">${c.docCount || 0} 文档 · ${(c.chunkCount || 0)} 分块</span>
      </div>
      <button class="kb-col-delete icon-btn" data-id="${c.id}" title="删除集合">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>
        </svg>
      </button>
    </div>
  `).join('');

  listEl.querySelectorAll('.kb-collection-item').forEach(el => {
    el.addEventListener('click', async (e) => {
      if ((e.target as HTMLElement).closest('.kb-col-delete')) return;
      currentColId = (el as HTMLElement).dataset.id!;
      await refreshCollections();
      await refreshDocList();
      const vs = getVectorStore();
      const col = await vs!.getCollection(currentColId);
      if (col?.embeddingModel) {
        (document.querySelector('#selectEmbedModel') as HTMLSelectElement).value = col.embeddingModel;
      }
    });
  });

  listEl.querySelectorAll('.kb-col-delete').forEach(btn => {
    btn.addEventListener('click', async (e) => {
      e.stopPropagation();
      const id = (btn as HTMLElement).dataset.id!;
      if (!await showConfirm('确定删除此知识库集合？所有文档将被清除。', '删除知识库')) return;
      const vs = getVectorStore();
      await vs!.deleteCollection(id);
      if (currentColId === id) currentColId = null;
      if (ragCollectionId === id) {
        ragEnabled = false;
        ragCollectionId = null;
        (document.querySelector('#toggleRAG') as HTMLInputElement).checked = false;
        updateRagBadge();
      }
      showToast('集合已删除', 'success');
      await refreshCollections();
      await refreshDocList();
    });
  });
}

async function refreshDocList(): Promise<void> {
  const docListEl = document.querySelector('#kbDocList')!;
  if (!currentColId) {
    docListEl.innerHTML = '<p class="text-muted" style="padding:16px;text-align:center;">← 选择一个知识库集合</p>';
    return;
  }

  const docs = await getDocumentsInCollection(currentColId);
  if (docs.length === 0) {
    docListEl.innerHTML = '<p class="text-muted" style="padding:16px;text-align:center;">此集合暂无文档，上传文件开始构建知识库</p>';
    return;
  }

  docListEl.innerHTML = docs.map(d => `
    <div class="kb-doc-item">
      <span class="kb-doc-icon">📄</span>
      <div class="kb-doc-info">
        <span class="kb-doc-name">${escapeHtml(d.filename)}</span>
        <span class="kb-doc-meta">${d.chunkCount} 个分块</span>
      </div>
      <button class="kb-doc-delete icon-btn" data-docid="${d.docId}" title="删除文档">
        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>
    </div>
  `).join('');

  docListEl.querySelectorAll('.kb-doc-delete').forEach(btn => {
    btn.addEventListener('click', async () => {
      const docId = (btn as HTMLElement).dataset.docid!;
      if (!await showConfirm('确定删除此文档？', '删除文档')) return;
      await removeDocumentFromKB(currentColId!, docId);
      showToast('文档已删除', 'success');
      await refreshCollections();
      await refreshDocList();
    });
  });
}

async function createCollection(): Promise<void> {
  const nameInput = document.querySelector('#inputKBName') as HTMLInputElement;
  const name = nameInput.value.trim();
  if (!name) { showToast('请输入知识库名称', 'warning'); return; }
  const vs = await initVectorStore();
  const col = await vs.createCollection(name);
  currentColId = col.id;
  nameInput.value = '';
  showToast(`知识库「${name}」已创建`, 'success');
  logRAG(`创建集合: ${name}`);
  await refreshCollections();
  await refreshDocList();
}

async function handleDocUpload(e: Event): Promise<void> {
  const fileArr = Array.from((e.target as HTMLInputElement).files || []);
  (e.target as HTMLInputElement).value = '';

  if (fileArr.length === 0) return;

  const embedModel = (document.querySelector('#selectEmbedModel') as HTMLSelectElement).value;
  if (!embedModel) { showToast('请先选择一个嵌入模型', 'warning'); return; }

  const progressEl = document.querySelector('#kbProgress') as HTMLElement;
  const progressTextEl = document.querySelector('#kbProgressText')!;

  let successCount = 0;
  let failCount = 0;

  for (const file of fileArr) {
    if (file.size > 5 * 1024 * 1024) {
      showToast(`${file.name} 超过 5MB 限制`, 'warning');
      failCount++;
      continue;
    }

    try {
      progressEl.style.display = '';
      progressTextEl.textContent = `正在处理 ${file.name}...`;

      const content = await fileToText(file);
      const result = await addDocumentToKB(
        currentColId!, file.name, content, embedModel,
        (done, total, msg) => {
          progressTextEl.textContent = `${file.name}: ${msg} (${done}/${total})`;
        }
      );

      showToast(`${file.name} 已添加到知识库（${result.chunkCount} 个分块）`, 'success');
      logRAG(`文档上传: ${file.name}`, `${result.chunkCount} 个分块`);
      successCount++;
    } catch (err) {
      console.error('[KB] 文档处理失败:', err);
      showToast(`${file.name} 处理失败: ${(err as Error).message}`, 'error');
      logError(`RAG 文档处理失败: ${file.name}`, (err as Error).message);
      failCount++;
    }
  }

  progressEl.style.display = 'none';

  if (fileArr.length > 1) {
    showToast(`上传完成：成功 ${successCount} 个，失败 ${failCount} 个`, failCount > 0 ? 'warning' : 'success');
    logRAG(`批量上传完成`, `成功 ${successCount}, 失败 ${failCount}`);
  }

  await refreshCollections();
  await refreshDocList();
}

async function populateEmbedModels(): Promise<void> {
  const select = document.querySelector('#selectEmbedModel') as HTMLSelectElement;
  const api = state.get<OllamaAPI>(KEYS.API);
  if (!api) return;

  try {
    const data = await api.listModels();
    select.innerHTML = '<option value="">选择嵌入模型...</option>';
    if (!data.models || data.models.length === 0) {
      select.innerHTML = '<option value="">未安装任何模型</option>';
      return;
    }

    const checks = await Promise.allSettled(
      data.models.map(async (m) => {
        const info = await api.showModel(m.name);
        const caps = info.capabilities || [];
        return { name: m.name, size: m.size, isEmbed: caps.includes('embedding') };
      })
    );

    const embedModels = checks
      .filter(r => r.status === 'fulfilled' && r.value.isEmbed)
      .map(r => (r as PromiseFulfilledResult<{ name: string; size?: number; isEmbed: boolean }>).value);

    embedModels.forEach(m => {
      const opt = document.createElement('option');
      opt.value = m.name;
      opt.textContent = m.name + (m.size ? ` (${formatSize(m.size)})` : '');
      select.appendChild(opt);
    });

    if (embedModels.length === 0) {
      select.innerHTML = '<option value="">未检测到嵌入模型，请先 ollama pull</option>';
    }
  } catch (err) {
    console.warn('[KB] 加载模型列表失败:', err);
  }
}
