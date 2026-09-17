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
 *
 * 🔑 인식률에 관계된 값은 전부 아래 `TUNE` 한 곳에 모아 두었다.
 * 현장에서 잘 안 읽히면 이 상수만 조정하거나 되돌리면 된다.
 */

/** 인식률 조정값 - 바꿀 일이 있으면 여기만 본다 */
const TUNE = {
    /** 내장 인식기용 요청 해상도. 가는 바가 뭉개지지 않도록 기본값(대개 640×480)보다 높게 잡는다 */
    nativeSize: { width: 1920, height: 1080 },
    /** ZXing 용 요청 해상도. 디코딩을 CPU 로 하므로 한 단계 낮춰 프레임 수를 지킨다 */
    zxingSize: { width: 1280, height: 720 },
    /** ZXing 에 넘길 중앙 밴드 비율 (가로, 세로) - 조준선 주변만 잘라 넘긴다 */
    roi: { w: 1, h: 0.45 },
    /** 밴드에서 못 찾은 횟수가 이만큼 쌓이면 한 번은 전체 화면으로 시도한다 */
    fullFrameEvery: 4,
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
};

const FORMATS = ['code_128', 'code_39', 'ean_13', 'qr_code', 'codabar', 'itf'];

/** 내장 BarcodeDetector 를 쓸 수 있는지 */
export function hasNativeDetector() {
    return 'BarcodeDetector' in window;
}

/** 이 브라우저에서 카메라 스캔이 가능한지 (ZXing 대체 경로 포함) */
export function scanSupported() {
    return Boolean(navigator.mediaDevices?.getUserMedia);
}

/* -------------------------------- 인식기 만들기 -------------------------------- */

/**
 * 내장 BarcodeDetector 인식기.
 * 한 프레임에 여러 바코드가 잡히면 **조준선(화면 중앙)에 가장 가까운 것**을 고른다.
 * (라벨 여러 장이 한 화면에 들어오면 엉뚱한 것이 읽히는 일을 막는다)
 * @returns {Promise<Function|null>} 지원하지 않으면 null
 */
async function nativeReader() {
    if (!hasNativeDetector()) return null;
    try {
        const supported = await window.BarcodeDetector.getSupportedFormats?.() ?? FORMATS;
        const formats = FORMATS.filter((f) => supported.includes(f));
        if (!formats.length) return null;
        const detector = new window.BarcodeDetector({ formats });

        return async (video) => {
            const found = await detector.detect(video);
            if (!found.length) return null;
            if (found.length === 1) return found[0].rawValue || null;
            const cx = video.videoWidth / 2;
            const cy = video.videoHeight / 2;
            const dist = (b) => {
                const r = b.boundingBox;
                if (!r) return Number.MAX_SAFE_INTEGER;
                return Math.hypot(r.x + r.width / 2 - cx, r.y + r.height / 2 - cy);
            };
            return [...found].sort((a, b) => dist(a) - dist(b))[0].rawValue || null;
        };
    } catch (err) {
        // 기기가 이 포맷 조합을 못 만드는 경우 - ZXing 으로 넘긴다
        console.warn('내장 바코드 인식기를 쓸 수 없어 ZXing 으로 전환합니다.', err);
        return null;
    }
}

/**
 * ZXing 인식기 (내장 기능이 없는 기기 전용).
 * 전체 프레임 대신 **조준선 주변 가로 밴드**만 잘라 넘긴다 - 픽셀이 줄어 빨라지고,
 * 주변 잡음이 빠져 1D 바코드 인식이 붙는다. 가끔 전체 화면도 한 번씩 시도한다.
 */
async function zxingReader() {
    const [{ BrowserMultiFormatReader }, { DecodeHintType, BarcodeFormat }] = await Promise.all([
        import('@zxing/browser'),
        import('@zxing/library'),
    ]);

    // 쓰는 포맷으로 후보를 좁히고, 어렵게라도 찾도록 힌트를 준다
    const hints = new Map();
    hints.set(DecodeHintType.POSSIBLE_FORMATS, [
        BarcodeFormat.CODE_128,
        BarcodeFormat.CODE_39,
        BarcodeFormat.ITF,
        BarcodeFormat.CODABAR,
        BarcodeFormat.EAN_13,
        BarcodeFormat.QR_CODE,
    ]);
    hints.set(DecodeHintType.TRY_HARDER, true);

    const zxing = new BrowserMultiFormatReader(hints);
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    let misses = 0;

    /** 프레임의 일부(또는 전체)를 캔버스에 옮겨 디코딩한다 */
    const decode = (video, ratio) => {
        const vw = video.videoWidth;
        const vh = video.videoHeight;
        const w = Math.max(1, Math.round(vw * ratio.w));
        const h = Math.max(1, Math.round(vh * ratio.h));
        if (canvas.width !== w || canvas.height !== h) {
            canvas.width = w;
            canvas.height = h;
        }
        ctx.drawImage(video, (vw - w) / 2, (vh - h) / 2, w, h, 0, 0, w, h);
        try {
            return zxing.decodeFromCanvas(canvas)?.getText() ?? null;
        } catch {
            return null;   // 프레임에서 못 찾은 경우 (정상)
        }
    };

    return async (video) => {
        if (!video.videoWidth) return null;
        const whole = misses >= TUNE.fullFrameEvery;
        const code = decode(video, whole ? { w: 1, h: 1 } : TUNE.roi);
        misses = code ? 0 : (whole ? 0 : misses + 1);
        return code;
    };
}

/**
 * 프레임에서 바코드를 읽는 인식기를 만든다.
 * @returns {Promise<{read:Function, native:boolean}>}
 */
async function createReader() {
    const native = await nativeReader();
    if (native) return { read: native, native: true };
    return { read: await zxingReader(), native: false };
}

/* --------------------------------- 카메라 제어 --------------------------------- */

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
 *            hasTorch:Function, isTorchOn:Function, toggleTorch:Function}}
 */
export function createScanner(video, onCode) {
    let stream = null;
    let track = null;
    let timer = null;
    let frameReq = 0;
    let turn = 0;
    let running = false;
    let torchOn = false;
    let readerP = null;
    let starting = false;
    let gen = 0;
    let last = '';
    let acceptedAt = 0;
    let seenAt = 0;
    let startedAt = 0;
    /** 디코딩 1회 소요시간(ms) 이동평균 - 기기 속도에 맞춰 중복 판정을 조절한다 */
    let cost = 0;

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

    /* -------------------------------- 인식 루프 -------------------------------- */

    /**
     * 같은 코드를 다시 받아도 되는지 판정한다.
     *
     * 🔑 상차검수는 **같은 주문번호 라벨을 파렛트 수만큼** 찍는다. 그래서 무조건
     * 2.5초를 막으면 빨리 찍는 사람에게는 "안 읽힌다" 로 보이고,
     * 반대로 너무 쉽게 풀면 **한 파렛트가 2건으로 세어져 실물보다 진행률이 앞선다.**
     * 후자가 훨씬 위험하므로(파렛트 누락 출고) 판정은 보수적으로 둔다.
     *
     * 다시 받는 조건은 **비어 있던 시간**이고, 그 문턱은 두 값의 큰 쪽이다.
     *   ① `reArmMs` (1.5초) - 사람이 파렛트를 옮기는 최소 시간
     *   ② `reArmFrames × 디코딩 1회 소요시간` - 디코딩이 느린 기기일수록 커진다
     * ②가 있어야 "디코딩 실패 몇 번"이 "라벨을 치움"으로 오해되지 않는다.
     */
    function reArmGap() {
        return Math.max(TUNE.reArmMs, TUNE.reArmFrames * cost);
    }

    function accepts(code, now) {
        if (code !== last) return true;
        if (now - seenAt >= reArmGap()) return true;        // 정말 비어 있었다 = 다음 파렛트
        return now - acceptedAt >= TUNE.repeatMs;           // 계속 보이는 중이면 시간으로 막는다
    }

    /**
     * 다음 프레임을 예약한다. 처리가 끝난 뒤에만 부르므로 **호출이 겹치지 않는다**.
     * 새 프레임이 올 때 깨우는 `requestVideoFrameCallback` 을 쓰되,
     * 그 콜백이 오지 않는 상황(백그라운드·숨겨진 프리뷰)에 대비해 예비 타이머를 함께 건다.
     */
    function schedule(waitMs) {
        if (!running) return;
        if (waitMs > 0) {
            timer = setTimeout(schedule, waitMs, 0);
            return;
        }
        turn += 1;
        const mine = turn;
        const run = () => {
            if (mine !== turn) return;   // 예비 타이머와 프레임 콜백 중 먼저 온 쪽만 실행한다
            turn += 1;
            tick();
        };
        if (video.requestVideoFrameCallback) {
            frameReq = video.requestVideoFrameCallback(run);
            timer = setTimeout(run, TUNE.stallMs);
        } else {
            timer = setTimeout(run, 0);
        }
    }

    async function tick() {
        if (!running) return;
        const reader = await readerP;
        if (!running) return;   // 기다리는 사이에 화면을 떠났다
        if (!reader) {          // 디코더를 못 불러왔다 - 프리뷰만 켜 두는 것은 의미가 없다
            stop();
            return;
        }
        // 🔑 **디코더를 받은 뒤부터** 잰다. 첫 프레임에 ZXing 내려받는 시간(느린 회선에서
        // 수 초)이 섞이면 평균이 오염되어 한동안 중복 판정 문턱이 상한까지 올라간다.
        const began = performance.now();
        try {
            const code = await reader.read(video);
            const now = performance.now();
            // 디코딩이 얼마나 걸리는 기기인지 재 둔다 (중복 판정 문턱에 쓴다)
            const spent = Math.min(now - began, TUNE.costCapMs);
            cost = cost ? cost * 0.7 + spent * 0.3 : spent;
            // 🔑 읽는 동안 화면을 떠났거나 중지했으면 **넘기지 않는다**
            // (전량 검수 자동 중지 뒤에 1건이 더 들어가는 것을 막는다)
            if (!running) return;
            if (code) {
                if (accepts(code, now)) {
                    acceptedAt = now;
                    if (navigator.vibrate) navigator.vibrate(60);
                    onCode(code);
                }
                last = code;
                seenAt = now;
            }
        } catch (err) {
            console.warn('바코드 인식 실패', err);
        }
        // 한동안 아무것도 안 잡히면 간격을 늘린다 (카메라를 켜 둔 채 이동할 때의 발열·배터리)
        const idle = performance.now() - Math.max(seenAt, startedAt) >= TUNE.idleAfterMs;
        const want = idle ? TUNE.idleGapMs : TUNE.minGapMs;
        schedule(want - (performance.now() - began));
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
        if (timer) clearTimeout(timer);
        timer = null;
        if (frameReq && video.cancelVideoFrameCallback) video.cancelVideoFrameCallback(frameReq);
        frameReq = 0;
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
        const size = hasNativeDetector() ? TUNE.nativeSize : TUNE.zxingSize;
        // 🔑 스트림은 **내 세대 것으로 확정된 뒤에만** 공유 변수에 넣는다.
        // 취소된 세대가 stream·starting 을 건드리면 그 사이 시작한 세대의 것을 꺼 버린다.
        let mineStream = null;
        try {
            mineStream = await navigator.mediaDevices.getUserMedia({
                video: {
                    facingMode: { ideal: 'environment' },
                    // ideal 로만 요청한다 - 못 맞추는 기기도 거절하지 않고 가장 가까운 값을 준다
                    width: { ideal: size.width },
                    height: { ideal: size.height },
                },
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
        if (!readerP) {
            readerP = createReader().catch((err) => {
                console.warn('바코드 디코더를 불러오지 못했습니다.', err);
                return null;
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
        startedAt = performance.now();
        running = true;
        document.addEventListener('visibilitychange', onVisible);
        schedule(0);
    }

    return {
        start,
        stop,
        isOn: () => Boolean(stream),
        hasTorch,
        isTorchOn: () => torchOn,
        /** 토치를 뒤집는다 - 지원 기기에서만 동작하고, 새 상태를 돌려준다 */
        toggleTorch: () => setTorch(!torchOn),
    };
}
