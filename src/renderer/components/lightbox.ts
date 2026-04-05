/**
 * Lightbox - 图片预览组件
 */

let lightboxEl: HTMLElement, lightboxImg: HTMLImageElement;

export function initLightbox(): void {
  lightboxEl = document.querySelector('#lightbox')!;
  lightboxImg = document.querySelector('#lightboxImg')!;

  lightboxEl.addEventListener('click', (e) => {
    if (e.target === lightboxEl) closeLightbox();
  });
  document.querySelector('#lightboxClose')!.addEventListener('click', closeLightbox);

  document.querySelector('#messagesContainer')?.addEventListener('click', (e) => {
    const target = e.target as HTMLElement;
    if ((target as HTMLImageElement).dataset.lightbox === 'true') {
      openLightbox((target as HTMLImageElement).src);
    }
  });
}

export function openLightbox(src: string): void {
  lightboxImg.src = src;
  lightboxEl.style.display = '';
}

export function closeLightbox(): void {
  lightboxEl.style.display = 'none';
  lightboxImg.src = '';
}
