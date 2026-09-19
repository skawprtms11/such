/**
 * 바코드 스캔 계산 - **순수 함수만** 모은다 (DOM·카메라·타이머를 모른다).
 *
 * `scanner.js` 는 카메라를 열고 프레임을 나르는 일만 하고, "어디를 · 얼마나 · 언제"
 * 는 전부 여기서 정한다. 브라우저 없이 부를 수 있어 `tools/scan-check.js` 가 가짜
 * 디코더로 루프를 모사해 불변식을 센다 (`checkflow.js` + `checkflow-check.js` 와 같은 꼴).
 *
 * 🔑 **조정값(TUNE)은 여기에 두지 않는다.** 유일한 출처는 `scanner.js` 의 `TUNE` 이고,
 * 이 파일의 함수는 그 객체를 인자로 받는다. 값이 두 곳에 흩어지면 현장에서 어느 쪽을
 * 고쳐야 하는지 알 수 없다.
 */

/**
 * ROI 가로 하한 🔑 — **1D(`kind: '1d'`) ROI 에만 건다.**
 * Code128 은 좌우 여백(quiet zone · 모듈 10개)이 잘리면 디코딩이 **실패**한다.
 * 1D 바코드는 스캔라인 하나면 되므로 줄이려면 세로를 줄인다. 가로는 이 아래로 자르지 않는다.
 *
 * QR(`kind: '2d'`)은 사정이 반대다 - 정사각형이라 가로만 넓은 밴드는 위아래를 잘라 먹고,
 * 좌우 여백도 4모듈이면 된다. 그래서 2D ROI 는 이 하한을 적용하지 않는다
 * (하이브리드 라벨 · [docs/testing.md](../../docs/testing.md) 참고).
 */
export const ROI_MIN_W = 0.72;

/** 가이드 박스가 그려 주는 조준 밴드 - ROI 계획의 밴드와 같은 값이어야 한다 */
export const AIM_ROI = { w: 1, h: 0.45 };

/** 예산을 연속으로 이만큼 넘기면 해상도를 한 단계 낮춘다 (복귀는 없다 - 진동 방지) */
export const DOWNGRADE_AFTER = 2;

/**
 * 한 프레임에서 시도할 ROI 계획.
 *
 * 순서대로 시도하고 **첫 성공에서 멈춘다.** 미검출이 쌓이면 뒤 순서를 앞으로 당겨
 * (라벨이 밴드 밖에 있는 경우) 같은 자리만 계속 보지 않게 한다.
 *
 * @param {boolean} native 내장 BarcodeDetector 경로인지 (false = ZXing)
 * @param {number} missStreak 연속 미검출 횟수
 * @param {object} tune `scanner.js` 의 TUNE
 * @returns {{w:number, h:number, kind:string, wide:boolean, pre:boolean}[]}
 *          `kind` = `'1d'`(가로 하한을 지킨다) / `'2d'`(QR 용 정사각) ·
 *          `wide` = 전 포맷 디코더로 본다(첫 시도는 QR + CODE_128 전용) ·
 *          `pre` = 전처리(그레이+대비)를 붙인다
 */
export function roiPlan(native, missStreak, tune) {
    const base = native ? tune.roiNative : tune.roiZxing;
    const n = base.length;
    const miss = Math.max(0, Math.floor(missStreak) || 0);
    const shift = miss >= tune.preMissN ? Math.floor(miss / tune.preMissN) % n : 0;
    // 전처리는 ZXing 경로에서만 뜻이 있다 (내장 인식기는 자기 전처리를 한다)
    const pre = !native && miss >= tune.preMissN;
    return base.map((_, i) => {
        const roi = base[(i + shift) % n];
        const kind = roi.kind === '2d' ? '2d' : '1d';
        // 🔑 가로 하한은 1D 에만 건다 - QR 에 걸면 정사각 ROI 가 밴드로 펴져 위아래가 잘린다
        const w = kind === '1d' ? Math.max(ROI_MIN_W, roi.w) : Math.max(0.05, roi.w);
        return {
            w: Math.min(1, w),
            h: Math.min(1, Math.max(0.05, roi.h)),
            kind,
            wide: i > 0,
            pre,
        };
    });
}

/**
 * 한 프레임에 쓸 디코딩 예산(ms).
 * 이 시간을 넘긴 뒤에는 다음 ROI 를 시작하지 않는다(시작한 것은 끝까지 간다).
 * @param {boolean} native 내장 인식기 경로인지
 * @param {object} tune TUNE
 */
export function stepBudget(native, tune) {
    return native ? tune.budgetNativeMs : tune.budgetZxingMs;
}

/**
 * 같은 코드를 다음 1건으로 받기 위해 **비어 있어야 하는 시간**(ms).
 *
 * 🔑 시간 상수와 프레임 수 상수를 나란히 두지 않고 **한 식**으로 합친다.
 * 단위가 다른 조건 둘을 "둘 다 만족" 으로 두면 한쪽이 항상 먼저 충족되어 없는 것과 같다
 * (2026-09-17 학습로그). `reArmMs` 는 하한이라 어떤 적응도 이 아래로 내려가지 않는다.
 * @param {number} cost 디코딩 1회 소요시간 이동평균(ms)
 * @param {object} tune TUNE
 */
export function reArmGap(cost, tune) {
    return Math.max(tune.reArmMs, tune.reArmFrames * Math.max(0, cost));
}

/**
 * 디코딩 1회 소요시간 이동평균을 갱신한다.
 *
 * 🔑 **검출에 성공한 tick 은 넣지 않는다.** `cost` 의 뜻은 "라벨을 든 채 한 번 **실패**하는
 * 데 걸리는 시간" 이다. 성공은 첫 ROI 에서 끝나 싸므로 섞으면 평균이 내려가고,
 * `reArmGap` 이 짧아져 **한 파렛트가 2건으로 세어진다.**
 * 인식을 잘 되게 만들수록 중복 계수 위험이 커지는 역설을 여기서 끊는다.
 *
 * @param {number} cost 지금 평균(0 = 아직 없음)
 * @param {number} spent 이번 tick 의 디코딩 소요시간(ms)
 * @param {boolean} hit 이번 tick 에서 코드를 찾았는지
 * @param {object} tune TUNE
 */
export function nextCost(cost, spent, hit, tune) {
    if (hit) return cost;
    const s = Math.min(Math.max(0, spent), tune.costCapMs);
    return cost ? cost * 0.7 + s * 0.3 : s;
}

/**
 * 다음 프레임까지 기다릴 시간(ms).
 * 한동안 아무것도 안 잡히면 간격을 늘려 발열·배터리를 아낀다.
 * @param {number} seenAt 마지막으로 코드가 보인 시각
 * @param {number} startedAt 카메라를 켠 시각
 * @param {number} now 지금
 * @param {object} tune TUNE
 */
export function nextGap(seenAt, startedAt, now, tune) {
    const idle = now - Math.max(seenAt, startedAt) >= tune.idleAfterMs;
    return idle ? tune.idleGapMs : tune.minGapMs;
}

/**
 * 이번 tick 에 **그림자 디코딩**(같은 프레임을 ZXing 으로도 본다)을 할지.
 *
 * 🔑 내장 인식기가 「예외도 안 던지고 **늘 빈 결과**」인 기기가 있다. 이때는 오류가 없어
 * 전환 신호가 없으므로 **한참 못 잡는 것 자체**를 신호로 본다.
 * 매 프레임 두 번 디코딩하면 발열이 크므로 `shadowEveryN` 번에 한 번만 돌린다.
 *
 * @param {number} idleMs 내장 인식기가 **자기 힘으로** 마지막에 읽은 뒤 흐른 시간(ms)
 * @param {number} misses 연속 미검출 횟수 (이번 tick 을 포함한다)
 * @param {object} tune TUNE
 */
export function shadowDue(idleMs, misses, tune) {
    if (!(idleMs >= tune.shadowAfterMs)) return false;
    const every = Math.max(1, Math.floor(tune.shadowEveryN) || 1);
    const n = Math.floor(misses) || 0;
    return n > 0 && n % every === 0;
}

/**
 * 기기가 줄 수 있는 줌 배율 버튼 목록.
 * 🔑 **쓸 수 있는 단계가 2개 미만이면 빈 배열**을 준다 - UI 는 이때 버튼을 통째로 숨긴다.
 * (iOS·대부분의 PC 웹캠은 줌 자체가 없어 버튼이 있으면 눌러 놓고 실패한다)
 * @param {{min:number, max:number, step?:number}|null} caps `getCapabilities().zoom`
 * @param {object} tune TUNE
 * @returns {number[]}
 */
export function zoomSteps(caps, tune) {
    if (!caps || !Number.isFinite(caps.min) || !Number.isFinite(caps.max)) return [];
    const min = Math.max(1, caps.min);      // 1배 미만(광각)은 인식에 도움이 되지 않는다
    if (!(caps.max > min)) return [];
    const out = [];
    tune.zoomSteps.forEach((z) => {
        const v = Math.min(Math.max(z, min), caps.max);
        if (!out.includes(v)) out.push(v);
    });
    return out.length > 1 ? out : [];
}

/**
 * 핀치 줌이 준 값을 기기가 받을 수 있는 값으로 맞춘다.
 * @param {number} value 원하는 배율
 * @param {{min:number, max:number, step?:number}|null|undefined} caps
 * @returns {number|null} 줌을 못 쓰면 null
 */
export function clampZoom(value, caps) {
    if (!caps || !Number.isFinite(caps.min) || !Number.isFinite(caps.max)) return null;
    const step = Number.isFinite(caps.step) && caps.step > 0 ? caps.step : 0;
    let v = Math.min(Math.max(Number(value) || caps.min, caps.min), caps.max);
    if (step) v = caps.min + Math.round((v - caps.min) / step) * step;
    return Math.min(Math.max(v, caps.min), caps.max);
}

/**
 * 예산 초과를 센다. 🔑 판정 대상은 **ROI 1회**의 소요시간이다 -
 * 미검출 tick 의 총 시간은 설계상 언제나 예산에 수렴하므로 그것으로는 아무것도 가려내지 못한다.
 * "한 번 디코딩하는 것조차 예산을 넘는다" 가 해상도를 감당 못 한다는 신호다.
 * @param {number} overrun 지금까지 연속 초과 횟수
 * @param {number} firstSpent 이번 tick 첫 ROI 의 소요시간(ms)
 * @param {number} budget 예산(ms)
 */
export function nextOverrun(overrun, firstSpent, budget) {
    return firstSpent > budget ? overrun + 1 : 0;
}

/** 지금 해상도를 낮춰야 하는지 (한 번 낮추면 되돌리지 않는다 - 진동 방지) */
export function shouldDowngrade(overrun, downgraded) {
    return !downgraded && overrun >= DOWNGRADE_AFTER;
}

/**
 * 프리뷰 상자 안에서 조준 밴드(ROI)가 차지할 픽셀 영역.
 *
 * 비디오는 `object-fit: cover` 로 잘려 보이므로 **CSS 퍼센트와 프레임 퍼센트가 다르다.**
 * 가이드 박스를 프레임 기준으로 정확히 그리려면 실제 배율을 계산해야 한다.
 * @param {{w:number, h:number}} roi 프레임 대비 비율
 * @param {number} vw 프레임 가로 · @param {number} vh 프레임 세로
 * @param {number} bw 상자 가로 · @param {number} bh 상자 세로
 * @returns {{left:number, top:number, width:number, height:number}} 상자 좌표(px)
 */
export function aimRect(roi, vw, vh, bw, bh) {
    if (!(vw > 0 && vh > 0 && bw > 0 && bh > 0)) {
        return { left: 0, top: 0, width: bw || 0, height: bh || 0 };
    }
    const scale = Math.max(bw / vw, bh / vh);          // cover
    const width = Math.min(bw, roi.w * vw * scale);
    const height = Math.min(bh, roi.h * vh * scale);
    return { left: (bw - width) / 2, top: (bh - height) / 2, width, height };
}
