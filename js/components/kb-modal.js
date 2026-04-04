/**
 * KBModal - 知识库管理面板
 *
 * 支持：创建/删除集合、上传/删除文档、选择嵌入模型、启用 RAG 检索
 */

import { state, KEYS } from '../state.js';
import {
    initVectorStore, getVectorStore, addDocumentToKB,
    removeDocumentFromKB, getDocumentsInCollection, retrieveContext,
    buildRagSystemPrompt
} from '../rag.js';
import { fileToText, formatSize, escapeHtml, truncate } from '../utils.js';
import { showToast } from './toast.js';

let kbModalEl;
let currentColId = null;

/** 当前是否启用 RAG */
let ragEnabled = false;
let ragCollectionId = null;

export function initKBModal() {
    kbModalEl = document.querySelector('#kbModal');

    document.querySelector('#btnKB').addEventListener('click', openKBModal);
    document.querySelector('#btnCloseKB').addEventListener('click', closeKBModal);
    kbModalEl.addEventListener('click', (e) => {
        if (e.target === kbModalEl) closeKBModal();
    });

    // 新建集合
    document.querySelector('#btnNewCollection').addEventListener('click', createCollection);

    // 上传文档
    document.querySelector('#btnUploadDoc').addEventListener('click', () => {
        if (!currentColId) {
            showToast('请先选择一个知识库集合', 'warning');
            return;
        }
        document.querySelector('#kbFileInput').click();
    });
    document.querySelector('#kbFileInput').addEventListener('change', handleDocUpload);

    // RAG 开关
    document.querySelector('#toggleRAG').addEventListener('change', (e) => {
        ragEnabled = e.target.checked;
        if (ragEnabled && currentColId) {
            ragCollectionId = currentColId;
            showToast('RAG 知识检索已开启', 'success');
        } else if (ragEnabled && !currentColId) {
            e.target.checked = false;
            ragEnabled = false;
            showToast('请先选择一个知识库集合', 'warning');
            return;
        } else {
            ragCollectionId = null;
            showToast('RAG 知识检索已关闭', 'info');
        }
        updateRagBadge();
    });

    // 嵌入模型变更
    document.querySelector('#selectEmbedModel').addEventListener('change', async (e) => {
        if (!currentColId) return;
        const vs = getVectorStore();
        const col = await vs.getCollection(currentColId);
        if (col) {
            col.embeddingModel = e.target.value;
            await vs.updateCollection(col);
        }
    });
}

// ── RAG 接口 ──

export function isRagEnabled() {
    return ragEnabled && !!ragCollectionId;
}

export function getRagCollectionId() {
    return ragCollectionId;
}

export async function performRagRetrieval(query) {
    if (!isRagEnabled()) return null;
    try {
        const { context, results } = await retrieveContext(query, ragCollectionId, 5);
        if (!context) return null;
        return { context, results, ragPrompt: buildRagSystemPrompt(context) };
    } catch (err) {
        console.warn('[KB] RAG 检索失败:', err);
        return null;
    }
}

// ── UI ──

function updateRagBadge() {
    const badge = document.querySelector('#badgeRAG');
    if (!badge) return;
    badge.style.display = ragEnabled ? '' : 'none';
}

async function openKBModal() {
    kbModalEl.style.display = '';
    await refreshCollections();
    await populateEmbedModels();
}

function closeKBModal() {
    kbModalEl.style.display = 'none';
}

/**
 * 刷新集合列表
 */
async function refreshCollections() {
    const vs = await initVectorStore();
    const collections = await vs.getCollections();
    const listEl = document.querySelector('#kbCollectionList');

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

    // 点击选中集合
    listEl.querySelectorAll('.kb-collection-item').forEach(el => {
        el.addEventListener('click', async (e) => {
            if (e.target.closest('.kb-col-delete')) return;
            currentColId = el.dataset.id;
            await refreshCollections();
            await refreshDocList();
            // 设置嵌入模型下拉
            const vs = getVectorStore();
            const col = await vs.getCollection(currentColId);
            if (col?.embeddingModel) {
                document.querySelector('#selectEmbedModel').value = col.embeddingModel;
            }
        });
    });

    // 删除集合
    listEl.querySelectorAll('.kb-col-delete').forEach(btn => {
        btn.addEventListener('click', async (e) => {
            e.stopPropagation();
            const id = btn.dataset.id;
            if (!confirm('确定删除此知识库集合？所有文档将被清除。')) return;
            const vs = getVectorStore();
            await vs.deleteCollection(id);
            if (currentColId === id) currentColId = null;
            if (ragCollectionId === id) {
                ragEnabled = false;
                ragCollectionId = null;
                document.querySelector('#toggleRAG').checked = false;
                updateRagBadge();
            }
            showToast('集合已删除', 'success');
            await refreshCollections();
            await refreshDocList();
        });
    });
}

/**
 * 刷新文档列表
 */
async function refreshDocList() {
    const docListEl = document.querySelector('#kbDocList');
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
            const docId = btn.dataset.docid;
            if (!confirm('确定删除此文档？')) return;
            await removeDocumentFromKB(currentColId, docId);
            showToast('文档已删除', 'success');
            await refreshCollections();
            await refreshDocList();
        });
    });
}

/**
 * 创建新集合
 */
async function createCollection() {
    const nameInput = document.querySelector('#inputKBName');
    const name = nameInput.value.trim();
    if (!name) {
        showToast('请输入知识库名称', 'warning');
        return;
    }
    const vs = await initVectorStore();
    const col = await vs.createCollection(name);
    currentColId = col.id;
    nameInput.value = '';
    showToast(`知识库「${name}」已创建`, 'success');
    await refreshCollections();
    await refreshDocList();
}

/**
 * 上传文档处理
 */
async function handleDocUpload(e) {
    const files = e.target.value;
    e.target.value = '';

    const embedModel = document.querySelector('#selectEmbedModel').value;
    if (!embedModel) {
        showToast('请先选择一个嵌入模型', 'warning');
        return;
    }

    const fileArr = Array.from(e.target.files || []);
    if (fileArr.length === 0) return;

    const progressEl = document.querySelector('#kbProgress');
    const progressTextEl = document.querySelector('#kbProgressText');

    for (const file of fileArr) {
        if (file.size > 5 * 1024 * 1024) {
            showToast(`${file.name} 超过 5MB 限制`, 'warning');
            continue;
        }

        try {
            progressEl.style.display = '';
            progressTextEl.textContent = `正在处理 ${file.name}...`;

            const content = await fileToText(file);
            await addDocumentToKB(
                currentColId, file.name, content, embedModel,
                (done, total, msg) => {
                    progressTextEl.textContent = `${file.name}: ${msg} (${done}/${total})`;
                }
            );

            showToast(`${file.name} 已添加到知识库`, 'success');
        } catch (err) {
            console.error('[KB] 文档处理失败:', err);
            showToast(`${file.name} 处理失败: ${err.message}`, 'error');
        }
    }

    progressEl.style.display = 'none';
    await refreshCollections();
    await refreshDocList();
}

/**
 * 填充嵌入模型下拉
 */
async function populateEmbedModels() {
    const select = document.querySelector('#selectEmbedModel');
    const api = state.get(KEYS.API);
    if (!api) return;

    try {
        const data = await api.listModels();
        select.innerHTML = '<option value="">选择嵌入模型...</option>';
        if (data.models) {
            // 推荐的嵌入模型优先显示
            const embedKeywords = ['embed', 'nomic', 'mxbai', 'bge', 'e5', 'snowflake'];
            const recommended = [];
            const others = [];

            for (const m of data.models) {
                const name = m.name.toLowerCase();
                if (embedKeywords.some(kw => name.includes(kw))) {
                    recommended.push(m);
                } else {
                    others.push(m);
                }
            }

            if (recommended.length > 0) {
                const optgroup = document.createElement('optgroup');
                optgroup.label = '推荐（嵌入模型）';
                recommended.forEach(m => {
                    const opt = document.createElement('option');
                    opt.value = m.name;
                    opt.textContent = m.name;
                    optgroup.appendChild(opt);
                });
                select.appendChild(optgroup);
            }

            const optgroup2 = document.createElement('optgroup');
            optgroup2.label = '其他模型';
            others.forEach(m => {
                const opt = document.createElement('option');
                opt.value = m.name;
                opt.textContent = m.name;
                optgroup2.appendChild(opt);
            });
            select.appendChild(optgroup2);
        }
    } catch (err) {
        console.warn('[KB] 加载模型列表失败:', err);
    }
}
