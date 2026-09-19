/**
 * 검수 사진 압축 (docs/processing.md §17-3 · A21).
 *
 * 촬영 **직후** 한 번만 압축한다. 원본(3~8MB)을 메모리에 들고 있으면 구성품이 10줄인
 * 작업에서 폰이 죽는다. 압축 결과만 화면 · 초안(IndexedDB) · 업로드가 함께 쓴다.
 *
 * 이 모듈은 저장하지도 올리지도 않는다 - 입력(File)만 보고 Blob 을 돌려준다.
 */

/** 압축 기준값 - 바뀌면 Storage 버킷의 file_size_limit 도 함께 본다 */
export const PHOTO = {
    maxEdge: 1280,              // 긴 변
    quality: 0.7,               // JPEG 첫 시도
    targetBytes: 200 * 1024,    // 목표 크기
    maxBytes: 1024 * 1024,      // 상한 (db 가 거부하는 크기 · 버킷 제한과 같다)
    /** 목표를 못 맞추면 순서대로 낮춘다 */
    steps: [
        { edge: 1280, q: 0.7 },
        { edge: 1280, q: 0.55 },
        { edge: 1024, q: 0.55 },
        { edge: 1024, q: 0.45 },
        { edge: 800, q: 0.45 },
    ],
};

/** 사진을 못 읽었을 때의 안내 - 화면·db 가 같은 말을 쓴다 */
export const PHOTO_READ_ERROR = '사진을 읽지 못했습니다. 다시 촬영해 주세요.';

/**
 * 긴 변을 `edge` 로 맞춘 크기 (순수 함수 · 늘리지는 않는다).
 * @returns {{width:number, height:number}} 1 이상 정수
 */
export function fitSize(width, height, edge) {
    const w = Math.max(1, Math.round(Number(width) || 0));
    const h = Math.max(1, Math.round(Number(height) || 0));
    const max = Math.max(1, Math.round(Number(edge) || 0));
    const long = Math.max(w, h);
    if (long <= max) return { width: w, height: h };
    const k = max / long;
    return { width: Math.max(1, Math.round(w * k)), height: Math.max(1, Math.round(h * k)) };
}

/**
 * 파일을 그릴 수 있는 이미지로 연다.
 * 🔑 `imageOrientation: 'from-image'` 로 **EXIF 회전을 먼저 편다** - 안 펴면 세로로 찍은
 * 사진이 웹 상세에서 눕는다. `createImageBitmap` 이 없는(또는 HEIC 를 못 여는) 기기는
 * `<img>` 로 한 번 더 시도하고, 그래도 안 되면 다시 촬영하도록 안내한다.
 */
async function decode(file) {
    if (typeof createImageBitmap === 'function') {
        try {
            return await createImageBitmap(file, { imageOrientation: 'from-image' });
        } catch (err) {
            console.warn('createImageBitmap 실패, img 로 다시 시도합니다.', err);
        }
    }
    const url = URL.createObjectURL(file);
    try {
        return await new Promise((resolve, reject) => {
            const img = new Image();
            img.onload = () => resolve(img);
            img.onerror = () => reject(new Error(PHOTO_READ_ERROR));
            img.src = url;
        });
    } finally {
        URL.revokeObjectURL(url);
    }
}

/** 캔버스를 JPEG Blob 으로 (toBlob 은 콜백이라 감싼다) */
function toJpeg(canvas, quality) {
    return new Promise((resolve, reject) => {
        canvas.toBlob(
            (blob) => (blob ? resolve(blob) : reject(new Error(PHOTO_READ_ERROR))),
            'image/jpeg',
            quality,
        );
    });
}

/**
 * File → 압축 JPEG Blob.
 *
 * 목표(200KB)를 맞출 때까지 `PHOTO.steps` 를 순서대로 내려가고, 마지막 단계에서도 못 맞추면
 * **그중 가장 작은 결과를 그대로 쓴다.** 거부하면 같은 자리를 다시 찍어도 결과가 같아
 * 현장이 빠져나갈 길이 없기 때문이다 (1MB 초과만 db 가 막는다).
 *
 * @param {File|Blob} file 촬영 원본
 * @param {{targetBytes?:number, steps?:Array<{edge:number,q:number}>}} [opt]
 * @returns {Promise<{blob:Blob, width:number, height:number, size:number}>}
 */
export async function compressPhoto(file, opt = {}) {
    if (!file || !file.size) throw new Error(PHOTO_READ_ERROR);
    const target = opt.targetBytes ?? PHOTO.targetBytes;
    const steps = opt.steps ?? PHOTO.steps;

    const img = await decode(file);
    const srcW = img.width ?? img.naturalWidth;
    const srcH = img.height ?? img.naturalHeight;
    if (!srcW || !srcH) throw new Error(PHOTO_READ_ERROR);

    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    let best = null;

    // 🔑 중간에 실패해도 ImageBitmap·캔버스를 반드시 놓는다. 구성품 10줄을 연달아 찍는
    // 화면이라 한 장이라도 새면 폰이 금방 죽는다
    try {
        for (const step of steps) {
            const { width, height } = fitSize(srcW, srcH, step.edge);
            canvas.width = width;
            canvas.height = height;
            ctx.drawImage(img, 0, 0, width, height);
            // 단계는 앞 결과를 보고 내려간다
            const blob = await toJpeg(canvas, step.q);
            if (!best || blob.size < best.blob.size) best = { blob, width, height };
            if (blob.size <= target) break;
        }
    } finally {
        img.close?.();
        canvas.width = 0;
        canvas.height = 0;
    }

    if (!best) throw new Error(PHOTO_READ_ERROR);
    return { ...best, size: best.blob.size };
}
