/**
 * Lightbox - 图片预览组件
 */

let lightboxEl, lightboxImg;

export function initLightbox() {
    lightboxEl = document.querySelector('#lightbox');
    lightboxImg = document.querySelector('#lightboxImg');

    // 关闭事件
    lightboxEl.addEventListener('click', (e) => {
        if (e.target === lightboxEl) closeLightbox();
    });
    document.querySelector('#lightboxClose').addEventListener('click', closeLightbox);

    // 消息区域点击图片打开预览
    document.querySelector('#messagesContainer')?.addEventListener('click', (e) => {
        if (e.target.dataset.lightbox === 'true') {
            openLightbox(e.target.src);
        }
    });
}

export function openLightbox(src) {
    lightboxImg.src = src;
    lightboxEl.style.display = '';
}

export function closeLightbox() {
    lightboxEl.style.display = 'none';
    lightboxImg.src = '';
}
