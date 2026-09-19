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
 * 🔑 **1번은 「있다」가 아니라 「동작한다」를 확인하고 쓴다.** 안드로이드 크롬은 Google Play
 * 바코드 모듈이 없으면 인식기 **생성은 성공하는데** `detect()` 가 매번 던지거나 늘 빈 배열을
 * 준다 (현장에서 「우리 앱만 안 읽힌다」 로 나타났다). 그래서 폴백이 셋이다.
 *   ① 시작 자가 진단 - 우리가 그린 Code128 한 장을 먹여 본다 (`selfTest`)
 *   ② 런타임 - `detect()` 가 던지면 그 자리에서 ZXing 으로 갈아탄다 (`swapEngine`)
 *   ③ 그림자 디코딩 - 한참 못 잡으면 같은 프레임을 ZXing 으로도 본다 (`shadowDue`)
 * ⚠️ **다음 실행까지 기억하는 것은 ②③ 런타임 전환뿐이다**
 * (`localStorage.tpl_scan_engine='zxing'` · 지우는 곳은 앱 계정 화면의 `스캔 엔진 재검사`).
 * ①자가 진단 실패는 **이번 페이지 동안만** 유효하다 - 진단이 잘못 실패하면 그 기억이
 * 배포를 넘어 살아남아, 고친 뒤에도 멀쩡한 기기가 버튼을 누르기 전까지 ZXing 을 쓴다.
 *
 * 카메라 API 자체는 HTTPS 또는 localhost 에서만 동작한다.
 *
 * 🔑 인식률에 관계된 값은 전부 아래 `TUNE` 한 곳에 모아 두었다.
 * 현장에서 잘 안 읽히면 이 상수만 조정하거나 되돌리면 된다.
 * "어디를 · 얼마나 · 언제" 를 정하는 계산은 `scan-calc.js` 의 순수 함수가 하고
 * (브라우저 없이 `npm run check:scan` 으로 검사한다), 이 파일은 카메라와 프레임만 다룬다.
 */
import {
    AIM_ROI, aimRect, clampZoom, nextCost, nextGap, nextOverrun, reArmGap,
    roiPlan, shadowDue, shouldDowngrade, stepBudget, zoomSteps,
} from './scan-calc.js';

/** 인식률 조정값 - 바꿀 일이 있으면 여기만 본다 */
export const TUNE = {
    /**
     * 내장 인식기용 요청 해상도. 가는 바가 뭉개지지 않도록 기본값(대개 640×480)보다 높게 잡는다.
     * 🔑 인식은 **가장 가는 바가 이미지에서 몇 픽셀인가**로 거의 결정된다(경험칙 2px 이상).
     * 작은 라벨을 살리는 유일한 수단이 해상도라 내장 경로는 2560×1440 까지 올린다.
     */
    nativeSize: { width: 2560, height: 1440 },
    /** ZXing 용 요청 해상도. 디코딩을 CPU 로 하지만 ROI 로 잘라 넘기므로 실제 픽셀은 더 적다 */
    zxingSize: { width: 1920, height: 1080 },
    /** 프레임 예산을 연속으로 넘길 때 낮출 해상도 (한 번 낮추면 되돌리지 않는다) */
    downSize: { width: 1280, height: 720 },
    /**
     * 한 프레임에서 시도할 ROI (가로, 세로 비율) - 순서대로 보고 **첫 성공에 멈춘다**.
     * ⚠️ `kind` 가 없으면 1D 다. 1D 의 가로는 0.72 아래로 자르지 않는다 - Code128 은 좌우
     * 여백(quiet zone)이 잘리면 디코딩이 실패한다. 줄이려면 세로를 줄인다.
     * 🔑 `kind: '2d'` 는 **QR 전용 정사각 ROI** 다 (하이브리드 라벨). 가로 하한을 받지 않아
     * 화면 가운데만 잘라 볼 수 있고, 그만큼 주변 글자·다른 라벨이 빠진다.
     */
    roiNative: [
        { w: 1, h: 1 }, { w: 1, h: 0.45 },
        { w: 0.6, h: 0.6, kind: '2d' }, { w: 0.8, h: 0.6 },
    ],
    roiZxing: [
        { w: 1, h: 0.45 }, { w: 1, h: 0.22 },
        { w: 0.6, h: 0.6, kind: '2d' }, { w: 0.8, h: 0.6 }, { w: 1, h: 1 },
    ],
    /** 내장 인식기 경로의 프레임당 디코딩 예산(ms) - 8fps 이상을 지킨다 */
    budgetNativeMs: 120,
    /** ZXing 경로의 프레임당 디코딩 예산(ms) - iOS 는 1회가 100~400ms 다 */
    budgetZxingMs: 260,
    /** 줌 버튼 배율 - 기기가 주는 `caps.zoom.max` 로 잘라낸다. 없는 기기는 버튼이 숨는다 */
    zoomSteps: [1, 2, 3],
    /** 줌을 바꾼 뒤 초점이 안정될 때까지 기다리는 시간(ms) */
    zoomSettleMs: 300,
    /** 연속 미검출이 이만큼 쌓이면 ROI 순서를 돌리고 ZXing 에 전처리를 붙인다 */
    preMissN: 3,
    /** 같은 값을 몇 프레임 연속 봐야 받아들이는지 - 오인식 신고가 오면 2로 올린다 */
    consensus: 1,
    /** 프레임 처리 사이 최소 간격(ms) - 바코드를 찾고 있는 동안. 발열이 심하면 올린다 */
    minGapMs: 60,
    /** 아무것도 안 잡힌 채 시간이 흐를 때의 간격(ms) - 발열·배터리를 아낀다 */
    idleGapMs: 180,
    /** 마지막 인식 뒤 이만큼 지나면 유휴로 보고 간격을 늘린다(ms) */
    idleAfterMs: 2000,
    /** 같은 코드가 계속 보일 때 다시 받지 않는 시간(ms) */
    repeatMs: 2500,
    /**
     * 같은 코드를 다음 1건으로 받기 위해 **비어 있어야 하는 시간**(ms).
     * 상차검수에서 라벨을 든 채 디코딩이 몇 번 실패한 것을 "치웠다 다시 댐" 으로
     * 오해하면 한 파렛트가 2건으로 세어진다 - 실사용 간격(1초 이상)보다 짧게 두지 않는다.
     */
    reArmMs: 1500,
    /**
     * 위 시간을 **디코딩 1회 소요시간의 몇 배**로도 함께 요구한다.
     * 느린 기기(iOS·ZXing 은 1회 100~400ms)에서는 이 쪽이 커져 자동으로 더 엄격해진다.
     */
    reArmFrames: 5,
    /**
     * 디코딩 1회 소요시간으로 인정하는 상한(ms).
     * 기기가 잠깐 느려진 것이 평균을 끌어올려 문턱이 과하게 길어지는 것을 막는다.
     */
    costCapMs: 500,
    /** 첫 프레임을 기다리는 한도(ms) */
    readyMs: 3000,
    /** 프레임 콜백이 오지 않을 때 그래도 한 번 읽어 보는 간격(ms) */
    stallMs: 500,
    /**
     * 시작할 때 내장 인식기에 먹여 보는 자가 진단 문자열 🔑
     * 이 값의 Code128 을 캔버스에 그려 `detect()` 를 한 번 돌린다. 못 읽으면 내장을 버린다
     * (인식기 **생성은 성공하는데** 동작하지 않는 기기가 있다 - 아래 `selfTest` 참고).
     */
    selfTestText: 'SELFTEST-128',
    /** 내장 인식기가 이만큼(ms) 아무것도 못 잡으면 같은 프레임을 ZXing 으로도 본다 */
    shadowAfterMs: 4000,
    /** 그림자 디코딩 주기 - 미검출 이 횟수마다 한 번 (매 프레임 두 번 디코딩하면 뜨겁다) */
    shadowEveryN: 6,
    /** ZXing 만 읽은 일이 이만큼 쌓이면 내장을 버리고 ZXing 으로 갈아탄다 */
    shadowSwitchHits: 2,
};

const FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code', 'codabar', 'itf'];
/**
 * 현장에서 실제로 쓰는 포맷 - 1순위 패스는 이 둘만 본다 (빠르고 오인식이 적다).
 * 🔑 우리 라벨은 **하이브리드**다 - 같은 번호를 QR 과 Code128 로 나란히 찍는다.
 * 휴대폰 카메라는 QR 쪽이 훨씬 잘 붙으므로 **QR 을 앞에** 둔다.
 */
const MAIN_FORMATS = ['qr_code', 'code_128'];

/** 내장 BarcodeDetector 를 쓸 수 있는지 */
export function hasNativeDetector() {
    return 'BarcodeDetector' in window;
}

/** 이 브라우저에서 카메라 스캔이 가능한지 (ZXing 대체 경로 포함) */
export function scanSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
}

/* ------------------------------ 엔진 기억 (localStorage) ------------------------------ */

/**
 * 내장 인식기를 못 쓰는 기기로 판명되면 기억해 둔다 🔑
 * 자가 진단·런타임 전환이 한 번 일어난 기기는 다음 실행부터 진단 없이 ZXing 으로 간다.
 * 지우는 곳은 **계정 화면의 `스캔 엔진 재검사` 하나뿐**이다.
 */
const ENGINE_KEY = 'tpl_scan_engine';

/** 자가 진단용 이미지를 기다리는 한도(ms) - 여기서 막히면 카메라 시작이 늦어진다 */
const SELFTEST_WAIT_MS = 1000;

function rememberZxing() {
    try {
        localStorage.setItem(ENGINE_KEY, 'zxing');
    } catch (err) {
        console.warn('스캔 엔진 기억을 저장하지 못했습니다.', err);
    }
}

/**
 * 이번 **페이지**에서 내장 인식기가 자가 진단에 떨어졌는지 🔑
 * `localStorage` 와 달리 새로고침하면 사라진다 - 진단은 카메라가 아니라 캔버스로 하는
 * 간접 확인이라 오판 여지가 있고, 그 오판이 영구가 되면 배포로도 못 고친다.
 * 영구 기억은 실제 카메라 프레임에서 실패한 런타임 전환(`swapEngine`)에만 남긴다.
 */
let nativeBroken = false;

/** 이 기기에서 내장 인식기를 건너뛰기로 기억해 두었는지 */
export function zxingRemembered() {
    try {
        return localStorage.getItem(ENGINE_KEY) === 'zxing';
    } catch (err) {
        console.warn('스캔 엔진 기억을 읽지 못했습니다.', err);
        return false;      // 기억이 없을 뿐이다 - 자가 진단부터 다시 한다
    }
}

/** 기억을 지운다 (계정 화면) - 다음 스캔에서 내장 인식기를 다시 진단한다 */
export function resetScanEngine() {
    nativeBroken = false;
    try {
        localStorage.removeItem(ENGINE_KEY);
    } catch (err) {
        console.warn('스캔 엔진 기억을 지우지 못했습니다.', err);
    }
}

/** 이번 실행에서 내장 인식기를 시도할지 (기능이 있고 + 못 쓴다고 기억하지 않았다) */
function useNative() {
    return hasNativeDetector() && !nativeBroken && !zxingRemembered();
}

/* -------------------------------- 인식기 만들기 -------------------------------- */

/**
 * 한 프레임에 여러 바코드가 잡히면 **조준선(가운데)에 가장 가까운 것**을 고른다.
 * (라벨 여러 장이 한 화면에 들어오면 엉뚱한 것이 읽히는 일을 막는다)
 * @param {Array} found 검출 결과
 * @param {HTMLVideoElement|HTMLCanvasElement} img 넘긴 이미지 (좌표 기준)
 */
function pickCenter(found, img) {
    if (!found?.length) return null;
    if (found.length === 1) return found[0].rawValue || null;
    const cx = (img.videoWidth ?? img.width) / 2;
    const cy = (img.videoHeight ?? img.height) / 2;
    const dist = (b) => {
        const r = b.boundingBox;
        if (!r) return Number.MAX_SAFE_INTEGER;
        return Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
    };
    return [...found].sort((a, b) => dist(a) - dist(b))[0].rawValue || null;
}

/** SVG 문자열을 이미지로 만든다 (캔버스에 그리려면 한 번 디코딩해야 한다) */
function svgImage(svg) {
    return new Promise((resolve, reject) => {
        const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml' }));
        const img = new Image();
        const end = (fn, arg) => {
            clearTimeout(timer);
            URL.revokeObjectURL(url);
            fn(arg);
        };
        const timer = setTimeout(
            () => end(reject, new Error('자가 진단 이미지 시간 초과')), SELFTEST_WAIT_MS);
        img.onload = () => end(resolve, img);
        img.onerror = () => end(reject, new Error('자가 진단 이미지를 그리지 못했습니다'));
        img.src = url;
    });
}

/** 자가 진단용 캔버스 - 우리 바코드 생성기로 그린 Code128 한 장 (흰 배경 · 여백 넉넉히) */
async function selfTestCanvas() {
    // 🔑 지연 로드 - 내장 인식기가 있는 기기에서만, 그것도 시작 시 한 번만 쓴다
    const { code128Svg } = await import('./barcode.js');
    const img = await svgImage(code128Svg(TUNE.selfTestText, { moduleWidth: 4, height: 80 }));
    const pad = 60;                        // 좌우 여백(quiet zone)을 넉넉히 둔다
    const canvas = document.createElement('canvas');
    canvas.width = img.width + pad * 2;
    canvas.height = img.height + pad;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(img, pad, pad / 2);
    return canvas;
}

/**
 * 내장 인식기 자가 진단 🔑
 *
 * **만들 수 있다 ≠ 동작한다.** 안드로이드 크롬은 Google Play 의 바코드 모듈이 없으면
 * `new BarcodeDetector()` 는 성공하는데 `detect()` 가 매번 던지거나
 * (`NotSupportedError: Barcode detection service unavailable`) **늘 빈 배열**을 준다.
 * 그 상태로는 아무리 비춰도 읽히지 않으므로, 시작할 때 **우리가 그린 바코드 한 장**을
 * 먹여 보고 못 읽으면 내장을 버린다.
 *
 * ⚠️ 진단 **자체가 실패한 것**(이미지를 못 그림)으로는 폴백을 걸지 않는다.
 * 그림에 실패한 것과 인식기 고장은 다르고, 여기서 잘못 버리면 멀쩡한 기기가
 * 470KB 를 내려받게 된다.
 *
 * @param {object} detector 만들어 둔 BarcodeDetector
 * @param {Function} [canceled] 세대 토큰 - 기다리는 사이 화면을 떠났는지
 * @returns {Promise<boolean|null>} true=쓸 수 있다 · false=못 쓴다 · null=진단을 못 했다
 */
async function selfTest(detector, canceled) {
    let canvas = null;
    try {
        canvas = await selfTestCanvas();
    } catch (err) {
        console.warn('내장 인식기 자가 진단용 이미지를 만들지 못해 진단을 건너뜁니다.', err);
        return null;
    }
    if (canceled?.()) return null;
    try {
        const found = await detector.detect(canvas);
        if (canceled?.()) return null;
        if (found?.some((b) => b.rawValue === TUNE.selfTestText)) return true;
        console.warn('내장 바코드 인식기가 자가 진단 바코드를 읽지 못했습니다 (빈 결과).');
        return false;
    } catch (err) {
        console.warn('내장 바코드 인식기가 자가 진단에서 예외를 던졌습니다.', err);
        return false;
    }
}

/**
 * 내장 BarcodeDetector 인식기.
 * 🔑 디코더를 **둘** 만든다 - 1순위는 QR + CODE_128 전용(포맷을 줄이면 후보 탐색이 줄어 빠르다),
 * 2순위부터 전 포맷. 상차라벨·작업지시서가 이 둘을 함께 찍으므로 1순위에서 거의 끝난다.
 * @param {Function} [canceled] 세대 토큰 (자가 진단 중 이탈을 확인한다)
 * @returns {Promise<{native:boolean, decode:Function}|null>} 지원하지 않으면 null
 */
async function nativeReader(canceled) {
    if (!useNative()) return null;
    let one = null;
    let wide = null;
    try {
        const supported = await window.BarcodeDetector.getSupportedFormats?.() ?? FORMATS;
        const all = FORMATS.filter((f) => supported.includes(f));
        if (!all.length) return null;
        const main = MAIN_FORMATS.filter((f) => all.includes(f));
        const narrow = main.length ? main : all;
        one = new window.BarcodeDetector({ formats: narrow });
        wide = narrow.length === all.length
            ? one
            : new window.BarcodeDetector({ formats: all });
    } catch (err) {
        // 기기가 이 포맷 조합을 못 만드는 경우 - ZXing 으로 넘긴다
        console.warn('내장 바코드 인식기를 쓸 수 없어 ZXing 으로 전환합니다.', err);
        return null;
    }

    // 🔑 여기부터가 자가 진단이다 - 만들어 놓고 동작하지 않는 기기를 걸러낸다
    const ok = await selfTest(one, canceled);
    if (ok === false) {
        nativeBroken = true;      // 이번 페이지만 - 위 `nativeBroken` 주석 참고
        return null;
    }
    return {
        native: true,
        /**
         * 자가 진단을 **끝냈는지** 🔑 기다리는 사이 화면을 떠나 건너뛴 경우만 false 다.
         * 그대로 캐시하면 검증되지 않은 내장 인식기가 자리 잡아 **다시는 진단하지 않는다**
         * (`start()` 가 이 값을 보고 다시 만든다). 이미지를 못 그려 건너뛴 경우는 다시
         * 해도 같은 결과이므로 검증된 것으로 본다.
         */
        tested: ok === true || !canceled?.(),
        async decode(img, useWide) {
            return pickCenter(await (useWide ? wide : one).detect(img), img);
        },
    };
}

/**
 * ZXing 인식기 (내장 기능이 없는 기기 전용).
 * 내장 경로와 같이 **1순위는 QR + CODE_128 전용**, 2순위부터 전 포맷을 본다.
 * `TRY_HARDER` 는 양쪽 모두 켠다 - 후보 포맷이 하나뿐인 1순위에서는 비용이 크지 않고,
 * 라벨이 기울어졌을 때 이 힌트가 있어야 붙는다.
 */
async function zxingReader() {
    const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
    ]);

    const hint = (formats) => new Map([
        [DecodeHintType.POSSIBLE_FORMATS, formats],
        [DecodeHintType.TRY_HARDER, true],
    ]);
    const one = new BrowserMultiFormatReader(hint([
        BarcodeFormat.QR_CODE,
        BarcodeFormat.CODE_128,
    ]));
    const wide = new BrowserMultiFormatReader(hint([
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
        BarcodeFormat.CODABAR,
        BarcodeFormat.EAN_13,
        BarcodeFormat.QR_CODE,
    ]));

    return {
        native: false,
        async decode(canvas, useWide) {
            try {
                return (useWide ? wide : one).decodeFromCanvas(canvas)?.getText() ?? null;
            } catch {
                return null;   // 프레임에서 못 찾은 경우 (정상)
            }
        },
    };
}

/**
 * 프레임에서 바코드를 읽는 인식기를 만든다.
 * @param {Function} [canceled] 세대 토큰 (자가 진단 중 이탈을 확인한다)
 * @returns {Promise<{native:boolean, decode:Function}>}
 */
async function createReader(canceled) {
    return await nativeReader(canceled) ?? zxingReader();
}

/* ------------------------------ 프레임 공급 (frameSource) ------------------------------ */

/**
 * 프레임 캔버스 - ROI 를 잘라 담고, 필요하면 전처리한다.
 * `willReadFrequently` 를 켜야 `getImageData`(전처리)가 GPU↔CPU 왕복으로 느려지지 않는다.
 */
function frameCanvas() {
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    return {
        /** 프레임 가운데의 ROI 만 캔버스로 옮긴다 */
        crop(video, roi) {
            const vw = video.videoWidth;
            const vh = video.videoHeight;
            const w = Math.max(1, Math.round(vw * roi.w));
            const h = Math.max(1, Math.round(vh * roi.h));
            if (canvas.width !== w || canvas.height !== h) {
                canvas.width = w;
                canvas.height = h;
            }
            ctx.drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, w, h);
            return canvas;
        },
        /**
         * 그레이 + 대비 스트레치 - 저조도·인쇄 흐림에서 가는 바를 살린다.
         * 🔑 **미검출이 쌓였을 때만** 부른다. 잘 읽히는 프레임에 붙이면 비용만 늘고,
         * 과대비는 오히려 가는 바를 지운다.
         */
        stretch() {
            if (!canvas.width || !canvas.height) return;
            const img = ctx.getImageData(0, 0, canvas.width, canvas.height);
            const d = img.data;
            let lo = 255;
            let hi = 0;
            for (let i = 0; i < d.length; i += 4) {
                const g = (d[i] * 77 + d[i + 1] * 151 + d[i + 2] * 28) >> 8;
                d[i] = g;
                if (g < lo) lo = g;
                if (g > hi) hi = g;
            }
            if (hi - lo < 8) return;   // 거의 평평한 화면 - 늘리면 잡음만 커진다
            const k = 255 / (hi - lo);
            for (let i = 0; i < d.length; i += 4) {
                const v = Math.min(255, Math.max(0, Math.round((d[i] - lo) * k)));
                d[i] = v;
                d[i + 1] = v;
                d[i + 2] = v;
            }
            ctx.putImageData(img, 0, 0);
        },
        /**
         * 뒷면 버퍼를 놓는다 (`stop()` 전용).
         * 2560×1440 한 장이 RGBA 로 14MB 라, 화면을 떠난 뒤에도 들고 있으면
         * 폰에서 다른 화면이 메모리 때문에 느려진다.
         */
        release() {
            canvas.width = 0;
            canvas.height = 0;
        },
    };
}

/**
 * 프레임 공급 - 새 프레임이 올 때 깨우는 `requestVideoFrameCallback` 을 쓰되,
 * 그 콜백이 오지 않는 상황(백그라운드·숨겨진 프리뷰)에 대비해 예비 타이머를 함께 건다.
 * 처리가 끝난 뒤에만 `next()` 를 부르므로 **호출이 겹치지 않는다.**
 * @param {HTMLVideoElement} el 프리뷰
 * @param {Function} onFrame 프레임이 준비됐을 때 할 일
 */
function frameSource(el, onFrame) {
    let timer = null;
    let req = 0;
    let turn = 0;

    function cancel() {
        if (timer) clearTimeout(timer);
        timer = null;
        if (req && el.cancelVideoFrameCallback) el.cancelVideoFrameCallback(req);
        req = 0;
    }

    function next(waitMs) {
        cancel();
        if (waitMs > 0) {
            timer = setTimeout(next, waitMs, 0);
            return;
        }
        turn += 1;
        const mine = turn;
        const run = () => {
            if (mine !== turn) return;   // 예비 타이머와 프레임 콜백 중 먼저 온 쪽만 실행한다
            turn += 1;
            cancel();
            onFrame();
        };
        if (el.requestVideoFrameCallback) {
            req = el.requestVideoFrameCallback(run);
            timer = setTimeout(run, TUNE.stallMs);
        } else {
            timer = setTimeout(run, 0);
        }
    }

    return { next, cancel };
}

/* --------------------------------- 카메라 제어 --------------------------------- */

/** getUserMedia 제약 - 해상도는 **ideal 로만** 요청한다 (못 맞추는 기기도 거절하지 않는다) */
function videoConstraints(size) {
    return {
        facingMode: { ideal: 'environment' },
        width: { ideal: size.width },
        height: { ideal: size.height },
    };
}

/** 트랙이 지원하는 기능만 골라 적용한다 (지원하지 않으면 조용히 건너뛴다) */
async function tuneTrack(track) {
    const caps = track.getCapabilities?.();
    if (!caps) return;              // iOS 사파리는 getCapabilities 가 없을 수 있다
    const advanced = [];
    if (caps.focusMode?.includes('continuous')) advanced.push({ focusMode: 'continuous' });
    if (!advanced.length) return;
    try {
        await track.applyConstraints({ advanced });
    } catch (err) {
        console.warn('카메라 세부 설정을 적용하지 못했습니다.', err);
    }
}

/** 첫 프레임이 들어올 때까지 기다린다 (크기가 0 이면 어떤 디코더도 읽지 못한다) */
function waitReady(video) {
    if (video.videoWidth) return Promise.resolve();
    return new Promise((resolve) => {
        const done = () => {
            clearTimeout(timer);
            video.removeEventListener('loadedmetadata', done);
            resolve();
        };
        const timer = setTimeout(done, TUNE.readyMs);
        video.addEventListener('loadedmetadata', done, { once: true });
    });
}

/**
 * 스캐너를 만든다.
 *
 * 반환 형태는 예전과 같다(`start` `stop` `isOn`). 나머지는 **선택적 추가**라
 * 쓰지 않는 화면은 그대로 둬도 된다.
 *
 * @param {HTMLVideoElement} video 미리보기 엘리먼트
 * @param {(code:string) => void} onCode 코드 인식 콜백
 * @returns {{start:Function, stop:Function, isOn:Function,
 *            hasTorch:Function, isTorchOn:Function, toggleTorch:Function,
 *            canZoom:Function, zoomSteps:Function, zoomValue:Function,
 *            zoomRange:Function, setZoom:Function, setZoomRaw:Function,
 *            engine:Function, onEngine:Function, aimRect:Function}}
 */
export function createScanner(video, onCode) {
    let stream = null;
    let track = null;
    let settleTimer = null;
    let settleDone = null;
    let running = false;
    let torchOn = false;
    let readerP = null;
    /** 지금 `readerP` 가 자가 진단을 끝낸 인식기인지 (아니면 다음 start() 가 다시 만든다) */
    let readerTested = true;
    let starting = false;
    let gen = 0;
    let last = '';
    let acceptedAt = 0;
    let seenAt = 0;
    let startedAt = 0;
    /** 디코딩 1회 소요시간(ms) 이동평균 - 기기 속도에 맞춰 중복 판정을 조절한다 */
    let cost = 0;
    /** 연속 미검출 횟수 - ROI 순서와 전처리 여부를 정한다 */
    let missStreak = 0;
    /** 연속 예산 초과 횟수 · 해상도를 이미 낮췄는지 */
    let overrun = 0;
    let downgraded = false;
    /** 같은 값을 연속으로 본 횟수 (TUNE.consensus 가 1 이면 사실상 꺼져 있다) */
    let agree = 0;
    let agreeCode = '';
    /** 지금 줌 배율 */
    let zoomNow = 1;
    /** 지금 쓰는 인식기 - '' | 'native' | 'zxing' (인식기를 받은 뒤에 정해진다) */
    let engine = '';
    let engineCb = null;
    /**
     * 내장 인식기가 **자기 힘으로** 마지막에 읽은 시각 - 그림자 디코딩 시점의 기준이다.
     * 🔑 그림자(ZXing)가 읽은 것은 넣지 않는다. 넣으면 내장이 계속 못 잡는데도
     * 「방금 읽혔으니 괜찮다」 가 되어 전환에 필요한 횟수가 영영 안 쌓인다.
     */
    let nativeSeenAt = 0;
    /** ZXing 만 읽은 횟수 · ZXing 지연 로드 · 전환 진행 여부 */
    let shadowHits = 0;
    let shadowP = null;
    let swapping = false;

    const frame = frameCanvas();
    const frames = frameSource(video, () => {
        if (running) tick();
    });

    /* ------------------------------ 토치(플래시) ------------------------------ */

    /** 이 기기에서 토치를 켤 수 있는지 (대개 안드로이드 후면 카메라만 된다) */
    function hasTorch() {
        return Boolean(track?.getCapabilities?.().torch);
    }

    /** 토치를 켜고 끈다. 지원하지 않으면 아무 일도 하지 않는다 */
    async function setTorch(on) {
        if (!hasTorch() || track.readyState !== 'live') return false;
        try {
            await track.applyConstraints({ advanced: [{ torch: Boolean(on) }] });
            torchOn = Boolean(on);
        } catch (err) {
            console.warn('플래시를 제어하지 못했습니다.', err);
        }
        return torchOn;
    }

    /* ---------------------------------- 줌 ---------------------------------- */

    /** 이 기기가 노출한 줌 능력 (안드로이드 크롬은 대개 있고, iOS·PC 웹캠은 거의 없다) */
    function zoomCaps() {
        const z = track?.getCapabilities?.().zoom;
        return z && Number.isFinite(z.min) && Number.isFinite(z.max) ? z : null;
    }

    /** 줌 버튼으로 낼 배율 목록 - 비어 있으면 **UI 는 버튼을 숨긴다** */
    function steps() {
        return zoomSteps(zoomCaps(), TUNE);
    }

    function canZoom() {
        return steps().length > 1;
    }

    /**
     * 줌 안정화 기다림을 끝낸다 - 시간이 다 됐거나, 중지·다음 줌이 끊었거나.
     * 🔑 **끊을 때도 반드시 resolve 한다.** 여기서 멈춰 버리면 부르는 쪽(핀치 UI)의
     * `zoomBusy` 가 영영 풀리지 않아 다음부터 줌이 먹지 않는다.
     */
    function endSettle() {
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = null;
        const done = settleDone;
        settleDone = null;
        if (done) done();
    }

    /** 줌을 바꾼 뒤 초점이 안정될 때까지 기다린다 (그 사이 stop() 이 오면 세대로 걸러진다) */
    function settle(ms) {
        endSettle();            // 앞선 기다림이 남아 있으면 먼저 끊는다 (타이머가 쌓이지 않게)
        return new Promise((resolve) => {
            settleDone = resolve;
            settleTimer = setTimeout(endSettle, ms);
        });
    }

    /**
     * 배율을 직접 지정한다 (핀치 줌이 부른다).
     * 실패하면 조용히 원래 값을 돌려준다 - 스트림을 다시 열지 않는다.
     * @param {number} value 원하는 배율
     * @returns {Promise<number>} 실제로 적용된 배율
     */
    async function setZoomRaw(value) {
        const caps = zoomCaps();
        const v = clampZoom(value, caps);
        if (v == null || !track || track.readyState !== 'live' || v === zoomNow) return zoomNow;
        const mine = gen;
        try {
            await track.applyConstraints({ advanced: [{ zoom: v }] });
            zoomNow = v;
        } catch (err) {
            console.warn('줌을 적용하지 못했습니다.', err);
            return zoomNow;
        }
        // 🔑 줌이 바뀌면 초점이 흔들린다 - 안정될 시간을 준 뒤 연속 오토포커스를 다시 건다
        await settle(TUNE.zoomSettleMs);
        if (mine === gen && track) await tuneTrack(track);
        return zoomNow;
    }

    /** 줌 버튼(1x·2x·3x)이 부른다 - 목록에 없는 값은 그대로 클램프된다 */
    function setZoom(step) {
        return setZoomRaw(step);
    }

    /* -------------------------------- 인식기 전환 -------------------------------- */

    /** 엔진 표시를 갱신한다 (프리뷰 좌하단 태그 - 지원 문의 때 이 값으로 기기를 가른다) */
    function setEngine(name) {
        if (engine === name) return;
        engine = name;
        engineCb?.(name);
    }

    /** 그림자 디코딩·전환에 쓸 ZXing - 필요해진 순간 한 번만 내려받는다 (약 470KB) */
    function shadowReader() {
        if (!shadowP) {
            shadowP = zxingReader().catch((err) => {
                console.warn('ZXing 을 불러오지 못했습니다.', err);
                return null;
            });
        }
        return shadowP;
    }

    /**
     * 내장 인식기를 버리고 ZXing 으로 갈아탄다 (한 세션에 한 번).
     * 부르는 곳은 둘 - ① `detect()` 가 예외를 던졌을 때 ② ZXing 만 읽은 일이 쌓였을 때.
     * 🔑 내려받는 사이 화면을 떠났을 수 있으므로 **세대 토큰**을 확인하고 반영한다.
     * ZXing 마저 못 만들면 종전처럼 중지한다 (프리뷰만 켜 두는 것은 의미가 없다).
     * @param {string} why 콘솔에 남길 이유
     */
    async function swapEngine(why) {
        if (swapping) return;
        swapping = true;
        console.warn(why);
        const mine = gen;
        const zx = await shadowReader();
        if (mine !== gen) return;        // 중지·재시작됐다 - 다음 세션이 알아서 정한다
        if (!zx) {
            stop();
            return;
        }
        readerP = Promise.resolve(zx);
        readerTested = true;        // ZXing 은 진단 대상이 아니다
        rememberZxing();
        setEngine('zxing');
    }

    /* -------------------------------- 인식 루프 -------------------------------- */

    /**
     * 같은 코드를 다시 받아도 되는지 판정한다.
     *
     * 🔑 상차검수는 **같은 주문번호 라벨을 파렛트 수만큼** 찍는다. 그래서 무조건
     * 2.5초를 막으면 빨리 찍는 사람에게는 "안 읽힌다" 로 보이고,
     * 반대로 너무 쉽게 풀면 **한 파렛트가 2건으로 세어져 실물보다 진행률이 앞선다.**
     * 후자가 훨씬 위험하므로(파렛트 누락 출고) 판정은 보수적으로 둔다.
     *
     * 다시 받는 조건은 **비어 있던 시간**이고, 그 문턱은 두 값의 큰 쪽이다
     * (`scan-calc.js` 의 `reArmGap`).
     *   ① `reArmMs` (1.5초) - 사람이 파렛트를 옮기는 최소 시간
     *   ② `reArmFrames × 디코딩 1회 소요시간` - 디코딩이 느린 기기일수록 커진다
     * ②가 있어야 "디코딩 실패 몇 번"이 "라벨을 치움"으로 오해되지 않는다.
     *
     * ⚠️ 인식 강화(줌·해상도·ROI)는 이 판정을 건드리지 않는다. 두 가지는 독립이어야 한다.
     */
    function accepts(code, now) {
        if (code !== last) return true;
        if (now - seenAt >= reArmGap(cost, TUNE)) return true;   // 정말 비어 있었다 = 다음 파렛트
        return now - acceptedAt >= TUNE.repeatMs;                // 계속 보이는 중이면 시간으로 막는다
    }

    /**
     * ROI 하나를 디코더에 넘긴다.
     * 내장 인식기에 **전체 프레임**을 줄 때는 비디오를 그대로 넘겨 복사를 아낀다.
     * @param {object} reader 인식기
     * @param {{w:number,h:number,kind:string,wide:boolean,pre:boolean}} roi
     */
    function decodeOnce(reader, roi) {
        const whole = roi.w >= 1 && roi.h >= 1;
        if (reader.native && whole && !roi.pre) return reader.decode(video, roi.wide);
        const canvas = frame.crop(video, roi);
        if (roi.pre) frame.stretch();
        return reader.decode(canvas, roi.wide);
    }

    /**
     * 한 프레임 처리 - 예산 안에서 ROI 계획을 순서대로 보고 **첫 성공에 멈춘다.**
     * 🔑 `cost` 는 **미검출로 끝난 tick 만** 반영한다 (`nextCost`). 성공 프레임은 첫 ROI 에서
     * 끝나 싸므로 섞으면 평균이 내려가고, `reArmGap` 이 짧아져 중복 계수가 늘어난다.
     */
    async function tick() {
        if (!running) return;
        const reader = await readerP;
        if (!running) return;   // 기다리는 사이에 화면을 떠났다
        if (!reader) {          // 디코더를 못 불러왔다 - 프리뷰만 켜 두는 것은 의미가 없다
            stop();
            return;
        }
        setEngine(reader.native ? 'native' : 'zxing');
        // 🔑 **디코더를 받은 뒤부터** 잰다. 첫 프레임에 ZXing 내려받는 시간(느린 회선에서
        // 수 초)이 섞이면 평균이 오염되어 한동안 중복 판정 문턱이 상한까지 올라간다.
        const began = performance.now();
        const budget = stepBudget(reader.native, TUNE);
        const plan = roiPlan(reader.native, missStreak, TUNE);
        let code = null;
        let used = 0;
        let firstSpent = 0;
        try {
            for (let i = 0; i < plan.length; i += 1) {
                if (i > 0 && used >= budget) break;    // 예산을 넘겼으면 다음 프레임으로 넘긴다
                const at = performance.now();
                code = await decodeOnce(reader, plan[i]);
                // 🔑 읽는 동안 화면을 떠났거나 중지했으면 **넘기지 않는다**
                // (전량 검수 자동 중지 뒤에 1건이 더 들어가는 것을 막는다)
                if (!running) return;
                const done = performance.now();
                if (i === 0) firstSpent = done - at;
                used = done - began;
                if (code) break;
            }
        } catch (err) {
            // 🔑 예외 경로에도 중지 확인이 필요하다. 중지하면 트랙·캔버스를 놓으므로
            // 진행 중이던 디코딩이 던질 수 있는데, 여기서 빠져나가지 않으면 아래
            // `frames.next()` 가 **중지 뒤에 프레임 타이머를 다시 건다**(좀비 루프).
            if (!running) return;
            console.warn('바코드 인식 실패', err);
            // 🔑 전환에 걸리는 시간(ZXing 내려받기)은 여기 넣지 않는다 - `cost` 가 오염된다
            used = performance.now() - began;
            code = null;
            // 🔑 내장 인식기가 던졌으면 **그 자리에서** ZXing 으로 갈아탄다.
            // 같은 인식기로 계속 돌면 영원히 미검출이다 (안드로이드에서 실제로 난 현상 -
            // Google Play 바코드 모듈이 없으면 detect() 가 매 프레임 던진다).
            if (reader.native) await swapEngine('내장 인식기 오류로 ZXing 으로 전환합니다.');
            if (!running) return;
        }

        // 내장이 **자기 힘으로** 읽은 시각 (그림자가 읽은 것은 넣지 않는다)
        if (code && reader.native) nativeSeenAt = performance.now();

        // 🔑 내장이 한참 아무것도 못 잡으면 **같은 프레임**을 ZXing 으로도 본다.
        // 예외를 던지지 않고 늘 빈 결과만 주는 기기는 이것 말고 전환 신호가 없다.
        // 예산이 남았을 때만 돌려 「한 tick ≤ 예산 + 1회분」 규칙을 깨지 않는다.
        let shadowHit = false;
        if (!code && reader.native && !swapping && used < budget
            && shadowDue(performance.now() - nativeSeenAt, missStreak + 1, TUNE)) {
            const zx = await shadowReader();
            if (!running) return;
            if (zx) {
                code = await decodeOnce(zx, roiPlan(false, missStreak, TUNE)[0]);
                if (!running) return;
                // 그림자 시간도 **예산에는** 포함한다 (아래 cost 는 여전히 미검출만 본다)
                used = performance.now() - began;
                shadowHit = Boolean(code);
            }
        }
        if (shadowHit) {
            shadowHits += 1;
            // 사용자 입장에서는 그냥 읽힌 것이다 - 코드는 아래에서 그대로 채택된다
            if (shadowHits >= TUNE.shadowSwitchHits) {
                await swapEngine('ZXing 만 읽히는 상태가 이어져 ZXing 으로 전환합니다.');
                if (!running) return;
            }
        }

        // 🔑 판정 시각은 그림자 디코딩 **뒤**에 읽는다 (앞으로 당기지 말 것).
        // `repeatMs` 는 「마지막으로 센 뒤 흐른 실시간」이라 실제 시계여야 비프 간격이
        // 정확히 2.5초로 유지된다. `reArmGap` 쪽은 그림자를 돈 tick 만 최대 1회
        // 디코딩만큼 늦게 읽히지만, **같은 시간이 `used`→`cost`→`reArmGap`(5배)로
        // 들어가 문턱이 더 크게 올라가** 상쇄된다 (그래서 `used` 에서 빼면 안 된다).
        const now = performance.now();
        missStreak = code ? 0 : missStreak + 1;
        cost = nextCost(cost, used, Boolean(code), TUNE);
        if (!code) {
            // 한 번 디코딩하는 것조차 예산을 넘으면 이 해상도를 감당하지 못하는 기기다.
            // 🔑 성공 tick 은 세지도 풀지도 않는다 - 성공은 첫 ROI 에서 끝나 언제나 싸므로
            // 넣으면 느린 기기의 초과가 성공 한 번에 지워진다(강등이 영영 안 걸린다).
            overrun = nextOverrun(overrun, firstSpent, budget);
            if (shouldDowngrade(overrun, downgraded)) downgrade();
            // 🔑 합의(consensus)는 **연속** 프레임을 뜻한다 - 미검출이 끼면 처음부터 다시 센다.
            // (`consensus: 1` 인 기본값에서는 아무 차이가 없고, 2 이상일 때만 뜻이 생긴다)
            agree = 0;
            agreeCode = '';
        }

        if (code) {
            agree = code === agreeCode ? agree + 1 : 1;
            agreeCode = code;
            if (agree >= TUNE.consensus && accepts(code, now)) {
                acceptedAt = now;
                if (navigator.vibrate) navigator.vibrate(60);
                onCode(code);
            }
            last = code;
            seenAt = now;
        }

        // 한동안 아무것도 안 잡히면 간격을 늘린다 (카메라를 켜 둔 채 이동할 때의 발열·배터리)
        const want = nextGap(seenAt, startedAt, performance.now(), TUNE);
        frames.next(want - (performance.now() - began));
    }

    /** 예산을 연속으로 넘기는 기기는 해상도를 한 단계 낮춘다 (되돌리지 않는다 - 진동 방지) */
    async function downgrade() {
        downgraded = true;
        if (!track) return;
        try {
            await track.applyConstraints({
                width: { ideal: TUNE.downSize.width },
                height: { ideal: TUNE.downSize.height },
            });
            console.warn(`프레임 예산을 넘겨 해상도를 ${TUNE.downSize.width}×`
                + `${TUNE.downSize.height} 로 낮췄습니다.`);
        } catch (err) {
            console.warn('해상도를 낮추지 못했습니다.', err);
        }
    }

    /** 앱을 다시 열었을 때 멈춘 프리뷰를 되살린다 (iOS 는 백그라운드에서 재생을 끊는다) */
    function onVisible() {
        if (running && !document.hidden) video.play().catch(() => {});
    }

    /* ------------------------------- 시작 / 정지 ------------------------------- */

    function stop() {
        gen += 1;               // 준비 중인 start() 가 있으면 여기서 무효가 된다
        running = false;
        starting = false;
        frames.cancel();
        endSettle();
        frame.release();
        document.removeEventListener('visibilitychange', onVisible);
        if (torchOn) setTorch(false);
        torchOn = false;
        if (stream) stream.getTracks().forEach((t) => t.stop());
        stream = null;
        track = null;
        video.srcObject = null;
        video.hidden = true;
    }

    async function start() {
        if (!scanSupported()) throw new Error('이 브라우저는 카메라를 지원하지 않습니다.');
        // 🔑 권한 프롬프트가 떠 있는 동안 연타해도 스트림이 두 개 열리지 않게 막는다
        // (`stream` 은 await 뒤에야 채워지므로 그것만으로는 막을 수 없다)
        if (stream || starting) return;
        starting = true;

        // 준비 중에 stop() 이 오면 이 세대는 버린다 (켜지 않은 채로 끝낸다)
        gen += 1;
        const mine = gen;
        const canceled = () => mine !== gen;

        // 🔑 **카메라부터 연다.** 디코더를 내려받느라 기다린 뒤에 열면 사파리가 버튼을 누른
        // 동작과 이어지지 않는 것으로 보아 권한 요청을 거절할 수 있다.
        // 내장 인식기가 없는 기기는 ZXing 이 약 470KB 라 이 차이가 크다.
        const size = useNative() ? TUNE.nativeSize : TUNE.zxingSize;
        // 🔑 스트림은 **내 세대 것으로 확정된 뒤에만** 공유 변수에 넣는다.
        // 취소된 세대가 stream·starting 을 건드리면 그 사이 시작한 세대의 것을 꺼 버린다.
        let mineStream = null;
        try {
            mineStream = await navigator.mediaDevices.getUserMedia({
                video: videoConstraints(size),
            });
        } catch (err) {
            if (!canceled()) starting = false;
            throw new Error(`카메라를 사용할 수 없습니다: ${err.name}`);
        }

        // 여는 사이에 화면을 떠났으면 내가 연 카메라만 정리하고 끝낸다
        if (canceled()) {
            mineStream.getTracks().forEach((t) => t.stop());
            return;             // starting 은 나를 밀어낸 세대가 관리한다
        }
        stream = mineStream;

        // 프리뷰가 뜨는 동안 디코더를 준비한다 (실패해도 직접 입력 경로는 살아 있다)
        // 🔑 **자가 진단을 못 끝낸 인식기는 다시 만든다.** 진단을 기다리는 사이 화면을
        // 떠나면 검증되지 않은 내장 인식기가 캐시에 남아 그 뒤로 영영 진단하지 않는다.
        if (!readerP || !readerTested) {
            // 🔑 진단이 **끝난 뒤**가 아니라 **시작할 때** 미검증으로 표시한다.
            // 끝난 뒤에 표시하면 진단 중에 중지→재시작한 세대가 「검증됐다」 로 보고
            // 미검증 인식기를 그대로 물려받는다 (이 경로가 바로 막으려던 것이다).
            readerTested = !useNative();      // ZXing 경로는 진단할 것이 없다
            const mineReader = createReader(canceled).catch((err) => {
                console.warn('바코드 디코더를 불러오지 못했습니다.', err);
                return null;
            });
            readerP = mineReader;
            mineReader.then((r) => {
                if (readerP === mineReader) readerTested = r?.tested !== false;
            });
        }

        track = stream.getVideoTracks()[0] ?? null;
        if (track) await tuneTrack(track);

        video.srcObject = stream;
        video.hidden = false;
        video.setAttribute('playsinline', '');
        video.muted = true;
        await video.play().catch(() => {});   // 재생이 막혀도 프레임은 들어올 수 있다
        await waitReady(video);

        // 첫 프레임을 기다리는 동안(최대 3초) 화면을 떠났을 수 있다 - 루프를 살리지 않는다
        if (canceled()) {
            mineStream.getTracks().forEach((t) => t.stop());
            if (stream === mineStream) {   // 내 것이 아직 걸려 있을 때만 치운다
                stream = null;
                track = null;
                video.srcObject = null;
                video.hidden = true;
            }
            return;
        }
        starting = false;

        last = '';
        acceptedAt = 0;
        seenAt = 0;
        cost = 0;
        missStreak = 0;
        overrun = 0;
        downgraded = false;
        agree = 0;
        agreeCode = '';
        shadowHits = 0;
        swapping = false;
        // 지금 배율은 기기에게 묻는다 (추측하면 첫 줌 버튼이 "같은 값" 으로 무시될 수 있다)
        const nowZoom = track?.getSettings?.().zoom;
        zoomNow = Number.isFinite(nowZoom) ? nowZoom : steps()[0] ?? 1;
        startedAt = performance.now();
        nativeSeenAt = startedAt;
        running = true;
        document.addEventListener('visibilitychange', onVisible);
        frames.next(0);
    }

    return {
        start,
        stop,
        isOn: () => Boolean(stream),
        hasTorch,
        isTorchOn: () => torchOn,
        /** 토치를 뒤집는다 - 지원 기기에서만 동작하고, 새 상태를 돌려준다 */
        toggleTorch: () => setTorch(!torchOn),
        /** 이 기기에서 줌을 쓸 수 있는지 - false 면 UI 는 줌 버튼을 **숨긴다** */
        canZoom,
        /** 줌 버튼으로 낼 배율 목록 (예: [1, 2, 3]) */
        zoomSteps: steps,
        /** 지금 배율 */
        zoomValue: () => zoomNow,
        /** 핀치 줌이 쓸 범위 */
        zoomRange: () => zoomCaps(),
        setZoom,
        setZoomRaw,
        /** 지금 쓰는 인식기 - 'native' | 'zxing' | '' (아직 정해지지 않음) */
        engine: () => engine,
        /** 인식기가 바뀌면 알려준다 (프리뷰의 엔진 태그가 즉시 따라간다) */
        onEngine: (cb) => {
            engineCb = cb;
        },
        /** 프리뷰 상자 안에서 조준 밴드가 차지할 영역 (가이드 박스를 ROI 와 맞춘다) */
        aimRect: (bw, bh) => aimRect(AIM_ROI, video.videoWidth, video.videoHeight, bw, bh),
    };
}
