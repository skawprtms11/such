/**
 * 바코드 스캔 공통 모듈.
 *
 * 인식 방식은 두 가지다.
 *   1. 브라우저 내장 BarcodeDetector (안드로이드 크롬, 데스크톱 크롬/엣지) - 가볍고 빠르다
 *   2. ZXing 디코더 (iOS 사파리·크롬, 파이어폭스) - 내장 기능이 없을 때만 내려받는다
 *
 * iOS 는 모든 브라우저가 WebKit 을 쓰므로 크롬을 써도 BarcodeDetector 가 없다.
 * 그래서 2번 경로가 반드시 필요하다.
 *
 * 카메라 API 자체는 HTTPS 또는 localhost 에서만 동작한다.
 */

const FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code', 'codabar', 'itf'];

/** 내장 BarcodeDetector 를 쓸 수 있는지 */
export function hasNativeDetector() {
    return 'BarcodeDetector' in window;
}

/** 이 브라우저에서 카메라 스캔이 가능한지 (ZXing 대체 경로 포함) */
export function scanSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
}

/**
 * 프레임에서 바코드를 읽는 인식기를 만든다.
 * 내장 기능이 있으면 그것을, 없으면 ZXing 을 동적으로 내려받아 쓴다.
 * @returns {Promise<(video:HTMLVideoElement) => Promise<string|null>>}
 */
async function createReader() {
    if (hasNativeDetector()) {
        const detector = new window.BarcodeDetector({ formats: FORMATS });
        return async (video) => {
            const found = await detector.detect(video);
            return found[0]?.rawValue ?? null;
        };
    }

    // 내장 기능이 없는 브라우저(iOS 등)에서만 디코더를 내려받는다
    const { BrowserMultiFormatReader } = await import('@zxing/browser');
    const zxing = new BrowserMultiFormatReader();
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    return async (video) => {
        if (!video.videoWidth) return null;
        canvas.width = video.videoWidth;
        canvas.height = video.videoHeight;
        ctx.drawImage(video, 0, 0);
        try {
            return zxing.decodeFromCanvas(canvas)?.getText() ?? null;
        } catch {
            return null;   // 프레임에서 못 찾은 경우 (정상)
        }
    };
}

/**
 * 스캐너를 만든다.
 * @param {HTMLVideoElement} video 미리보기 엘리먼트
 * @param {(code:string) => void} onCode 코드 인식 콜백
 * @returns {{start:Function, stop:Function, isOn:Function}}
 */
export function createScanner(video, onCode) {
    let stream = null;
    let timer = null;
    let last = '';
    let lastAt = 0;

    function stop() {
        if (timer) clearInterval(timer);
        timer = null;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        video.hidden = true;
    }

    async function start() {
        if (!scanSupported()) throw new Error('이 브라우저는 카메라를 지원하지 않습니다.');
        const read = await createReader();
        try {
            stream = await navigator.mediaDevices.getUserMedia({
                video: { facingMode: { ideal: 'environment' } },
            });
        } catch (err) {
            throw new Error(`카메라를 사용할 수 없습니다: ${err.name}`);
        }
        video.srcObject = stream;
        video.hidden = false;
        await video.play();

        timer = setInterval(async () => {
            try {
                const code = await read(video);
                if (!code) return;
                const now = performance.now();
                // 같은 코드가 연속 인식되는 것을 막는다
                if (code === last && now - lastAt < 2500) return;
                last = code;
                lastAt = now;
                if (navigator.vibrate) navigator.vibrate(60);
                onCode(code);
            } catch (err) {
                console.warn('바코드 인식 실패', err);
            }
        }, 400);
    }

    return { start, stop, isOn: () => Boolean(stream) };
}
